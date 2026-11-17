//! Document font embedding (Stage 1 F): which installed or registered face may be embedded into a document, and
//! the format-neutral pieces of doing it.
//!
//! Embedding is not installation or selection: it copies a font program into the document package so another
//! reader can render the text without having the font. That is governed by the font's license. The machine-
//! readable part of it is the OpenType `OS/2.fsType` field, read here exactly as the OpenType specification
//! defines it:
//!
//! - bits 0–3 (usage permissions; at most one may be set): `0x0000` installable, `0x0002` restricted license,
//!   `0x0004` preview & print, `0x0008` editable;
//! - bit 8 `0x0100` no subsetting (geul never subsets: the whole font is embedded, so this is honoured);
//! - bit 9 `0x0200` bitmap embedding only (geul embeds outlines, so this refuses);
//! - every other bit is reserved and must be zero.
//!
//! geul is an editor: a document carrying a preview & print font may only be opened read-only, which geul cannot
//! enforce on other readers or on itself, so only **installable** and **editable** fonts are embedded. A malformed
//! field (several usage bits, reserved bits) refuses. `fsType` does not override the font's actual license
//! terms: the license text (`name` IDs 13/14) is shown to the user before embedding and the user decides; geul
//! never edits permission metadata.
//!
//! Output representation: every target format (OOXML embedded TrueType fonts, OWPML `hh:font type="TTF"`) takes a
//! single-face **TrueType-outline** sfnt (`glyf`/`loca`). Registered WOFF/WOFF2 fonts are already stored decoded
//! (WordCraft `decode_font_file`, standards-compliant WOFF/WOFF2 decoding, the user's file is never modified), so
//! their decoded sfnt is used. CFF/CFF2 outlines (`OTTO`), collections and variable fonts refuse with a reason.

use serde::Serialize;
use sha2::{Digest, Sha256};
use wordcraft_fonts::FontDb;

use super::commands::FontError;

/// Largest font program embedded (the RHWP renderer's per-font limit; also bounds DOCX parts).
pub const MAX_EMBED_BYTES: usize = 32 * 1024 * 1024;

/// The license usage permission of a font (`OS/2.fsType` bits 0–3, plus bit 9).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Installable,
    Editable,
    PreviewPrint,
    Restricted,
    BitmapOnly,
    Malformed,
}

/// Why a face cannot be embedded (stable codes for the UI).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    /// Restricted license, preview & print only, bitmap only, or malformed permissions.
    Permission,
    /// CFF/CFF2 outlines: the target formats embed TrueType outlines.
    CffOutlines,
    /// A font collection face (TTC/OTC).
    Collection,
    /// A variable font (the embedded program would not select the chosen instance).
    Variable,
    /// Not a parseable single-face sfnt, or missing required tables.
    Damaged,
    TooLarge,
    /// The face is not available as an exact family/style match.
    Unavailable,
    /// The document format has no font-embedding representation (HWP 5.0).
    FormatUnsupported,
    /// The style has no slot in the format (DOCX: regular, bold, italic, bold italic).
    Style,
}

/// What was read from a font program.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontProgram {
    pub permission: Permission,
    pub fs_type: u16,
    pub no_subsetting: bool,
    pub truetype: bool,
    /// nameID 1 and 16 family names (Windows/Unicode and Macintosh Roman records), first occurrence order.
    pub families: Vec<String>,
    /// nameID 13 license description and 14 license URL (truncated to 2000 characters).
    pub license: Option<String>,
    pub license_url: Option<String>,
}

fn be16(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(o)?, *b.get(o + 1)?]))
}
fn be32(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes([*b.get(o)?, *b.get(o + 1)?, *b.get(o + 2)?, *b.get(o + 3)?]))
}

/// Decode the `fsType` usage field (OpenType `OS/2` table).
pub fn permission(fs_type: u16) -> Permission {
    let usage = fs_type & 0x000E;
    if fs_type & 0xFCF1 != 0 || usage.count_ones() > 1 {
        Permission::Malformed
    } else if usage == 0x0002 {
        Permission::Restricted
    } else if usage == 0x0004 {
        Permission::PreviewPrint
    } else if fs_type & 0x0200 != 0 {
        Permission::BitmapOnly
    } else if usage == 0x0008 {
        Permission::Editable
    } else {
        Permission::Installable
    }
}

/// Read a single-face sfnt. `Err` = not embeddable for a structural reason.
pub fn inspect(bytes: &[u8]) -> Result<FontProgram, Refusal> {
    if bytes.len() > MAX_EMBED_BYTES {
        return Err(Refusal::TooLarge);
    }
    let version = be32(bytes, 0).ok_or(Refusal::Damaged)?;
    match &version.to_be_bytes() {
        b"ttcf" => return Err(Refusal::Collection),
        b"OTTO" => return Err(Refusal::CffOutlines),
        b"true" | [0, 1, 0, 0] => {}
        _ => return Err(Refusal::Damaged),
    }
    let count = usize::from(be16(bytes, 4).ok_or(Refusal::Damaged)?);
    if count == 0 || count > 512 {
        return Err(Refusal::Damaged);
    }
    let mut tables = std::collections::HashMap::new();
    for i in 0..count {
        let rec = 12 + i * 16;
        let tag: [u8; 4] = bytes.get(rec..rec + 4).ok_or(Refusal::Damaged)?.try_into().map_err(|_| Refusal::Damaged)?;
        let offset = be32(bytes, rec + 8).ok_or(Refusal::Damaged)? as usize;
        let length = be32(bytes, rec + 12).ok_or(Refusal::Damaged)? as usize;
        if offset.checked_add(length).is_none_or(|end| end > bytes.len()) {
            return Err(Refusal::Damaged);
        }
        tables.insert(tag, (offset, length));
    }
    if tables.contains_key(b"fvar") {
        return Err(Refusal::Variable);
    }
    if tables.contains_key(b"CFF ") || tables.contains_key(b"CFF2") {
        return Err(Refusal::CffOutlines);
    }
    for tag in [b"glyf", b"loca", b"head", b"maxp", b"cmap", b"name", b"OS/2"] {
        if !tables.contains_key(tag) {
            return Err(Refusal::Damaged);
        }
    }
    let (os2, os2_len) = tables[b"OS/2"];
    if os2_len < 10 {
        return Err(Refusal::Damaged);
    }
    let fs_type = be16(bytes, os2 + 8).ok_or(Refusal::Damaged)?;
    let (name, name_len) = tables[b"name"];
    let end = name + name_len;
    let records = usize::from(be16(bytes, name + 2).ok_or(Refusal::Damaged)?);
    let storage = name + usize::from(be16(bytes, name + 4).ok_or(Refusal::Damaged)?);
    let (mut families, mut license, mut license_url) = (Vec::new(), None, None);
    for i in 0..records.min(4096) {
        let r = name + 6 + i * 12;
        if r + 12 > end {
            break;
        }
        let (platform, name_id) = (be16(bytes, r).unwrap_or(0), be16(bytes, r + 6).unwrap_or(0));
        if ![1, 13, 14, 16].contains(&name_id) {
            continue;
        }
        let (len, off) = (usize::from(be16(bytes, r + 8).unwrap_or(0)), usize::from(be16(bytes, r + 10).unwrap_or(0)));
        let Some(raw) = bytes.get(storage + off..storage + off + len).filter(|_| storage + off + len <= end) else {
            continue;
        };
        let text: String = match platform {
            0 | 3 => {
                let units: Vec<u16> = raw.as_chunks::<2>().0.iter().map(|c| u16::from_be_bytes(*c)).collect();
                String::from_utf16_lossy(&units)
            }
            1 => raw.iter().map(|&b| char::from(b)).collect(),
            _ => continue,
        };
        let text: String = text.chars().take(2000).collect();
        if text.is_empty() {
            continue;
        }
        match name_id {
            13 => {
                license.get_or_insert(text);
            }
            14 => {
                license_url.get_or_insert(text);
            }
            _ if !families.contains(&text) => families.push(text),
            _ => {}
        }
    }
    if families.is_empty() {
        return Err(Refusal::Damaged);
    }
    Ok(FontProgram {
        permission: permission(fs_type),
        fs_type,
        no_subsetting: fs_type & 0x0100 != 0,
        truetype: true,
        families,
        license,
        license_url,
    })
}

/// May this program be embedded for editing (installable or editable, TrueType outlines)?
pub fn embeddable(program: &FontProgram) -> Result<(), Refusal> {
    match program.permission {
        Permission::Installable | Permission::Editable if program.truetype => Ok(()),
        Permission::Installable | Permission::Editable => Err(Refusal::CffOutlines),
        _ => Err(Refusal::Permission),
    }
}

/// A face chosen for embedding: its exact family/style from the shared font database and its program bytes.
pub struct Candidate {
    pub family: String,
    pub style: String,
    pub bytes: Vec<u8>,
    pub program: FontProgram,
}

/// The exact face (`family`, `style`) of the shared font database (system, bundled or user), inspected.
/// Only an exact match is used (never a fallback face); collections and variable faces refuse.
pub fn candidate(family: &str, style: &str) -> Result<Candidate, Refusal> {
    let face = FontDb::global().face(family, style);
    if !face.family.eq_ignore_ascii_case(family) || !face.style.eq_ignore_ascii_case(style) {
        return Err(Refusal::Unavailable);
    }
    if face.is_variable() {
        return Err(Refusal::Variable);
    }
    if face.index() != 0 {
        return Err(Refusal::Collection);
    }
    let bytes = face.data().to_vec();
    let program = inspect(&bytes)?;
    if !program.families.iter().any(|f| f.eq_ignore_ascii_case(family)) {
        return Err(Refusal::Unavailable);
    }
    Ok(Candidate { family: face.family.clone(), style: face.style.clone(), bytes, program })
}

/// The face's embedding status for the UI (no bytes).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedInfo {
    pub family: String,
    pub style: String,
    pub program: Option<FontProgram>,
    /// `None` = embeddable (the format may still refuse, see `formats`).
    pub refusal: Option<Refusal>,
    /// Per document format: `None` = supported for this face, else why not.
    pub docx: Option<Refusal>,
    pub hwpx: Option<Refusal>,
    pub hwp: Option<Refusal>,
}

/// DOCX embed slot of a style (ECMA-376 `w:embedRegular|Bold|Italic|BoldItalic`).
pub fn docx_slot(style: &str) -> Option<&'static str> {
    match style.to_ascii_lowercase().replace(['-', '_'], " ").trim() {
        "regular" | "normal" | "book" | "roman" => Some("embedRegular"),
        "bold" => Some("embedBold"),
        "italic" | "oblique" => Some("embedItalic"),
        "bold italic" | "bold oblique" | "bolditalic" => Some("embedBoldItalic"),
        _ => None,
    }
}

pub fn info(family: &str, style: &str) -> EmbedInfo {
    let (program, refusal) = match candidate(family, style) {
        Ok(c) => {
            let refusal = embeddable(&c.program).err();
            (Some(c.program), refusal)
        }
        // Report permission details even when the structure refuses (e.g. CFF outlines).
        Err(e) => (None, Some(e)),
    };
    let docx = refusal.or(docx_slot(style).is_none().then_some(Refusal::Style));
    EmbedInfo {
        family: family.to_string(),
        style: style.to_string(),
        program,
        refusal,
        docx,
        hwpx: refusal,
        hwp: Some(Refusal::FormatUnsupported),
    }
}

/// The program bytes of an embeddable face (HWPX embedding in the RHWP session; the WebView never names a path).
pub fn embeddable_bytes(family: &str, style: &str) -> Result<Vec<u8>, FontError> {
    let c = candidate(family, style).map_err(|_| FontError::UnsupportedFont)?;
    embeddable(&c.program).map_err(|_| FontError::EmbeddingRestricted)?;
    Ok(c.bytes)
}

// ---- OOXML font obfuscation (ECMA-376 Part 1, 17.8.1 "Font Embedding") ----

/// A font key GUID derived from the font program (deterministic: the same font gets the same key, so it is
/// recognised instead of duplicated; uniqueness is what the format needs, obfuscation is not secrecy). Version-4
/// layout bits are set so it is a well-formed GUID. Format: `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`.
pub fn font_key(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut b = [0u8; 16];
    b.copy_from_slice(&digest[..16]);
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{{{}-{}-{}-{}-{}}}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// The 16-byte XOR key of a font key GUID: its 32 hexadecimal digits read from the last byte to the first.
fn xor_key(guid: &str) -> Option<[u8; 16]> {
    let hex: String = guid.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let stripped: String = guid.chars().filter(|c| !matches!(c, '{' | '}' | '-')).collect();
    if hex.len() != 32 || stripped.len() != 32 {
        return None;
    }
    let mut key = [0u8; 16];
    for (i, k) in key.iter_mut().enumerate() {
        let at = 30 - 2 * i;
        *k = u8::from_str_radix(hex.get(at..at + 2)?, 16).ok()?;
    }
    Some(key)
}

/// Obfuscate (or, applied again, deobfuscate) a font program: the first 32 bytes are XORed with the key twice.
pub fn obfuscate(bytes: &[u8], guid: &str) -> Option<Vec<u8>> {
    let key = xor_key(guid)?;
    if bytes.len() < 32 {
        return None;
    }
    let mut out = bytes.to_vec();
    for (i, b) in out.iter_mut().take(32).enumerate() {
        *b ^= key[i % 16];
    }
    Some(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn fixture() -> Vec<u8> {
        std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../external/wordcraft/assets/fonts/Inter-Regular.ttf")).unwrap()
    }

    /// The same font with a different `fsType` (generated in memory for negative tests; never written to disk).
    pub(crate) fn with_fs_type(bytes: &[u8], fs_type: u16) -> Vec<u8> {
        let mut out = bytes.to_vec();
        let count = usize::from(be16(bytes, 4).unwrap());
        for i in 0..count {
            let rec = 12 + i * 16;
            if &bytes[rec..rec + 4] == b"OS/2" {
                let o = be32(bytes, rec + 8).unwrap() as usize;
                out[o + 8..o + 10].copy_from_slice(&fs_type.to_be_bytes());
            }
        }
        out
    }

    #[test]
    fn permissions_follow_the_opentype_fs_type_definition() {
        assert_eq!(permission(0x0000), Permission::Installable);
        assert_eq!(permission(0x0008), Permission::Editable);
        assert_eq!(permission(0x0108), Permission::Editable); // no subsetting: whole font embedded
        assert_eq!(permission(0x0004), Permission::PreviewPrint);
        assert_eq!(permission(0x0002), Permission::Restricted);
        assert_eq!(permission(0x0200), Permission::BitmapOnly);
        assert_eq!(permission(0x0208), Permission::BitmapOnly);
        assert_eq!(permission(0x000C), Permission::Malformed); // two usage bits
        assert_eq!(permission(0x0010), Permission::Malformed); // reserved bit
        assert_eq!(permission(0x0001), Permission::Malformed);
    }

    #[test]
    fn inspects_a_licensed_truetype_font_and_refuses_restricted_variants() {
        let inter = fixture();
        let p = inspect(&inter).unwrap();
        assert_eq!(p.permission, Permission::Installable);
        assert!(p.families.iter().any(|f| f == "Inter"));
        assert!(p.license.as_ref().is_some_and(|l| l.contains("Open Font License")));
        assert_eq!(embeddable(&p), Ok(()));
        for (fs, expected) in [(0x0002, Permission::Restricted), (0x0004, Permission::PreviewPrint), (0x0200, Permission::BitmapOnly), (0x0006, Permission::Malformed)] {
            let p = inspect(&with_fs_type(&inter, fs)).unwrap();
            assert_eq!(p.permission, expected);
            assert_eq!(embeddable(&p), Err(Refusal::Permission));
        }
        assert_eq!(embeddable(&inspect(&with_fs_type(&inter, 0x0008)).unwrap()), Ok(()));
        let mut cff = inter.clone();
        cff[..4].copy_from_slice(b"OTTO");
        assert_eq!(inspect(&cff), Err(Refusal::CffOutlines));
        let mut ttc = inter.clone();
        ttc[..4].copy_from_slice(b"ttcf");
        assert_eq!(inspect(&ttc), Err(Refusal::Collection));
        assert_eq!(inspect(&inter[..100]), Err(Refusal::Damaged));
    }

    #[test]
    fn obfuscation_round_trips_and_uses_the_reversed_guid_bytes() {
        let guid = "{00112233-4455-6677-8899-AABBCCDDEEFF}";
        let data: Vec<u8> = (0..64).collect();
        let o = obfuscate(&data, guid).unwrap();
        // Byte 0 is XORed with the last GUID byte (0xFF), byte 15 with the first (0x00); bytes 16..32 repeat it.
        assert_eq!(o[0], 0xFF);
        assert_eq!(o[15], 15);
        assert_eq!(o[16], 16 ^ 0xFF);
        assert_eq!(&o[32..], &data[32..]);
        assert_eq!(obfuscate(&o, guid).unwrap(), data);
        let key = font_key(&fixture());
        assert_eq!(key.len(), 38);
        assert_eq!(key, font_key(&fixture()));
        assert!(obfuscate(&data, "{bad}").is_none());
    }

    #[test]
    fn docx_slots_cover_the_four_style_slots_only() {
        assert_eq!(docx_slot("Regular"), Some("embedRegular"));
        assert_eq!(docx_slot("Bold Italic"), Some("embedBoldItalic"));
        assert_eq!(docx_slot("SemiBold"), None);
    }
}
