//! WordCraft DOCX table structure editing (Stage 2 Phase 1): capability reporting, strict
//! target validation, atomic execution with round-trip equivalence checking, and Undo/Redo.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::json;
use wordcraft_engine::doc::props::{Align, Border, BorderStyle, HeightRule, VAlign, VMerge};
use wordcraft_engine::doc::table::{MAX_COLS, MAX_ROWS};
use wordcraft_engine::doc::{Block, Cell, Document, InlineObject, StoryRef, Table};

use super::{position_key, DocxModel, FormatAccess, Rejected, SelectionIdentity};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableStructureAction {
    InsertRowAbove,
    InsertRowBelow,
    InsertColumnLeft,
    InsertColumnRight,
    DeleteRow,
    DeleteColumn,
    MergeRight,
    MergeBelow,
    MergeCells,
    SplitCell,
}

impl TableStructureAction {
    pub fn command(self) -> &'static str {
        match self {
            TableStructureAction::InsertRowAbove => "table.insertRowAbove",
            TableStructureAction::InsertRowBelow => "table.insertRowBelow",
            TableStructureAction::InsertColumnLeft => "table.insertColumnLeft",
            TableStructureAction::InsertColumnRight => "table.insertColumnRight",
            TableStructureAction::DeleteRow => "table.deleteRow",
            TableStructureAction::DeleteColumn => "table.deleteColumn",
            TableStructureAction::MergeRight => "table.mergeRight",
            TableStructureAction::MergeBelow => "table.mergeBelow",
            TableStructureAction::MergeCells => "table.mergeCells",
            TableStructureAction::SplitCell => "table.splitCell",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableBorderKind {
    All,
    Outside,
    Inside,
    None,
    Top,
    Bottom,
    Left,
    Right,
}

impl TableBorderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TableBorderKind::All => "all",
            TableBorderKind::Outside => "outside",
            TableBorderKind::Inside => "inside",
            TableBorderKind::None => "none",
            TableBorderKind::Top => "top",
            TableBorderKind::Bottom => "bottom",
            TableBorderKind::Left => "left",
            TableBorderKind::Right => "right",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxCellBorderEdge {
    pub style: &'static str,
    pub width: f32,
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxCellBordersView {
    pub top: Option<DocxCellBorderEdge>,
    pub bottom: Option<DocxCellBorderEdge>,
    pub left: Option<DocxCellBorderEdge>,
    pub right: Option<DocxCellBorderEdge>,
}

pub const DOCX_BORDER_STYLES: &[&str] = &[
    "single", "double", "dotted", "dashed", "thick", "triple", "dotDash", "wave", "none",
];

pub fn normalize_hex_color(raw: &str) -> Option<String> {
    let s = raw.trim().trim_start_matches('#');
    if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(s.to_ascii_uppercase())
}

pub fn valid_docx_border_style(style: &str) -> bool {
    DOCX_BORDER_STYLES.contains(&style)
}

pub fn valid_docx_border_width(width: f32) -> bool {
    width.is_finite() && (0.25..=12.0).contains(&width)
}

/// Table structure state & per-command refusal reasons exposed in `DocxView`.
/// `None` for an action field means the operation is allowed in the current context;
/// `Some(reason)` holds the UI `UnavailableReason` key (`tableShape`, `tableContent`, `limit`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxTableView {
    pub rows: usize,
    pub cols: usize,
    pub row: usize,
    pub col: usize,
    pub row_span: usize,
    pub col_span: usize,
    pub selected_cells: usize,
    pub insert_row_above: Option<&'static str>,
    pub insert_row_below: Option<&'static str>,
    pub insert_column_left: Option<&'static str>,
    pub insert_column_right: Option<&'static str>,
    pub delete_row: Option<&'static str>,
    pub delete_column: Option<&'static str>,
    pub merge_right: Option<&'static str>,
    pub merge_below: Option<&'static str>,
    pub merge_cells: Option<&'static str>,
    pub split_cell: Option<&'static str>,
    pub max_split_rows: usize,
    pub max_split_columns: usize,
    pub has_inside_borders: bool,
    pub cell_shading_refusal: Option<&'static str>,
    pub cell_borders_refusal: Option<&'static str>,
    pub cell_shading: Option<String>,
    pub cell_shading_mixed: bool,
    pub has_cell_shading: bool,
    pub cell_borders: Option<DocxCellBordersView>,
    pub supported_border_styles: &'static [&'static str],
    pub cell_align_horizontal: Option<&'static str>,
    pub cell_align_horizontal_mixed: bool,
    pub cell_align_vertical: Option<&'static str>,
    pub cell_align_vertical_mixed: bool,
    pub cell_alignment_refusal: Option<&'static str>,
    pub col_width: Option<f32>,
    pub col_width_mixed: bool,
    pub row_height: Option<f32>,
    pub row_height_mixed: bool,
    pub row_height_rule: Option<&'static str>,
    pub selected_cols: usize,
    pub selected_rows: usize,
    pub column_width_refusal: Option<&'static str>,
    pub row_height_refusal: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RowHeightRule {
    AtLeast,
    Exact,
}

impl RowHeightRule {
    pub fn as_str(self) -> &'static str {
        match self {
            RowHeightRule::AtLeast => "atLeast",
            RowHeightRule::Exact => "exact",
        }
    }
}

pub(super) fn valid_docx_col_width(w: f32) -> bool {
    w.is_finite() && (6.0..=1584.0).contains(&w)
}

pub(super) fn valid_docx_row_height(h: f32) -> bool {
    h.is_finite() && (1.0..=1584.0).contains(&h)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellHAlign {
    Left,
    Center,
    Right,
    Justify,
}

impl CellHAlign {
    pub fn as_str(self) -> &'static str {
        match self {
            CellHAlign::Left => "left",
            CellHAlign::Center => "center",
            CellHAlign::Right => "right",
            CellHAlign::Justify => "justify",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellVAlign {
    Top,
    Middle,
    Bottom,
}

impl CellVAlign {
    pub fn as_str(self) -> &'static str {
        match self {
            CellVAlign::Top => "top",
            CellVAlign::Middle => "middle",
            CellVAlign::Bottom => "bottom",
        }
    }
}

enum MultiCellState {
    /// Caret or text selection confined inside one cell.
    Single,
    /// Selection crosses out of the table or covers unrelated tables.
    CrossTable,
    /// Valid logical cell rectangle `(r0, r1, g0, g1, distinct_logical_cells)`.
    Rect(usize, usize, usize, usize, usize),
    /// Selection overlaps a merged cell partially.
    PartialOverhang,
}

fn grid_cols(t: &Table, r: usize, c: usize) -> (usize, usize) {
    let g = t.grid_col(r, c);
    let span = t.rows.get(r).and_then(|row| row.cells.get(c)).map_or(1, Cell::span);
    (g, g + span - 1)
}

fn inspect_selection(model: &DocxModel, tp: &wordcraft_engine::doc::Path, t: &Table) -> MultiCellState {
    let sel = &model.session.sel;
    if let Some(range) = model
        .session
        .cell_range()
        .filter(|cr| cr.story == StoryRef::Body && cr.table == *tp)
    {
        return match t.logical_rect_valid(range.rows.0, range.rows.1, range.cols.0, range.cols.1) {
            Some(count) => MultiCellState::Rect(
                range.rows.0,
                range.rows.1,
                range.cols.0,
                range.cols.1,
                count,
            ),
            None => MultiCellState::PartialOverhang,
        };
    }
    if sel.is_collapsed() {
        return MultiCellState::Single;
    }
    if sel.anchor.story != StoryRef::Body || sel.focus.story != StoryRef::Body {
        return MultiCellState::CrossTable;
    }
    match (sel.anchor.path.cell(), sel.focus.path.cell()) {
        (Some((ta, ra, ca)), Some((tb, rb, cb))) if ta == *tp && tb == *tp => {
            if (ra, ca) == (rb, cb) {
                MultiCellState::Single
            } else {
                let (ga0, ga1) = grid_cols(t, ra, ca);
                let (gb0, gb1) = grid_cols(t, rb, cb);
                let (r0, r1, g0, g1) = (ra.min(rb), ra.max(rb), ga0.min(gb0), ga1.max(gb1));
                match t.logical_rect_valid(r0, r1, g0, g1) {
                    Some(count) => MultiCellState::Rect(r0, r1, g0, g1, count),
                    None => MultiCellState::PartialOverhang,
                }
            }
        }
        _ => MultiCellState::CrossTable,
    }
}

fn collect_obj_media(obj: &InlineObject, used: &mut BTreeSet<String>) {
    match obj {
        InlineObject::Image { media, .. } => {
            used.insert(media.clone());
        }
        InlineObject::Group { children, .. } => {
            for child in children {
                collect_obj_media(&child.obj, used);
            }
        }
        _ => {}
    }
}

fn collect_block_media(blocks: &[std::sync::Arc<Block>], used: &mut BTreeSet<String>) {
    for block in blocks {
        match block.as_ref() {
            Block::Para(p) => {
                for obj in &p.objects {
                    collect_obj_media(obj, used);
                }
            }
            Block::Table(t) => {
                for row in &t.rows {
                    for cell in &row.cells {
                        collect_block_media(&cell.blocks, used);
                    }
                }
            }
        }
    }
}

/// Prune unreferenced `Document::media` entries after deleting rows/columns so
/// `roundtrip_equivalent` and DOCX serialization do not retain orphaned image parts
/// (Undo snapshots preserve the prior `Document::media` intact).
fn retain_used_media(doc: &mut Document) {
    if doc.media.is_empty() {
        return;
    }
    let mut used = BTreeSet::new();
    collect_block_media(&doc.body, &mut used);
    for part in doc.parts.values() {
        collect_block_media(&part.blocks, &mut used);
    }
    doc.media.retain(|key, _| used.contains(key));
}

fn refusal_for(
    model: &DocxModel,
    t: &Table,
    ext: (usize, usize, usize, usize),
    multi: &MultiCellState,
    action: TableStructureAction,
    split_dims: Option<(u32, u32)>,
) -> Option<&'static str> {
    if matches!(multi, MultiCellState::CrossTable) {
        return Some("tableShape");
    }
    if !matches!(action, TableStructureAction::SplitCell) && split_dims.is_some() {
        return Some("tableShape");
    }
    let (r0, r1, g0, g1) = ext;
    let ncols = t.grid.len();
    let nrows = t.rows.len();
    let multi_active = match multi {
        MultiCellState::Rect(_, _, _, _, count) => *count > 1,
        MultiCellState::PartialOverhang => true,
        MultiCellState::Single | MultiCellState::CrossTable => false,
    };
    let (sel_r0, sel_r1, _sel_g0, _sel_g1) = match multi {
        MultiCellState::Rect(ar0, ar1, ag0, ag1, _) => (*ar0, *ar1, *ag0, *ag1),
        _ => (r0, r1, g0, g1),
    };
    match action {
        TableStructureAction::InsertRowAbove | TableStructureAction::InsertRowBelow => {
            let count = sel_r1.saturating_sub(sel_r0) + 1;
            if nrows.saturating_add(count) > MAX_ROWS {
                return Some("limit");
            }
            let like = if matches!(action, TableStructureAction::InsertRowBelow) {
                sel_r1
            } else {
                sel_r0
            };
            if t.rect_has_controls(like, like, 0, ncols.saturating_sub(1)) {
                return Some("tableContent");
            }
            let _ = model;
            None
        }
        TableStructureAction::InsertColumnLeft | TableStructureAction::InsertColumnRight => {
            if ncols >= MAX_COLS {
                Some("limit")
            } else {
                None
            }
        }
        TableStructureAction::DeleteRow => {
            let rows_to_delete: BTreeSet<usize> = match multi {
                MultiCellState::Rect(ar0, ar1, _, _, _) => (*ar0..=*ar1).collect(),
                _ => {
                    let Some((_, fr, _)) = model.session.sel.focus.path.cell() else {
                        return Some("tableShape");
                    };
                    [fr].into_iter().collect()
                }
            };
            if nrows <= 1 || rows_to_delete.len() >= nrows {
                return Some("tableShape");
            }
            for &rr in &rows_to_delete {
                if t.rect_has_controls(rr, rr, 0, ncols.saturating_sub(1)) {
                    return Some("tableContent");
                }
            }
            let mut probe = (rows_to_delete.len() > 1).then(|| t.clone());
            for &rr in rows_to_delete.iter().rev() {
                let ok = if let Some(ref mut p) = probe {
                    p.delete_row_safe(rr)
                } else {
                    t.can_delete_row_safe(rr)
                };
                if !ok {
                    return Some("tableContent");
                }
            }
            None
        }
        TableStructureAction::DeleteColumn => {
            let cols: BTreeSet<usize> = match multi {
                MultiCellState::Rect(ar0, ar1, ag0, ag1, _) => {
                    let mut set = BTreeSet::new();
                    for rr in *ar0..=*ar1 {
                        if let (Some(ca), Some(cb)) = (t.cell_at_grid(rr, *ag0), t.cell_at_grid(rr, *ag1)) {
                            for cc in ca..=cb {
                                let (a, b) = grid_cols(t, rr, cc);
                                set.extend(a..=b);
                            }
                        }
                    }
                    set
                }
                _ => (g0..=g1).collect(),
            };
            if ncols <= 1 || cols.is_empty() || cols.len() >= ncols {
                return Some("tableShape");
            }
            for &g in &cols {
                if t.rect_has_controls(0, nrows.saturating_sub(1), g, g) {
                    return Some("tableContent");
                }
            }
            None
        }
        TableStructureAction::MergeRight => {
            if multi_active {
                return Some("tableShape");
            }
            let next_g = g1 + 1;
            let Some(nc) = t.cell_at_grid(r0, next_g) else {
                return Some("tableShape");
            };
            let Some((nr0, nr1, ng0, ng1)) = t.cell_extent(r0, nc) else {
                return Some("tableShape");
            };
            if nr0 != r0 || nr1 != r1 || ng0 != next_g {
                return Some("tableShape");
            }
            if t.rect_has_controls(r0, r1, g0, ng1) || !t.can_merge_rect(r0, r1, g0, ng1) {
                return Some("tableContent");
            }
            None
        }
        TableStructureAction::MergeBelow => {
            if multi_active {
                return Some("tableShape");
            }
            let next_r = r1 + 1;
            let Some(bc) = t.cell_at_grid(next_r, g0) else {
                return Some("tableShape");
            };
            let Some((br0, br1, bg0, bg1)) = t.cell_extent(next_r, bc) else {
                return Some("tableShape");
            };
            if br0 != next_r || bg0 != g0 || bg1 != g1 {
                return Some("tableShape");
            }
            if t.rect_has_controls(r0, br1, g0, g1) || !t.can_merge_rect(r0, br1, g0, g1) {
                return Some("tableContent");
            }
            None
        }
        TableStructureAction::MergeCells => match multi {
            MultiCellState::Rect(ar0, ar1, ag0, ag1, count) if *count >= 2 => {
                if t.rect_has_controls(*ar0, *ar1, *ag0, *ag1) || !t.can_merge_rect(*ar0, *ar1, *ag0, *ag1) {
                    Some("tableContent")
                } else {
                    None
                }
            }
            _ => Some("tableShape"),
        },
        TableStructureAction::SplitCell => {
            if multi_active {
                return Some("tableShape");
            }
            let is_merged = r1 > r0 || g1 > g0;
            if is_merged {
                if split_dims.is_some() {
                    return Some("tableShape");
                }
                if t.rect_has_controls(r0, r1, g0, g1) {
                    return Some("tableContent");
                }
                return None;
            }
            let Some(ci) = t.cell_at_grid(r0, g0) else {
                return Some("tableShape");
            };
            let Some(cell) = t.rows.get(r0).and_then(|row| row.cells.get(ci)) else {
                return Some("tableShape");
            };
            if !cell.controls.is_empty() {
                return Some("tableContent");
            }
            let Some((mr, mc)) = t.unmerged_split_limits(r0, ci) else {
                let controls_block = t.rect_has_controls(r0, r0, 0, ncols.saturating_sub(1))
                    || t.rect_has_controls(0, nrows.saturating_sub(1), g0, g0);
                return Some(if controls_block { "tableContent" } else { "limit" });
            };
            if let Some((sr, sc)) = split_dims {
                if sr == 0 || sc == 0 || sr * sc < 2 || sr as usize > mr || sc as usize > mc {
                    return Some("limit");
                }
            }
            None
        }
    }
}

fn border_style_name(style: BorderStyle) -> &'static str {
    match style {
        BorderStyle::None => "none",
        BorderStyle::Single => "single",
        BorderStyle::Double => "double",
        BorderStyle::Dotted => "dotted",
        BorderStyle::Dashed => "dashed",
        BorderStyle::Thick => "thick",
        BorderStyle::Triple => "triple",
        BorderStyle::DotDash => "dotDash",
        BorderStyle::Wave => "wave",
    }
}

fn edge_from_border(b: Option<&Border>) -> Option<DocxCellBorderEdge> {
    let b = b?;
    Some(DocxCellBorderEdge {
        style: border_style_name(b.style),
        width: b.width,
        color: b.color.map(|rgb| format!("#{}", rgb.hex())),
    })
}

fn cell_format_refusal(model: &DocxModel, multi: &MultiCellState) -> Option<&'static str> {
    if FormatAccess::of(&model.session) == FormatAccess::Protected {
        return Some("protected");
    }
    match multi {
        MultiCellState::CrossTable => Some("crossTable"),
        MultiCellState::PartialOverhang => Some("partialOverhang"),
        MultiCellState::Single | MultiCellState::Rect(..) => None,
    }
}

fn selected_rect_bounds(
    ext: (usize, usize, usize, usize),
    multi: &MultiCellState,
) -> (usize, usize, usize, usize) {
    match multi {
        MultiCellState::Rect(r0, r1, g0, g1, _) => (*r0, *r1, *g0, *g1),
        _ => ext,
    }
}

fn resolve_cell_borders(
    t: &Table,
    r0: usize,
    r1: usize,
    g0: usize,
    g1: usize,
) -> Option<DocxCellBordersView> {
    let tbl_b = t.props.borders.as_ref();
    let pick = |r: usize, g: usize| -> Option<&Cell> {
        let ci = t.cell_at_grid(r, g)?;
        t.rows.get(r)?.cells.get(ci)
    };
    let top_cell = pick(r0, g0)?;
    let bottom_cell = pick(r1, g0)?;
    let left_cell = pick(r0, g0)?;
    let right_cell = pick(r0, g1)?;
    let top = top_cell
        .props
        .borders
        .as_ref()
        .and_then(|b| b.top.as_ref())
        .or_else(|| {
            if r0 == 0 {
                tbl_b.and_then(|b| b.top.as_ref())
            } else {
                tbl_b.and_then(|b| b.between.as_ref())
            }
        });
    let bottom = bottom_cell
        .props
        .borders
        .as_ref()
        .and_then(|b| b.bottom.as_ref())
        .or_else(|| {
            if r1 + 1 == t.rows.len() {
                tbl_b.and_then(|b| b.bottom.as_ref())
            } else {
                tbl_b.and_then(|b| b.between.as_ref())
            }
        });
    let left = left_cell
        .props
        .borders
        .as_ref()
        .and_then(|b| b.left.as_ref())
        .or_else(|| {
            if g0 == 0 {
                tbl_b.and_then(|b| b.left.as_ref())
            } else {
                tbl_b.and_then(|b| b.inside_v.as_ref())
            }
        });
    let right = right_cell
        .props
        .borders
        .as_ref()
        .and_then(|b| b.right.as_ref())
        .or_else(|| {
            if g1 + 1 == t.grid.len() {
                tbl_b.and_then(|b| b.right.as_ref())
            } else {
                tbl_b.and_then(|b| b.inside_v.as_ref())
            }
        });
    Some(DocxCellBordersView {
        top: edge_from_border(top),
        bottom: edge_from_border(bottom),
        left: edge_from_border(left),
        right: edge_from_border(right),
    })
}

fn inspect_cell_shading(
    t: &Table,
    r0: usize,
    r1: usize,
    g0: usize,
    g1: usize,
) -> (Option<String>, bool, bool) {
    let mut seen = BTreeSet::new();
    let mut any_shaded = false;
    let mut first_hex: Option<String> = None;
    let mut mixed = false;
    for r in r0..=r1 {
        for g in g0..=g1 {
            let Some(ci) = t.cell_at_grid(r, g) else { continue };
            let Some(cell) = t.rows.get(r).and_then(|row| row.cells.get(ci)) else { continue };
            if cell.props.vmerge == VMerge::Continue {
                continue;
            }
            if !seen.insert((r, ci)) {
                continue;
            }
            let hex = cell.props.shading.map(|rgb| format!("#{}", rgb.hex()));
            if hex.is_some() {
                any_shaded = true;
            }
            if seen.len() == 1 {
                first_hex = hex;
            } else if first_hex != hex {
                mixed = true;
            }
        }
    }
    (if mixed { None } else { first_hex }, mixed, any_shaded)
}

fn inspect_cell_alignment(
    doc: &Document,
    t: &Table,
    r0: usize,
    r1: usize,
    g0: usize,
    g1: usize,
) -> (Option<&'static str>, bool, Option<&'static str>, bool) {
    let mut seen = BTreeSet::new();
    let mut h_first: Option<&'static str> = None;
    let mut h_mixed = false;
    let mut v_first: Option<&'static str> = None;
    let mut v_mixed = false;
    for r in r0..=r1 {
        for g in g0..=g1 {
            let Some(ci) = t.cell_at_grid(r, g) else { continue };
            let Some(cell) = t.rows.get(r).and_then(|row| row.cells.get(ci)) else { continue };
            if cell.props.vmerge == VMerge::Continue {
                continue;
            }
            if !seen.insert((r, ci)) {
                continue;
            }
            let va = match cell.props.valign {
                VAlign::Top => "top",
                VAlign::Center => "middle",
                VAlign::Bottom => "bottom",
            };
            match v_first {
                None => v_first = Some(va),
                Some(prev) if prev != va => v_mixed = true,
                _ => {}
            }
            for b in &cell.blocks {
                if h_mixed {
                    break;
                }
                if let Block::Para(p) = b.as_ref() {
                    let h = match doc.styles.resolve_para(&p.props).align {
                        Align::Left => Some("left"),
                        Align::Center => Some("center"),
                        Align::Right => Some("right"),
                        Align::Justify => Some("justify"),
                        Align::Distribute => None,
                    };
                    match (h_first, h) {
                        (_, None) => h_mixed = true,
                        (None, Some(v)) => h_first = Some(v),
                        (Some(prev), Some(v)) if prev != v => h_mixed = true,
                        _ => {}
                    }
                }
            }
        }
    }
    (
        if h_mixed { None } else { h_first },
        h_mixed,
        if v_mixed { None } else { v_first },
        v_mixed,
    )
}

fn round_pt(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

fn inspect_dimensions(
    t: &Table,
    r0: usize,
    r1: usize,
    g0: usize,
    g1: usize,
) -> (Option<f32>, bool, Option<f32>, bool, Option<&'static str>) {
    let mut w_first: Option<f32> = None;
    let mut w_mixed = false;
    for g in g0..=g1 {
        if let Some(&w) = t.grid.get(g) {
            match w_first {
                None => w_first = Some(w),
                Some(prev) if (prev - w).abs() > 0.05 => w_mixed = true,
                _ => {}
            }
        }
    }
    let mut h_first: Option<Option<f32>> = None;
    let mut h_mixed = false;
    let mut rule_first: Option<&'static str> = None;
    for r in r0..=r1 {
        if let Some(row) = t.rows.get(r) {
            let cur = row.props.height;
            let rule = match row.props.height_rule {
                HeightRule::AtLeast => Some("atLeast"),
                HeightRule::Exact => Some("exact"),
                HeightRule::Auto => None,
            };
            match h_first {
                None => {
                    h_first = Some(cur);
                    rule_first = rule;
                }
                Some(prev) => {
                    let eq = match (prev, cur) {
                        (None, None) => true,
                        (Some(a), Some(b)) => (a - b).abs() <= 0.05 && rule_first == rule,
                        _ => false,
                    };
                    if !eq {
                        h_mixed = true;
                    }
                }
            }
        }
    }
    (
        if w_mixed { None } else { w_first.map(round_pt) },
        w_mixed,
        if h_mixed { None } else { h_first.flatten().map(round_pt) },
        h_mixed,
        if h_mixed { None } else { rule_first },
    )
}

impl DocxModel {
    pub(super) fn table_view(&self) -> Option<DocxTableView> {
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body {
            return None;
        }
        let (tp, r, c) = focus.path.cell()?;
        let t = self.session.doc.table(StoryRef::Body, &tp)?;
        let Some(ext) = (if t.is_grid_consistent() { t.cell_extent(r, c) } else { None }) else {
            return Some(DocxTableView {
                rows: t.rows.len(),
                cols: t.cols(),
                row: r,
                col: c,
                row_span: 1,
                col_span: 1,
                selected_cells: 1,
                insert_row_above: Some("tableShape"),
                insert_row_below: Some("tableShape"),
                insert_column_left: Some("tableShape"),
                insert_column_right: Some("tableShape"),
                delete_row: Some("tableShape"),
                delete_column: Some("tableShape"),
                merge_right: Some("tableShape"),
                merge_below: Some("tableShape"),
                merge_cells: Some("tableShape"),
                split_cell: Some("tableShape"),
                max_split_rows: 0,
                max_split_columns: 0,
                has_inside_borders: false,
                cell_shading_refusal: Some("tableShape"),
                cell_borders_refusal: Some("tableShape"),
                cell_shading: None,
                cell_shading_mixed: false,
                has_cell_shading: false,
                cell_borders: None,
                supported_border_styles: DOCX_BORDER_STYLES,
                cell_align_horizontal: None,
                cell_align_horizontal_mixed: false,
                cell_align_vertical: None,
                cell_align_vertical_mixed: false,
                cell_alignment_refusal: Some("tableShape"),
                col_width: None,
                col_width_mixed: false,
                row_height: None,
                row_height_mixed: false,
                row_height_rule: None,
                selected_cols: 1,
                selected_rows: 1,
                column_width_refusal: Some("tableShape"),
                row_height_refusal: Some("tableShape"),
            });
        };
        let multi = inspect_selection(self, &tp, t);
        let selected_cells = match multi {
            MultiCellState::Rect(_, _, _, _, count) => count,
            _ => 1,
        };
        let has_inside_borders = matches!(multi, MultiCellState::Rect(_, _, _, _, count) if count >= 2);
        let format_refusal = cell_format_refusal(self, &multi);
        let (r0, r1, g0, g1) = selected_rect_bounds(ext, &multi);
        let (cell_shading, cell_shading_mixed, has_cell_shading) = if format_refusal.is_some() {
            (None, false, false)
        } else {
            inspect_cell_shading(t, r0, r1, g0, g1)
        };
        let cell_borders = if format_refusal.is_some() {
            None
        } else {
            resolve_cell_borders(t, r0, r1, g0, g1)
        };
        let (
            cell_align_horizontal,
            cell_align_horizontal_mixed,
            cell_align_vertical,
            cell_align_vertical_mixed,
        ) = if format_refusal.is_some() {
            (None, false, None, false)
        } else {
            inspect_cell_alignment(&self.session.doc, t, r0, r1, g0, g1)
        };
        let (col_width, col_width_mixed, row_height, row_height_mixed, row_height_rule) =
            if format_refusal.is_some() {
                (None, false, None, false, None)
            } else {
                inspect_dimensions(t, r0, r1, g0, g1)
            };
        let reason = |a| refusal_for(self, t, ext, &multi, a, None);
        let is_merged = ext.1 > ext.0 || ext.3 > ext.2;
        let (max_split_rows, max_split_columns) = if is_merged
            || matches!(multi, MultiCellState::CrossTable | MultiCellState::PartialOverhang)
            || matches!(multi, MultiCellState::Rect(_, _, _, _, count) if count > 1)
        {
            (0, 0)
        } else if let Some(ci) = t.cell_at_grid(ext.0, ext.2) {
            t.unmerged_split_limits(ext.0, ci).unwrap_or((0, 0))
        } else {
            (0, 0)
        };
        Some(DocxTableView {
            rows: t.rows.len(),
            cols: t.grid.len(),
            row: ext.0,
            col: ext.2,
            row_span: ext.1 - ext.0 + 1,
            col_span: ext.3 - ext.2 + 1,
            selected_cells,
            insert_row_above: reason(TableStructureAction::InsertRowAbove),
            insert_row_below: reason(TableStructureAction::InsertRowBelow),
            insert_column_left: reason(TableStructureAction::InsertColumnLeft),
            insert_column_right: reason(TableStructureAction::InsertColumnRight),
            delete_row: reason(TableStructureAction::DeleteRow),
            delete_column: reason(TableStructureAction::DeleteColumn),
            merge_right: reason(TableStructureAction::MergeRight),
            merge_below: reason(TableStructureAction::MergeBelow),
            merge_cells: reason(TableStructureAction::MergeCells),
            split_cell: reason(TableStructureAction::SplitCell),
            max_split_rows,
            max_split_columns,
            has_inside_borders,
            cell_shading_refusal: format_refusal,
            cell_borders_refusal: format_refusal,
            cell_shading,
            cell_shading_mixed,
            has_cell_shading,
            cell_borders,
            supported_border_styles: DOCX_BORDER_STYLES,
            cell_align_horizontal,
            cell_align_horizontal_mixed,
            cell_align_vertical,
            cell_align_vertical_mixed,
            cell_alignment_refusal: format_refusal,
            col_width,
            col_width_mixed,
            row_height,
            row_height_mixed,
            row_height_rule,
            selected_cols: g1 - g0 + 1,
            selected_rows: r1 - r0 + 1,
            column_width_refusal: format_refusal,
            row_height_refusal: format_refusal,
        })
    }

    pub(super) fn table_structure(
        &mut self,
        action: TableStructureAction,
        target: &SelectionIdentity,
        rows: Option<u32>,
        columns: Option<u32>,
    ) -> Result<bool, Rejected> {
        if position_key(&self.session.sel.anchor) != target.anchor_key
            || position_key(&self.session.sel.focus) != target.caret_key
        {
            return Err(Rejected);
        }
        let split_dims = match (rows, columns) {
            (None, None) => None,
            (Some(r), Some(c)) => Some((r, c)),
            _ => return Err(Rejected),
        };
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body || self.session.sel.anchor.story != StoryRef::Body {
            return Err(Rejected);
        }
        let (tp, r, c) = focus.path.cell().ok_or(Rejected)?;
        let t = self.session.doc.table(StoryRef::Body, &tp).ok_or(Rejected)?;
        if !t.is_grid_consistent() {
            return Err(Rejected);
        }
        let ext = t.cell_extent(r, c).ok_or(Rejected)?;
        let multi = inspect_selection(self, &tp, t);
        if refusal_for(self, t, ext, &multi, action, split_dims).is_some() {
            return Err(Rejected);
        }
        let params = match split_dims {
            Some((sr, sc)) => json!({ "rows": sr, "columns": sc }),
            None => json!({}),
        };
        let changed = self.atomic(|model| {
            let changed = model.run(action.command(), params.clone())?;
            if !changed {
                return Err(Rejected);
            }
            if matches!(action, TableStructureAction::DeleteRow | TableStructureAction::DeleteColumn) {
                retain_used_media(&mut model.session.doc);
            }
            let updated_tp = model
                .session
                .sel
                .focus
                .path
                .cell()
                .map(|(p, _, _)| p)
                .ok_or(Rejected)?;
            if updated_tp != tp {
                return Err(Rejected);
            }
            let updated_table = model
                .session
                .doc
                .table(StoryRef::Body, &updated_tp)
                .ok_or(Rejected)?;
            if !updated_table.is_grid_consistent() {
                return Err(Rejected);
            }
            if !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(true)
        })?;
        self.session.clamp_selection();
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    pub(super) fn table_shading(
        &mut self,
        target: &SelectionIdentity,
        color: Option<&str>,
    ) -> Result<bool, Rejected> {
        if position_key(&self.session.sel.anchor) != target.anchor_key
            || position_key(&self.session.sel.focus) != target.caret_key
        {
            return Err(Rejected);
        }
        let normalized_color = match color {
            Some(raw) => Some(normalize_hex_color(raw).ok_or(Rejected)?),
            None => None,
        };
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body || self.session.sel.anchor.story != StoryRef::Body {
            return Err(Rejected);
        }
        let (tp, _, _) = focus.path.cell().ok_or(Rejected)?;
        let t = self.session.doc.table(StoryRef::Body, &tp).ok_or(Rejected)?;
        if !t.is_grid_consistent() {
            return Err(Rejected);
        }
        let multi = inspect_selection(self, &tp, t);
        if cell_format_refusal(self, &multi).is_some() {
            return Err(Rejected);
        }
        let params = json!({ "color": normalized_color });
        let changed = self.atomic(|model| {
            let changed = model.run("table.shading", params.clone())?;
            if !changed {
                return Ok(false);
            }
            if !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(true)
        })?;
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    pub(super) fn table_cell_borders(
        &mut self,
        target: &SelectionIdentity,
        kind: TableBorderKind,
        style: Option<&str>,
        width: Option<f32>,
        color: Option<&str>,
    ) -> Result<bool, Rejected> {
        if position_key(&self.session.sel.anchor) != target.anchor_key
            || position_key(&self.session.sel.focus) != target.caret_key
        {
            return Err(Rejected);
        }
        if let Some(s) = style {
            if !valid_docx_border_style(s) {
                return Err(Rejected);
            }
        }
        if let Some(w) = width {
            if !valid_docx_border_width(w) {
                return Err(Rejected);
            }
        }
        let normalized_color = match color {
            Some(raw) => Some(normalize_hex_color(raw).ok_or(Rejected)?),
            None => None,
        };
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body || self.session.sel.anchor.story != StoryRef::Body {
            return Err(Rejected);
        }
        let (tp, _, _) = focus.path.cell().ok_or(Rejected)?;
        let t = self.session.doc.table(StoryRef::Body, &tp).ok_or(Rejected)?;
        if !t.is_grid_consistent() {
            return Err(Rejected);
        }
        let multi = inspect_selection(self, &tp, t);
        if cell_format_refusal(self, &multi).is_some() {
            return Err(Rejected);
        }
        if matches!(kind, TableBorderKind::Inside)
            && !matches!(multi, MultiCellState::Rect(_, _, _, _, count) if count >= 2)
        {
            return Err(Rejected);
        }
        let params = json!({
            "kind": kind.as_str(),
            "style": style,
            "width": width,
            "color": normalized_color,
        });
        let changed = self.atomic(|model| {
            let changed = model.run("table.cellBorders", params.clone())?;
            if !changed {
                return Ok(false);
            }
            if !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(true)
        })?;
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    pub(super) fn table_cell_alignment(
        &mut self,
        target: &SelectionIdentity,
        horizontal: Option<CellHAlign>,
        vertical: Option<CellVAlign>,
    ) -> Result<bool, Rejected> {
        if position_key(&self.session.sel.anchor) != target.anchor_key
            || position_key(&self.session.sel.focus) != target.caret_key
        {
            return Err(Rejected);
        }
        if horizontal.is_none() && vertical.is_none() {
            return Err(Rejected);
        }
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body || self.session.sel.anchor.story != StoryRef::Body {
            return Err(Rejected);
        }
        let (tp, _, _) = focus.path.cell().ok_or(Rejected)?;
        let t = self.session.doc.table(StoryRef::Body, &tp).ok_or(Rejected)?;
        if !t.is_grid_consistent() {
            return Err(Rejected);
        }
        let multi = inspect_selection(self, &tp, t);
        if cell_format_refusal(self, &multi).is_some() {
            return Err(Rejected);
        }
        let params = json!({
            "horizontal": horizontal.map(CellHAlign::as_str),
            "vertical": vertical.map(CellVAlign::as_str),
        });
        let changed = self.atomic(|model| {
            let changed = model.run("table.cellAlignment", params.clone())?;
            if !changed {
                return Ok(false);
            }
            if !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(true)
        })?;
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    pub(super) fn table_column_width(
        &mut self,
        target: &SelectionIdentity,
        width: Option<f32>,
        distribute: bool,
    ) -> Result<bool, Rejected> {
        if position_key(&self.session.sel.anchor) != target.anchor_key
            || position_key(&self.session.sel.focus) != target.caret_key
        {
            return Err(Rejected);
        }
        let params = match (distribute, width) {
            (true, None) => json!({ "distribute": true }),
            (false, Some(w)) if valid_docx_col_width(w) => json!({ "width": w }),
            _ => return Err(Rejected),
        };
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body || self.session.sel.anchor.story != StoryRef::Body {
            return Err(Rejected);
        }
        let (tp, _, _) = focus.path.cell().ok_or(Rejected)?;
        let t = self.session.doc.table(StoryRef::Body, &tp).ok_or(Rejected)?;
        if !t.is_grid_consistent() {
            return Err(Rejected);
        }
        let multi = inspect_selection(self, &tp, t);
        if cell_format_refusal(self, &multi).is_some() {
            return Err(Rejected);
        }
        let changed = self.atomic(|model| {
            let changed = model.run("table.setColumnWidth", params.clone())?;
            if !changed {
                return Ok(false);
            }
            if !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(true)
        })?;
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    pub(super) fn table_row_height(
        &mut self,
        target: &SelectionIdentity,
        height: Option<f32>,
        rule: Option<RowHeightRule>,
        clear: bool,
        distribute: bool,
    ) -> Result<bool, Rejected> {
        if position_key(&self.session.sel.anchor) != target.anchor_key
            || position_key(&self.session.sel.focus) != target.caret_key
        {
            return Err(Rejected);
        }
        let params = if distribute {
            if height.is_some() || rule.is_some() || clear {
                return Err(Rejected);
            }
            json!({ "distribute": true })
        } else if clear {
            if height.is_some() || rule.is_some() {
                return Err(Rejected);
            }
            json!({ "height": null })
        } else if let Some(h) = height {
            if !valid_docx_row_height(h) {
                return Err(Rejected);
            }
            json!({
                "height": h,
                "rule": rule.unwrap_or(RowHeightRule::AtLeast).as_str(),
            })
        } else {
            return Err(Rejected);
        };
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body || self.session.sel.anchor.story != StoryRef::Body {
            return Err(Rejected);
        }
        let (tp, _, _) = focus.path.cell().ok_or(Rejected)?;
        let t = self.session.doc.table(StoryRef::Body, &tp).ok_or(Rejected)?;
        if !t.is_grid_consistent() {
            return Err(Rejected);
        }
        let multi = inspect_selection(self, &tp, t);
        if cell_format_refusal(self, &multi).is_some() {
            return Err(Rejected);
        }
        let changed = self.atomic(|model| {
            let changed = model.run("table.setRowHeight", params.clone())?;
            if !changed {
                return Ok(false);
            }
            if !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(true)
        })?;
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }
}
