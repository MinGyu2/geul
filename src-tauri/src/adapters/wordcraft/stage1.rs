//! Stage 1 common document editing for DOCX (WordCraft): paragraph alignment, character size/color/highlight/
//! script, paragraph spacing and indents, numbered/multilevel lists, page setup and find/replace.
//!
//! Every operation maps to a fixed WordCraft command with validated parameters (never an arbitrary command ID),
//! so each successful operation is exactly one WordCraft undo step and is persisted in native WordprocessingML
//! (`w:jc`, `w:sz`, `w:color`, `w:highlight`, `w:vertAlign`, `w:spacing`, `w:ind`, `w:numPr` + numbering part,
//! `w:sectPr`). Save preservation is decided by T009 (`compare_saved_docx`); numbering resources are proved there.
//!
//! Search is model-owned: matches are WordCraft `edit.*` search results over the main story's paragraph text
//! (literal text, no wildcard/special codes), never rendered pixels. A replacement only applies while the
//! selection is still exactly a current match of the same query, so a stale result never changes the document.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wordcraft_engine::doc::props::{Align, LineSpacing, ParaProps};
use wordcraft_engine::doc::StoryRef;

use super::{DocxModel, Rejected};

/// Search text length limit (characters).
pub const MAX_SEARCH_CHARS: usize = 256;
/// Matches reported for the current-result indication; counting continues past it as a bound only.
pub const MAX_SEARCH_RESULTS: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ParagraphAlign {
    Left,
    Center,
    Right,
    Justify,
}

impl ParagraphAlign {
    fn engine(self) -> &'static str {
        match self {
            ParagraphAlign::Left => "left",
            ParagraphAlign::Center => "center",
            ParagraphAlign::Right => "right",
            ParagraphAlign::Justify => "justify",
        }
    }
    fn of(align: Align) -> Option<ParagraphAlign> {
        match align {
            Align::Left => Some(ParagraphAlign::Left),
            Align::Center => Some(ParagraphAlign::Center),
            Align::Right => Some(ParagraphAlign::Right),
            Align::Justify => Some(ParagraphAlign::Justify),
            Align::Distribute => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScriptValue {
    Superscript,
    Subscript,
    Baseline,
}

/// Highlight colors the app offers: WordprocessingML `ST_HighlightColor` values (the engine matches these first,
/// so `green` is bright green and `darkGreen` is green), plus `none`.
pub const HIGHLIGHTS: [&str; 16] = [
    "yellow",
    "green",
    "cyan",
    "magenta",
    "blue",
    "red",
    "darkBlue",
    "darkCyan",
    "darkGreen",
    "darkMagenta",
    "darkRed",
    "darkYellow",
    "darkGray",
    "lightGray",
    "black",
    "none",
];

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(tag = "rule", rename_all = "camelCase", deny_unknown_fields)]
pub enum LineSpacingOp {
    Multiple { value: f32 },
    AtLeast { value: f32 },
    Exactly { value: f32 },
}

/// Paragraph formatting from the paragraph dialog: only the given fields change (points).
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParagraphFormat {
    #[serde(default)]
    pub line_spacing: Option<LineSpacingOp>,
    #[serde(default)]
    pub space_before: Option<f32>,
    #[serde(default)]
    pub space_after: Option<f32>,
    #[serde(default)]
    pub indent_left: Option<f32>,
    #[serde(default)]
    pub indent_right: Option<f32>,
    /// First-line indent; negative = hanging indent.
    #[serde(default)]
    pub indent_first: Option<f32>,
}

pub const MAX_INDENT_PT: f32 = 1584.0;

/// WordprocessingML stores these lengths in twentieths of a point (and multiples in 240ths of a line): quantize so the
/// edited model equals the model reread from the saved file (T009 reopen comparison).
fn twips(v: f32) -> f32 {
    (v * 20.0).round() / 20.0
}
pub const MAX_SPACING_PT: f32 = 1584.0;

impl ParagraphFormat {
    pub fn valid(&self) -> bool {
        let within = |v: Option<f32>, min: f32, max: f32| {
            v.is_none_or(|v| v.is_finite() && (min..=max).contains(&v))
        };
        let spacing = match self.line_spacing {
            None => true,
            Some(LineSpacingOp::Multiple { value }) => {
                value.is_finite() && (0.5..=10.0).contains(&value)
            }
            Some(LineSpacingOp::AtLeast { value } | LineSpacingOp::Exactly { value }) => {
                value.is_finite() && (1.0..=MAX_SPACING_PT).contains(&value)
            }
        };
        let any = self.line_spacing.is_some()
            || [
                self.space_before,
                self.space_after,
                self.indent_left,
                self.indent_right,
                self.indent_first,
            ]
            .iter()
            .any(Option::is_some);
        any && spacing
            && within(self.space_before, 0.0, MAX_SPACING_PT)
            && within(self.space_after, 0.0, MAX_SPACING_PT)
            && within(self.indent_left, -MAX_INDENT_PT, MAX_INDENT_PT)
            && within(self.indent_right, -MAX_INDENT_PT, MAX_INDENT_PT)
            && within(self.indent_first, -MAX_INDENT_PT, MAX_INDENT_PT)
    }
}

/// List kinds the app creates. Each is a WordCraft built-in definition (`levels_for`), proved on save.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListStyle {
    Numbered,
    NumberedParen,
    UpperLetter,
    LowerLetter,
    LowerRoman,
    Outline,
    Multilevel,
    BulletCircle,
    BulletSquare,
    BulletDash,
    BulletCheck,
}

/// Bullet characters offered as custom bullet definitions (first level; deeper levels use the standard set).
pub const BULLET_CHARS: [(ListStyle, char); 4] = [
    (ListStyle::BulletCircle, '○'),
    (ListStyle::BulletSquare, '▪'),
    (ListStyle::BulletDash, '–'),
    (ListStyle::BulletCheck, '✓'),
];

impl ListStyle {
    fn command(self) -> (&'static str, Value) {
        if let Some((_, c)) = BULLET_CHARS.iter().find(|(s, _)| *s == self) {
            return ("para.bullets", json!({ "kind": c.to_string() }));
        }
        match self {
            ListStyle::Multilevel => ("para.multilevel", json!({ "kind": "legal" })),
            ListStyle::Numbered => ("para.numbering", json!({ "kind": "numbered" })),
            ListStyle::NumberedParen => ("para.numbering", json!({ "kind": "numberedParen" })),
            ListStyle::UpperLetter => ("para.numbering", json!({ "kind": "upperLetter" })),
            ListStyle::LowerLetter => ("para.numbering", json!({ "kind": "lowerLetter" })),
            ListStyle::LowerRoman => ("para.numbering", json!({ "kind": "lowerRoman" })),
            ListStyle::Outline => ("para.numbering", json!({ "kind": "outline" })),
            _ => unreachable!("bullet styles handled above"),
        }
    }
}

/// Paper sizes offered (WordCraft `PAPER_SIZES` names).
pub const PAPER_NAMES: [&str; 7] = ["A3", "A4", "A5", "B4 (JIS)", "B5 (JIS)", "Letter", "Legal"];

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PageSetupOp {
    Margins {
        top: f32,
        bottom: f32,
        left: f32,
        right: f32,
    },
    Orientation {
        landscape: bool,
    },
    Size {
        name: String,
    },
    Columns {
        count: u32,
        space: f32,
    },
}

impl PageSetupOp {
    pub fn valid(&self) -> bool {
        let pt = |v: f32| v.is_finite() && (0.0..=1584.0).contains(&v);
        match self {
            PageSetupOp::Margins {
                top,
                bottom,
                left,
                right,
            } => [*top, *bottom, *left, *right].into_iter().all(pt),
            PageSetupOp::Orientation { .. } => true,
            PageSetupOp::Size { name } => PAPER_NAMES.contains(&name.as_str()),
            PageSetupOp::Columns { count, space } => {
                (1..=12).contains(count) && space.is_finite() && (0.0..=300.0).contains(space)
            }
        }
    }
}

/// A literal search over the main story.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchQuery {
    pub text: String,
    #[serde(default)]
    pub match_case: bool,
    #[serde(default)]
    pub whole_word: bool,
}

fn valid_search_text(text: &str, allow_empty: bool, max: usize) -> bool {
    (allow_empty || !text.is_empty())
        && text.chars().count() <= max
        && !text
            .chars()
            .any(|c| c.is_control() || c == '\u{FFFC}' || c == '\u{2029}')
}

impl SearchQuery {
    pub fn valid(&self) -> bool {
        valid_search_text(&self.text, false, MAX_SEARCH_CHARS)
    }
    fn params(&self) -> Value {
        json!({
            "text": self.text, "matchCase": self.match_case, "wholeWord": self.whole_word,
            "regex": false, "wildcards": false, "special": false,
            "matchPrefix": false, "matchSuffix": false, "ignorePunct": false, "ignoreSpace": false,
        })
    }
}

pub fn valid_replacement(text: &str) -> bool {
    valid_search_text(text, true, super::MAX_TEXT_CHARS)
}

/// Search state for the view: number of current matches and the 0-based index of the selected match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchView {
    pub text: String,
    pub match_case: bool,
    pub whole_word: bool,
    pub count: usize,
    pub current: Option<usize>,
}

/// The selection's paragraph formatting (resolved through styles). `None` values are mixed across the selection.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphView {
    pub align: Option<ParagraphAlign>,
    /// `{rule, value}` of the first selected paragraph when all agree.
    pub line_spacing: Option<LineSpacingView>,
    pub space_before: Option<f32>,
    pub space_after: Option<f32>,
    pub indent_left: Option<f32>,
    pub indent_right: Option<f32>,
    pub indent_first: Option<f32>,
    /// List state of the caret paragraph.
    pub list: Option<ListView>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineSpacingView {
    pub rule: &'static str,
    pub value: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListView {
    pub bullets: bool,
    pub numbering: bool,
    pub multilevel: bool,
    pub level: u8,
}

/// Page setup of the caret's section.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSetupView {
    pub width: f32,
    pub height: f32,
    pub landscape: bool,
    pub margin_top: f32,
    pub margin_bottom: f32,
    pub margin_left: f32,
    pub margin_right: f32,
    pub columns: u32,
    pub column_space: f32,
    /// Paper name when the size matches one offered (either orientation).
    pub paper: Option<&'static str>,
}

/// Character formatting beyond the four flags (selection, or the next typed text).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharView {
    pub size: Option<f32>,
    /// `RRGGBB`, `auto`, or `None` when mixed.
    pub color: Option<String>,
    /// `RRGGBB` of the highlight, `none` when there is none, `None` when mixed.
    pub highlight: Option<String>,
    pub superscript: bool,
    pub subscript: bool,
}

const PAPER_DIMENSIONS: [(&str, f32, f32); 7] = [
    ("A3", 841.89, 1190.55),
    ("A4", 595.28, 841.89),
    ("A5", 419.53, 595.28),
    ("B4 (JIS)", 728.5, 1031.8),
    ("B5 (JIS)", 515.9, 728.5),
    ("Letter", 612.0, 792.0),
    ("Legal", 612.0, 1008.0),
];

fn line_spacing_view(spacing: LineSpacing) -> LineSpacingView {
    match spacing {
        LineSpacing::Multiple(v) => LineSpacingView {
            rule: "multiple",
            value: v,
        },
        LineSpacing::AtLeast(v) => LineSpacingView {
            rule: "atLeast",
            value: v,
        },
        LineSpacing::Exactly(v) => LineSpacingView {
            rule: "exactly",
            value: v,
        },
    }
}

impl DocxModel {
    /// Selected paragraphs share a story and a container (body top level or one table cell) and are all paragraphs.
    fn list_target_supported(&self) -> bool {
        let (a, b) = self.session.sel.ordered();
        if a.story != StoryRef::Body
            || b.story != StoryRef::Body
            || a.path.0.len() != b.path.0.len()
        {
            return false;
        }
        if !matches!(a.path.0.len(), 1 | 4) || a.path.parent() != b.path.parent() {
            return false;
        }
        let Some(blocks) = self.session.doc.container(a.story, &a.path) else {
            return false;
        };
        (a.path.last()..=b.path.last())
            .all(|i| blocks.get(i).is_some_and(|block| block.as_para().is_some()))
    }

    pub(super) fn stage1_align(&mut self, value: ParagraphAlign) -> Result<bool, Rejected> {
        self.run("para.align", json!({ "value": value.engine() }))
    }

    pub(super) fn stage1_font_size(&mut self, size: f32) -> Result<bool, Rejected> {
        if !size.is_finite() || !(1.0..=1638.0).contains(&size) {
            return Err(Rejected);
        }
        self.run("format.size", json!({ "size": size }))
    }

    pub(super) fn stage1_font_color(&mut self, color: &str) -> Result<bool, Rejected> {
        self.run("format.color", json!({ "color": color }))
    }

    pub(super) fn stage1_highlight(&mut self, color: &str) -> Result<bool, Rejected> {
        self.run("format.highlight", json!({ "color": color }))
    }

    pub(super) fn stage1_script(&mut self, value: ScriptValue) -> Result<bool, Rejected> {
        match value {
            ScriptValue::Superscript => self.run("format.superscript", json!({ "value": true })),
            ScriptValue::Subscript => self.run("format.subscript", json!({ "value": true })),
            // Baseline: clear whichever is set (one engine command; the other is already off).
            ScriptValue::Baseline => {
                let state = wordcraft_engine::cmd::format::state(&self.session);
                if state.get("subscript").and_then(Value::as_bool) == Some(true) {
                    self.run("format.subscript", json!({ "value": false }))
                } else {
                    self.run("format.superscript", json!({ "value": false }))
                }
            }
        }
    }

    /// One `para.set` (one undo step). Setting a point indent cancels a character indent of that side, as the
    /// engine's own indent commands do; a point spacing turns off automatic spacing of that side.
    pub(super) fn stage1_paragraph(&mut self, format: &ParagraphFormat) -> Result<bool, Rejected> {
        if !format.valid() {
            return Err(Rejected);
        }
        let current = self
            .session
            .doc
            .para_at(&self.session.sel.focus)
            .map(|p| self.session.doc.styles.resolve_para(&p.props));
        let mut props = ParaProps {
            line_spacing: format.line_spacing.map(|l| match l {
                LineSpacingOp::Multiple { value } => {
                    LineSpacing::Multiple((value * 240.0).round() / 240.0)
                }
                LineSpacingOp::AtLeast { value } => LineSpacing::AtLeast(twips(value)),
                LineSpacingOp::Exactly { value } => LineSpacing::Exactly(twips(value)),
            }),
            space_before: format.space_before.map(twips),
            space_after: format.space_after.map(twips),
            indent_left: format.indent_left.map(twips),
            indent_right: format.indent_right.map(twips),
            indent_first: format.indent_first.map(twips),
            ..Default::default()
        };
        if format.indent_left.is_some() {
            props.indent_left_chars = Some(0.0);
        }
        if format.indent_right.is_some() {
            props.indent_right_chars = Some(0.0);
        }
        if format.indent_first.is_some() {
            props.indent_first_chars = Some(0.0);
        }
        if format.space_before.is_some() && current.as_ref().is_some_and(|c| c.before_auto) {
            props.space_before_auto = Some(false);
        }
        if format.space_after.is_some() && current.as_ref().is_some_and(|c| c.after_auto) {
            props.space_after_auto = Some(false);
        }
        let value = serde_json::to_value(&props).map_err(|_| Rejected)?;
        self.run("para.set", json!({ "props": value }))
    }

    /// Numbered/multilevel/custom bullet list on the selected paragraphs (or off). The engine continues the previous
    /// paragraph's list of the same kind, reuses an existing bullet definition, and toggles off when every selected
    /// paragraph already has that kind (`off` forces removal).
    pub(super) fn stage1_list(&mut self, style: ListStyle, off: bool) -> Result<bool, Rejected> {
        if !self.list_target_supported() {
            return Err(Rejected);
        }
        let (command, mut params) = style.command();
        if off {
            params["off"] = json!(true);
        }
        self.run(command, params)
    }

    /// List level demotion (`outdent: false`) or promotion; plain paragraphs change their left indent by a tab stop.
    pub(super) fn stage1_list_indent(&mut self, outdent: bool) -> Result<bool, Rejected> {
        if !self.list_target_supported() {
            return Err(Rejected);
        }
        self.run(
            if outdent {
                "para.outdent"
            } else {
                "para.indent"
            },
            json!({}),
        )
    }

    /// Restart numbering at the caret paragraph's list (a new `w:num` with start overrides).
    pub(super) fn stage1_restart_numbering(&mut self) -> Result<bool, Rejected> {
        if !self.list_target_supported() || self.list_view().is_none_or(|l| !l.numbering) {
            return Err(Rejected);
        }
        self.run("para.restartNumbering", json!({}))
    }

    /// Continue numbering: join the caret paragraph's list to the nearest earlier list of the same definition.
    pub(super) fn stage1_continue_numbering(&mut self) -> Result<bool, Rejected> {
        if !self.list_target_supported() {
            return Err(Rejected);
        }
        let doc = &self.session.doc;
        let focus = self.session.sel.focus.clone();
        let Some(here) = doc
            .para_at(&focus)
            .and_then(|p| p.props.numbering)
            .filter(|n| n.num != 0)
        else {
            return Err(Rejected);
        };
        let Some(abstract_id) = doc.numbering.num(here.num).map(|n| n.abstract_id) else {
            return Err(Rejected);
        };
        let previous = doc
            .para_paths(focus.story)
            .into_iter()
            .take_while(|p| *p < focus.path)
            .filter_map(|p| doc.para(focus.story, &p).and_then(|q| q.props.numbering))
            .filter(|n| n.num != 0 && n.num != here.num)
            .filter(|n| {
                doc.numbering
                    .num(n.num)
                    .is_some_and(|x| x.abstract_id == abstract_id)
            })
            .last();
        let Some(previous) = previous else {
            return Err(Rejected);
        };
        // `para.set` overlays the numbering reference of the selected paragraphs only (one undo step).
        let level = here.level;
        let props = ParaProps {
            numbering: Some(wordcraft_engine::doc::props::NumRef {
                num: previous.num,
                level,
            }),
            ..Default::default()
        };
        let value = serde_json::to_value(&props).map_err(|_| Rejected)?;
        self.run("para.set", json!({ "props": value }))
    }

    pub(super) fn stage1_page_setup(&mut self, setup: &PageSetupOp) -> Result<bool, Rejected> {
        if !setup.valid() {
            return Err(Rejected);
        }
        match setup {
            PageSetupOp::Margins { top, bottom, left, right } => self.run(
                "layout.margins",
                json!({ "top": twips(*top), "bottom": twips(*bottom), "left": twips(*left), "right": twips(*right) }),
            ),
            PageSetupOp::Orientation { landscape } => self.run(
                "layout.orientation",
                json!({ "value": if *landscape { "landscape" } else { "portrait" } }),
            ),
            // Whole twips (the engine's named sizes are fractional points, e.g. A5 419.53 pt).
            PageSetupOp::Size { name } => {
                let (_, w, h) = PAPER_DIMENSIONS.iter().find(|(n, ..)| n == name).ok_or(Rejected)?;
                self.run("layout.size", json!({ "width": twips(*w), "height": twips(*h) }))
            }
            PageSetupOp::Columns { count, space } => {
                let separator = wordcraft_engine::cmd::page::sect(&self.session).columns.separator;
                self.run(
                    "layout.columns",
                    json!({ "count": count, "space": twips(*space), "separator": separator, "apply": "section" }),
                )
            }
        }
    }

    /// Current matches of `query` in the main story (model positions, document order).
    fn stage1_matches(
        &mut self,
        query: &SearchQuery,
    ) -> Result<Vec<(wordcraft_engine::doc::Pos, wordcraft_engine::doc::Pos)>, Rejected> {
        let mut params = query.params();
        params["in"] = json!("main");
        self.session
            .run("edit.advancedFind", &params)
            .map_err(|_| Rejected)?;
        let mut results = self.session.find.results.clone();
        results.truncate(MAX_SEARCH_RESULTS);
        Ok(results)
    }

    /// Select the next (or previous) match from the selection, wrapping. Navigation only (no revision).
    pub(super) fn stage1_find(
        &mut self,
        query: &SearchQuery,
        backward: bool,
    ) -> Result<bool, Rejected> {
        if !query.valid() {
            return Err(Rejected);
        }
        self.search = Some(query.clone());
        let matches = self.stage1_matches(query)?;
        if matches.is_empty() {
            return Ok(false);
        }
        let (a, b) = self.session.sel.ordered();
        let at = if backward {
            matches
                .iter()
                .rposition(|(_, end)| *end <= a)
                .unwrap_or(matches.len() - 1)
        } else {
            matches
                .iter()
                .position(|(start, _)| *start >= b)
                .unwrap_or(0)
        };
        let (anchor, focus) = matches[at].clone();
        self.select(&anchor, &focus)?;
        Ok(false)
    }

    /// Replace the selected match only if the selection is still exactly a current match; then select the next one.
    pub(super) fn stage1_replace(
        &mut self,
        query: &SearchQuery,
        with: &str,
    ) -> Result<bool, Rejected> {
        if !query.valid() || !valid_replacement(with) {
            return Err(Rejected);
        }
        self.search = Some(query.clone());
        let selected = self.session.sel.ordered();
        if !self.stage1_matches(query)?.contains(&selected) {
            return Err(Rejected);
        }
        let changed = self.atomic(|model| {
            let mut params = query.params();
            params["with"] = json!(with);
            let changed = model.run("edit.replace", params)?;
            if changed {
                Ok(true)
            } else {
                Err(Rejected)
            }
        })?;
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    /// Replace every current match in one engine command (one undo step). No match: rejected (nothing changed).
    pub(super) fn stage1_replace_all(
        &mut self,
        query: &SearchQuery,
        with: &str,
    ) -> Result<bool, Rejected> {
        if !query.valid() || !valid_replacement(with) {
            return Err(Rejected);
        }
        self.search = Some(query.clone());
        if self.stage1_matches(query)?.is_empty() {
            return Err(Rejected);
        }
        let changed = self.atomic(|model| {
            let mut params = query.params();
            params["with"] = json!(with);
            let changed = model.run("edit.replaceAll", params)?;
            if changed {
                Ok(true)
            } else {
                Err(Rejected)
            }
        })?;
        self.session.clamp_selection();
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    pub(super) fn stage1_clear_search(&mut self) {
        self.search = None;
    }

    pub(super) fn search_view(&mut self) -> Option<SearchView> {
        let query = self.search.clone()?;
        let matches = self.stage1_matches(&query).ok()?;
        let selected = self.session.sel.ordered();
        Some(SearchView {
            current: matches.iter().position(|m| *m == selected),
            count: matches.len(),
            text: query.text,
            match_case: query.match_case,
            whole_word: query.whole_word,
        })
    }

    fn list_view(&self) -> Option<ListView> {
        let doc = &self.session.doc;
        let para = doc.para_at(&self.session.sel.focus)?;
        let numbering = doc
            .styles
            .resolve_para(&para.props)
            .numbering
            .filter(|n| n.num != 0)?;
        let buttons = wordcraft_engine::cmd::para::list_buttons(doc, Some(numbering));
        Some(ListView {
            bullets: buttons.bullets,
            numbering: buttons.numbering,
            multilevel: buttons.multilevel,
            level: numbering.level,
        })
    }

    pub(super) fn paragraph_view(&self) -> ParagraphView {
        let doc = &self.session.doc;
        let (a, b) = self.session.sel.ordered();
        let resolved: Vec<_> = doc
            .para_paths_in(&a, &b)
            .into_iter()
            .take(4096)
            .filter_map(|path| {
                doc.para(a.story, &path)
                    .map(|p| doc.styles.resolve_para(&p.props))
            })
            .collect();
        let resolved = if resolved.is_empty() {
            doc.para_at(&self.session.sel.focus)
                .map(|p| vec![doc.styles.resolve_para(&p.props)])
                .unwrap_or_default()
        } else {
            resolved
        };
        fn same<T: PartialEq + Clone>(items: &[T]) -> Option<T> {
            let first = items.first()?.clone();
            items.iter().all(|x| *x == first).then_some(first)
        }
        let align: Vec<_> = resolved
            .iter()
            .map(|r| ParagraphAlign::of(r.align))
            .collect();
        ParagraphView {
            align: same(&align).flatten(),
            line_spacing: same(&resolved.iter().map(|r| r.line_spacing).collect::<Vec<_>>())
                .map(line_spacing_view),
            space_before: same(&resolved.iter().map(|r| r.space_before).collect::<Vec<_>>()),
            space_after: same(&resolved.iter().map(|r| r.space_after).collect::<Vec<_>>()),
            indent_left: same(&resolved.iter().map(|r| r.indent_left).collect::<Vec<_>>()),
            indent_right: same(&resolved.iter().map(|r| r.indent_right).collect::<Vec<_>>()),
            indent_first: same(&resolved.iter().map(|r| r.indent_first).collect::<Vec<_>>()),
            list: self.list_view(),
        }
    }

    pub(super) fn page_view(&self) -> PageSetupView {
        let s = wordcraft_engine::cmd::page::sect(&self.session);
        let paper = PAPER_DIMENSIONS
            .iter()
            .find(|(_, w, h)| {
                ((w - s.page_w).abs() < 0.5 && (h - s.page_h).abs() < 0.5)
                    || ((w - s.page_h).abs() < 0.5 && (h - s.page_w).abs() < 0.5)
            })
            .map(|(name, ..)| *name);
        PageSetupView {
            width: s.page_w,
            height: s.page_h,
            landscape: s.landscape,
            margin_top: s.margin_top,
            margin_bottom: s.margin_bottom,
            margin_left: s.margin_left,
            margin_right: s.margin_right,
            columns: s.columns.count.max(1),
            column_space: s.columns.space,
            paper,
        }
    }

    pub(super) fn char_view(state: &Value) -> CharView {
        let text = |key: &str| state.get(key).and_then(Value::as_str).map(str::to_owned);
        CharView {
            size: state.get("size").and_then(Value::as_f64).map(|v| v as f32),
            color: text("color"),
            // `format.state` reports `null` both for no highlight and for a mixed selection: only a uniform
            // highlight is reported (pressed-state display only; applying never depends on it).
            highlight: text("highlight"),
            superscript: state
                .get("superscript")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            subscript: state
                .get("subscript")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}
