//! Narrow HWP5 insertion proof. Layouts follow pinned RHWP serializers and Phase 1
//! record evidence. This is not a general HWP schema or an operation receipt.
//! Original records are matched in order; unknown records are never sorted away.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

type Checked<T> = Result<T, Finding>;
type Defs<'a> = BTreeMap<u16, Vec<&'a [u8]>>;
const BODY: &str = "BodyText/Section0";
const BORDER: u16 = 20;
const BULLET: u16 = 24;
const MAX_UNITS: usize = 2_000_000;
const ALLOWED: [u16; 5] = [18, 20, 21, 24, 25];

pub(super) struct Proof {
    pub streams: BTreeSet<String>,
}
fn finding(code: FindingCode, part: &str) -> Finding {
    Finding::at(code, part)
}
fn require(ok: bool, code: FindingCode, part: &str) -> Checked<()> {
    if ok {
        Ok(())
    } else {
        Err(finding(code, part))
    }
}
fn valid(ok: bool, part: &str) -> Checked<()> {
    require(ok, FindingCode::OutputMalformed, part)
}
fn reference(ok: bool, part: &str) -> Checked<()> {
    require(ok, FindingCode::ReferenceInvalid, part)
}
fn preserved(ok: bool, part: &str) -> Checked<()> {
    require(ok, FindingCode::RecordsChanged, part)
}
fn word(b: &[u8], at: usize) -> Checked<usize> {
    b.get(at..at + 2)
        .map(|p| usize::from(u16::from_le_bytes([p[0], p[1]])))
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))
}
fn dword(b: &[u8], at: usize) -> Checked<usize> {
    b.get(at..at + 4)
        .map(|p| u32::from_le_bytes([p[0], p[1], p[2], p[3]]) as usize)
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))
}
fn definitions<'a>(rs: &[Record<'a>]) -> Defs<'a> {
    let mut out = BTreeMap::<_, Vec<_>>::new();
    for &(tag, _, b) in rs {
        out.entry(tag).or_default().push(b);
    }
    out
}
fn entries<'a, 'b>(defs: &'b Defs<'a>, tag: u16) -> &'b [&'a [u8]] {
    defs.get(&tag).map(Vec::as_slice).unwrap_or_default()
}
fn read_records(c: &Container, name: &str) -> Checked<Vec<u8>> {
    let raw = c
        .streams
        .get(name)
        .ok_or_else(|| finding(FindingCode::PartMissing, name))?;
    unpack(c, raw).map_err(|p| Side::Output.unpack_finding(p, name))
}
fn decode_records<'a>(b: &'a [u8], name: &str) -> Checked<Vec<Record<'a>>> {
    records(b).ok_or_else(|| finding(FindingCode::OutputMalformed, name))
}
fn feature_counts(rs: &[Record<'_>]) -> (usize, usize, Vec<usize>) {
    (
        rs.iter().filter(|r| r.0 == 77).count(),
        rs.iter().filter(|r| r.0 == 85).count(),
        rs.iter()
            .filter(|r| r.0 == 66 && r.1 == 0)
            .filter_map(|r| word(r.2, 8).ok())
            .collect(),
    )
}

/// None keeps the legacy text/T012 contract. A structural insertion or list toggle
/// must prove the entire narrow contract, even if DocInfo happens to be unchanged.
pub(super) fn assess(a: &Container, b: &Container) -> Option<Checked<Proof>> {
    let ad = read_records(a, "DocInfo").ok()?;
    let bd = read_records(b, "DocInfo").ok()?;
    let ar = records(&ad)?;
    let br = records(&bd)?;
    let ac = definitions(&ar);
    let bc = definitions(&br);
    let definition_delta = [18, 20, 24, 25]
        .iter()
        .any(|t| entries(&ac, *t) != entries(&bc, *t));
    let has_bullet = entries(&ac, 25)
        .iter()
        .chain(entries(&bc, 25))
        .any(|p| dword(p, 0).is_ok_and(|v| (v >> 23) & 3 == 3));
    let mut structural = false;
    for (name, data) in &b.streams {
        if !section_stream(name) {
            continue;
        }
        let after = unpack(b, data).ok()?;
        let before = read_records(a, name).ok()?;
        let xr = records(&before)?;
        let yr = records(&after)?;
        let (xt, xp, xs) = feature_counts(&xr);
        let (yt, yp, ys) = feature_counts(&yr);
        // Structural tables/pictures trigger the additive proof; plain text and
        // section/preview normalization retain the existing semantic-reopen path.
        let object_record = |r: &&Record<'_>| {
            matches!(r.0, 72 | 76 | 77 | 85)
                || (r.0 == 71 && (r.2.starts_with(b" lbt") || r.2.starts_with(b" osg")))
        };
        let opaque_changed = !xr
            .iter()
            .filter(object_record)
            .eq(yr.iter().filter(object_record));
        structural |= xt != yt || xp != yp || (has_bullet && xs != ys) || opaque_changed;
    }
    if !definition_delta && !structural {
        return None;
    }
    Some(prove(a, b, &ar, &br))
}

/// The legacy ordinary-edit path permits text deletion/replacement using the
/// independent live/export reopen evidence. Additive text/control units must
/// retain the original paragraph boundaries and context, including empty ones.
/// Match borrowed units and explicit start/end markers in O(n), without per-unit allocation.
/// The additive proof below additionally binds every character/anchor to its end.
pub(super) fn ordinary_boundaries(
    ar: &[Record<'_>],
    br: &[Record<'_>],
    context: bool,
) -> Checked<()> {
    fn roots<'a>(rs: &[Record<'a>]) -> Option<Vec<(&'a [u8], &'a [u8])>> {
        let mut out: Vec<(&[u8], &[u8])> = Vec::new();
        let mut root = false;
        let mut text_seen = false;
        for &(tag, level, bytes) in rs {
            if level == 0 {
                root = tag == 66;
                text_seen = false;
                if root {
                    out.push((b"", bytes.get(8..12)?));
                }
            }
            if root && tag == 67 && level == 1 {
                if text_seen || bytes.len() % 2 != 0 || !bytes.ends_with(b"\r\0") {
                    return None;
                }
                out.last_mut()?.0 = &bytes[..bytes.len() - 2];
                text_seen = true;
            }
        }
        Some(out)
    }
    // This supplementary ordinary-edit invariant is available only for the
    // modeled original layout. Do not invent a malformed-original diagnosis
    // from missing schema evidence: compare_with still owns full framing and
    // opaque-record checks, and structural changes require the strict proof.
    let Some(a) = roots(ar) else {
        return Ok(());
    };
    let b = roots(br).ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    // With the same number of paragraphs, ordinary insertion/deletion of text
    // cannot justify moving a control to another paragraph or transferring a
    // paragraph's shape/style/break flags. Added splits use the additive token
    // proof (or the unchanged-unit boundary check below).
    fn anchors(mut bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
        std::iter::from_fn(move || {
            while bytes.len() >= 2 {
                if matches!(u16::from_le_bytes([bytes[0], bytes[1]]), 2 | 11) {
                    let n = bytes.len().min(16);
                    let (anchor, rest) = bytes.split_at(n);
                    bytes = rest;
                    return Some(anchor);
                }
                bytes = &bytes[2..];
            }
            None
        })
    }
    crate::document::resources::charge(
        crate::document::resources::Category::Comparison,
        (a.len() + b.len()).saturating_mul(std::mem::size_of::<(&[u8], &[u8])>()),
    )
    .map_err(|_| finding(FindingCode::LimitExceeded, BODY))?;
    if context && a.len() == b.len() {
        for ((x, hx), (y, hy)) in a.iter().zip(&b) {
            preserved(anchors(x).eq(anchors(y)) && hx == hy, BODY)?;
        }
    }
    if !context {
        return Ok(());
    } // the strict additive proof owns canonical shape ancestry
    let mut new_units = b.iter().flat_map(|p| p.0.as_chunks::<2>().0.iter());
    let additive = a
        .iter()
        .flat_map(|p| p.0.as_chunks::<2>().0.iter())
        .all(|old| new_units.by_ref().any(|new| new == old));
    // Ordinary deletion/replacement keeps its existing independent reopen
    // contract. Additive ordinary text, including unchanged text, must also
    // preserve old paragraph ends: appending one character is not a bypass.
    if !additive {
        return Ok(());
    }
    preserved(
        a.iter()
            .map(|p| p.1[3])
            .filter(|f| *f != 0)
            .eq(b.iter().map(|p| p.1[3]).filter(|f| *f != 0)),
        BODY,
    )?;
    fn tokens<'a>(
        paras: &'a [(&'a [u8], &'a [u8])],
    ) -> impl Iterator<Item = (u8, u16, &'a [u8])> + 'a {
        paras.iter().flat_map(|(text, header)| {
            let context = &header[..3];
            // Start flags remain on the split prefix; the old terminator may
            // match the suffix. Kind separates flags from characters/CR.
            std::iter::once((1, u16::from(header[3]), &b""[..]))
                .filter(|(_, f, _)| *f != 0)
                .chain(
                    text.as_chunks::<2>()
                        .0
                        .iter()
                        .map(move |u| (0, u16::from_le_bytes(*u), context)),
                )
                .chain(std::iter::once((0, 13, context)))
        })
    }
    let mut after = tokens(&b);
    for before in tokens(&a) {
        preserved(after.by_ref().any(|token| token == before), BODY)?;
    }
    Ok(())
}

fn mappings(rs: &[Record<'_>], defs: &Defs<'_>) -> Checked<Vec<usize>> {
    preserved(
        rs.first().is_some_and(|r| r.0 == 16 && r.1 == 0)
            && rs.get(1).is_some_and(|r| r.0 == 17 && r.1 == 0)
            && entries(defs, 16).len() == 1,
        "DocInfo",
    )?;
    preserved(
        rs.iter().all(|r| !matches!(r.0, 18..=26) || r.1 == 1),
        "DocInfo",
    )?;
    let all: Vec<_> = rs.iter().filter(|r| r.0 == 17).collect();
    preserved(all.len() == 1 && all[0].1 == 0, "DocInfo")?;
    let bytes = all[0].2;
    // No 64->72 exception: unknown/tracking fields must never be invented/reset.
    preserved(matches!(bytes.len(), 64 | 72), "DocInfo")?;
    let counts: Vec<_> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| u32::from_le_bytes(*p) as usize)
        .collect();
    for (index, tag) in [
        (0, 18),
        (8, 20),
        (9, 21),
        (10, 22),
        (11, 23),
        (12, 24),
        (13, 25),
        (14, 26),
    ] {
        preserved(counts[index] == entries(defs, tag).len(), "DocInfo")?;
    }
    preserved(
        counts[1..8].iter().sum::<usize>() == entries(defs, 19).len(),
        "DocInfo",
    )?;
    Ok(counts)
}
fn prove(a: &Container, b: &Container, ar: &[Record<'_>], br: &[Record<'_>]) -> Checked<Proof> {
    preserved(a.header[34] <= 1 && b.header[34] <= 1, "FileHeader")?;
    preserved(ar.len() <= 20_000 && br.len() <= 20_000, "DocInfo")?;
    let ac = definitions(ar);
    let bc = definitions(br);
    let am = mappings(ar, &ac)?;
    let bm = mappings(br, &bc)?;
    preserved(am.len() == bm.len(), "DocInfo")?;
    let mut added = Defs::new();
    let mut seen = BTreeMap::<u16, usize>::new();
    let mut i = 0;
    for (position, r) in br.iter().enumerate() {
        if let Some(old) = ar.get(i) {
            let same = if old.0 == 17 {
                r.0 == 17 && r.1 == old.1
            } else {
                same_record(old, r)
            };
            if same {
                *seen.entry(old.0).or_default() += 1;
                i += 1;
                continue;
            }
        }
        // Only append to a definition's original ID block. Never match by tag alone.
        preserved(
            ALLOWED.contains(&r.0)
                && r.1 == 1
                && seen.get(&r.0).copied().unwrap_or(0) == entries(&ac, r.0).len(),
            "DocInfo",
        )?;
        if let Some(next) = ar.get(i) {
            preserved(next.0 > r.0, "DocInfo")?;
        }
        let previous = position.checked_sub(1).and_then(|p| br.get(p));
        preserved(
            previous.is_some_and(|p| {
                if entries(&ac, r.0).is_empty() {
                    p.0 <= r.0
                } else {
                    p.0 == r.0
                }
            }),
            "DocInfo",
        )?;
        let new = added.entry(r.0).or_default();
        preserved(
            !entries(&ac, r.0).contains(&r.2) && !new.contains(&r.2),
            "DocInfo",
        )?;
        new.push(r.2);
    }
    preserved(i == ar.len(), "DocInfo")?;
    for index in 0..am.len() {
        let tag = match index {
            0 => 18,
            8 => 20,
            9 => 21,
            12 => 24,
            13 => 25,
            _ => 0,
        };
        preserved(
            am[index].checked_add(entries(&added, tag).len()) == Some(bm[index]),
            "DocInfo",
        )?;
    }
    // Reuse the existing T012 metric proof, including its original-shape ancestry.
    if !entries(&added, 21).is_empty() {
        let mut reduced = Vec::new();
        let mut adjusted = entries(&bc, 17)[0].to_vec();
        for index in [0, 8, 12, 13] {
            adjusted[index * 4..index * 4 + 4].copy_from_slice(&(am[index] as u32).to_le_bytes());
        }
        let mut ordinal = BTreeMap::<u16, usize>::new();
        for r in br {
            let n = ordinal.entry(r.0).or_default();
            *n += 1;
            if [18, 20, 24, 25].contains(&r.0) && *n > entries(&ac, r.0).len() {
                continue;
            }
            reduced.push(if r.0 == 17 {
                (17, r.1, adjusted.as_slice())
            } else {
                *r
            });
        }
        preserved(
            docinfo_char_shapes_appended(ar, &reduced)
                .is_some_and(|(base, k)| appended_char_shapes_referenced(b, base, k)),
            "DocInfo",
        )?;
    }
    for bf in entries(&added, BORDER) {
        preserved(*bf == basic_border_fill(), "DocInfo")?;
    }
    for bullet in entries(&added, BULLET) {
        basic_bullet(bullet, &bc)?;
    }
    for ps in entries(&added, 25) {
        valid_para_shape(ps, &bc)?;
        let attr = dword(ps, 0)?;
        preserved(
            matches!((attr >> 23) & 3, 0 | 3)
                && (attr >> 25) & 7 == 0
                && (ps.len() == 54 || dword(ps, 54)? == 0),
            "DocInfo",
        )?;
        let signature = para_signature(ps)?;
        preserved(
            entries(&ac, 25)
                .iter()
                .any(|old| para_signature(old).is_ok_and(|v| v == signature)),
            "DocInfo",
        )?;
    }
    // Validate every modeled definition, including existing reachable references.
    for ps in entries(&bc, 25) {
        valid_para_shape(ps, &bc)?;
    }
    for bullet in entries(&bc, 24) {
        reference(dword(bullet, 8)? < entries(&bc, 21).len(), "DocInfo")?;
    }
    let resources = resources(a, b, &ac, &bc)?;
    let mut used = Used::default();
    let mut table_ids = BTreeSet::new();
    let mut table_total = 0;
    let mut picture_total = 0;
    for (name, data) in &b.streams {
        if !section_stream(name) {
            continue;
        }
        let before = read_records(a, name)?;
        let after = unpack(b, data).map_err(|e| Side::Output.unpack_finding(e, name))?;
        let xr = decode_records(&before, name)?;
        let yr = decode_records(&after, name)?;
        let mut old = section(&xr, &ac, &ac)?;
        let new = section(&yr, &bc, &ac)?;
        // The observed compatibility is 3->0, never invention of an initial marker.
        preserved(!(xr[0].2[11] & 3 == 0 && yr[0].2[11] & 3 == 3), name)?;
        for object in &old.objects {
            let kind = object[0].2.get(..4).unwrap_or_default();
            preserved(matches!(kind, b"dces" | b"dloc" | b" lbt" | b" osg"), name)?;
            if kind == b" osg" {
                valid(
                    object.len() == 3
                        && object[1].0 == 76
                        && object[1].1 == 2
                        && object[1].2.starts_with(b"cip$")
                        && object[2].0 == 85
                        && object[2].1 == 3,
                    name,
                )?;
            }
            if kind == b" lbt" {
                validate_table(object, &ac, &mut Used::default(), &mut BTreeSet::new())?;
            }
            preserved(object.iter().skip(1).all(|r| r.0 != 71), name)?;
            if matches!(kind, b" lbt" | b" osg") {
                let id = dword(object[0].2, 36)?;
                if id != 0 {
                    reference(table_ids.insert(id), name)?;
                }
            }
        }
        preserved(
            old.paragraphs <= new.paragraphs && old.breaks == new.breaks,
            name,
        )?;
        // Insertion/splitting may add text; it must not delete/reformat original characters.
        let mut tokens = new.tokens.iter();
        for token in &old.tokens {
            preserved(tokens.any(|t| t.preserves(token)), name)?;
        }
        let mut cursor = 0;
        for object in &new.objects {
            if old.objects.get(cursor).is_some_and(|o| o == object) {
                cursor += 1;
                continue;
            }
            if object[0].2.starts_with(b" lbt") {
                validate_table(object, &bc, &mut used, &mut table_ids)?;
                table_total += 1;
            } else if object[0].2.starts_with(b" osg") {
                validate_picture(object, &bc, &resources, &mut used)?;
                picture_total += 1;
            } else {
                return Err(finding(FindingCode::RecordsChanged, name));
            }
        }
        preserved(cursor == old.objects.len(), name)?;
        used.paras.extend(new.para_ids);
        old.objects.clear();
    }
    // Paragraph reachability, then definition-to-definition reachability.
    for id in used.paras.clone() {
        if let Some(ps) = entries(&bc, 25).get(id) {
            if (dword(ps, 0)? >> 23) & 3 == 3 {
                used.bullets.insert(word(ps, 30)?);
            }
        }
    }
    for (tag, field) in [
        (20, &used.borders),
        (24, &used.bullets),
        (25, &used.paras),
        (18, &used.pictures),
    ] {
        let start = entries(&ac, tag).len();
        for index in start..entries(&bc, tag).len() {
            reference(field.contains(&(index + usize::from(tag != 25))), "DocInfo")?;
        }
    }
    reference(picture_total == resources.new_paths.len(), "DocInfo")?;
    preserved(entries(&added, 20).is_empty() || table_total > 0, "DocInfo")?;
    Ok(Proof {
        streams: resources.new_paths,
    })
}

fn basic_bullet(bullet: &[u8], defs: &Defs<'_>) -> Checked<()> {
    valid(bullet.len() == 24, "DocInfo")?;
    reference(dword(bullet, 8)? < entries(defs, 21).len(), "DocInfo")?;
    let mut canonical = vec![0u8; 24];
    canonical[0] = 8;
    canonical[6] = 50;
    canonical[12..14].copy_from_slice(&0x2022u16.to_le_bytes());
    canonical[8..12].copy_from_slice(&bullet[8..12]);
    preserved(bullet == canonical, "DocInfo")
}
fn basic_border_fill() -> Vec<u8> {
    // serialize_border_fill: attr2 + four(style,width,COLORREF) + diagonal6 + fill12.
    let mut b = vec![0u8; 40];
    for at in [2, 8, 14, 20] {
        b[at] = 1;
        b[at + 1] = 1;
    }
    b[26] = 1;
    b
}
fn para_signature(ps: &[u8]) -> Checked<Vec<u8>> {
    valid(matches!(ps.len(), 54 | 58), "DocInfo")?;
    let mut out = ps.to_vec();
    let attr = dword(ps, 0)? as u32;
    out[..4].copy_from_slice(&(attr & !(0x1f << 23)).to_le_bytes());
    out[30..32].fill(0);
    Ok(out)
}
fn valid_para_shape(ps: &[u8], defs: &Defs<'_>) -> Checked<()> {
    valid(matches!(ps.len(), 54 | 58), "DocInfo")?;
    let attr = dword(ps, 0)?;
    let head = (attr >> 23) & 3;
    let id = word(ps, 30)?;
    reference(word(ps, 28)? < entries(defs, 22).len(), "DocInfo")?;
    let bf = word(ps, 32)?;
    reference(bf == 0 || bf <= entries(defs, 20).len(), "DocInfo")?;
    match head {
        0 => reference(id == 0, "DocInfo"),
        3 => {
            reference(id > 0 && id <= entries(defs, 24).len(), "DocInfo")?;
            basic_bullet(entries(defs, 24)[id - 1], defs)?;
            preserved(
                (attr >> 25) & 7 == 0 && (ps.len() == 54 || dword(ps, 54)? == 0),
                "DocInfo",
            )
        }
        _ => reference(id == 0 || id <= entries(defs, 23).len(), "DocInfo"),
    }
}

struct Resources {
    new_paths: BTreeSet<String>,
    dimensions: BTreeMap<usize, (u32, u32)>,
}
/// Existing declarations use the T009 storage model, not the insertion schema.
/// Resolve each definition independently of its ordinal: picture IDs refer to
/// definition ordinals; storage IDs are allowed to be sparse. Never guess a path.
fn resource_paths(c: &Container, defs: &Defs<'_>) -> Checked<BTreeMap<usize, String>> {
    let mut paths = BTreeMap::new();
    for name in c.streams.keys() {
        if name.to_ascii_uppercase().starts_with("BINDATA/") {
            reference(
                paths
                    .insert(name.to_ascii_uppercase(), name.clone())
                    .is_none(),
                name,
            )?;
        }
    }
    let mut resolved = BTreeMap::new();
    let mut claimed = BTreeSet::new();
    let mut storage_ids = BTreeSet::new();
    for (index, decl) in entries(defs, 18).iter().enumerate() {
        let attr = word(decl, 0)?;
        match attr & 15 {
            0 => {
                // Linked BIN_DATA: two counted UTF-16 paths, no embedded stream.
                let mut at = 2;
                for _ in 0..2 {
                    let n = word(decl, at)?;
                    at += 2;
                    let bytes = decl
                        .get(at..at + 2 * n)
                        .ok_or_else(|| finding(FindingCode::OutputMalformed, "DocInfo"))?;
                    let units: Vec<_> = bytes
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|v| u16::from_le_bytes(*v))
                        .collect();
                    valid(String::from_utf16(&units).is_ok(), "DocInfo")?;
                    at += 2 * n;
                }
                valid(at == decl.len(), "DocInfo")?;
                continue;
            }
            1 | 2 => {}
            _ => return Err(finding(FindingCode::Unsupported, "DocInfo")),
        }
        let id = word(decl, 2)?;
        let ext = if attr & 15 == 2 && decl.len() == 4 {
            "OLE".to_owned()
        } else {
            let n = word(decl, 4)?;
            valid(decl.len() == 6 + 2 * n, "DocInfo")?;
            let units: Vec<_> = decl[6..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|v| u16::from_le_bytes(*v))
                .collect();
            String::from_utf16(&units)
                .map_err(|_| finding(FindingCode::OutputMalformed, "DocInfo"))?
        };
        valid(
            id > 0 && !ext.is_empty() && ext.is_ascii() && !ext.contains(['/', '\\']),
            "DocInfo",
        )?;
        let path = format!("BinData/BIN{id:04X}.{ext}");
        valid((attr >> 4) & 3 != 3, &path)?;
        let key = path.to_ascii_uppercase();
        reference(
            storage_ids.insert(id) && claimed.insert(key.clone()),
            "DocInfo",
        )?;
        let actual = paths
            .get(&key)
            .ok_or_else(|| finding(FindingCode::ReferenceInvalid, &path))?;
        resolved.insert(index + 1, actual.clone());
    }
    Ok(resolved)
}
fn resources(a: &Container, b: &Container, ac: &Defs<'_>, bc: &Defs<'_>) -> Checked<Resources> {
    let old = entries(ac, 18);
    let all = entries(bc, 18);
    preserved(all.starts_with(old), "DocInfo")?;
    // Reject unsupported new storage before interpreting it as a legacy form.
    for (index, decl) in all.iter().enumerate().skip(old.len()) {
        preserved(
            word(decl, 0)? & 15 == 1 && word(decl, 2)? == index + 1,
            "DocInfo",
        )?;
    }
    let paths = resource_paths(b, bc)?;
    // Original stream bytes/compression equivalence are checked independently
    // by compare_with/compare_stream. Exact definition prefixes and preserved
    // object tokens bind the original reference meaning to those same streams.
    let mut new_paths = BTreeSet::new();
    let mut dimensions = BTreeMap::new();
    for (index, decl) in all.iter().enumerate().skip(old.len()) {
        let attr = word(decl, 0)?;
        let id = word(decl, 2)?;
        preserved(id == index + 1, "DocInfo")?;
        let actual = paths
            .get(&(index + 1))
            .ok_or_else(|| finding(FindingCode::ReferenceInvalid, "DocInfo"))?;
        let units: Vec<_> = decl[6..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|v| u16::from_le_bytes(*v))
            .collect();
        let ext = String::from_utf16(&units)
            .map_err(|_| finding(FindingCode::OutputMalformed, "DocInfo"))?;
        preserved(
            matches!(ext.as_str(), "png" | "jpg" | "jpeg")
                && !a.streams.keys().any(|n| n.eq_ignore_ascii_case(actual)),
            "DocInfo",
        )?;
        let raw = &b.streams[actual];
        let compression = (attr >> 4) & 3;
        let decoded = if compression == 1 || (compression == 0 && b.compressed) {
            inflate_bounded(raw, crate::picture::MAX_BYTES as u64)
                .map_err(|e| Side::Output.unpack_finding(e, actual))?
        } else {
            raw.to_vec()
        };
        preserved(attr == 0x0101, "DocInfo")?;
        valid(decoded.len() <= crate::picture::MAX_BYTES, actual)?;
        valid(
            if ext == "png" {
                decoded.starts_with(b"\x89PNG\r\n\x1a\n")
            } else {
                decoded.starts_with(b"\xff\xd8\xff")
            },
            actual,
        )?;
        let size = crate::picture::dimensions(&decoded)
            .ok_or_else(|| finding(FindingCode::OutputMalformed, actual))?;
        dimensions.insert(index + 1, size);
        new_paths.insert(actual.clone());
    }
    for name in b
        .streams
        .keys()
        .filter(|n| n.to_ascii_uppercase().starts_with("BINDATA/"))
    {
        if !a.streams.contains_key(name) {
            reference(new_paths.contains(name), name)?;
        }
    }
    Ok(Resources {
        new_paths,
        dimensions,
    })
}
#[derive(Default)]
struct Used {
    borders: BTreeSet<usize>,
    bullets: BTreeSet<usize>,
    paras: BTreeSet<usize>,
    pictures: BTreeSet<usize>,
}
#[derive(PartialEq, Eq)]
struct Token {
    unit: u16,
    char_ids: Arc<[usize]>,
    para: Arc<[u8]>,
    style: usize,
}
impl Token {
    fn preserves(&self, old: &Self) -> bool {
        self.unit == old.unit
            && self.para == old.para
            && self.style == old.style
            && old.char_ids.iter().all(|id| self.char_ids.contains(id))
    }
}
struct Section<'a> {
    tokens: Vec<Token>,
    objects: Vec<Vec<Record<'a>>>,
    para_ids: BTreeSet<usize>,
    paragraphs: usize,
    breaks: Vec<u8>,
}

fn section<'a>(
    rs: &[Record<'a>],
    defs: &Defs<'_>,
    original_defs: &Defs<'_>,
) -> Checked<Section<'a>> {
    let mut out = Section {
        tokens: Vec::new(),
        objects: Vec::new(),
        para_ids: BTreeSet::new(),
        paragraphs: 0,
        breaks: Vec::new(),
    };
    let mut i = 0;
    valid(
        !rs.is_empty() && rs.len() <= 100_000 && rs.windows(2).all(|r| r[1].1 <= r[0].1 + 1),
        BODY,
    )?;
    while i < rs.len() {
        valid(rs[i].0 == 66 && rs[i].1 == 0, BODY)?;
        let end = rs[i + 1..]
            .iter()
            .position(|r| r.1 == 0)
            .map_or(rs.len(), |p| i + 1 + p);
        let para = &rs[i..end];
        let controls = paragraph(para, 0, defs, original_defs, &mut out)?;
        out.objects.extend(controls);
        out.paragraphs += 1;
        i = end;
        valid(
            out.paragraphs <= 100_000 && out.tokens.len() <= MAX_UNITS,
            BODY,
        )?;
    }
    Ok(out)
}
fn paragraph<'a>(
    rs: &[Record<'a>],
    level: u16,
    defs: &Defs<'_>,
    original_defs: &Defs<'_>,
    out: &mut Section<'a>,
) -> Checked<Vec<Vec<Record<'a>>>> {
    let header = rs
        .first()
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    valid(
        header.0 == 66 && header.1 == level && matches!(header.2.len(), 22 | 24),
        BODY,
    )?;
    let ps = word(header.2, 8)?;
    let style = *header
        .2
        .get(10)
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))? as usize;
    reference(
        ps < entries(defs, 25).len() && style < entries(defs, 26).len(),
        BODY,
    )?;
    out.para_ids.insert(ps);
    let signature: Arc<[u8]> = para_signature(entries(defs, 25)[ps])?.into();
    preserved(
        matches!((dword(entries(defs, 25)[ps], 0)? >> 23) & 3, 0 | 3),
        BODY,
    )?;
    let texts: Vec<_> = rs
        .iter()
        .filter(|r| r.0 == 67 && r.1 == level + 1)
        .collect();
    let runs: Vec<_> = rs
        .iter()
        .filter(|r| r.0 == 68 && r.1 == level + 1)
        .collect();
    let lines = rs.iter().filter(|r| r.0 == 69 && r.1 == level + 1).count();
    valid(texts.len() <= 1 && runs.len() == 1 && lines == 1, BODY)?;
    // Reserve token storage before allocation; shape/paragraph signatures are
    // shared per run/paragraph rather than copied once for every character.
    let text = texts.first().map_or(&b"\r\0"[..], |r| r.2);
    let run = runs[0].2;
    let line_count: usize = rs
        .iter()
        .filter(|r| r.0 == 69 && r.1 == level + 1)
        .map(|r| r.2.len() / 36)
        .sum();
    valid(
        word(header.2, 12)? == run.len() / 8
            && word(header.2, 14)? == 0
            && word(header.2, 16)? == line_count,
        BODY,
    )?;
    valid(
        text.len() / 2 <= MAX_UNITS
            && text.len() % 2 == 0
            && text.len() / 2 == (dword(header.2, 0)? & 0x7fffffff)
            && !run.is_empty()
            && run.len() % 8 == 0,
        BODY,
    )?;
    crate::document::resources::charge(
        crate::document::resources::Category::Comparison,
        (text.len() / 2).saturating_mul(std::mem::size_of::<Token>()),
    )
    .map_err(|_| finding(FindingCode::LimitExceeded, BODY))?;
    let mut shapes = Vec::new();
    let mut last = None;
    for pair in run.as_chunks::<8>().0 {
        let offset = dword(pair, 0)?;
        let id = dword(pair, 4)?;
        reference(id < entries(defs, 21).len(), BODY)?;
        valid(
            offset < text.len() / 2 && last.is_none_or(|p| p < offset),
            BODY,
        )?;
        last = Some(offset);
        let identity: Arc<[usize]> = if id < entries(original_defs, 21).len() {
            vec![id].into()
        } else {
            let new = entries(defs, 21)[id];
            let parents = entries(original_defs, 21)
                .iter()
                .enumerate()
                .filter_map(|(index, old)| {
                    (old.len() == new.len()
                        && new.len() >= 28
                        && old[..14] == new[..14]
                        && old[28..] == new[28..])
                        .then_some(index)
                })
                .collect::<Vec<_>>();
            reference(!parents.is_empty(), BODY)?;
            parents.into()
        };
        shapes.push((offset, identity));
    }
    valid(shapes[0].0 == 0, BODY)?;
    let mut objects = Vec::new();
    let mut last_meta = 66;
    let mut controls_started = false;
    let mut i = 1;
    while i < rs.len() {
        let r = rs[i];
        match r.0 {
            67..=69 => {
                valid(!controls_started && r.0 > last_meta, BODY)?;
                last_meta = r.0;
                valid(
                    r.1 == level + 1
                        && (r.0 != 69 || (!r.2.is_empty() && r.2.len().is_multiple_of(36))),
                    BODY,
                )?;
                i += 1;
            }
            71 if level == 0 => {
                controls_started = true;
                valid(r.1 == 1 && r.2.len() >= 4, BODY)?;
                let end = rs[i + 1..]
                    .iter()
                    .position(|r| r.1 <= 1)
                    .map_or(rs.len(), |p| i + 1 + p);
                let object = rs[i..end].to_vec();
                generic_references(&object, defs)?;
                objects.push(object);
                i = end;
            }
            _ if matches!(r.0, 66..=85) => return Err(finding(FindingCode::OutputMalformed, BODY)),
            _ => return Err(finding(FindingCode::RecordsChanged, BODY)),
        }
    }
    // Pinned RHWP keeps an initial section/column marker (bits 0..1=3)
    // on a text prefix but clears it for an empty root hosting a new table.
    // B6 and B-text prove 3->0 only at the initial paragraph containing BOTH
    // exact-preserved secd/cold controls. Other bits (notably page breaks),
    // incomplete markers, and every later paragraph retain ordered boundaries.
    let first_section = level == 0
        && out.paragraphs == 0
        && objects.iter().any(|o| o[0].2.starts_with(b"dces"))
        && objects.iter().any(|o| o[0].2.starts_with(b"dloc"));
    let flags = header.2[11];
    let flags = if first_section && matches!(flags & 3, 0 | 3) {
        flags & !3
    } else {
        flags
    };
    if level == 0 && flags != 0 {
        out.breaks.push(flags);
        out.tokens.push(Token {
            unit: 0,
            char_ids: vec![0].into(),
            para: vec![b'B', flags].into(),
            style: 0,
        });
    }
    if level != 0 {
        preserved(flags == 0, BODY)?;
    }
    valid(text.ends_with(b"\r\0"), BODY)?;
    let mut plain_units = Vec::new();
    let mut control_ids = Vec::new();
    let mut unit = 0;
    let mut shape = 0;
    while unit < text.len() / 2 {
        let ch = word(text, unit * 2)? as u16;
        while shape + 1 < shapes.len() && shapes[shape + 1].0 <= unit {
            shape += 1;
        }
        if matches!(ch, 2 | 11) {
            valid(
                unit + 8 <= text.len() / 2 && word(text, (unit + 7) * 2)? == ch as usize,
                BODY,
            )?;
            let object = objects
                .get(control_ids.len())
                .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
            use sha2::{Digest, Sha256};
            let mut digest = Sha256::new();
            for &(tag, level, payload) in object {
                digest.update(tag.to_le_bytes());
                digest.update(level.to_le_bytes());
                digest.update((payload.len() as u64).to_le_bytes());
                digest.update(payload);
            }
            out.tokens.push(Token {
                unit: 0,
                char_ids: vec![0].into(),
                para: digest.finalize().to_vec().into(),
                style: 0,
            });
            control_ids.push(text[unit * 2 + 2..unit * 2 + 6].to_vec());
            unit += 8;
            continue;
        }
        if ch == 13 {
            valid(unit + 1 == text.len() / 2, BODY)?;
            out.tokens.push(Token {
                unit: 13,
                char_ids: shapes[shape].1.clone(),
                para: signature.clone(),
                style,
            });
            unit += 1;
            continue;
        }
        valid(ch >= 32 || ch == 10, BODY)?;
        plain_units.push(ch);
        out.tokens.push(Token {
            unit: ch,
            char_ids: shapes[shape].1.clone(),
            para: signature.clone(),
            style,
        });
        unit += 1;
    }
    valid(String::from_utf16(&plain_units).is_ok(), BODY)?;
    let actual_ids: Vec<_> = objects.iter().map(|o| o[0].2[..4].to_vec()).collect();
    valid(actual_ids == control_ids, BODY)?;
    let mask = control_ids.iter().fold(0usize, |mask, id| {
        mask | if id == b"dces" || id == b"dloc" {
            1 << 2
        } else {
            1 << 11
        }
    });
    valid(dword(header.2, 4)? == mask, BODY)?;
    Ok(objects)
}
fn generic_references(rs: &[Record<'_>], defs: &Defs<'_>) -> Checked<()> {
    // A LIST_HEADER can also be a caption/header/textbox. Decode cell offsets
    // only under a table control AFTER its TABLE record, never from size alone.
    let mut tables: Vec<(u16, bool)> = Vec::new();
    for &(tag, level, b) in rs {
        while tables.last().is_some_and(|(parent, _)| level <= *parent) {
            tables.pop();
        }
        if tag == 71 && b.starts_with(b" lbt") {
            tables.push((level, false));
        }
        match tag {
            77 => {
                if let Some((owner, seen)) = tables.last_mut() {
                    if level == *owner + 1 {
                        *seen = true;
                    }
                }
                let rows = word(b, 4)?;
                valid(rows > 0 && rows <= 4096, BODY)?;
                let id = word(b, 18 + 2 * rows)?;
                reference(id > 0 && id <= entries(defs, 20).len(), BODY)?;
            }
            72 if tables
                .last()
                .is_some_and(|(owner, seen)| *seen && level == *owner + 1) =>
            {
                let id = word(b, 32)?;
                reference(id > 0 && id <= entries(defs, 20).len(), BODY)?;
            }
            85 => {
                let id = word(b, 71)?;
                reference(id > 0 && id <= entries(defs, 18).len(), BODY)?;
            }
            66 => reference(word(b, 8)? < entries(defs, 25).len(), BODY)?,
            68 => {
                valid(!b.is_empty() && b.len() % 8 == 0, BODY)?;
                for run in b.as_chunks::<8>().0 {
                    reference(dword(run, 4)? < entries(defs, 21).len(), BODY)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}
fn validate_table(
    rs: &[Record<'_>],
    defs: &Defs<'_>,
    used: &mut Used,
    ids: &mut BTreeSet<usize>,
) -> Checked<()> {
    let h = rs[0].2;
    valid(h.len() == 42, BODY)?;
    preserved((dword(h, 4)? & !1) == 0x082a2210, BODY)?;
    valid(
        dword(h, 8)? == 0 && dword(h, 12)? == 0 && word(h, 40)? == 0,
        BODY,
    )?;
    let id = dword(h, 36)?;
    reference(id > 0 && ids.insert(id), BODY)?;
    valid(
        (1..=2_000_000).contains(&dword(h, 16)?) && (1..=2_000_000).contains(&dword(h, 20)?),
        BODY,
    )?;
    valid(rs.get(1).is_some_and(|r| r.0 == 77 && r.1 == 2), BODY)?;
    let table = rs[1].2;
    let rows = word(table, 4)?;
    let cols = word(table, 6)?;
    valid(
        (1..=32).contains(&rows)
            && (1..=16).contains(&cols)
            && rows * cols <= 256
            && table.len() == 22 + 2 * rows
            && dword(table, 0)? == 0
            && word(table, 20 + 2 * rows)? == 0,
        BODY,
    )?;
    for row in 0..rows {
        valid(word(table, 18 + row * 2)? == cols, BODY)?;
    }
    let border = word(table, 18 + rows * 2)?;
    reference(border > 0 && border <= entries(defs, 20).len(), BODY)?;
    preserved(entries(defs, 20)[border - 1] == basic_border_fill(), BODY)?;
    used.borders.insert(border);
    let mut at = 2;
    let mut widths = vec![0; cols];
    let mut row_height = 0;
    for cell in 0..rows * cols {
        let r = rs
            .get(at)
            .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
        valid(r.0 == 72 && r.1 == 2 && r.2.len() == 47, BODY)?;
        let b = r.2;
        valid(
            word(b, 0)? == 1
                && dword(b, 2)? == 0x00200000
                && word(b, 6)? == 0x400
                && word(b, 8)? == cell % cols
                && word(b, 10)? == cell / cols
                && word(b, 12)? == 1
                && word(b, 14)? == 1
                && dword(b, 16)? > 0
                && dword(b, 20)? > 0
                && dword(b, 20)? <= dword(h, 20)?,
            BODY,
        )?;
        valid(
            b[34..38] == b[16..20] && b[38..].iter().all(|v| *v == 0),
            BODY,
        )?;
        let col = cell % cols;
        if cell < cols {
            widths[col] = dword(b, 16)?;
        } else {
            valid(widths[col] == dword(b, 16)?, BODY)?;
        }
        if col == 0 {
            row_height = dword(b, 20)?;
        } else {
            valid(row_height == dword(b, 20)?, BODY)?;
        }
        let bf = word(b, 32)?;
        reference(bf == border, BODY)?;
        used.borders.insert(bf);
        at += 1;
        let end = rs[at..]
            .iter()
            .position(|r| r.0 == 72)
            .map_or(rs.len(), |p| at + p);
        let mut out = Section {
            tokens: Vec::new(),
            objects: Vec::new(),
            para_ids: BTreeSet::new(),
            paragraphs: 0,
            breaks: Vec::new(),
        };
        let nested = paragraph(&rs[at..end], 2, defs, defs, &mut out)?;
        valid(nested.is_empty(), BODY)?;
        used.paras.extend(out.para_ids);
        at = end;
    }
    valid(
        at == rs.len() && widths.iter().sum::<usize>() == dword(h, 16)?,
        BODY,
    )
}
fn validate_picture(
    rs: &[Record<'_>],
    defs: &Defs<'_>,
    resources: &Resources,
    used: &mut Used,
) -> Checked<()> {
    valid(
        rs.len() == 3
            && rs[0].1 == 1
            && rs[1].0 == 76
            && rs[1].1 == 2
            && rs[2].0 == 85
            && rs[2].1 == 3,
        BODY,
    )?;
    let h = rs[0].2;
    valid(h.len() >= 46, BODY)?;
    preserved(dword(h, 4)? == 0x000a0311, BODY)?;
    valid(
        dword(h, 8)? == 0 && dword(h, 12)? == 0 && dword(h, 36)? == 0 && dword(h, 40)? == 0,
        BODY,
    )?;
    let n = word(h, 44)?;
    valid(
        h.len() == 46 + 2 * n
            && n <= 256
            && dword(h, 24)? == 1
            && h[28..36].iter().all(|v| *v == 0),
        BODY,
    )?;
    valid(
        String::from_utf16(
            &h[46..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect::<Vec<_>>(),
        )
        .is_ok(),
        BODY,
    )?;
    let w = dword(h, 16)?;
    let height = dword(h, 20)?;
    valid(
        (1..=2_000_000).contains(&w) && (1..=2_000_000).contains(&height),
        BODY,
    )?;
    let s = rs[1].2;
    let mut canonical = vec![0u8; 52];
    canonical[..8].copy_from_slice(b"cip$cip$");
    canonical[18..20].copy_from_slice(&1u16.to_le_bytes());
    for (at, v) in [(20, w), (24, height), (28, w), (32, height)] {
        canonical[at..at + 4].copy_from_slice(&(v as u32).to_le_bytes());
    }
    canonical[50..52].copy_from_slice(&1u16.to_le_bytes());
    for _ in 0..3 {
        for v in [1f64, 0., 0., 0., 1., 0.] {
            canonical.extend(v.to_le_bytes());
        }
    }
    valid(s == canonical, BODY)?;
    let pic = rs[2].2;
    valid(pic.len() == 91, BODY)?;
    let id = word(pic, 71)?;
    reference(
        id > 0
            && id <= entries(defs, 18).len()
            && resources.dimensions.contains_key(&id)
            && used.pictures.insert(id),
        BODY,
    )?;
    let (pw, ph) = resources.dimensions[&id];
    let nw = pw as usize * 75;
    let nh = ph as usize * 75;
    let mut expected = vec![0u8; 91];
    for (at, v) in [
        (20, w),
        (28, w),
        (32, height),
        (40, height),
        (52, nw),
        (56, nh),
        (82, nw),
        (86, nh),
    ] {
        expected[at..at + 4].copy_from_slice(&(v as u32).to_le_bytes());
    }
    expected[71..73].copy_from_slice(&(id as u16).to_le_bytes());
    valid(pic == expected, BODY)
}

/// Extra reference checks for modeled structures, including pre-existing objects.
/// Unmodeled bodies retain their existing opaque/reopen boundary, not a guessed schema.
pub(super) fn reference_findings(c: &Container) -> Vec<Finding> {
    let result = (|| -> Checked<()> {
        let mut pictures = false;
        // compare_with owns framing/unpack diagnostics on both sides. Avoid
        // relabeling an identical malformed original as a second output error.
        let Ok(data) = read_records(c, "DocInfo") else {
            return Ok(());
        };
        let Some(rs) = records(&data) else {
            return Ok(());
        };
        let defs = definitions(&rs);
        for (name, raw) in &c.streams {
            if !section_stream(name) {
                continue;
            }
            let Ok(bytes) = unpack(c, raw) else {
                continue;
            };
            let Some(body) = records(&bytes) else {
                continue;
            };
            if body.iter().any(|r| matches!(r.0, 77 | 85)) {
                generic_references(&body, &defs)?;
            }
            pictures |= body.iter().any(|r| r.0 == 85);
        }
        if pictures {
            resource_paths(c, &defs)?;
        }
        if !entries(&defs, 24).is_empty() {
            for ps in entries(&defs, 25) {
                valid_para_shape(ps, &defs)?;
            }
            for bullet in entries(&defs, 24) {
                reference(dword(bullet, 8)? < entries(&defs, 21).len(), "DocInfo")?;
            }
        }
        Ok(())
    })();
    result.err().into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cell_reference_offsets_require_table_context() {
        let mut caption = vec![0; 40];
        caption[32..34].copy_from_slice(&99u16.to_le_bytes());
        let mut table = vec![0; 22];
        table[4..6].copy_from_slice(&1u16.to_le_bytes());
        table[20..22].copy_from_slice(&1u16.to_le_bytes());
        let mut cell = vec![0; 34];
        cell[32..34].copy_from_slice(&1u16.to_le_bytes());
        let defs = Defs::from([(20, vec![b"preserved definition".as_slice()])]);
        let good = vec![
            (71, 1, b" lbt".as_slice()),
            (72, 2, caption.as_slice()),
            (77, 2, table.as_slice()),
            (72, 2, cell.as_slice()),
        ];
        assert!(generic_references(&good, &defs).is_ok());
        cell[32..34].copy_from_slice(&99u16.to_le_bytes());
        let bad = vec![
            (71, 1, b" lbt".as_slice()),
            (72, 2, caption.as_slice()),
            (77, 2, table.as_slice()),
            (72, 2, cell.as_slice()),
        ];
        assert_eq!(
            generic_references(&bad, &defs).err(),
            Some(Finding::at(FindingCode::ReferenceInvalid, BODY))
        );
    }
}
