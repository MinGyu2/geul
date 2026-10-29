//! SVG 집계의 서로 다른 RNG seed를 같은 엔진에서 제한 재현한다.
use crate::wasm_api::HwpDocument;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
struct Lcg(u64);
impl Lcg {
    fn next(&mut self, n: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) as usize) % n.max(1)
    }
}

#[derive(Debug, Clone)]
enum Op {
    Insert(usize, usize, usize, &'static str),
    Delete(usize, usize, usize),
    Split(usize, usize, usize),
    Merge(usize, usize),
    Bold(usize, usize, usize, usize),
}

fn pick(doc: &HwpDocument, rng: &mut Lcg) -> Option<Op> {
    let sections = doc.document.sections.len();
    if sections == 0 {
        return None;
    }
    let s = rng.next(sections);
    let paras = doc.document.sections[s].paragraphs.len();
    if paras == 0 {
        return None;
    }
    let p = rng.next(paras);
    let len = doc.get_paragraph_length_native(s, p).ok()?;
    let at = rng.next(len + 1);
    Some(match rng.next(10) {
        0..=2 => Op::Insert(s, p, at, "a"),
        3..=4 => Op::Insert(s, p, at, "가나"),
        5..=6 if len > 0 => Op::Delete(s, p, at.min(len - 1)),
        7 => Op::Split(s, p, at),
        8 if p > 0 => Op::Merge(s, p),
        9 if len > 1 => Op::Bold(s, p, at.min(len - 1), (at.min(len - 1) + 2).min(len)),
        _ => Op::Insert(s, p, at, "x"),
    })
}

fn apply(doc: &mut HwpDocument, op: &Op) -> Result<(), String> {
    let r = match *op {
        Op::Insert(s, p, at, t) => doc.insert_text_native(s, p, at, t),
        Op::Delete(s, p, at) => doc.delete_text_native(s, p, at, 1),
        Op::Split(s, p, at) => doc.split_paragraph_native(s, p, at, None),
        Op::Merge(s, p) => doc.merge_paragraph_native(s, p),
        Op::Bold(s, p, a, b) => doc.apply_char_format_native(s, p, a, b, r#"{"bold":true}"#),
    };
    r.map(|_| ()).map_err(|e| format!("{e:?}"))
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
#[test]
#[ignore]
fn geul_historical_svg_seed_replay() {
    let inputs: Vec<serde_json::Value> = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("GEUL_SVG_REPLAY_MANIFEST").unwrap()).unwrap(),
    )
    .unwrap();
    let samples = PathBuf::from(std::env::var("GEUL_TABLE_SAMPLES").unwrap());
    let mut results = Vec::new();
    for input in inputs {
        let name = input["path"].as_str().unwrap();
        let bytes = std::fs::read(samples.join(name)).unwrap();
        assert_eq!(hex(&bytes), input["sha256"].as_str().unwrap());
        let mut arms = Vec::new();
        for (label, key, expected) in [
            (
                "historical",
                input["historicalInput"].as_str().unwrap(),
                input["historicalSvg"].as_u64().unwrap(),
            ),
            ("strict", name, input["strictSvg"].as_u64().unwrap()),
        ] {
            let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
            let seed = key.bytes().fold(1469598103934665603u64, |h, c| {
                (h ^ c as u64).wrapping_mul(1099511628211)
            });
            let mut rng = Lcg(seed);
            let mut operations = String::new();
            for _ in 0..30 {
                let op = pick(&doc, &mut rng).unwrap();
                operations.push_str(&format!("{op:?}\n"));
                apply(&mut doc, &op).unwrap();
            }
            let pages = doc.page_count();
            let mut successful = 0u32;
            for page in 0..pages {
                doc.render_page_svg_native(page).unwrap();
                successful += 1;
            }
            eprintln!("GEUL_SVG_SEED path={name} arm={label} pages={pages} expected={expected}");
            arms.push(serde_json::json!({"arm":label,"seed":seed.to_string(),"seedInputSha256":hex(key.as_bytes()),"operationScriptSha256":hex(operations.as_bytes()),"edits":30,"pages":pages,"successfulSvg":successful,"expectedSvg":expected,"matchesHistoricalEvidence":u64::from(successful)==expected}));
        }
        results.push(serde_json::json!({"path":name,"sha256":hex(&bytes),"arms":arms}));
    }
    let matches = results.iter().all(|row| {
        row["arms"]
            .as_array()
            .unwrap()
            .iter()
            .all(|arm| arm["matchesHistoricalEvidence"] == true)
    });
    let out = serde_json::json!({"scope":"동일 엔진의 두 seed 정책, 제한 5개 fixture","allExpectedCountsReproduced":matches,"engineIdentity":{"manifestRoot":env!("CARGO_MANIFEST_DIR"),"layoutSha256":hex(include_bytes!("../renderer/layout/table_layout.rs")),"typesetSha256":hex(include_bytes!("../renderer/typeset.rs"))},"fixtures":results});
    std::fs::write(
        std::env::var("GEUL_SVG_REPLAY_OUTPUT").unwrap(),
        serde_json::to_vec_pretty(&out).unwrap(),
    )
    .unwrap();
    assert!(
        matches,
        "관측된 역사/strict SVG 계수와 다른 결과: 출력 원본을 확인한다"
    );
}
