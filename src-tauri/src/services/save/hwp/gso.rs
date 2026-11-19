//! Bounded field-level evolution and deletion proof for existing HWP5 GSO (`b" osg"`) objects.
//!
//! Only top-level Pictures (`b"cip$"`) and basic Shapes (`b"nil$"`, `b"cer$"`,
//! `b"lle$"`, optionally with a plain TextBox) whose identity matches unambiguously
//! may evolve within the exact fields owned by supported editor commands or be deleted
//! when unlocked, uncaptioned, non-grouped, and free of opaque/nested controls.
//! Groups, charts, OLE, captions, unknown extensions, and BinData substitutions fail closed.

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

const TAG_CTRL_HEADER: u16 = 71;
const TAG_LIST_HEADER: u16 = 72;
const TAG_SHAPE_COMPONENT: u16 = 76;
const TAG_LINE: u16 = 78;
const TAG_RECTANGLE: u16 = 79;
const TAG_ELLIPSE: u16 = 80;
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
const ATTR_SIZE_PROTECT: u32 = 1 << 20;
const ATTR_CAPTION: u32 = 1 << 29;
const ATTR_LOCKED: u32 = 1 << 30;

fn gso_header_id(rs: &[Record<'_>]) -> Option<u32> {
    let first = rs.first()?;
    if first.0 != TAG_CTRL_HEADER || !first.2.starts_with(CTRL_GSO) || first.2.len() < 46 {
        return None;
    }
    Some(u32::from_le_bytes(first.2.get(36..40)?.try_into().ok()?))
}

/// An original caption subtree can be carried through an unrelated edit by
/// exact object equality. The evolution matcher below still requires the
/// SHAPE_COMPONENT to follow the CTRL_HEADER immediately.
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

fn shape_ctrl_id<'a>(rs: &'a [Record<'a>]) -> Option<(&'a [u8; 4], usize)> {
    let sc = rs.get(1)?;
    if sc.0 != TAG_SHAPE_COMPONENT || sc.1 != rs[0].1 + 1 || sc.2.len() < 8 {
        return None;
    }
    let two = sc.2[..4] == sc.2[4..8];
    let id_offset = if two { 8 } else { 4 };
    if sc.2.len() < id_offset + 44 {
        return None;
    }
    let ctrl_id: &[u8; 4] = sc.2[..4].try_into().ok()?;
    Some((ctrl_id, id_offset))
}

fn expected_leaf_tag(ctrl_id: &[u8; 4]) -> Option<u16> {
    match ctrl_id {
        SC_PICTURE => Some(TAG_PICTURE),
        SC_LINE => Some(TAG_LINE),
        SC_RECT => Some(TAG_RECTANGLE),
        SC_ELLIPSE => Some(TAG_ELLIPSE),
        _ => None,
    }
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
    let (Some((old_ctrl, old_off)), Some((new_ctrl, new_off))) =
        (shape_ctrl_id(old), shape_ctrl_id(new))
    else {
        return false;
    };
    if old_ctrl != new_ctrl || old_off != new_off || expected_leaf_tag(old_ctrl).is_none() {
        return false;
    }
    if old_id != 0 {
        return new_id == old_id;
    }
    // Newly inserted root pictures start with CTRL_HEADER.instance_id == 0. On subsequent
    // reopen+edit, they keep id == 0 while referencing an *original* BinData (distinct from
    // freshly appended BinData checked by `validate_picture`). Shapes require non-zero ID.
    if old_ctrl != SC_PICTURE || new_id != 0 {
        return false;
    }
    if old[1].2[old_off + 10..old_off + 20] != new[1].2[new_off + 10..new_off + 20] {
        return false;
    }
    let orig_bins = entries(orig_defs, 18).len();
    matches!(
        (picture_bin_id(old), picture_bin_id(new)),
        (Some(a), Some(b)) if a == b && a >= 1 && a <= orig_bins
    )
}

/// Only top-level, unlocked, uncaptioned, non-grouped, opaque-free HWP5 GSO pictures
/// (`b"cip$"`) and basic shapes (`b"nil$"`, `b"cer$"`, `b"lle$"`, optionally with a plain
/// TextBox) may be deleted. Captions, locked objects, groups, charts, OLE, nested/unknown
/// controls, and opaque records (`CTRL_DATA`, range tags) remain strictly preserved.
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
    if (attr & (ATTR_LOCKED | ATTR_CAPTION)) != 0 {
        return false;
    }
    let Some((ctrl_id, id_off)) = shape_ctrl_id(old) else {
        return false;
    };
    let Some(leaf_tag) = expected_leaf_tag(ctrl_id) else {
        return false;
    };
    if word(old[1].2, id_off + 8) != Ok(0) {
        return false;
    }
    if old
        .iter()
        .any(|r| !matches!(r.0, 66..=85) || (r.0 == 70 && !r.2.is_empty()))
    {
        return false;
    }
    if ctrl_id == SC_PICTURE {
        if old.len() != 3 || old[2].0 != TAG_PICTURE || old[2].1 != 3 || old[2].2.len() < 73 {
            return false;
        }
        let orig_bins = entries(orig_defs, 18).len();
        return picture_bin_id(old).is_some_and(|bin_id| bin_id >= 1 && bin_id <= orig_bins);
    }
    let last = old[old.len() - 1];
    if last.0 != leaf_tag || last.1 != 3 {
        return false;
    }
    let mid = &old[2..old.len() - 1];
    if mid.is_empty() {
        return true;
    }
    mid[0].0 == TAG_LIST_HEADER
        && mid[0].1 == 3
        && mid.get(1).is_some_and(|r| r.0 == 66 && r.1 == 4)
        && mid[1..].iter().all(|r| {
            matches!((r.0, r.1), (66, 4) | (67..=70, 5)) && (r.0 != 70 || r.2.is_empty())
        })
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

fn approx_eq_matrix(actual: [f64; 6], expected: [f64; 6], tol: f64) -> bool {
    actual
        .iter()
        .zip(expected.iter())
        .all(|(a, e)| a.is_finite() && e.is_finite() && (a - e).abs() <= tol)
}

fn validate_rendering_info(
    old_r: &[u8],
    new_r: &[u8],
    picture_transform_changed: bool,
    component_offset: [i32; 2],
    rotated_pic: Option<(i16, [usize; 2], [usize; 2])>,
) -> Checked<()> {
    if !picture_transform_changed || old_r == new_r {
        return preserved(old_r == new_r, BODY);
    }
    let [x, y] = component_offset.map(f64::from);
    if let Some((angle, orig_dims, new_cur_dims)) = rotated_pic {
        let Some([om1, om2, om3]) = parse_rendering_matrices(old_r) else {
            return Err(finding(FindingCode::RecordsChanged, BODY));
        };
        let theta = (angle as f64).to_radians();
        let (cos, sin) = (theta.cos(), theta.sin());
        preserved(
            om1[0] == 1.0 && om1[1] == 0.0 && om1[3] == 0.0 && om1[4] == 1.0,
            BODY,
        )?;
        preserved(
            om2[0] > 0.0
                && om2[4] > 0.0
                && om2[1] == 0.0
                && om2[2] == 0.0
                && om2[3] == 0.0
                && om2[5] == 0.0,
            BODY,
        )?;
        preserved(
            (om3[0] - cos).abs() <= 1e-6
                && (om3[1] + sin).abs() <= 1e-6
                && (om3[3] - sin).abs() <= 1e-6
                && (om3[4] - cos).abs() <= 1e-6,
            BODY,
        )?;

        valid(
            orig_dims[0] > 0
                && orig_dims[1] > 0
                && new_cur_dims[0] > 0
                && new_cur_dims[1] > 0,
            BODY,
        )?;
        let Some([nm1, nm2, nm3]) = parse_rendering_matrices(new_r) else {
            return Err(finding(FindingCode::OutputMalformed, BODY));
        };
        let expected_m1 = [1.0, 0.0, x, 0.0, 1.0, y];
        let expected_m2 = [
            new_cur_dims[0] as f64 / orig_dims[0] as f64,
            0.0,
            0.0,
            0.0,
            new_cur_dims[1] as f64 / orig_dims[1] as f64,
            0.0,
        ];
        let w = new_cur_dims[0] as f64;
        let h = new_cur_dims[1] as f64;
        let corners = [
            (0.0, 0.0),
            (w * cos, w * sin),
            (-h * sin, h * cos),
            (w * cos - h * sin, w * sin + h * cos),
        ];
        let tx = -corners.iter().map(|(cx, _)| *cx).fold(f64::INFINITY, f64::min);
        let ty = -corners.iter().map(|(_, cy)| *cy).fold(f64::INFINITY, f64::min);
        let expected_m3 = [cos, -sin, tx - x, sin, cos, ty - y];
        valid(
            approx_eq_matrix(nm1, expected_m1, 1e-12)
                && nm2[1] == 0.0
                && nm2[2] == 0.0
                && nm2[3] == 0.0
                && nm2[5] == 0.0
                && approx_eq_matrix(nm2, expected_m2, 1e-12)
                && approx_eq_matrix(nm3, expected_m3, 1e-10),
            BODY,
        )?;
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
        matches(old_r, identity) || matches(old_r, translation),
        BODY,
    )?;
    preserved(matches(new_r, translation), BODY)
}

fn check_ctrl_header(
    old_h: &[u8],
    new_h: &[u8],
    is_picture: bool,
) -> Checked<(usize, usize, usize, usize, bool)> {
    valid(old_h.len() >= 46 && new_h.len() >= 46, BODY)?;
    preserved(old_h[..4] == *CTRL_GSO && new_h[..4] == *CTRL_GSO, BODY)?;
    preserved(old_h[36..40] == new_h[36..40], BODY)?; // instance_id
    preserved(old_h[24..36] == new_h[24..36], BODY)?; // z_order + margins
    preserved(old_h[40..44] == new_h[40..44], BODY)?; // prevent_page_break

    let old_attr = dword(old_h, 4)? as u32;
    let new_attr = dword(new_h, 4)? as u32;
    preserved((old_attr & ATTR_LOCKED) == 0, BODY)?;
    preserved(((old_attr | new_attr) & ATTR_CAPTION) == 0, BODY)?;
    preserved(
        (old_attr & !MUTABLE_ATTR_MASK) == (new_attr & !MUTABLE_ATTR_MASK),
        BODY,
    )?;
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

    let old_n = word(old_h, 44)?;
    let new_n = word(new_h, 44)?;
    let old_end = 46usize
        .checked_add(2 * old_n)
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    let new_end = 46usize
        .checked_add(2 * new_n)
        .ok_or_else(|| finding(FindingCode::OutputMalformed, BODY))?;
    valid(old_h.len() >= old_end && new_h.len() >= new_end, BODY)?;
    let desc_changed = old_h[44..old_end] != new_h[44..new_end];
    if desc_changed {
        preserved(is_picture && new_n <= MAX_DESC_UNITS, BODY)?;
        let units: Vec<u16> = new_h[46..new_end]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        valid(String::from_utf16(&units).is_ok(), BODY)?;
    }
    // Preserve any trailing raw_extra bytes verbatim.
    preserved(old_h[old_end..] == new_h[new_end..], BODY)?;
    Ok((
        old_w,
        old_h_dim,
        new_w,
        new_h_dim,
        new_w != old_w || new_h_dim != old_h_dim,
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
) -> Checked<()> {
    preserved(evolved_candidate(old, new, orig_defs), BODY)?;
    let (ctrl_id, id_off) = shape_ctrl_id(old).unwrap();
    let is_picture = ctrl_id == SC_PICTURE;
    let leaf_tag = expected_leaf_tag(ctrl_id).unwrap();

    // A caption LIST_HEADER precedes SHAPE_COMPONENT in HWP5. The candidate
    // requires SHAPE_COMPONENT immediately after CTRL_HEADER, even if bit 29 is absent.
    let (old_w, old_h_dim, new_w, new_h_dim, size_changed) =
        check_ctrl_header(old[0].2, new[0].2, is_picture)?;

    let old_sc = old[1].2;
    let new_sc = new[1].2;
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
    if is_picture {
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
    preserved(new_rc == old_rc, BODY)?;

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
    validate_rendering_info(
        &old_sc[r_at..old_r_end],
        &new_sc[r_at..new_r_end],
        picture_transform_changed,
        component_offset,
        rotated_picture.then_some((new_rot, [orig_w, orig_h], [new_cw, new_ch])),
    )?;

    if is_picture {
        valid(old_sc.len() == old_r_end && new_sc.len() == new_r_end, BODY)?;
        valid(old.len() == 3 && new.len() == 3, BODY)?;
        let (old_pic, new_pic) = (old[2], new[2]);
        valid(
            old_pic.0 == TAG_PICTURE
                && old_pic.1 == 3
                && new_pic.0 == TAG_PICTURE
                && new_pic.1 == 3,
            BODY,
        )?;
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
    preserved(old_border[4..13] == new_border[4..13], BODY)?;
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
    let (old_last, new_last) = (old[old.len() - 1], new[new.len() - 1]);
    valid(
        old_last.0 == leaf_tag && old_last.1 == 3 && new_last.0 == leaf_tag && new_last.1 == 3,
        BODY,
    )?;
    let old_mid = &old[2..old.len() - 1];
    let new_mid = &new[2..new.len() - 1];
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
    } else {
        preserved(old_last.2 == new_last.2, BODY)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::preview::PreviewRaster;
    use super::super::{Finding, FindingCode, Mode, compare_with, refresh_previews};
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
        pick: fn(u16, u16, &[u8]) -> bool,
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
        if dir.join("rotated-pic-orig.hwp").is_file() {
            let rot_orig = read("rotated-pic-orig");
            let rot_edit = read("rotated-pic-edited");
            assert_eq!(check_with_preview_refresh(&rot_orig, &rot_edit), vec![]);
            let rot_pic =
                |tag, level, data: &[u8]| tag == 76 && level == 2 && data.starts_with(b"cip$cip$");
            let rot_bad = mutate_body_record(&rot_edit, rot_pic, |payload| {
                let mut changed = payload.to_vec();
                changed[100..108].copy_from_slice(&2.5f64.to_le_bytes());
                changed
            });
            assert!(!check_with_preview_refresh(&rot_orig, &rot_bad).is_empty());
        }

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
            assert!(
                !check_with_preview_refresh(&caption, &read(name)).is_empty(),
                "{name}"
            );
        }
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
}
