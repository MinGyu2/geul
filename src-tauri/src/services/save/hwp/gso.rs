//! Bounded field-level evolution and deletion proof for existing HWP5 GSO (`b" osg"`) objects.
//!
//! Only top-level Pictures (`b"cip$"`) and basic Shapes (`b"nil$"`, `b"cer$"`,
//! `b"lle$"`, optionally with a plain TextBox or an unchanged caption subtree)
//! whose identity matches unambiguously may evolve within the exact fields owned
//! by supported editor commands, or be deleted when unlocked, uncaptioned,
//! non-grouped, and free of opaque/nested controls.
//! Picture caption editing has a separate owned story proof. Caption deletion, groups, charts,
//! OLE, unknown extensions, and BinData substitutions remain outside this module’s edit proofs.

use super::FindingCode;
use super::Record;
use super::insertions::{
    Checked, Defs, dword, entries, finding, preserved, reference, valid, word,
};

const BODY: &str = "BodyText/Section0";
const CTRL_GSO: &[u8; 4] = b" osg";
const SC_PICTURE: &[u8; 4] = b"cip$";
const SC_LINE: &[u8; 4] = b"nil$";
const SC_RECT: &[u8; 4] = b"cer$";
const SC_ELLIPSE: &[u8; 4] = b"lle$";
const SC_POLYGON: &[u8; 4] = b"lop$";
const SC_CURVE: &[u8; 4] = b"ruc$";
const SC_CONTAINER: &[u8; 4] = b"noc$";

const TAG_CTRL_HEADER: u16 = 71;
const TAG_LIST_HEADER: u16 = 72;
const TAG_SHAPE_COMPONENT: u16 = 76;
const TAG_LINE: u16 = 78;
const TAG_RECTANGLE: u16 = 79;
const TAG_ELLIPSE: u16 = 80;
const TAG_POLYGON: u16 = 82;
const TAG_CURVE: u16 = 83;
const TAG_PICTURE: u16 = 85;

const MAX_DIM_HU: usize = 2_000_000;
const MAX_OFFSET_HU: i32 = 2_000_000;
const MAX_CROP_HU: i32 = 10_000_000;
const MAX_DESC_UNITS: usize = 256;

/// `CommonObjAttr.attr` bits editable via supported wrap / anchor commands:
/// - bit 0: `treat_as_char`
/// - bits 3..=4: `vert_rel_to` (`0..=2`)
/// - bits 8..=9: `horz_rel_to` (`0..=3`)
/// - bits 21..=23: `text_wrap` (`0..=3`)
const MUTABLE_ATTR_MASK: u32 = 0x01 | (0x03 << 3) | (0x03 << 8) | (0x07 << 21);
const ALIGN_ATTR_MASK: u32 = (0x07 << 5) | (0x07 << 10);
const FLOW_WITH_TEXT: u32 = 1 << 13;
const ATTR_SIZE_PROTECT: u32 = 1 << 20;
const ATTR_CAPTION: u32 = 1 << 29;
const ATTR_LOCKED: u32 = 1 << 30;

fn gso_header_id(rs: &[Record<'_>]) -> Option<u32> {
    let first = rs.first()?;
    if first.0 != TAG_CTRL_HEADER || !first.2.starts_with(CTRL_GSO) || first.2.len() < 40 {
        return None;
    }
    Some(u32::from_le_bytes(first.2.get(36..40)?.try_into().ok()?))
}

/// HWP5 permits CTRL_HEADER records with no description string at all. The
/// pinned RHWP parser reads that as an empty description and its writer emits
/// the canonical zero-length UTF-16 string before the exact opaque tail.
fn description_parts(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    if bytes.len() < 44 {
        return None;
    }
    if bytes.len() < 46 {
        return Some((&[], &bytes[44..]));
    }
    let units = u16::from_le_bytes(bytes[44..46].try_into().ok()?) as usize;
    let end = 46usize.checked_add(units.checked_mul(2)?)?;
    Some((bytes.get(46..end)?, bytes.get(end..)?))
}

/// An original caption subtree can be carried through an unrelated edit by
/// exact object equality, or preserved verbatim across proven outer-object edits.
pub(super) fn preserved_structure(rs: &[Record<'_>]) -> bool {
    let level = rs[0].1 + 1;
    let Some(first) = rs.get(1).filter(|r| r.1 == level) else {
        return false;
    };
    first.0 == TAG_SHAPE_COMPONENT
        || (first.0 == TAG_LIST_HEADER
            && dword(rs[0].2, 4).is_ok_and(|attr| attr as u32 & ATTR_CAPTION != 0)
            && rs[2..]
                .iter()
                .any(|r| r.0 == TAG_SHAPE_COMPONENT && r.1 == level))
}

/// Caption paragraphs do not appear in the structural record filter. Include
/// their complete GSO so a text-only caption edit cannot use the ordinary
/// paragraph path. RHWP locates a caption list before the shape component.
pub(super) fn caption_subtrees<'a, 'b>(
    rs: &'a [Record<'b>],
) -> impl Iterator<Item = &'a [Record<'b>]> {
    rs.iter()
        .enumerate()
        .filter_map(|(i, &(tag, level, data))| {
            if tag != TAG_CTRL_HEADER || !data.starts_with(CTRL_GSO) {
                return None;
            }
            let bit = dword(data, 4).is_ok_and(|attr| attr as u32 & ATTR_CAPTION != 0);
            let list = rs
                .get(i + 1)
                .is_some_and(|r| r.0 == TAG_LIST_HEADER && r.1 == level + 1);
            if !bit && !list {
                return None;
            }
            let end = rs[i + 1..]
                .iter()
                .position(|r| r.1 <= level)
                .map_or(rs.len(), |offset| i + 1 + offset);
            Some(&rs[i..end])
        })
}

fn shape_component_pos(rs: &[Record<'_>]) -> Option<usize> {
    let first = rs.first()?;
    if first.0 != TAG_CTRL_HEADER || !first.2.starts_with(CTRL_GSO) || first.2.len() < 44 {
        return None;
    }
    let level = first.1 + 1;
    let r1 = rs.get(1)?;
    if r1.0 == TAG_SHAPE_COMPONENT && r1.1 == level {
        return Some(1);
    }
    let attr = dword(first.2, 4).ok()? as u32;
    if (attr & ATTR_CAPTION) == 0 || r1.0 != TAG_LIST_HEADER || r1.1 != level {
        return None;
    }
    // HWP5 caption LIST_HEADER (level 2) + caption paragraph(s) (PARA_HEADER at level 2,
    // children at >=3) precede SHAPE_COMPONENT at `level`.
    let rel = rs[2..]
        .iter()
        .position(|r| r.0 == TAG_SHAPE_COMPONENT && r.1 == level)?;
    let sc_idx = 2 + rel;
    if rs[2..sc_idx]
        .iter()
        .any(|r| r.1 < level || (r.1 == level && r.0 != 66))
    {
        return None;
    }
    Some(sc_idx)
}

pub(super) fn shape_ctrl_id<'a>(rs: &'a [Record<'a>]) -> Option<(&'a [u8; 4], usize, usize)> {
    let sc_idx = shape_component_pos(rs)?;
    let sc = rs.get(sc_idx)?;
    if sc.2.len() < 8 {
        return None;
    }
    let two = sc.2[..4] == sc.2[4..8];
    let id_offset = if two { 8 } else { 4 };
    if sc.2.len() < id_offset + 44 {
        return None;
    }
    let ctrl_id: &[u8; 4] = sc.2[..4].try_into().ok()?;
    Some((ctrl_id, id_offset, sc_idx))
}

fn expected_leaf_tag(ctrl_id: &[u8; 4]) -> Option<u16> {
    match ctrl_id {
        SC_PICTURE => Some(TAG_PICTURE),
        SC_LINE => Some(TAG_LINE),
        SC_RECT => Some(TAG_RECTANGLE),
        SC_ELLIPSE => Some(TAG_ELLIPSE),
        SC_POLYGON => Some(TAG_POLYGON),
        SC_CURVE => Some(TAG_CURVE),
        _ => None,
    }
}

fn plain_textbox(rs: &[Record<'_>]) -> bool {
    let Some((SC_RECT, 8, 1)) = shape_ctrl_id(rs) else {
        return false;
    };
    let Some(&(72, 3, list)) = rs.get(2) else {
        return false;
    };
    rs[0].1 == 1
        && dword(rs[0].2, 4).is_ok_and(|attr| attr as u32 & (ATTR_LOCKED | ATTR_CAPTION) == 0)
        && word(rs[1].2, 16) == Ok(0)
        && list.len() == 33
        && dword(list, 0).is_ok_and(|count| (1..=64).contains(&count))
        && list[20..] == [0; 13]
        && rs.last().is_some_and(|r| r.0 == TAG_RECTANGLE && r.1 == 3)
        && rs.len() >= 7
}

/// A changed TextBox only reaches the plain-story proof when its original
/// control, component, list header, and leaf all independently match.
pub(super) fn textbox_edit_candidate(old: &[Record<'_>], new: &[Record<'_>]) -> bool {
    plain_textbox(old)
        && plain_textbox(new)
        && old[..2] == new[..2]
        && old[2].2[4..] == new[2].2[4..]
        && old.last() == new.last()
        && old != new
}

pub(super) fn textbox_story<'a, 'b>(
    rs: &'b [Record<'a>],
) -> impl Iterator<Item = &'b [Record<'a>]> {
    rs.iter().enumerate().filter_map(move |(index, record)| {
        if record.0 != TAG_CTRL_HEADER || record.1 != 1 || !record.2.starts_with(CTRL_GSO) {
            return None;
        }
        let end = rs[index + 1..]
            .iter()
            .position(|r| r.1 <= 1)
            .map_or(rs.len(), |next| index + 1 + next);
        let object = &rs[index..end];
        object
            .iter()
            .any(|r| r.0 == TAG_LIST_HEADER && r.1 == 3)
            .then_some(object)
    })
}

fn textbox_paragraph_content(rs: &[Record<'_>]) -> Option<(Vec<u16>, Vec<(usize, u32)>)> {
    let text_records: Vec<_> = rs
        .iter()
        .filter(|record| record.0 == 67 && record.1 == 4)
        .collect();
    if text_records.len() != 1 {
        return None;
    }
    let encoded = text_records[0].2.strip_suffix(&[13, 0])?;
    if encoded.len() % 2 != 0 {
        return None;
    }
    let text: Vec<u16> = encoded
        .chunks_exact(2)
        .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
        .collect();
    if text.iter().any(|unit| *unit < 32) {
        return None;
    }
    let shape_records: Vec<_> = rs
        .iter()
        .filter(|record| record.0 == 68 && record.1 == 4)
        .collect();
    if shape_records.len() != 1 || shape_records[0].2.len() % 8 != 0 {
        return None;
    }
    let runs: Vec<(usize, u32)> = shape_records[0]
        .2
        .chunks_exact(8)
        .map(|run| {
            Some((
                u32::from_le_bytes(run[..4].try_into().ok()?) as usize,
                u32::from_le_bytes(run[4..].try_into().ok()?),
            ))
        })
        .collect::<Option<Vec<_>>>()?;
    if runs.first().is_none_or(|run| run.0 != 0)
        || runs.windows(2).any(|pair| pair[0].0 >= pair[1].0)
        || runs.iter().any(|run| run.0 > text.len())
    {
        return None;
    }
    Some((text, runs))
}

fn textbox_char_shape(runs: &[(usize, u32)], offset: usize) -> Option<u32> {
    runs.iter()
        .take_while(|run| run.0 <= offset)
        .last()
        .map(|run| run.1)
}

fn textbox_content_matches(
    source: &[Record<'_>],
    first: &[Record<'_>],
    second: Option<&[Record<'_>]>,
) -> bool {
    let (Some((source_text, source_shapes)), Some((first_text, first_shapes))) = (
        textbox_paragraph_content(source),
        textbox_paragraph_content(first),
    ) else {
        return false;
    };
    let second_content = second.map(textbox_paragraph_content);
    if second.is_some()
        && second_content
            .as_ref()
            .is_none_or(|content| content.is_none())
    {
        return false;
    }
    let second_content = second_content.flatten();
    let second_text = second_content
        .as_ref()
        .map_or(&[][..], |(text, _)| text.as_slice());
    if source_text.len() != first_text.len() + second_text.len()
        || source_text
            .iter()
            .copied()
            .ne(first_text.iter().chain(second_text).copied())
    {
        return false;
    }
    let second_shapes = second_content
        .as_ref()
        .map_or(&[][..], |(_, shapes)| shapes.as_slice());
    (0..source_text.len()).all(|offset| {
        let target = if offset < first_text.len() {
            textbox_char_shape(&first_shapes, offset)
        } else {
            textbox_char_shape(&second_shapes, offset - first_text.len())
        };
        textbox_char_shape(&source_shapes, offset) == target
    })
}

fn textbox_range_content(
    paragraphs: &[&[Record<'_>]],
) -> Option<(Vec<u16>, Vec<u32>, std::collections::BTreeSet<u32>)> {
    let mut text = Vec::new();
    let mut styles = Vec::new();
    let mut available_styles = std::collections::BTreeSet::new();
    for paragraph in paragraphs {
        let (paragraph_text, runs) = textbox_paragraph_content(paragraph)?;
        available_styles.extend(runs.iter().map(|run| run.1));
        for offset in 0..paragraph_text.len() {
            styles.push(textbox_char_shape(&runs, offset)?);
        }
        text.extend(paragraph_text);
    }
    Some((text, styles, available_styles))
}

fn textbox_preserves_inserted_range(
    old_paragraphs: &[&[Record<'_>]],
    new_paragraphs: &[&[Record<'_>]],
) -> bool {
    let (Some((old_text, old_styles, available_styles)), Some((new_text, new_styles, _))) = (
        textbox_range_content(old_paragraphs),
        textbox_range_content(new_paragraphs),
    ) else {
        return false;
    };
    if old_text.len() > 65_536 || new_text.len() > 65_536 {
        return false;
    }

    // Paragraph reflow is authorized only for insertion-only edits: every
    // original UTF-16 unit must remain in order and on the same character
    // shape, and inserted units must use a character shape already owned by
    // the source text box. This distinguishes multiline paste from altered
    // paragraph text or formatting.
    let mut next = 0;
    let mut previous_match = None;
    let mut matched_new = vec![false; new_text.len()];
    for (source_offset, (unit, style)) in old_text.iter().zip(&old_styles).enumerate() {
        let Some(offset) = (next..new_text.len())
            .find(|offset| new_text[*offset] == *unit && new_styles[*offset] == *style)
        else {
            return false;
        };
        if previous_match.is_some_and(|previous| {
            source_offset > 0
                && (0xD800..=0xDBFF).contains(&old_text[source_offset - 1])
                && (0xDC00..=0xDFFF).contains(unit)
                && offset != previous + 1
        }) {
            return false;
        }
        matched_new[offset] = true;
        previous_match = Some(offset);
        next = offset + 1;
    }
    new_styles
        .iter()
        .enumerate()
        .all(|(offset, style)| matched_new[offset] || available_styles.contains(style))
}

fn proven_textbox_reflow(
    old_paragraphs: &[&[Record<'_>]],
    new_paragraphs: &[&[Record<'_>]],
    original_defs: &Defs<'_>,
    defs: &Defs<'_>,
    original_instances: &std::collections::BTreeMap<u32, usize>,
    output_instances: &std::collections::BTreeMap<u32, usize>,
) -> bool {
    if old_paragraphs.is_empty()
        || new_paragraphs.is_empty()
        || old_paragraphs.len() == new_paragraphs.len()
        || old_paragraphs.len().abs_diff(new_paragraphs.len()) > 63
        || original_defs != defs
    {
        return false;
    }
    let mut prefix = 0;
    while prefix < old_paragraphs.len().min(new_paragraphs.len())
        && old_paragraphs[prefix] == new_paragraphs[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_paragraphs.len() - prefix
        && suffix < new_paragraphs.len() - prefix
        && old_paragraphs[old_paragraphs.len() - 1 - suffix]
            == new_paragraphs[new_paragraphs.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let old_changed = &old_paragraphs[prefix..old_paragraphs.len() - suffix];
    let new_changed = &new_paragraphs[prefix..new_paragraphs.len() - suffix];
    let (Some(first_old), Some(first_new)) = (old_changed.first(), new_changed.first()) else {
        return false;
    };
    let Some(first_id) = textbox_paragraph_instance(first_old) else {
        return false;
    };
    if original_instances.get(&first_id) != Some(&1)
        || textbox_paragraph_instance(first_new) != Some(first_id)
        || output_instances.get(&first_id) != Some(&1)
    {
        return false;
    }

    let Some(base_tail) = textbox_paragraph_tail(first_old) else {
        return false;
    };
    let Some(style_refs) = first_old.first().and_then(|record| record.2.get(8..11)) else {
        return false;
    };
    let Some(style_index) = first_old.first().and_then(|record| word(record.2, 8).ok()) else {
        return false;
    };
    let Some(base_style) = entries(original_defs, 25).get(style_index) else {
        return false;
    };

    for paragraph in old_changed.iter().chain(new_changed) {
        let Some(header) = paragraph.first().map(|record| record.2) else {
            return false;
        };
        let Some(style_index) = word(header, 8).ok() else {
            return false;
        };
        let Some(style) = entries(original_defs, 25).get(style_index) else {
            return false;
        };
        if header.get(8..11) != Some(style_refs)
            || textbox_paragraph_tail(paragraph) != Some(base_tail)
            || super::insertions::same_textbox_para_style(base_style, style).is_err()
        {
            return false;
        }
    }
    for paragraph in old_changed {
        let Some(id) = textbox_paragraph_instance(paragraph) else {
            return false;
        };
        if original_instances.get(&id) != Some(&1) {
            return false;
        }
    }
    for (index, paragraph) in new_changed.iter().enumerate() {
        let Some(id) = textbox_paragraph_instance(paragraph) else {
            return false;
        };
        if (index == 0 && id != first_id)
            || (index > 0
                && (id == 0
                    || original_instances.contains_key(&id)
                    || output_instances.get(&id) != Some(&1)))
        {
            return false;
        }
    }
    let removed_ids_absent = old_changed.iter().skip(1).all(|paragraph| {
        textbox_paragraph_instance(paragraph).is_some_and(|id| !output_instances.contains_key(&id))
    });
    let content_preserved = textbox_preserves_inserted_range(old_changed, new_changed);
    removed_ids_absent && content_preserved
}

fn same_textbox_paragraph_refs(first: &[Record<'_>], second: &[Record<'_>]) -> bool {
    let (Some(a), Some(b)) = (
        first.first().map(|record| record.2),
        second.first().map(|record| record.2),
    ) else {
        return false;
    };
    a.len() >= 22 && b.len() >= 22 && a[8..11] == b[8..11]
}

fn textbox_paragraph_instance(rs: &[Record<'_>]) -> Option<u32> {
    let header = rs.first()?.2;
    let bytes: [u8; 4] = header.get(18..22)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn textbox_paragraph_tail<'a>(rs: &[Record<'a>]) -> Option<&'a [u8]> {
    rs.first()?.2.get(22..)
}

fn proven_textbox_split(
    source: &[Record<'_>],
    first: &[Record<'_>],
    second: &[Record<'_>],
    original_instances: &std::collections::BTreeMap<u32, usize>,
    output_instances: &std::collections::BTreeMap<u32, usize>,
) -> bool {
    let (Some(source_id), Some(first_id), Some(second_id)) = (
        textbox_paragraph_instance(source),
        textbox_paragraph_instance(first),
        textbox_paragraph_instance(second),
    ) else {
        return false;
    };
    same_textbox_paragraph_refs(source, first)
        && same_textbox_paragraph_refs(source, second)
        && source_id == first_id
        && textbox_paragraph_tail(source) == textbox_paragraph_tail(first)
        && textbox_paragraph_tail(source) == textbox_paragraph_tail(second)
        && second_id != 0
        && !original_instances.contains_key(&second_id)
        && output_instances.get(&second_id) == Some(&1)
        && textbox_content_matches(source, first, Some(second))
}

fn proven_textbox_merge(
    first: &[Record<'_>],
    second: &[Record<'_>],
    merged: &[Record<'_>],
    original_instances: &std::collections::BTreeMap<u32, usize>,
    output_instances: &std::collections::BTreeMap<u32, usize>,
) -> bool {
    let (Some(first_id), Some(second_id), Some(merged_id)) = (
        textbox_paragraph_instance(first),
        textbox_paragraph_instance(second),
        textbox_paragraph_instance(merged),
    ) else {
        return false;
    };
    same_textbox_paragraph_refs(first, merged)
        && first_id == merged_id
        && second_id != first_id
        && original_instances.get(&second_id) == Some(&1)
        && !output_instances.contains_key(&second_id)
        && textbox_paragraph_tail(first) == textbox_paragraph_tail(merged)
        && textbox_content_matches(merged, first, Some(second))
}

pub(super) fn prove_textbox_edit(
    old: &[Record<'_>],
    new: &[Record<'_>],
    original_defs: &Defs<'_>,
    defs: &Defs<'_>,
    original_instances: &std::collections::BTreeMap<u32, usize>,
    output_instances: &std::collections::BTreeMap<u32, usize>,
) -> Checked<()> {
    preserved(textbox_edit_candidate(old, new), BODY)?;
    let paragraphs = |rs: &[Record<'_>]| {
        rs.iter()
            .enumerate()
            .filter_map(|(i, r)| (r.0 == 66 && r.1 == 3).then_some(i))
            .chain(std::iter::once(rs.len()))
            .collect::<Vec<_>>()
    };
    let old_story = &old[3..old.len() - 1];
    let new_story = &new[3..new.len() - 1];
    let before = paragraphs(old_story);
    let after = paragraphs(new_story);
    let count = dword(old[2].2, 0)?;
    preserved(
        before.first() == Some(&0)
            && after.first() == Some(&0)
            && before.len() == count + 1
            && after.len() == dword(new[2].2, 0)? + 1,
        BODY,
    )?;
    let new_count = dword(new[2].2, 0)?;
    preserved(new_count.abs_diff(count) <= 63, BODY)?;
    let old_paragraphs: Vec<_> = before
        .windows(2)
        .map(|span| &old_story[span[0]..span[1]])
        .collect();
    let new_paragraphs: Vec<_> = after
        .windows(2)
        .map(|span| &new_story[span[0]..span[1]])
        .collect();
    for old_para in &old_paragraphs {
        super::insertions::prove_textbox_paragraph(old_para, original_defs, original_defs)?;
    }
    for new_para in &new_paragraphs {
        super::insertions::prove_textbox_paragraph(new_para, defs, original_defs)?;
    }
    if count == new_count {
        for (old_para, new_para) in old_paragraphs.iter().zip(&new_paragraphs) {
            preserved(
                textbox_paragraph_instance(old_para) == textbox_paragraph_instance(new_para)
                    && textbox_paragraph_tail(old_para) == textbox_paragraph_tail(new_para),
                BODY,
            )?;
            let old_style = entries(original_defs, 25)[word(old_para[0].2, 8)?];
            let new_style = entries(defs, 25)[word(new_para[0].2, 8)?];
            super::insertions::same_textbox_para_style(old_style, new_style)?;
        }
        return Ok(());
    }
    preserved(original_defs == defs, BODY)?;
    let mut witnesses = 0usize;
    if new_count == count + 1 {
        for index in 0..old_paragraphs.len() {
            if old_paragraphs[..index] == new_paragraphs[..index]
                && old_paragraphs[index + 1..] == new_paragraphs[index + 2..]
                && proven_textbox_split(
                    old_paragraphs[index],
                    new_paragraphs[index],
                    new_paragraphs[index + 1],
                    original_instances,
                    output_instances,
                )
            {
                witnesses += 1;
            }
        }
    } else if count == new_count + 1 {
        for index in 0..new_paragraphs.len() {
            if old_paragraphs[..index] == new_paragraphs[..index]
                && old_paragraphs[index + 2..] == new_paragraphs[index + 1..]
                && proven_textbox_merge(
                    old_paragraphs[index],
                    old_paragraphs[index + 1],
                    new_paragraphs[index],
                    original_instances,
                    output_instances,
                )
            {
                witnesses += 1;
            }
        }
    }
    preserved(
        witnesses == 1
            || proven_textbox_reflow(
                &old_paragraphs,
                &new_paragraphs,
                original_defs,
                defs,
                original_instances,
                output_instances,
            ),
        BODY,
    )
}

pub(super) fn picture_caption_candidate(old: &[Record<'_>], new: &[Record<'_>]) -> bool {
    let (Some((kind, _, a)), Some((kind2, _, b))) = (shape_ctrl_id(old), shape_ctrl_id(new))
    else {
        return false;
    };
    let Some(leaf_tag) = expected_leaf_tag(kind) else {
        return false;
    };
    kind == kind2
        && old != new
        && a >= 3
        && b >= 3
        && old.len() == a + 2
        && new.len() == b + 2
        && old[0].1 == 1
        && old[0] == new[0]
        && old[1].0 == TAG_LIST_HEADER
        && old[1].1 == 2
        && new[1].0 == TAG_LIST_HEADER
        && new[1].1 == 2
        && old[a + 1].0 == leaf_tag
        && old[a + 1].1 == 3
        && old[a..] == new[b..]
}

pub(super) fn prove_picture_caption(
    old: &[Record<'_>],
    new: &[Record<'_>],
    original_defs: &Defs<'_>,
    defs: &Defs<'_>,
) -> Checked<()> {
    preserved(picture_caption_candidate(old, new), BODY)?;
    let (kind, _, a) = shape_ctrl_id(old).unwrap();
    let (_, _, b) = shape_ctrl_id(new).unwrap();
    let old_list = old[1].2;
    let new_list = new[1].2;
    let old_count = word(old_list, 0)?;
    let new_count = word(new_list, 0)?;
    preserved(
        (kind != SC_PICTURE
            || picture_bin_id(old)
                .is_some_and(|id| (1..=entries(original_defs, 18).len()).contains(&id)))
            && dword(old[0].2, 4)? as u32 & (ATTR_LOCKED | ATTR_CAPTION) == ATTR_CAPTION
            && old_list.len() == 30
            && new_list.len() == 30
            && old_list[2..] == new_list[2..]
            && (1..=64).contains(&old_count)
            && (1..=64).contains(&new_count),
        BODY,
    )?;
    super::insertions::prove_caption_paragraphs(
        &old[2..a],
        &new[2..b],
        old_count,
        new_count,
        original_defs,
        defs,
    )
}

/// The pinned RHWP body insertion command emits these resource-free defaults.
/// Bare defaults may carry a bounded solid-outline width from a subsequent edit.
pub(super) fn prove_inserted_shape(
    rs: &[Record<'_>],
    defs: &Defs<'_>,
    original_defs: &Defs<'_>,
    original_ids: &std::collections::BTreeSet<usize>,
) -> Checked<()> {
    let Some((kind, 8, 1)) = shape_ctrl_id(rs) else {
        return Err(finding(FindingCode::RecordsChanged, BODY));
    };
    let textbox = matches!(rs.len(), 7 | 8) && kind == SC_RECT;
    let (tag, height, description) = match kind {
        SC_LINE => (TAG_LINE, 100i32, "선입니다."),
        SC_ELLIPSE => (TAG_ELLIPSE, 7200, "타원입니다."),
        SC_RECT if textbox => (TAG_RECTANGLE, 7200, "글상자입니다."),
        SC_RECT => (TAG_RECTANGLE, 7200, "사각형입니다."),
        _ => return Err(finding(FindingCode::RecordsChanged, BODY)),
    };
    let width = 10800i32;
    let (leaf_tag, leaf_level, leaf) = rs[rs.len() - 1];
    let h = rs[0].2;
    let instance = dword(h, 36)?;
    reference(instance != 0 && !original_ids.contains(&instance), BODY)?;
    let margin = (if textbox { 283u16 } else { 0 }).to_le_bytes();
    let desc: Vec<u8> = description
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    preserved(
        rs[0].1 == 1 && rs[1].1 == 2 && (textbox || rs.len() == 3),
        BODY,
    )?;
    preserved(
        dword(h, 4)? == if textbox { 0x000a0211 } else { 0x000a0000 }
            && h[8..16] == [0; 8]
            && dword(h, 16)? == width as usize
            && dword(h, 20)? == height as usize
            && h[28..36].chunks_exact(2).all(|m| m == margin)
            && h[40..44] == [0; 4]
            && word(h, 44)? == desc.len() / 2
            && h[46..] == desc,
        BODY,
    )?;

    let line = kind == SC_LINE;
    let mut component = vec![0; if line { 239 } else { 252 }];
    component[..4].copy_from_slice(kind);
    component[4..8].copy_from_slice(kind);
    component[18..20].copy_from_slice(&1u16.to_le_bytes()); // local version
    for (at, value) in [
        (20, width),
        (24, height),
        (28, width),
        (32, height),
        (36, 0x0008_0000),
        (42, width / 2),
        (46, height / 2),
        (200, 33),
        (204, 0xd100_0041u32 as i32),
    ] {
        component[at..at + 4].copy_from_slice(&value.to_le_bytes());
    }
    component[50..52].copy_from_slice(&1u16.to_le_bytes());
    for matrix in component[52..196].chunks_exact_mut(48) {
        matrix[..8].copy_from_slice(&1.0f64.to_le_bytes());
        matrix[32..40].copy_from_slice(&1.0f64.to_le_bytes());
    }
    if !line {
        component[209] = 1; // solid white fill, no pattern
        component[213..217].copy_from_slice(&0x00ff_ffffu32.to_le_bytes());
        component[221..225].copy_from_slice(&(-1i32).to_le_bytes());
    }
    let subject = ((instance as u32 & 0x3fff_ffff) + 1).to_le_bytes();
    let at = component.len() - 6;
    component[at..at + 4].copy_from_slice(&subject);
    let actual = rs[1].2;
    if !textbox && actual.len() == component.len() {
        // The surrounding canonical bytes still prove the solid line type,
        // default color, transforms, geometry-independent fields and subject ID.
        let border_width = dword(actual, 200)?;
        valid((1..=7200).contains(&border_width), BODY)?;
        component[200..204].copy_from_slice(&actual[200..204]);
    }
    preserved(actual == component, BODY)?;

    let mut geometry = Vec::new();
    if kind == SC_RECT {
        geometry.push(0); // square corners
    }
    let half = width / 2;
    let middle = height / 2;
    let coords: &[i32] = match kind {
        SC_RECT => &[0, 0, width, 0, width, height, 0, height],
        SC_ELLIPSE => &[
            0, half, middle, width, middle, half, height, width, middle, width, middle, width,
            middle, width, middle,
        ],
        _ => &[0, 0, width, height, 0],
    };
    geometry.extend(coords.iter().flat_map(|v| v.to_le_bytes()));
    preserved(
        (leaf_tag, leaf_level, leaf) == (tag, 3, geometry.as_slice()),
        BODY,
    )?;

    if textbox {
        let (72, 3, list) = rs[2] else {
            return Err(finding(FindingCode::RecordsChanged, BODY));
        };
        preserved(
            list.len() == 33
                && dword(list, 0)? == 1
                && dword(list, 4)? == 0x20
                && list[8..16].chunks_exact(2).all(|m| m == margin)
                && dword(list, 16)? == width as usize
                && list[20..] == [0; 13],
            BODY,
        )?;
        if rs.len() == 8 {
            return super::insertions::prove_textbox_paragraph(&rs[3..7], defs, original_defs);
        }
        let [(66, 3, para), (68, 4, run), (69, 4, line)] = &rs[3..6] else {
            return Err(finding(FindingCode::RecordsChanged, BODY));
        };
        preserved(
            para.len() == 24
                && para[..8] == [1, 0, 0, 0x80, 0, 0, 0, 0]
                && para[10..] == [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]
                && run.len() == 8
                && dword(run, 0)? == 0,
            BODY,
        )?;
        reference(
            word(para, 8)? < entries(defs, 25).len() && dword(run, 4)? < entries(defs, 21).len(),
            BODY,
        )?;
        let expected = [0i32, 0, 1000, 1000, 850, 600, 0, width - 1020, 0x0006_0000];
        preserved(
            line.chunks_exact(4)
                .eq(expected.iter().map(|v| v.to_le_bytes()))
                && line.len() == 36,
            BODY,
        )?;
    }
    Ok(())
}

pub(super) fn is_basic_shape(rs: &[Record<'_>]) -> bool {
    shape_ctrl_id(rs).is_some_and(|(kind, _, _)| matches!(kind, SC_RECT | SC_ELLIPSE | SC_LINE))
}

fn picture_bin_id(rs: &[Record<'_>]) -> Option<usize> {
    let leaf = rs.last()?;
    if leaf.0 != TAG_PICTURE || leaf.2.len() < 73 {
        return None;
    }
    Some(usize::from(u16::from_le_bytes([leaf.2[71], leaf.2[72]])))
}

/// Fast structural correspondence test used to align `old.objects` and `new.objects`
/// cleanly before full field validation (`prove_evolved_gso`).
pub(super) fn evolved_candidate(
    old: &[Record<'_>],
    new: &[Record<'_>],
    orig_defs: &Defs<'_>,
) -> bool {
    if old == new || old.len() < 3 || new.len() < 3 || old[0].1 != 1 || new[0].1 != 1 {
        return false;
    }
    let (Some(old_id), Some(new_id)) = (gso_header_id(old), gso_header_id(new)) else {
        return false;
    };
    let (Some((old_ctrl, old_off, old_sc_idx)), Some((new_ctrl, new_off, new_sc_idx))) =
        (shape_ctrl_id(old), shape_ctrl_id(new))
    else {
        return false;
    };
    if old_ctrl != new_ctrl
        || old_off != new_off
        || (old_ctrl != SC_CONTAINER && expected_leaf_tag(old_ctrl).is_none())
    {
        return false;
    }
    if old_id != 0 {
        return new_id == old_id;
    }
    // Newly inserted root pictures and created containers can start with CTRL_HEADER.instance_id == 0
    // and keep id == 0 across reopened edits. Leaf shapes still require non-zero ID.
    if !matches!(old_ctrl, SC_PICTURE | SC_CONTAINER) || new_id != 0 {
        return false;
    }
    if old[old_sc_idx].2[old_off + 10..old_off + 20]
        != new[new_sc_idx].2[new_off + 10..new_off + 20]
    {
        return false;
    }
    if old_ctrl == SC_CONTAINER {
        return true;
    }
    let orig_bins = entries(orig_defs, 18).len();
    matches!(
        (picture_bin_id(old), picture_bin_id(new)),
        (Some(a), Some(b)) if a == b && a >= 1 && a <= orig_bins
    )
}

/// Prove supported geometry/property edits to drawable GSO objects owned by one
/// exact HWP header/footer control. The outer `head`/`foot` control and every
/// record outside an object subtree must remain byte-identical. Relative levels
/// are normalized only for the existing HWP GSO field proof.
pub(super) fn prove_header_story_edit(
    old: &[Record<'_>],
    new: &[Record<'_>],
    defs: &Defs<'_>,
) -> Checked<Vec<u32>> {
    fn is_owner(record: &Record<'_>) -> bool {
        record.0 == TAG_CTRL_HEADER
            && record.1 == 1
            && record
                .2
                .get(..4)
                .is_some_and(|id| id == b"daeh" || id == b"toof")
    }

    fn object_spans(records: &[Record<'_>]) -> Checked<Vec<(usize, usize)>> {
        let owner_level = records[0].1;
        let mut spans = Vec::new();
        let mut index = 1;
        while index < records.len() {
            let record = records[index];
            if record.0 == TAG_CTRL_HEADER && record.2.starts_with(CTRL_GSO) {
                preserved(record.1 >= owner_level + 2, BODY)?;
                let end = records[index + 1..]
                    .iter()
                    .position(|next| next.1 <= record.1)
                    .map_or(records.len(), |offset| index + 1 + offset);
                valid(end > index, BODY)?;
                spans.push((index, end));
                index = end;
            } else {
                index += 1;
            }
        }
        Ok(spans)
    }

    preserved(old.first().is_some_and(is_owner), BODY)?;
    preserved(new.first().is_some_and(is_owner), BODY)?;
    preserved(old.len() == new.len() && old[0] == new[0], BODY)?;
    preserved(
        old.iter().zip(new).all(|(a, b)| (a.0, a.1) == (b.0, b.1)),
        BODY,
    )?;

    let old_spans = object_spans(old)?;
    let new_spans = object_spans(new)?;
    preserved(old_spans == new_spans && !old_spans.is_empty(), BODY)?;
    // Captions are separate editable stories; preserve each subtree byte-for-byte.
    preserved(caption_subtrees(old).eq(caption_subtrees(new)), BODY)?;

    let mut changed_ids = Vec::new();
    for &(start, end) in &old_spans {
        let before = &old[start..end];
        let after = &new[start..end];
        if before == after {
            continue;
        }
        let Some((ctrl_id, _, _)) = shape_ctrl_id(before) else {
            return Err(finding(FindingCode::RecordsChanged, BODY));
        };
        if !matches!(ctrl_id, SC_PICTURE | SC_LINE | SC_RECT | SC_ELLIPSE | SC_POLYGON | SC_CURVE | SC_CONTAINER) {
            return Err(finding(FindingCode::RecordsChanged, BODY));
        }
        let Some(id) = gso_header_id(before) else {
            return Err(finding(FindingCode::OutputMalformed, BODY));
        };
        preserved(id != 0, BODY)?;
        if ctrl_id == SC_PICTURE {
            preserved(dword(before[0].2, 4)? as u32 & ATTR_CAPTION == 0, BODY)?;
            preserved(
                description_parts(before[0].2) == description_parts(after[0].2),
                BODY,
            )?;
        }
        let shift = before[0]
            .1
            .checked_sub(1)
            .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
        preserved(
            before.iter().chain(after).all(|record| record.1 >= shift),
            BODY,
        )?;
        let normalize = |(tag, level, data)| (tag, level - shift, data);
        let old_normalized: Vec<_> = before.iter().copied().map(normalize).collect();
        let new_normalized: Vec<_> = after.iter().copied().map(normalize).collect();
        if prove_evolved_gso(&old_normalized, &new_normalized, defs, defs).is_err() {
            prove_header_position_only(&old_normalized, &new_normalized)?;
        }
        changed_ids.push(id);
    }
    preserved(!changed_ids.is_empty(), BODY)?;

    let mut in_objects = vec![false; old.len()];
    for &(start, end) in &old_spans {
        in_objects[start..end].fill(true);
    }
    for (index, (before, after)) in old.iter().zip(new).enumerate() {
        if !in_objects[index] {
            preserved(before == after, BODY)?;
        }
    }
    Ok(changed_ids)
}

/// A header/footer object may contain a complex TextBox story that the general
/// GSO editor intentionally does not interpret. A pure move is still safe when
/// its exact owner and object ID are established and every record except the
/// two signed position fields is byte-identical. This fallback does not admit
/// resizing, styling, path edits, child edits, or any story-content changes.
fn prove_header_position_only(old: &[Record<'_>], new: &[Record<'_>]) -> Checked<()> {
    let reject = || finding(FindingCode::RecordsChanged, BODY);
    valid(!old.is_empty() && old.len() == new.len(), BODY)?;
    let (Some((old_kind, _, old_sc)), Some((new_kind, _, new_sc))) =
        (shape_ctrl_id(old), shape_ctrl_id(new))
    else {
        return Err(reject());
    };
    preserved(
        old[0].0 == TAG_CTRL_HEADER
            && old[0].1 == 1
            && new[0].0 == TAG_CTRL_HEADER
            && new[0].1 == 1
            && old_kind == new_kind
            && matches!(old_kind, SC_LINE | SC_RECT | SC_ELLIPSE | SC_POLYGON | SC_CURVE | SC_CONTAINER)
            && old_sc == new_sc
            && old[1..] == new[1..],
        BODY,
    )?;
    let (Some(old_id), Some(new_id)) = (gso_header_id(old), gso_header_id(new)) else {
        return Err(reject());
    };
    preserved(old_id != 0 && old_id == new_id, BODY)?;

    let before = old[0].2;
    let after = new[0].2;
    preserved(
        before.len() == after.len()
            && before.len() >= 44
            && before[..8] == after[..8]
            && before[16..] == after[16..]
            && before[8..16] != after[8..16]
            && dword(before, 4)? as u32 & ATTR_LOCKED == 0,
        BODY,
    )?;
    for bytes in [before, after] {
        for offset in [8, 12] {
            let value = i32::from_le_bytes(
                bytes[offset..offset + 4]
                    .try_into()
                    .map_err(|_| finding(FindingCode::OutputMalformed, BODY))?,
            );
            valid((-MAX_OFFSET_HU..=MAX_OFFSET_HU).contains(&value), BODY)?;
        }
    }
    Ok(())
}

/// Rank and wrapping plane for a bare floating body shape. Reordering is
/// never routed through the broader field evolution or deletion proofs.
pub(super) fn shape_layer(rs: &[Record<'_>]) -> Option<(i32, u32)> {
    let (kind, offset, 1) = shape_ctrl_id(rs)? else { return None };
    let [header, component, leaf] = rs else { return None };
    let attr = dword(header.2, 4).ok()? as u32;
    if !matches!(kind, SC_RECT | SC_ELLIPSE | SC_LINE | SC_POLYGON | SC_CURVE)
        || gso_header_id(rs)? == 0
        || (header.1, component.1, leaf.1) != (1, 2, 3)
        || expected_leaf_tag(kind)? != leaf.0
        || word(component.2, offset + 8).ok()? != 0
        || attr & (ATTR_LOCKED | ATTR_CAPTION | 1) != 0
    {
        return None;
    }
    let rank = super::insertions::signed_dword(header.2, 24).ok()?;
    let wrap = (attr >> 21) & 7;
    ((-1_000_000..=1_000_000).contains(&rank) && wrap <= 3).then_some((rank, wrap))
}

pub(super) fn shape_layer_changed(old: &[Record<'_>], new: &[Record<'_>]) -> bool {
    old.first().zip(new.first()).is_some_and(|(a, b)| {
        a.2.starts_with(CTRL_GSO) && b.2.starts_with(CTRL_GSO)
            && gso_header_id(old).is_some_and(|id| id != 0 && Some(id) == gso_header_id(new))
            && a.2.get(24..28) != b.2.get(24..28)
    })
}

pub(super) fn prove_shape_layers(
    old_objects: &[Vec<Record<'_>>],
    new_objects: &[Vec<Record<'_>>],
) -> Checked<()> {
    preserved(old_objects.len() == new_objects.len(), BODY)?;
    let mut old_ranks = Vec::new();
    let mut new_ranks = Vec::new();
    let mut plane: Option<u32> = None;
    let mut changed = 0usize;
    for (old, new) in old_objects.iter().zip(new_objects.iter()) {
        if !old.first().is_some_and(|r| r.2.starts_with(CTRL_GSO)) {
            preserved(old == new, BODY)?;
            continue;
        }
        let (Some((before, wrap)), Some((after, new_wrap))) =
            (shape_layer(old), shape_layer(new))
        else {
            return Err(finding(FindingCode::RecordsChanged, BODY));
        };
        let expected_wrap = *plane.get_or_insert(wrap);
        preserved(
            wrap == expected_wrap
                && new_wrap == expected_wrap
                && old[0].2[..24] == new[0].2[..24]
                && old[0].2[28..] == new[0].2[28..]
                && old[1..] == new[1..],
            BODY,
        )?;
        if before != after {
            changed += 1;
        }
        old_ranks.push(before);
        new_ranks.push(after);
    }
    let n = old_ranks.len();
    let distinct_old: std::collections::BTreeSet<_> = old_ranks.iter().copied().collect();
    let distinct_new: std::collections::BTreeSet<_> = new_ranks.iter().copied().collect();
    preserved(
        n >= 2 && changed >= 1 && distinct_old.len() == n && distinct_new.len() == n,
        BODY,
    )?;
    let low = *distinct_old.first().unwrap();
    let high = *distinct_old.last().unwrap();
    if n == 2 && changed == 1 {
        let (before, after) = old_ranks
            .iter()
            .zip(&new_ranks)
            .find(|(a, b)| a != b)
            .map(|(&a, &b)| (a, b))
            .unwrap();
        return preserved(
            (before != high && after == high + 1) || (before != low && after == low - 1),
            BODY,
        );
    }
    // Multi-edit z-order shifts in one save remain strictly bounded around [low, high].
    let max_steps = (n as i32).saturating_mul(8).min(256);
    preserved(
        old_ranks.iter().zip(&new_ranks).all(|(&before, &after)| {
            before == after
                || (after >= low.saturating_sub(max_steps)
                    && after <= high.saturating_add(max_steps))
        }),
        BODY,
    )
}

/// A directly owned cell picture (at depth 1 or inside nested tables) only exposes width
/// and height. The table proof fixes its cell, paragraph and control position before calling this.
pub(super) fn prove_cell_picture_resize(
    old: &[Record<'_>; 3],
    new: &[Record<'_>; 3],
    defs: &Defs<'_>,
) -> Checked<()> {
    let [(71, pic_level, old_header), (76, comp_level, component), (85, leaf_level, leaf)] = *old
    else {
        return Err(finding(FindingCode::RecordsChanged, BODY));
    };
    let [(71, new_pic_level, new_header), (76, new_comp_level, _), (85, new_leaf_level, new_leaf)] =
        *new
    else {
        return Err(finding(FindingCode::RecordsChanged, BODY));
    };
    preserved(
        pic_level >= 3
            && pic_level <= 131
            && pic_level % 2 == 1
            && comp_level == pic_level + 1
            && leaf_level == pic_level + 2
            && new_pic_level == pic_level
            && new_comp_level == comp_level
            && new_leaf_level == leaf_level,
        BODY,
    )?;
    let Some((SC_PICTURE, id_offset, 1)) = shape_ctrl_id(old) else {
        return Err(finding(FindingCode::RecordsChanged, BODY));
    };
    let attr = dword(old_header, 4)? as u32;
    preserved(
        gso_header_id(old).is_some_and(|id| id != 0)
            && attr & (ATTR_LOCKED | ATTR_SIZE_PROTECT | ATTR_CAPTION | FLOW_WITH_TEXT | 1) == 1
            && old_header.get(8..16) == Some(&[0; 8])
            && old_header.get(..16) == new_header.get(..16)
            && old_header.get(24..) == new_header.get(24..)
            && old_header.get(16..24) != new_header.get(16..24)
            && dword(component, id_offset + 28)? & 3 == 0
            && word(component, id_offset + 32)? == 0
            && leaf == new_leaf,
        BODY,
    )?;
    // Reuse the existing GSO field proof at relative body levels, after
    // checking the concrete serialized cell record levels above.
    let shift = pic_level - 1;
    let normalize = |(tag, level, data)| (tag, level - shift, data);
    prove_evolved_gso(&old.map(normalize), &new.map(normalize), defs, defs)
}

/// Validated HWP5 `SHAPE_COMPONENT` rendering-matrix end offset (`r_at + 2 + (1 + 2 * cnt) * 48`).
fn shape_rendering_end(sc: &[u8], id_off: usize) -> Option<usize> {
    let r_at = id_off.checked_add(42)?;
    let cnt = word(sc, r_at).ok()?;
    let r_len = 2usize.checked_add(1usize.checked_add(2 * cnt)?.checked_mul(48)?)?;
    let r_end = r_at.checked_add(r_len)?;
    (sc.len() >= r_end).then_some(r_end)
}

/// Validates a plain, control-free TextBox subtree after `LIST_HEADER` at `base_lvl`.
/// Both HWP5 sibling paragraphs (`para_lvl = base_lvl`, e.g. RHWP/Hancom) and nested-child
/// representations (`para_lvl = base_lvl + 1`) are accepted as long as every record in `mid`
/// keeps a single consistent paragraph level and carries no controls (`71`) or opaque tags.
fn plain_textbox_records(mid: &[Record<'_>], base_lvl: u16) -> bool {
    if mid.len() < 2 || mid[0].0 != TAG_LIST_HEADER || mid[0].1 != base_lvl || mid[1].0 != 66 {
        return false;
    }
    let para_lvl = mid[1].1;
    if para_lvl != base_lvl && para_lvl != base_lvl + 1 {
        return false;
    }
    mid[1..].iter().all(|r| {
        ((r.0 == 66 && r.1 == para_lvl) || (matches!(r.0, 67..=70) && r.1 == para_lvl + 1))
            && (r.0 != 70 || r.2.is_empty())
    })
}

/// Validates a flat, unlocked, uncaptioned HWP5 `SC_CONTAINER` child list for safe deletion:
/// no nested containers (`noc$`), no OLE/Chart/Arc/unknown children, no `CTRL_HEADER`,
/// optional plain level-4 TextBox, valid leaf shape/picture tags, and valid `BinData` IDs.
fn deletable_flat_group(old: &[Record<'_>], id_off: usize, orig_defs: &Defs<'_>) -> bool {
    let sc = old[1].2;
    let Some(r_end) = shape_rendering_end(sc, id_off) else {
        return false;
    };
    let Ok(child_count) = word(sc, r_end) else {
        return false;
    };
    let Some(expected_tail) = child_count.checked_mul(4).and_then(|n| n.checked_add(6)) else {
        return false;
    };
    if child_count == 0 || sc.len() != r_end + expected_tail {
        return false;
    }
    let body = &old[2..];
    if body.is_empty()
        || body[0].0 != TAG_SHAPE_COMPONENT
        || body[0].1 != 3
        || body.iter().any(|r| {
            r.1 < 3
                || !matches!(r.0, 66..=85)
                || r.0 == TAG_CTRL_HEADER
                || r.0 == 70
                || r.0 == 81
                || r.0 == 84
        })
    {
        return false;
    }
    let mut starts: Vec<usize> = body
        .iter()
        .enumerate()
        .filter_map(|(i, r)| (r.0 == TAG_SHAPE_COMPONENT && r.1 == 3).then_some(i))
        .collect();
    if starts.len() != child_count {
        return false;
    }
    starts.push(body.len());
    let orig_bins = entries(orig_defs, 18).len();
    for (idx, w) in starts.windows(2).enumerate() {
        let child = &body[w[0]..w[1]];
        if child.len() < 2 {
            return false;
        }
        let child_sc = child[0].2;
        if child_sc.len() < 48 {
            return false;
        }
        let two = child_sc.len() >= 8 && child_sc[4..8] == child_sc[..4];
        let child_id_off = if two { 8 } else { 4 };
        if child_sc.len() < child_id_off + 44 {
            return false;
        }
        let expected_id = &sc[r_end + 2 + idx * 4..r_end + 6 + idx * 4];
        if &child_sc[..4] != expected_id
            || word(child_sc, child_id_off + 8)
                .ok()
                .is_none_or(|gl| gl < 1)
        {
            return false;
        }
        let Ok(child_ctrl): Result<&[u8; 4], _> = child_sc[..4].try_into() else {
            return false;
        };
        let Some(leaf_tag) = expected_leaf_tag(child_ctrl) else {
            return false;
        };
        if child_ctrl == SC_PICTURE {
            if child.len() != 2
                || child[1].0 != TAG_PICTURE
                || child[1].1 != 4
                || child[1].2.len() < 73
                || word(child[1].2, 71)
                    .ok()
                    .is_none_or(|id| id == 0 || id > orig_bins)
            {
                return false;
            }
        } else {
            let last = child[child.len() - 1];
            if last.0 != leaf_tag || last.1 != 4 {
                return false;
            }
            let mid = &child[1..child.len() - 1];
            if !mid.is_empty() && !plain_textbox_records(mid, 4) {
                return false;
            }
        }
    }
    true
}

/// Only top-level, unlocked, opaque-free HWP5 GSO pictures (`b"cip$"`) and basic shapes
/// (`b"nil$"`, `b"cer$"`, `b"lle$"`, `b"lop$"`, `b"ruc$"`) — optionally with a
/// plain TextBox (when uncaptioned) or a proven plain caption (`1..=64` paragraphs, at most one
/// `atno`), plus flat uncaptioned `SC_CONTAINER` (`b"noc$"`) leaf groups — may be deleted.
/// Locked objects, TextBox+caption, nested/captioned/OLE/Chart groups,
/// nested/unknown controls, and opaque records (`CTRL_DATA`, range tags) remain strictly preserved.
pub(super) fn deletable_gso(old: &[Record<'_>], orig_defs: &Defs<'_>) -> bool {
    if old.len() < 3 || old[0].1 != 1 {
        return false;
    }
    let Some(first) = old.first() else {
        return false;
    };
    if first.0 != TAG_CTRL_HEADER || !first.2.starts_with(CTRL_GSO) || first.2.len() < 46 {
        return false;
    }
    let Ok(attr) = dword(first.2, 4).map(|v| v as u32) else {
        return false;
    };
    if (attr & ATTR_LOCKED) != 0 {
        return false;
    }
    let has_caption = (attr & ATTR_CAPTION) != 0;
    let Some((ctrl_id, id_off, sc_idx)) = shape_ctrl_id(old) else {
        return false;
    };
    if word(old[sc_idx].2, id_off + 8) != Ok(0) {
        return false;
    }
    if ctrl_id == SC_CONTAINER {
        return !has_caption && sc_idx == 1 && deletable_flat_group(old, id_off, orig_defs);
    }
    let Some(leaf_tag) = expected_leaf_tag(ctrl_id) else {
        return false;
    };
    if has_caption {
        if sc_idx < 3
            || old[1].0 != TAG_LIST_HEADER
            || old[1].1 != 2
            || old[1].2.len() != 30
            || old[2].0 != 66
            || old[2].1 != 2
        {
            return false;
        }
        let Ok(cap_count) = word(old[1].2, 0) else {
            return false;
        };
        if !(1..=64).contains(&cap_count)
            || super::insertions::prove_caption_paragraphs(
                &old[2..sc_idx],
                &old[2..sc_idx],
                cap_count,
                cap_count,
                orig_defs,
                orig_defs,
            )
            .is_err()
        {
            return false;
        }
    } else if sc_idx != 1 {
        return false;
    }
    if old[sc_idx..]
        .iter()
        .any(|r| !matches!(r.0, 66..=85) || (r.0 == 70 && !r.2.is_empty()))
    {
        return false;
    }
    if ctrl_id == SC_PICTURE {
        if old.len() != sc_idx + 2
            || old[sc_idx + 1].0 != TAG_PICTURE
            || old[sc_idx + 1].1 != 3
            || old[sc_idx + 1].2.len() < 73
        {
            return false;
        }
        let orig_bins = entries(orig_defs, 18).len();
        return picture_bin_id(old).is_some_and(|bin_id| bin_id >= 1 && bin_id <= orig_bins);
    }
    let last = old[old.len() - 1];
    if last.0 != leaf_tag || last.1 != 3 {
        return false;
    }
    let mid = &old[sc_idx + 1..old.len() - 1];
    if mid.is_empty() {
        return true;
    }
    if has_caption {
        return false;
    }
    plain_textbox_records(mid, 3)
}

/// Validates that `dst` is a faithful same-document RHWP clone (`copyControl` + `pasteControl`)
/// of an unlocked, opaque-free modeled `src` GSO from `old_objects`, preserving all geometry,
/// attributes, resources (`BinData`), captions, TextBox paragraphs, and group children while
/// assigning fresh unique IDs, valid z-order, and bounded cascade offsets.
pub(super) fn prove_cloned_gso(
    src: &[Record<'_>],
    dst: &[Record<'_>],
    orig_defs: &Defs<'_>,
    original_ids: &std::collections::BTreeSet<usize>,
) -> bool {
    if !deletable_gso(src, orig_defs) || dst.len() != src.len() || dst.len() < 3 || dst[0].1 != 1 {
        return false;
    }
    let Some((ctrl_id, _, sc_idx)) = shape_ctrl_id(src) else {
        return false;
    };
    if shape_ctrl_id(dst).map(|(c, _, i)| (c, i)) != Some((ctrl_id, sc_idx)) {
        return false;
    }
    let (sh, dh) = (src[0].2, dst[0].2);
    if dst[0].0 != TAG_CTRL_HEADER
        || dh.len() != sh.len()
        || sh.len() < 46
        || sh[..8] != dh[..8]
        || sh[16..24] != dh[16..24]
        || sh[28..36] != dh[28..36]
        || sh[40..] != dh[40..]
    {
        return false;
    }
    let (Ok(attr), Ok(sv), Ok(sh_off), Ok(dv), Ok(dh_off), Ok(dz), Ok(dst_id)) = (
        dword(dh, 4),
        super::insertions::signed_dword(sh, 8),
        super::insertions::signed_dword(sh, 12),
        super::insertions::signed_dword(dh, 8),
        super::insertions::signed_dword(dh, 12),
        super::insertions::signed_dword(dh, 24),
        dword(dh, 36),
    ) else {
        return false;
    };
    let delta_v = dv.checked_sub(sv);
    let delta_h = dh_off.checked_sub(sh_off);
    let inline = (attr as u32 & 1) != 0;
    if dst_id == 0
        || original_ids.contains(&dst_id)
        || !(-1_000_000..=1_000_000).contains(&dz)
        || !(-MAX_OFFSET_HU..=MAX_OFFSET_HU).contains(&dv)
        || !(-MAX_OFFSET_HU..=MAX_OFFSET_HU).contains(&dh_off)
        || delta_v.is_none()
        || delta_v != delta_h
        || if inline {
            delta_v != Some(0)
        } else {
            delta_v.is_none_or(|d| !(0..=64 * 1417).contains(&d))
        }
    {
        return false;
    }

    let para_eq_except_inst = |a: &Record<'_>, b: &Record<'_>| {
        a.0 == 66
            && b.0 == 66
            && a.1 == b.1
            && a.2.len() == b.2.len()
            && a.2.len() >= 22
            && a.2[..18] == b.2[..18]
            && a.2[22..] == b.2[22..]
    };

    // Caption subtree (`1..sc_idx`): LIST_HEADER must match byte-for-byte; PARA_HEADER may remap `instance_id`.
    if sc_idx > 1 {
        if dst[1] != src[1] {
            return false;
        }
        if !src[2..sc_idx]
            .iter()
            .zip(&dst[2..sc_idx])
            .all(|(a, b)| a == b || para_eq_except_inst(a, b))
        {
            return false;
        }
    }

    // Outer `SHAPE_COMPONENT` (`sc_idx`).
    let (osc, nsc) = (src[sc_idx], dst[sc_idx]);
    if osc.0 != nsc.0 || osc.1 != nsc.1 || osc.2.len() != nsc.2.len() {
        return false;
    }
    if ctrl_id == SC_CONTAINER {
        if osc.2.len() < 4 || osc.2[..osc.2.len() - 4] != nsc.2[..nsc.2.len() - 4] {
            return false;
        }
    } else if ctrl_id == SC_PICTURE {
        if osc != nsc {
            return false;
        }
    } else if osc.2.len() < 22
        || osc.2[..osc.2.len() - 6] != nsc.2[..nsc.2.len() - 6]
        || osc.2[osc.2.len() - 2..] != nsc.2[nsc.2.len() - 2..]
    {
        return false;
    }

    // Subtree after `SHAPE_COMPONENT` (`TAG_PICTURE`, shape leaf, TextBox, or flat container children).
    src[sc_idx + 1..].iter().zip(&dst[sc_idx + 1..]).all(|(a, b)| {
        if a == b {
            return true;
        }
        if a.0 != b.0 || a.1 != b.1 || a.2.len() != b.2.len() {
            return false;
        }
        match a.0 {
            TAG_PICTURE if a.2.len() >= 78 => a.2[..74] == b.2[..74] && a.2[78..] == b.2[78..],
            TAG_SHAPE_COMPONENT if a.1 == 3 => {
                if a.2.starts_with(SC_PICTURE) {
                    false
                } else {
                    a.2.len() >= 22
                        && a.2[..a.2.len() - 6] == b.2[..b.2.len() - 6]
                        && a.2[a.2.len() - 2..] == b.2[b.2.len() - 2..]
                }
            }
            66 => para_eq_except_inst(a, b),
            _ => false,
        }
    })
}

pub(super) fn prove_cloned_gso_from(
    sources: &[Vec<Record<'_>>],
    dst: &[Record<'_>],
    orig_defs: &Defs<'_>,
    original_ids: &std::collections::BTreeSet<usize>,
) -> bool {
    sources
        .iter()
        .any(|src| prove_cloned_gso(src, dst, orig_defs, original_ids))
}

fn parse_rendering_matrices(bytes: &[u8]) -> Option<[[f64; 6]; 3]> {
    if bytes.len() != 146 || u16::from_le_bytes(bytes[..2].try_into().ok()?) != 1 {
        return None;
    }
    let mut matrices = [[0.0f64; 6]; 3];
    for (m_idx, matrix) in matrices.iter_mut().enumerate() {
        for (k, slot) in matrix.iter_mut().enumerate() {
            let at = 2 + (m_idx * 6 + k) * 8;
            let val = f64::from_le_bytes(bytes[at..at + 8].try_into().ok()?);
            if !val.is_finite() {
                return None;
            }
            *slot = val;
        }
    }
    Some(matrices)
}

/// Match the HWP parser's T × R × S model and RHWP's generated matrices.
fn matches_rotated_rendering(
    raw: &[u8],
    offset: [f64; 2],
    angle: i16,
    original: [usize; 2],
    current: [usize; 2],
) -> bool {
    let Some([translation, scale, rotation]) = parse_rendering_matrices(raw) else {
        return false;
    };
    let [x, y] = offset;
    let [w, h] = current.map(|dim| dim as f64);
    let theta = f64::from(angle).to_radians();
    let (cos, sin) = (theta.cos(), theta.sin());
    let tx = -(w * cos).min(0.0) - (-h * sin).min(0.0);
    let ty = -(w * sin).min(0.0) - (h * cos).min(0.0);
    let scale_matches = |actual: f64, expected: f64| {
        (actual - expected).abs() <= 8.0 * f64::EPSILON * expected
    };
    let position_tol = 16.0 * f64::EPSILON * (w + h + x.abs() + y.abs());
    translation == [1.0, 0.0, x, 0.0, 1.0, y]
        && scale[1] == 0.0
        && scale[2] == 0.0
        && scale[3] == 0.0
        && scale[5] == 0.0
        && scale_matches(scale[0], w / original[0] as f64)
        && scale_matches(scale[4], h / original[1] as f64)
        && (rotation[0] - cos).abs() <= 1e-12
        && (rotation[1] + sin).abs() <= 1e-12
        && (rotation[3] - sin).abs() <= 1e-12
        && (rotation[4] - cos).abs() <= 1e-12
        && (rotation[2] - (tx - x)).abs() <= position_tol
        && (rotation[5] - (ty - y)).abs() <= position_tol
}

/// A second authentic nonrotated HWP5 representation scales around the object
/// origin: T(offset) × S(current/original, -offset) × I. RHWP parses this as
/// `current_*` geometry and emits the canonical translation form after edits.
fn matches_scaled_source_rendering(
    raw: &[u8],
    offset: [i32; 2],
    original: [usize; 2],
    current: [usize; 2],
) -> bool {
    let Some([translation, scale, rotation]) = parse_rendering_matrices(raw) else {
        return false;
    };
    if original.into_iter().chain(current).any(|dim| dim == 0) {
        return false;
    }
    let [x, y] = offset.map(f64::from);
    let close = |actual: f64, expected: f64| {
        (actual - expected).abs() <= 8.0 * f64::EPSILON * (1.0 + expected.abs())
    };
    translation == [1.0, 0.0, x, 0.0, 1.0, y]
        && close(scale[0], current[0] as f64 / original[0] as f64)
        && scale[1] == 0.0
        && close(scale[2], -x)
        && scale[3] == 0.0
        && close(scale[4], current[1] as f64 / original[1] as f64)
        && close(scale[5], -y)
        && rotation == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
}

fn compose_affine(a: [f64; 6], b: [f64; 6]) -> [f64; 6] {
    [
        a[0] * b[0] + a[1] * b[3],
        a[0] * b[1] + a[1] * b[4],
        a[0] * b[2] + a[1] * b[5] + a[2],
        a[3] * b[0] + a[4] * b[3],
        a[3] * b[1] + a[4] * b[4],
        a[3] * b[2] + a[4] * b[5] + a[5],
    ]
}

fn eval_rendering_affine(bytes: &[u8]) -> Option<[f64; 6]> {
    if bytes.len() < 50 {
        return None;
    }
    let cnt = usize::from(u16::from_le_bytes(bytes[..2].try_into().ok()?));
    if bytes.len() != 2 + (1 + 2 * cnt) * 48 {
        return None;
    }
    let read_m = |at: usize| -> Option<[f64; 6]> {
        let mut m = [0.0f64; 6];
        for k in 0..6 {
            let v = f64::from_le_bytes(bytes[at + k * 8..at + k * 8 + 8].try_into().ok()?);
            if !v.is_finite() {
                return None;
            }
            m[k] = v;
        }
        Some(m)
    };
    let mut acc = read_m(2)?;
    for idx in 0..cnt {
        let base = 2 + (1 + 2 * idx) * 48;
        let scale = read_m(base)?;
        let rot = read_m(base + 48)?;
        acc = compose_affine(acc, rot);
        acc = compose_affine(acc, scale);
    }
    Some(acc)
}

fn validate_rendering_info(
    old_r: &[u8],
    new_r: &[u8],
    picture_transform_changed: bool,
    is_container: bool,
    component_offset: [i32; 2],
    rotated_pic: Option<(i16, [usize; 2], [usize; 2], [usize; 2])>,
    scaled_source_picture: bool,
) -> Checked<()> {
    if is_container {
        if old_r == new_r {
            return Ok(());
        }
        // RHWP clears container `raw_rendering` on outer transform edits and writes
        // a 1-pair affine factorization (`[1,0,tx;0,1,ty] * I * [sx,b,0;c,sy,0]`).
        let Some(old_m) = eval_rendering_affine(old_r) else {
            return Err(finding(FindingCode::OutputMalformed, BODY));
        };
        let Some([_, scale, rot]) = parse_rendering_matrices(new_r) else {
            return Err(finding(FindingCode::OutputMalformed, BODY));
        };
        let Some(new_m) = eval_rendering_affine(new_r) else {
            return Err(finding(FindingCode::OutputMalformed, BODY));
        };
        let identity = [1., 0., 0., 0., 1., 0.];
        let approx = |a: f64, b: f64| (a - b).abs() <= 1e-9 * (1.0 + a.abs() + b.abs());
        return preserved(
            rot == identity
                && approx(scale[2], 0.0)
                && approx(scale[5], 0.0)
                && old_m.into_iter().zip(new_m).all(|(a, b)| approx(a, b)),
            BODY,
        );
    }
    if !picture_transform_changed {
        return preserved(old_r == new_r, BODY);
    }
    let [x, y] = component_offset.map(f64::from);
    if let Some((angle, orig_dims, old_cur_dims, new_cur_dims)) = rotated_pic {
        preserved(
            orig_dims.into_iter().chain(old_cur_dims).all(|dim| dim > 0)
                && matches_rotated_rendering(old_r, [x, y], angle, orig_dims, old_cur_dims),
            BODY,
        )?;
        return valid(
            new_cur_dims.into_iter().all(|dim| dim > 0)
                && matches_rotated_rendering(new_r, [x, y], angle, orig_dims, new_cur_dims),
            BODY,
        );
    }
    if old_r == new_r {
        return Ok(());
    }

    // For supported nonrotating picture edits, RHWP clears raw_rendering and resets
    // render_tx/ty to the component offsets and render_sx/sy to 1. Its HWP5 writer
    // emits translation, scale, rotation (in that order). Size lives in the component
    // dimensions, so a second scale would duplicate the resize.
    valid(new_r.len() == 146 && word(new_r, 0)? == 1, BODY)?;
    let identity = [1., 0., 0., 0., 1., 0.];
    let translation = [1., 0., x, 0., 1., y];
    let matches = |bytes: &[u8], first: [f64; 6]| {
        bytes.starts_with(&1u16.to_le_bytes())
            && bytes.len() == 146
            && bytes[2..]
                .chunks_exact(8)
                .zip([first, identity, identity].into_iter().flatten())
                .all(|(actual, expected)| actual == expected.to_le_bytes())
    };
    // The writer also has an identity fallback. Admit replacement only where
    // the source is one of these two known representations.
    preserved(
        matches(old_r, identity) || matches(old_r, translation) || scaled_source_picture,
        BODY,
    )?;
    preserved(matches(new_r, translation), BODY)
}

fn check_ctrl_header(
    old_h: &[u8],
    new_h: &[u8],
    is_picture: bool,
) -> Checked<(usize, usize, usize, usize, bool, bool)> {
    valid(old_h.len() >= 44 && new_h.len() >= 44, BODY)?;
    preserved(old_h[..4] == *CTRL_GSO && new_h[..4] == *CTRL_GSO, BODY)?;
    preserved(old_h[36..40] == new_h[36..40], BODY)?; // instance_id
    preserved(old_h[24..36] == new_h[24..36], BODY)?; // z_order + margins
    preserved(old_h[40..44] == new_h[40..44], BODY)?; // prevent_page_break
    let (old_description, old_extra) = description_parts(old_h)
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    let (new_description, new_extra) = description_parts(new_h)
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;

    let old_attr = dword(old_h, 4)? as u32;
    let new_attr = dword(new_h, 4)? as u32;
    preserved((old_attr & ATTR_LOCKED) == 0, BODY)?;
    let alignment_changed = (old_attr ^ new_attr) & ALIGN_ATTR_MASK != 0;
    if alignment_changed {
        const RELATIVE_ATTR_MASK: u32 = (3 << 3) | (3 << 8);
        const PLACEMENT_MASK: u32 = ALIGN_ATTR_MASK | RELATIVE_ATTR_MASK;
        const NONPRESET_FLAGS: u32 = ATTR_CAPTION | ATTR_SIZE_PROTECT | FLOW_WITH_TEXT | 1 | (7 << 21);
        preserved(
            is_picture
                && old_attr & NONPRESET_FLAGS == 0
                && (old_attr ^ new_attr) & !PLACEMENT_MASK == 0
                && new_attr & RELATIVE_ATTR_MASK == (1 << 3) | (1 << 8)
                && (new_attr >> 5) & 7 <= 2
                && (new_attr >> 10) & 7 <= 2
                && new_h[8..16] == [0; 8]
                && old_h[16..24] == new_h[16..24]
                && old_h[28..36] == [0; 8]
                && old_description == new_description
                && old_extra == new_extra,
            BODY,
        )?;
    } else {
        preserved((old_attr ^ new_attr) & !MUTABLE_ATTR_MASK == 0, BODY)?;
    }
    let has_caption = (old_attr & ATTR_CAPTION) != 0;
    if new_attr != old_attr {
        let vert_rel_to = (new_attr >> 3) & 0x03;
        let text_wrap = (new_attr >> 21) & 0x07;
        valid(vert_rel_to <= 2 && text_wrap <= 3, BODY)?;
    }

    let old_v = i32::from_le_bytes(old_h[8..12].try_into().unwrap());
    let old_x = i32::from_le_bytes(old_h[12..16].try_into().unwrap());
    let new_v = i32::from_le_bytes(new_h[8..12].try_into().unwrap());
    let new_x = i32::from_le_bytes(new_h[12..16].try_into().unwrap());
    preserved(
        new_v == old_v || (-MAX_OFFSET_HU..=MAX_OFFSET_HU).contains(&new_v),
        BODY,
    )?;
    preserved(
        new_x == old_x || (-MAX_OFFSET_HU..=MAX_OFFSET_HU).contains(&new_x),
        BODY,
    )?;

    let old_w = dword(old_h, 16)?;
    let old_h_dim = dword(old_h, 20)?;
    let new_w = dword(new_h, 16)?;
    let new_h_dim = dword(new_h, 20)?;
    if (old_attr & ATTR_SIZE_PROTECT) != 0 {
        preserved(new_w == old_w && new_h_dim == old_h_dim, BODY)?;
    } else {
        valid(new_w == old_w || (1..=MAX_DIM_HU).contains(&new_w), BODY)?;
        valid(
            new_h_dim == old_h_dim || (1..=MAX_DIM_HU).contains(&new_h_dim),
            BODY,
        )?;
    }

    let desc_changed = old_description != new_description;
    if desc_changed {
        preserved(
            is_picture
                && new_description.len().is_multiple_of(2)
                && new_description.len() / 2 <= MAX_DESC_UNITS,
            BODY,
        )?;
        let units: Vec<u16> = new_description
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        valid(String::from_utf16(&units).is_ok(), BODY)?;
    }
    // Preserve any trailing raw_extra bytes verbatim.
    preserved(old_extra == new_extra, BODY)?;
    Ok((
        old_w,
        old_h_dim,
        new_w,
        new_h_dim,
        new_w != old_w || new_h_dim != old_h_dim,
        has_caption,
    ))
}

fn check_fill(old_fill: &[u8], new_fill: &[u8]) -> Checked<()> {
    let old_type = dword(old_fill, 0)?;
    if !matches!(old_type, 0 | 1) {
        return preserved(old_fill == new_fill, BODY);
    }
    if old_type == 0 {
        valid(old_fill == [0u8; 8], BODY)?;
    } else {
        valid(old_fill.len() == 21 && dword(old_fill, 16)? == 0, BODY)?;
    }
    let new_type = dword(new_fill, 0)?;
    match new_type {
        0 => {
            preserved(new_fill == [0u8; 8], BODY)?;
            Ok(())
        }
        1 => {
            valid(new_fill.len() == 21 && dword(new_fill, 16)? == 0, BODY)?;
            valid(new_fill[7] == 0, BODY)?; // RGBX COLORREF high byte is zero
            if old_type == 1 {
                preserved(
                    old_fill[8..16] == new_fill[8..16] && old_fill[20] == new_fill[20],
                    BODY,
                )?;
            } else {
                // None -> Solid uses canonical pattern_color=0, pattern_type=-1, alpha=0.
                preserved(
                    new_fill[8..12] == [0; 4]
                        && new_fill[12..16] == (-1i32).to_le_bytes()
                        && new_fill[20] == 0,
                    BODY,
                )?;
            }
            Ok(())
        }
        _ => Err(finding(FindingCode::RecordsChanged, BODY)),
    }
}

#[derive(Clone, Copy)]
struct Hwp5GroupChildComponent {
    ctrl_id: [u8; 4],
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    inst_id: u32,
    fill_start: usize,
    tail_start: usize,
    solid_fill: bool,
}

fn read_hwp5_matrix(bytes: &[u8]) -> Option<[f64; 6]> {
    if bytes.len() != 48 {
        return None;
    }
    let mut matrix = [0.0; 6];
    for (value, chunk) in matrix.iter_mut().zip(bytes.chunks_exact(8)) {
        *value = f64::from_le_bytes(chunk.try_into().ok()?);
        if !value.is_finite() {
            return None;
        }
    }
    Some(matrix)
}

fn hwp5_identity_matrix(matrix: &[f64; 6], tx: f64, ty: f64) -> bool {
    matrix == &[1.0, 0.0, tx, 0.0, 1.0, ty]
}

fn hwp5_identity_rendering(bytes: &[u8], expected_count: usize, tx: f64, ty: f64) -> bool {
    if bytes.len() != 2 + 48 + expected_count * 96
        || u16::from_le_bytes([bytes[0], bytes[1]]) as usize != expected_count
    {
        return false;
    }
    let Some(translation) = read_hwp5_matrix(&bytes[2..50]) else {
        return false;
    };
    if !hwp5_identity_matrix(&translation, tx, ty) {
        return false;
    }
    bytes[50..].chunks_exact(48).all(|raw| {
        read_hwp5_matrix(raw).is_some_and(|matrix| hwp5_identity_matrix(&matrix, 0.0, 0.0))
    })
}

fn parse_hwp5_group_child_component(
    sc: &[u8],
    parent_width: usize,
    parent_height: usize,
) -> Option<Hwp5GroupChildComponent> {
    let ctrl_id: [u8; 4] = sc.get(..4)?.try_into().ok()?;
    if ctrl_id != *SC_RECT && ctrl_id != *SC_ELLIPSE {
        return None;
    }
    if sc.len() < 46 + 242 {
        return None;
    }
    let read_u16 = |at: usize| Some(u16::from_le_bytes(sc.get(at..at + 2)?.try_into().ok()?));
    let read_u32 = |at: usize| Some(u32::from_le_bytes(sc.get(at..at + 4)?.try_into().ok()?));
    let read_i32 = |at: usize| Some(i32::from_le_bytes(sc.get(at..at + 4)?.try_into().ok()?));
    let x = read_i32(4)?;
    let y = read_i32(8)?;
    let original_width = read_u32(16)?;
    let original_height = read_u32(20)?;
    let current_width = read_u32(24)?;
    let current_height = read_u32(28)?;
    let flip = read_u32(32)?;
    let rotation = i16::from_le_bytes(sc.get(36..38)?.try_into().ok()?);
    if read_u16(12)? != 1
        || original_width == 0
        || original_height == 0
        || original_width > MAX_DIM_HU as u32
        || original_height > MAX_DIM_HU as u32
        || current_width != original_width
        || current_height != original_height
        || flip & 3 != 0
        || rotation != 0
        || x < 0
        || y < 0
        || x as usize + original_width as usize > parent_width
        || y as usize + original_height as usize > parent_height
        || !hwp5_identity_rendering(&sc[46..46 + 242], 2, f64::from(x), f64::from(y))
    {
        return None;
    }
    let rendering_end = 46 + 242;
    if sc.len() < rendering_end + 13 + 8 + 22 {
        return None;
    }
    let fill_start = rendering_end + 13;
    let tail_start = sc.len().checked_sub(22)?;
    if tail_start < fill_start {
        return None;
    }
    let fill = &sc[fill_start..tail_start];
    let fill_kind = read_u32(fill_start)?;
    let solid_fill = match fill_kind {
        0 => fill.len() == 8 && fill.iter().all(|byte| *byte == 0),
        1 => fill.len() == 21 && fill[7] == 0 && fill[16..20] == [0; 4],
        _ => false,
    };
    if !solid_fill {
        return None;
    }
    let inst_id = read_u32(tail_start + 16)?;
    if inst_id == 0 || sc[tail_start + 20] != 0 {
        return None;
    }
    Some(Hwp5GroupChildComponent {
        ctrl_id,
        x,
        y,
        width: original_width,
        height: original_height,
        inst_id,
        fill_start,
        tail_start,
        solid_fill: fill_kind == 1,
    })
}

fn hwp5_group_child_leaf_supported(tag: u16, leaf: &[u8], width: u32, height: u32, resize: bool) -> bool {
    match tag {
        TAG_RECTANGLE => {
            if leaf.len() != 33 || leaf[0] > 100 {
                return false;
            }
            let Some((xs, ys)) = parse_rectangle_vertices(&leaf[1..]) else {
                return false;
            };
            let (Ok(w), Ok(h)) = (i32::try_from(width), i32::try_from(height)) else {
                return false;
            };
            xs == [0, w, w, 0] && ys == [0, 0, h, h]
        }
        TAG_ELLIPSE => {
            if leaf.len() != 60 || dword(leaf, 0) != Ok(0) {
                return false;
            }
            let point = |at: usize| -> Option<(i64, i64)> {
                Some((
                    i64::from(i32::from_le_bytes(leaf.get(at..at + 4)?.try_into().ok()?)),
                    i64::from(i32::from_le_bytes(leaf.get(at + 4..at + 8)?.try_into().ok()?)),
                ))
            };
            let (w, h) = (i64::from(width), i64::from(height));
            let Some(center) = point(4) else { return false };
            let Some(axis1) = point(12) else { return false };
            let Some(axis2) = point(20) else { return false };
            let half_x = (w / 2, (w + 1) / 2);
            let half_y = (h / 2, (h + 1) / 2);
            let axes = (half_x.0..=half_x.1).contains(&center.0)
                && (half_y.0..=half_y.1).contains(&center.1)
                && axis1 == (w, center.1)
                && axis2 == (center.0, h);
            if !axes || !resize {
                return axes;
            }
            let endpoint = (w, center.1);
            (0..4).all(|index| point(28 + index * 8) == Some(endpoint))
        }
        _ => false,
    }
}

fn same_except_hwp5_component_ranges(old: &[u8], new: &[u8], ranges: &[(usize, usize)]) -> bool {
    if old.len() != new.len() {
        return false;
    }
    let mut normalized = old.to_vec();
    for &(start, end) in ranges {
        if start > end || end > old.len() {
            return false;
        }
        normalized[start..end].copy_from_slice(&new[start..end]);
    }
    normalized == new
}

fn hwp5_group_child_change_is_safe(
    old_sc: &[u8],
    new_sc: &[u8],
    old_leaf: &[u8],
    new_leaf: &[u8],
    old: Hwp5GroupChildComponent,
    new: Hwp5GroupChildComponent,
) -> bool {
    if old.ctrl_id != new.ctrl_id || old.inst_id != new.inst_id
        || old_sc.len() != new_sc.len()
        || old.fill_start != new.fill_start
        || old.tail_start != new.tail_start
        || old_sc[old.tail_start..] != new_sc[new.tail_start..]
        || old_sc[288..301] != new_sc[288..301]
    {
        return false;
    }
    let old_fill = &old_sc[old.fill_start..old.tail_start];
    let new_fill = &new_sc[new.fill_start..new.tail_start];
    let offset_changed = (old.x, old.y) != (new.x, new.y);
    let size_changed = (old.width, old.height) != (new.width, new.height);
    if size_changed {
        if !hwp5_group_child_leaf_supported(
            if old.ctrl_id == *SC_RECT { TAG_RECTANGLE } else { TAG_ELLIPSE },
            old_leaf,
            old.width,
            old.height,
            true,
        ) || !hwp5_group_child_leaf_supported(
            if new.ctrl_id == *SC_RECT { TAG_RECTANGLE } else { TAG_ELLIPSE },
            new_leaf,
            new.width,
            new.height,
            true,
        ) {
            return false;
        }
    } else if old_leaf != new_leaf {
        return false;
    }
    let fill_changed = old_fill != new_fill;
    if fill_changed
        && !(old.solid_fill
            && new.solid_fill
            && old_fill.len() == 21
            && new_fill.len() == 21
            && old_fill[4..8] != new_fill[4..8]
            && old_fill[..4] == new_fill[..4]
            && old_fill[8..] == new_fill[8..])
    {
        return false;
    }
    (offset_changed || size_changed || fill_changed || old_leaf != new_leaf)
        && same_except_hwp5_component_ranges(
            old_sc,
            new_sc,
            &[(4, 12), (16, 32), (64, 72), (88, 96), (old.fill_start + 4, old.fill_start + 8)],
        )
}

fn prove_hwp5_group_child_edit(
    old: &[Record<'_>],
    new: &[Record<'_>],
    old_sc_idx: usize,
    new_sc_idx: usize,
    child_count: usize,
    rendering_end: usize,
    parent_width: usize,
    parent_height: usize,
) -> Checked<()> {
    let (Some(old_header), Some(new_header)) = (old.first(), new.first()) else {
        return Err(finding(FindingCode::OutputMalformed, BODY));
    };
    let (Some(old_parent), Some(new_parent)) = (old.get(old_sc_idx), new.get(new_sc_idx)) else {
        return Err(finding(FindingCode::OutputMalformed, BODY));
    };
    preserved(
        old_sc_idx == 1
            && new_sc_idx == 1
            && old_header == new_header
            && old_parent == new_parent
            && old_parent.0 == TAG_SHAPE_COMPONENT
            && old_parent.1 == 2
            && old_parent.2.starts_with(SC_CONTAINER),
        BODY,
    )?;
    let parent_sc = old_parent.2;
    let id_off = 8;
    let parent_render_end = shape_rendering_end(parent_sc, id_off)
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    let parent_attr = dword(old_header.2, 4)? as u32;
    let original_width = dword(parent_sc, id_off + 12)?;
    let original_height = dword(parent_sc, id_off + 16)?;
    let current_width = dword(parent_sc, id_off + 20)?;
    let current_height = dword(parent_sc, id_off + 24)?;
    let parent_flip = dword(parent_sc, id_off + 28)? as u32;
    let parent_rotation = i16::from_le_bytes(parent_sc[id_off + 32..id_off + 34].try_into().unwrap());
    preserved(
        parent_attr & (ATTR_LOCKED | ATTR_SIZE_PROTECT | ATTR_CAPTION) == 0
            && word(parent_sc, id_off + 8)? == 0
            && parent_sc[id_off..id_off + 8] == [0; 8]
            && parent_flip & 3 == 0
            && parent_rotation == 0,
        BODY,
    )?;
    valid(
        (1..=MAX_DIM_HU).contains(&parent_width)
            && (1..=MAX_DIM_HU).contains(&parent_height)
            && original_width == parent_width
            && original_height == parent_height
            && current_width == parent_width
            && current_height == parent_height
            && parent_render_end == rendering_end
            && hwp5_identity_rendering(&parent_sc[id_off + 42..parent_render_end], 1, 0.0, 0.0),
        BODY,
    )?;
    let expected_tail = child_count
        .checked_mul(4)
        .and_then(|n| n.checked_add(6))
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    valid(
        (1..=128).contains(&child_count)
            && parent_sc.len() == parent_render_end + expected_tail
            && word(parent_sc, parent_render_end)? == child_count,
        BODY,
    )?;
    let old_body = &old[old_sc_idx + 1..];
    let new_body = &new[new_sc_idx + 1..];
    preserved(old_body.len() == child_count * 2 && new_body.len() == child_count * 2, BODY)?;
    let mut seen = std::collections::HashSet::with_capacity(child_count);
    let mut changed_children = 0usize;
    for index in 0..child_count {
        let old_component = old_body[index * 2];
        let new_component = new_body[index * 2];
        let old_leaf = old_body[index * 2 + 1];
        let new_leaf = new_body[index * 2 + 1];
        preserved(
            old_component.0 == TAG_SHAPE_COMPONENT
                && old_component.1 == 3
                && new_component.0 == TAG_SHAPE_COMPONENT
                && new_component.1 == 3
                && old_leaf.0 == new_leaf.0
                && old_leaf.1 == 4
                && new_leaf.1 == 4,
            BODY,
        )?;
        let id_at = parent_render_end + 2 + index * 4;
        preserved(
            old_component.2.get(..4) == parent_sc.get(id_at..id_at + 4)
                && new_component.2.get(..4) == parent_sc.get(id_at..id_at + 4),
            BODY,
        )?;
        let old_layout = parse_hwp5_group_child_component(&old_component.2, parent_width, parent_height)
            .ok_or_else(|| finding(FindingCode::RecordsChanged, BODY))?;
        let new_layout = parse_hwp5_group_child_component(&new_component.2, parent_width, parent_height)
            .ok_or_else(|| finding(FindingCode::RecordsChanged, BODY))?;
        let leaf_tag = if old_layout.ctrl_id == *SC_RECT { TAG_RECTANGLE } else { TAG_ELLIPSE };
        preserved(old_leaf.0 == leaf_tag, BODY)?;
        valid(
            hwp5_group_child_leaf_supported(leaf_tag, old_leaf.2, old_layout.width, old_layout.height, false)
                && hwp5_group_child_leaf_supported(leaf_tag, new_leaf.2, new_layout.width, new_layout.height, false),
            BODY,
        )?;
        reference(seen.insert((old_layout.ctrl_id, old_layout.inst_id)), BODY)?;
        if old_component != new_component || old_leaf != new_leaf {
            changed_children += 1;
            preserved(
                hwp5_group_child_change_is_safe(
                    old_component.2,
                    new_component.2,
                    old_leaf.2,
                    new_leaf.2,
                    old_layout,
                    new_layout,
                ),
                BODY,
            )?;
        }
    }
    preserved(changed_children > 0, BODY)?;
    Ok(())
}

fn parse_rectangle_vertices(vertices: &[u8]) -> Option<([i32; 4], [i32; 4])> {
    if vertices.len() != 32 {
        return None;
    }
    let mut xs = [0i32; 4];
    let mut ys = [0i32; 4];
    for i in 0..4 {
        let at = i * 8;
        xs[i] = i32::from_le_bytes(vertices[at..at + 4].try_into().ok()?);
        ys[i] = i32::from_le_bytes(vertices[at + 4..at + 8].try_into().ok()?);
    }
    Some((xs, ys))
}

fn scale_rectangle_axis(coords: [i32; 4], old_dim: usize, new_dim: usize) -> Option<[i32; 4]> {
    if old_dim == 0 || new_dim == 0 || old_dim > MAX_DIM_HU || new_dim > MAX_DIM_HU {
        return None;
    }
    if coords
        .iter()
        .any(|&c| !(-MAX_CROP_HU..=MAX_CROP_HU).contains(&c))
    {
        return None;
    }
    let (Some(&min_c), Some(&max_c)) = (coords.iter().min(), coords.iter().max()) else {
        return None;
    };
    if min_c >= max_c {
        return None;
    }
    if old_dim == new_dim {
        return Some(coords);
    }
    let den = i128::try_from(old_dim).ok()?;
    let num_scale = i128::try_from(new_dim).ok()?;
    let mut out = [0i32; 4];
    for (i, &c) in coords.iter().enumerate() {
        let num = i128::from(c) * num_scale;
        let rounded = if num >= 0 {
            (num + den / 2) / den
        } else {
            (num - den / 2) / den
        };
        let scaled = i32::try_from(rounded).ok()?;
        if !(-MAX_CROP_HU..=MAX_CROP_HU).contains(&scaled) {
            return None;
        }
        out[i] = scaled;
    }
    let (Some(&new_min), Some(&new_max)) = (out.iter().min(), out.iter().max()) else {
        return None;
    };
    if new_min >= new_max {
        return None;
    }
    Some(out)
}

/// Validates a candidate evolved GSO object pair (`old`, `new`) against strict HWP5 rules.
pub(super) fn prove_evolved_gso(
    old: &[Record<'_>],
    new: &[Record<'_>],
    orig_defs: &Defs<'_>,
    defs: &Defs<'_>,
) -> Checked<()> {
    preserved(evolved_candidate(old, new, orig_defs), BODY)?;
    let (ctrl_id, id_off, old_sc_idx) = shape_ctrl_id(old).unwrap();
    let (_, _, new_sc_idx) = shape_ctrl_id(new).unwrap();
    let is_picture = ctrl_id == SC_PICTURE;
    let is_container = ctrl_id == SC_CONTAINER;
    let leaf_tag = if is_container {
        None
    } else {
        Some(expected_leaf_tag(ctrl_id).unwrap())
    };

    let (old_w, old_h_dim, new_w, new_h_dim, size_changed, has_caption) =
        check_ctrl_header(old[0].2, new[0].2, is_picture)?;
    if has_caption {
        preserved(
            old_sc_idx >= 3
                && new_sc_idx >= 3
                && old[1].0 == TAG_LIST_HEADER
                && old[1].1 == 2
                && new[1].0 == TAG_LIST_HEADER
                && new[1].1 == 2
                && old[2].0 == 66
                && old[2].1 == 2
                && new[2].0 == 66
                && new[2].1 == 2,
            BODY,
        )?;
        if old[1..old_sc_idx] != new[1..new_sc_idx] {
            preserved(
                !is_container
                    && old.len() == old_sc_idx + 2
                    && new.len() == new_sc_idx + 2,
                BODY,
            )?;
            let old_list = old[1].2;
            let new_list = new[1].2;
            let old_count = word(old_list, 0)?;
            let new_count = word(new_list, 0)?;
            preserved(
                old_list.len() == 30
                    && new_list.len() == 30
                    && old_list[2..] == new_list[2..]
                    && (1..=64).contains(&old_count)
                    && (1..=64).contains(&new_count),
                BODY,
            )?;
            super::insertions::prove_caption_paragraphs(
                &old[2..old_sc_idx],
                &new[2..new_sc_idx],
                old_count,
                new_count,
                orig_defs,
                defs,
            )?;
        }
    } else {
        preserved(old_sc_idx == 1 && new_sc_idx == 1, BODY)?;
    }

    let old_sc = old[old_sc_idx].2;
    let new_sc = new[new_sc_idx].2;
    let attr_at = id_off;
    preserved(old_sc[..attr_at] == new_sc[..attr_at], BODY)?;
    // offset_x(4) + offset_y(4) immutable; group_level(2)==0; local_file_version(2) immutable;
    // original_width(4) + original_height(4) immutable.
    preserved(
        old_sc[attr_at..attr_at + 8] == new_sc[attr_at..attr_at + 8],
        BODY,
    )?;
    preserved(
        word(old_sc, attr_at + 8)? == 0 && word(new_sc, attr_at + 8)? == 0,
        BODY,
    )?;
    preserved(
        old_sc[attr_at + 10..attr_at + 20] == new_sc[attr_at + 10..attr_at + 20],
        BODY,
    )?;

    let orig_w = dword(old_sc, attr_at + 12)?;
    let orig_h = dword(old_sc, attr_at + 16)?;
    let old_cw = dword(old_sc, attr_at + 20)?;
    let old_ch = dword(old_sc, attr_at + 24)?;
    let new_cw = dword(new_sc, attr_at + 20)?;
    let new_ch = dword(new_sc, attr_at + 24)?;
    let old_flip = dword(old_sc, attr_at + 28)? as u32;
    let new_flip = dword(new_sc, attr_at + 28)? as u32;
    let old_rot = i16::from_le_bytes(old_sc[attr_at + 32..attr_at + 34].try_into().unwrap());
    let new_rot = i16::from_le_bytes(new_sc[attr_at + 32..attr_at + 34].try_into().unwrap());
    let rotated_picture = is_picture && new_rot.rem_euclid(360) != 0;
    if is_picture || is_container {
        preserved(old_flip == new_flip && old_rot == new_rot, BODY)?;
    } else {
        preserved((old_flip & !0x03) == (new_flip & !0x03), BODY)?;
        preserved(new_rot == old_rot || (0..360).contains(&new_rot), BODY)?;
    }

    // RHWP updates current_* only on a changed axis. Nonrotated pictures and
    // basic shapes use the header size on a changed axis; rotated HWP pictures
    // scale current_* proportionally from old header/current dims while keeping
    // original_* fixed as the scale denominator.
    for (old_dim, new_dim, old_current, new_current) in [
        (old_w, new_w, old_cw, new_cw),
        (old_h_dim, new_h_dim, old_ch, new_ch),
    ] {
        if old_dim == new_dim {
            preserved(new_current == old_current, BODY)?;
        } else if rotated_picture {
            preserved(old_dim > 0 && old_current > 0, BODY)?;
            let expected = ((old_current as f64 * new_dim as f64 / old_dim as f64).round())
                .max(1.0) as usize;
            valid((1..=MAX_DIM_HU).contains(&expected) && new_current == expected, BODY)?;
        } else {
            valid(new_current == new_dim, BODY)?;
        }
    }

    let old_rc = &old_sc[attr_at + 34..attr_at + 42];
    let new_rc = &new_sc[attr_at + 34..attr_at + 42];
    if is_container && new_rc != old_rc {
        let mut expected_rc = [0u8; 8];
        expected_rc[..4].copy_from_slice(&((new_w / 2) as i32).to_le_bytes());
        expected_rc[4..].copy_from_slice(&((new_h_dim / 2) as i32).to_le_bytes());
        valid(new_rc == expected_rc, BODY)?;
    } else {
        preserved(new_rc == old_rc, BODY)?;
    }

    let r_at = attr_at + 42;
    let old_cnt = word(old_sc, r_at)?;
    let new_cnt = word(new_sc, r_at)?;
    let old_r_len = 2usize
        .checked_add(
            1usize
                .checked_add(2 * old_cnt)
                .and_then(|m| m.checked_mul(48))
                .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?,
        )
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    let new_r_len = 2usize
        .checked_add(
            1usize
                .checked_add(2 * new_cnt)
                .and_then(|m| m.checked_mul(48))
                .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?,
        )
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    let old_r_end = r_at + old_r_len;
    let new_r_end = r_at + new_r_len;
    valid(old_sc.len() >= old_r_end && new_sc.len() >= new_r_end, BODY)?;

    if rotated_picture && size_changed {
        preserved(old_w > 0 && old_h_dim > 0, BODY)?;
        valid(new_w > 0 && new_h_dim > 0, BODY)?;
    }

    let picture_transform_changed = is_picture
        && if rotated_picture {
            size_changed
        } else {
            size_changed || old[0].2[8..16] != new[0].2[8..16]
        };
    let component_offset = [
        dword(new_sc, attr_at)? as i32,
        dword(new_sc, attr_at + 4)? as i32,
    ];
    let old_component_offset = [
        dword(old_sc, attr_at)? as i32,
        dword(old_sc, attr_at + 4)? as i32,
    ];
    let scaled_source_picture = is_picture
        && !rotated_picture
        && matches_scaled_source_rendering(
            &old_sc[r_at..old_r_end],
            old_component_offset,
            [orig_w, orig_h],
            [old_cw, old_ch],
        );
    validate_rendering_info(
        &old_sc[r_at..old_r_end],
        &new_sc[r_at..new_r_end],
        picture_transform_changed,
        is_container,
        component_offset,
        rotated_picture.then_some((new_rot, [orig_w, orig_h], [old_cw, old_ch], [new_cw, new_ch])),
        scaled_source_picture,
    )?;

    if is_container {
        // Group container (`noc$`): child count + child ctrl_ids + instance_id and every child record stay intact.
        valid(old_sc.len() >= old_r_end + 6 && new_sc.len() >= new_r_end + 6, BODY)?;
        let child_count = word(old_sc, old_r_end)?;
        let expected_tail = 6usize
            .checked_add(child_count.checked_mul(4).ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?)
            .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
        valid(
            child_count >= 1
                && old_sc.len() == old_r_end + expected_tail
                && new_sc.len() == new_r_end + expected_tail,
            BODY,
        )?;
        preserved(old_sc[old_r_end..] == new_sc[new_r_end..], BODY)?;
        let old_children = &old[old_sc_idx + 1..];
        let new_children = &new[new_sc_idx + 1..];
        if old_children != new_children {
            return prove_hwp5_group_child_edit(
                old,
                new,
                old_sc_idx,
                new_sc_idx,
                child_count,
                old_r_end,
                old_w,
                old_h_dim,
            );
        }
        preserved(!old_children.is_empty(), BODY)?;
        return Ok(());
    }

    if is_picture {
        valid(old_sc.len() == old_r_end && new_sc.len() == new_r_end, BODY)?;
        valid(
            old.len() == old_sc_idx + 2 && new.len() == new_sc_idx + 2,
            BODY,
        )?;
        let (old_pic, new_pic) = (old[old_sc_idx + 1], new[new_sc_idx + 1]);
        valid(
            old_pic.0 == TAG_PICTURE
                && old_pic.1 == 3
                && new_pic.0 == TAG_PICTURE
                && new_pic.1 == 3,
            BODY,
        )?;
        if (dword(old[0].2, 4)? ^ dword(new[0].2, 4)?) as u32 & ALIGN_ATTR_MASK != 0 {
            preserved(old_rot == 0 && old_flip & 3 == 0 && old_pic == new_pic, BODY)?;
        }
        let (op, np) = (old_pic.2, new_pic.2);
        valid(op.len() >= 73 && np.len() >= 73, BODY)?;
        preserved(op[..44] == np[..44], BODY)?; // border + border_x[4] + border_y[4]
        if op[44..60] != np[44..60] {
            let i32_at =
                |b: &[u8], at: usize| i32::from_le_bytes(b[at..at + 4].try_into().unwrap());
            let (l, t, r, b) = (
                i32_at(np, 44),
                i32_at(np, 48),
                i32_at(np, 52),
                i32_at(np, 56),
            );
            valid(
                (0..=MAX_CROP_HU).contains(&l)
                    && (l..=MAX_CROP_HU).contains(&r)
                    && (0..=MAX_CROP_HU).contains(&t)
                    && (t..=MAX_CROP_HU).contains(&b),
                BODY,
            )?;
        }
        preserved(op[60..71] == np[60..71], BODY)?; // padding + brightness + contrast + effect
        let old_bin = word(op, 71)?;
        let new_bin = word(np, 71)?;
        reference(
            old_bin == new_bin && old_bin >= 1 && old_bin <= entries(orig_defs, 18).len(),
            BODY,
        )?;
        preserved(op[73..] == np[73..], BODY)?; // raw_picture_extra / transparency
        return Ok(());
    }

    // Shape GSO (`nil$`, `cer$`, `lle$`): border(13) + fill(>=8) + shadow+inst+alpha(22).
    valid(
        old_sc.len() >= old_r_end + 13 + 8 + 22 && new_sc.len() >= new_r_end + 13 + 8 + 22,
        BODY,
    )?;
    let (old_border, new_border) = (
        &old_sc[old_r_end..old_r_end + 13],
        &new_sc[new_r_end..new_r_end + 13],
    );
    preserved(old_border[8..13] == new_border[8..13], BODY)?;
    if old_border[4..8] != new_border[4..8] {
        preserved(!has_caption && old.len() == 3 && new.len() == 3 && dword(old_border, 8)? & 0x3f == 1, BODY)?;
        valid(
            (1..=7200).contains(&dword(old_border, 4)?) && (1..=7200).contains(&dword(new_border, 4)?),
            BODY,
        )?;
    }
    if old_border[..4] != new_border[..4] {
        valid(new_border[3] == 0, BODY)?;
    }

    let old_tail_at = old_sc.len() - 22;
    let new_tail_at = new_sc.len() - 22;
    preserved(old_sc[old_tail_at..] == new_sc[new_tail_at..], BODY)?;
    check_fill(
        &old_sc[old_r_end + 13..old_tail_at],
        &new_sc[new_r_end + 13..new_tail_at],
    )?;

    // Optional byte-identical TextBox (`LIST_HEADER` at level 3 + paragraphs), then shape leaf at level 3.
    let Some(leaf_tag) = leaf_tag else {
        return Err(finding(FindingCode::RecordsChanged, BODY));
    };
    let (old_last, new_last) = (old[old.len() - 1], new[new.len() - 1]);
    valid(
        old_last.0 == leaf_tag && old_last.1 == 3 && new_last.0 == leaf_tag && new_last.1 == 3,
        BODY,
    )?;
    let old_mid = &old[old_sc_idx + 1..old.len() - 1];
    let new_mid = &new[new_sc_idx + 1..new.len() - 1];
    if old_mid.is_empty() && new_mid.is_empty() {
        // Plain shape with no TextBox.
    } else {
        preserved(
            !old_mid.is_empty()
                && old_mid == new_mid
                && old_mid[0].0 == TAG_LIST_HEADER
                && old_mid[0].1 == 3
                && old_mid.get(1).is_some_and(|r| r.0 == 66 && r.1 == 4)
                && old_mid[1..].iter().all(|r| {
                    matches!((r.0, r.1), (66, 4) | (67..=70, 5)) && (r.0 != 70 || r.2.is_empty())
                }),
            BODY,
        )?;
    }

    if leaf_tag == TAG_RECTANGLE {
        valid(old_last.2.len() == 33 && new_last.2.len() == 33, BODY)?;
        preserved(old_last.2[0] == new_last.2[0], BODY)?; // round_rate
        let old_vertices = &old_last.2[1..];
        let new_vertices = &new_last.2[1..];
        if size_changed {
            let Some((old_x, old_y)) = parse_rectangle_vertices(old_vertices) else {
                return Err(finding(FindingCode::OutputMalformed, BODY));
            };
            let Some((new_x, new_y)) = parse_rectangle_vertices(new_vertices) else {
                return Err(finding(FindingCode::OutputMalformed, BODY));
            };
            let expected_x = scale_rectangle_axis(old_x, old_w, new_w)
                .ok_or_else(|| finding(FindingCode::RecordsChanged, BODY))?;
            let expected_y = scale_rectangle_axis(old_y, old_h_dim, new_h_dim)
                .ok_or_else(|| finding(FindingCode::RecordsChanged, BODY))?;
            valid(new_x == expected_x && new_y == expected_y, BODY)?;
        } else {
            preserved(old_vertices == new_vertices, BODY)?;
        }
    } else if matches!(leaf_tag, TAG_CURVE | TAG_POLYGON) && old_last.2 != new_last.2 {
        // A path edit keeps the complete owner subtree except its path leaf
        // byte-identical. Permit only the modeled reversible HWP5 transform:
        // bounded integer translation, modeled flip/rotation fields, and the
        // one-pair identity rendering matrices. Any upper flip bits remain in
        // the byte-identical owner subtree. The
        // frontend applies the inverse transform to pointer deltas; this proof
        // establishes that no unmodeled affine state changed or was discarded.
        let component_offset = [
            i32::from_le_bytes(old_sc[attr_at..attr_at + 4].try_into().unwrap()),
            i32::from_le_bytes(old_sc[attr_at + 4..attr_at + 8].try_into().unwrap()),
        ];
        let rotation_center = [
            i32::from_le_bytes(old_sc[attr_at + 34..attr_at + 38].try_into().unwrap()),
            i32::from_le_bytes(old_sc[attr_at + 38..attr_at + 42].try_into().unwrap()),
        ];
        let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let modeled_transform = (-MAX_OFFSET_HU..=MAX_OFFSET_HU)
            .contains(&component_offset[0])
            && (-MAX_OFFSET_HU..=MAX_OFFSET_HU).contains(&component_offset[1])
            && (-MAX_OFFSET_HU..=MAX_OFFSET_HU)
                .contains(&i32::from_le_bytes(old[0].2[8..12].try_into().unwrap()))
            && (-MAX_OFFSET_HU..=MAX_OFFSET_HU)
                .contains(&i32::from_le_bytes(old[0].2[12..16].try_into().unwrap()))
            && word(old_sc, attr_at + 10).is_ok_and(|version| version == 1)
            && (-360..=360).contains(&old_rot)
            && (old_rot.rem_euclid(360) == 0
                || (i64::from(rotation_center[0]) * 2 == orig_w as i64
                    && i64::from(rotation_center[1]) * 2 == orig_h as i64))
            && old_w == orig_w
            && old_h_dim == orig_h
            && old_cw == orig_w
            && old_ch == orig_h
            && parse_rendering_matrices(&old_sc[r_at..old_r_end])
                .is_some_and(|matrices| matrices.into_iter().all(|matrix| matrix == identity));
        preserved(
            !has_caption
                && old_mid.is_empty()
                && old[..old.len() - 1] == new[..new.len() - 1]
                && dword(old[0].2, 4)? as u32 & ATTR_SIZE_PROTECT == 0
                && (1..=2_000_000).contains(&orig_w)
                && (1..=2_000_000).contains(&orig_h)
                && modeled_transform
                && if leaf_tag == TAG_CURVE {
                    prove_cubic_leaf_edit(old_last.2, new_last.2, orig_w, orig_h)
                } else {
                    old_sc[attr_at..attr_at + 8] == [0; 8]
                        && prove_polygon_leaf_edit(old_last.2, new_last.2, orig_w, orig_h)
                },
            BODY,
        )?;
    } else {
        preserved(old_last.2 == new_last.2, BODY)?;
    }
    Ok(())
}

fn polygon_cross(a: CurvePoint, b: CurvePoint, c: CurvePoint) -> i64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn polygon_contains(a: CurvePoint, b: CurvePoint, p: CurvePoint) -> bool {
    (a[0].min(b[0])..=a[0].max(b[0])).contains(&p[0])
        && (a[1].min(b[1])..=a[1].max(b[1])).contains(&p[1])
}

fn polygon_edges_intersect(a: CurvePoint, b: CurvePoint, c: CurvePoint, d: CurvePoint) -> bool {
    let (ac, ad) = (polygon_cross(a, b, c), polygon_cross(a, b, d));
    let (ca, cb) = (polygon_cross(c, d, a), polygon_cross(c, d, b));
    (ac.signum() * ad.signum() < 0 && ca.signum() * cb.signum() < 0)
        || (ac == 0 && polygon_contains(a, b, c))
        || (ad == 0 && polygon_contains(a, b, d))
        || (ca == 0 && polygon_contains(c, d, a))
        || (cb == 0 && polygon_contains(c, d, b))
}

struct PolygonLeaf {
    vertices: Vec<CurvePoint>,
    winding: i64,
}

fn parse_polygon_leaf(data: &[u8], width: usize, height: usize) -> Option<PolygonLeaf> {
    let count = dword(data, 0).ok()?;
    if !(4..=257).contains(&count) || data.len() != 8 + 8 * count || data[4 + 8 * count..] != [0; 4] {
        return None;
    }
    let mut points = Vec::with_capacity(count);
    for bytes in data[4..4 + 8 * count].chunks_exact(8) {
        let (x, y) = (dword(bytes, 0).ok()?, dword(bytes, 4).ok()?);
        if x > width || y > height {
            return None;
        }
        points.push([x as i64, y as i64]);
    }
    let vertices = &points[..count - 1];
    if points.first() != points.last()
        || vertices.iter().collect::<std::collections::BTreeSet<_>>().len() != vertices.len()
    {
        return None;
    }
    let winding = points.windows(2).map(|e| polygon_cross([0, 0], e[0], e[1])).sum::<i64>().signum();
    if winding == 0 {
        return None;
    }
    for (i, edge) in points.windows(2).enumerate() {
        let (a, b) = (edge[0], edge[1]);
        let prev = vertices[(i + count - 2) % (count - 1)];
        if polygon_cross(prev, a, b) == 0 && !strictly_between(prev, a, b) {
            return None;
        }
        let end = if i == 0 { count - 2 } else { count - 1 };
        if points.windows(2).take(end).skip(i + 2).any(|e| polygon_edges_intersect(a, b, e[0], e[1])) {
            return None;
        }
    }
    points.pop();
    Some(PolygonLeaf { vertices: points, winding })
}

fn polygon_corners(vertices: &[CurvePoint]) -> Vec<CurvePoint> {
    let count = vertices.len();
    vertices.iter().enumerate().filter_map(|(i, &p)| {
        let (prev, next) = (vertices[(i + count - 1) % count], vertices[(i + 1) % count]);
        (!strictly_between(prev, p, next)).then_some(p)
    }).collect()
}

fn prove_polygon_leaf_edit(old: &[u8], new: &[u8], width: usize, height: usize) -> bool {
    let Some(old) = parse_polygon_leaf(old, width, height) else { return false };
    let Some(new) = parse_polygon_leaf(new, width, height) else { return false };
    if old.winding != new.winding {
        return false;
    }
    // Structural edits only split or join straight edges, in the original
    // traversal order. A removed first point may be an interior edge point.
    if polygon_corners(&old.vertices) == polygon_corners(&new.vertices) {
        return true;
    }
    // Point edits preserve indices. An existing vertex cannot be relocated to
    // another slot by a serialized permutation.
    old.vertices.len() == new.vertices.len()
        && new.vertices.iter().enumerate().all(|(i, point)| {
            old.vertices[i] == *point || !old.vertices.contains(point)
        })
}

struct CubicLeaf<'a> {
    point_bytes: &'a [u8],
    used_commands: &'a [u8],
}

fn parse_cubic_leaf(data: &[u8], width: usize, height: usize) -> Option<CubicLeaf<'_>> {
    let count = dword(data, 0).ok()?;
    if !(4..=257).contains(&count) {
        return None;
    }
    let point_end = 4 + 8 * count;
    let end = point_end + count - 1;
    if data.len() != end + 4 || data[end..] != [0; 4] {
        return None;
    }
    let commands = &data[point_end..end];
    let point_bytes = &data[4..point_end];
    let points: Vec<_> = point_bytes.chunks_exact(8).collect();
    if points.first() == points.last()
        || !points.iter().all(|point| dword(point, 0).is_ok_and(|x| x <= width)
            && dword(point, 4).is_ok_and(|y| y <= height))
    {
        return None;
    }
    let (mut offset, mut segment) = (1, 0);
    let mut cubic = false;
    while offset < count {
        let start = offset - 1;
        match commands[segment] {
            0 => offset += 1,
            1 if offset + 2 < count => {
                cubic = true;
                offset += 3;
            }
            _ => return None,
        }
        if points[start] == points[offset - 1] {
            return None;
        }
        segment += 1;
    }
    (cubic && commands[segment..].iter().all(|value| *value == 0))
        .then_some(CubicLeaf { point_bytes, used_commands: &commands[..segment] })
}

fn prove_cubic_leaf_edit(old: &[u8], new: &[u8], width: usize, height: usize) -> bool {
    let (Some(old), Some(new)) = (parse_cubic_leaf(old, width, height), parse_cubic_leaf(new, width, height)) else {
        return false;
    };
    if old.point_bytes.len() == new.point_bytes.len() && old.used_commands == new.used_commands {
        return true;
    }
    let (old_start, old) = canonical_cubic_path(old);
    let (new_start, new) = canonical_cubic_path(new);
    old_start == new_start
        && (extends_curve_with_lines(old_start, &old, &new)
            || extends_curve_with_lines(old_start, &new, &old)
            || differs_by_one_cubic(&old, &new)
            || differs_by_one_cubic(&new, &old))
}

type CurvePoint = [i64; 2];

#[derive(PartialEq, Eq)]
enum CurveStep {
    Line(CurvePoint),
    Cubic([CurvePoint; 3]),
}

impl CurveStep {
    fn end(&self) -> CurvePoint {
        match self {
            Self::Line(end) | Self::Cubic([_, _, end]) => *end,
        }
    }
}

fn strictly_between(a: CurvePoint, p: CurvePoint, b: CurvePoint) -> bool {
    let [dx, dy] = [p[0] - a[0], p[1] - a[1]];
    let [ex, ey] = [b[0] - p[0], b[1] - p[1]];
    dx * ey == dy * ex && dx * ex + dy * ey > 0
}

/// Remove only redundant points on same-direction straight runs. The input
/// parser already proved every step's point arity and bounded coordinates.
fn canonical_cubic_path(leaf: CubicLeaf<'_>) -> (CurvePoint, Vec<CurveStep>) {
    let mut points = leaf.point_bytes.chunks_exact(8).map(|bytes| {
        let x = i32::from_le_bytes(bytes[..4].try_into().unwrap());
        let y = i32::from_le_bytes(bytes[4..].try_into().unwrap());
        [i64::from(x), i64::from(y)]
    });
    let start = points.next().unwrap();
    let mut current = start;
    let mut line_start = start;
    let mut steps = Vec::with_capacity(leaf.used_commands.len());
    for &command in leaf.used_commands {
        let point = points.next().unwrap();
        if command == 0 {
            match steps.last_mut() {
                Some(CurveStep::Line(previous)) if strictly_between(line_start, *previous, point) => {
                    *previous = point;
                }
                _ => {
                    line_start = current;
                    steps.push(CurveStep::Line(point));
                }
            }
            current = point;
        } else {
            let control = points.next().unwrap();
            current = points.next().unwrap();
            steps.push(CurveStep::Cubic([point, control, current]));
        }
    }
    (start, steps)
}

fn extends_curve_with_lines(start: CurvePoint, short: &[CurveStep], long: &[CurveStep]) -> bool {
    if let Some(suffix) = long.strip_prefix(short) {
        return suffix.iter().all(|step| matches!(step, CurveStep::Line(_)));
    }
    // A collinear append can extend the final line past the shortened path's
    // endpoint. Every preceding segment still has to match exactly.
    let Some((CurveStep::Line(old_end), prefix)) = short.split_last() else {
        return false;
    };
    let Some([CurveStep::Line(new_end), suffix @ ..]) = long.strip_prefix(prefix) else {
        return false;
    };
    strictly_between(prefix.last().map_or(start, CurveStep::end), *old_end, *new_end)
        && suffix.iter().all(|step| matches!(step, CurveStep::Line(_)))
}

fn differs_by_one_cubic(short: &[CurveStep], long: &[CurveStep]) -> bool {
    if long.len() != short.len() + 1 { return false; }
    (0..long.len()).any(|index| {
        matches!(&long[index], CurveStep::Cubic(_))
            && short.get(..index) == long.get(..index)
            && short.get(index..) == long.get(index + 1..)
    })
}

#[cfg(test)]
mod tests {
    use super::super::super::preview::PreviewRaster;
    use super::super::{
        Finding, FindingCode, Mode, Side, compare_saved_with_preview, compare_with, open,
        rebuild_preview, refresh_previews,
    };
    use std::io::{Cursor, Write};

    fn pack_records(rs: &[(u16, u16, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for &(tag, level, data) in rs {
            let len = data.len();
            let header_len = if len >= 0xFFF { 0xFFF } else { len };
            let head = u32::from(tag & 0x3FF)
                | (u32::from(level & 0x3FF) << 10)
                | ((header_len as u32) << 20);
            out.extend_from_slice(&head.to_le_bytes());
            if len >= 0xFFF {
                out.extend_from_slice(&(len as u32).to_le_bytes());
            }
            out.extend_from_slice(data);
        }
        out
    }

    fn build_hwp(
        doc_info: &[(u16, u16, &[u8])],
        section: &[(u16, u16, &[u8])],
        bin1: &[u8],
    ) -> Vec<u8> {
        let mut header = vec![0u8; 256];
        header[..17].copy_from_slice(b"HWP Document File");
        header[32..36].copy_from_slice(&0x05000000u32.to_le_bytes());
        let mut buf = Cursor::new(Vec::new());
        {
            let mut cf = cfb::CompoundFile::create(&mut buf).unwrap();
            cf.create_stream("FileHeader")
                .unwrap()
                .write_all(&header)
                .unwrap();
            cf.create_stream("DocInfo")
                .unwrap()
                .write_all(&pack_records(doc_info))
                .unwrap();
            cf.create_storage("BodyText").unwrap();
            cf.create_stream("BodyText/Section0")
                .unwrap()
                .write_all(&pack_records(section))
                .unwrap();
            cf.create_storage("BinData").unwrap();
            cf.create_stream("BinData/BIN0001.png")
                .unwrap()
                .write_all(bin1)
                .unwrap();
            cf.create_stream("PrvText")
                .unwrap()
                .write_all(b"\r\0\n\0")
                .unwrap();
            cf.create_stream("PrvImage")
                .unwrap()
                .write_all(b"old-prv")
                .unwrap();
        }
        buf.into_inner()
    }

    fn doc_info_records(bin_count: u32) -> Vec<(u16, u16, Vec<u8>)> {
        let mut id_map = vec![0u8; 64];
        id_map[0..4].copy_from_slice(&bin_count.to_le_bytes());
        id_map[4..8].copy_from_slice(&1u32.to_le_bytes()); // font 1
        id_map[32..36].copy_from_slice(&1u32.to_le_bytes()); // border_fill 1
        id_map[36..40].copy_from_slice(&1u32.to_le_bytes()); // char_shape 1
        id_map[40..44].copy_from_slice(&1u32.to_le_bytes()); // tab_def 1
        id_map[52..56].copy_from_slice(&1u32.to_le_bytes()); // para_shape 1
        id_map[56..60].copy_from_slice(&1u32.to_le_bytes()); // style 1
        let mut out = vec![(16, 0, vec![0; 26]), (17, 0, id_map)];
        for id in 1..=bin_count {
            let mut bin = vec![0u8; 12];
            bin[0..2].copy_from_slice(&0x0101u16.to_le_bytes());
            bin[2..4].copy_from_slice(&(id as u16).to_le_bytes());
            bin[4..6].copy_from_slice(&3u16.to_le_bytes());
            for (i, ch) in "png".encode_utf16().enumerate() {
                bin[6 + i * 2..8 + i * 2].copy_from_slice(&ch.to_le_bytes());
            }
            out.push((18, 1, bin));
        }
        out.push((19, 1, vec![0; 8]));
        out.push((20, 1, vec![0; 40]));
        out.push((21, 1, vec![0; 74]));
        out.push((22, 1, vec![0; 14]));
        out.push((25, 1, vec![0; 54]));
        out.push((26, 1, vec![0; 12]));
        out
    }

    fn ctrl_header(
        id: u32,
        attr: u32,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        desc: &str,
        raw_extra: &[u8],
    ) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b" osg");
        b.extend_from_slice(&attr.to_le_bytes());
        b.extend_from_slice(&y.to_le_bytes());
        b.extend_from_slice(&x.to_le_bytes());
        b.extend_from_slice(&w.to_le_bytes());
        b.extend_from_slice(&h.to_le_bytes());
        b.extend_from_slice(&1i32.to_le_bytes()); // z_order
        b.extend_from_slice(&[0u8; 8]); // margins
        b.extend_from_slice(&id.to_le_bytes());
        b.extend_from_slice(&0i32.to_le_bytes()); // prevent_page_break
        let units: Vec<u16> = desc.encode_utf16().collect();
        b.extend_from_slice(&(units.len() as u16).to_le_bytes());
        for u in units {
            b.extend_from_slice(&u.to_le_bytes());
        }
        b.extend_from_slice(raw_extra);
        b
    }

    fn shape_component_base(
        ctrl: &[u8; 4],
        orig_w: u32,
        orig_h: u32,
        cur_w: u32,
        cur_h: u32,
        flip: u32,
        rot: i16,
    ) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(ctrl);
        b.extend_from_slice(ctrl);
        b.extend_from_slice(&0i32.to_le_bytes()); // offset_x
        b.extend_from_slice(&0i32.to_le_bytes()); // offset_y
        b.extend_from_slice(&0u16.to_le_bytes()); // group_level
        b.extend_from_slice(&0u16.to_le_bytes()); // local_file_version
        b.extend_from_slice(&orig_w.to_le_bytes());
        b.extend_from_slice(&orig_h.to_le_bytes());
        b.extend_from_slice(&cur_w.to_le_bytes());
        b.extend_from_slice(&cur_h.to_le_bytes());
        b.extend_from_slice(&flip.to_le_bytes());
        b.extend_from_slice(&rot.to_le_bytes());
        b.extend_from_slice(&(orig_w as i32 / 2).to_le_bytes());
        b.extend_from_slice(&(orig_h as i32 / 2).to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // cnt = 1
        for _ in 0..3 {
            for v in [1.0f64, 0.0, 0.0, 0.0, 1.0, 0.0] {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        b
    }

    fn picture_leaf(bin_id: u16, crop: [i32; 4], extra: &[u8]) -> Vec<u8> {
        let mut b = vec![0u8; 73];
        for (i, c) in crop.into_iter().enumerate() {
            b[44 + i * 4..48 + i * 4].copy_from_slice(&c.to_le_bytes());
        }
        b[71..73].copy_from_slice(&bin_id.to_le_bytes());
        b.extend_from_slice(extra);
        b
    }

    fn header_picture_owner(x: i32, y: i32, ctrl_id: u32, bin_id: u16) -> Vec<(u16, u16, Vec<u8>)> {
        let mut owner = vec![0u8; 16];
        owner[..4].copy_from_slice(b"daeh");
        let mut paragraph = vec![0u8; 22];
        paragraph[0..4].copy_from_slice(&1u32.to_le_bytes());
        vec![
            (71, 1, owner),
            (66, 2, paragraph),
            (
                71,
                3,
                ctrl_header(ctrl_id, 0x000a_0311, x, y, 4000, 3000, "", b"\xaa\xbb"),
            ),
            (
                76,
                4,
                shape_component_base(b"cip$", 4000, 3000, 4000, 3000, 0, 0),
            ),
            (85, 5, picture_leaf(bin_id, [0, 0, 4000, 3000], b"\x01\x02")),
        ]
    }

    fn shape_component_drawing(
        ctrl: &[u8; 4],
        w: u32,
        h: u32,
        flip: u32,
        rot: i16,
        border_color: u32,
        solid_color: Option<u32>,
        sc_inst: u32,
    ) -> Vec<u8> {
        let mut b = shape_component_base(ctrl, 10000, 5000, w, h, flip, rot);
        b.extend_from_slice(&border_color.to_le_bytes());
        b.extend_from_slice(&33i32.to_le_bytes()); // border_width
        b.extend_from_slice(&0x01u32.to_le_bytes()); // border_attr
        b.push(0); // outline_style
        match solid_color {
            None => {
                b.extend_from_slice(&0u32.to_le_bytes());
                b.extend_from_slice(&0u32.to_le_bytes());
            }
            Some(c) => {
                b.extend_from_slice(&1u32.to_le_bytes());
                b.extend_from_slice(&c.to_le_bytes());
                b.extend_from_slice(&0u32.to_le_bytes());
                b.extend_from_slice(&(-1i32).to_le_bytes());
                b.extend_from_slice(&0u32.to_le_bytes());
                b.push(0);
            }
        }
        b.extend_from_slice(&0u32.to_le_bytes()); // shadow_type
        b.extend_from_slice(&0x00c4c4c4u32.to_le_bytes());
        b.extend_from_slice(&283i32.to_le_bytes());
        b.extend_from_slice(&283i32.to_le_bytes());
        b.extend_from_slice(&sc_inst.to_le_bytes());
        b.push(0);
        b.push(0);
        b
    }

    fn rect_leaf(round: u8, w: i32, h: i32) -> Vec<u8> {
        let mut b = vec![round];
        for val in [0i32, 0, w, 0, w, h, 0, h] {
            b.extend_from_slice(&val.to_le_bytes());
        }
        b
    }

    fn wrap_section(objects: Vec<Vec<(u16, u16, Vec<u8>)>>) -> Vec<(u16, u16, Vec<u8>)> {
        let mut text = Vec::new();
        text.extend_from_slice(&2u16.to_le_bytes());
        text.extend_from_slice(b"dces");
        text.extend_from_slice(&[0u8; 8]);
        text.extend_from_slice(&2u16.to_le_bytes());
        for _ in &objects {
            text.extend_from_slice(&11u16.to_le_bytes());
            text.extend_from_slice(b" osg");
            text.extend_from_slice(&[0u8; 8]);
            text.extend_from_slice(&11u16.to_le_bytes());
        }
        text.extend_from_slice(b"\r\0");
        let char_count = ((text.len() / 2) as u32) | 0x8000_0000;
        let mask: u32 = (1 << 2) | if objects.is_empty() { 0 } else { 1 << 11 };
        let mut hdr = vec![0u8; 22];
        hdr[0..4].copy_from_slice(&char_count.to_le_bytes());
        hdr[4..8].copy_from_slice(&mask.to_le_bytes());
        hdr[12..14].copy_from_slice(&1u16.to_le_bytes());
        hdr[16..18].copy_from_slice(&1u16.to_le_bytes());
        let mut page_def = vec![0u8; 40];
        page_def[0..4].copy_from_slice(&59528u32.to_le_bytes());
        page_def[4..8].copy_from_slice(&84188u32.to_le_bytes());
        let mut secd_hdr = vec![0u8; 38];
        secd_hdr[..4].copy_from_slice(b"dces");
        let mut out = vec![
            (66, 0, hdr),
            (67, 1, text),
            (68, 1, vec![0u8; 8]),
            (69, 1, vec![0u8; 36]),
            (71, 1, secd_hdr),
            (73, 2, page_def),
        ];
        for obj in objects {
            out.extend(obj);
        }
        out
    }

    fn check(orig: &[u8], edited: &[u8]) -> Vec<Finding> {
        compare_with(orig, edited, Mode::Edited, None)
    }

    fn check_with_preview_refresh(orig: &[u8], edited: &[u8]) -> Vec<Finding> {
        let mut pixels = vec![255u8; 724 * 1024 * 3];
        pixels[0] = 0; // non-uniform raster representing rendered page 1
        let raster = PreviewRaster {
            width: 724,
            height: 1024,
            rgb: pixels,
            blank_page: false,
        };
        let refreshed = refresh_previews(orig, edited, Some(&raster)).unwrap();
        let output = refreshed.output.as_deref().unwrap_or(edited);
        compare_with(orig, output, Mode::Edited, refreshed.image.as_deref())
    }

    #[test]
    fn evolved_picture_and_shape_fields_pass_t009() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let pic_orig = vec![
            (
                71,
                1,
                ctrl_header(101, 0x000a_0311, 0, 0, 4000, 3000, "old", b"\xaa\xbb"),
            ),
            (
                76,
                2,
                shape_component_base(b"cip$", 4000, 3000, 4000, 3000, 0, 0),
            ),
            (85, 3, picture_leaf(1, [0, 0, 4000, 3000], b"\x01\x02")),
        ];
        let rect_orig = vec![
            (
                71,
                1,
                ctrl_header(202, 0x000a_0000, 500, 600, 10000, 5000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"cer$", 10000, 5000, 0, 0, 0x112233, Some(0xAABBCC), 9001),
            ),
            (79, 3, rect_leaf(7, 10000, 5000)),
        ];
        // Include a second picture with id=0 (inserted & saved earlier) + textbox shape
        let pic0_orig = vec![
            (
                71,
                1,
                ctrl_header(0, 0x000a_0311, 0, 0, 2000, 1500, "", &[]),
            ),
            (
                76,
                2,
                shape_component_base(b"cip$", 2000, 1500, 2000, 1500, 0, 0),
            ),
            (85, 3, picture_leaf(1, [0, 0, 2000, 1500], &[0; 18])),
        ];
        let orig_sec = wrap_section(vec![pic_orig.clone(), rect_orig.clone(), pic0_orig.clone()]);
        let orig_sec_ref: Vec<_> = orig_sec
            .iter()
            .map(|(t, l, b)| (*t, *l, b.as_slice()))
            .collect();
        let orig_cfb = build_hwp(&di_ref, &orig_sec_ref, b"\x89PNG\r\n\x1a\n123");

        // Mutate pic1 (resize, wrap->floating, move, altText, crop), rect (fill none, outline, rotate, flip, resize), pic0 (resize).
        let pic_edit = vec![
            (
                71,
                1,
                ctrl_header(
                    101,
                    0x002a_0000,
                    1200,
                    1500,
                    6000,
                    4500,
                    "Updated Alt",
                    b"\xaa\xbb",
                ),
            ),
            (
                76,
                2,
                shape_component_base(b"cip$", 4000, 3000, 6000, 4500, 0, 0),
            ),
            (85, 3, picture_leaf(1, [100, 100, 3900, 2900], b"\x01\x02")),
        ];
        let rect_edit = vec![
            (
                71,
                1,
                ctrl_header(202, 0x000a_0001, 0, 0, 14000, 7000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"cer$", 14000, 7000, 3, 45, 0x004455, None, 9001),
            ),
            (79, 3, rect_leaf(7, 14000, 7000)),
        ];
        let pic0_edit = vec![
            (
                71,
                1,
                ctrl_header(0, 0x000a_0311, 0, 0, 3000, 2000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_base(b"cip$", 2000, 1500, 3000, 2000, 0, 0),
            ),
            (85, 3, picture_leaf(1, [0, 0, 2000, 1500], &[0; 18])),
        ];
        let edit_sec = wrap_section(vec![pic_edit, rect_edit, pic0_edit]);
        let edit_sec_ref: Vec<_> = edit_sec
            .iter()
            .map(|(t, l, b)| (*t, *l, b.as_slice()))
            .collect();
        let edit_cfb = build_hwp(&di_ref, &edit_sec_ref, b"\x89PNG\r\n\x1a\n123");

        assert_eq!(check_with_preview_refresh(&orig_cfb, &edit_cfb), vec![]);

        // TextBox (with untouched paragraph) + Ellipse + Line evolution also passes.
        let tbox_orig = vec![
            (
                71,
                1,
                ctrl_header(303, 0x000a_0000, 0, 0, 8000, 4000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"cer$", 8000, 4000, 0, 0, 0, None, 555),
            ),
            (72, 3, vec![1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            (66, 4, vec![0; 22]),
            (79, 3, rect_leaf(0, 8000, 4000)),
        ];
        let ell_orig = vec![
            (
                71,
                1,
                ctrl_header(404, 0x000a_0000, 0, 0, 5000, 5000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"lle$", 5000, 5000, 0, 0, 0, Some(0xFFFFFF), 666),
            ),
            (80, 3, vec![0u8; 60]),
        ];
        let line_orig = vec![
            (
                71,
                1,
                ctrl_header(505, 0x000a_0000, 0, 0, 5000, 100, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"nil$", 5000, 100, 0, 0, 0, None, 777),
            ),
            (78, 3, vec![0u8; 20]),
        ];
        let s1 = wrap_section(vec![tbox_orig, ell_orig, line_orig]);
        let s1_ref: Vec<_> = s1.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let o1 = build_hwp(&di_ref, &s1_ref, b"\x89PNG\r\n\x1a\n123");

        let tbox_edit = vec![
            (
                71,
                1,
                ctrl_header(303, 0x000a_0000, 100, 200, 9000, 4500, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"cer$", 9000, 4500, 0, 0, 0xFF0000, Some(0x112233), 555),
            ),
            (72, 3, vec![1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            (66, 4, vec![0; 22]),
            (79, 3, rect_leaf(0, 9000, 4500)),
        ];
        let ell_edit = vec![
            (
                71,
                1,
                ctrl_header(404, 0x000a_0000, 0, 0, 6000, 6000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"lle$", 6000, 6000, 1, 15, 0x00FF00, Some(0x010203), 666),
            ),
            (80, 3, vec![0u8; 60]),
        ];
        let line_edit = vec![
            (
                71,
                1,
                ctrl_header(505, 0x000a_0000, 0, 0, 7000, 100, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"nil$", 7000, 100, 0, 30, 0x0000FF, None, 777),
            ),
            (78, 3, vec![0u8; 20]),
        ];
        let s2 = wrap_section(vec![tbox_edit, ell_edit, line_edit]);
        let s2_ref: Vec<_> = s2.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let o2 = build_hwp(&di_ref, &s2_ref, b"\x89PNG\r\n\x1a\n123");
        assert_eq!(check_with_preview_refresh(&o1, &o2), vec![]);
    }

    #[test]
    fn header_and_footer_story_object_geometry_is_exactly_owned() {
        fn borrow(rows: &[(u16, u16, Vec<u8>)]) -> Vec<(u16, u16, &[u8])> {
            rows.iter()
                .map(|(tag, level, data)| (*tag, *level, data.as_slice()))
                .collect()
        }

        let original = header_picture_owner(0, 0, 101, 1);
        let moved = header_picture_owner(120, 80, 101, 1);
        let bin_data = [0u8; 1];
        let defs = super::super::insertions::Defs::from([(18, vec![&bin_data[..]])]);
        let before = borrow(&original);
        let after = borrow(&moved);
        assert_eq!(
            super::prove_header_story_edit(&before, &after, &defs).unwrap(),
            vec![101]
        );

        let mut footer_original = original.clone();
        footer_original[0].2[..4].copy_from_slice(b"toof");
        let mut footer_moved = moved.clone();
        footer_moved[0].2[..4].copy_from_slice(b"toof");
        assert_eq!(
            super::prove_header_story_edit(&borrow(&footer_original), &borrow(&footer_moved), &defs)
                .unwrap(),
            vec![101],
            "a picture move is accepted only within the exact footer owner"
        );
        let mut wrong_story = footer_moved.clone();
        wrong_story[0].2[..4].copy_from_slice(b"daeh");
        assert!(
            super::prove_header_story_edit(&borrow(&footer_original), &borrow(&wrong_story), &defs)
                .is_err(),
            "the same picture cannot move between footer and header stories"
        );

        let mut omitted_description = original.clone();
        omitted_description[2].2 = ctrl_header(101, 0x000a_0311, 0, 0, 4000, 3000, "", &[]);
        omitted_description[2].2.truncate(44);
        let mut canonicalized = moved.clone();
        canonicalized[2].2 = ctrl_header(101, 0x000a_0311, 120, 80, 4000, 3000, "", &[]);
        assert_eq!(
            super::prove_header_story_edit(&borrow(&omitted_description), &borrow(&canonicalized), &defs).unwrap(),
            vec![101],
            "RHWP's explicit empty description preserves the source's omitted empty field"
        );

        let mut body_text = moved.clone();
        body_text[2].2[0] = b'X';
        assert!(super::prove_header_story_edit(&before, &borrow(&body_text), &defs).is_err());

        let mut other_owner = moved.clone();
        other_owner[0].2[..4].copy_from_slice(b"toof");
        assert!(super::prove_header_story_edit(&before, &borrow(&other_owner), &defs).is_err());

        let mut replaced_media = moved.clone();
        replaced_media[4].2[71..73].copy_from_slice(&2u16.to_le_bytes());
        assert!(super::prove_header_story_edit(&before, &borrow(&replaced_media), &defs).is_err());

        let mut changed_description = moved.clone();
        changed_description[2].2 = ctrl_header(101, 0x000a_0311, 120, 80, 4000, 3000, "x", b"\xaa\xbb");
        assert!(super::prove_header_story_edit(&before, &borrow(&changed_description), &defs).is_err());

        let rectangle_owner = |x: i32, y: i32| {
            let mut owner = vec![0u8; 16];
            owner[..4].copy_from_slice(b"daeh");
            let mut paragraph = vec![0u8; 22];
            paragraph[0..4].copy_from_slice(&1u32.to_le_bytes());
            vec![
                (71, 1, owner),
                (66, 2, paragraph),
                (71, 3, ctrl_header(606, 0x000a_0000, x, y, 4000, 3000, "", b"")),
                (76, 4, shape_component_drawing(b"cer$", 4000, 3000, 0, 0, 0x004455, None, 901)),
                (79, 5, rect_leaf(7, 4000, 3000)),
            ]
        };
        let rectangle = rectangle_owner(0, 0);
        let rectangle_moved = rectangle_owner(120, 80);
        assert_eq!(
            super::prove_header_story_edit(&borrow(&rectangle), &borrow(&rectangle_moved), &defs).unwrap(),
            vec![606],
            "an existing non-picture GSO shape can change only within its exact story owner"
        );
        let mut rectangle_other_story = rectangle_moved.clone();
        rectangle_other_story[0].2[..4].copy_from_slice(b"toof");
        assert!(super::prove_header_story_edit(
            &borrow(&rectangle),
            &borrow(&rectangle_other_story),
            &defs,
        ).is_err());
        let mut rectangle_sibling_mutation = rectangle_moved.clone();
        rectangle_sibling_mutation[1].2[4] ^= 1;
        assert!(super::prove_header_story_edit(
            &borrow(&rectangle),
            &borrow(&rectangle_sibling_mutation),
            &defs,
        ).is_err());

        // This supported move contains an opaque nested table story. Every record in that
        // story remains byte-identical while only the owning CTRL_HEADER position changes.
        let nested_box = |x: i32, y: i32| {
            vec![
                (71, 1, {
                    let mut owner = vec![0u8; 16];
                    owner[..4].copy_from_slice(b"daeh");
                    owner
                }),
                (66, 2, vec![0; 22]),
                (71, 3, ctrl_header(707, 0x000a_0000, x, y, 4000, 3000, "", b"")),
                (76, 4, shape_component_drawing(b"cer$", 4000, 3000, 0, 0, 0, None, 902)),
                (72, 5, vec![1; 12]),
                (77, 6, vec![2; 24]),
                (66, 7, vec![3; 22]),
                (67, 8, vec![4; 8]),
                (79, 5, rect_leaf(7, 4000, 3000)),
            ]
        };
        let nested_original = nested_box(0, 0);
        let nested_moved = nested_box(120, 80);
        assert_eq!(
            super::prove_header_story_edit(
                &borrow(&nested_original),
                &borrow(&nested_moved),
                &defs,
            )
            .unwrap(),
            vec![707],
            "a nested table story is retained exactly during a position-only move"
        );
        let mut nested_child_changed = nested_moved.clone();
        nested_child_changed[6].2[0] ^= 1;
        assert!(super::prove_header_story_edit(
            &borrow(&nested_original),
            &borrow(&nested_child_changed),
            &defs,
        )
        .is_err());
        let mut nested_resize = nested_moved.clone();
        // CTRL_HEADER width starts at byte 16; resizing is outside the narrow fallback.
        nested_resize[2].2[16..20].copy_from_slice(&4001u32.to_le_bytes());
        assert!(super::prove_header_story_edit(
            &borrow(&nested_original),
            &borrow(&nested_resize),
            &defs,
        )
        .is_err());
        let mut nested_reidentified = nested_moved.clone();
        nested_reidentified[2].2[36..40].copy_from_slice(&708u32.to_le_bytes());
        assert!(super::prove_header_story_edit(
            &borrow(&nested_original),
            &borrow(&nested_reidentified),
            &defs,
        )
        .is_err());
        let locked_original = {
            let mut rows = nested_original.clone();
            rows[2].2[4..8].copy_from_slice(&(1u32 << 30).to_le_bytes());
            rows
        };
        let locked_moved = {
            let mut rows = nested_moved.clone();
            rows[2].2[4..8].copy_from_slice(&(1u32 << 30).to_le_bytes());
            rows
        };
        assert!(super::prove_header_story_edit(
            &borrow(&locked_original),
            &borrow(&locked_moved),
            &defs,
        )
        .is_err());
        let mut nested_out_of_range = nested_moved;
        nested_out_of_range[2].2[8..12].copy_from_slice(&2_000_001i32.to_le_bytes());
        assert!(super::prove_header_story_edit(
            &borrow(&nested_original),
            &borrow(&nested_out_of_range),
            &defs,
        )
        .is_err());
    }

    #[test]
    fn source_scaled_hwp_picture_rendering_is_bound_to_object_geometry() {
        let mut raw = 1u16.to_le_bytes().to_vec();
        for value in [
            1.0f64,
            0.0,
            -8917.0,
            0.0,
            1.0,
            -430.0,
            9367.0 / 30000.0,
            0.0,
            8917.0,
            0.0,
            4559.0 / 20000.0,
            430.0,
            1.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
        ] {
            raw.extend_from_slice(&value.to_le_bytes());
        }
        let offset = [-8917, -430];
        assert!(super::matches_scaled_source_rendering(
            &raw,
            offset,
            [30000, 20000],
            [9367, 4559]
        ));
        assert!(!super::matches_scaled_source_rendering(
            &raw,
            [-8916, -430],
            [30000, 20000],
            [9367, 4559]
        ));
        assert!(!super::matches_scaled_source_rendering(
            &raw,
            offset,
            [30000, 20000],
            [9366, 4559]
        ));
    }

    #[test]
    fn picture_geometry_and_rendering_are_bound_in_t009() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let file = |records| {
            let sec = wrap_section(vec![records]);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };
        let mut base = vec![
            (
                71,
                1,
                ctrl_header(101, 0x000a_0311, 0, 0, 4000, 3000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_base(b"cip$", 4000, 3000, 4000, 3000, 0, 0),
            ),
            (85, 3, picture_leaf(1, [0, 0, 4000, 3000], &[])),
        ];
        base[1].2[8..12].copy_from_slice(&125i32.to_le_bytes());
        let original = file(base.clone());
        let mut resized = base.clone();
        resized[0].2[16..20].copy_from_slice(&5000u32.to_le_bytes());
        resized[0].2[20..24].copy_from_slice(&4500u32.to_le_bytes());
        resized[1].2[28..32].copy_from_slice(&5000u32.to_le_bytes());
        resized[1].2[32..36].copy_from_slice(&4500u32.to_le_bytes());
        resized[1].2[68..76].copy_from_slice(&125f64.to_le_bytes());
        assert_eq!(
            check_with_preview_refresh(&original, &file(resized.clone())),
            vec![]
        );

        for (label, record, offset, bytes) in [
            ("header width only", 0, 16, 6000u32.to_le_bytes().to_vec()),
            (
                "unrelated current width",
                1,
                28,
                6000u32.to_le_bytes().to_vec(),
            ),
            (
                "unrelated current height",
                1,
                32,
                1u32.to_le_bytes().to_vec(),
            ),
            ("original width", 1, 20, 4001u32.to_le_bytes().to_vec()),
            (
                "overflowed header dimension",
                0,
                16,
                u32::MAX.to_le_bytes().to_vec(),
            ),
            ("zero current dimension", 1, 28, 0u32.to_le_bytes().to_vec()),
            ("rotation center", 1, 42, 2500i32.to_le_bytes().to_vec()),
            ("translation", 1, 68, 126f64.to_le_bytes().to_vec()),
            ("scale", 1, 100, 1.1f64.to_le_bytes().to_vec()),
            (
                "finite rotation entry",
                1,
                156,
                0.5f64.to_le_bytes().to_vec(),
            ),
            ("matrix count", 1, 50, 2u16.to_le_bytes().to_vec()),
            ("NaN", 1, 52, f64::NAN.to_le_bytes().to_vec()),
            ("infinity", 1, 52, f64::INFINITY.to_le_bytes().to_vec()),
        ] {
            let mut edited = resized.clone();
            edited[record].2[offset..offset + bytes.len()].copy_from_slice(&bytes);
            assert!(
                !check_with_preview_refresh(&original, &file(edited)).is_empty(),
                "{label}"
            );
        }
        let mut reordered = resized.clone();
        reordered[1].2[52..148].rotate_left(48);
        assert!(!check_with_preview_refresh(&original, &file(reordered)).is_empty());
        let mut truncated = resized.clone();
        truncated[1].2.pop();
        assert!(!check_with_preview_refresh(&original, &file(truncated)).is_empty());
        let mut appended = resized.clone();
        appended[1].2.push(0);
        assert!(!check_with_preview_refresh(&original, &file(appended)).is_empty());

        // A bit-only caption marker must fail even without a LIST_HEADER subtree.
        base[0].2[7] |= 0x20;
        let captioned = file(base.clone());
        assert_eq!(check(&captioned, &captioned), vec![]);
        let mut introduced = resized.clone();
        introduced[0].2[7] |= 0x20;
        assert!(!check_with_preview_refresh(&original, &file(introduced)).is_empty());
        assert!(!check_with_preview_refresh(&captioned, &file(resized.clone())).is_empty());
        resized[0].2[7] |= 0x20;
        assert!(!check_with_preview_refresh(&captioned, &file(resized)).is_empty());
        base[0].2[12..16].copy_from_slice(&50i32.to_le_bytes());
        assert!(!check_with_preview_refresh(&captioned, &file(base)).is_empty());
    }

    // Replace a selected record in a real engine-produced CFB without changing
    // other semantic records, resource streams, or the compression mode.
    fn mutate_body_record(
        file: &[u8],
        pick: impl Fn(u16, u16, &[u8]) -> bool,
        edit: impl FnOnce(&[u8]) -> Vec<u8>,
    ) -> Vec<u8> {
        use std::io::Read;

        let mut cf = cfb::CompoundFile::open(Cursor::new(file.to_vec())).unwrap();
        let mut header = Vec::new();
        cf.open_stream("FileHeader")
            .unwrap()
            .read_to_end(&mut header)
            .unwrap();
        let compressed = header[36] & 1 != 0;
        let path = "BodyText/Section0";
        let mut raw = Vec::new();
        let stream = cf.open_stream(path).unwrap();
        if compressed {
            flate2::read::DeflateDecoder::new(stream)
                .read_to_end(&mut raw)
                .unwrap();
        } else {
            let mut stream = stream;
            stream.read_to_end(&mut raw).unwrap();
        }
        let mut rows = super::super::records(&raw).unwrap();
        let (_, _, payload) = rows
            .iter_mut()
            .find(|(tag, level, data)| pick(*tag, *level, data))
            .unwrap();
        let changed = edit(payload);
        *payload = &changed;
        let raw = pack_records(&rows);
        let raw = if compressed {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&raw).unwrap();
            encoder.finish().unwrap()
        } else {
            raw
        };
        cf.create_stream(path).unwrap().write_all(&raw).unwrap();
        cf.into_inner().into_inner()
    }

    #[test]
    #[ignore = "Release-WASM 64-paragraph caption boundary fixture"]
    fn release_hwp_caption_boundary_preservation() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let original = std::fs::read(dir.join("p5-boundary-original.hwp")).unwrap();
        let edited = std::fs::read(dir.join("p5-boundary-edited.hwp")).unwrap();
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the HWP owned picture caption scenario first"]
    fn release_hwp_picture_caption_preserves_owner_and_number_slot() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p5-caption-original.hwp");
        let edited = read("p5-caption-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        let picture = |tag, level, data: &[u8]| tag == 71 && level == 1 && data.starts_with(super::CTRL_GSO);
        let cases: [(fn(u16, u16, &[u8]) -> bool, usize); 5] = [
            (picture, 16),
            (|t, l, _| t == 72 && l == 2, 4),
            (|t, l, _| t == 67 && l == 3, 4),
            (|t, l, bytes| t == 71 && l == 3 && bytes.starts_with(b"onta"), 8),
            (|t, l, _| t == 85 && l == 3, 71),
        ];
        for (pick, offset) in cases {
            let tampered = mutate_body_record(&edited, pick, |data| {
                let mut changed = data.to_vec();
                changed[offset] ^= 1;
                changed
            });
            assert!(check_with_preview_refresh(&original, &tampered)
                .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
        }
        let lock = |header: &[u8]| {
            let mut changed = header.to_vec();
            changed[7] |= 0x40;
            changed
        };
        let locked = mutate_body_record(&original, picture, lock);
        let locked_edit = mutate_body_record(&edited, picture, lock);
        assert!(check_with_preview_refresh(&locked, &locked_edit)
            .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the HWP polygon outline scenario first"]
    fn release_hwp_polygon_outline_preserves_geometry() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p3-polygon-original.hwp");
        let edited = read("p3-polygon-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        let component = |tag, level, data: &[u8]| tag == 76 && level == 2 && data.starts_with(super::SC_POLYGON);
        let vertices = |tag, level, _: &[u8]| tag == super::TAG_POLYGON && level == 3;
        let cases: [(fn(u16, u16, &[u8]) -> bool, usize); 4] = [
            (vertices, 4), (component, 20), (component, 200), (component, 204),
        ];
        for (pick, offset) in cases {
            let tampered = mutate_body_record(&edited, pick, |data| {
                let mut changed = data.to_vec();
                if offset == 200 {
                    changed[offset..offset+4].copy_from_slice(&7201u32.to_le_bytes());
                } else {
                    changed[offset] ^= 1;
                }
                changed
            });
            assert!(check_with_preview_refresh(&original, &tampered)
                .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the HWP polygon/curve geometry scenario first"]
    fn release_hwp_polygon_and_curve_geometry_preserves_vertices() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p3-poly-curve-original.hwp");
        let edited = read("p3-poly-curve-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        let curve = |tag, level, _: &[u8]| tag == super::TAG_CURVE && level == 3;
        let tampered_curve = mutate_body_record(&edited, curve, |data| {
            let mut changed = data.to_vec();
            changed[4] ^= 1;
            changed
        });
        assert!(check_with_preview_refresh(&original, &tampered_curve)
            .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
    }

    #[test]
    #[ignore = "Release-WASM HWP5 polygon source, point move, edge split and join fixtures"]
    fn release_stage3a_hwp5_polygon_preserves_cfb_records() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(format!("a-p4-hwp5-polygon-{name}.hwp"))).unwrap();
        let source = read("original");
        let moved = read("moved");
        let split = read("split");
        let joined = read("joined");
        assert_eq!(check_with_preview_refresh(&source, &moved), vec![]);
        assert_eq!(check_with_preview_refresh(&source, &split), vec![]);
        assert_eq!(check_with_preview_refresh(&split, &joined), vec![]);

        let polygon = |tag, level, _: &[u8]| tag == super::TAG_POLYGON && level == 3;
        for (offset, value) in [(4 + 3 * 8 + 4, 3901i32), (4 + 5 * 8, 1), (4, -1)] {
            let tampered = mutate_body_record(&split, polygon, |data| {
                let mut changed = data.to_vec();
                changed[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
                changed
            });
            assert!(check_with_preview_refresh(&source, &tampered)
                .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
        }
        let comp = |tag, level, data: &[u8]| tag == 76 && level == 2 && data.starts_with(b"lop$lop$");
        let translated = |data: &[u8]| {
            let mut changed = data.to_vec();
            changed[8] = 1;
            changed
        };
        assert!(check_with_preview_refresh(
            &mutate_body_record(&source, comp, translated),
            &mutate_body_record(&moved, comp, translated),
        ).iter().any(|f| f.part.as_deref() == Some(super::BODY)));
    }

    #[test]
    #[ignore = "Builds an open HWP5 cubic and line fixture from the existing Stage 3 shape fixture"]
    fn prepare_stage3a_hwp_curve_fixture() {
        let directory = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let original = std::fs::read(directory.join("p3-poly-curve-original.hwp")).unwrap();
        let points = [(0, 2000), (2500, 1000), (4300, 6300), (8100, 5800), (10000, 4200)];
        let path = cubic_fixture_leaf(&points, &[1, 0]);
        let candidate = mutate_body_record(
            &original, |tag, level, _| tag == super::TAG_CURVE && level == 3, |_| path,
        );
        std::fs::write(directory.join("a-p4-curve-original.hwp"), &candidate).unwrap();
        let translated = mutate_p4_cubic_component(&candidate, 68, &9000.0f64.to_le_bytes());
        std::fs::write(directory.join("a-p4-curve-translated.hwp"), translated).unwrap();
        let unmodeled_padding = mutate_body_record(
            &candidate,
            |tag, level, _| tag == super::TAG_CURVE && level == 3,
            |data| {
                let mut changed = data.to_vec();
                *changed.last_mut().unwrap() = 1;
                changed
            },
        );
        std::fs::write(directory.join("a-p4-curve-unmodeled.hwp"), unmodeled_padding).unwrap();

        let mut points = points.to_vec();
        points.extend([(10200, 2800), (9900, 1100), (8400, 900)]);
        let curve = |tag, level, _: &[u8]| tag == super::TAG_CURVE && level == 3;
        let interior = mutate_body_record(&original, curve, |_| cubic_fixture_leaf(&points, &[1, 0, 1]));
        std::fs::write(directory.join("a-p4-curve-interior-original.hwp"), interior).unwrap();
    }

    fn cubic_fixture_leaf(points: &[(i32, i32)], commands: &[u8]) -> Vec<u8> {
        let count = points.len();
        let mut leaf = (count as u32).to_le_bytes().to_vec();
        for (x, y) in points {
            leaf.extend(x.to_le_bytes());
            leaf.extend(y.to_le_bytes());
        }
        leaf.extend(commands);
        leaf.resize(4 + 8 * count + count - 1 + 4, 0);
        leaf
    }

    #[test]
    fn stage3a_interior_line_proof_preserves_cubics_and_turns() {
        let prefix = [(100, 100), (200, 200), (300, 300), (400, 400)];
        let leaf = |tail: &[(i32, i32)], commands: &[u8]| {
            cubic_fixture_leaf(&[prefix.as_slice(), tail].concat(), commands)
        };
        let old = leaf(&[(600, 400), (650, 350), (600, 200), (550, 100), (500, 100)], &[1, 0, 1, 0]);
        let edited = leaf(&[(500, 400), (600, 400), (650, 350), (600, 200), (550, 100), (440, 100)], &[1, 0, 0, 1, 0]);
        assert!(super::prove_cubic_leaf_edit(&old, &edited, 2000, 2000));
        for tail in [
            [(500, 401), (600, 400), (650, 350), (600, 200), (550, 100), (440, 100)],
            [(620, 400), (600, 400), (650, 350), (600, 200), (550, 100), (440, 100)],
            [(500, 400), (600, 400), (651, 350), (600, 200), (550, 100), (440, 100)],
        ] {
            assert!(!super::prove_cubic_leaf_edit(&old, &leaf(&tail, &[1, 0, 0, 1, 0]), 2000, 2000));
        }
    }

    #[test]
    fn stage3a_cubic_segment_proof_allows_one_owned_cubic_and_preserves_neighbors() {
        let old = cubic_fixture_leaf(&[(0, 0), (10, 5), (20, 10), (30, 15), (40, 15)], &[1, 0]);
        let inserted = cubic_fixture_leaf(
            &[(0, 0), (10, 5), (20, 10), (30, 15), (34, 17), (38, 17), (42, 15), (40, 15)],
            &[1, 1, 0],
        );
        assert!(super::prove_cubic_leaf_edit(&old, &inserted, 100, 100));
        assert!(super::prove_cubic_leaf_edit(&inserted, &old, 100, 100));

        let changed_neighbor = cubic_fixture_leaf(
            &[(0, 0), (10, 5), (20, 10), (30, 15), (34, 17), (38, 17), (42, 15), (41, 15)],
            &[1, 1, 0],
        );
        let inserted_line = cubic_fixture_leaf(
            &[(0, 0), (10, 5), (20, 10), (30, 15), (35, 20), (40, 15)],
            &[1, 0, 0],
        );
        assert!(!super::prove_cubic_leaf_edit(&old, &changed_neighbor, 100, 100));
        assert!(!super::prove_cubic_leaf_edit(&old, &inserted_line, 100, 100));
    }

    #[test]
    #[ignore = "Release-WASM HWP5 interior line split and join fixtures"]
    fn release_stage3a_hwp_cubic_interior_line_reopens() {
        let directory = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |filename| std::fs::read(directory.join(filename)).unwrap();
        let source = read("a-p4-curve-interior-original.hwp");
        let split = read("a-p4-curve-interior-split.hwp");
        let joined = read("a-p4-curve-interior-joined.hwp");
        assert_eq!(check_with_preview_refresh(&source, &split), vec![]);
        assert_eq!(check_with_preview_refresh(&split, &joined), vec![]);
        assert_eq!(check_with_preview_refresh(&source, &joined), vec![]);
    }

    #[test]
    #[ignore = "Release-WASM HWP5 cubic insertion and removal fixtures"]
    fn release_stage3a_hwp_cubic_segment_reopens() {
        let directory = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let source = std::fs::read(directory.join("a-p4-curve-interior-original.hwp")).unwrap();
        let inserted = std::fs::read(directory.join("a-p4-curve-cubic-inserted.hwp")).unwrap();
        let removed = std::fs::read(directory.join("a-p4-curve-cubic-removed.hwp")).unwrap();
        assert_eq!(check_with_preview_refresh(&source, &inserted), vec![]);
        assert_eq!(check_with_preview_refresh(&inserted, &removed), vec![]);
        assert_eq!(check_with_preview_refresh(&source, &removed), vec![]);
    }

    fn mutate_p4_cubic_component(bytes: &[u8], offset: usize, replacement: &[u8]) -> Vec<u8> {
        mutate_body_record(
            bytes,
            |tag, level, data| {
                tag == super::TAG_SHAPE_COMPONENT && level == 2 && data.starts_with(b"ruc$ruc$")
            },
            |data| {
                let mut changed = data.to_vec();
                changed[offset..offset + replacement.len()].copy_from_slice(replacement);
                changed
            },
        )
    }

    #[test]
    #[ignore = "Release-WASM HWP5 editable cubic path and published fixture"]
    fn release_stage3a_hwp_cubic_preserves_segment_structure() {
        let directory = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let original = std::fs::read(directory.join("a-p4-path-transform-h5-original.hwp")).unwrap();
        let output = std::fs::read(directory.join("a-p4-path-transform-h5-edited.hwp")).unwrap();
        assert_eq!(check_with_preview_refresh(&original, &output), vec![]);
        let curve = |tag, level, _: &[u8]| tag == super::TAG_CURVE && level == 3;
        for (offset, value) in [(0, 9), (68, 2), (75, 1)] {
            let tampered = mutate_body_record(&output, curve, |data| {
                let mut bytes = data.to_vec();
                bytes[offset] = value;
                bytes
            });
            assert!(check_with_preview_refresh(&original, &tampered)
                .iter().any(|finding| finding.part.as_deref() == Some(super::BODY)));
        }
        // The accepted fixture carries a centered 30-degree rotation, modeled
        // horizontal flip, and nonzero owner/component offsets. Rendering
        // matrices are still identity and identical around the single leaf edit.
        // A nonidentity matrix, unsupported component offset, or changed owner
        // transform remains refused.
        let translation = 9000.0f64.to_le_bytes();
        let translated_original = mutate_p4_cubic_component(&original, 68, &translation);
        let translated_output = mutate_p4_cubic_component(&output, 68, &translation);
        assert!(check_with_preview_refresh(&translated_original, &translated_output)
            .iter().any(|finding| finding.part.as_deref() == Some(super::BODY)));
        let oversized_original = mutate_p4_cubic_component(&original, 8, &2000001i32.to_le_bytes());
        let oversized_output = mutate_p4_cubic_component(&output, 8, &2000001i32.to_le_bytes());
        assert!(check_with_preview_refresh(&oversized_original, &oversized_output)
            .iter().any(|finding| finding.part.as_deref() == Some(super::BODY)));
        let both_flips_original = mutate_p4_cubic_component(&original, 36, &3u32.to_le_bytes());
        let both_flips_output = mutate_p4_cubic_component(&output, 36, &3u32.to_le_bytes());
        assert_eq!(check_with_preview_refresh(&both_flips_original, &both_flips_output), vec![]);
        for (offset, replacement) in [
            (8, &15001i32.to_le_bytes()[..]),
            (36, &524293u32.to_le_bytes()[..]),
            (40, &31i16.to_le_bytes()[..]),
        ] {
            let tampered = mutate_p4_cubic_component(&output, offset, replacement);
            assert!(check_with_preview_refresh(&original, &tampered)
                .iter().any(|finding| finding.part.as_deref() == Some(super::BODY)));
        }
        for (offset, replacement) in [
            (40, &361i16.to_le_bytes()[..]),
            (42, &5401i32.to_le_bytes()[..]),
        ] {
            let unsupported_original = mutate_p4_cubic_component(&original, offset, replacement);
            let unsupported_output = mutate_p4_cubic_component(&output, offset, replacement);
            assert!(check_with_preview_refresh(&unsupported_original, &unsupported_output)
                .iter().any(|finding| finding.part.as_deref() == Some(super::BODY)));
        }
    }

    #[test]
    #[ignore = "Release-WASM HWP5 terminal line append and remove fixtures"]
    fn release_stage3a_hwp_cubic_terminal_line_changes_are_bounded() {
        let directory = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |filename| std::fs::read(directory.join(filename)).unwrap();
        let source = read("a-p4-curve-original.hwp");
        let appended = read("a-p4-curve-line-appended.hwp");
        let removed = read("a-p4-curve-line-removed.hwp");
        assert_eq!(check_with_preview_refresh(&source, &appended), vec![]);
        assert_eq!(check_with_preview_refresh(&appended, &removed), vec![]);
        assert_eq!(check_with_preview_refresh(&source, &removed), vec![]);
        let curve = |tag, level, _: &[u8]| tag == super::TAG_CURVE && level == 3;
        for (offset, mask) in [(0, 1), (12, 1), (53, 1), (55, 1), (60, 1)] {
            let tampered = mutate_body_record(&appended, curve, |data| {
                let mut changed = data.to_vec();
                changed[offset] ^= mask;
                changed
            });
            assert!(check_with_preview_refresh(&source, &tampered)
                .iter().any(|finding| finding.part.as_deref() == Some(super::BODY)),
                "accepted a tampered count, point, command or padding at {offset}");
        }
        let shifted = mutate_p4_cubic_component(&appended, 8, &15001i32.to_le_bytes());
        assert!(check_with_preview_refresh(&source, &shifted)
            .iter().any(|finding| finding.part.as_deref() == Some(super::BODY)));
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the HWP picture position preset scenario first"]
    fn release_hwp_picture_position_preserves_resources_and_alignment_contract() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p3-position-original.hwp");
        let edited = read("p3-position-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        let picture = |tag, level, data: &[u8]| {
            tag == 71 && level == 1 && data.starts_with(super::CTRL_GSO)
                && super::dword(data, 16) == Ok(3600)
        };
        for (offset, mask) in [(4, 8), (4, 0x80), (12, 1), (20, 1), (28, 1)] {
            let tampered = mutate_body_record(&edited, picture, |data| {
                let mut changed = data.to_vec();
                changed[offset] ^= mask;
                changed
            });
            assert!(check_with_preview_refresh(&original, &tampered)
                .iter().any(|f| f.part.as_deref() == Some(super::BODY)),
                "accepted unauthorized picture placement field at {offset}");
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the existing HWP shape reorder scenario first"]
    fn release_hwp_basic_shape_layer_preserves_owned_records() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p3-layer-original.hwp");
        let edited = read("p3-layer-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        let shape = |tag, level, data: &[u8]| tag == 71 && level == 1 && data.starts_with(super::CTRL_GSO);
        let leaf = |tag, level, _: &[u8]| tag == 80 && level == 3;
        for (pick, offset, value) in [(shape as fn(u16, u16, &[u8]) -> bool, 24, 1000u32), (leaf, 8, 1)] {
            let tampered = mutate_body_record(&edited, pick, |data| {
                let mut changed = data.to_vec();
                changed[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
                changed
            });
            assert!(check_with_preview_refresh(&original, &tampered)
                .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
        }
        let locked = |data: &[u8]| {
            let mut changed = data.to_vec();
            changed[7] |= 0x40;
            changed
        };
        let original = mutate_body_record(&original, shape, locked);
        let edited = mutate_body_record(&edited, shape, locked);
        assert!(check_with_preview_refresh(&original, &edited)
            .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the HWP table-cell picture resize scenario first"]
    fn release_hwp_cell_picture_resize_preserves_table_and_resource() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p2-cell-picture-original.hwp");
        let edited = read("p2-cell-picture-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        let table = |tag, level, data: &[u8]| tag == 71 && level == 1 && data.starts_with(b" lbt");
        let picture = |tag, level, data: &[u8]| tag == 71 && level == 3 && data.starts_with(super::CTRL_GSO);
        let leaf = |tag, level, _: &[u8]| tag == 85 && level == 5;
        let cases: [(fn(u16, u16, &[u8]) -> bool, usize, u8); 5] = [
            (table, 20, 1),
            (table, 7, 0x40),
            (picture, 36, 1),
            (leaf, 71, 1),
            (|tag, level, data| tag == 67 && level == 3 && data.starts_with(b"s\0i\0"), 0, 1),
        ];
        for (pick, offset, mask) in cases {
            let tampered = mutate_body_record(&edited, pick, |data| {
                let mut changed = data.to_vec();
                changed[offset] ^= mask;
                changed
            });
            assert!(
                check_with_preview_refresh(&original, &tampered)
                    .iter()
                    .any(|f| f.part.as_deref() == Some(super::BODY)),
                "accepted tampered table/picture record at offset {offset}"
            );
        }
        for (pick, mask) in [(table as fn(u16, u16, &[u8]) -> bool, 0x40), (picture, 0x40), (picture, 0)] {
            let set_protection = |data: &[u8]| {
                let mut changed = data.to_vec();
                changed[7] |= mask;
                if mask == 0 { changed[6] |= 0x10; } // independent size protection
                changed
            };
            let original = mutate_body_record(&original, pick, set_protection);
            let edited = mutate_body_record(&edited, pick, set_protection);
            assert!(check_with_preview_refresh(&original, &edited)
                .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the P2 nested cell picture scenario first"]
    fn release_hwp_nested_cell_picture_resize_preserves_tables_and_resource() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p2-nested-cell-picture-original.hwp");
        let edited = read("p2-nested-cell-picture-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);

        let outer_table = |tag: u16, level: u16, data: &[u8]| tag == 71 && level == 1 && data.starts_with(b" lbt");
        let inner_table = |tag: u16, level: u16, data: &[u8]| tag == 71 && level == 3 && data.starts_with(b" lbt");
        let picture = |tag: u16, level: u16, data: &[u8]| tag == 71 && level == 5 && data.starts_with(super::CTRL_GSO);
        let leaf = |tag: u16, level: u16, _: &[u8]| tag == 85 && level == 7;
        for (pick, offset, mask) in [
            (outer_table as fn(u16, u16, &[u8]) -> bool, 20, 1u8),
            (inner_table, 20, 1),
            (picture, 36, 1),
            (leaf, 71, 1),
            (|tag: u16, level: u16, data: &[u8]| tag == 67 && level == 5 && data.starts_with(b"d\0e\0"), 0, 1),
        ] {
            let tampered = mutate_body_record(&edited, pick, |data| {
                let mut changed = data.to_vec();
                changed[offset] ^= mask;
                changed
            });
            assert!(
                check_with_preview_refresh(&original, &tampered)
                    .iter()
                    .any(|f| f.part.as_deref() == Some(super::BODY)),
                "accepted tampered nested table/picture record at offset {offset}"
            );
        }
        for pick in [inner_table as fn(u16, u16, &[u8]) -> bool, picture] {
            let set_locked = |data: &[u8]| {
                let mut changed = data.to_vec();
                changed[7] |= 0x40;
                changed
            };
            let locked_orig = mutate_body_record(&original, pick, set_locked);
            let locked_edit = mutate_body_record(&edited, pick, set_locked);
            assert!(
                check_with_preview_refresh(&locked_orig, &locked_edit)
                    .iter()
                    .any(|f| f.part.as_deref() == Some(super::BODY))
            );
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the combined HWP outline width scenario first"]
    fn release_hwp_inserted_shape_accepts_only_solid_outline_width() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("combined-outline-original.hwp");
        let edited = read("combined-outline-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);

        let component = |tag, level, data: &[u8]| {
            tag == 76 && level == 2 && data.starts_with(b"cer$cer$")
        };
        for (offset, value) in [
            (200, 0u32),
            (200, 7201),
            (204, 0xd100_0042),
            (28, 10801),
            (196, 1),
        ] {
            let tampered = mutate_body_record(&edited, component, |data| {
                let mut changed = data.to_vec();
                changed[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
                changed
            });
            assert!(
                check_with_preview_refresh(&original, &tampered)
                    .iter()
                    .any(|f| f.part.as_deref() == Some(super::BODY)),
                "accepted unauthorized component value {value} at offset {offset}"
            );
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the P3 solid outline width scenario first"]
    fn release_hwp_p3_solid_outline_width_is_bounded() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let original = std::fs::read(dir.join("p3-width-original.hwp")).unwrap();
        let edited = std::fs::read(dir.join("p3-width-edited.hwp")).unwrap();
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        let pick = |tag, level, data: &[u8]| tag == 76 && level == 2 && data.starts_with(b"cer$cer$");
        for (at, bytes) in [(200, 7201u32.to_le_bytes()), (204, 0xd100_0042u32.to_le_bytes())] {
            let tampered = mutate_body_record(&edited, pick, |data| {
                let mut changed = data.to_vec();
                changed[at..at + 4].copy_from_slice(&bytes);
                changed
            });
            assert!(check_with_preview_refresh(&original, &tampered).iter()
                .any(|f| f.part.as_deref() == Some(super::BODY)));
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the multi-paragraph HWP text-box scenario first"]
    fn release_hwp_existing_textbox_paragraphs_preserve_story_structure() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p2-multipara-original.hwp");
        let edited = read("p2-multipara-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        for (tag, level, offset, mask) in [(72, 3, 0, 1), (79, 3, 1, 1), (71, 1, 36, 1)] {
            let tampered = mutate_body_record(
                &edited,
                |t, l, data| t == tag && l == level && (t != 71 || data.starts_with(super::CTRL_GSO)),
                |data| {
                    let mut v = data.to_vec();
                    v[offset] ^= mask;
                    v
                },
            );
            assert!(
                check_with_preview_refresh(&original, &tampered)
                    .iter()
                    .any(|f| f.part.as_deref() == Some(super::BODY)),
                "accepted changed text-box record {tag}"
            );
        }
    }

    #[test]
    #[ignore = "Release-WASM HWP5 textbox split/merge fixtures"]
    fn release_hwp5_textbox_split_merge_accepts_only_proven_story_changes() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p5-h5tb-original.hwp");
        let split = read("p5-h5tb-split.hwp");
        let merged = read("p5-h5tb-merged.hwp");

        assert_eq!(check_with_preview_refresh(&original, &split), vec![]);
        assert_eq!(check_with_preview_refresh(&split, &merged), vec![]);
        assert_eq!(check_with_preview_refresh(&original, &merged), vec![]);

        // The same live WASM document exports its original PrvImage after the first save,
        // even though the published source now contains this save's regenerated preview.
        let mut pixels = vec![255u8; 724 * 1024 * 3];
        pixels[0] = 0;
        let raster = PreviewRaster {
            width: 724,
            height: 1024,
            rgb: pixels,
            blank_page: false,
        };
        let first_refresh = refresh_previews(&original, &split, Some(&raster)).unwrap();
        let first_output = first_refresh.output.expect("first split preview rebuilt");
        let first_image = first_refresh.image.expect("first split preview evidence");
        assert!(compare_saved_with_preview(&original, &first_output, Some(&first_image)).is_empty());

        // A second save from that same live engine exports `merged` with the pre-save image.
        // It must replace that stale image with the exact reopened render, then pass the full
        // T009 comparison against the current on-disk split document.
        let second_refresh = refresh_previews(&first_output, &merged, Some(&raster)).unwrap();
        let second_output = second_refresh.output.expect("second merge preview rebuilt");
        let second_image = second_refresh.image.expect("second merge preview evidence");
        assert_eq!(second_image, first_image);
        assert!(compare_saved_with_preview(&first_output, &second_output, Some(&second_image)).is_empty());

        // A changed preview without a body edit is not a save: even a valid render cannot
        // authorize replacing the image when the output has no visual body change.
        let old_image = open(&original, Side::Original).unwrap().streams["PrvImage"].clone();
        let first_container = open(&first_output, Side::Original).unwrap();
        let preview_only_change = rebuild_preview(
            &first_output,
            &first_container,
            &[("PrvImage", old_image.as_slice())],
        )
        .unwrap();
        assert!(refresh_previews(&first_output, &preview_only_change, Some(&raster))
            .unwrap()
            .output
            .is_none());

        let changed_text = mutate_body_record(
            &split,
            |tag, level, data| tag == 67 && level == 4 && data.starts_with(b"e\0"),
            |data| {
                let mut changed = data.to_vec();
                changed[0] = b'x';
                changed
            },
        );
        assert!(
            check_with_preview_refresh(&original, &changed_text)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(super::BODY)),
            "accepted an unauthorized text mutation inside a split textbox"
        );

        let duplicate_paragraph_id = mutate_body_record(
            &split,
            |tag, level, data| {
                tag == 66
                    && level == 3
                    && data.get(18..22) == Some(&[1, 0, 0, 0][..])
            },
            |data| {
                let mut changed = data.to_vec();
                changed[18..22].copy_from_slice(&0u32.to_le_bytes());
                changed
            },
        );
        assert!(
            check_with_preview_refresh(&original, &duplicate_paragraph_id)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(super::BODY)),
            "accepted a split paragraph that reused its owner's paragraph ID"
        );

        let reused_deleted_paragraph_id = mutate_body_record(
            &merged,
            |tag, level, data| tag == 66 && level == 0 && data.len() >= 22,
            |data| {
                let mut changed = data.to_vec();
                changed[18..22].copy_from_slice(&1u32.to_le_bytes());
                changed
            },
        );
        assert!(
            check_with_preview_refresh(&split, &reused_deleted_paragraph_id)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(super::BODY)),
            "accepted reusing the deleted textbox paragraph ID elsewhere"
        );

        let moved_owner = mutate_body_record(
            &split,
            |tag, level, data| tag == 71 && level == 1 && data.starts_with(super::CTRL_GSO),
            |data| {
                let mut changed = data.to_vec();
                changed[12] ^= 1;
                changed
            },
        );
        assert!(refresh_previews(&first_output, &moved_owner, Some(&raster))
            .unwrap()
            .output
            .is_none(), "regenerated preview authorized a textbox geometry mutation");
        assert!(
            check_with_preview_refresh(&original, &moved_owner)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(super::BODY)),
            "accepted a textbox geometry mutation alongside the paragraph split"
        );
    }

    #[test]
    #[ignore = "Release-WASM HWP5 text-box multiline paste fixture"]
    fn release_hwp5_textbox_multiline_paste_accepts_only_proven_reflow() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p5-h5tb-paste-original.hwp");
        let edited = read("p5-h5tb-paste-edited.hwp");

        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);

        let duplicate_paragraph_id = mutate_body_record(
            &edited,
            |tag, level, data| {
                tag == 66 && level == 3 && data.get(18..22) == Some(&[1, 0, 0, 0][..])
            },
            |data| {
                let mut changed = data.to_vec();
                changed[18..22].copy_from_slice(&0u32.to_le_bytes());
                changed
            },
        );
        assert!(
            check_with_preview_refresh(&original, &duplicate_paragraph_id)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(super::BODY)),
            "accepted a new textbox paragraph that reused an existing ID"
        );

        let changed_tail = mutate_body_record(
            &edited,
            |tag, level, data| {
                tag == 66 && level == 3 && data.get(18..22) == Some(&[1, 0, 0, 0][..])
            },
            |data| {
                let mut changed = data.to_vec();
                changed[22] ^= 1;
                changed
            },
        );
        assert!(
            check_with_preview_refresh(&original, &changed_tail)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(super::BODY)),
            "accepted a multiline paste that changed paragraph metadata"
        );

        let changed_owner = mutate_body_record(
            &edited,
            |tag, level, data| tag == 71 && level == 1 && data.starts_with(super::CTRL_GSO),
            |data| {
                let mut changed = data.to_vec();
                changed[12] ^= 1;
                changed
            },
        );
        assert!(
            check_with_preview_refresh(&original, &changed_owner)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(super::BODY)),
            "accepted a multiline paste alongside a textbox geometry mutation"
        );
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the P2 HWP text-box scenario first"]
    fn release_hwp_p2_textbox_edit_preserves_owner_and_structure() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let before = read("p2-hwp-before.hwp");
        let existing = read("p2-hwp-existing.hwp");
        let edited = read("p2-hwp-edited.hwp");
        assert_eq!(check_with_preview_refresh(&before, &edited), vec![]);
        assert_eq!(check_with_preview_refresh(&existing, &edited), vec![]);
        let locked = mutate_body_record(
            &existing,
            |tag, level, data| tag == 71 && level == 1 && data.starts_with(super::CTRL_GSO),
            |data| {
                let mut h = data.to_vec();
                h[7] |= 0x40;
                h
            },
        );
        // Keep the protection bit on both sides so the negative depends on the
        // text edit’s owner, rather than on clearing protection in the output.
        let locked_edit = mutate_body_record(
            &edited,
            |tag, level, data| tag == 71 && level == 1 && data.starts_with(super::CTRL_GSO),
            |data| {
                let mut h = data.to_vec();
                h[7] |= 0x40;
                h
            },
        );
        assert!(
            check_with_preview_refresh(&locked, &locked_edit)
                .iter()
                .any(|f| {
                    f.code == FindingCode::RecordsChanged && f.part.as_deref() == Some(super::BODY)
                })
        );
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the P1 HWP shape insertion scenario first"]
    fn release_hwp_p1_shape_insertions_require_owned_canonical_records() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let original = std::fs::read(dir.join("p1-shapes-original.hwp")).unwrap();
        let edited = std::fs::read(dir.join("p1-shapes-edited.hwp")).unwrap();
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);

        let pickers: [(fn(u16, u16, &[u8]) -> bool, usize); 4] = [
            (|tag, level, _| tag == 78 && level == 3, 8),
            (|tag, level, _| tag == 80 && level == 3, 4),
            (|tag, level, _| tag == 79 && level == 3, 0),
            (|tag, level, _| tag == 72 && level == 3, 0),
        ];
        for (pick, offset) in pickers {
            let tampered = mutate_body_record(&edited, pick, |payload| {
                let mut bytes = payload.to_vec();
                bytes[offset] ^= 1;
                bytes
            });
            assert!(
                check_with_preview_refresh(&original, &tampered)
                    .iter()
                    .any(|finding| finding.part.as_deref() == Some(super::BODY))
            );
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: set GEUL_STAGE3_OUT and run the rotated stage3-picture-size scenario"]
    fn release_hwp_rotated_picture_requires_consistent_source_and_output_matrices() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let orig = std::fs::read(dir.join("rotated-pic-orig.hwp")).unwrap();
        let edit = std::fs::read(dir.join("rotated-pic-edited.hwp")).unwrap();
        assert_eq!(check_with_preview_refresh(&orig, &edit), vec![]);

        let picture =
            |tag, level, data: &[u8]| tag == 76 && level == 2 && data.starts_with(b"cip$cip$");
        for (label, at, value) in [
            ("translation", 68, 42.0f64),
            ("scale", 100, 2.5),
            ("rotation correction", 164, 17.0),
            ("rotation angle mismatch", 148, 0.5),
            ("shear", 108, 0.125),
            ("non-finite", 52, f64::NAN),
        ] {
            let change = |file| {
                mutate_body_record(file, picture, |payload| {
                    let mut changed = payload.to_vec();
                    changed[at..at + 8].copy_from_slice(&value.to_le_bytes());
                    changed
                })
            };
            for findings in [
                check_with_preview_refresh(&change(orig.as_slice()), &edit),
                check_with_preview_refresh(&orig, &change(edit.as_slice())),
            ] {
                assert!(
                    findings.iter().any(|f| f.part.as_deref() == Some(super::BODY)),
                    "{label}: {findings:?}",
                );
            }
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: set GEUL_STAGE3_OUT and run stage3-object-edit.wasm.test.ts first"]
    fn release_hwp_gso_bytes_pass_only_for_proven_edits() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name: &str| std::fs::read(dir.join(format!("{name}.hwp"))).unwrap();
        let original = read("gso-original");
        let edited = read("gso-edited");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        assert_eq!(
            check_with_preview_refresh(&original, &read("gso-deleted")),
            vec![]
        );
        let mutate = |file: &[u8], pick: fn(u16, u16, &[u8]) -> bool, at: usize, bytes: &[u8]| {
            mutate_body_record(file, pick, |payload| {
                let mut changed = payload.to_vec();
                changed[at..at + bytes.len()].copy_from_slice(bytes);
                changed
            })
        };
        let picture =
            |tag, level, data: &[u8]| tag == 76 && level == 2 && data.starts_with(b"cip$cip$");
        for (at, bytes) in [
            (28, 4999u32.to_le_bytes().to_vec()),
            (68, 37f64.to_le_bytes().to_vec()),
        ] {
            let tampered = mutate(&edited, picture, at, &bytes);
            let findings = check_with_preview_refresh(&original, &tampered);
            assert!(
                findings
                    .iter()
                    .any(|f| f.part.as_deref() == Some(super::BODY)),
                "{findings:?}"
            );
        }

        let caption = read("gso-caption");
        assert_eq!(
            check_with_preview_refresh(&caption, &read("gso-caption-unrelated")),
            vec![]
        );
        for name in ["gso-caption-moved", "gso-caption-resized"] {
            assert_eq!(
                check_with_preview_refresh(&caption, &read(name)),
                vec![],
                "{name}"
            );
        }
        // Toggling ATTR_CAPTION off or mutating caption LIST_HEADER / PARA_TEXT must still fail.
        let toggle_caption_attr = mutate_body_record(
            &read("gso-caption-moved"),
            |tag, level, data| tag == 71 && level == 1 && data.starts_with(b" osg"),
            |payload| {
                let mut changed = payload.to_vec();
                changed[7] &= !0x20;
                changed
            },
        );
        assert!(
            !check_with_preview_refresh(&caption, &toggle_caption_attr).is_empty(),
            "ATTR_CAPTION toggle must be rejected"
        );
        for tag in [72, 67] {
            let pick: fn(u16, u16, &[u8]) -> bool = if tag == 72 {
                |tag, level, _| tag == 72 && level == 2
            } else {
                |tag, level, _| tag == 67 && level == 3
            };
            let tampered = mutate(&caption, pick, 4, &[0x7f]);
            assert!(
                !check_with_preview_refresh(&caption, &tampered).is_empty(),
                "caption record {tag}"
            );
            let moved_tampered = mutate(&read("gso-caption-moved"), pick, 4, &[0x7f]);
            assert!(
                !check_with_preview_refresh(&caption, &moved_tampered).is_empty(),
                "moved + caption record {tag}"
            );
        }

        let caption_shape = read("gso-caption-shape");
        let caption_shape_edited = read("gso-caption-shape-edited");
        assert_eq!(
            check_with_preview_refresh(&caption_shape, &caption_shape_edited),
            vec![]
        );
        for (tag, level) in [(72, 2), (67, 3)] {
            let pick = if tag == 72 {
                (|t, l, _| t == 72 && l == 2) as fn(u16, u16, &[u8]) -> bool
            } else {
                (|t, l, _| t == 67 && l == 3) as fn(u16, u16, &[u8]) -> bool
            };
            let _ = level;
            let tampered = mutate(&caption_shape_edited, pick, 4, &[0x7f]);
            assert!(
                !check_with_preview_refresh(&caption_shape, &tampered).is_empty(),
                "captioned shape record {tag}"
            );
        }
    }

    fn rectangle_record(tag: u16, level: u16, _: &[u8]) -> bool {
        (tag, level) == (79, 3)
    }

    fn noncanonical_vertices(leaf: &[u8]) -> Vec<u8> {
        let mut edited = vec![leaf[0]];
        for value in [100i32, 200, 6800, 200, 6800, 3200, 100, 3200] {
            edited.extend_from_slice(&value.to_le_bytes());
        }
        edited
    }

    #[test]
    #[ignore = "Copy the Stage 3 WASM gso-original.hwp to GEUL_RECT_PROOF/canonical.hwp first"]
    fn prepare_rectangle_fixture() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_RECT_PROOF").unwrap());
        let original = std::fs::read(dir.join("canonical.hwp")).unwrap();
        let fixture = mutate_body_record(&original, rectangle_record, noncanonical_vertices);
        std::fs::write(dir.join("noncanonical.hwp"), fixture).unwrap();
    }

    #[test]
    fn rectangle_vertex_edits_require_owned_geometry_in_t009() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let file = |rect| {
            let sec = wrap_section(vec![rect]);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };
        let canonical = vec![
            (
                71,
                1,
                ctrl_header(202, 0x000a_0000, 500, 600, 7200, 3600, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"cer$", 7200, 3600, 0, 0, 0x112233, Some(0xAABBCC), 9001),
            ),
            (79, 3, rect_leaf(7, 7200, 3600)),
        ];
        let canonical_file = file(canonical.clone());
        let mut noncanonical = canonical.clone();
        noncanonical[2].2 = noncanonical_vertices(&canonical[2].2);
        let noncanonical_file = file(noncanonical.clone());
        assert_eq!(check(&noncanonical_file, &noncanonical_file), vec![]);
        for (original, original_file) in [
            (&canonical, &canonical_file),
            (&noncanonical, &noncanonical_file),
        ] {
            let mut edited = original.clone();
            edited[1].2[196..200].copy_from_slice(&0x223344u32.to_le_bytes());
            assert_eq!(
                check_with_preview_refresh(original_file, &file(edited.clone())),
                vec![]
            );
            // Normalize on the unrelated border edit, as the old engine did.
            if original == &noncanonical {
                let mut normalized = edited.clone();
                normalized[2].2.clone_from(&canonical[2].2);
                assert!(!check_with_preview_refresh(original_file, &file(normalized)).is_empty());
            }

            for edit in [
                |leaf: &mut Vec<u8>| leaf[1] ^= 1,
                |leaf: &mut Vec<u8>| leaf[1..17].rotate_left(8),
                |leaf: &mut Vec<u8>| {
                    leaf.pop();
                },
                |leaf: &mut Vec<u8>| leaf.push(0),
                |leaf: &mut Vec<u8>| leaf[0] ^= 1,
            ] {
                let mut invalid = edited.clone();
                edit(&mut invalid[2].2);
                assert!(!check_with_preview_refresh(original_file, &file(invalid)).is_empty());
            }
        }

        let mut resized = canonical.clone();
        resized[0].2[16..20].copy_from_slice(&8200u32.to_le_bytes());
        resized[1].2[28..32].copy_from_slice(&8200u32.to_le_bytes());
        resized[2].2 = rect_leaf(7, 8200, 3600);
        assert_eq!(
            check_with_preview_refresh(&canonical_file, &file(resized.clone())),
            vec![]
        );
        // Unauthorized canonicalization during noncanonical resize must still fail.
        assert!(!check_with_preview_refresh(&noncanonical_file, &file(resized.clone())).is_empty());
        // Proportional scaling preserving unchanged Y axis must pass.
        let mut noncanon_resized_w = noncanonical.clone();
        noncanon_resized_w[0].2[16..20].copy_from_slice(&8200u32.to_le_bytes());
        noncanon_resized_w[1].2[28..32].copy_from_slice(&8200u32.to_le_bytes());
        noncanon_resized_w[2].2 = {
            let mut leaf = vec![7u8];
            for v in [114i32, 200, 7744, 200, 7744, 3200, 114, 3200] {
                leaf.extend_from_slice(&v.to_le_bytes());
            }
            leaf
        };
        assert_eq!(
            check_with_preview_refresh(&noncanonical_file, &file(noncanon_resized_w.clone())),
            vec![]
        );
        // 1-HWPUNIT drift or unchanged-axis mutation must fail.
        let mut drifted = noncanon_resized_w.clone();
        drifted[2].2[1..5].copy_from_slice(&115i32.to_le_bytes());
        assert!(!check_with_preview_refresh(&noncanonical_file, &file(drifted)).is_empty());
        let mut y_mutated = noncanon_resized_w.clone();
        y_mutated[2].2[5..9].copy_from_slice(&201i32.to_le_bytes());
        assert!(!check_with_preview_refresh(&noncanonical_file, &file(y_mutated)).is_empty());
        // Malformed collapsed or out-of-bounds source vertices cannot be resized.
        let mut collapsed_src = noncanonical.clone();
        collapsed_src[2].2 = {
            let mut leaf = vec![7u8];
            for v in [100i32, 200, 100, 200, 100, 3200, 100, 3200] {
                leaf.extend_from_slice(&v.to_le_bytes());
            }
            leaf
        };
        assert!(
            !check_with_preview_refresh(&file(collapsed_src), &file(noncanon_resized_w.clone()))
                .is_empty()
        );
        let mut oob_src = noncanonical.clone();
        oob_src[2].2 = {
            let mut leaf = vec![7u8];
            for v in [0i32, 200, 20_000_000, 200, 20_000_000, 3200, 0, 3200] {
                leaf.extend_from_slice(&v.to_le_bytes());
            }
            leaf
        };
        assert!(!check_with_preview_refresh(&file(oob_src), &file(noncanon_resized_w)).is_empty());

        let mut stale = resized.clone();
        stale[2].2.clone_from(&canonical[2].2);
        assert!(!check_with_preview_refresh(&canonical_file, &file(stale)).is_empty());
        resized[1].2[28..32].copy_from_slice(&8300u32.to_le_bytes());
        assert!(!check_with_preview_refresh(&canonical_file, &file(resized)).is_empty());
    }

    #[test]
    #[ignore = "GEUL_RECT_PROOF: run hwp-rectangle-geometry.mjs on the prepared fixtures first"]
    fn release_hwp_rectangle_geometry() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_RECT_PROOF").unwrap());
        let read = |name: &str| std::fs::read(dir.join(format!("{name}.hwp"))).unwrap();
        for kind in ["canonical", "noncanonical"] {
            let original = read(kind);
            for case in [
                "noop", "border", "fill", "rotate", "move", "width", "height", "both",
            ] {
                let edited = read(&format!("{kind}-{case}"));
                let findings = check_with_preview_refresh(&original, &edited);
                assert!(findings.is_empty(), "{kind}-{case}: {findings:?}");
            }
        }
        // Reconstruct unauthorized canonicalization against a real HWP (both on
        // an unrelated edit and on a resize).
        let source = read("noncanonical");
        let edited = read("noncanonical-border");
        let normalized = mutate_body_record(&edited, rectangle_record, |leaf| {
            rect_leaf(leaf[0], 7200, 3600)
        });
        assert!(
            check_with_preview_refresh(&source, &normalized)
                .contains(&Finding::at(FindingCode::RecordsChanged, super::BODY))
        );
        let resized = read("noncanonical-width");
        let multistep = read("noncanonical-multistep");
        assert_eq!(check_with_preview_refresh(&source, &multistep), vec![]);
        let normalized_resize = mutate_body_record(&resized, rectangle_record, |leaf| {
            rect_leaf(leaf[0], 8200, 3600)
        });
        assert!(!check_with_preview_refresh(&source, &normalized_resize).is_empty());
    }

    #[test]
    fn gso_evolution_rejects_unauthorized_mutations_and_tampering() {
        let di = doc_info_records(2);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let pic_orig = vec![
            (
                71,
                1,
                ctrl_header(101, 0x000a_0311, 0, 0, 4000, 3000, "", b"\xaa"),
            ),
            (
                76,
                2,
                shape_component_base(b"cip$", 4000, 3000, 4000, 3000, 0, 0),
            ),
            (85, 3, picture_leaf(1, [0, 0, 4000, 3000], b"\x05")),
        ];
        let rect_orig = vec![
            (
                71,
                1,
                ctrl_header(202, 0x000a_0000, 0, 0, 10000, 5000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"cer$", 10000, 5000, 0, 0, 0, Some(0x112233), 9001),
            ),
            (72, 3, vec![1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            (66, 4, vec![0; 22]),
            (79, 3, rect_leaf(0, 10000, 5000)),
        ];
        let orig_sec = wrap_section(vec![pic_orig.clone(), rect_orig.clone()]);
        let orig_sec_ref: Vec<_> = orig_sec
            .iter()
            .map(|(t, l, b)| (*t, *l, b.as_slice()))
            .collect();
        let orig_cfb = build_hwp(&di_ref, &orig_sec_ref, b"\x89PNG\r\n\x1a\n123");

        let assert_refused =
            |label: &str, pic: Vec<(u16, u16, Vec<u8>)>, rect: Vec<(u16, u16, Vec<u8>)>| {
                let sec = wrap_section(vec![pic, rect]);
                let sec_ref: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
                let cfb = build_hwp(&di_ref, &sec_ref, b"\x89PNG\r\n\x1a\n123");
                assert!(!check(&orig_cfb, &cfb).is_empty(), "must refuse: {label}");
            };

        // 1. Swapped / changed instance_id
        {
            let mut bad = rect_orig.clone();
            bad[0].2[36..40].copy_from_slice(&999u32.to_le_bytes());
            assert_refused("changed instance_id", pic_orig.clone(), bad);
        }
        // 2. Non-picture shape with id == 0
        {
            let mut r0 = rect_orig.clone();
            r0[0].2[36..40].copy_from_slice(&0u32.to_le_bytes());
            let s0 = wrap_section(vec![r0.clone()]);
            let s0_ref: Vec<_> = s0.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            let o0 = build_hwp(&di_ref, &s0_ref, b"\x89PNG\r\n\x1a\n123");
            let mut r1 = r0;
            r1[0].2[16..20].copy_from_slice(&12000u32.to_le_bytes());
            let s1 = wrap_section(vec![r1]);
            let s1_ref: Vec<_> = s1.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            let o1 = build_hwp(&di_ref, &s1_ref, b"\x89PNG\r\n\x1a\n123");
            assert!(!check(&o0, &o1).is_empty(), "zero-id shape must fail");
        }
        // 3. Unknown attr bit modified
        {
            let mut bad = pic_orig.clone();
            bad[0].2[4] ^= 0x02;
            assert_refused("unknown attr bit", bad, rect_orig.clone());
        }
        // 4. CTRL_HEADER raw_extra changed
        {
            let mut bad = pic_orig.clone();
            *bad[0].2.last_mut().unwrap() ^= 1;
            assert_refused("raw_extra mutated", bad, rect_orig.clone());
        }
        // 5. z_order changed
        {
            let mut bad = rect_orig.clone();
            bad[0].2[24] = 9;
            assert_refused("z_order mutated", pic_orig.clone(), bad);
        }
        // 6. BinData reference repointed to bin 2
        {
            let mut bad = pic_orig.clone();
            bad[2].2[71..73].copy_from_slice(&2u16.to_le_bytes());
            assert_refused("bin_data_id swapped", bad, rect_orig.clone());
        }
        // 7. raw_picture_extra mutated
        {
            let mut bad = pic_orig.clone();
            *bad[2].2.last_mut().unwrap() ^= 1;
            assert_refused("raw_picture_extra mutated", bad, rect_orig.clone());
        }
        // 8. Negative crop
        {
            let mut bad = pic_orig.clone();
            bad[2].2[44..48].copy_from_slice(&(-1i32).to_le_bytes());
            assert_refused("negative crop", bad, rect_orig.clone());
        }
        // 9. original_width mutated in SHAPE_COMPONENT
        {
            let mut bad = rect_orig.clone();
            bad[1].2[20..24].copy_from_slice(&9999u32.to_le_bytes());
            assert_refused("original_width mutated", pic_orig.clone(), bad);
        }
        // 10. drawing inst_id mutated in SHAPE_COMPONENT tail
        {
            let mut bad = rect_orig.clone();
            let at = bad[1].2.len() - 6;
            bad[1].2[at] ^= 1;
            assert_refused("drawing inst_id mutated", pic_orig.clone(), bad);
        }
        // 11. border width mutated
        {
            let mut bad = rect_orig.clone();
            bad[1].2[200] ^= 1;
            assert_refused("border width mutated", pic_orig.clone(), bad);
        }
        // 12. Rectangle round_rate mutated
        {
            let mut bad = rect_orig.clone();
            bad[4].2[0] = 5;
            assert_refused("round_rate mutated", pic_orig.clone(), bad);
        }
        // 13. TextBox paragraph mutated
        {
            let mut bad = rect_orig.clone();
            bad[3].2[0] = 1;
            assert_refused("textbox para mutated", pic_orig.clone(), bad);
        }
        // 14. Unknown extension record (CTRL_DATA 87) injected
        {
            let mut bad = rect_orig.clone();
            bad.insert(2, (87, 2, vec![1, 2, 3, 4]));
            assert_refused("CTRL_DATA injected", pic_orig.clone(), bad);
        }
        // 15. Size-protected GSO resized
        {
            let mut sp = pic_orig.clone();
            sp[0].2[6] |= 0x10; // bit 20 = size_protect
            let s0 = wrap_section(vec![sp.clone()]);
            let s0_ref: Vec<_> = s0.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            let o0 = build_hwp(&di_ref, &s0_ref, b"\x89PNG\r\n\x1a\n123");
            sp[0].2[16..20].copy_from_slice(&5000u32.to_le_bytes());
            sp[1].2[28..32].copy_from_slice(&5000u32.to_le_bytes());
            let s1 = wrap_section(vec![sp]);
            let s1_ref: Vec<_> = s1.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            let o1 = build_hwp(&di_ref, &s1_ref, b"\x89PNG\r\n\x1a\n123");
            assert!(
                !check(&o0, &o1).is_empty(),
                "size-protected resize must fail"
            );
        }
        // 16. Locked GSO (bit 30) mutated
        {
            let mut lk = pic_orig.clone();
            lk[0].2[7] |= 0x40; // bit 30 = lock
            let s0 = wrap_section(vec![lk.clone()]);
            let s0_ref: Vec<_> = s0.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            let o0 = build_hwp(&di_ref, &s0_ref, b"\x89PNG\r\n\x1a\n123");
            lk[0].2[12..16].copy_from_slice(&500i32.to_le_bytes());
            let s1 = wrap_section(vec![lk]);
            let s1_ref: Vec<_> = s1.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            let o1 = build_hwp(&di_ref, &s1_ref, b"\x89PNG\r\n\x1a\n123");
            assert!(!check(&o0, &o1).is_empty(), "locked GSO move must fail");
        }
        // 17. Locked, captioned, opaque, and unknown GSO deletion refused
        {
            let empty_sec = wrap_section(vec![]);
            let empty_ref: Vec<_> = empty_sec
                .iter()
                .map(|(t, l, b)| (*t, *l, b.as_slice()))
                .collect();
            let empty_cfb = build_hwp(&di_ref, &empty_ref, b"\x89PNG\r\n\x1a\n123");

            let mut locked = pic_orig.clone();
            locked[0].2[7] |= 0x40;
            let mut captioned = pic_orig.clone();
            captioned[0].2[7] |= 0x20;
            let mut opaque = rect_orig.clone();
            opaque.insert(2, (87, 2, vec![1, 2, 3, 4]));
            let mut group = rect_orig.clone();
            group[1].2[0..8].copy_from_slice(b" gp$ gp$");
            for (label, obj) in [
                ("locked GSO delete", locked),
                ("captioned GSO delete", captioned),
                ("opaque CTRL_DATA GSO delete", opaque),
                ("group GSO delete", group),
            ] {
                let s = wrap_section(vec![obj]);
                let s_ref: Vec<_> = s.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
                let o = build_hwp(&di_ref, &s_ref, b"\x89PNG\r\n\x1a\n123");
                assert!(
                    !check_with_preview_refresh(&o, &empty_cfb).is_empty(),
                    "{label} must fail"
                );
            }
        }
        // 18. BinData stream bytes mutated
        {
            let tampered_bin = build_hwp(&di_ref, &orig_sec_ref, b"\x89PNG\r\n\x1a\nXXX");
            let findings = check(&orig_cfb, &tampered_bin);
            assert!(findings.contains(&Finding::at(
                FindingCode::PartChanged,
                "BinData/BIN0001.png"
            )));
        }
        // 19. Duplicate non-zero instance_id across GSO objects refused
        {
            let mut dup = rect_orig.clone();
            dup[0].2[36..40].copy_from_slice(&101u32.to_le_bytes());
            assert_refused("duplicate non-zero instance_id", pic_orig.clone(), dup);
        }
    }

    #[test]
    fn supported_hwp_gso_deletion_passes_only_for_proven_objects() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let pic1 = vec![
            (
                71,
                1,
                ctrl_header(101, 0x000a_0311, 0, 0, 4000, 3000, "p1", b"\xaa"),
            ),
            (
                76,
                2,
                shape_component_base(b"cip$", 4000, 3000, 4000, 3000, 0, 0),
            ),
            (85, 3, picture_leaf(1, [0, 0, 4000, 3000], b"\x01")),
        ];
        let pic2 = vec![
            (
                71,
                1,
                ctrl_header(102, 0x000a_0311, 0, 0, 2000, 1500, "p2", b"\xbb"),
            ),
            (
                76,
                2,
                shape_component_base(b"cip$", 2000, 1500, 2000, 1500, 0, 0),
            ),
            (85, 3, picture_leaf(1, [0, 0, 2000, 1500], b"\x02")),
        ];
        let rect_tb = vec![
            (
                71,
                1,
                ctrl_header(202, 0x000a_0000, 0, 0, 8000, 4000, "", &[]),
            ),
            (
                76,
                2,
                shape_component_drawing(b"cer$", 8000, 4000, 0, 0, 0, Some(0x112233), 9001),
            ),
            (72, 3, vec![1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            (66, 4, vec![0; 22]),
            (79, 3, rect_leaf(0, 8000, 4000)),
        ];
        let orig_sec = wrap_section(vec![pic1.clone(), pic2.clone(), rect_tb.clone()]);
        let orig_ref: Vec<_> = orig_sec
            .iter()
            .map(|(t, l, b)| (*t, *l, b.as_slice()))
            .collect();
        let orig_cfb = build_hwp(&di_ref, &orig_ref, b"\x89PNG\r\n\x1a\n123");

        // Deleting pic1 preserves shared BinData, pic2, and rect_tb.
        let del_pic1_sec = wrap_section(vec![pic2.clone(), rect_tb.clone()]);
        let del_pic1_ref: Vec<_> = del_pic1_sec
            .iter()
            .map(|(t, l, b)| (*t, *l, b.as_slice()))
            .collect();
        let del_pic1_cfb = build_hwp(&di_ref, &del_pic1_ref, b"\x89PNG\r\n\x1a\n123");
        assert_eq!(check_with_preview_refresh(&orig_cfb, &del_pic1_cfb), vec![]);

        // Deleting rect_tb passes while pic1 and pic2 remain intact.
        let del_rect_sec = wrap_section(vec![pic1.clone(), pic2.clone()]);
        let del_rect_ref: Vec<_> = del_rect_sec
            .iter()
            .map(|(t, l, b)| (*t, *l, b.as_slice()))
            .collect();
        let del_rect_cfb = build_hwp(&di_ref, &del_rect_ref, b"\x89PNG\r\n\x1a\n123");
        assert_eq!(check_with_preview_refresh(&orig_cfb, &del_rect_cfb), vec![]);

        // Deleting pic1 AND mutating BinData is still rejected.
        let bad_bin = build_hwp(&di_ref, &del_pic1_ref, b"\x89PNG\r\n\x1a\nBAD");
        assert!(
            check_with_preview_refresh(&orig_cfb, &bad_bin)
                .contains(&Finding::at(FindingCode::PartChanged, "BinData/BIN0001.png"))
        );

        // Deleting a TextBox shape that contains a nested control is rejected.
        let mut nested_tb = rect_tb;
        nested_tb.insert(
            4,
            (71, 5, b"umf%\x00\x00\x00\x00\x08\x00\x00\x00".to_vec()),
        );
        let nested_sec = wrap_section(vec![pic1.clone(), nested_tb]);
        let nested_ref: Vec<_> = nested_sec
            .iter()
            .map(|(t, l, b)| (*t, *l, b.as_slice()))
            .collect();
        let nested_orig = build_hwp(&di_ref, &nested_ref, b"\x89PNG\r\n\x1a\n123");
        let only_pic1_sec = wrap_section(vec![pic1]);
        let only_pic1_ref: Vec<_> = only_pic1_sec
            .iter()
            .map(|(t, l, b)| (*t, *l, b.as_slice()))
            .collect();
        let only_pic1_cfb = build_hwp(&di_ref, &only_pic1_ref, b"\x89PNG\r\n\x1a\n123");
        assert!(!check_with_preview_refresh(&nested_orig, &only_pic1_cfb).is_empty());
    }

    fn rotated_rendering_info(
        offset_x: i32,
        offset_y: i32,
        orig_w: usize,
        orig_h: usize,
        cur_w: usize,
        cur_h: usize,
        angle: i16,
    ) -> Vec<u8> {
        let mut out = Vec::with_capacity(146);
        out.extend_from_slice(&1u16.to_le_bytes());
        let [ox, oy] = [f64::from(offset_x), f64::from(offset_y)];
        let m1 = [1.0, 0.0, ox, 0.0, 1.0, oy];
        let m2 = [
            cur_w as f64 / orig_w as f64,
            0.0,
            0.0,
            0.0,
            cur_h as f64 / orig_h as f64,
            0.0,
        ];
        let theta = (angle as f64).to_radians();
        let (cos, sin) = (theta.cos(), theta.sin());
        let (w, h) = (cur_w as f64, cur_h as f64);
        let corners = [
            (0.0, 0.0),
            (w * cos, w * sin),
            (-h * sin, h * cos),
            (w * cos - h * sin, w * sin + h * cos),
        ];
        let tx = -corners.iter().map(|(x, _)| *x).fold(f64::INFINITY, f64::min);
        let ty = -corners.iter().map(|(_, y)| *y).fold(f64::INFINITY, f64::min);
        let m3 = [cos, -sin, tx - ox, sin, cos, ty - oy];
        for m in [m1, m2, m3] {
            for v in m {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    fn rotated_shape_component(
        offset_x: i32,
        offset_y: i32,
        orig_w: usize,
        orig_h: usize,
        cur_w: usize,
        cur_h: usize,
        angle: i16,
        rendering: &[u8],
    ) -> Vec<u8> {
        let mut sc = Vec::new();
        sc.extend_from_slice(b"cip$cip$");
        sc.extend_from_slice(&offset_x.to_le_bytes());
        sc.extend_from_slice(&offset_y.to_le_bytes());
        sc.extend_from_slice(&0u16.to_le_bytes()); // group_level
        sc.extend_from_slice(&0u16.to_le_bytes()); // local_file_version
        sc.extend_from_slice(&(orig_w as u32).to_le_bytes());
        sc.extend_from_slice(&(orig_h as u32).to_le_bytes());
        sc.extend_from_slice(&(cur_w as u32).to_le_bytes());
        sc.extend_from_slice(&(cur_h as u32).to_le_bytes());
        sc.extend_from_slice(&0u32.to_le_bytes()); // flip
        sc.extend_from_slice(&angle.to_le_bytes());
        sc.extend_from_slice(&0i32.to_le_bytes()); // rot center x
        sc.extend_from_slice(&0i32.to_le_bytes()); // rot center y
        sc.extend_from_slice(rendering);
        sc
    }

    #[test]
    fn rotated_hwp_picture_resize_proof_admits_only_consistent_matrices() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let file = |cw, ch, cur_w, cur_h, angle, rendering: Vec<u8>| {
            let pic = vec![
                (
                    71,
                    1,
                    ctrl_header(101, 0x000a_0311, 0, 0, cw, ch, "rot", b"\xaa"),
                ),
                (
                    76,
                    2,
                    rotated_shape_component(10, 20, 4050, 2025, cur_w, cur_h, angle, &rendering),
                ),
                (85, 3, picture_leaf(1, [0, 0, 4050, 2025], b"\x01")),
            ];
            let sec = wrap_section(vec![pic]);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };

        let old_r = rotated_rendering_info(10, 20, 4050, 2025, 4050, 2025, 30);
        let orig = file(4520, 3779, 4050, 2025, 30, old_r);
        let new_cw = 6075usize; // (4050 * 6780 / 4520).round()
        let new_ch = 2990usize; // (2025 * 5580 / 3779).round()
        let new_r = rotated_rendering_info(10, 20, 4050, 2025, new_cw, new_ch, 30);
        let good = file(6780, 5580, new_cw, new_ch, 30, new_r.clone());
        assert_eq!(check_with_preview_refresh(&orig, &good), vec![]);

        // Tamper scale sx, rotation cos, translation, or inject NaN.
        for at in [50usize, 82, 98, 114] {
            let mut bad_r = new_r.clone();
            let tampered = if at == 98 { f64::NAN } else { 99.0 };
            bad_r[at..at + 8].copy_from_slice(&tampered.to_le_bytes());
            let bad = file(6780, 5580, new_cw, new_ch, 30, bad_r);
            assert!(!check_with_preview_refresh(&orig, &bad).is_empty(), "at {at}");
        }

        // Inconsistent current_width or nonfinite/sheared source matrix must be rejected.
        let bad_cur = file(6780, 5580, 6780, 5580, 30, new_r.clone());
        assert!(!check_with_preview_refresh(&orig, &bad_cur).is_empty());
        let mut sheared_old = rotated_rendering_info(10, 20, 4050, 2025, 4050, 2025, 30);
        sheared_old[58..66].copy_from_slice(&0.5f64.to_le_bytes());
        let sheared_src = file(4520, 3779, 4050, 2025, 30, sheared_old);
        assert!(!check_with_preview_refresh(&sheared_src, &good).is_empty());
    }

    #[test]
    fn hwp_polygon_and_curve_evolution_preserves_vertices_and_segments() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();

        let poly_leaf = {
            let mut b = Vec::new();
            b.extend_from_slice(&3i32.to_le_bytes());
            for v in [0i32, 0, 10800, 0, 5400, 7200] {
                b.extend_from_slice(&v.to_le_bytes());
            }
            b.extend_from_slice(&0u32.to_le_bytes());
            b
        };
        let curve_leaf = {
            let mut b = Vec::new();
            b.extend_from_slice(&3i32.to_le_bytes());
            for v in [0i32, 0, 5400, 7200, 10800, 0] {
                b.extend_from_slice(&v.to_le_bytes());
            }
            b.extend_from_slice(&[1u8, 1u8]);
            b.extend_from_slice(&0u32.to_le_bytes());
            b
        };

        let build = |w: u32, h: u32, flip: u32, rot: i16, fill: Option<u32>, border_c: u32, leaf_poly: &[u8], leaf_curve: &[u8], locked: bool| {
            let attr = if locked { super::ATTR_LOCKED } else { 0 } | (1 << 21);
            let poly = vec![
                (71, 1, ctrl_header(201, attr, 0, 0, w, h, "", &[])),
                (76, 2, shape_component_drawing(super::SC_POLYGON, w, h, flip, rot, border_c, fill, 201)),
                (super::TAG_POLYGON, 3, leaf_poly.to_vec()),
            ];
            let curve = vec![
                (71, 1, ctrl_header(202, attr, 0, 0, w, h, "", &[])),
                (76, 2, shape_component_drawing(super::SC_CURVE, w, h, flip, rot, border_c, fill, 202)),
                (super::TAG_CURVE, 3, leaf_curve.to_vec()),
            ];
            let sec = wrap_section(vec![poly, curve]);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };

        let orig = build(10800, 7200, 0, 0, None, 0, &poly_leaf, &curve_leaf, false);
        let edited = build(15000, 9000, 1, 45, Some(0x00CC_8822), 0x0011_33AA, &poly_leaf, &curve_leaf, false);
        assert_eq!(check_with_preview_refresh(&orig, &edited), vec![]);

        // Negative 1: mutated polygon vertex or curve segment must fail closed.
        let mut bad_poly = poly_leaf.clone();
        bad_poly[8] ^= 1;
        let tampered_poly = build(15000, 9000, 1, 45, Some(0x00CC_8822), 0x0011_33AA, &bad_poly, &curve_leaf, false);
        assert!(!check_with_preview_refresh(&orig, &tampered_poly).is_empty());

        let mut bad_curve = curve_leaf.clone();
        bad_curve[28] = 0; // segment_type flipped
        let tampered_curve = build(15000, 9000, 1, 45, Some(0x00CC_8822), 0x0011_33AA, &poly_leaf, &bad_curve, false);
        assert!(!check_with_preview_refresh(&orig, &tampered_curve).is_empty());

        // Negative 2: locked polygon/curve must never allow geometry evolution.
        let locked_orig = build(10800, 7200, 0, 0, None, 0, &poly_leaf, &curve_leaf, true);
        let locked_edit = build(15000, 9000, 0, 0, None, 0, &poly_leaf, &curve_leaf, true);
        assert!(!check_with_preview_refresh(&locked_orig, &locked_edit).is_empty());

        // Deletion of unlocked polygon & curve succeeds cleanly.
        let deleted_sec = wrap_section(vec![]);
        let deleted_refs: Vec<_> = deleted_sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let deleted = build_hwp(&di_ref, &deleted_refs, b"\x89PNG\r\n\x1a\n123");
        assert_eq!(check_with_preview_refresh(&orig, &deleted), vec![]);
    }

    #[test]
    fn hwp_group_container_evolution_preserves_children() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();

        let container_sc = |w: u32, h: u32, inst: u32, child_ids: &[u32], rc: [i32; 2], rendering: &[u8]| {
            let mut b = Vec::new();
            b.extend_from_slice(super::SC_CONTAINER);
            b.extend_from_slice(super::SC_CONTAINER);
            b.extend_from_slice(&0i32.to_le_bytes()); // offset_x
            b.extend_from_slice(&0i32.to_le_bytes()); // offset_y
            b.extend_from_slice(&0u16.to_le_bytes()); // group_level = 0
            b.extend_from_slice(&0u16.to_le_bytes()); // local_file_version
            b.extend_from_slice(&12000u32.to_le_bytes()); // orig_w
            b.extend_from_slice(&8000u32.to_le_bytes()); // orig_h
            b.extend_from_slice(&w.to_le_bytes()); // cur_w
            b.extend_from_slice(&h.to_le_bytes()); // cur_h
            b.extend_from_slice(&0u32.to_le_bytes()); // flip
            b.extend_from_slice(&0i16.to_le_bytes()); // rot
            b.extend_from_slice(&rc[0].to_le_bytes());
            b.extend_from_slice(&rc[1].to_le_bytes());
            b.extend_from_slice(rendering);
            b.extend_from_slice(&(child_ids.len() as u16).to_le_bytes());
            for id in child_ids {
                b.extend_from_slice(&id.to_le_bytes());
            }
            b.extend_from_slice(&inst.to_le_bytes());
            b
        };
        let child_rect_sc = {
            let mut b = Vec::new();
            b.extend_from_slice(super::SC_RECT);
            b.extend_from_slice(&0i32.to_le_bytes());
            b.extend_from_slice(&0i32.to_le_bytes());
            b.extend_from_slice(&1u16.to_le_bytes()); // group_level = 1
            b.extend_from_slice(&0u16.to_le_bytes());
            b.extend_from_slice(&5000u32.to_le_bytes());
            b.extend_from_slice(&4000u32.to_le_bytes());
            b.extend_from_slice(&5000u32.to_le_bytes());
            b.extend_from_slice(&4000u32.to_le_bytes());
            b.extend_from_slice(&0u32.to_le_bytes());
            b.extend_from_slice(&0i16.to_le_bytes());
            b.extend_from_slice(&0i32.to_le_bytes());
            b.extend_from_slice(&0i32.to_le_bytes());
            b.extend_from_slice(&[0u8; 2 + 3 * 48]);
            b.extend_from_slice(&[0u8; 13 + 8 + 22]);
            b
        };
        let child_leaf = rect_leaf(0, 5000, 4000);
        let id_m = |id: [f64; 6]| {
            let mut m = [0u8; 48];
            for (i, v) in id.into_iter().enumerate() {
                m[i * 8..i * 8 + 8].copy_from_slice(&v.to_le_bytes());
            }
            m
        };
        let mut r_orig = Vec::new();
        r_orig.extend_from_slice(&1u16.to_le_bytes());
        r_orig.extend_from_slice(&id_m([1., 0., 10., 0., 1., 20.]));
        r_orig.extend_from_slice(&id_m([1., 0., 0., 0., 1., 0.]));
        r_orig.extend_from_slice(&id_m([0., -1., 0., 1., 0., 0.])); // 90deg matrix factored on edit
        let mut r_factored = Vec::new();
        r_factored.extend_from_slice(&1u16.to_le_bytes());
        r_factored.extend_from_slice(&id_m([1., 0., 10., 0., 1., 20.]));
        r_factored.extend_from_slice(&id_m([0., -1., 0., 1., 0., 0.]));
        r_factored.extend_from_slice(&id_m([1., 0., 0., 0., 1., 0.]));

        let build = |w: u32, h: u32, rc: [i32; 2], rendering: &[u8], leaf: &[u8]| {
            let group = vec![
                (71, 1, ctrl_header(301, 1 << 21, 500, 500, w, h, "", &[])),
                (76, 2, container_sc(w, h, 301, &[u32::from_le_bytes(*super::SC_RECT)], rc, rendering)),
                (76, 3, child_rect_sc.clone()),
                (super::TAG_RECTANGLE, 4, leaf.to_vec()),
            ];
            let sec = wrap_section(vec![group]);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };

        let orig = build(12000, 8000, [6000, 4000], &r_orig, &child_leaf);
        let edited = build(16000, 10000, [8000, 5000], &r_factored, &child_leaf);
        assert_eq!(check_with_preview_refresh(&orig, &edited), vec![]);

        // Negative 1: tampered child record inside group must fail closed.
        let mut bad_leaf = child_leaf.clone();
        bad_leaf[5] ^= 1;
        let bad_child = build(16000, 10000, [8000, 5000], &r_factored, &bad_leaf);
        assert!(!check_with_preview_refresh(&orig, &bad_child).is_empty());

        // Negative 2: incompatible affine matrix factorization must fail closed.
        let bad_r = build(16000, 10000, [8000, 5000], &[0u8; 2 + 3 * 48], &child_leaf);
        assert!(!check_with_preview_refresh(&orig, &bad_r).is_empty());

        // Flat unlocked uncaptioned HWP5 container deletion succeeds cleanly.
        let deleted_sec = wrap_section(vec![]);
        let deleted_refs: Vec<_> = deleted_sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let deleted = build_hwp(&di_ref, &deleted_refs, b"\x89PNG\r\n\x1a\n123");
        assert_eq!(check_with_preview_refresh(&orig, &deleted), vec![]);
    }

    #[test]
    fn hwp_group_child_t009_proves_geometry_fill_and_sibling_ownership() {
        let identity = |tx: f64, ty: f64| {
            let mut bytes = Vec::new();
            for value in [1.0, 0.0, tx, 0.0, 1.0, ty] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes
        };
        let component = |ctrl: &[u8; 4], x: i32, y: i32, w: u32, h: u32, inst: u32, color: u32| {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(ctrl);
            bytes.extend_from_slice(&x.to_le_bytes());
            bytes.extend_from_slice(&y.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&w.to_le_bytes());
            bytes.extend_from_slice(&h.to_le_bytes());
            bytes.extend_from_slice(&w.to_le_bytes());
            bytes.extend_from_slice(&h.to_le_bytes());
            bytes.extend_from_slice(&0x0008_0000u32.to_le_bytes());
            bytes.extend_from_slice(&0i16.to_le_bytes());
            bytes.extend_from_slice(&((w / 2) as i32).to_le_bytes());
            bytes.extend_from_slice(&((h / 2) as i32).to_le_bytes());
            bytes.extend_from_slice(&2u16.to_le_bytes());
            bytes.extend_from_slice(&identity(f64::from(x), f64::from(y)));
            for _ in 0..2 {
                bytes.extend_from_slice(&identity(0.0, 0.0));
                bytes.extend_from_slice(&identity(0.0, 0.0));
            }
            bytes.extend_from_slice(&[0u8; 13]);
            bytes.extend_from_slice(&1u32.to_le_bytes());
            bytes.extend_from_slice(&color.to_le_bytes());
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.extend_from_slice(&(-1i32).to_le_bytes());
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.push(0);
            bytes.extend_from_slice(&[0u8; 16]);
            bytes.extend_from_slice(&inst.to_le_bytes());
            bytes.push(0);
            bytes.push(0);
            bytes
        };
        let rectangle = |w: i32, h: i32| rect_leaf(0, w, h);
        let ellipse = |w: i32, h: i32| {
            let (cx, cy) = (w / 2, h / 2);
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&0u32.to_le_bytes());
            for (x, y) in [
                (cx, cy), (w, cy), (cx, h), (w, cy),
                (w, cy), (w, cy), (w, cy),
            ] {
                bytes.extend_from_slice(&x.to_le_bytes());
                bytes.extend_from_slice(&y.to_le_bytes());
            }
            bytes
        };
        let parent = || {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(super::SC_CONTAINER);
            bytes.extend_from_slice(super::SC_CONTAINER);
            bytes.extend_from_slice(&[0u8; 8]);
            bytes.extend_from_slice(&0u16.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            for dim in [12000u32, 8000, 12000, 8000] {
                bytes.extend_from_slice(&dim.to_le_bytes());
            }
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.extend_from_slice(&0i16.to_le_bytes());
            bytes.extend_from_slice(&6000i32.to_le_bytes());
            bytes.extend_from_slice(&4000i32.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&identity(0.0, 0.0));
            bytes.extend_from_slice(&identity(0.0, 0.0));
            bytes.extend_from_slice(&identity(0.0, 0.0));
            bytes.extend_from_slice(&2u16.to_le_bytes());
            bytes.extend_from_slice(super::SC_RECT);
            bytes.extend_from_slice(super::SC_ELLIPSE);
            bytes.extend_from_slice(&301u32.to_le_bytes());
            bytes
        };
        let records = |rect_sc: Vec<u8>, rect_leaf: Vec<u8>, ellipse_sc: Vec<u8>, ellipse_leaf: Vec<u8>| {
            vec![
                (71, 1, b" osg\0\0\0\0".to_vec()),
                (76, 2, parent()),
                (76, 3, rect_sc), (79, 4, rect_leaf),
                (76, 3, ellipse_sc), (80, 4, ellipse_leaf),
            ]
        };
        let original = records(
            component(super::SC_RECT, 0, 0, 4000, 3000, 1001, 0x0011_2233),
            rectangle(4000, 3000),
            component(super::SC_ELLIPSE, 6000, 1000, 4000, 3000, 1002, 0x0044_5566),
            ellipse(4000, 3000),
        );
        let prove = |next: &[(u16, u16, Vec<u8>)]| {
            let old_refs: Vec<super::Record<'_>> = original.iter().map(|(tag, level, data)| (*tag, *level, data.as_slice())).collect();
            let new_refs: Vec<super::Record<'_>> = next.iter().map(|(tag, level, data)| (*tag, *level, data.as_slice())).collect();
            super::prove_hwp5_group_child_edit(&old_refs, &new_refs, 1, 1, 2, 196, 12000, 8000).is_ok()
        };
        let mut moved = original.clone();
        moved[2].2[4..8].copy_from_slice(&100i32.to_le_bytes());
        moved[2].2[64..72].copy_from_slice(&100f64.to_le_bytes());
        assert!(prove(&moved), "single-child movement should pass");

        let mut resized = original.clone();
        for (at, value) in [(16, 3800u32), (20, 2800), (24, 3800), (28, 2800)] {
            resized[2].2[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        resized[3].2 = rectangle(3800, 2800);
        assert!(prove(&resized), "single-child resize should pass");

        let mut filled = original.clone();
        filled[2].2[305..309].copy_from_slice(&0x0066_7788u32.to_le_bytes());
        assert!(prove(&filled), "solid fill color edit should pass");

        let mut combined = original.clone();
        combined[2].2[4..8].copy_from_slice(&100i32.to_le_bytes());
        combined[2].2[64..72].copy_from_slice(&100f64.to_le_bytes());
        for (at, value) in [(16, 3800u32), (20, 2800), (24, 3800), (28, 2800)] {
            combined[2].2[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        combined[2].2[305..309].copy_from_slice(&0x0066_7788u32.to_le_bytes());
        combined[3].2 = rectangle(3800, 2800);
        combined[4].2[305..309].copy_from_slice(&0x0099_aabb_u32.to_le_bytes());
        assert!(prove(&combined), "multiple safe child edits should pass");

        let mut bad_matrix = moved.clone();
        bad_matrix[2].2[64..72].copy_from_slice(&99f64.to_le_bytes());
        assert!(!prove(&bad_matrix), "offset/render translation mismatch must fail");
        let mut bad_border = filled.clone();
        bad_border[2].2[288] ^= 1;
        assert!(!prove(&bad_border), "border changes must fail");
        let mut bad_leaf = resized.clone();
        bad_leaf[3].2[5] ^= 1;
        assert!(!prove(&bad_leaf), "noncanonical resized leaf must fail");
        let mut reordered = original.clone();
        reordered.swap(2, 4);
        reordered.swap(3, 5);
        assert!(!prove(&reordered), "child order changes must fail");
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the HWP group geometry scenario first"]
    fn release_hwp_group_geometry_preserves_children() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        let original = read("p3-group-original.hwp");
        let edited = read("p3-group-edited.hwp");
        assert_eq!(check_with_preview_refresh(&original, &edited), vec![]);
        let child_rect = |tag, level, data: &[u8]| tag == 76 && level == 3 && !data.is_empty();
        let tampered = mutate_body_record(&edited, child_rect, |data| {
            let mut changed = data.to_vec();
            changed[20] ^= 1;
            changed
        });
        assert!(check_with_preview_refresh(&original, &tampered)
            .iter().any(|f| f.part.as_deref() == Some(super::BODY)));
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the HWP5 group-child scenario first"]
    fn release_hwp_group_child_edits_preserve_children() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let original = std::fs::read(dir.join("p4-h5-group-original.hwp")).unwrap();
        for name in ["move", "resize", "fill", "combined"] {
            let edited = std::fs::read(dir.join(format!("p4-h5-group-{name}.hwp"))).unwrap();
            assert_eq!(
                check_with_preview_refresh(&original, &edited),
                vec![],
                "T009 must accept the supported {name} edit while preserving the source group"
            );
        }
    }

    #[test]
    fn hwp_shape_and_multiparagraph_caption_preserve_autonumber() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();

        let cap_para = |text: &str, with_atno: bool, is_last_mask: bool| -> Vec<(u16, u16, Vec<u8>)> {
            let mut raw_text = Vec::new();
            for cu in text.encode_utf16() {
                raw_text.extend_from_slice(&cu.to_le_bytes());
            }
            if with_atno {
                raw_text.extend_from_slice(&18u16.to_le_bytes());
                raw_text.extend_from_slice(b"onta");
                raw_text.extend_from_slice(&[0u8; 8]);
                raw_text.extend_from_slice(&18u16.to_le_bytes());
            }
            raw_text.extend_from_slice(b"\r\0");
            let cc = ((raw_text.len() / 2) as u32) | if is_last_mask { 0x8000_0000 } else { 0 };
            let mask: u32 = if with_atno { 1 << 18 } else { 0 };
            let mut hdr = vec![0u8; 22];
            hdr[0..4].copy_from_slice(&cc.to_le_bytes());
            hdr[4..8].copy_from_slice(&mask.to_le_bytes());
            hdr[12..14].copy_from_slice(&1u16.to_le_bytes());
            hdr[16..18].copy_from_slice(&1u16.to_le_bytes());
            let mut cs = vec![0u8; 8];
            cs[0..4].copy_from_slice(&0u32.to_le_bytes());
            let mut ls = vec![0u8; 36];
            ls[4..8].copy_from_slice(&1000i32.to_le_bytes());
            ls[8..12].copy_from_slice(&1000i32.to_le_bytes());
            ls[12..16].copy_from_slice(&850i32.to_le_bytes());
            let mut out = vec![(66, 2, hdr), (67, 3, raw_text), (68, 3, cs), (69, 3, ls)];
            if with_atno {
                let mut atno = vec![0u8; 16];
                atno[0..4].copy_from_slice(b"onta");
                out.push((71, 3, atno));
            }
            out
        };

        let cap_list = |para_count: u16, extra_flags: u8| -> Vec<u8> {
            let mut list = vec![0u8; 30];
            list[0..2].copy_from_slice(&para_count.to_le_bytes());
            list[8] = extra_flags;
            list
        };

        let shape_sc = shape_component_drawing(super::SC_RECT, 201, 6000, 4000, 100, 0, Some(0x00ff_ffff), 1);
        let shape_leaf = rect_leaf(0, 6000, 4000);
        let build_shape_cap = |paras: Vec<Vec<(u16, u16, Vec<u8>)>>, list_hdr: Vec<u8>, attr: u32| {
            let mut obj = vec![
                (71, 1, ctrl_header(201, attr, 500, 500, 6000, 4000, "", &[])),
                (72, 2, list_hdr),
            ];
            for p in paras {
                obj.extend(p);
            }
            obj.push((76, 2, shape_sc.clone()));
            obj.push((super::TAG_RECTANGLE, 3, shape_leaf.clone()));
            let sec = wrap_section(vec![obj]);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };

        // Positive 1: 1-para shape caption split into 2 paragraphs while preserving AutoNumber (`atno`).
        let orig_shape = build_shape_cap(
            vec![cap_para("도형 ", true, true)],
            cap_list(1, 0),
            super::ATTR_CAPTION,
        );
        let split_shape = build_shape_cap(
            vec![cap_para("도형 ", true, false), cap_para("둘째 줄", false, true)],
            cap_list(2, 0),
            super::ATTR_CAPTION,
        );
        assert_eq!(check_with_preview_refresh(&orig_shape, &split_shape), vec![]);

        // Positive 2: 2-para caption merged back into 1 paragraph preserving `atno`.
        assert_eq!(check_with_preview_refresh(&split_shape, &orig_shape), vec![]);

        // Negative 1: deleting `atno` during multi-para caption edit must fail closed.
        let lost_atno = build_shape_cap(
            vec![cap_para("도형 ", false, false), cap_para("둘째 줄", false, true)],
            cap_list(2, 0),
            super::ATTR_CAPTION,
        );
        assert!(!check_with_preview_refresh(&orig_shape, &lost_atno).is_empty());

        // Negative 2: tampering caption LIST_HEADER bytes beyond para_count (`[2..]`) must fail closed.
        let bad_list = build_shape_cap(
            vec![cap_para("도형 ", true, false), cap_para("둘째 줄", false, true)],
            cap_list(2, 1),
            super::ATTR_CAPTION,
        );
        assert!(!check_with_preview_refresh(&orig_shape, &bad_list).is_empty());

        // Negative 3: locked shape caption edit must fail closed.
        let locked_orig = build_shape_cap(
            vec![cap_para("도형 ", true, true)],
            cap_list(1, 0),
            super::ATTR_CAPTION | super::ATTR_LOCKED,
        );
        let locked_edit = build_shape_cap(
            vec![cap_para("도형 ", true, false), cap_para("둘째 줄", false, true)],
            cap_list(2, 0),
            super::ATTR_CAPTION | super::ATTR_LOCKED,
        );
        assert!(!check_with_preview_refresh(&locked_orig, &locked_edit).is_empty());

        // Negative 4: duplicating `atno` across paragraphs must fail closed.
        let dup_atno = build_shape_cap(
            vec![cap_para("도형 ", true, false), cap_para("둘째 ", true, true)],
            cap_list(2, 0),
            super::ATTR_CAPTION,
        );
        assert!(!check_with_preview_refresh(&orig_shape, &dup_atno).is_empty());
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run the HWP shape and multi-paragraph caption scenarios first"]
    fn release_hwp_shape_and_multiparagraph_captions() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        for (orig_name, edit_name) in [
            ("p5-shape-caption-original.hwp", "p5-shape-caption-edited.hwp"),
            ("p5-multipara-caption-original.hwp", "p5-multipara-caption-edited.hwp"),
        ] {
            let orig = read(orig_name);
            let edited = read(edit_name);
            assert_eq!(check_with_preview_refresh(&orig, &edited), vec![], "{edit_name}");
        }
    }

    #[test]
    fn multi_shape_z_order_preserves_owned_records_and_refuses_tamper() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let make_shape = |id: u32, z: i32, wrap: u32, fill: Option<u32>, locked: bool| {
            let attr = (wrap << 21) | if locked { super::ATTR_LOCKED } else { 0 };
            let mut hdr = ctrl_header(id, attr, 0, 0, 6000, 4000, "", &[]);
            hdr[24..28].copy_from_slice(&z.to_le_bytes());
            vec![
                (71, 1, hdr),
                (76, 2, shape_component_drawing(super::SC_RECT, 6000, 4000, 0, 0, 0, fill, id)),
                (super::TAG_RECTANGLE, 3, rect_leaf(0, 6000, 4000)),
            ]
        };
        let build = |s1: Vec<(u16, u16, Vec<u8>)>, s2: Vec<(u16, u16, Vec<u8>)>, s3: Vec<(u16, u16, Vec<u8>)>| {
            let sec = wrap_section(vec![s1, s2, s3]);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };
        let orig = build(
            make_shape(101, 1, 1, None, false),
            make_shape(102, 2, 1, None, false),
            make_shape(103, 3, 1, None, false),
        );
        // Positive: shape 3 moved back (0), shape 1 moved front (4), shape 2 moved front (5).
        let valid_multi = build(
            make_shape(101, 4, 1, None, false),
            make_shape(102, 5, 1, None, false),
            make_shape(103, 0, 1, None, false),
        );
        assert_eq!(check_with_preview_refresh(&orig, &valid_multi), vec![]);

        // Negative 1: duplicate ranks must fail closed.
        let dup_ranks = build(
            make_shape(101, 4, 1, None, false),
            make_shape(102, 4, 1, None, false),
            make_shape(103, 0, 1, None, false),
        );
        assert!(!check_with_preview_refresh(&orig, &dup_ranks).is_empty());

        // Negative 2: locked shape participation must fail closed.
        let locked_orig = build(
            make_shape(101, 1, 1, None, false),
            make_shape(102, 2, 1, None, false),
            make_shape(103, 3, 1, None, true),
        );
        let locked_edit = build(
            make_shape(101, 4, 1, None, false),
            make_shape(102, 5, 1, None, false),
            make_shape(103, 3, 1, None, true),
        );
        assert!(!check_with_preview_refresh(&locked_orig, &locked_edit).is_empty());

        // Negative 3: out-of-bounds rank jump must fail closed.
        let jumped = build(
            make_shape(101, 1000, 1, None, false),
            make_shape(102, 1001, 1, None, false),
            make_shape(103, 0, 1, None, false),
        );
        assert!(!check_with_preview_refresh(&orig, &jumped).is_empty());

        // Negative 4: mixing fill mutation with multi z-order must fail closed.
        let mixed_fill = build(
            make_shape(101, 4, 1, Some(0x0011_2233), false),
            make_shape(102, 5, 1, None, false),
            make_shape(103, 0, 1, None, false),
        );
        assert!(!check_with_preview_refresh(&orig, &mixed_fill).is_empty());
    }

    #[test]
    fn combined_hwp_caption_and_outer_edit_preserves_autonumber_and_refuses_tamper() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let cap_para = |text: &str, with_atno: bool, is_last_mask: bool| -> Vec<(u16, u16, Vec<u8>)> {
            let mut raw_text = Vec::new();
            for cu in text.encode_utf16() {
                raw_text.extend_from_slice(&cu.to_le_bytes());
            }
            if with_atno {
                raw_text.extend_from_slice(&18u16.to_le_bytes());
                raw_text.extend_from_slice(b"onta");
                raw_text.extend_from_slice(&[0u8; 8]);
                raw_text.extend_from_slice(&18u16.to_le_bytes());
            }
            raw_text.extend_from_slice(b"\r\0");
            let cc = ((raw_text.len() / 2) as u32) | if is_last_mask { 0x8000_0000 } else { 0 };
            let mask: u32 = if with_atno { 1 << 18 } else { 0 };
            let mut hdr = vec![0u8; 22];
            hdr[0..4].copy_from_slice(&cc.to_le_bytes());
            hdr[4..8].copy_from_slice(&mask.to_le_bytes());
            hdr[12..14].copy_from_slice(&1u16.to_le_bytes());
            hdr[16..18].copy_from_slice(&1u16.to_le_bytes());
            let mut cs = vec![0u8; 8];
            cs[0..4].copy_from_slice(&0u32.to_le_bytes());
            let mut ls = vec![0u8; 36];
            ls[4..8].copy_from_slice(&1000i32.to_le_bytes());
            ls[8..12].copy_from_slice(&1000i32.to_le_bytes());
            ls[12..16].copy_from_slice(&850i32.to_le_bytes());
            let mut out = vec![(66, 2, hdr), (67, 3, raw_text), (68, 3, cs), (69, 3, ls)];
            if with_atno {
                let mut atno = vec![0u8; 16];
                atno[0..4].copy_from_slice(b"onta");
                out.push((71, 3, atno));
            }
            out
        };
        let cap_list = |para_count: u16, extra: u8| -> Vec<u8> {
            let mut list = vec![0u8; 30];
            list[0..2].copy_from_slice(&para_count.to_le_bytes());
            list[8] = extra;
            list
        };
        let build = |paras: Vec<Vec<(u16, u16, Vec<u8>)>>, list: Vec<u8>, attr: u32, w: u32, h: u32, fill: Option<u32>, bw: i32| {
            let mut obj = vec![
                (71, 1, ctrl_header(201, attr, 500, 500, w, h, "", &[])),
                (72, 2, list),
            ];
            for p in paras {
                obj.extend(p);
            }
            let mut sc = shape_component_drawing(super::SC_RECT, w, h, 0, 0, 0, fill, 201);
            // Update border_width at offset 200..204 (2+3*48 = 146 after attr+42 = 196; border_color 196..200, border_width 200..204).
            sc[200..204].copy_from_slice(&bw.to_le_bytes());
            obj.push((76, 2, sc));
            obj.push((super::TAG_RECTANGLE, 3, rect_leaf(0, w as i32, h as i32)));
            let sec = wrap_section(vec![obj]);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };

        let orig = build(
            vec![cap_para("도형 ", true, true)],
            cap_list(1, 0),
            super::ATTR_CAPTION | (1 << 21),
            6000,
            4000,
            Some(0x00ff_ffff),
            33,
        );
        // Positive: split caption + outer resize + solid fill in one save.
        let combined = build(
            vec![cap_para("도형 ", true, false), cap_para("편집", false, true)],
            cap_list(2, 0),
            super::ATTR_CAPTION | (1 << 21),
            8400,
            4200,
            Some(0x0099_6633),
            33,
        );
        assert_eq!(check_with_preview_refresh(&orig, &combined), vec![]);

        // Negative 1: missing atno fails closed.
        let no_atno = build(
            vec![cap_para("도형 ", false, false), cap_para("편집", false, true)],
            cap_list(2, 0),
            super::ATTR_CAPTION | (1 << 21),
            8400,
            4200,
            Some(0x0099_6633),
            33,
        );
        assert!(!check_with_preview_refresh(&orig, &no_atno).is_empty());

        // Negative 2: LIST_HEADER tamper fails closed.
        let bad_list = build(
            vec![cap_para("도형 ", true, false), cap_para("편집", false, true)],
            cap_list(2, 1),
            super::ATTR_CAPTION | (1 << 21),
            8400,
            4200,
            Some(0x0099_6633),
            33,
        );
        assert!(!check_with_preview_refresh(&orig, &bad_list).is_empty());

        // Negative 3: outline width mutation on caption-bearing shape remains refused.
        let bad_bw = build(
            vec![cap_para("도형 ", true, false), cap_para("편집", false, true)],
            cap_list(2, 0),
            super::ATTR_CAPTION | (1 << 21),
            8400,
            4200,
            Some(0x0099_6633),
            200,
        );
        assert!(!check_with_preview_refresh(&orig, &bad_bw).is_empty());

        // Negative 4: locked caption owner fails closed.
        let locked_orig = build(
            vec![cap_para("도형 ", true, true)],
            cap_list(1, 0),
            super::ATTR_CAPTION | super::ATTR_LOCKED | (1 << 21),
            6000,
            4000,
            Some(0x00ff_ffff),
            33,
        );
        let locked_edit = build(
            vec![cap_para("도형 ", true, false), cap_para("편집", false, true)],
            cap_list(2, 0),
            super::ATTR_CAPTION | super::ATTR_LOCKED | (1 << 21),
            8400,
            4200,
            Some(0x0099_6633),
            33,
        );
        assert!(!check_with_preview_refresh(&locked_orig, &locked_edit).is_empty());
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run B1.1 and B1.2 WASM tests with GEUL_STAGE3_OUT first"]
    fn release_hwp_b1_multi_shape_layer_and_combined_caption() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let read = |name| std::fs::read(dir.join(name)).unwrap();
        for (orig_name, edit_name) in [
            ("b1-1-multi-layer-original.hwp", "b1-1-multi-layer-edited.hwp"),
            ("b1-2-combined-caption-original.hwp", "b1-2-combined-caption-edited.hwp"),
        ] {
            let orig = read(orig_name);
            let edited = read(edit_name);
            assert_eq!(check_with_preview_refresh(&orig, &edited), vec![], "{edit_name}");
        }
    }

    #[test]
    fn captioned_hwp_gso_deletion_preserves_siblings_and_refuses_unsafe_captions() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let cap_para = |text: &str, with_atno: bool, dup_atno: bool| -> Vec<(u16, u16, Vec<u8>)> {
            let mut raw_text = Vec::new();
            for cu in text.encode_utf16() {
                raw_text.extend_from_slice(&cu.to_le_bytes());
            }
            if with_atno {
                raw_text.extend_from_slice(&18u16.to_le_bytes());
                raw_text.extend_from_slice(b"onta");
                raw_text.extend_from_slice(&[0u8; 8]);
                raw_text.extend_from_slice(&18u16.to_le_bytes());
            }
            if dup_atno {
                raw_text.extend_from_slice(&18u16.to_le_bytes());
                raw_text.extend_from_slice(b"onta");
                raw_text.extend_from_slice(&[0u8; 8]);
                raw_text.extend_from_slice(&18u16.to_le_bytes());
            }
            raw_text.extend_from_slice(b"\r\0");
            let cc = ((raw_text.len() / 2) as u32) | 0x8000_0000;
            let mask: u32 = if with_atno || dup_atno { 1 << 18 } else { 0 };
            let mut hdr = vec![0u8; 22];
            hdr[0..4].copy_from_slice(&cc.to_le_bytes());
            hdr[4..8].copy_from_slice(&mask.to_le_bytes());
            hdr[12..14].copy_from_slice(&1u16.to_le_bytes());
            hdr[16..18].copy_from_slice(&1u16.to_le_bytes());
            let cs = vec![0u8; 8];
            let mut ls = vec![0u8; 36];
            ls[4..8].copy_from_slice(&1000i32.to_le_bytes());
            ls[8..12].copy_from_slice(&1000i32.to_le_bytes());
            ls[12..16].copy_from_slice(&850i32.to_le_bytes());
            let mut out = vec![(66, 2, hdr), (67, 3, raw_text), (68, 3, cs), (69, 3, ls)];
            if with_atno {
                let mut atno = vec![0u8; 16];
                atno[0..4].copy_from_slice(b"onta");
                out.push((71, 3, atno));
            }
            if dup_atno {
                let mut atno = vec![0u8; 16];
                atno[0..4].copy_from_slice(b"onta");
                out.push((71, 3, atno));
            }
            out
        };
        let mut list = vec![0u8; 30];
        list[0..2].copy_from_slice(&1u16.to_le_bytes());

        let pic_obj = |id: u32, attr: u32, dup_atno: bool, extra: Option<(u16, u16, Vec<u8>)>| {
            let mut obj = vec![
                (71, 1, ctrl_header(id, attr, 0, 0, 4000, 3000, "", &[])),
                (72, 2, list.clone()),
            ];
            obj.extend(cap_para("그림 ", true, dup_atno));
            if let Some(ex) = extra {
                obj.push(ex);
            }
            obj.push((76, 2, shape_component_base(super::SC_PICTURE, 4000, 3000, 4000, 3000, 0, 0)));
            obj.push((85, 3, picture_leaf(1, [0; 4], &[])));
            obj
        };
        let shape_obj = |id: u32, attr: u32, with_textbox: bool| {
            let mut obj = vec![
                (71, 1, ctrl_header(id, attr, 500, 500, 5000, 3000, "", &[])),
                (72, 2, list.clone()),
            ];
            obj.extend(cap_para("도형 ", true, false));
            obj.push((76, 2, shape_component_drawing(super::SC_RECT, 5000, 3000, 0, 0, 0, None, id)));
            if with_textbox {
                obj.push((72, 3, vec![0u8; 33]));
                obj.push((66, 4, vec![0u8; 22]));
                obj.push((68, 4, vec![0u8; 8]));
                obj.push((69, 4, vec![0u8; 36]));
            }
            obj.push((super::TAG_RECTANGLE, 3, rect_leaf(0, 5000, 3000)));
            obj
        };
        let build = |objs: Vec<Vec<(u16, u16, Vec<u8>)>>| {
            let sec = wrap_section(objs);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };

        let survivor = pic_obj(102, super::ATTR_CAPTION | 1, false, None);
        let orig = build(vec![
            pic_obj(101, super::ATTR_CAPTION | 1, false, None),
            shape_obj(103, super::ATTR_CAPTION, false),
            survivor.clone(),
        ]);
        let deleted = build(vec![survivor]);
        assert_eq!(check_with_preview_refresh(&orig, &deleted), vec![]);

        // Negative 1: locked captioned picture deletion refused.
        let locked_orig = build(vec![pic_obj(101, super::ATTR_CAPTION | super::ATTR_LOCKED | 1, false, None)]);
        assert!(!check_with_preview_refresh(&locked_orig, &build(vec![])).is_empty());

        // Negative 2: malformed caption (duplicate atno) deletion refused.
        let dup_orig = build(vec![pic_obj(101, super::ATTR_CAPTION | 1, true, None)]);
        assert!(!check_with_preview_refresh(&dup_orig, &build(vec![])).is_empty());

        // Negative 3: unknown dependent record inside caption (e.g. CTRL_DATA tag 90) refused.
        let unknown_orig = build(vec![pic_obj(101, super::ATTR_CAPTION | 1, false, Some((90, 3, vec![1, 2, 3])))]);
        assert!(!check_with_preview_refresh(&unknown_orig, &build(vec![])).is_empty());

        // Negative 4: TextBox+caption deletion refused.
        let tb_cap_orig = build(vec![shape_obj(103, super::ATTR_CAPTION, true)]);
        assert!(!check_with_preview_refresh(&tb_cap_orig, &build(vec![])).is_empty());
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run B2.1 WASM test with GEUL_STAGE3_OUT first"]
    fn release_hwp_b2_1_captioned_gso_deletion() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let orig = std::fs::read(dir.join("b2-1-caption-delete-original.hwp")).unwrap();
        let edited = std::fs::read(dir.join("b2-1-caption-delete-edited.hwp")).unwrap();
        assert_eq!(check_with_preview_refresh(&orig, &edited), vec![]);
    }

    #[test]
    fn b2_2_flat_group_deletion_and_refusals() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
        let identity_render = || {
            let mut r = vec![0u8; 2 + 3 * 48];
            r[..2].copy_from_slice(&1u16.to_le_bytes());
            r
        };
        let container_sc = |inst: u32, child_ids: &[&[u8; 4]]| {
            let mut b = Vec::new();
            b.extend_from_slice(super::SC_CONTAINER);
            b.extend_from_slice(super::SC_CONTAINER);
            b.extend_from_slice(&0i32.to_le_bytes());
            b.extend_from_slice(&0i32.to_le_bytes());
            b.extend_from_slice(&0u16.to_le_bytes());
            b.extend_from_slice(&0u16.to_le_bytes());
            b.extend_from_slice(&12000u32.to_le_bytes());
            b.extend_from_slice(&8000u32.to_le_bytes());
            b.extend_from_slice(&12000u32.to_le_bytes());
            b.extend_from_slice(&8000u32.to_le_bytes());
            b.extend_from_slice(&0u32.to_le_bytes());
            b.extend_from_slice(&0i16.to_le_bytes());
            b.extend_from_slice(&6000i32.to_le_bytes());
            b.extend_from_slice(&4000i32.to_le_bytes());
            b.extend_from_slice(&identity_render());
            b.extend_from_slice(&(child_ids.len() as u16).to_le_bytes());
            for id in child_ids {
                b.extend_from_slice(*id);
            }
            b.extend_from_slice(&inst.to_le_bytes());
            b
        };
        let child_sc = |ctrl: &[u8; 4], tail: usize| {
            let mut b = Vec::new();
            b.extend_from_slice(ctrl);
            b.extend_from_slice(&0i32.to_le_bytes());
            b.extend_from_slice(&0i32.to_le_bytes());
            b.extend_from_slice(&1u16.to_le_bytes());
            b.extend_from_slice(&0u16.to_le_bytes());
            b.extend_from_slice(&4000u32.to_le_bytes());
            b.extend_from_slice(&3000u32.to_le_bytes());
            b.extend_from_slice(&4000u32.to_le_bytes());
            b.extend_from_slice(&3000u32.to_le_bytes());
            b.extend_from_slice(&0u32.to_le_bytes());
            b.extend_from_slice(&0i16.to_le_bytes());
            b.extend_from_slice(&2000i32.to_le_bytes());
            b.extend_from_slice(&1500i32.to_le_bytes());
            b.extend_from_slice(&identity_render());
            b.extend(vec![0u8; tail]);
            b
        };
        let survivor_pic = vec![
            (71, 1, ctrl_header(202, 1 << 21 | 1, 0, 0, 4000, 3000, "", &[])),
            (76, 2, shape_component_base(super::SC_PICTURE, 4000, 3000, 4000, 3000, 0, 0)),
            (85, 3, picture_leaf(1, [0; 4], &[])),
        ];
        let flat_group = vec![
            (71, 1, ctrl_header(201, 1 << 21, 500, 500, 12000, 8000, "", &[])),
            (76, 2, container_sc(201, &[super::SC_RECT, super::SC_PICTURE])),
            (76, 3, child_sc(super::SC_RECT, 13 + 8 + 22)),
            (super::TAG_RECTANGLE, 4, rect_leaf(0, 4000, 3000)),
            (76, 3, child_sc(super::SC_PICTURE, 0)),
            (super::TAG_PICTURE, 4, picture_leaf(1, [0; 4], &[])),
        ];
        let build = |objs: Vec<Vec<(u16, u16, Vec<u8>)>>| {
            let sec = wrap_section(objs);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };

        // Positive: deleting flat unlocked uncaptioned group (rect + picture) preserves sibling picture & shared BinData.
        let orig = build(vec![flat_group.clone(), survivor_pic.clone()]);
        let after_delete = build(vec![survivor_pic.clone()]);
        assert_eq!(check_with_preview_refresh(&orig, &after_delete), vec![]);

        // Negative 1: locked group deletion refused.
        let mut locked = flat_group.clone();
        locked[0].2 = ctrl_header(201, (1 << 21) | super::ATTR_LOCKED, 500, 500, 12000, 8000, "", &[]);
        assert!(!check_with_preview_refresh(&build(vec![locked, survivor_pic.clone()]), &after_delete).is_empty());

        // Negative 2: captioned group deletion refused.
        let captioned = vec![
            (71, 1, ctrl_header(201, (1 << 21) | super::ATTR_CAPTION, 500, 500, 12000, 8000, "", &[])),
            (72, 2, vec![0u8; 30]),
            (66, 2, vec![0u8; 22]),
            (68, 2, vec![0u8; 8]),
            (69, 2, vec![0u8; 36]),
            (76, 2, container_sc(201, &[super::SC_RECT])),
            (76, 3, child_sc(super::SC_RECT, 13 + 8 + 22)),
            (super::TAG_RECTANGLE, 4, rect_leaf(0, 4000, 3000)),
        ];
        assert!(!check_with_preview_refresh(&build(vec![captioned, survivor_pic.clone()]), &after_delete).is_empty());

        // Negative 3: nested group child refused.
        let nested = vec![
            (71, 1, ctrl_header(201, 1 << 21, 500, 500, 12000, 8000, "", &[])),
            (76, 2, container_sc(201, &[super::SC_CONTAINER])),
            (76, 3, child_sc(super::SC_CONTAINER, 10)),
            (76, 4, child_sc(super::SC_RECT, 13 + 8 + 22)),
            (super::TAG_RECTANGLE, 5, rect_leaf(0, 4000, 3000)),
        ];
        assert!(!check_with_preview_refresh(&build(vec![nested, survivor_pic.clone()]), &after_delete).is_empty());

        // Negative 4: OLE child inside group refused.
        let ole_group = vec![
            (71, 1, ctrl_header(201, 1 << 21, 500, 500, 12000, 8000, "", &[])),
            (76, 2, container_sc(201, &[b"elo$"])),
            (76, 3, child_sc(b"elo$", 0)),
            (84, 4, vec![0u8; 30]),
        ];
        assert!(!check_with_preview_refresh(&build(vec![ole_group, survivor_pic.clone()]), &after_delete).is_empty());

        // Negative 5: Arc child inside group refused.
        let arc_group = vec![
            (71, 1, ctrl_header(201, 1 << 21, 500, 500, 12000, 8000, "", &[])),
            (76, 2, container_sc(201, &[b"cra$"])),
            (76, 3, child_sc(b"cra$", 13 + 8 + 22)),
            (81, 4, vec![0u8; 25]),
        ];
        assert!(!check_with_preview_refresh(&build(vec![arc_group, survivor_pic]), &after_delete).is_empty());
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run B2.2 WASM test with GEUL_STAGE3_OUT first"]
    fn release_hwp_b2_2_group_deletion() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        let orig = std::fs::read(dir.join("b2-2-group-delete-original.hwp")).unwrap();
        let edited = std::fs::read(dir.join("b2-2-group-delete-edited.hwp")).unwrap();
        assert_eq!(check_with_preview_refresh(&orig, &edited), vec![]);
    }

    #[test]
    fn b3_1_cloned_hwp_gso_copy_cut_paste_and_refusals() {
        let di = doc_info_records(1);
        let di_ref: Vec<_> = di.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();

        let pic_obj = |id: u32, attr: u32, off: i32, pic_inst: u32| {
            let mut leaf = picture_leaf(1, [0; 4], &[0u8; 9]);
            leaf[74..78].copy_from_slice(&pic_inst.to_le_bytes());
            vec![
                (71, 1, ctrl_header(id, attr, off, off, 4000, 3000, "pic", &[])),
                (76, 2, shape_component_base(super::SC_PICTURE, 4000, 3000, 4000, 3000, 0, 0)),
                (85, 3, leaf),
            ]
        };
        let shape_obj = |id: u32, attr: u32, off: i32, sc_inst: u32, border_color: u32| {
            vec![
                (71, 1, ctrl_header(id, attr, off, off, 5000, 3000, "rect", &[])),
                (
                    76,
                    2,
                    shape_component_drawing(
                        super::SC_RECT,
                        5000,
                        3000,
                        0,
                        0,
                        border_color,
                        None,
                        sc_inst,
                    ),
                ),
                (super::TAG_RECTANGLE, 3, rect_leaf(0, 5000, 3000)),
            ]
        };
        let build = |objs: Vec<Vec<(u16, u16, Vec<u8>)>>| {
            let sec = wrap_section(objs);
            let refs: Vec<_> = sec.iter().map(|(t, l, b)| (*t, *l, b.as_slice())).collect();
            build_hwp(&di_ref, &refs, b"\x89PNG\r\n\x1a\n123")
        };

        let src_pic = pic_obj(101, 1 << 21, 500, 1);
        let src_shape = shape_obj(102, 1 << 21, 1500, 2, 100);
        let cloned_pic = pic_obj(201, 1 << 21, 1067, 9);
        let cloned_shape = shape_obj(202, 1 << 21, 2067, 10, 100);

        let orig = build(vec![src_pic.clone(), src_shape.clone()]);
        // Positive 1: Copy + Paste preserves original and admits cloned picture + styled shape.
        let copied = build(vec![
            src_pic.clone(),
            src_shape.clone(),
            cloned_pic.clone(),
            cloned_shape.clone(),
        ]);
        assert_eq!(check_with_preview_refresh(&orig, &copied), vec![]);

        // Positive 2: Cut + Paste (deletes src_shape and inserts cloned_shape with fresh ID + cascade).
        let cut_pasted = build(vec![src_pic.clone(), cloned_shape.clone()]);
        assert_eq!(check_with_preview_refresh(&orig, &cut_pasted), vec![]);

        // Negative 1: Cloning a locked source or fabricating an unowned styled shape must fail closed.
        let locked_orig = build(vec![shape_obj(102, (1 << 21) | super::ATTR_LOCKED, 1500, 2, 100)]);
        let locked_clone = build(vec![
            shape_obj(102, (1 << 21) | super::ATTR_LOCKED, 1500, 2, 100),
            shape_obj(202, (1 << 21) | super::ATTR_LOCKED, 2067, 10, 100),
        ]);
        assert!(!check_with_preview_refresh(&locked_orig, &locked_clone).is_empty());

        let tampered_border = build(vec![
            src_pic.clone(),
            src_shape.clone(),
            shape_obj(202, 1 << 21, 2067, 10, 250),
        ]);
        assert!(!check_with_preview_refresh(&orig, &tampered_border).is_empty());

        // Negative 2: Reusing original instance_id in cloned object must fail closed.
        let reused_id = build(vec![
            src_pic,
            src_shape,
            pic_obj(101, 1 << 21, 1067, 9),
        ]);
        assert!(!check_with_preview_refresh(&orig, &reused_id).is_empty());

        // Negative 3: Cross-document / unowned BinData ID in pasted picture fails closed.
        let mut foreign_pic = cloned_pic;
        foreign_pic[2].2[71..73].copy_from_slice(&2u16.to_le_bytes());
        assert!(!check_with_preview_refresh(&orig, &build(vec![foreign_pic])).is_empty());
    }

    #[test]
    #[ignore = "Release-WASM fixtures: run B3.1 WASM test with GEUL_STAGE3_OUT first"]
    fn release_hwp_b3_1_hwp_clipboard() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        for prefix in ["b3-1-copy-paste", "b3-1-cut-paste"] {
            let orig = std::fs::read(dir.join(format!("{prefix}-original.hwp"))).unwrap();
            let edited = std::fs::read(dir.join(format!("{prefix}-edited.hwp"))).unwrap();
            assert_eq!(check_with_preview_refresh(&orig, &edited), vec![]);
        }
    }
}
