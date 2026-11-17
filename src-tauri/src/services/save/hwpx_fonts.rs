//! T009 Stage 1 F: HWPX embedded-font additions (OWPML `hh:font@isEmbedded` + `@binaryItemIDRef` referencing an
//! OPF manifest BinData item; KS X 6101 header schema).
//!
//! The output may differ from the original by font embedding only like this:
//! - `Contents/content.hpf`: the original manifest with only added `opf:item` elements, each
//!   `href="BinData/….ttf"`, `media-type="application/octet-stream"` (the pinned serializer's form),
//!   `isEmbeded="1"`, naming a part that did not exist in the original and exists in the output;
//! - every such part is a single-face TrueType font whose `fsType` permits editable embedding (installable or
//!   editable) and whose family names include the face of every `hh:font` that references it, and every added
//!   item is referenced by at least one `hh:font` (no unreferenced font binary);
//! - `Contents/header.xml`: the fonts referencing an added item have `isEmbedded="1"` and that
//!   `binaryItemIDRef`. With exactly those two attributes turned back into a non-embedded font
//!   (`isEmbedded="0"`, no reference) the header must pass the ordinary header rules against the original
//!   (equal, or the proved font/character/paragraph appends). Original embedded fonts keep their own references.
//!
//! Combined in one save with picture insertion (also a manifest change) it is refused (not composed).

use std::collections::{BTreeMap, BTreeSet};

use crate::document::xml::{self, Canonical};
use crate::fonts::embedding;

use super::package::Package;

pub const CONTENT: &str = "Contents/content.hpf";
const HEADER: &str = "Contents/header.xml";
const OPF: &str = "http://www.idpf.org/2007/opf/";
const HEAD: &str = "http://www.hancom.co.kr/hwpml/2011/head";

pub struct HwpxFontProof {
    /// Added font parts.
    pub parts: BTreeSet<String>,
    /// The output header with the added embeds turned back into non-embedded fonts.
    pub normalized_header: Vec<u8>,
}

fn attr<'a>(e: &'a Canonical, ns: Option<&str>, key: &str) -> Option<&'a str> {
    let Canonical::Start { attributes, .. } = e else { return None };
    attributes.iter().find(|(n, k, _)| n.as_ref().map(|a| a.as_str()) == ns && k.as_str() == key).map(|(_, _, v)| v.as_str())
}

fn is(e: &Canonical, ns: &str, local: &str) -> bool {
    matches!(e, Canonical::Start { namespace: Some(n), name, .. } if n.as_str() == ns && name.as_str() == local)
}

pub fn hwpx_fonts_embedded(original: &Package, output: &Package) -> Option<HwpxFontProof> {
    let (before, after) = (xml::canonical(original.get(CONTENT)?).ok()?, xml::canonical(output.get(CONTENT)?).ok()?);
    let original_ids: BTreeSet<&str> = before.iter().filter(|e| is(e, OPF, "item")).filter_map(|e| attr(e, None, "id")).collect();
    // Remove the added manifest items; the rest must equal the original manifest.
    let mut added: BTreeMap<String, String> = BTreeMap::new(); // id → part
    let mut kept = Vec::with_capacity(after.len());
    let mut iter = after.iter().peekable();
    while let Some(e) = iter.next() {
        if is(e, OPF, "item") {
            let id = attr(e, None, "id")?;
            if !original_ids.contains(id) {
                let href = attr(e, None, "href")?;
                let Canonical::Start { attributes, .. } = e else { return None };
                let ttf = href.strip_prefix("BinData/").is_some_and(|n| !n.is_empty() && !n.contains('/') && n.to_ascii_lowercase().ends_with(".ttf"));
                if attributes.len() != 4
                    || !ttf
                    || attr(e, None, "media-type") != Some("application/octet-stream")
                    || attr(e, None, "isEmbeded") != Some("1")
                    || original.get(href).is_some()
                    || output.get(href).is_none()
                    || added.values().any(|p| p == href)
                    || added.insert(id.to_string(), href.to_string()).is_some()
                    || iter.next()? != &Canonical::End
                {
                    return None;
                }
                continue;
            }
        }
        kept.push(e.clone());
    }
    if added.is_empty() || kept != before {
        return None;
    }
    // Header: every font referencing an added item, with its face; each item's program checked once.
    let header = std::str::from_utf8(output.get(HEADER)?).ok()?;
    let events = xml::canonical(header.as_bytes()).ok()?;
    let mut faces: BTreeMap<String, BTreeSet<String>> = BTreeMap::new(); // id → faces
    let mut references = 0usize;
    for e in events.iter().filter(|e| is(e, HEAD, "font") || is(e, HEAD, "substFont")) {
        let Some(id) = attr(e, None, "binaryItemIDRef").filter(|id| added.contains_key(*id)) else { continue };
        if !is(e, HEAD, "font") || attr(e, None, "isEmbedded") != Some("1") || attr(e, None, "type") != Some("TTF") {
            return None;
        }
        faces.entry(id.to_string()).or_default().insert(attr(e, None, "face")?.to_string());
        references += 1;
    }
    if faces.len() != added.len() {
        return None; // an unreferenced font binary
    }
    for (id, part) in &added {
        let program = embedding::inspect(output.get(part)?).ok()?;
        embedding::embeddable(&program).ok()?;
        if !faces[id].iter().all(|face| program.families.iter().any(|f| f == face)) {
            return None;
        }
    }
    // Turn exactly those references back into non-embedded fonts (serializer attribute form) and re-check.
    let mut normalized = header.to_string();
    let mut replaced = 0usize;
    for id in added.keys() {
        let from = format!(r#" isEmbedded="1" binaryItemIDRef="{id}""#);
        replaced += normalized.matches(&from).count();
        normalized = normalized.replace(&from, r#" isEmbedded="0""#);
    }
    if replaced != references {
        return None;
    }
    let check = xml::canonical(normalized.as_bytes()).ok()?;
    if check.iter().any(|e| attr(e, None, "binaryItemIDRef").is_some_and(|id| added.contains_key(id))) {
        return None;
    }
    Some(HwpxFontProof { parts: added.into_values().collect(), normalized_header: normalized.into_bytes() })
}

/// Negative cases over the actual Release-WASM export `hwpx-stage1-embed-font` (explicit opt-in: GEUL_FORMAT_DIR).
#[cfg(test)]
mod tests {
    use super::super::package::{self, compare_saved_hwpx, validate_hwpx, validate_hwpx_references, Package, Side};
    use super::super::preserve::FindingCode;

    fn load(name: &str, side: Side) -> Package {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_FORMAT_DIR").expect("GEUL_FORMAT_DIR"));
        package::open(&std::fs::read(dir.join("hwpx-stage1-embed-font").join(name)).unwrap(), side).unwrap()
    }

    fn refused(original: &Package, output: &Package) -> bool {
        validate_hwpx(original, output)
            .into_iter()
            .chain(compare_saved_hwpx(original, output))
            .chain(validate_hwpx_references(output))
            .any(|f| f.code != FindingCode::PreviewStale)
    }

    #[test]
    #[ignore = "requires the Stage 1 Release-WASM exports (GEUL_FORMAT_DIR)"]
    fn stage1_hwpx_font_embedding_proof_rejects_invalid_outputs() {
        let original = load("original.hwpx", Side::Original);
        let edited = load("edited.hwpx", Side::Output);
        assert!(super::hwpx_fonts_embedded(&original, &edited).is_some());
        assert!(!refused(&original, &edited));
        let font_parts: Vec<String> = edited.parts.keys().filter(|k| k.starts_with("BinData/") && k.ends_with(".ttf")).cloned().collect();
        assert_eq!(font_parts.len(), 2);
        let with = |part: &str, f: &dyn Fn(Vec<u8>) -> Vec<u8>| {
            let mut p = Package { order: edited.order.clone(), parts: edited.parts.clone() };
            let entry = p.parts.get_mut(part).unwrap();
            let changed = f(entry.1.clone());
            assert_ne!(changed, entry.1, "mutation not applied to {part}");
            entry.1 = changed;
            p
        };
        let text = |from: &'static str, to: &'static str| move |b: Vec<u8>| String::from_utf8(b).unwrap().replacen(from, to, 1).into_bytes();
        let restricted = |b: Vec<u8>| crate::fonts::embedding::tests::with_fs_type(&b, 0x0002);
        let preview = |b: Vec<u8>| crate::fonts::embedding::tests::with_fs_type(&b, 0x0004);
        let first = font_parts[0].clone();
        let id = first.trim_start_matches("BinData/").trim_end_matches(".ttf").to_string();
        let unreferenced = {
            let id = id.clone();
            move |b: Vec<u8>| String::from_utf8(b).unwrap().replace(&format!(r#" isEmbedded="1" binaryItemIDRef="{id}""#), r#" isEmbedded="0""#).into_bytes()
        };
        let cases: Vec<(&str, Package)> = vec![
            ("restricted-license font program", with(&first, &restricted)),
            ("preview & print font program", with(&first, &preview)),
            ("not a font", with(&first, &|_| b"not a font".to_vec())),
            ("unreferenced font binary", with("Contents/header.xml", &unreferenced)),
            ("manifest media type", with("Contents/content.hpf", &text(r#"media-type="application/octet-stream""#, r#"media-type="image/png""#))),
            ("manifest not embedded", with("Contents/content.hpf", &text(r#"isEmbeded="1""#, r#"isEmbeded="0""#))),
            ("face not a family of the font", with("Contents/header.xml", &text(r#"face="Inter" type="TTF" isEmbedded="1""#, r#"face="Arial" type="TTF" isEmbedded="1""#))),
            ("embedded font type", with("Contents/header.xml", &text(r#"type="TTF" isEmbedded="1""#, r#"type="HFT" isEmbedded="1""#))),
            ("unrelated header change", with("Contents/header.xml", &text(r#"<hh:beginNum page="1""#, r#"<hh:beginNum page="2""#))),
        ];
        for (name, output) in &cases {
            assert!(refused(&original, output), "{name}: accepted");
        }
    }
}
