//! T009 Stage 3 (B6/B7): Narrow semantic preservation proof for edited HWPX/HWP OOXML charts.
//!
//! When an HWPX chart is edited via `setChartData`:
//! 1. Both `Chart/chartN.xml` and the paired `BinData/*.ole` fallback container must already exist in
//!    both `original` and `output` (no added or removed chart/OLE parts), and `Contents/content.hpf`
//!    must remain canonically unchanged.
//! 2. An active `<hp:switch>` binding (`<hp:case><hp:chart chartIDRef="..."/></hp:case>` paired with
//!    `<hp:default><hp:ole binaryItemIDRef="..."/></hp:default>`) resolved through
//!    `Contents/content.hpf` must connect each changed `Chart/` XML part and `BinData/*.ole` part
//!    in both packages.
//! 3. Both `Chart/chartN.xml` and the inner CFB stream `/OOXMLChartContents` must preserve all
//!    non-data XML structure (`c:title`, `c:legend`, `c:spPr`, `c:extLst`, `c:externalData`, axes,
//!    and chart layout) canonically, changing only existing `<c:v>` values inside `c:plotArea` ->
//!    `c:ser` -> `{c:tx, c:cat, c:xVal, c:val, c:yVal}`, with finite numbers in numeric slots and
//!    safe strings in label/name slots.
//! 4. The inner OLE CFB container must keep the same root CLSID, identical stream/storage inventory,
//!    and byte-identical content for every stream other than `/OOXMLChartContents`, and the logical
//!    chart values in `Chart/chartN.xml` and `/OOXMLChartContents` must agree.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};

use crate::document::xml::{self, Atom, Canonical};

use super::package::{self, Package};

const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const OPF: [&str; 2] = [
    "http://www.idpf.org/2007/opf/",
    "http://www.idpf.org/2007/opf",
];
const HWPML_P: [&str; 2] = [
    "http://www.hancom.co.kr/hwpml/2011/paragraph",
    "http://www.hancom.co.kr/hwpml/2016/paragraph",
];
const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const MAX_OLE_STREAM_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHART_LABEL_CHARS: usize = 1024;
const MAX_CHART_NUM_BYTES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SlotRole {
    Numeric,
    String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ChartLogicalState {
    slots: Vec<(SlotRole, String)>,
}

fn editable_slot_role(stack: &[(Option<Atom>, Atom)]) -> Option<SlotRole> {
    let last = stack.last()?;
    if last.0.as_deref() != Some(NS_C) || last.1.as_str() != "v" {
        return None;
    }
    let plot_pos = stack
        .iter()
        .position(|(ns, name)| ns.as_deref() == Some(NS_C) && name.as_str() == "plotArea")?;
    let ser_pos = stack[plot_pos + 1..]
        .iter()
        .position(|(ns, name)| ns.as_deref() == Some(NS_C) && name.as_str() == "ser")
        .map(|off| plot_pos + 1 + off)?;
    let field = stack[ser_pos + 1..].iter().find(|(ns, name)| {
        ns.as_deref() == Some(NS_C)
            && matches!(name.as_str(), "tx" | "cat" | "xVal" | "val" | "yVal")
    })?;
    // Reject nested unexpected containers like extLst inside a series field.
    if stack[ser_pos + 1..]
        .iter()
        .any(|(ns, name)| ns.as_deref() == Some(NS_C) && name.as_str() == "extLst")
    {
        return None;
    }
    match field.1.as_str() {
        "tx" | "cat" => Some(SlotRole::String),
        "val" | "yVal" => stack[ser_pos + 1..]
            .iter()
            .any(|(ns, name)| {
                ns.as_deref() == Some(NS_C)
                    && matches!(name.as_str(), "numRef" | "numCache" | "numLit")
            })
            .then_some(SlotRole::Numeric),
        "xVal" => {
            if stack[ser_pos + 1..].iter().any(|(ns, name)| {
                ns.as_deref() == Some(NS_C)
                    && matches!(name.as_str(), "numRef" | "numCache" | "numLit")
            }) {
                Some(SlotRole::Numeric)
            } else {
                Some(SlotRole::String)
            }
        }
        _ => None,
    }
}

fn consume_v_text(events: &[Canonical], idx: &mut usize) -> Option<(Option<String>, usize)> {
    let start_end = *idx;
    if let Some(Canonical::Text(text)) = events.get(*idx) {
        *idx += 1;
        match events.get(*idx) {
            Some(Canonical::End { .. }) => {
                *idx += 1;
                Some((Some(text.as_str().to_owned()), start_end))
            }
            _ => None,
        }
    } else if matches!(events.get(*idx), Some(Canonical::End { .. })) {
        *idx += 1;
        Some((None, start_end))
    } else {
        None
    }
}

fn valid_slot_text(role: SlotRole, text: &str) -> bool {
    match role {
        SlotRole::Numeric => {
            !text.is_empty()
                && text.len() <= MAX_CHART_NUM_BYTES
                && text.parse::<f64>().is_ok_and(f64::is_finite)
        }
        SlotRole::String => {
            !text.is_empty()
                && text.chars().count() <= MAX_CHART_LABEL_CHARS
                && !text.chars().any(char::is_control)
        }
    }
}

/// Proves that `after_xml` is a canonical OOXML chart (`c:chartSpace`) preserving all structure
/// outside existing `<c:v>` series cache/literal text slots of `before_xml`.
pub(super) fn prove_ooxml_chart_xml_edit(
    before_xml: &[u8],
    after_xml: &[u8],
) -> Option<ChartLogicalState> {
    let before = xml::canonical(before_xml).ok()?;
    let after = xml::canonical(after_xml).ok()?;
    let Some(Canonical::Start {
        namespace: Some(root_ns),
        name: root_name,
        ..
    }) = before.first()
    else {
        return None;
    };
    if root_ns.as_str() != NS_C || root_name.as_str() != "chartSpace" {
        return None;
    }

    let mut stack: Vec<(Option<Atom>, Atom)> = Vec::new();
    let mut slots = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < before.len() && j < after.len() {
        let b = &before[i];
        let a = &after[j];
        if b != a {
            return None;
        }
        match b {
            Canonical::Start {
                namespace, name, ..
            } => {
                stack.push((namespace.clone(), name.clone()));
                i += 1;
                j += 1;
                if let Some(role) = editable_slot_role(&stack) {
                    let (b_text, _) = consume_v_text(&before, &mut i)?;
                    let (a_text, _) = consume_v_text(&after, &mut j)?;
                    stack.pop()?;
                    if b_text != a_text {
                        b_text.as_ref()?;
                        let next = a_text.as_deref()?;
                        if !valid_slot_text(role, next) {
                            return None;
                        }
                    }
                    slots.push((role, a_text.unwrap_or_default()));
                }
            }
            Canonical::End { .. } => {
                stack.pop()?;
                i += 1;
                j += 1;
            }
            Canonical::Text(_) => {
                i += 1;
                j += 1;
            }
            Canonical::Comment(_) | Canonical::Instruction(_) => return None,
        }
    }
    (i == before.len() && j == after.len() && stack.is_empty())
        .then_some(ChartLogicalState { slots })
}

fn unwrap_ole_cfb(bytes: &[u8], strip_size_prefix: bool) -> Option<&[u8]> {
    if strip_size_prefix {
        if bytes.len() < 12 {
            return None;
        }
        let len = u32::from_le_bytes(bytes[..4].try_into().ok()?) as usize;
        if len.checked_add(4)? != bytes.len() || bytes[4..12] != CFB_MAGIC {
            return None;
        }
        Some(&bytes[4..])
    } else {
        if bytes.len() < 8 || bytes[..8] != CFB_MAGIC {
            return None;
        }
        Some(bytes)
    }
}

fn collect_cfb_entries<R: std::io::Read + std::io::Seek>(
    cfb: &cfb::CompoundFile<R>,
) -> Vec<(String, bool, u64)> {
    let mut entries: Vec<(String, bool, u64)> = cfb
        .walk()
        .map(|entry| {
            (
                entry.path().to_string_lossy().into_owned(),
                entry.is_stream(),
                entry.len(),
            )
        })
        .collect();
    entries.sort();
    entries
}

fn read_cfb_stream_bounded<R: std::io::Read + std::io::Seek>(
    cfb: &mut cfb::CompoundFile<R>,
    path: &str,
    expected_len: u64,
) -> Option<Vec<u8>> {
    let expected = usize::try_from(expected_len).ok()?;
    if expected > MAX_OLE_STREAM_BYTES {
        return None;
    }
    let stream = cfb.open_stream(path).ok()?;
    let mut out = Vec::new();
    stream
        .take((MAX_OLE_STREAM_BYTES + 1) as u64)
        .read_to_end(&mut out)
        .ok()?;
    (out.len() == expected && out.len() <= MAX_OLE_STREAM_BYTES).then_some(out)
}

/// Proves that a nested OLE CFB container keeps root CLSID, all storage/stream paths, and every
/// stream except `/OOXMLChartContents` byte-identical, while `/OOXMLChartContents` passes the narrow
/// chart XML proof.
pub(super) fn prove_nested_ole_chart_cfb(
    before_ole: &[u8],
    after_ole: &[u8],
    strip_size_prefix: bool,
) -> Option<ChartLogicalState> {
    let before_cfb_bytes = unwrap_ole_cfb(before_ole, strip_size_prefix)?;
    let after_cfb_bytes = unwrap_ole_cfb(after_ole, strip_size_prefix)?;
    let mut before_cfb = cfb::CompoundFile::open(Cursor::new(before_cfb_bytes)).ok()?;
    let mut after_cfb = cfb::CompoundFile::open(Cursor::new(after_cfb_bytes)).ok()?;
    if before_cfb.root_entry().clsid() != after_cfb.root_entry().clsid() {
        return None;
    }
    let before_entries = collect_cfb_entries(&before_cfb);
    let after_entries = collect_cfb_entries(&after_cfb);
    if before_entries.len() != after_entries.len() {
        return None;
    }
    let mut chart_state = None;
    for ((b_path, b_stream, b_len), (a_path, a_stream, a_len)) in
        before_entries.iter().zip(&after_entries)
    {
        if b_path != a_path || b_stream != a_stream {
            return None;
        }
        if !b_stream {
            continue;
        }
        let b_data = read_cfb_stream_bounded(&mut before_cfb, b_path, *b_len)?;
        let a_data = read_cfb_stream_bounded(&mut after_cfb, a_path, *a_len)?;
        if b_path == "/OOXMLChartContents" {
            chart_state = Some(prove_ooxml_chart_xml_edit(&b_data, &a_data)?);
        } else if b_data != a_data {
            return None;
        }
    }
    chart_state
}

fn manifest_hrefs(content_hpf: &[u8]) -> Option<BTreeMap<String, String>> {
    let events = xml::canonical(content_hpf).ok()?;
    let mut out = BTreeMap::new();
    for event in events {
        let Canonical::Start {
            namespace: Some(ns),
            name,
            attributes,
        } = event
        else {
            continue;
        };
        if name.as_str() != "item" || !OPF.contains(&ns.as_str()) {
            continue;
        }
        let id = attributes
            .iter()
            .find(|(ans, k, _)| ans.is_none() && k.as_str() == "id")
            .map(|(_, _, v)| v.as_str().to_owned())?;
        let href = attributes
            .iter()
            .find(|(ans, k, _)| ans.is_none() && k.as_str() == "href")
            .map(|(_, _, v)| v.as_str().to_owned())?;
        out.insert(id, href);
    }
    Some(out)
}

fn switch_chart_ole_bindings(
    pkg: &Package,
    href_by_id: &BTreeMap<String, String>,
) -> Option<Vec<(String, String)>> {
    let mut bindings = Vec::new();
    for (name, (_, bytes)) in &pkg.parts {
        if !package::hwpx_body(name) {
            continue;
        }
        let events = xml::canonical(bytes).ok()?;
        let mut depth = 0usize;
        let mut switch_depth: Option<usize> = None;
        let mut case_depth: Option<usize> = None;
        let mut default_depth: Option<usize> = None;
        let mut cur_chart: Option<String> = None;
        let mut cur_ole: Option<String> = None;
        for event in events {
            match event {
                Canonical::Start {
                    namespace,
                    name,
                    attributes,
                } => {
                    depth += 1;
                    let is_hp = namespace.as_deref().is_some_and(|u| HWPML_P.contains(&u));
                    if is_hp && name.as_str() == "switch" && switch_depth.is_none() {
                        switch_depth = Some(depth);
                        cur_chart = None;
                        cur_ole = None;
                    } else if switch_depth.is_some() {
                        if is_hp && name.as_str() == "case" && case_depth.is_none() {
                            case_depth = Some(depth);
                        } else if is_hp && name.as_str() == "default" && default_depth.is_none() {
                            default_depth = Some(depth);
                        } else if is_hp && name.as_str() == "chart" && case_depth.is_some() {
                            if let Some(chart_ref) = attributes
                                .iter()
                                .find(|(ns, k, _)| ns.is_none() && k.as_str() == "chartIDRef")
                                .map(|(_, _, v)| v.as_str().to_owned())
                            {
                                cur_chart = Some(chart_ref);
                            }
                        } else if is_hp && name.as_str() == "ole" && default_depth.is_some() {
                            if let Some(ole_id) = attributes
                                .iter()
                                .find(|(ns, k, _)| ns.is_none() && k.as_str() == "binaryItemIDRef")
                                .map(|(_, _, v)| v.as_str())
                            {
                                if let Some(ole_href) = href_by_id.get(ole_id) {
                                    cur_ole = Some(ole_href.clone());
                                }
                            }
                        }
                    }
                }
                Canonical::End { .. } => {
                    if switch_depth == Some(depth) {
                        if let (Some(c), Some(o)) = (cur_chart.take(), cur_ole.take()) {
                            bindings.push((c, o));
                        }
                        switch_depth = None;
                    }
                    if case_depth == Some(depth) {
                        case_depth = None;
                    }
                    if default_depth == Some(depth) {
                        default_depth = None;
                    }
                    depth -= 1;
                }
                Canonical::Text(_) | Canonical::Comment(_) | Canonical::Instruction(_) => {}
            }
        }
    }
    bindings.sort();
    bindings.dedup();
    Some(bindings)
}

fn is_chart_or_ole_part(name: &str) -> bool {
    name.starts_with("Chart/")
        || (name.starts_with("BinData/") && name.to_ascii_lowercase().ends_with(".ole"))
}

/// Admits changed `(Chart/chartN.xml, BinData/*.ole)` HWPX chart pairs iff every change is proven
/// to edit only existing OOXML chart series/category/value slots consistently across both
/// representations while preserving bindings and all other CFB streams.
///
/// Returns `Some(empty)` when no chart or OLE part differs; `None` if any chart/OLE change fails proof.
pub(super) fn hwpx_charts_edited(original: &Package, output: &Package) -> Option<BTreeSet<String>> {
    let orig_chart_ole: BTreeSet<&str> = original
        .parts
        .keys()
        .map(String::as_str)
        .filter(|n| is_chart_or_ole_part(n))
        .collect();
    let out_chart_ole: BTreeSet<&str> = output
        .parts
        .keys()
        .map(String::as_str)
        .filter(|n| is_chart_or_ole_part(n))
        .collect();
    if orig_chart_ole != out_chart_ole {
        return None;
    }
    let changed: BTreeSet<String> = orig_chart_ole
        .iter()
        .copied()
        .filter(|name| original.get(name) != output.get(name))
        .map(str::to_owned)
        .collect();
    if changed.is_empty() {
        return Some(BTreeSet::new());
    }

    let orig_hpf = original.get("Contents/content.hpf")?;
    let out_hpf = output.get("Contents/content.hpf")?;
    if xml::canonical_equal(orig_hpf, out_hpf) != Ok(true) {
        return None;
    }
    let orig_hrefs = manifest_hrefs(orig_hpf)?;
    let out_hrefs = manifest_hrefs(out_hpf)?;
    if orig_hrefs != out_hrefs {
        return None;
    }
    let orig_bindings = switch_chart_ole_bindings(original, &orig_hrefs)?;
    let out_bindings = switch_chart_ole_bindings(output, &out_hrefs)?;

    let mut admitted = BTreeSet::new();
    for (chart_href, ole_href) in &orig_bindings {
        if !out_bindings.contains(&(chart_href.clone(), ole_href.clone())) {
            return None;
        }
        if !changed.contains(chart_href) && !changed.contains(ole_href) {
            continue;
        }
        let before_chart = original.get(chart_href)?;
        let after_chart = output.get(chart_href)?;
        let before_ole = original.get(ole_href)?;
        let after_ole = output.get(ole_href)?;
        let zip_state = prove_ooxml_chart_xml_edit(before_chart, after_chart)?;
        let ole_state = prove_nested_ole_chart_cfb(before_ole, after_ole, true)?;
        if zip_state != ole_state {
            return None;
        }
        admitted.insert(chart_href.clone());
        admitted.insert(ole_href.clone());
    }

    if admitted != changed {
        return None;
    }
    Some(admitted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::save::package::{
        compare_saved_hwpx, validate_hwpx, validate_hwpx_references, Side,
    };
    use crate::services::save::preserve::FindingCode;
    use crate::services::save::preview::RHWP_BLANK_PREVIEW_PNG;
    use std::io::Write;

    fn chart_xml(series_name: &str, label0: &str, val0: &str, extra_title: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>{extra_title}</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea>
      <c:barChart>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>{series_name}</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>{label0}</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>{val0}</c:v></c:pt><c:pt idx="1"><c:v>2.5</c:v></c:pt></c:numCache></c:numRef></c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>"#
        )
        .into_bytes()
    }

    fn make_ole_cfb(chart_bytes: &[u8], extra_contents: &[u8], zero_clsid: bool) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut cf = cfb::CompoundFile::create(&mut cursor).unwrap();
            if !zero_clsid {
                cf.set_storage_clsid("/", "12345678-1234-5678-1234-567812345678".parse().unwrap())
                    .unwrap();
            }
            cf.create_stream("/OOXMLChartContents")
                .unwrap()
                .write_all(chart_bytes)
                .unwrap();
            cf.create_stream("/Contents")
                .unwrap()
                .write_all(extra_contents)
                .unwrap();
        }
        let raw = cursor.into_inner();
        let mut out = Vec::with_capacity(4 + raw.len());
        out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        out.extend_from_slice(&raw);
        out
    }

    fn build_hwpx(
        chart_bytes: &[u8],
        ole_bytes: &[u8],
        with_switch: bool,
        blank_preview: bool,
    ) -> Package {
        let header = br#"<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:fontfaces itemCnt="0"/><hh:borderFills itemCnt="0"/><hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000"><hh:fontRef/></hh:charPr></hh:charProperties><hh:tabProperties itemCnt="0"/><hh:numberings itemCnt="0"/><hh:bullets itemCnt="0"/><hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:align/></hh:paraPr></hh:paraProperties><hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/></hh:styles></hh:refList></hh:head>"#.to_vec();
        let body = if with_switch {
            br#"<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/ooxmlchart"><hp:chart id="1" zOrder="0" chartIDRef="Chart/chart1.xml"/></hp:case><hp:default><hp:ole id="1" zOrder="0" binaryItemIDRef="ole1"/></hp:default></hp:switch></hp:run></hp:p></hs:sec>"#.to_vec()
        } else {
            br#"<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>plain</hp:t></hp:run></hp:p></hs:sec>"#.to_vec()
        };
        let hpf = br#"<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="ole1" href="BinData/ole1.ole" media-type="application/ole" isEmbeded="0"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>"#.to_vec();

        let mut order = vec![
            "mimetype".to_owned(),
            "Contents/header.xml".to_owned(),
            "Contents/section0.xml".to_owned(),
            "Contents/content.hpf".to_owned(),
            "Chart/chart1.xml".to_owned(),
            "BinData/ole1.ole".to_owned(),
        ];
        let mut parts = BTreeMap::new();
        parts.insert(
            "mimetype".to_owned(),
            (0u16, b"application/hwp+zip".to_vec()),
        );
        parts.insert("Contents/header.xml".to_owned(), (8, header));
        parts.insert("Contents/section0.xml".to_owned(), (8, body));
        parts.insert("Contents/content.hpf".to_owned(), (8, hpf));
        parts.insert("Chart/chart1.xml".to_owned(), (8, chart_bytes.to_vec()));
        parts.insert("BinData/ole1.ole".to_owned(), (8, ole_bytes.to_vec()));
        if blank_preview {
            order.push("Preview/PrvImage.png".to_owned());
            parts.insert(
                "Preview/PrvImage.png".to_owned(),
                (8, RHWP_BLANK_PREVIEW_PNG.to_vec()),
            );
        }
        Package { order, parts }
    }

    fn all_findings(
        before: &Package,
        after: &Package,
    ) -> Vec<crate::services::save::preserve::Finding> {
        validate_hwpx(before, after)
            .into_iter()
            .chain(compare_saved_hwpx(before, after))
            .chain(validate_hwpx_references(after))
            .collect()
    }

    #[test]
    fn hwpx_chart_proof_admits_only_consistent_bound_data_edits() {
        let c_orig = chart_xml("S1", "Q1", "4.3", "Title");
        let o_orig = make_ole_cfb(&c_orig, b"OLE-CONTENTS-ORIG", false);
        let orig = build_hwpx(&c_orig, &o_orig, true, true);

        let c_edit = chart_xml("S1 edited", "Q1 edited", "12.5", "Title");
        let o_edit = make_ole_cfb(&c_edit, b"OLE-CONTENTS-ORIG", false);
        let edited = build_hwpx(&c_edit, &o_edit, true, true);
        assert_eq!(all_findings(&orig, &edited), vec![]);

        // Negative 1: non-numeric value in c:val
        let c_nan = chart_xml("S1", "Q1", "not-a-num", "Title");
        let bad_num = build_hwpx(
            &c_nan,
            &make_ole_cfb(&c_nan, b"OLE-CONTENTS-ORIG", false),
            true,
            true,
        );
        assert!(!all_findings(&orig, &bad_num).is_empty());

        // Negative 2: uneditable chart title mutated
        let c_title = chart_xml("S1", "Q1", "12.5", "Hacked Title");
        let bad_title = build_hwpx(
            &c_title,
            &make_ole_cfb(&c_title, b"OLE-CONTENTS-ORIG", false),
            true,
            true,
        );
        assert!(!all_findings(&orig, &bad_title).is_empty());

        // Negative 3: mismatch between Chart/chart1.xml and nested /OOXMLChartContents
        let mismatch = build_hwpx(
            &c_edit,
            &make_ole_cfb(
                &chart_xml("S1 edited", "Q1 edited", "99.0", "Title"),
                b"OLE-CONTENTS-ORIG",
                false,
            ),
            true,
            true,
        );
        assert!(!all_findings(&orig, &mismatch).is_empty());

        // Negative 4: extra OLE stream mutated
        let bad_ole_stream = build_hwpx(
            &c_edit,
            &make_ole_cfb(&c_edit, b"TAMPERED", false),
            true,
            true,
        );
        assert!(!all_findings(&orig, &bad_ole_stream).is_empty());

        // Negative 5: root CLSID zeroed in nested CFB
        let bad_clsid = build_hwpx(
            &c_edit,
            &make_ole_cfb(&c_edit, b"OLE-CONTENTS-ORIG", true),
            true,
            true,
        );
        assert!(!all_findings(&orig, &bad_clsid).is_empty());

        // Negative 6: unbound chart/ole (missing <hp:switch>)
        let orig_unbound = build_hwpx(&c_orig, &o_orig, false, true);
        let edit_unbound = build_hwpx(&c_edit, &o_edit, false, true);
        assert!(!all_findings(&orig_unbound, &edit_unbound).is_empty());
    }

    fn with_blank_preview(pkg: &Package) -> Package {
        mutate_pkg_part(pkg, "Preview/PrvImage.png", |_| {
            RHWP_BLANK_PREVIEW_PNG.to_vec()
        })
    }

    fn mutate_pkg_part(pkg: &Package, target: &str, f: impl FnOnce(&[u8]) -> Vec<u8>) -> Package {
        let mut parts = pkg.parts.clone();
        if let Some((_, data)) = parts.get_mut(target) {
            *data = f(data);
        }
        Package {
            order: pkg.order.clone(),
            parts,
        }
    }

    #[test]
    #[ignore = "Release-WASM fixtures: set GEUL_STAGE3_OUT and run stage3-chart-inspection.wasm.test.ts first"]
    fn release_hwpx_chart_bytes_pass_only_for_proven_edits() {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_OUT").unwrap());
        for tag in ["bar", "line", "pie", "7406"] {
            let orig = package::open(
                &std::fs::read(dir.join(format!("hwpx-chart-{tag}-orig.hwpx"))).unwrap(),
                Side::Original,
            )
            .unwrap();
            let edited = package::open(
                &std::fs::read(dir.join(format!("hwpx-chart-{tag}-edited.hwpx"))).unwrap(),
                Side::Output,
            )
            .unwrap();
            let non_preview: Vec<_> = all_findings(&orig, &edited)
                .into_iter()
                .filter(|f| f.code != FindingCode::PreviewStale)
                .collect();
            assert_eq!(
                non_preview,
                vec![],
                "{tag}: unexpected non-preview findings"
            );

            let orig_blank = with_blank_preview(&orig);
            let edit_blank = with_blank_preview(&edited);
            assert_eq!(
                all_findings(&orig_blank, &edit_blank),
                vec![],
                "{tag}: blank-preview T009 failed"
            );

            let tampered_chart = mutate_pkg_part(&edit_blank, "Chart/chart1.xml", |raw| {
                let s = String::from_utf8(raw.to_vec()).unwrap();
                s.replacen("<c:v>12.75</c:v>", "<c:v>notanumber</c:v>", 1)
                    .into_bytes()
            });
            assert!(
                !all_findings(&orig_blank, &tampered_chart).is_empty(),
                "{tag}: NaN tamper admitted"
            );

            let mismatched_chart = mutate_pkg_part(&edit_blank, "Chart/chart1.xml", |raw| {
                let s = String::from_utf8(raw.to_vec()).unwrap();
                s.replacen("<c:v>12.75</c:v>", "<c:v>99.5</c:v>", 1)
                    .into_bytes()
            });
            assert!(
                !all_findings(&orig_blank, &mismatched_chart).is_empty(),
                "{tag}: mismatch vs OLE admitted"
            );

            let tampered_hpf = mutate_pkg_part(&edit_blank, "Contents/content.hpf", |raw| {
                let s = String::from_utf8(raw.to_vec()).unwrap();
                s.replacen(r#"id="ole1""#, r#"id="image1""#, 1).into_bytes()
            });
            assert!(
                !all_findings(&orig_blank, &tampered_hpf).is_empty(),
                "{tag}: content.hpf mutation admitted"
            );
        }
    }
}
