//! T009 Stage 1 F: DOCX embedded-font additions (ECMA-376 Part 1, 17.8.3 font table embed elements, 17.8.1 font
//! obfuscation; Part 2 relationships and content types).
//!
//! An output may differ from the original by font embedding only in this exact way (anything else falls back to
//! the ordinary part-by-part comparison and is refused):
//! - `word/fontTable.xml`: the original canonical XML with **only** added `w:embedRegular|Bold|Italic|BoldItalic`
//!   elements (empty, attributes exactly `r:id` + `w:fontKey`), each inside a `w:font` that is either original or
//!   new and consists of nothing but added embed elements; at most one element per family and slot. A new font
//!   table holds only such new `w:font` elements.
//! - `word/_rels/fontTable.xml.rels`: the original relationships unchanged and first; every added relationship is
//!   internal, of the `font` type, targets a part that did not exist, and is used by exactly one added embed.
//! - every added part is such a font part: its content type is `obfuscatedFont`, and deobfuscated with the embed's
//!   key it is a single-face TrueType font whose `fsType` permits editable embedding (installable/editable) and
//!   whose family names include the `w:font` name.
//! - `[Content_Types].xml`: the original entries unchanged; added entries are only Overrides for those font parts
//!   (and the new font table).
//! - `word/_rels/document.xml.rels`: unchanged, or for a new font table exactly one added internal `fontTable`
//!   relationship to `fontTable.xml`.
//!
//! Combined in one save with other part additions (pictures, notes, comments) it is refused (not composed).

use std::collections::{BTreeMap, BTreeSet};

use crate::document::xml::{self, Canonical};
use crate::fonts::embedding;

use super::package::Package;

pub const FONT_TABLE: &str = "word/fontTable.xml";
pub const FONT_TABLE_RELS: &str = "word/_rels/fontTable.xml.rels";
const DOCUMENT_RELS: &str = "word/_rels/document.xml.rels";
const CONTENT_TYPES: &str = "[Content_Types].xml";
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const OPC_RELS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const FONT_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";
const FONT_TABLE_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable";
const OBFUSCATED_FONT: &str = "application/vnd.openxmlformats-officedocument.obfuscatedFont";
const FONT_TABLE_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml";
const SLOTS: [&str; 4] = [
    "embedRegular",
    "embedBold",
    "embedItalic",
    "embedBoldItalic",
];

/// Parts the rule accounts for.
#[derive(Debug, Default, PartialEq)]
pub struct FontProof {
    /// fontTable, its relationships part, and the added font parts.
    pub parts: BTreeSet<String>,
    /// The document relationships gained the font table relationship (new table).
    pub document_rels: bool,
}

type RelRow = (String, String, String, bool); // id, type, target, external

/// Relationships of a `.rels` part, in document order (OPC namespace only; anything else refuses).
fn rels(bytes: Option<&[u8]>) -> Option<Vec<RelRow>> {
    let Some(bytes) = bytes else {
        return Some(Vec::new());
    };
    let events = xml::canonical(bytes).ok()?;
    let mut out = Vec::new();
    let mut iter = events.iter();
    match iter.next()? {
        Canonical::Start {
            namespace: Some(ns),
            name,
            ..
        } if ns.as_str() == OPC_RELS && name.as_str() == "Relationships" => {}
        _ => return None,
    }
    while let Some(e) = iter.next() {
        match e {
            Canonical::Start {
                namespace: Some(ns),
                name,
                attributes,
            } if ns.as_str() == OPC_RELS && name.as_str() == "Relationship" => {
                let get = |k: &str| {
                    attributes
                        .iter()
                        .find(|(n, a, _)| n.is_none() && a.as_str() == k)
                        .map(|(_, _, v)| v.to_string())
                };
                let external = get("TargetMode").is_some_and(|m| m == "External");
                out.push((get("Id")?, get("Type")?, get("Target")?, external));
                if iter.next()? != &Canonical::End {
                    return None;
                }
            }
            Canonical::End => return Some(out),
            Canonical::Text(t) if t.trim().is_empty() => {}
            _ => return None,
        }
    }
    None
}

/// `word/` relative target → part name (no `..`, no absolute or external forms).
fn word_part(target: &str) -> Option<String> {
    if target.is_empty()
        || target.starts_with('/')
        || target.contains("..")
        || target.contains(':')
        || target.contains('\\')
    {
        return None;
    }
    Some(format!("word/{target}"))
}

fn attr<'a>(
    attributes: &'a [(Option<xml::Atom>, xml::Atom, xml::Atom)],
    ns: Option<&str>,
    key: &str,
) -> Option<&'a str> {
    attributes
        .iter()
        .find(|(n, k, _)| n.as_deref() == ns && k.as_str() == key)
        .map(|(_, _, v)| v.as_ref())
}

fn guid_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 38
        && b[0] == b'{'
        && b[37] == b'}'
        && [9, 14, 19, 24].iter().all(|&i| b[i] == b'-')
        && b.iter().enumerate().all(|(i, c)| {
            i == 0 || i == 37 || [9, 14, 19, 24].contains(&i) || c.is_ascii_hexdigit()
        })
}

/// The font-embedding additions between `original` and `output`, or `None` when the difference is not exactly
/// that (or there is no font table change).
pub fn docx_fonts_embedded(original: &Package, output: &Package) -> Option<FontProof> {
    let after = output.get(FONT_TABLE)?;
    let before = original.get(FONT_TABLE);
    if before == Some(after) && original.get(FONT_TABLE_RELS) == output.get(FONT_TABLE_RELS) {
        return None;
    }
    // Relationships of the font table: original first and unchanged, then added font relationships.
    let (old_rels, new_rels) = (
        rels(original.get(FONT_TABLE_RELS))?,
        rels(output.get(FONT_TABLE_RELS))?,
    );
    if new_rels.len() <= old_rels.len() || new_rels.get(..old_rels.len())? != old_rels.as_slice() {
        return None;
    }
    let mut added: BTreeMap<String, String> = BTreeMap::new(); // id → part
    for (id, kind, target, external) in &new_rels[old_rels.len()..] {
        let part = word_part(target)?;
        if *external
            || kind != FONT_REL
            || original.get(&part).is_some()
            || output.get(&part).is_none()
            || added.values().any(|p| *p == part)
        {
            return None;
        }
        if old_rels.iter().any(|r| &r.0 == id) || added.insert(id.clone(), part).is_some() {
            return None;
        }
    }
    // Font table: remove the added embeds (and new w:font elements made only of them); the rest equals the original.
    let new_events = xml::canonical(after).ok()?;
    let old_events = match before {
        Some(b) => xml::canonical(b).ok()?,
        None => Vec::new(),
    };
    let old_families: BTreeSet<String> = old_events
        .iter()
        .filter_map(|e| match e {
            Canonical::Start {
                namespace: Some(ns),
                name,
                attributes,
            } if ns.as_str() == W && name.as_str() == "font" => {
                attr(attributes, Some(W), "name").map(str::to_string)
            }
            _ => None,
        })
        .collect();
    let mut filtered = Vec::new();
    let mut embeds: Vec<(String, String, String, String)> = Vec::new(); // family, slot, id, key
    let mut i = 0;
    let mut depth = 0usize;
    while i < new_events.len() {
        let e = &new_events[i];
        if let Canonical::Start {
            namespace: Some(ns),
            name,
            attributes,
        } = e
        {
            if depth == 1 && ns.as_str() == W && name.as_str() == "font" {
                let family = attr(attributes, Some(W), "name")?.to_string();
                // Collect this w:font subtree.
                let mut j = i + 1;
                let mut d = 1;
                let mut kept = vec![e.clone()];
                let mut removed = 0;
                while d > 0 {
                    let c = new_events.get(j)?;
                    if d == 1 {
                        if let Canonical::Start {
                            namespace: Some(cns),
                            name: cname,
                            attributes: cattrs,
                        } = c
                        {
                            let id = attr(cattrs, Some(R), "id");
                            if cns.as_str() == W
                                && SLOTS.contains(&cname.as_str())
                                && id.is_some_and(|id| added.contains_key(id))
                            {
                                let key = attr(cattrs, Some(W), "fontKey")?;
                                if cattrs.len() != 2
                                    || !guid_ok(key)
                                    || new_events.get(j + 1)? != &Canonical::End
                                {
                                    return None;
                                }
                                embeds.push((
                                    family.clone(),
                                    cname.to_string(),
                                    id?.to_string(),
                                    key.to_string(),
                                ));
                                removed += 1;
                                j += 2;
                                continue;
                            }
                        }
                    }
                    match c {
                        Canonical::Start { .. } => d += 1,
                        Canonical::End => d -= 1,
                        _ => {}
                    }
                    kept.push(c.clone());
                    j += 1;
                }
                let only_added = kept.len() == 2 && removed > 0;
                if !(only_added && !old_families.contains(&family)) {
                    filtered.extend(kept);
                }
                i = j;
                continue;
            }
        }
        match e {
            Canonical::Start { .. } => depth += 1,
            Canonical::End => depth = depth.checked_sub(1)?,
            _ => {}
        }
        filtered.push(e.clone());
        i += 1;
    }
    match before {
        Some(_) => {
            if filtered != old_events {
                return None;
            }
        }
        None => {
            let root_only = matches!(filtered.as_slice(), [Canonical::Start { namespace: Some(ns), name, attributes }, Canonical::End]
                if ns.as_str() == W && name.as_str() == "fonts" && attributes.is_empty());
            if !root_only {
                return None;
            }
        }
    }
    // Every added relationship used by exactly one embed; one font per family and slot (original slots included).
    let mut used = BTreeSet::new();
    let mut slots = BTreeSet::new();
    for (family, slot, id, _) in &embeds {
        if !used.insert(id.clone()) || !slots.insert((family.clone(), slot.clone())) {
            return None;
        }
    }
    if used.len() != added.len() {
        return None;
    }
    // Original slots of the same family/slot must not coexist with an added one.
    let mut family = None;
    for e in &old_events {
        if let Canonical::Start {
            namespace: Some(ns),
            name,
            attributes,
        } = e
        {
            if ns.as_str() == W && name.as_str() == "font" {
                family = attr(attributes, Some(W), "name").map(str::to_string);
            } else if ns.as_str() == W && SLOTS.contains(&name.as_str()) {
                if let Some(f) = &family {
                    if slots.contains(&(f.clone(), name.to_string())) {
                        return None;
                    }
                }
            }
        }
    }
    // Content types and the font programs.
    let (old_ct, new_ct) = (
        xml::content_types(original.get(CONTENT_TYPES)?).ok()?,
        xml::content_types(output.get(CONTENT_TYPES)?).ok()?,
    );
    let lower = |v: &[(String, String)]| {
        v.iter()
            .map(|(a, b)| (a.to_ascii_lowercase(), b.clone()))
            .collect::<BTreeSet<_>>()
    };
    if lower(&old_ct.defaults) != lower(&new_ct.defaults) {
        return None;
    }
    let (old_over, new_over) = (lower(&old_ct.overrides), lower(&new_ct.overrides));
    if !old_over.is_subset(&new_over) {
        return None;
    }
    let mut expected: BTreeSet<(String, String)> = added
        .values()
        .map(|p| {
            (
                format!("/{p}").to_ascii_lowercase(),
                OBFUSCATED_FONT.to_string(),
            )
        })
        .collect();
    if before.is_none() {
        expected.insert((
            format!("/{FONT_TABLE}").to_ascii_lowercase(),
            FONT_TABLE_TYPE.to_string(),
        ));
    }
    let extra: BTreeSet<_> = new_over.difference(&old_over).cloned().collect();
    if extra != expected {
        return None;
    }
    for (family, _, id, key) in &embeds {
        let part = &added[id];
        let program = embedding::obfuscate(output.get(part)?, key)?;
        let inspected = embedding::inspect(&program).ok()?;
        embedding::embeddable(&inspected).ok()?;
        if !inspected
            .families
            .iter()
            .any(|f| f.eq_ignore_ascii_case(family))
        {
            return None;
        }
    }
    // Document relationships: unchanged, or exactly the new font table relationship.
    let mut proof = FontProof::default();
    if before.is_none() {
        let (old_doc, new_doc) = (
            rels(original.get(DOCUMENT_RELS))?,
            rels(output.get(DOCUMENT_RELS))?,
        );
        let extra: Vec<&RelRow> = new_doc.iter().filter(|r| !old_doc.contains(r)).collect();
        if old_doc.iter().any(|r| !new_doc.contains(r))
            || extra.len() != 1
            || extra[0].1 != FONT_TABLE_REL
            || extra[0].2 != "fontTable.xml"
            || extra[0].3
            || old_doc.iter().any(|r| r.0 == extra[0].0)
        {
            return None;
        }
        proof.document_rels = true;
    }
    proof.parts.insert(FONT_TABLE.to_string());
    proof.parts.insert(FONT_TABLE_RELS.to_string());
    proof.parts.extend(added.into_values());
    Some(proof)
}
