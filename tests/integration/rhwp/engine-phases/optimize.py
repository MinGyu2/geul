#!/usr/bin/env python3
"""Preserve KoPub classification while avoiding per-glyph Unicode lowercase allocations."""
import argparse, hashlib, json
from pathlib import Path
from hash_catalog import load_json


def optimize(root):
    staged = {}; before = {}
    def edit(name, old, new):
        p=root/name; text=staged.get(name,p.read_text())
        if text.count(old)!=1: raise ValueError(f'{name}: expected one exact boundary')
        before.setdefault(name,hashlib.sha256(p.read_bytes()).hexdigest());staged[name]=text.replace(old,new)
    name='src/renderer/layout/text_measurement.rs'
    edit(name, '''fn kopub_char_width(primary_name: &str, c: char, font_size: f64) -> Option<f64> {
    let lower = primary_name.to_lowercase();
    let is_dotum = primary_name.contains("KoPub돋움체") || lower.contains("kopub dotum");
    let is_batang = primary_name.contains("KoPub바탕체") || lower.contains("kopub batang");''', '''/// Same name predicates as before, without lowercasing every ordinary font for every glyph.
/// Among non-ASCII scalars, only Kelvin sign lowercases to any letter in these ASCII needles.
/// Keep full Unicode lowercase for that uncommon input; exhaustive Unicode regression below
/// checks that assumption against the Rust toolchain's actual Unicode tables.
pub(crate) fn kopub_family_flags(name: &str) -> (bool, bool) {
    let unicode_lower = name.contains('\\u{212a}').then(|| name.to_lowercase());
    let latin = unicode_lower.as_deref().unwrap_or(name).as_bytes();
    let contains = |needle: &[u8]| {
        latin.windows(needle.len()).any(|part| part.eq_ignore_ascii_case(needle))
    };
    (
        name.contains("KoPub돋움체") || contains(b"kopub dotum"),
        name.contains("KoPub바탕체") || contains(b"kopub batang"),
    )
}

fn kopub_char_width(primary_name: &str, c: char, font_size: f64) -> Option<f64> {
    let (is_dotum, is_batang) = kopub_family_flags(primary_name);''')
    edit(name, '''    let lower = primary.to_lowercase();
    let units = if primary.contains("KoPub돋움체") || lower.contains("kopub dotum") {
        290.0
    } else if primary.contains("KoPub바탕체") || lower.contains("kopub batang") {''', '''    let (is_dotum, is_batang) = kopub_family_flags(primary);
    let units = if is_dotum {
        290.0
    } else if is_batang {''')
    edit('src/renderer/layout.rs','    hancom_regenerated_space_width, is_cjk_char, is_halfwidth_cjk_quote, kopub_space_advance_em,','    hancom_regenerated_space_width, is_cjk_char, is_halfwidth_cjk_quote, kopub_family_flags, kopub_space_advance_em,')
    edit('src/renderer/composer.rs','''                    face.contains("KoPub돋움체")
                        || face.contains("KoPub바탕체")
                        || face.to_lowercase().contains("kopub dotum")
                        || face.to_lowercase().contains("kopub batang")''','''                    let (dotum, batang) = super::layout::kopub_family_flags(face);
                    dotum || batang''')
    staged[name] += '''

#[cfg(test)]
mod kopub_family_equivalence_tests {
    use super::kopub_family_flags;
    fn legacy(name: &str) -> (bool, bool) {
        let lower = name.to_lowercase();
        (name.contains("KoPub돋움체") || lower.contains("kopub dotum"),
         name.contains("KoPub바탕체") || lower.contains("kopub batang"))
    }
    #[test]
    fn unicode_tables_only_require_kelvin_fallback_for_these_needles() {
        for scalar in 128..=0x10ffff {
            let Some(c) = char::from_u32(scalar) else { continue; };
            if c.to_lowercase().any(|lower| "kopub dotum batang".contains(lower)) {
                // ASCII space never results from a non-ASCII lowercase mapping either.
                assert_eq!(c, '\\u{212a}', "unexpected relevant Unicode mapping: {c:?}");
            }
        }
    }
    #[test]
    fn names_case_variants_boundaries_and_unicode_match_frozen_predicates() {
        let names = ["바탕", "한양중고딕", "맑은 고딕", "Arial", "Bookman", "", "k", "kopub",
            "KoPub돋움체", "KoPub바탕체", "kopub돋움체", "KoPub Dotum", "KOPUB BATANG",
            "prefixKoPub DotumSuffix", "KoPub Dotum KoPub Batang", "KoPub Dotum", "KoPub Batang",
            "İKoPub DotumΣ", "ΣKoPub BatangΣ", "KoPub  Dotum", "KoPub\\u{00a0}Dotum",
            "ＫoPub Dotum", "KoPub\\u{200d} Batang", "KoPub Dotum, KoPub바탕체"];
        for name in names { assert_eq!(kopub_family_flags(name), legacy(name), "{name:?}"); }
        for name in ["kopub dotum", "kopub batang"] {
            let bytes = name.as_bytes();
            for bits in 0u32..(1 << bytes.len()) {
                let variant: String = bytes.iter().enumerate().map(|(i, &b)| {
                    if bits & (1 << i) != 0 { b.to_ascii_uppercase() as char } else { b as char }
                }).collect();
                for prefix in ["", "한글", "Σ", "K", "İ"] {
                    let value = format!("{prefix}{variant} suffix");
                    assert_eq!(kopub_family_flags(&value), legacy(&value), "{value:?}");
                }
            }
        }
    }
}
'''
    for name,text in staged.items(): (root/name).write_text(text)
    return {name:{'before':sha,'after':hashlib.sha256((root/name).read_bytes()).hexdigest()} for name,sha in before.items()}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True);p.add_argument('--baseline-manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    if a.output.exists():p.error('preserve previous evidence')
    expected=load_json(a.baseline_manifest)['sourceHashes']
    actual={str(p.relative_to(a.source)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (a.source/'src').rglob('*.rs')}
    if actual!=expected:p.error('all baseline source files must match')
    a.output.write_text(json.dumps(optimize(a.source),indent=2)+'\n')


if __name__=='__main__':main()
