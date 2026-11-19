//! Ownership proof for edited HWP5 OLE streams. Every section record is inspected
//! at its stored depth, including captions, table cells, text boxes and groups.

use std::collections::BTreeMap;

use super::insertions::{definitions, dword, entries, resource_paths, word};
use super::{
    Container, MAX_INFLATED_BYTES, Record, TAG_BIN_DATA, TAG_PARA_HEADER, gso, records,
    section_stream, unpack,
};

const TAG_CTRL_HEADER: u16 = 71;
const TAG_SHAPE_COMPONENT: u16 = 76;
pub(super) const TAG_OLE: u16 = 84;
const ATTR_LOCKED: usize = 1 << 30;

// Section, control instance ID, and the leaf's BinData reference.
type ChartOwner<'a> = (&'a str, usize, usize);

struct Inventory<'a> {
    declarations: usize,
    paths: BTreeMap<usize, String>,
    storage_ids: BTreeMap<usize, (usize, bool)>,
    slots: Vec<usize>,
    owners: BTreeMap<usize, Option<ChartOwner<'a>>>,
}

impl<'a> Inventory<'a> {
    fn engine_slot(&self, id: usize) -> Option<usize> {
        // RHWP loads present embedded/storage entries in DocInfo order, skipping
        // links. find_bin_data_index uses that packed ordinal, then a storage-ID fallback.
        self.slots
            .get(id.checked_sub(1)?)
            .copied()
            .or_else(|| self.storage_ids.get(&id).map(|&(ordinal, _)| ordinal))
    }

    fn reference(&mut self, id: usize, chart: Option<ChartOwner<'a>>) -> Option<()> {
        if id == 0 {
            return Some(()); // Unset image or fill.
        }
        let by_ordinal = self.paths.contains_key(&id).then_some(id);
        let by_storage = self.storage_ids.get(&id).copied();
        let engine = self.engine_slot(id);
        if engine.is_none() && id > self.declarations {
            return None; // Dangling reference.
        }
        // Count every potentially aliased stream. An eligible chart must agree
        // with the engine's slot and the storage ID used by the existing proof.
        let binding = chart.filter(|_| {
            by_storage.is_some_and(|(ordinal, is_storage)| {
                is_storage
                    && engine == Some(ordinal)
                    && (id > self.declarations || by_ordinal == engine)
            })
        });
        let targets = [by_ordinal, by_storage.map(|(ordinal, _)| ordinal), engine];
        for (i, &target) in targets.iter().enumerate() {
            let Some(declaration) = target else { continue };
            if !targets[..i].contains(&target) && self.paths[&declaration].ends_with(".OLE") {
                self.owners
                    .entry(declaration)
                    .and_modify(|owner| *owner = None)
                    .or_insert(binding);
            }
        }
        Some(())
    }
}

/// Image fill IDs occur in DocInfo BORDER_FILL and drawing SHAPE_COMPONENT.
/// Follow RHWP's fill bitmask and field order (solid, gradient, then image).
fn fill_image_id(fill: &[u8]) -> Option<usize> {
    let flags = dword(fill, 0).ok()?;
    if flags & !7 != 0 {
        return None;
    }
    if flags & 2 == 0 {
        return Some(0);
    }
    let mut at = 4 + if flags & 1 != 0 { 12 } else { 0 };
    if flags & 4 != 0 {
        let stops = dword(fill, at + 13).ok()?;
        if stops > 64 {
            return None;
        }
        at += 17 + stops * if stops > 2 { 8 } else { 4 };
    }
    word(fill, at + 4).ok()
}

fn drawing_image_id(component: &[u8]) -> Option<usize> {
    let id = component.get(..4)?;
    if !matches!(
        id,
        b"cip$"
            | b"elo$"
            | b"nil$"
            | b"loc$"
            | b"cer$"
            | b"lle$"
            | b"cra$"
            | b"lop$"
            | b"ruc$"
            | b"noc$"
    ) {
        return None;
    }
    let attr = if component.get(4..8) == Some(id) {
        8
    } else {
        4
    };
    let count = word(component, attr + 42).ok()?;
    let tail = component.get(attr + 92 + 96 * count..)?;
    if id == b"noc$" {
        // This group representation carries a child count, fourcc list and
        // instance ID. The children themselves are visited as section records.
        return (tail.is_empty() || word(tail, 0).is_ok_and(|n| tail.len() == 6 + 4 * n))
            .then_some(0);
    }
    if tail.len() < 17 {
        return Some(0); // No fill after the optional 13-byte border.
    }
    fill_image_id(&tail[13..])
}

fn known_control(data: &[u8]) -> bool {
    matches!(
        data.get(..4),
        Some(
            b" osg"
                | b"dces"
                | b"dloc"
                | b" lbt"
                | b"daeh"
                | b"toof"
                | b"  nf"
                | b"  ne"
                | b"deqe"
                | b"onta"
                | b"onwn"
                | b"pngp"
                | b"tcgp"
                | b"dhgp"
                | b"mxdi"
                | b"mkob"
                | b"spct"
                | b"tudt"
                | b"tmct"
                | b"klc%"
                | b"klh%"
                | b"kmb%"
                | b"etd%"
                | b"tdd%"
                | b"tap%"
                | b"gmm%"
                | b"frx%"
                | b"umf%"
                | b"rms%"
                | b"rsu%"
                | b"em%%"
                | b"rpc%"
                | b"cot%"
        )
    )
}

fn editable_chart_owner<'a>(
    section: &'a str,
    rs: &[Record<'_>],
    ancestors: &[usize],
    leaf: usize,
    id: usize,
) -> Option<ChartOwner<'a>> {
    let &[paragraph, control, component] = ancestors else {
        return None;
    };
    if rs[paragraph].0 != TAG_PARA_HEADER
        || rs[leaf].1 != 3
        || rs.get(leaf + 1).is_some_and(|r| r.1 > 1)
        || rs[component + 1..leaf]
            .iter()
            .any(|r| r.1 == 3 && !matches!(r.0, 72 | 87))
    {
        return None;
    }
    let header = rs[control].2;
    let (kind, attr, relative_component) = gso::shape_ctrl_id(&rs[control..=leaf])?;
    if kind != b"elo$"
        || control + relative_component != component
        || word(rs[component].2, attr + 8).ok()? != 0
        || dword(header, 4).ok()? & ATTR_LOCKED != 0
    {
        return None;
    }
    Some((section, dword(header, 36).ok()?, id))
}

pub(super) fn exclusive_chart_owners(
    container: &Container,
) -> Option<BTreeMap<String, ChartOwner<'_>>> {
    let doc_info = unpack(container, container.streams.get("DocInfo")?).ok()?;
    let doc_records = records(&doc_info)?;
    let defs = definitions(&doc_records);
    let bin_defs = entries(&defs, TAG_BIN_DATA);
    let mut paths = resource_paths(container, &defs).ok()?;
    paths
        .values_mut()
        .for_each(|path| path.make_ascii_uppercase());
    if !paths.values().any(|path| path.ends_with(".OLE")) {
        return Some(BTreeMap::new());
    }
    let mut storage_ids = BTreeMap::new();
    for &ordinal in paths.keys() {
        let declaration = bin_defs[ordinal - 1];
        let kind = word(declaration, 0).ok()? & 15;
        storage_ids.insert(word(declaration, 2).ok()?, (ordinal, kind == 2));
    }
    let mut inventory = Inventory {
        declarations: bin_defs.len(),
        slots: paths.keys().copied().collect(),
        paths,
        storage_ids,
        owners: BTreeMap::new(),
    };

    for (tag, _, body) in doc_records {
        match tag {
            20 => inventory.reference(fill_image_id(body.get(32..)?)?, None)?,
            // The image-bullet extension has no ownership proof. Older text
            // bullets end after the character, newer ones have a zero flag.
            24 if body.len() == 14 || dword(body, 14).ok() == Some(0) => {}
            16..=19 | 21..=23 | 25..=26 | 30..=32 | 92 | 94 => {}
            _ => return None,
        }
    }

    let mut remaining_bytes = MAX_INFLATED_BYTES.checked_sub(doc_info.len() as u64)?;
    for (section, raw) in &container.streams {
        let name = section.to_ascii_uppercase();
        if name.starts_with("VIEWTEXT/") {
            return None;
        }
        if !name.starts_with("BODYTEXT/") {
            continue;
        }
        if !section_stream(section) {
            return None;
        }
        let unpacked = unpack(container, raw).ok()?;
        remaining_bytes = remaining_bytes.checked_sub(unpacked.len() as u64)?;
        let rs = records(&unpacked)?;
        let mut ancestors = Vec::new();
        for (i, &(tag, level, body)) in rs.iter().enumerate() {
            let depth = usize::from(level);
            if depth > ancestors.len() {
                return None;
            }
            ancestors.truncate(depth);
            match tag {
                TAG_CTRL_HEADER if known_control(body) => {}
                TAG_SHAPE_COMPONENT => inventory.reference(drawing_image_id(body)?, None)?,
                TAG_OLE => {
                    let id = dword(body, 12).ok()?;
                    // RHWP casts OLE IDs down to u16. Wide IDs could alias a
                    // smaller slot, so ownership cannot be proven for them.
                    u16::try_from(id).ok()?;
                    inventory.engine_slot(id)?;
                    let owner = editable_chart_owner(section, &rs, &ancestors, i, id);
                    inventory.reference(id, owner)?;
                }
                85 => inventory.reference(word(body, 71).ok()?, None)?,
                70 | 87 if body.is_empty() => {}
                66..=69 | 72..=75 | 77..=83 | 88 | 90 | 92..=93 => {}
                _ => return None,
            }
            ancestors.push(i);
        }
    }
    Some(
        inventory
            .owners
            .into_iter()
            .filter_map(|(ordinal, owner)| Some((inventory.paths[&ordinal].clone(), owner?)))
            .collect(),
    )
}
