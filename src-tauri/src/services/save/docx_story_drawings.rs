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

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct StoryPictureKey {
    note_id: u32,
    docpr_id: String,
    picture_id: String,
    embed_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PicturePlacement {
    paragraph: usize,
    mode: &'static str,
    wrapper: BTreeMap<String, String>,
    simple: Option<(String, String)>,
    horizontal: Option<(String, String)>,
    vertical: Option<(String, String)>,
    wrap_name: Option<String>,
    wrap: Vec<Canonical>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoryPicture {
    key: StoryPictureKey,
    run_props: Vec<Canonical>,
    core: Vec<Canonical>,
    placement: PicturePlacement,
}

struct NormalizedStory {
    events: Vec<Canonical>,
    pictures: Vec<StoryPicture>,
}

/// Prove the source and WordCraft's first export preserve every linked story, and that each
/// note picture can be identified by its actual note owner, DrawingML id, and owned media rel.
pub(crate) fn move_source_supported(source: &[u8], export: &[u8], count: usize) -> bool {
    if count == 0 {
        return false;
    }
    let (Ok(original), Ok(output)) = (
        package::open(source, Side::Original),
        package::open(export, Side::Output),
    ) else {
        return false;
    };
    let Some(stories) = linked_stories(&original, &output) else {
        return false;
    };
    if original.get(DOCUMENT_XML) != output.get(DOCUMENT_XML)
        || !same_story_references(&original, &output)
    {
        return false;
    }
    let mut pictures = 0usize;
    for (part, root, note) in stories {
        let (Some(before), Some(after)) = (original.get(&part), output.get(&part)) else {
            return false;
        };
        if before != after {
            return false;
        }
        if note.is_some() {
            let images = owned_images(&original, &output, &part).unwrap_or_default();
            let Some(normalized) = normalize_story(before, root, note, &images) else {
                return false;
            };
            pictures = match pictures.checked_add(normalized.pictures.len()) {
                Some(count) => count,
                None => return false,
            };
        }
    }
    pictures == count
}

/// Admit only one note-picture placement change. The target picture, character run properties,
/// drawing body, note id, relationship, document note references, and every paragraph/run outside
/// that picture must remain intact. This covers inline-to-square movement and subsequent movement
/// of a WordCraft-authored square anchor.
pub(super) fn moved_note_picture_edits(original: &Package, output: &Package) -> BTreeSet<String> {
    if original.get(DOCUMENT_XML) != output.get(DOCUMENT_XML)
        || !same_story_references(original, output)
    {
        return BTreeSet::new();
    }
    let Some(stories) = linked_stories(original, output) else {
        return BTreeSet::new();
    };
    let mut admitted = None;
    for (part, root, note) in stories {
        if note.is_none() {
            continue;
        }
        let (Some(before), Some(after)) = (original.get(&part), output.get(&part)) else {
            return BTreeSet::new();
        };
        if before == after {
            continue;
        }
        if admitted.is_some() {
            return BTreeSet::new();
        }
        let Some(images) = owned_images(original, output, &part) else {
            return BTreeSet::new();
        };
        let (Some(before), Some(after)) = (
            normalize_story(before, root, note, &images),
            normalize_story(after, root, note, &images),
        ) else {
            return BTreeSet::new();
        };
        if before.events != after.events {
            return BTreeSet::new();
        }
        let before: BTreeMap<_, _> = before
            .pictures
            .into_iter()
            .map(|p| (p.key.clone(), p))
            .collect();
        let after: BTreeMap<_, _> = after
            .pictures
            .into_iter()
            .map(|p| (p.key.clone(), p))
            .collect();
        if before.len() != after.len() || before.keys().ne(after.keys()) {
            return BTreeSet::new();
        }
        let mut changed = 0usize;
        for (key, old) in &before {
            let Some(new) = after.get(key) else {
                return BTreeSet::new();
            };
            if old.core != new.core || old.run_props != new.run_props {
                return BTreeSet::new();
            }
            if old.placement != new.placement {
                if !safe_note_move(&old.placement, &new.placement) {
                    return BTreeSet::new();
                }
                changed += 1;
            }
        }
        if changed != 1 {
            return BTreeSet::new();
        }
        admitted = Some(part);
    }
    admitted.into_iter().collect()
}

fn safe_note_move(before: &PicturePlacement, after: &PicturePlacement) -> bool {
    let square_wrap = after.wrap.len() == 2
        && event_start(&after.wrap[0], WP, "wrapSquare")
        && event_attributes(&after.wrap[0])
            .is_some_and(|attrs| attrs.len() == 1 && attrs.get("wrapText").is_some_and(|v| v == "bothSides"))
        && after.wrap[1] == Canonical::End;
    if after.mode != "anchor"
        || !square_wrap
        || after
            .simple
            .as_ref()
            .is_none_or(|(x, y)| x != "0" || y != "0")
        || after
            .horizontal
            .as_ref()
            .is_none_or(|(rel, pos)| rel != "column" || !valid_offset(pos))
        || after
            .vertical
            .as_ref()
            .is_none_or(|(rel, pos)| rel != "paragraph" || !valid_offset(pos))
    {
        return false;
    }
    let anchor_attrs_ok = after.wrapper.len() == 10
        && ["distT", "distB", "distL", "distR"]
            .iter()
            .all(|key| after.wrapper.get(*key).is_some_and(|v| v == "0"))
        && after.wrapper.get("simplePos").is_some_and(|v| v == "0")
        && after
            .wrapper
            .get("relativeHeight")
            .is_some_and(|v| canonical_u32(v).is_some_and(|n| n > 0))
        && after.wrapper.get("behindDoc").is_some_and(|v| v == "0")
        && after.wrapper.get("locked").is_some_and(|v| v == "0")
        && after.wrapper.get("layoutInCell").is_some_and(|v| v == "1")
        && after.wrapper.get("allowOverlap").is_some_and(|v| v == "1");
    if !anchor_attrs_ok || after.wrap_name.as_deref() != Some("wrapSquare") {
        return false;
    }
    match before.mode {
        "inline" => {
            before.wrapper.len() == 4
                && ["distT", "distB", "distL", "distR"]
                    .iter()
                    .all(|key| before.wrapper.get(*key).is_some_and(|v| v == "0"))
                && (before.paragraph != after.paragraph || before.mode != after.mode)
        }
        "anchor" => {
            before.wrapper == after.wrapper
                && before.simple == after.simple
                && before.wrap_name == after.wrap_name
                && before.wrap == after.wrap
                && (before.paragraph != after.paragraph
                    || before.horizontal != after.horizontal
                    || before.vertical != after.vertical)
        }
        _ => false,
    }
}

fn valid_offset(value: &str) -> bool {
    value
        .strip_prefix("offset:")
        .and_then(|value| value.parse::<i64>().ok())
        .is_some_and(|value| (-50_800_000..=50_800_000).contains(&value))
}

fn canonical_u32(value: &str) -> Option<u32> {
    let parsed = value.parse::<u32>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn event_start(event: &Canonical, namespace: &str, name: &str) -> bool {
    matches!(event, Canonical::Start { namespace: Some(ns), name: actual, .. } if ns.as_str() == namespace && actual.as_str() == name)
}

fn event_attributes(event: &Canonical) -> Option<BTreeMap<String, String>> {
    let Canonical::Start { attributes, .. } = event else {
        return None;
    };
    let mut result = BTreeMap::new();
    for (namespace, key, value) in attributes {
        if namespace.is_some() || result.insert(key.to_string(), value.to_string()).is_some() {
            return None;
        }
    }
    Some(result)
}

fn namespaced_attribute(event: &Canonical, namespace: &str, name: &str) -> Option<String> {
    let Canonical::Start { attributes, .. } = event else {
        return None;
    };
    let mut found = None;
    for (ns, key, value) in attributes {
        if ns.as_deref() == Some(namespace) && key == name {
            if found.replace(value.to_string()).is_some() {
                return None;
            }
        }
    }
    found
}

fn subtree_end(events: &[Canonical], start: usize) -> Option<usize> {
    if !matches!(events.get(start), Some(Canonical::Start { .. })) {
        return None;
    }
    let mut depth = 0usize;
    for (index, event) in events.iter().enumerate().skip(start) {
        match event {
            Canonical::Start { .. } => depth = depth.checked_add(1)?,
            Canonical::End => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn element_children(events: &[Canonical], start: usize, end: usize) -> Option<Vec<(usize, usize)>> {
    let mut children = Vec::new();
    let mut index = start.checked_add(1)?;
    while index < end {
        match events.get(index)? {
            Canonical::Start { .. } => {
                let child_end = subtree_end(events, index)?;
                if child_end >= end {
                    return None;
                }
                children.push((index, child_end));
                index = child_end.checked_add(1)?;
            }
            Canonical::Text(value) if value.trim().is_empty() => index += 1,
            _ => return None,
        }
    }
    (index == end).then_some(children)
}

fn child_name(event: &Canonical) -> Option<(String, String)> {
    let Canonical::Start {
        namespace, name, ..
    } = event
    else {
        return None;
    };
    Some((namespace.as_ref()?.to_string(), name.to_string()))
}

fn leaf_text(
    events: &[Canonical],
    start: usize,
    end: usize,
    ns: &str,
    name: &str,
) -> Option<String> {
    if !event_start(events.get(start)?, ns, name)
        || end != start + 2
        || events.get(end) != Some(&Canonical::End)
    {
        return None;
    }
    match events.get(start + 1)? {
        Canonical::Text(value) => Some(value.clone()),
        _ => None,
    }
}

fn parse_position(
    events: &[Canonical],
    start: usize,
    end: usize,
    expected: &str,
) -> Option<(String, String)> {
    if !event_start(events.get(start)?, WP, expected) {
        return None;
    }
    let attrs = event_attributes(events.get(start)?)?;
    if attrs.len() != 1 {
        return None;
    }
    let relative = attrs.get("relativeFrom")?.clone();
    let children = element_children(events, start, end)?;
    let [(child, child_end)] = children.as_slice() else {
        return None;
    };
    let (ns, name) = child_name(events.get(*child)?)?;
    if ns != WP {
        return None;
    }
    let value = match name.as_str() {
        "posOffset" => {
            let value = leaf_text(events, *child, *child_end, WP, "posOffset")?;
            let parsed = value.parse::<i64>().ok()?;
            if parsed.to_string() != value || !(-50_800_000..=50_800_000).contains(&parsed) {
                return None;
            }
            format!("offset:{value}")
        }
        "align" => {
            let value = leaf_text(events, *child, *child_end, WP, "align")?;
            if value.is_empty() || value.len() > 32 {
                return None;
            }
            format!("align:{value}")
        }
        _ => return None,
    };
    Some((relative, value))
}

fn note_id(event: &Canonical) -> Option<u32> {
    let value = namespaced_attribute(event, WORD, "id")?;
    let id = value.parse::<u32>().ok()?;
    (id > 0 && id.to_string() == value).then_some(id)
}

fn normal_note(event: &Canonical) -> Option<u32> {
    let id = note_id(event)?;
    let Canonical::Start { attributes, .. } = event else {
        return None;
    };
    if attributes
        .iter()
        .any(|(ns, key, value)| ns.as_deref() == Some(WORD) && key == "type" && value != "normal")
    {
        return None;
    }
    Some(id)
}

fn normalize_story(
    bytes: &[u8],
    root: &str,
    note: Option<&str>,
    owned: &BTreeSet<String>,
) -> Option<NormalizedStory> {
    let note = note?;
    let (events, _) = xml::canonical_with_payload_limit(bytes, Some(8 * 1024 * 1024)).ok()?;
    let mut output = Vec::new();
    let mut pictures = Vec::new();
    let mut stack: Vec<Element> = Vec::new();
    let mut index = 0usize;
    while index < events.len() {
        if event_start(events.get(index)?, WORD, note) && matches_path(&stack, &[(WORD, root)]) {
            let end = subtree_end(&events, index)?;
            if let Some(id) = normal_note(&events[index]) {
                let (mut normalized, found) = normalize_note(&events[index..=end], id, owned)?;
                output.append(&mut normalized);
                pictures.extend(found);
            } else {
                output.extend_from_slice(&events[index..=end]);
            }
            index = end.checked_add(1)?;
            continue;
        }
        match events.get(index)? {
            Canonical::Start {
                namespace, name, ..
            } => stack.push((namespace.clone(), name.clone())),
            Canonical::End => {
                stack.pop()?;
            }
            _ => {}
        }
        output.push(events[index].clone());
        index += 1;
    }
    let mut unique = BTreeSet::new();
    if pictures
        .iter()
        .any(|picture: &StoryPicture| !unique.insert(picture.key.clone()))
    {
        return None;
    }
    Some(NormalizedStory {
        events: output,
        pictures,
    })
}

fn normalize_note(
    events: &[Canonical],
    id: u32,
    owned: &BTreeSet<String>,
) -> Option<(Vec<Canonical>, Vec<StoryPicture>)> {
    let mut output = Vec::new();
    let mut pictures = Vec::new();
    let mut stack: Vec<Element> = Vec::new();
    let mut paragraph = 0usize;
    let mut index = 0usize;
    while index < events.len() {
        if event_start(events.get(index)?, WORD, "p")
            && !stack
                .iter()
                .any(|(ns, name)| ns.as_deref() == Some(WORD) && name == "drawing")
        {
            paragraph = paragraph.checked_add(1)?;
        }
        let in_drawing = stack
            .iter()
            .any(|(ns, name)| ns.as_deref() == Some(WORD) && name == "drawing");
        let direct_run = stack
            .last()
            .is_some_and(|(ns, name)| ns.as_deref() == Some(WORD) && name == "p");
        if !in_drawing && direct_run && event_start(events.get(index)?, WORD, "r") {
            let end = subtree_end(events, index)?;
            if let Some((run_props, drawing)) = picture_run(events, index, end) {
                if let Some((core, key, placement)) =
                    picture_drawing(&drawing, id, paragraph, owned)
                {
                    pictures.push(StoryPicture {
                        key,
                        run_props,
                        core,
                        placement,
                    });
                    index = end.checked_add(1)?;
                    continue;
                }
            }
        }
        match events.get(index)? {
            Canonical::Start {
                namespace, name, ..
            } => stack.push((namespace.clone(), name.clone())),
            Canonical::End => {
                stack.pop()?;
            }
            _ => {}
        }
        output.push(events[index].clone());
        index += 1;
    }
    Some((output, pictures))
}

fn picture_run(
    events: &[Canonical],
    start: usize,
    end: usize,
) -> Option<(Vec<Canonical>, Vec<Canonical>)> {
    let attrs = event_attributes(events.get(start)?)?;
    if !attrs.is_empty() {
        return None;
    }
    let children = element_children(events, start, end)?;
    let mut run_props = None;
    let mut drawing = None;
    for (child, child_end) in children {
        if event_start(events.get(child)?, WORD, "rPr") {
            if run_props
                .replace(events[child..=child_end].to_vec())
                .is_some()
            {
                return None;
            }
        } else if event_start(events.get(child)?, WORD, "drawing") {
            if drawing
                .replace(events[child..=child_end].to_vec())
                .is_some()
            {
                return None;
            }
        } else {
            return None;
        }
    }
    Some((run_props.unwrap_or_default(), drawing?))
}

fn picture_drawing(
    events: &[Canonical],
    note_id: u32,
    paragraph: usize,
    owned: &BTreeSet<String>,
) -> Option<(Vec<Canonical>, StoryPictureKey, PicturePlacement)> {
    if !event_start(events.first()?, WORD, "drawing") || events.last()? != &Canonical::End {
        return None;
    }
    let drawing_end = events.len().checked_sub(1)?;
    let drawing_children = element_children(events, 0, drawing_end)?;
    let [(wrapper_start, wrapper_end)] = drawing_children.as_slice() else {
        return None;
    };
    let mode = if event_start(events.get(*wrapper_start)?, WP, "inline") {
        "inline"
    } else if event_start(events.get(*wrapper_start)?, WP, "anchor") {
        "anchor"
    } else {
        return None;
    };
    let wrapper = event_attributes(events.get(*wrapper_start)?)?;
    let children = element_children(events, *wrapper_start, *wrapper_end)?;
    let mut names = Vec::new();
    let mut simple = None;
    let mut horizontal = None;
    let mut vertical = None;
    let mut wrap_name = None;
    let mut wrap = Vec::new();
    let mut core_children = Vec::new();
    for (child, child_end) in &children {
        let (ns, name) = child_name(events.get(*child)?)?;
        names.push((ns.clone(), name.clone()));
        match (ns.as_str(), name.as_str()) {
            (WP, "simplePos") => {
                let attrs = event_attributes(events.get(*child)?)?;
                let (x, y) = (attrs.get("x")?.clone(), attrs.get("y")?.clone());
                let canonical =
                    |value: &str| value.parse::<i64>().is_ok_and(|n| n.to_string() == value);
                if attrs.len() != 2
                    || !canonical(&x)
                    || !canonical(&y)
                    || simple.replace((x, y)).is_some()
                {
                    return None;
                }
            }
            (WP, "positionH") => {
                if horizontal
                    .replace(parse_position(events, *child, *child_end, "positionH")?)
                    .is_some()
                {
                    return None;
                }
            }
            (WP, "positionV") => {
                if vertical
                    .replace(parse_position(events, *child, *child_end, "positionV")?)
                    .is_some()
                {
                    return None;
                }
            }
            (WP, "wrapSquare" | "wrapTight" | "wrapThrough" | "wrapTopAndBottom" | "wrapNone") => {
                let attributes = event_attributes(events.get(*child)?)?;
                if wrap_name.replace(name.clone()).is_some() {
                    return None;
                }
                if name == "wrapSquare"
                    && (attributes.len() != 1
                        || !matches!(
                            attributes.get("wrapText").map(String::as_str),
                            Some("bothSides" | "left" | "right" | "largest")
                        ))
                {
                    return None;
                }
                wrap = events[*child..=*child_end].to_vec();
            }
            (WP, "extent" | "effectExtent" | "docPr" | "cNvGraphicFramePr") | (A, "graphic") => {
                core_children.extend_from_slice(&events[*child..=*child_end]);
            }
            _ => return None,
        }
    }
    let inline_names = [
        (WP, "extent"),
        (WP, "effectExtent"),
        (WP, "docPr"),
        (WP, "cNvGraphicFramePr"),
        (A, "graphic"),
    ];
    let anchor_names = [
        (WP, "simplePos"),
        (WP, "positionH"),
        (WP, "positionV"),
        (WP, "extent"),
        (WP, "effectExtent"),
        (WP, "wrapSquare"),
        (WP, "docPr"),
        (WP, "cNvGraphicFramePr"),
        (A, "graphic"),
    ];
    if mode == "inline" {
        if names.as_slice() != inline_names.map(|(ns, name)| (ns.to_owned(), name.to_owned()))
            || simple.is_some()
            || horizontal.is_some()
            || vertical.is_some()
            || wrap_name.is_some()
        {
            return None;
        }
        if wrapper.len() != 4
            || ["distT", "distB", "distL", "distR"].iter().any(|key| {
                wrapper
                    .get(*key)
                    .is_none_or(|value| canonical_u32(value).is_none())
            })
        {
            return None;
        }
    } else {
        if names.as_slice() != anchor_names.map(|(ns, name)| (ns.to_owned(), name.to_owned()))
            || simple.is_none()
            || horizontal.is_none()
            || vertical.is_none()
            || wrap_name.is_none()
        {
            return None;
        }
        if !valid_anchor_attributes(&wrapper) {
            return None;
        }
    }
    let placement = PicturePlacement {
        paragraph,
        mode,
        wrapper,
        simple,
        horizontal,
        vertical,
        wrap_name,
        wrap,
    };

    let mut core = Vec::with_capacity(core_children.len() + 2);
    core.push(events[0].clone());
    core.extend(core_children);
    core.push(events[drawing_end].clone());
    let docpr = unique_attribute(&core, WP, "docPr", None, "id")?;
    let picture_id = unique_attribute(&core, PIC, "cNvPr", None, "id")?;
    let embedded = unique_attribute(&core, A, "blip", Some(REL), "embed")?;
    let graphic_data = matching_elements(&core, A, "graphicData");
    let graphic_uri = graphic_data
        .first()
        .and_then(|index| event_attributes(&core[*index]))
        .and_then(|attrs| attrs.get("uri").cloned());
    if graphic_data.len() != 1
        || graphic_uri.as_deref() != Some(PIC)
        || matching_elements(&core, A, "blip").len() != 1
        || !owned.contains(&embedded)
        || docpr.parse::<u32>().is_err()
        || picture_id.parse::<u32>().is_err()
    {
        return None;
    }
    Some((
        core,
        StoryPictureKey {
            note_id,
            docpr_id: docpr,
            picture_id,
            embed_id: embedded,
        },
        placement,
    ))
}

fn valid_anchor_attributes(attrs: &BTreeMap<String, String>) -> bool {
    attrs.len() == 10
        && ["distT", "distB", "distL", "distR"].iter().all(|key| {
            attrs
                .get(*key)
                .is_some_and(|value| canonical_u32(value).is_some())
        })
        && attrs
            .get("simplePos")
            .is_some_and(|value| matches!(value.as_str(), "0" | "1"))
        && attrs
            .get("relativeHeight")
            .is_some_and(|value| canonical_u32(value).is_some())
        && attrs
            .get("behindDoc")
            .is_some_and(|value| matches!(value.as_str(), "0" | "1"))
        && attrs
            .get("locked")
            .is_some_and(|value| matches!(value.as_str(), "0" | "1"))
        && attrs
            .get("layoutInCell")
            .is_some_and(|value| matches!(value.as_str(), "0" | "1"))
        && attrs
            .get("allowOverlap")
            .is_some_and(|value| matches!(value.as_str(), "0" | "1"))
}

fn matching_elements(events: &[Canonical], namespace: &str, name: &str) -> Vec<usize> {
    events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| event_start(event, namespace, name).then_some(index))
        .collect()
}

fn unique_attribute(
    events: &[Canonical],
    element_ns: &str,
    element_name: &str,
    attribute_ns: Option<&str>,
    attribute_name: &str,
) -> Option<String> {
    let elements = matching_elements(events, element_ns, element_name);
    if elements.len() != 1 {
        return None;
    }
    let Canonical::Start { attributes, .. } = &events[elements[0]] else {
        return None;
    };
    let mut found = None;
    for (ns, name, value) in attributes {
        if ns.as_deref() == attribute_ns && name == attribute_name {
            if found.replace(value.to_string()).is_some() {
                return None;
            }
        }
    }
    found
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
