//! T010 고정 upstream/공통 표 패치 독립 비교용 생산자.
use crate::renderer::pagination::{ColumnContent, PageContent, PaginationResult};
use crate::wasm_api::HwpDocument;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt::Debug;
use std::path::PathBuf;


fn sorted<K: Debug, V: Debug>(it: impl Iterator<Item = (K, V)>) -> BTreeMap<String, String> {
    it.map(|(k, v)| (format!("{k:?}"), format!("{v:?}")))
        .collect()
}

fn canonical_column(cc: &ColumnContent) -> String {
    let ColumnContent {
        paragraph_float_placements,
        inline_flow_plans,
        inline_placements,
        column_index,
        start_height,
        endnote_flow,
        items,
        zone_layout,
        zone_y_offset,
        wrap_around_paras,
        used_height,
        wrap_anchors,
        overlay_continuations,
        overlay_cuts,
    } = cc;
    format!(
        "{:?}|{:?}|{:?}|{column_index}|{start_height:?}|{endnote_flow}|{items:?}|{zone_layout:?}|{zone_y_offset:?}|{wrap_around_paras:?}|{used_height:?}|{:?}|{overlay_continuations:?}|{overlay_cuts:?}",
        sorted(paragraph_float_placements.iter()),
        sorted(inline_flow_plans.iter()),
        sorted(inline_placements.iter()),
        sorted(wrap_anchors.iter()),
    )
}

fn canonical_page(p: &PageContent) -> String {
    let PageContent {
        page_index,
        page_number,
        section_index,
        layout,
        column_contents,
        active_header,
        active_footer,
        page_number_restarted,
        page_number_pos,
        page_hide,
        footnotes,
        active_master_page,
        extra_master_pages,
        ladder_band_tables,
    } = p;
    let columns: Vec<String> = column_contents.iter().map(canonical_column).collect();
    format!(
        "{page_index}|{page_number}|{section_index}|{layout:?}|{columns:?}|{active_header:?}|{active_footer:?}|{page_number_restarted}|{page_number_pos:?}|{page_hide:?}|{footnotes:?}|{active_master_page:?}|{extra_master_pages:?}|{ladder_band_tables:?}"
    )
}

fn canonical_result(r: &PaginationResult) -> String {
    let PaginationResult {
        pages,
        wrap_around_paras,
        hidden_empty_paras,
        pre_emitted_host_paras,
        pre_emitted_host_heights,
        pre_emitted_host_content_heights,
        endnotes,
        endnote_paragraphs,
        endnote_para_sources,
        endnote_between_notes_hu,
        endnote_separator_above_hu,
        endnote_separator_below_hu,
    } = r;
    let pages: Vec<String> = pages.iter().map(canonical_page).collect();
    let mut hidden: Vec<_> = hidden_empty_paras.iter().collect();
    hidden.sort();
    let mut hosts: Vec<_> = pre_emitted_host_paras.iter().collect();
    hosts.sort();
    format!(
        "{pages:?}|{wrap_around_paras:?}|{hidden:?}|{hosts:?}|{:?}|{:?}|{endnotes:?}|{endnote_paragraphs:?}|{endnote_para_sources:?}|{endnote_between_notes_hu}|{endnote_separator_above_hu}|{endnote_separator_below_hu}",
        sorted(pre_emitted_host_heights.iter()),
        sorted(pre_emitted_host_content_heights.iter()),
    )
}

fn canonical(doc: &HwpDocument) -> Vec<String> {
    doc.pagination.iter().map(canonical_result).collect()
}

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


#[test]
#[ignore]
fn geul_independent_table_layout() {
    let identity=serde_json::json!({"manifestRoot":env!("CARGO_MANIFEST_DIR"),
        "layoutSha256":hex(include_bytes!("../renderer/layout/table_layout.rs")),
        "typesetSha256":hex(include_bytes!("../renderer/typeset.rs"))});
    let samples=PathBuf::from(std::env::var("GEUL_TABLE_SAMPLES").unwrap());
    let output=PathBuf::from(std::env::var("GEUL_TABLE_OUTPUT").unwrap());
    let inputs:Vec<String>=serde_json::from_str(&std::fs::read_to_string(std::env::var("GEUL_TABLE_MANIFEST").unwrap()).unwrap()).unwrap();
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(output.join("engine-identity.json"),serde_json::to_vec_pretty(&identity).unwrap()).unwrap();
    for (index,name) in inputs.iter().enumerate() {
        eprintln!("GEUL_TABLE_START index={index} path={name}");
        let bytes=std::fs::read(samples.join(name)).unwrap();
        let mut doc=HwpDocument::from_bytes(&bytes).unwrap();
        let mut states=Vec::new();
        let mut rng=Lcg(name.bytes().fold(1469598103934665603u64,|h,c|(h^c as u64).wrapping_mul(1099511628211)));
        // 모든 단계의 canonical은 실제 바이트로 저장해 독립 프로세스 간 비교한다.
        for step in 0..=12 {
            let edit=if step==0 {"initial".to_owned()} else {
                // 표 내용 편집도 최소 두 번 수행해 pointer-keyed cache 무효화를 거친다.
                let target=doc.document.sections.iter().enumerate().find_map(|(s,section)|section.paragraphs.iter().enumerate().find_map(|(p,para)|para.controls.iter().enumerate().find_map(|(c,control)|match control {
                    crate::model::control::Control::Table(t) if !t.cells.is_empty() && !t.cells[0].paragraphs.is_empty()=>Some((s,p,c)),_=>None,
                })));
                if step<=2 && target.is_some() {
                    let(s,p,c)=target.unwrap();
                    let result=doc.insert_text_in_cell_native(s,p,c,0,0,0,"가");
                    assert!(result.is_ok(),"cell edit rejected: {result:?}");
                    format!("cell-insert:{s}:{p}:{c}")
                } else {
                    let op=pick(&doc,&mut rng).unwrap();apply(&mut doc,&op).unwrap();format!("{op:?}")
                }
            };
            let canonical=canonical(&doc).join("\n");
            std::fs::write(output.join(format!("{index}-{step}.pagination")),canonical.as_bytes()).unwrap();
            let count=doc.page_count();
            let mut svgs=Vec::new();
            if step==0 || step==12 {for page in 0..count {
                let svg=doc.render_page_svg_native(page).unwrap();
                std::fs::write(output.join(format!("{index}-{step}-{page}.svg")),svg.as_bytes()).unwrap();
                svgs.push(hex(svg.as_bytes()));
            }}
            states.push(serde_json::json!({"step":step,"edit":edit,"pages":count,"paginationSha256":hex(canonical.as_bytes()),"svgSha256":svgs}));
        }
        let result=serde_json::json!({"path":name,"sha256":hex(&bytes),"states":states});
        std::fs::write(output.join(format!("{index}.json")),serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        eprintln!("GEUL_TABLE_DONE index={index}");
    }
}

fn hex(bytes:&[u8])->String {Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect()}
