//! T009 embedded inline picture edits in linked DOCX header, footer and note parts.

use std::collections::{BTreeMap, BTreeSet};

use crate::document::xml::{self, Atom, Canonical};

use super::package::{self, resolve, Package, Side};

const DOCUMENT_RELS: &str = "word/_rels/document.xml.rels";
const DOCUMENT_XML: &str = "word/document.xml";
const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const IMAGE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

type Stories = Vec<(String, &'static str, Option<&'static str>)>;

fn linked_stories(original: &Package, output: &Package) -> Option<Stories> {
    let rels = original.get(DOCUMENT_RELS)?;
    if rels.len() > 2 * 1024 * 1024 || output.get(DOCUMENT_RELS) != Some(rels) {
        return None;
    }
    let relationships = xml::relationships(rels).ok()?;
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
    Some(bindings
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
            Some((name, root, note))
        })
        .collect())
}

fn owned_images(original: &Package, output: &Package, part: &str) -> Option<BTreeSet<String>> {
    let (dir, file) = part.rsplit_once('/')?;
    let rels_name = format!("{dir}/_rels/{file}.rels");
    let rels = original.get(&rels_name)?;
    if rels.len() > 2 * 1024 * 1024 || output.get(&rels_name) != Some(rels) {
        return None;
    }
    let relationships = xml::relationships(rels).ok()?;
    let mut ids = Vec::with_capacity(relationships.len());
    xml::visit_element_starts(rels, |el| {
        if el.name == "Relationship" {
            let (_, _, value) = el.attributes.iter()
                .find(|(ns, key, _)| ns.is_none() && key == "Id").ok_or(xml::Invalid)?;
            ids.push(value.to_string());
        }
        Ok(())
    }).ok()?;
    if ids.len() != relationships.len() {
        return None;
    }
    Some(ids.into_iter().zip(relationships).filter_map(|(id, rel)| {
        if rel.external || rel.kind != IMAGE_REL {
            return None;
        }
        let target = resolve(&rels_name, &rel.target)?;
        (original.get(&target)? == output.get(&target)?).then_some(id)
    }).collect())
}

/// Prove that WordCraft's initial serialization preserves the source XML of the
/// actual stories and that every eligible model picture has paired source sizes.
pub(crate) fn resize_source_supported(source: &[u8], export: &[u8], count: usize) -> bool {
    let (Ok(original), Ok(output)) = (package::open(source, Side::Original), package::open(export, Side::Output)) else {
        return false;
    };
    let Some(stories) = linked_stories(&original, &output) else {
        return false;
    };
    let mut proved = 0;
    for (part, root, note) in stories {
        let (Some(before), Some(after)) = (original.get(&part), output.get(&part)) else {
            return false;
        };
        // WordCraft's writer has one model size. Do not let its initial export
        // erase disagreement or other unknown story XML before the edit gate.
        if before != after {
            return false;
        }
        let images = owned_images(&original, &output, &part).unwrap_or_default();
        let Some((_, sizes)) = masked(before, root, note, &images) else {
            return false;
        };
        proved += sizes;
    }
    proved == count && same_story_references(&original, &output)
}

/// Exempt only linked story XML with matching picture descriptions or paired
/// embedded picture extents masked. All other XML events stay in the comparison.
pub(super) fn inline_picture_edits(original: &Package, output: &Package) -> BTreeSet<String> {
    let Some(stories) = linked_stories(original, output) else {
        return BTreeSet::new();
    };
    let parts: BTreeSet<_> = stories
        .into_iter()
        .filter_map(|(name, root, note)| {
            let (before, after) = (original.get(&name)?, output.get(&name)?);
            if before == after {
                return None;
            }
            let images = owned_images(original, output, &name).unwrap_or_default();
            let ((before, _), (after, _)) = (masked(before, root, note, &images)?, masked(after, root, note, &images)?);
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

fn masked(bytes: &[u8], root: &str, note: Option<&str>, owned_images: &BTreeSet<String>) -> Option<(Vec<Canonical>, usize)> {
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
    let mut xfrm = picture.clone();
    xfrm.extend([(PIC, "spPr"), (A, "xfrm")]);
    let mut inner_size = xfrm.clone();
    inner_size.push((A, "ext"));
    let mut outer_size = scope.clone();
    outer_size.push((WP, "extent"));
    picture.extend([(PIC, "nvPicPr"), (PIC, "cNvPr")]);
    let mut stack = Vec::new();
    let mut descriptions = Vec::new();
    let mut sizes = Vec::new();
    let mut props = None;
    let mut picture_props = None;
    let mut embedded = false;
    let mut blip_seen = false;
    let mut owned = false;
    let mut transformed = false;
    let mut outer_extent = None;
    let mut inner_extent = None;
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
                if matches_path(&stack, &outer_size) && outer_extent.replace(index).is_some() {
                    return None;
                }
                if matches_path(&stack, &inner_size) && inner_extent.replace(index).is_some() {
                    return None;
                }
                if matches_path(&stack, &xfrm) {
                    transformed |= attributes.iter().any(|(ns, key, value)| {
                        ns.is_some() || !matches!(key.as_str(), "rot" | "flipH" | "flipV") || value != "0"
                    });
                }
                if matches_path(&stack, &blip) {
                    transformed |= blip_seen;
                    blip_seen = true;
                    embedded = attributes.iter().any(|(ns, key, value)| {
                        ns.as_deref() == Some(REL) && key == "embed" && !value.is_empty()
                    }) && !attributes
                        .iter()
                        .any(|(ns, key, _)| ns.as_deref() == Some(REL) && key == "link");
                    owned = embedded && attributes.iter().any(|(ns, key, value)| {
                        ns.as_deref() == Some(REL) && key == "embed" && owned_images.contains(value.as_str())
                    });
                }
            }
            Canonical::End => {
                if matches_path(&stack, &scope) {
                    let frame = outer_extent.take().zip(inner_extent.take());
                    if owned && !transformed && props.is_some() && picture_props.is_some() {
                        if let Some((outer, inner)) = frame {
                            if let Some(size) = extent(&events[outer]) {
                                if extent(&events[inner]) == Some(size) {
                                    sizes.extend([outer, inner]);
                                }
                            }
                        }
                    }
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
                    blip_seen = false;
                    owned = false;
                    transformed = false;
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
    let count = sizes.len() / 2;
    for index in sizes {
        let Canonical::Start { attributes, .. } = &mut events[index] else {
            return None;
        };
        attributes.clear(); // extent() admitted exactly the paired cx/cy values.
    }
    Some((events, count))
}

fn extent(event: &Canonical) -> Option<[u32; 2]> {
    let Canonical::Start { attributes, .. } = event else {
        return None;
    };
    let [(None, cx, width), (None, cy, height)] = attributes.as_slice() else {
        return None;
    };
    if cx != "cx" || cy != "cy" {
        return None;
    }
    let parse = |value: &Atom| {
        let size = value.parse::<u32>().ok()?;
        ((25_400..=50_800_000).contains(&size) && value.as_str() == size.to_string()).then_some(size)
    };
    Some([parse(width)?, parse(height)?])
}

fn description(event: &Canonical) -> Option<&Atom> {
    let Canonical::Start { attributes, .. } = event else {
        return None;
    };
    attributes
        .iter()
        .find_map(|(ns, key, val)| (ns.is_none() && key == "descr").then_some(val))
}
