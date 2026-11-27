//! Stage 1 F: embedding a font into a DOCX document model (ECMA-376 Part 1, 17.8 "Fonts": 17.8.3.3–6
//! `w:embedRegular`/`w:embedBold`/`w:embedItalic`/`w:embedBoldItalic`, 17.8.1 font obfuscation).
//!
//! WordCraft keeps `word/fontTable.xml` and the parts it relates to as an opaque part tree (`passthrough` +
//! the `wordcraft:embedded.parts` manifest) and writes that tree back verbatim (`EmbedWriter::font_table`).
//! It has no API that creates embedded fonts, so geul adds one at the model level: the font table gains the
//! embed element for the face's style slot, the obfuscated font program becomes a kept part
//! (`word/fonts/fontN.odttf`, content type `application/vnd.openxmlformats-officedocument.obfuscatedFont`), and
//! the manifest gains the part and the font-table relationship (type `.../relationships/font`). The manifest is
//! written in exactly the canonical form WordCraft's reader produces (`EmbeddedManifest::to_bytes`), so the
//! saved package reopens to an equal model (T009 `roundtrip_equivalent` compares `passthrough`).
//!
//! Existing font table content, existing embedded fonts and every other part stay byte-identical. One slot of
//! one family holds at most one font; the same font program embedded again is recognised (same content-derived
//! key and bytes) and nothing is duplicated.

use std::collections::BTreeMap;
use std::sync::Arc;

use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::XmlVersion;
use wordcraft_engine::doc::Document;

use crate::fonts::embedding;

/// WordCraft's kept-part manifest key and font table part (`wordcraft-docx` `package::EMBEDDED_PARTS`,
/// `write::embed::FONT_TABLE_PART`).
pub const MANIFEST: &str = "wordcraft:embedded.parts";
pub const FONT_TABLE: &str = "word/fontTable.xml";
pub const FONT_TABLE_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml";
pub const OBFUSCATED_FONT: &str = "application/vnd.openxmlformats-officedocument.obfuscatedFont";
pub const FONT_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";
pub const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
pub const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/// `wordcraft-docx` limits: past these the reader/writer drops entries, so geul refuses instead.
const MAX_PARTS: usize = 4096;
const MAX_RELS: usize = 1024;
/// The four embed slots in schema order (CT_Font: … sig, embedRegular, embedBold, embedItalic, embedBoldItalic).
const SLOTS: [&str; 4] = [
    "embedRegular",
    "embedBold",
    "embedItalic",
    "embedBoldItalic",
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rel {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub external: bool,
}

/// The kept-part manifest (same text format and canonical order as WordCraft's `EmbeddedManifest`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Manifest {
    pub parts: BTreeMap<String, (String, Vec<Rel>)>,
}

fn field_ok(s: &str) -> bool {
    !s.is_empty() && !s.contains(['\t', '\r', '\n'])
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Manifest {
        let mut m = Manifest::default();
        for line in String::from_utf8_lossy(bytes).lines() {
            let f: Vec<&str> = line.split('\t').collect();
            match f.as_slice() {
                ["P", part, ct] if m.parts.len() < MAX_PARTS => {
                    m.parts
                        .entry((*part).to_string())
                        .or_insert_with(|| ((*ct).to_string(), Vec::new()));
                }
                ["R", part, id, kind, target, mode] => {
                    if let Some(p) = m.parts.get_mut(*part) {
                        if p.1.len() < MAX_RELS && !p.1.iter().any(|r| r.id == *id) {
                            p.1.push(Rel {
                                id: (*id).into(),
                                kind: (*kind).into(),
                                target: (*target).into(),
                                external: *mode == "E",
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        m
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut s = String::new();
        for (part, (ct, _)) in &self.parts {
            if field_ok(part) && field_ok(ct) {
                s.push_str(&format!("P\t{part}\t{ct}\n"));
            }
        }
        for (part, (_, rels)) in &self.parts {
            for r in rels
                .iter()
                .filter(|r| [&r.id, &r.kind, &r.target].iter().all(|f| field_ok(f)))
            {
                s.push_str(&format!(
                    "R\t{part}\t{}\t{}\t{}\t{}\n",
                    r.id,
                    r.kind,
                    r.target,
                    if r.external { "E" } else { "I" }
                ));
            }
        }
        s.into_bytes()
    }
}

/// An embedded font as the font table declares it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Embedded {
    pub family: String,
    pub slot: String,
    pub font_key: Option<String>,
    /// The kept part the relationship resolves to (`None`: dangling).
    pub part: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum EmbedError {
    /// The font table cannot be read or edited unambiguously (malformed, duplicate family entries…).
    FontTable,
    /// The slot already holds a different font (it is preserved, never replaced).
    SlotTaken,
    /// WordCraft's kept-part limits would drop the new part or relationship.
    Limit,
}

/// The `w:font` element spans of a font table: (family, element start, element end, start-tag end, self-closing,
/// child embed slots with their start offsets and `r:id`/`w:fontKey`).
struct FontEntry {
    family: String,
    start: usize,
    end: usize,
    open_end: usize,
    empty: bool,
    children: Vec<(String, usize, Option<String>, Option<String>)>,
}

/// Parse the font table (namespace-aware). `Err` on malformed XML or a root that is not `w:fonts`.
fn entries(text: &str) -> Result<(Vec<FontEntry>, usize, bool), EmbedError> {
    let mut reader = quick_xml::reader::NsReader::from_str(text);
    let mut out: Vec<FontEntry> = Vec::new();
    let mut depth = 0usize;
    let mut root_close = None;
    let mut root_ok = false;
    let mut current: Option<FontEntry> = None;
    let mut r_bound = false;
    loop {
        let start = usize::try_from(reader.buffer_position()).map_err(|_| EmbedError::FontTable)?;
        let event = reader.read_event().map_err(|_| EmbedError::FontTable)?;
        let after = usize::try_from(reader.buffer_position()).map_err(|_| EmbedError::FontTable)?;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                let (ns, local) = reader.resolver().resolve_element(e.name());
                let is_w = matches!(ns, ResolveResult::Bound(n) if n.as_ref() == W);
                if depth == 0 {
                    root_ok = is_w && local.as_ref() == "fonts";
                    // Is the r prefix bound to the relationships namespace at the root?
                    r_bound = e
                        .attributes()
                        .flatten()
                        .any(|a| a.key.as_ref() == "xmlns:r" && a.value.as_ref() == R);
                } else if depth == 1 && is_w && local.as_ref() == "font" {
                    let mut family = None;
                    for a in e.attributes() {
                        let a = a.map_err(|_| EmbedError::FontTable)?;
                        let (ans, alocal) = reader.resolver().resolve_attribute(a.key);
                        if matches!(ans, ResolveResult::Bound(n) if n.as_ref() == W)
                            && alocal.as_ref() == "name"
                        {
                            family = Some(
                                a.normalized_value(XmlVersion::Implicit1_0)
                                    .map_err(|_| EmbedError::FontTable)?
                                    .into_owned(),
                            );
                        }
                    }
                    let entry = FontEntry {
                        family: family.ok_or(EmbedError::FontTable)?,
                        start,
                        end: after,
                        open_end: after,
                        empty: matches!(event, Event::Empty(_)),
                        children: Vec::new(),
                    };
                    if entry.empty {
                        out.push(entry);
                    } else {
                        current = Some(entry);
                    }
                } else if depth == 2 && is_w {
                    if let Some(cur) = current.as_mut() {
                        let (mut id, mut key) = (None, None);
                        for a in e.attributes() {
                            let a = a.map_err(|_| EmbedError::FontTable)?;
                            let (ans, alocal) = reader.resolver().resolve_attribute(a.key);
                            let value = a
                                .normalized_value(XmlVersion::Implicit1_0)
                                .map_err(|_| EmbedError::FontTable)?
                                .into_owned();
                            match ans {
                                ResolveResult::Bound(n)
                                    if n.as_ref() == R && alocal.as_ref() == "id" =>
                                {
                                    id = Some(value)
                                }
                                ResolveResult::Bound(n)
                                    if n.as_ref() == W && alocal.as_ref() == "fontKey" =>
                                {
                                    key = Some(value)
                                }
                                _ => {}
                            }
                        }
                        cur.children.push((
                            String::from_utf8_lossy(local.as_ref().as_bytes()).into_owned(),
                            start,
                            id,
                            key,
                        ));
                    }
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or(EmbedError::FontTable)?;
                if depth == 1 {
                    if let Some(mut cur) = current.take() {
                        cur.end = after;
                        out.push(cur);
                    }
                } else if depth == 0 {
                    root_close = Some(start);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    match (root_ok, root_close) {
        (true, Some(close)) => Ok((out, close, r_bound)),
        _ => Err(EmbedError::FontTable),
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The embedded fonts a document declares (font table embed elements resolved through the manifest).
pub fn embedded(doc: &Document) -> Vec<Embedded> {
    let manifest = doc
        .passthrough
        .get(MANIFEST)
        .map(|m| Manifest::parse(m))
        .unwrap_or_default();
    let Some((_, rels)) = manifest.parts.get(FONT_TABLE) else {
        return Vec::new();
    };
    let Some(table) = doc
        .passthrough
        .get(FONT_TABLE)
        .and_then(|t| std::str::from_utf8(t).ok().map(str::to_string))
    else {
        return Vec::new();
    };
    let Ok((list, _, _)) = entries(&table) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in list {
        for (slot, _, id, key) in e.children.iter().filter(|c| SLOTS.contains(&c.0.as_str())) {
            let part = id
                .as_ref()
                .and_then(|id| rels.iter().find(|r| &r.id == id && !r.external))
                .map(|r| r.target.clone());
            out.push(Embedded {
                family: e.family.clone(),
                slot: slot.clone(),
                font_key: key.clone(),
                part,
            });
        }
    }
    out
}

/// Embed `program` (an embeddable TrueType font, checked by the caller) as `family`'s `slot`. `Ok(false)` when
/// exactly this font is already embedded there (no change); `Ok(true)` when the model changed.
pub fn embed(
    doc: &mut Document,
    family: &str,
    slot: &str,
    program: &[u8],
) -> Result<bool, EmbedError> {
    if !SLOTS.contains(&slot) || family.is_empty() || !field_ok(family) {
        return Err(EmbedError::FontTable);
    }
    let key = embedding::font_key(program);
    let odttf = embedding::obfuscate(program, &key).ok_or(EmbedError::FontTable)?;
    let mut manifest = doc
        .passthrough
        .get(MANIFEST)
        .map(|m| Manifest::parse(m))
        .unwrap_or_default();
    let had_table =
        manifest.parts.contains_key(FONT_TABLE) && doc.passthrough.contains_key(FONT_TABLE);
    let table = if had_table {
        String::from_utf8(doc.passthrough[FONT_TABLE].to_vec())
            .map_err(|_| EmbedError::FontTable)?
    } else {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>{}<w:fonts xmlns:w="{W}" xmlns:r="{R}"></w:fonts>"#,
            "\r\n"
        )
    };
    let (list, root_close, r_bound) = entries(&table)?;
    let matching: Vec<&FontEntry> = list.iter().filter(|e| e.family == family).collect();
    if matching.len() > 1 {
        return Err(EmbedError::FontTable);
    }
    let rels = manifest
        .parts
        .get(FONT_TABLE)
        .map(|p| p.1.clone())
        .unwrap_or_default();
    if let Some(existing) = matching
        .first()
        .and_then(|e| e.children.iter().find(|c| c.0 == slot))
    {
        // Already embedded here: unchanged when it is exactly this font, else the existing one is preserved.
        let same = existing.3.as_deref() == Some(key.as_str())
            && existing
                .2
                .as_ref()
                .and_then(|id| rels.iter().find(|r| &r.id == id))
                .is_some_and(|r| {
                    doc.passthrough
                        .get(&r.target)
                        .is_some_and(|b| b.as_slice() == odttf.as_slice())
                });
        return if same {
            Ok(false)
        } else {
            Err(EmbedError::SlotTaken)
        };
    }
    // The part: reuse a kept part with exactly these obfuscated bytes, else a new free name.
    let reuse = manifest
        .parts
        .iter()
        .find(|(name, (ct, _))| {
            ct == OBFUSCATED_FONT
                && doc
                    .passthrough
                    .get(*name)
                    .is_some_and(|b| b.as_slice() == odttf.as_slice())
        })
        .map(|(n, _)| n.clone());
    let part = match reuse {
        Some(p) => p,
        None => {
            let taken = |n: &str| {
                let lower = n.to_ascii_lowercase();
                manifest
                    .parts
                    .keys()
                    .any(|k| k.to_ascii_lowercase() == lower)
                    || doc
                        .passthrough
                        .keys()
                        .any(|k| k.to_ascii_lowercase() == lower)
            };
            (1..=MAX_PARTS)
                .map(|n| format!("word/fonts/font{n}.odttf"))
                .find(|n| !taken(n))
                .ok_or(EmbedError::Limit)?
        }
    };
    let next = rels
        .iter()
        .filter_map(|r| r.id.strip_prefix("rId").and_then(|n| n.parse::<u32>().ok()))
        .max()
        .unwrap_or(0)
        + 1;
    let id = (next..next + 10_000)
        .map(|n| format!("rId{n}"))
        .find(|i| !rels.iter().any(|r| &r.id == i))
        .ok_or(EmbedError::Limit)?;
    let r_decl = if r_bound {
        String::new()
    } else {
        format!(r#" xmlns:r="{R}""#)
    };
    let element = format!(r#"<w:{slot}{r_decl} r:id="{id}" w:fontKey="{key}"/>"#);
    // The w prefix must name the main namespace at the insertion point: the root binds it (checked: new tables
    // declare it; kept tables must use the `w` prefix for w:fonts, refused otherwise).
    let root_tag = table
        .find("<w:fonts")
        .and_then(|s| table[s..].find('>').map(|e| &table[s..s + e]));
    if !root_tag.is_some_and(|t| t.contains(&format!(r#"xmlns:w="{W}""#))) {
        return Err(EmbedError::FontTable);
    }
    let mut out = table.clone();
    match matching.first() {
        Some(entry) if entry.empty => {
            // <w:font .../> → <w:font ...>EMBED</w:font>
            let open = &table[entry.start..entry.end];
            if !open.starts_with("<w:font") || !open.ends_with("/>") {
                return Err(EmbedError::FontTable);
            }
            let trimmed = open.trim_end_matches("/>").trim_end();
            out.replace_range(
                entry.start..entry.end,
                &format!("{trimmed}>{element}</w:font>"),
            );
        }
        Some(entry) => {
            let rank = SLOTS.iter().position(|s| *s == slot).unwrap_or(0);
            let before = entry
                .children
                .iter()
                .find(|c| {
                    SLOTS
                        .iter()
                        .position(|s| *s == c.0)
                        .is_some_and(|r| r > rank)
                })
                .map(|c| c.1);
            let at = before.unwrap_or_else(|| table[..entry.end].rfind("</").unwrap_or(entry.end));
            if at < entry.open_end || at > entry.end {
                return Err(EmbedError::FontTable);
            }
            out.insert_str(at, &element);
        }
        None => out.insert_str(
            root_close,
            &format!(r#"<w:font w:name="{}">{element}</w:font>"#, escape(family)),
        ),
    }
    // Manifest: font table part (new tables), the font part, and the relationship.
    if !had_table {
        manifest
            .parts
            .insert(FONT_TABLE.into(), (FONT_TABLE_TYPE.into(), Vec::new()));
    }
    manifest
        .parts
        .entry(part.clone())
        .or_insert_with(|| (OBFUSCATED_FONT.into(), Vec::new()));
    if manifest.parts.len() > MAX_PARTS {
        return Err(EmbedError::Limit);
    }
    let table_rels = &mut manifest
        .parts
        .get_mut(FONT_TABLE)
        .ok_or(EmbedError::FontTable)?
        .1;
    if table_rels.len() >= MAX_RELS {
        return Err(EmbedError::Limit);
    }
    table_rels.push(Rel {
        id,
        kind: FONT_REL.into(),
        target: part.clone(),
        external: false,
    });
    // Validate the edited table before committing anything to the model.
    let (after, _, _) = entries(&out)?;
    if !after.iter().any(|e| {
        e.family == family
            && e.children
                .iter()
                .any(|c| c.0 == slot && c.3.as_deref() == Some(key.as_str()))
    }) {
        return Err(EmbedError::FontTable);
    }
    doc.passthrough
        .insert(FONT_TABLE.into(), Arc::new(out.into_bytes()));
    doc.passthrough
        .entry(part)
        .or_insert_with(|| Arc::new(odttf));
    doc.passthrough
        .insert(MANIFEST.into(), Arc::new(manifest.to_bytes()));
    Ok(true)
}
