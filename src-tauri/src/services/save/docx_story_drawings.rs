//! T009 description-only edits in linked DOCX header, footer and note parts.

use std::collections::{BTreeMap, BTreeSet};

use crate::document::xml::{self, Atom, Canonical};

use super::package::{resolve, Package};

const DOCUMENT_RELS: &str = "word/_rels/document.xml.rels";
const DOCUMENT_XML: &str = "word/document.xml";
const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// Exempt only linked story parts whose canonical XML agrees after masking
/// descriptions of embedded inline pictures. IDs, note boundaries, drawing
/// geometry and extents, relationship references, and all other events remain.
pub(super) fn description_edits(original: &Package, output: &Package) -> BTreeSet<String> {
    let Some(rels) = original.get(DOCUMENT_RELS) else {
        return BTreeSet::new();
    };
    if rels.len() > 2 * 1024 * 1024 || output.get(DOCUMENT_RELS) != Some(rels) {
        return BTreeSet::new();
    }
    let Ok(relationships) = xml::relationships(rels) else {
        return BTreeSet::new();
    };
    let bindings = relationships
        .into_iter()
        .fold(BTreeMap::new(), |mut bindings, relation| {
            if let Some(name) = (!relation.external)
                .then(|| resolve(DOCUMENT_RELS, &relation.target))
                .flatten()
            {
                bindings
                    .entry(name)
                    .and_modify(|kind| *kind = None)
                    .or_insert(Some(relation.kind));
            }
            bindings
        });
    let parts: BTreeSet<_> = bindings
        .into_iter()
        .filter_map(|(name, kind)| {
            let kind = kind?;
            let (root, note) = match kind.strip_prefix(REL)?.strip_prefix('/')? {
                "header" => ("hdr", None),
                "footer" => ("ftr", None),
                "footnotes" => ("footnotes", Some("footnote")),
                "endnotes" => ("endnotes", Some("endnote")),
                _ => return None,
            };
            let (before, after) = (original.get(&name)?, output.get(&name)?);
            if before == after {
                return None;
            }
            let (before, after) = (masked(before, root, note)?, masked(after, root, note)?);
            (before == after).then_some(name)
        })
        .collect();
    if !parts.is_empty() && !same_story_references(original, output) {
        return BTreeSet::new();
    }
    parts
}

fn same_story_references(original: &Package, output: &Package) -> bool {
    let (Some(before), Some(after)) = (original.get(DOCUMENT_XML), output.get(DOCUMENT_XML)) else {
        return false;
    };
    if before == after {
        return true;
    }
    let read = |bytes: &[u8]| {
        let mut refs = Vec::new();
        xml::visit_element_starts(bytes, |element| {
            if element.namespace.as_deref() == Some(WORD)
                && matches!(
                    element.name.as_str(),
                    "headerReference"
                        | "footerReference"
                        | "footnoteReference"
                        | "endnoteReference"
                )
            {
                if refs.len() >= 65_536 {
                    return Err(xml::Invalid);
                }
                refs.push((element.name, element.attributes));
            }
            Ok(())
        })
        .ok()?;
        Some(refs)
    };
    read(before).is_some_and(|a| read(after) == Some(a))
}

type Element = (Option<Atom>, Atom);

fn matches_path(stack: &[Element], path: &[(&str, &str)]) -> bool {
    stack.len() == path.len()
        && stack
            .iter()
            .zip(path)
            .all(|((ns, name), (want_ns, want_name))| {
                ns.as_deref() == Some(*want_ns) && name == want_name
            })
}

fn masked(bytes: &[u8], root: &str, note: Option<&str>) -> Option<Vec<Canonical>> {
    let (mut events, _) = xml::canonical_with_payload_limit(bytes, Some(8 * 1024 * 1024)).ok()?;
    let mut scope = vec![(WORD, root)];
    if let Some(note) = note {
        scope.push((WORD, note));
    }
    scope.extend([(WORD, "p"), (WORD, "r"), (WORD, "drawing"), (WP, "inline")]);
    let inline_depth = scope.len();
    let mut picture = scope.clone();
    picture.extend([(A, "graphic"), (A, "graphicData"), (PIC, "pic")]);
    let mut blip = picture.clone();
    blip.extend([(PIC, "blipFill"), (A, "blip")]);
    picture.extend([(PIC, "nvPicPr"), (PIC, "cNvPr")]);
    let mut stack = Vec::new();
    let mut descriptions = Vec::new();
    let mut props = None;
    let mut picture_props = None;
    let mut embedded = false;
    let mut normal_note = note.is_none();
    for (index, event) in events.iter().enumerate() {
        match event {
            Canonical::Start {
                namespace,
                name,
                attributes,
            } => {
                stack.push((namespace.clone(), name.clone()));
                if note.is_some() && matches_path(&stack, &scope[..2]) {
                    normal_note = attributes.iter().any(|(ns, key, value)| {
                        ns.as_deref() == Some(WORD)
                            && key == "id"
                            && value.parse::<u32>().is_ok_and(|id| id > 0)
                    }) && !attributes.iter().any(|(ns, key, value)| {
                        ns.as_deref() == Some(WORD) && key == "type" && value != "normal"
                    });
                }
                if !normal_note {
                    continue;
                }
                if stack.len() == inline_depth + 1
                    && matches_path(&stack[..inline_depth], &scope)
                    && namespace.as_deref() == Some(WP)
                    && name == "docPr"
                {
                    if props.replace(index).is_some() {
                        return None;
                    }
                    if attributes.iter().any(|(ns, key, value)| {
                        ns.is_none()
                            && key == "descr"
                            && (value.chars().count() > 1024
                                || value.chars().any(|ch| ch.is_control() || ch == '\u{fffc}'))
                    }) {
                        return None;
                    }
                }
                if matches_path(&stack, &picture) && picture_props.replace(index).is_some() {
                    return None;
                }
                if matches_path(&stack, &blip) {
                    embedded = attributes.iter().any(|(ns, key, value)| {
                        ns.as_deref() == Some(REL) && key == "embed" && !value.is_empty()
                    }) && !attributes
                        .iter()
                        .any(|(ns, key, _)| ns.as_deref() == Some(REL) && key == "link");
                }
            }
            Canonical::End => {
                if matches_path(&stack, &scope) {
                    if let (Some(outer), Some(inner), true) =
                        (props.take(), picture_props.take(), embedded)
                    {
                        // WordCraft writes the same description in both non-visual
                        // records. An independently authored second description has
                        // separate meaning and must never be overwritten by this path.
                        if description(&events[outer]) == description(&events[inner]) {
                            descriptions.extend([outer, inner]);
                        }
                    }
                    embedded = false;
                }
                stack.pop()?;
            }
            _ => {}
        }
    }
    for index in descriptions {
        let Canonical::Start { attributes, .. } = &mut events[index] else {
            return None;
        };
        attributes.retain(|(ns, key, _)| ns.is_some() || key != "descr");
    }
    Some(events)
}

fn description(event: &Canonical) -> Option<&Atom> {
    let Canonical::Start { attributes, .. } = event else {
        return None;
    };
    attributes
        .iter()
        .find_map(|(ns, key, val)| (ns.is_none() && key == "descr").then_some(val))
}
