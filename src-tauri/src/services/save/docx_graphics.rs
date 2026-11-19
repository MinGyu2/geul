//! T009 Stage 3: Narrow semantic preservation proof for DOCX chart and SmartArt parts
//! regenerated from WordCraft's editing model (`word/charts/chartN.xml`,
//! `word/diagrams/{data,layout,drawing}N.xml`).
//!
//! Instead of exempting the entire XML part from comparison, each changed part is admitted only
//! when:
//! 1. `word/_rels/document.xml.rels` is unchanged and binds the part with its exact relationship
//!    type, with no separate `.rels` file on the part in either package.
//! 2. `word/document.xml` in both original and output actively references the chart (`<c:chart>`)
//!    or SmartArt (`<dgm:relIds>`) binding for that part.
//! 3. Both original and output parts strictly conform to the canonical WordCraft schema for that
//!    chart or SmartArt model (no unknown attributes, extra nodes, external workbooks/data,
//!    embedded images, nested groups, or unknown extensions).
//! 4. Uneditable model properties (chart `legend` and `dataLabels`; SmartArt `colors`,
//!    `quickStyle`, and `dsp:dataModelExt/@relId`) are preserved unchanged, and SmartArt
//!    `data`, `layout`, and `drawing` parts stay mutually consistent.
//! 5. `word/diagrams/colorsN.xml` and `word/diagrams/quickStyleN.xml` are never admitted as
//!    changed (no supported edit mutates them).

use std::collections::{BTreeMap, BTreeSet};

use crate::document::xml::{self, Atom, Canonical};

use super::package::{self, Package};

const DOCUMENT_XML: &str = "word/document.xml";
const DOCUMENT_RELS: &str = "word/_rels/document.xml.rels";

const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_DGM: &str = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
const NS_DSP: &str = "http://schemas.microsoft.com/office/drawing/2008/diagram";

const CHART_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const DIAGRAM_DATA_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData";
const DIAGRAM_LAYOUT_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout";
const DIAGRAM_QUICK_STYLE_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramQuickStyle";
const DIAGRAM_COLORS_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramColors";
const DIAGRAM_DRAWING_REL: &str =
    "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing";

const DRAWING_EXT_URI: &str = "http://schemas.microsoft.com/office/drawing/2008/diagram";
const QUICK_STYLE_ID: &str = "urn:microsoft.com/office/officeart/2005/8/quickstyle/simple1";
const CAT_AX: &str = "500000001";
const VAL_AX: &str = "500000002";
const MAX_POINTS: usize = 4000;
const MAX_SERIES: usize = 255;
const MAX_CELLS: usize = 100_000;
const MAX_SMART_ART_ITEMS: usize = 100;
const MAX_SMART_ART_LEVEL: u8 = 7;

// ---- XML tree helper (built from canonical XML events) ----

#[derive(Debug)]
struct XmlEl {
    ns: Option<Atom>,
    name: Atom,
    attrs: Vec<(Option<Atom>, Atom, Atom)>,
    children: Vec<XmlEl>,
    text: String,
}

impl XmlEl {
    fn parse(bytes: &[u8]) -> Option<XmlEl> {
        let events = xml::canonical(bytes).ok()?;
        let mut stack: Vec<(XmlEl, bool)> = Vec::new();
        let mut root: Option<XmlEl> = None;
        for event in events {
            match event {
                Canonical::Start {
                    namespace,
                    name,
                    attributes,
                } => {
                    if let Some((parent, saw_non_ws_text)) = stack.last() {
                        if *saw_non_ws_text {
                            return None; // mixed content is not emitted by WordCraft graphic schemas
                        }
                        let _ = parent;
                    }
                    stack.push((
                        XmlEl {
                            ns: namespace,
                            name,
                            attrs: attributes,
                            children: Vec::new(),
                            text: String::new(),
                        },
                        false,
                    ));
                }
                Canonical::Text(t) => {
                    let (top, saw_non_ws_text) = stack.last_mut()?;
                    if !t.bytes().all(|b| b.is_ascii_whitespace()) {
                        if !top.children.is_empty() {
                            return None;
                        }
                        *saw_non_ws_text = true;
                        top.text.push_str(&t);
                    } else if top.children.is_empty() {
                        top.text.push_str(&t);
                    }
                }
                Canonical::End => {
                    let (el, _) = stack.pop()?;
                    if let Some((parent, _)) = stack.last_mut() {
                        parent.children.push(el);
                    } else if root.is_none() {
                        root = Some(el);
                    } else {
                        return None;
                    }
                }
                Canonical::Comment(_) | Canonical::Instruction(_) => return None,
            }
        }
        if !stack.is_empty() {
            return None;
        }
        root
    }

    fn is(&self, ns: &str, local: &str) -> bool {
        self.ns.as_deref() == Some(ns) && self.name.as_str() == local
    }

    fn no_text(&self) -> bool {
        self.text.bytes().all(|b| b.is_ascii_whitespace())
    }

    fn exact_attrs(&self, expected: &[(Option<&str>, &str, &str)]) -> bool {
        if self.attrs.len() != expected.len() {
            return false;
        }
        expected.iter().all(|(ns, k, v)| {
            self.attrs
                .iter()
                .any(|(ans, ak, av)| ans.as_deref() == *ns && ak.as_str() == *k && av.as_str() == *v)
        })
    }

    fn single_unqualified_attr(&self, key: &str) -> Option<&str> {
        if self.attrs.len() != 1 {
            return None;
        }
        let (ns, k, v) = &self.attrs[0];
        (ns.is_none() && k.as_str() == key).then_some(v.as_str())
    }

    fn attr(&self, ns: Option<&str>, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(ans, ak, _)| ans.as_deref() == ns && ak.as_str() == key)
            .map(|(_, _, v)| v.as_str())
    }

    fn leaf(&self, ns: &str, local: &str, expected_attrs: &[(Option<&str>, &str, &str)]) -> bool {
        self.is(ns, local) && self.children.is_empty() && self.no_text() && self.exact_attrs(expected_attrs)
    }

    fn leaf_val(&self, ns: &str, local: &str, val: &str) -> bool {
        self.leaf(ns, local, &[(None, "val", val)])
    }
}

// ---- Chart model & strict schema validation ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChartKind {
    Column,
    ColumnStacked,
    Bar,
    BarStacked,
    Line,
    Area,
    Pie,
    Doughnut,
    Scatter,
}

impl ChartKind {
    fn is_round(self) -> bool {
        matches!(self, ChartKind::Pie | ChartKind::Doughnut)
    }

    fn is_bar(self) -> bool {
        matches!(
            self,
            ChartKind::Column | ChartKind::ColumnStacked | ChartKind::Bar | ChartKind::BarStacked
        )
    }

    fn is_stacked(self) -> bool {
        matches!(self, ChartKind::ColumnStacked | ChartKind::BarStacked)
    }

    fn is_horizontal(self) -> bool {
        matches!(self, ChartKind::Bar | ChartKind::BarStacked)
    }
}

#[derive(Debug, PartialEq)]
struct ChartModel {
    kind: ChartKind,
    title: Option<String>,
    legend: Option<String>,
    data_labels: bool,
    categories: Vec<String>,
    series: Vec<(String, Vec<Option<String>>)>,
}

fn canonical_num_str(s: &str) -> Option<String> {
    let v = s.parse::<f64>().ok()?;
    if !v.is_finite() {
        return None;
    }
    let formatted = if v == 0.0 {
        "0".to_string()
    } else {
        format!("{v}")
    };
    (s == formatted).then_some(formatted)
}

fn parse_str_lit(el: &XmlEl) -> Option<Vec<String>> {
    if !el.is(NS_C, "strLit") || !el.attrs.is_empty() || !el.no_text() || el.children.is_empty() {
        return None;
    }
    let pt_count = el.children[0].single_unqualified_attr("val")?;
    if !el.children[0].is(NS_C, "ptCount")
        || !el.children[0].children.is_empty()
        || !el.children[0].no_text()
    {
        return None;
    }
    let n: usize = pt_count.parse().ok()?;
    if n > MAX_POINTS || pt_count != n.to_string() {
        return None;
    }
    let mut out = vec![String::new(); n];
    let mut prev_idx: Option<usize> = None;
    for pt in &el.children[1..] {
        if !pt.is(NS_C, "pt") || !pt.no_text() || pt.children.len() != 1 {
            return None;
        }
        let idx_str = pt.single_unqualified_attr("idx")?;
        let idx: usize = idx_str.parse().ok()?;
        if idx >= n || idx_str != idx.to_string() || prev_idx.is_some_and(|p| idx <= p) {
            return None;
        }
        prev_idx = Some(idx);
        let v = &pt.children[0];
        if !v.is(NS_C, "v") || !v.attrs.is_empty() || !v.children.is_empty() || v.text.is_empty() {
            return None;
        }
        out[idx] = v.text.clone();
    }
    Some(out)
}

fn parse_num_lit(el: &XmlEl) -> Option<Vec<Option<String>>> {
    if !el.is(NS_C, "numLit") || !el.attrs.is_empty() || !el.no_text() || el.children.len() < 2 {
        return None;
    }
    let fmt = &el.children[0];
    if !fmt.is(NS_C, "formatCode")
        || !fmt.attrs.is_empty()
        || !fmt.children.is_empty()
        || fmt.text != "General"
    {
        return None;
    }
    let pt_count_el = &el.children[1];
    let pt_count = pt_count_el.single_unqualified_attr("val")?;
    if !pt_count_el.is(NS_C, "ptCount")
        || !pt_count_el.children.is_empty()
        || !pt_count_el.no_text()
    {
        return None;
    }
    let n: usize = pt_count.parse().ok()?;
    if n > MAX_POINTS || pt_count != n.to_string() {
        return None;
    }
    let mut out = vec![None; n];
    let mut prev_idx: Option<usize> = None;
    for pt in &el.children[2..] {
        if !pt.is(NS_C, "pt") || !pt.no_text() || pt.children.len() != 1 {
            return None;
        }
        let idx_str = pt.single_unqualified_attr("idx")?;
        let idx: usize = idx_str.parse().ok()?;
        if idx >= n || idx_str != idx.to_string() || prev_idx.is_some_and(|p| idx <= p) {
            return None;
        }
        prev_idx = Some(idx);
        let v = &pt.children[0];
        if !v.is(NS_C, "v") || !v.attrs.is_empty() || !v.children.is_empty() {
            return None;
        }
        out[idx] = Some(canonical_num_str(&v.text)?);
    }
    Some(out)
}

fn check_cat_ax_exact(el: &XmlEl, pos: &str) -> bool {
    if !el.is(NS_C, "catAx") || !el.attrs.is_empty() || !el.no_text() || el.children.len() != 13 {
        return false;
    }
    let c = &el.children;
    c[0].leaf_val(NS_C, "axId", CAT_AX)
        && c[1].is(NS_C, "scaling")
        && c[1].attrs.is_empty()
        && c[1].no_text()
        && c[1].children.len() == 1
        && c[1].children[0].leaf_val(NS_C, "orientation", "minMax")
        && c[2].leaf_val(NS_C, "delete", "0")
        && c[3].leaf_val(NS_C, "axPos", pos)
        && c[4].leaf_val(NS_C, "majorTickMark", "none")
        && c[5].leaf_val(NS_C, "minorTickMark", "none")
        && c[6].leaf_val(NS_C, "tickLblPos", "nextTo")
        && c[7].leaf_val(NS_C, "crossAx", VAL_AX)
        && c[8].leaf_val(NS_C, "crosses", "autoZero")
        && c[9].leaf_val(NS_C, "auto", "1")
        && c[10].leaf_val(NS_C, "lblAlgn", "ctr")
        && c[11].leaf_val(NS_C, "lblOffset", "100")
        && c[12].leaf_val(NS_C, "noMultiLvlLbl", "0")
}

fn check_val_ax_exact(el: &XmlEl, id: &str, cross: &str, pos: &str, grid: bool, between: &str) -> bool {
    let expected_len = if grid { 12 } else { 10 };
    if !el.is(NS_C, "valAx")
        || !el.attrs.is_empty()
        || !el.no_text()
        || el.children.len() != expected_len
    {
        return false;
    }
    let mut idx = 0;
    let c = &el.children;
    if !c[idx].leaf_val(NS_C, "axId", id) {
        return false;
    }
    idx += 1;
    if !(c[idx].is(NS_C, "scaling")
        && c[idx].attrs.is_empty()
        && c[idx].no_text()
        && c[idx].children.len() == 1
        && c[idx].children[0].leaf_val(NS_C, "orientation", "minMax"))
    {
        return false;
    }
    idx += 1;
    if !c[idx].leaf_val(NS_C, "delete", "0") {
        return false;
    }
    idx += 1;
    if !c[idx].leaf_val(NS_C, "axPos", pos) {
        return false;
    }
    idx += 1;
    if grid {
        if !c[idx].leaf(NS_C, "majorGridlines", &[]) {
            return false;
        }
        idx += 1;
    }
    if !c[idx].leaf_val(NS_C, "majorTickMark", "none") {
        return false;
    }
    idx += 1;
    if !c[idx].leaf_val(NS_C, "minorTickMark", "none") {
        return false;
    }
    idx += 1;
    if !c[idx].leaf_val(NS_C, "tickLblPos", "nextTo") {
        return false;
    }
    idx += 1;
    if grid {
        let sp = &c[idx];
        if !(sp.is(NS_C, "spPr")
            && sp.attrs.is_empty()
            && sp.no_text()
            && sp.children.len() == 1
            && sp.children[0].is(NS_A, "ln")
            && sp.children[0].attrs.is_empty()
            && sp.children[0].no_text()
            && sp.children[0].children.len() == 1
            && sp.children[0].children[0].leaf(NS_A, "noFill", &[]))
        {
            return false;
        }
        idx += 1;
    }
    c[idx].leaf_val(NS_C, "crossAx", cross)
        && c[idx + 1].leaf_val(NS_C, "crosses", "autoZero")
        && c[idx + 2].leaf_val(NS_C, "crossBetween", between)
}

fn check_dlbls(el: &XmlEl) -> bool {
    if !el.is(NS_C, "dLbls") || !el.attrs.is_empty() || !el.no_text() || el.children.len() != 6 {
        return false;
    }
    let expected = [
        ("showLegendKey", "0"),
        ("showVal", "1"),
        ("showCatName", "0"),
        ("showSerName", "0"),
        ("showPercent", "0"),
        ("showBubbleSize", "0"),
    ];
    el.children
        .iter()
        .zip(expected)
        .all(|(c, (name, val))| c.leaf_val(NS_C, name, val))
}

fn parse_chart_model(bytes: &[u8]) -> Option<ChartModel> {
    let space = XmlEl::parse(bytes)?;
    if !space.is(NS_C, "chartSpace")
        || !space.attrs.is_empty()
        || !space.no_text()
        || space.children.len() != 3
    {
        return None;
    }
    if !space.children[0].leaf_val(NS_C, "roundedCorners", "0") {
        return None;
    }
    // c:spPr (white chart area without border)
    let sp_pr = &space.children[2];
    if !(sp_pr.is(NS_C, "spPr")
        && sp_pr.attrs.is_empty()
        && sp_pr.no_text()
        && sp_pr.children.len() == 2
        && sp_pr.children[0].is(NS_A, "solidFill")
        && sp_pr.children[0].attrs.is_empty()
        && sp_pr.children[0].no_text()
        && sp_pr.children[0].children.len() == 1
        && sp_pr.children[0].children[0].leaf_val(NS_A, "schemeClr", "bg1")
        && sp_pr.children[1].is(NS_A, "ln")
        && sp_pr.children[1].attrs.is_empty()
        && sp_pr.children[1].no_text()
        && sp_pr.children[1].children.len() == 1
        && sp_pr.children[1].children[0].leaf(NS_A, "noFill", &[]))
    {
        return None;
    }

    let chart = &space.children[1];
    if !chart.is(NS_C, "chart") || !chart.attrs.is_empty() || !chart.no_text() {
        return None;
    }
    let mut ci = 0;
    let title = if chart.children.get(ci).is_some_and(|e| e.is(NS_C, "title")) {
        let t_el = &chart.children[ci];
        ci += 1;
        if !t_el.attrs.is_empty() || !t_el.no_text() || t_el.children.len() != 2 {
            return None;
        }
        let tx = &t_el.children[0];
        if !(tx.is(NS_C, "tx") && tx.attrs.is_empty() && tx.no_text() && tx.children.len() == 1) {
            return None;
        }
        let rich = &tx.children[0];
        if !(rich.is(NS_C, "rich")
            && rich.attrs.is_empty()
            && rich.no_text()
            && rich.children.len() == 3
            && rich.children[0].leaf(NS_A, "bodyPr", &[])
            && rich.children[1].leaf(NS_A, "lstStyle", &[]))
        {
            return None;
        }
        let p = &rich.children[2];
        if !(p.is(NS_A, "p") && p.attrs.is_empty() && p.no_text() && p.children.len() == 1) {
            return None;
        }
        let r = &p.children[0];
        if !(r.is(NS_A, "r") && r.attrs.is_empty() && r.no_text() && r.children.len() == 1) {
            return None;
        }
        let a_t = &r.children[0];
        if !a_t.is(NS_A, "t") || !a_t.attrs.is_empty() || !a_t.children.is_empty() {
            return None;
        }
        if !t_el.children[1].leaf_val(NS_C, "overlay", "0") {
            return None;
        }
        Some(a_t.text.clone())
    } else {
        None
    };

    let auto_title = chart.children.get(ci)?;
    ci += 1;
    let expected_auto = if title.is_some() { "0" } else { "1" };
    if !auto_title.leaf_val(NS_C, "autoTitleDeleted", expected_auto) {
        return None;
    }

    let plot_area = chart.children.get(ci)?;
    ci += 1;
    if !plot_area.is(NS_C, "plotArea")
        || !plot_area.attrs.is_empty()
        || !plot_area.no_text()
        || plot_area.children.len() < 2
    {
        return None;
    }
    if !plot_area.children[0].leaf(NS_C, "layout", &[]) {
        return None;
    }

    let ty = &plot_area.children[1];
    if !ty.attrs.is_empty() || !ty.no_text() || ty.ns.as_deref() != Some(NS_C) {
        return None;
    }

    let mut ti = 0;
    let kind = match ty.name.as_str() {
        "barChart" => {
            let dir = ty.children.get(ti)?;
            ti += 1;
            let horizontal = if dir.leaf_val(NS_C, "barDir", "bar") {
                true
            } else if dir.leaf_val(NS_C, "barDir", "col") {
                false
            } else {
                return None;
            };
            let grp = ty.children.get(ti)?;
            ti += 1;
            let stacked = if grp.leaf_val(NS_C, "grouping", "stacked") {
                true
            } else if grp.leaf_val(NS_C, "grouping", "clustered") {
                false
            } else {
                return None;
            };
            match (horizontal, stacked) {
                (false, false) => ChartKind::Column,
                (false, true) => ChartKind::ColumnStacked,
                (true, false) => ChartKind::Bar,
                (true, true) => ChartKind::BarStacked,
            }
        }
        "lineChart" => {
            if !ty.children.get(ti)?.leaf_val(NS_C, "grouping", "standard") {
                return None;
            }
            ti += 1;
            ChartKind::Line
        }
        "areaChart" => {
            if !ty.children.get(ti)?.leaf_val(NS_C, "grouping", "standard") {
                return None;
            }
            ti += 1;
            ChartKind::Area
        }
        "pieChart" => ChartKind::Pie,
        "doughnutChart" => ChartKind::Doughnut,
        "scatterChart" => {
            if !ty.children.get(ti)?.leaf_val(NS_C, "scatterStyle", "lineMarker") {
                return None;
            }
            ti += 1;
            ChartKind::Scatter
        }
        _ => return None,
    };

    if !ty
        .children
        .get(ti)?
        .leaf_val(NS_C, "varyColors", if kind.is_round() { "1" } else { "0" })
    {
        return None;
    }
    ti += 1;

    // Parse c:ser elements
    let mut series_list = Vec::new();
    let mut shared_categories: Option<Vec<String>> = None;
    while ty.children.get(ti).is_some_and(|e| e.is(NS_C, "ser")) {
        if series_list.len() >= MAX_SERIES {
            return None;
        }
        let ser = &ty.children[ti];
        ti += 1;
        if !ser.attrs.is_empty() || !ser.no_text() {
            return None;
        }
        let idx_str = series_list.len().to_string();
        let mut si = 0;
        if !ser.children.get(si)?.leaf_val(NS_C, "idx", &idx_str) {
            return None;
        }
        si += 1;
        if !ser.children.get(si)?.leaf_val(NS_C, "order", &idx_str) {
            return None;
        }
        si += 1;

        let ser_name = if ser.children.get(si).is_some_and(|e| e.is(NS_C, "tx")) {
            let tx = &ser.children[si];
            si += 1;
            if !tx.attrs.is_empty() || !tx.no_text() || tx.children.len() != 1 {
                return None;
            }
            let v = &tx.children[0];
            if !v.is(NS_C, "v") || !v.attrs.is_empty() || !v.children.is_empty() || v.text.is_empty()
            {
                return None;
            }
            v.text.clone()
        } else {
            String::new()
        };

        if kind == ChartKind::Scatter {
            let sp = ser.children.get(si)?;
            si += 1;
            if !(sp.is(NS_C, "spPr")
                && sp.attrs.is_empty()
                && sp.no_text()
                && sp.children.len() == 1
                && sp.children[0].is(NS_A, "ln")
                && sp.children[0].exact_attrs(&[(None, "w", "19050")])
                && sp.children[0].no_text()
                && sp.children[0].children.len() == 1
                && sp.children[0].children[0].leaf(NS_A, "noFill", &[]))
            {
                return None;
            }
        } else if kind.is_bar() {
            if !ser.children.get(si)?.leaf_val(NS_C, "invertIfNegative", "0") {
                return None;
            }
            si += 1;
        } else if kind == ChartKind::Line {
            let mk = ser.children.get(si)?;
            si += 1;
            if !(mk.is(NS_C, "marker")
                && mk.attrs.is_empty()
                && mk.no_text()
                && mk.children.len() == 1
                && mk.children[0].leaf_val(NS_C, "symbol", "none"))
            {
                return None;
            }
        }

        let cat_tag = if kind == ChartKind::Scatter { "xVal" } else { "cat" };
        let val_tag = if kind == ChartKind::Scatter { "yVal" } else { "val" };
        let cat_el = ser.children.get(si)?;
        si += 1;
        if !cat_el.is(NS_C, cat_tag)
            || !cat_el.attrs.is_empty()
            || !cat_el.no_text()
            || cat_el.children.len() != 1
        {
            return None;
        }
        let cats = if kind == ChartKind::Scatter && cat_el.children[0].is(NS_C, "numLit") {
            let nums = parse_num_lit(&cat_el.children[0])?;
            nums.into_iter()
                .map(|o| o.unwrap_or_default())
                .collect::<Vec<_>>()
        } else {
            let strs = parse_str_lit(&cat_el.children[0])?;
            if kind == ChartKind::Scatter
                && strs
                    .iter()
                    .all(|s| s.is_empty() || canonical_num_str(s).is_some())
            {
                // WordCraft scatter uses numLit when all categories are numeric/empty.
                return None;
            }
            strs
        };
        if let Some(prev) = &shared_categories {
            if prev != &cats {
                return None;
            }
        } else {
            shared_categories = Some(cats);
        }

        let val_el = ser.children.get(si)?;
        si += 1;
        if !val_el.is(NS_C, val_tag)
            || !val_el.attrs.is_empty()
            || !val_el.no_text()
            || val_el.children.len() != 1
        {
            return None;
        }
        let values = parse_num_lit(&val_el.children[0])?;
        if values.len()
            != shared_categories
                .as_ref()
                .map_or(0, |c| c.len())
        {
            return None;
        }

        if matches!(kind, ChartKind::Line | ChartKind::Scatter) {
            if !ser.children.get(si)?.leaf_val(NS_C, "smooth", "0") {
                return None;
            }
            si += 1;
        }
        if si != ser.children.len() {
            return None;
        }
        series_list.push((ser_name, values));
    }

    if series_list.is_empty() {
        return None;
    }
    let categories = shared_categories.unwrap_or_default();
    if series_list.len().saturating_mul(categories.len()) > MAX_CELLS {
        return None;
    }

    let data_labels = if ty.children.get(ti).is_some_and(|e| e.is(NS_C, "dLbls")) {
        if !check_dlbls(&ty.children[ti]) {
            return None;
        }
        ti += 1;
        true
    } else {
        false
    };

    if kind.is_bar() {
        if !ty.children.get(ti)?.leaf_val(NS_C, "gapWidth", "150") {
            return None;
        }
        ti += 1;
        if kind.is_stacked() {
            if !ty.children.get(ti)?.leaf_val(NS_C, "overlap", "100") {
                return None;
            }
            ti += 1;
        }
    } else if kind == ChartKind::Line {
        if !ty.children.get(ti)?.leaf_val(NS_C, "marker", "1") {
            return None;
        }
        ti += 1;
    } else if kind == ChartKind::Pie {
        if !ty.children.get(ti)?.leaf_val(NS_C, "firstSliceAng", "0") {
            return None;
        }
        ti += 1;
    } else if kind == ChartKind::Doughnut {
        if !ty.children.get(ti)?.leaf_val(NS_C, "firstSliceAng", "0") {
            return None;
        }
        ti += 1;
        if !ty.children.get(ti)?.leaf_val(NS_C, "holeSize", "50") {
            return None;
        }
        ti += 1;
    }

    if !kind.is_round() {
        if !ty.children.get(ti)?.leaf_val(NS_C, "axId", CAT_AX) {
            return None;
        }
        ti += 1;
        if !ty.children.get(ti)?.leaf_val(NS_C, "axId", VAL_AX) {
            return None;
        }
        ti += 1;
    }
    if ti != ty.children.len() {
        return None;
    }

    // Check axes in plotArea
    match kind {
        ChartKind::Pie | ChartKind::Doughnut => {
            if plot_area.children.len() != 2 {
                return None;
            }
        }
        ChartKind::Scatter => {
            if plot_area.children.len() != 4
                || !check_val_ax_exact(&plot_area.children[2], CAT_AX, VAL_AX, "b", false, "midCat")
                || !check_val_ax_exact(&plot_area.children[3], VAL_AX, CAT_AX, "l", true, "midCat")
            {
                return None;
            }
        }
        _ => {
            let cat_pos = if kind.is_horizontal() { "l" } else { "b" };
            let val_pos = if kind.is_horizontal() { "b" } else { "l" };
            if plot_area.children.len() != 4
                || !check_cat_ax_exact(&plot_area.children[2], cat_pos)
                || !check_val_ax_exact(&plot_area.children[3], VAL_AX, CAT_AX, val_pos, true, "between")
            {
                return None;
            }
        }
    }

    let legend = if chart.children.get(ci).is_some_and(|e| e.is(NS_C, "legend")) {
        let leg = &chart.children[ci];
        ci += 1;
        if !leg.attrs.is_empty() || !leg.no_text() || leg.children.len() != 2 {
            return None;
        }
        let pos_el = &leg.children[0];
        if !pos_el.is(NS_C, "legendPos") || !pos_el.children.is_empty() || !pos_el.no_text() {
            return None;
        }
        let pos = pos_el.single_unqualified_attr("val")?;
        if !matches!(pos, "r" | "l" | "t" | "b") {
            return None;
        }
        if !leg.children[1].leaf_val(NS_C, "overlay", "0") {
            return None;
        }
        Some(pos.to_string())
    } else {
        None
    };

    if !chart.children.get(ci)?.leaf_val(NS_C, "plotVisOnly", "1") {
        return None;
    }
    ci += 1;
    if !chart.children.get(ci)?.leaf_val(NS_C, "dispBlanksAs", "gap") {
        return None;
    }
    ci += 1;
    if ci != chart.children.len() {
        return None;
    }

    Some(ChartModel {
        kind,
        title,
        legend,
        data_labels,
        categories,
        series: series_list,
    })
}

fn chart_mutation_allowed(before: &[u8], after: &[u8]) -> bool {
    let (Some(a), Some(b)) = (parse_chart_model(before), parse_chart_model(after)) else {
        return false;
    };
    // Supported ObjectEdit chart operations only alter title, chart type, categories, and series.
    a.legend == b.legend && a.data_labels == b.data_labels
}

// ---- SmartArt models & strict schema validation ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SmartArtLayoutKind {
    BasicList,
    Process,
    Cycle,
    Hierarchy,
    Pyramid,
    Radial,
    Matrix,
    Venn,
}

impl SmartArtLayoutKind {
    fn from_type_and_cat(lo_type: &str, lo_cat: &str) -> Option<Self> {
        match (lo_type, lo_cat) {
            ("urn:microsoft.com/office/officeart/2005/8/layout/default", "list") => {
                Some(Self::BasicList)
            }
            ("urn:microsoft.com/office/officeart/2005/8/layout/process1", "process") => {
                Some(Self::Process)
            }
            ("urn:microsoft.com/office/officeart/2005/8/layout/cycle2", "cycle") => Some(Self::Cycle),
            ("urn:microsoft.com/office/officeart/2005/8/layout/hierarchy1", "hierarchy") => {
                Some(Self::Hierarchy)
            }
            ("urn:microsoft.com/office/officeart/2005/8/layout/pyramid1", "pyramid") => {
                Some(Self::Pyramid)
            }
            ("urn:microsoft.com/office/officeart/2005/8/layout/radial1", "cycle") => {
                Some(Self::Radial)
            }
            ("urn:microsoft.com/office/officeart/2005/8/layout/matrix3", "matrix") => {
                Some(Self::Matrix)
            }
            ("urn:microsoft.com/office/officeart/2005/8/layout/venn1", "relationship") => {
                Some(Self::Venn)
            }
            _ => None,
        }
    }

    fn type_id(self) -> &'static str {
        match self {
            Self::BasicList => "urn:microsoft.com/office/officeart/2005/8/layout/default",
            Self::Process => "urn:microsoft.com/office/officeart/2005/8/layout/process1",
            Self::Cycle => "urn:microsoft.com/office/officeart/2005/8/layout/cycle2",
            Self::Hierarchy => "urn:microsoft.com/office/officeart/2005/8/layout/hierarchy1",
            Self::Pyramid => "urn:microsoft.com/office/officeart/2005/8/layout/pyramid1",
            Self::Radial => "urn:microsoft.com/office/officeart/2005/8/layout/radial1",
            Self::Matrix => "urn:microsoft.com/office/officeart/2005/8/layout/matrix3",
            Self::Venn => "urn:microsoft.com/office/officeart/2005/8/layout/venn1",
        }
    }

    fn meta(self) -> (&'static str, &'static str, &'static str, &'static str) {
        match self {
            Self::BasicList => (
                "Basic List",
                "Shows items of equal weight as blocks in rows.",
                "list",
                "rect",
            ),
            Self::Process => (
                "Basic Process",
                "Shows steps in order, left to right, with arrows between them.",
                "process",
                "roundRect",
            ),
            Self::Cycle => (
                "Basic Cycle",
                "Shows steps that repeat, around a circle.",
                "cycle",
                "ellipse",
            ),
            Self::Hierarchy => (
                "Hierarchy",
                "Shows a tree: each item below the item it belongs to.",
                "hierarchy",
                "roundRect",
            ),
            Self::Pyramid => (
                "Basic Pyramid",
                "Shows parts that build on each other, largest at the bottom.",
                "pyramid",
                "trapezoid",
            ),
            Self::Radial => (
                "Basic Radial",
                "Shows items around a central idea: the first item is the centre.",
                "cycle",
                "ellipse",
            ),
            Self::Matrix => (
                "Basic Matrix",
                "Shows parts of a whole as quadrants.",
                "matrix",
                "roundRect",
            ),
            Self::Venn => (
                "Basic Venn",
                "Shows overlapping ideas as overlapping circles.",
                "relationship",
                "ellipse",
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SmartArtColorScheme {
    Accent(u8), // 1..=6
    Colorful,
}

impl SmartArtColorScheme {
    fn from_type_and_cat(cs_type: &str, cs_cat: &str) -> Option<Self> {
        if cs_type == "urn:microsoft.com/office/officeart/2005/8/colors/colorful1"
            && cs_cat == "colorful"
        {
            return Some(Self::Colorful);
        }
        for n in 1..=6u8 {
            if cs_type == format!("urn:microsoft.com/office/officeart/2005/8/colors/accent{n}_2")
                && cs_cat == format!("accent{n}")
            {
                return Some(Self::Accent(n));
            }
        }
        None
    }

    fn allows_accent(self, accent: u8) -> bool {
        match self {
            Self::Colorful => (1..=6).contains(&accent),
            Self::Accent(n) => accent == n,
        }
    }
}

fn smart_art_model_id(n: usize) -> String {
    format!("{{5743A57A-0000-4000-8000-{n:012X}}}")
}

fn check_empty_dgm_t(el: &XmlEl) -> bool {
    if !(el.is(NS_DGM, "t")
        && el.attrs.is_empty()
        && el.no_text()
        && el.children.len() == 3
        && el.children[0].leaf(NS_A, "bodyPr", &[])
        && el.children[1].leaf(NS_A, "lstStyle", &[]))
    {
        return false;
    }
    let p = &el.children[2];
    p.is(NS_A, "p")
        && p.attrs.is_empty()
        && p.no_text()
        && p.children.len() == 1
        && p.children[0].leaf(NS_A, "endParaRPr", &[(None, "lang", "en-US")])
}

#[derive(Debug, PartialEq, Eq)]
struct SmartArtItemData {
    text: String,
    level: u8,
}

#[derive(Debug, PartialEq, Eq)]
struct DiagramDataModel {
    layout: SmartArtLayoutKind,
    colors: SmartArtColorScheme,
    items: Vec<SmartArtItemData>,
    drawing_rel: String,
}

fn item_descendants(items: &[SmartArtItemData], i: usize) -> std::ops::Range<usize> {
    let base = items[i].level;
    let end = (i + 1..items.len())
        .find(|&j| items[j].level <= base)
        .unwrap_or(items.len());
    (i + 1)..end
}

fn item_parents(items: &[SmartArtItemData]) -> Vec<Option<usize>> {
    let mut stack: Vec<(u8, usize)> = Vec::new();
    let mut out = Vec::with_capacity(items.len());
    for (i, it) in items.iter().enumerate() {
        while stack.last().is_some_and(|&(lvl, _)| lvl >= it.level) {
            stack.pop();
        }
        out.push(stack.last().map(|&(_, idx)| idx));
        stack.push((it.level, i));
    }
    out
}

fn parse_diagram_data_model(bytes: &[u8]) -> Option<DiagramDataModel> {
    let root = XmlEl::parse(bytes)?;
    if !root.is(NS_DGM, "dataModel")
        || !root.attrs.is_empty()
        || !root.no_text()
        || root.children.len() != 5
    {
        return None;
    }
    let pt_lst = &root.children[0];
    let cxn_lst = &root.children[1];
    if !root.children[2].leaf(NS_DGM, "bg", &[])
        || !root.children[3].leaf(NS_DGM, "whole", &[])
    {
        return None;
    }
    let ext_lst = &root.children[4];
    if !(ext_lst.is(NS_DGM, "extLst")
        && ext_lst.attrs.is_empty()
        && ext_lst.no_text()
        && ext_lst.children.len() == 1)
    {
        return None;
    }
    let ext = &ext_lst.children[0];
    if !(ext.is(NS_A, "ext")
        && ext.exact_attrs(&[(None, "uri", DRAWING_EXT_URI)])
        && ext.no_text()
        && ext.children.len() == 1)
    {
        return None;
    }
    let dm_ext = &ext.children[0];
    if !(dm_ext.is(NS_DSP, "dataModelExt")
        && dm_ext.attrs.len() == 2
        && dm_ext.no_text()
        && dm_ext.children.is_empty())
    {
        return None;
    }
    let drawing_rel = dm_ext.attr(None, "relId")?.to_string();
    if dm_ext.attr(None, "minVer")
        != Some("http://schemas.openxmlformats.org/drawingml/2006/diagram")
        || drawing_rel.is_empty()
    {
        return None;
    }

    // dgm:ptLst
    if !pt_lst.is(NS_DGM, "ptLst")
        || !pt_lst.attrs.is_empty()
        || !pt_lst.no_text()
        || pt_lst.children.is_empty()
    {
        return None;
    }
    if (pt_lst.children.len() - 1) % 3 != 0 {
        return None;
    }
    let item_count = (pt_lst.children.len() - 1) / 3;
    if item_count == 0 || item_count > MAX_SMART_ART_ITEMS {
        return None;
    }
    let doc_id = smart_art_model_id(0);
    let doc_pt = &pt_lst.children[0];
    if !(doc_pt.is(NS_DGM, "pt")
        && doc_pt.exact_attrs(&[(None, "modelId", &doc_id), (None, "type", "doc")])
        && doc_pt.no_text()
        && doc_pt.children.len() == 3)
    {
        return None;
    }
    let pr = &doc_pt.children[0];
    if !(pr.is(NS_DGM, "prSet") && pr.attrs.len() == 6 && pr.no_text() && pr.children.is_empty()) {
        return None;
    }
    let layout = SmartArtLayoutKind::from_type_and_cat(
        pr.attr(None, "loTypeId")?,
        pr.attr(None, "loCatId")?,
    )?;
    if pr.attr(None, "qsTypeId") != Some(QUICK_STYLE_ID)
        || pr.attr(None, "qsCatId") != Some("simple")
    {
        return None;
    }
    let colors =
        SmartArtColorScheme::from_type_and_cat(pr.attr(None, "csTypeId")?, pr.attr(None, "csCatId")?)?;
    if !doc_pt.children[1].leaf(NS_DGM, "spPr", &[]) || !check_empty_dgm_t(&doc_pt.children[2]) {
        return None;
    }

    let mut texts = Vec::with_capacity(item_count);
    for i in 0..item_count {
        let b = 1 + 4 * i;
        let (node_id, cxn_id, par_id, sib_id) = (
            smart_art_model_id(b),
            smart_art_model_id(b + 1),
            smart_art_model_id(b + 2),
            smart_art_model_id(b + 3),
        );
        let node = &pt_lst.children[1 + 3 * i];
        if !(node.is(NS_DGM, "pt")
            && node.exact_attrs(&[(None, "modelId", &node_id)])
            && node.no_text()
            && node.children.len() == 3
            && node.children[0].leaf(NS_DGM, "prSet", &[])
            && node.children[1].leaf(NS_DGM, "spPr", &[]))
        {
            return None;
        }
        let t = &node.children[2];
        if !(t.is(NS_DGM, "t")
            && t.attrs.is_empty()
            && t.no_text()
            && t.children.len() == 3
            && t.children[0].leaf(NS_A, "bodyPr", &[])
            && t.children[1].leaf(NS_A, "lstStyle", &[]))
        {
            return None;
        }
        let p = &t.children[2];
        if !(p.is(NS_A, "p") && p.attrs.is_empty() && p.no_text() && p.children.len() == 1) {
            return None;
        }
        let r = &p.children[0];
        if !(r.is(NS_A, "r")
            && r.attrs.is_empty()
            && r.no_text()
            && r.children.len() == 2
            && r.children[0].leaf(NS_A, "rPr", &[(None, "lang", "en-US")]))
        {
            return None;
        }
        let a_t = &r.children[1];
        if !a_t.is(NS_A, "t") || !a_t.attrs.is_empty() || !a_t.children.is_empty() {
            return None;
        }
        texts.push(a_t.text.clone());

        for (offset, ty) in [(1, "parTrans"), (2, "sibTrans")] {
            let id = if offset == 1 { &par_id } else { &sib_id };
            let tr = &pt_lst.children[1 + 3 * i + offset];
            if !(tr.is(NS_DGM, "pt")
                && tr.exact_attrs(&[(None, "modelId", id), (None, "type", ty), (None, "cxnId", &cxn_id)])
                && tr.no_text()
                && tr.children.len() == 3
                && tr.children[0].leaf(NS_DGM, "prSet", &[])
                && tr.children[1].leaf(NS_DGM, "spPr", &[])
                && check_empty_dgm_t(&tr.children[2]))
            {
                return None;
            }
        }
    }

    // dgm:cxnLst: verify exact connection list and reconstruct valid outline levels
    if !cxn_lst.is(NS_DGM, "cxnLst")
        || !cxn_lst.attrs.is_empty()
        || !cxn_lst.no_text()
        || cxn_lst.children.len() != item_count
    {
        return None;
    }
    let mut levels: Vec<u8> = Vec::with_capacity(item_count);
    let mut ord_counts = vec![0usize; item_count + 1];
    for (i, cxn) in cxn_lst.children.iter().enumerate() {
        let b = 1 + 4 * i;
        let (node_id, cxn_id, par_id, sib_id) = (
            smart_art_model_id(b),
            smart_art_model_id(b + 1),
            smart_art_model_id(b + 2),
            smart_art_model_id(b + 3),
        );
        if !cxn.is(NS_DGM, "cxn")
            || cxn.attrs.len() != 7
            || !cxn.no_text()
            || !cxn.children.is_empty()
        {
            return None;
        }
        let src_id = cxn.attr(None, "srcId")?;
        let (level, slot) = if src_id == doc_id {
            (0u8, 0usize)
        } else {
            let p_idx = (0..i).find(|&j| smart_art_model_id(1 + 4 * j) == src_id)?;
            let lvl = levels[p_idx].checked_add(1)?;
            if lvl > MAX_SMART_ART_LEVEL {
                return None;
            }
            (lvl, p_idx + 1)
        };
        let ord = ord_counts[slot];
        ord_counts[slot] += 1;
        if !cxn.exact_attrs(&[
            (None, "modelId", &cxn_id),
            (None, "srcId", src_id),
            (None, "destId", &node_id),
            (None, "srcOrd", &ord.to_string()),
            (None, "destOrd", "0"),
            (None, "parTransId", &par_id),
            (None, "sibTransId", &sib_id),
        ]) {
            return None;
        }
        levels.push(level);
    }

    // Verify canonical parent stack consistency (item_parents(items) must reproduce the exact srcId)
    let items: Vec<SmartArtItemData> = texts
        .into_iter()
        .zip(levels)
        .map(|(text, level)| SmartArtItemData { text, level })
        .collect();
    if items.first().is_none_or(|first| first.level != 0)
        || items
            .windows(2)
            .any(|w| w[1].level > w[0].level.saturating_add(1))
    {
        return None;
    }
    let expected_parents = item_parents(&items);
    for (i, (cxn, p)) in cxn_lst.children.iter().zip(&expected_parents).enumerate() {
        let expected_src = p.map_or_else(|| doc_id.clone(), |idx| smart_art_model_id(1 + 4 * idx));
        if cxn.attr(None, "srcId") != Some(expected_src.as_str()) {
            let _ = i;
            return None;
        }
    }

    Some(DiagramDataModel {
        layout,
        colors,
        items,
        drawing_rel,
    })
}

fn check_layout_node_header(
    el: &XmlEl,
    name: &str,
    style: Option<&str>,
    alg: &str,
    params: &[(&str, &str)],
    shape: Option<&str>,
    pres_of: &[(&str, &str)],
    min_children: usize,
) -> Option<usize> {
    if !el.is(NS_DGM, "layoutNode") || !el.no_text() || el.children.len() < min_children {
        return None;
    }
    let ok_attrs = match style {
        Some(s) => el.exact_attrs(&[(None, "name", name), (None, "styleLbl", s)]),
        None => el.exact_attrs(&[(None, "name", name)]),
    };
    if !ok_attrs {
        return None;
    }
    let alg_el = &el.children[0];
    if !alg_el.is(NS_DGM, "alg")
        || !alg_el.exact_attrs(&[(None, "type", alg)])
        || !alg_el.no_text()
        || alg_el.children.len() != params.len()
        || !alg_el
            .children
            .iter()
            .zip(params)
            .all(|(c, (t, v))| c.leaf(NS_DGM, "param", &[(None, "type", t), (None, "val", v)]))
    {
        return None;
    }
    let shape_el = &el.children[1];
    let shape_attrs: Vec<(Option<&str>, &str, &str)> = match shape {
        Some(t) => vec![(None, "type", t), (Some(NS_R), "blip", "")],
        None => vec![(Some(NS_R), "blip", "")],
    };
    if !(shape_el.is(NS_DGM, "shape")
        && shape_el.exact_attrs(&shape_attrs)
        && shape_el.no_text()
        && shape_el.children.len() == 1
        && shape_el.children[0].leaf(NS_DGM, "adjLst", &[]))
    {
        return None;
    }
    let pres_attrs: Vec<(Option<&str>, &str, &str)> =
        pres_of.iter().map(|&(k, v)| (None, k, v)).collect();
    if !el.children[2].leaf(NS_DGM, "presOf", &pres_attrs)
        || !el.children[3].leaf(NS_DGM, "constrLst", &[])
        || !el.children[4].leaf(NS_DGM, "ruleLst", &[])
    {
        return None;
    }
    Some(5)
}

const ITEM_TEXT_PRES: [(&str, &str); 4] = [
    ("axis", "desc;self"),
    ("ptType", "node;node"),
    ("st", "1;1"),
    ("cnt", "0;1"),
];

fn parse_layout_model(bytes: &[u8]) -> Option<SmartArtLayoutKind> {
    let root = XmlEl::parse(bytes)?;
    if !root.is(NS_DGM, "layoutDef")
        || !root.no_text()
        || root.children.len() != 4
    {
        return None;
    }
    let uid = root.single_unqualified_attr("uniqueId")?;
    let all = [
        SmartArtLayoutKind::BasicList,
        SmartArtLayoutKind::Process,
        SmartArtLayoutKind::Cycle,
        SmartArtLayoutKind::Hierarchy,
        SmartArtLayoutKind::Pyramid,
        SmartArtLayoutKind::Radial,
        SmartArtLayoutKind::Matrix,
        SmartArtLayoutKind::Venn,
    ];
    let kind = all.into_iter().find(|k| k.type_id() == uid)?;
    let (label, desc, cat, shape) = kind.meta();
    if !root.children[0].leaf_val(NS_DGM, "title", label)
        || !root.children[1].leaf_val(NS_DGM, "desc", desc)
    {
        return None;
    }
    let cat_lst = &root.children[2];
    if !(cat_lst.is(NS_DGM, "catLst")
        && cat_lst.attrs.is_empty()
        && cat_lst.no_text()
        && cat_lst.children.len() == 1
        && cat_lst.children[0].leaf(NS_DGM, "cat", &[(None, "type", cat), (None, "pri", "1000")]))
    {
        return None;
    }
    let (alg, params): (&str, &[(&str, &str)]) = match kind {
        SmartArtLayoutKind::BasicList | SmartArtLayoutKind::Matrix => (
            "snake",
            &[("grDir", "tL"), ("flowDir", "row"), ("contDir", "sameDir")],
        ),
        SmartArtLayoutKind::Process => ("lin", &[("linDir", "fromL"), ("nodeVertAlign", "mid")]),
        SmartArtLayoutKind::Cycle | SmartArtLayoutKind::Venn => {
            ("cycle", &[("stAng", "0"), ("spanAng", "360")])
        }
        SmartArtLayoutKind::Radial => (
            "cycle",
            &[("stAng", "0"), ("spanAng", "360"), ("ctrShpMap", "fNode")],
        ),
        SmartArtLayoutKind::Hierarchy => ("hierChild", &[("linDir", "fromL"), ("chAlign", "t")]),
        SmartArtLayoutKind::Pyramid => ("pyra", &[("linDir", "fromT")]),
    };
    let diag = &root.children[3];
    let body_at = check_layout_node_header(diag, "diagram", None, alg, params, None, &[], 6)?;
    if diag.children.len() != body_at + 1 {
        return None;
    }
    let fe = &diag.children[body_at];
    match kind {
        SmartArtLayoutKind::Hierarchy => {
            if !(fe.is(NS_DGM, "forEach")
                && fe.exact_attrs(&[
                    (None, "name", "branches"),
                    (None, "axis", "ch"),
                    (None, "ptType", "node"),
                ])
                && fe.no_text()
                && fe.children.len() == 1)
            {
                return None;
            }
            let br = &fe.children[0];
            let br_body = check_layout_node_header(br, "branch", None, "hierRoot", &[], None, &[], 7)?;
            if br.children.len() != br_body + 2 {
                return None;
            }
            let item = &br.children[br_body];
            if check_layout_node_header(
                item,
                "item",
                Some("node1"),
                "tx",
                &[],
                Some(shape),
                &[("axis", "self")],
                5,
            )? != item.children.len()
            {
                return None;
            }
            let below = &br.children[br_body + 1];
            let below_body = check_layout_node_header(
                below,
                "below",
                None,
                "hierChild",
                &[("chAlign", "t")],
                None,
                &[],
                7,
            )?;
            if below.children.len() != below_body + 2 {
                return None;
            }
            let joins = &below.children[below_body];
            if !(joins.is(NS_DGM, "forEach")
                && joins.exact_attrs(&[
                    (None, "name", "joins"),
                    (None, "axis", "ch"),
                    (None, "ptType", "parTrans"),
                ])
                && joins.no_text()
                && joins.children.len() == 1)
            {
                return None;
            }
            let join = &joins.children[0];
            if check_layout_node_header(
                join,
                "join",
                Some("connector"),
                "conn",
                &[
                    ("dim", "1D"),
                    ("connRout", "bend"),
                    ("begPts", "bCtr"),
                    ("endPts", "tCtr"),
                ],
                Some("conn"),
                &[("axis", "self")],
                5,
            )? != join.children.len()
            {
                return None;
            }
            if !below.children[below_body + 1].leaf(
                NS_DGM,
                "forEach",
                &[(None, "name", "deeper"), (None, "ref", "branches")],
            ) {
                return None;
            }
        }
        SmartArtLayoutKind::Radial => {
            if !(fe.is(NS_DGM, "forEach")
                && fe.exact_attrs(&[
                    (None, "name", "middle"),
                    (None, "axis", "ch"),
                    (None, "ptType", "node"),
                    (None, "cnt", "1"),
                ])
                && fe.no_text()
                && fe.children.len() == 1)
            {
                return None;
            }
            let ctr = &fe.children[0];
            let ctr_body = check_layout_node_header(
                ctr,
                "centre",
                Some("node1"),
                "tx",
                &[],
                Some(shape),
                &[("axis", "self")],
                6,
            )?;
            if ctr.children.len() != ctr_body + 1 {
                return None;
            }
            let around = &ctr.children[ctr_body];
            if !(around.is(NS_DGM, "forEach")
                && around.exact_attrs(&[
                    (None, "name", "around"),
                    (None, "axis", "ch"),
                    (None, "ptType", "node"),
                ])
                && around.no_text()
                && around.children.len() == 1)
            {
                return None;
            }
            let spoke = &around.children[0];
            if check_layout_node_header(
                spoke,
                "spoke",
                Some("node1"),
                "tx",
                &[],
                Some(shape),
                &ITEM_TEXT_PRES,
                5,
            )? != spoke.children.len()
            {
                return None;
            }
        }
        _ => {
            let has_arrows =
                matches!(kind, SmartArtLayoutKind::Process | SmartArtLayoutKind::Cycle);
            let expected_fe_children = if has_arrows { 2 } else { 1 };
            if !(fe.is(NS_DGM, "forEach")
                && fe.exact_attrs(&[
                    (None, "name", "items"),
                    (None, "axis", "ch"),
                    (None, "ptType", "node"),
                ])
                && fe.no_text()
                && fe.children.len() == expected_fe_children)
            {
                return None;
            }
            let style = if kind == SmartArtLayoutKind::Venn {
                "venn"
            } else {
                "node1"
            };
            let item = &fe.children[0];
            if check_layout_node_header(
                item,
                "item",
                Some(style),
                "tx",
                &[],
                Some(shape),
                &ITEM_TEXT_PRES,
                5,
            )? != item.children.len()
            {
                return None;
            }
            if has_arrows {
                let arrows = &fe.children[1];
                if !(arrows.is(NS_DGM, "forEach")
                    && arrows.exact_attrs(&[
                        (None, "name", "arrows"),
                        (None, "axis", "followSib"),
                        (None, "ptType", "sibTrans"),
                        (None, "cnt", "1"),
                    ])
                    && arrows.no_text()
                    && arrows.children.len() == 1)
                {
                    return None;
                }
                let arrow = &arrows.children[0];
                if check_layout_node_header(
                    arrow,
                    "arrow",
                    Some("connector"),
                    "conn",
                    &[("dim", "2D")],
                    Some("rightArrow"),
                    &[("axis", "self")],
                    5,
                )? != arrow.children.len()
                {
                    return None;
                }
            }
        }
    }
    Some(kind)
}

#[derive(Debug)]
struct DrawingShape {
    prst: String,
    has_adj: bool,
    accents: Vec<u8>,
    paras: Vec<(String, bool)>,
}

fn check_emu_int(s: &str, min: i64, max: i64) -> bool {
    s.parse::<i64>()
        .ok()
        .is_some_and(|v| (min..=max).contains(&v) && s == v.to_string())
}

fn check_off_ext(el: &XmlEl, expected_name: &str, min_xy: i64) -> bool {
    if !el.is(NS_DSP, expected_name) && !el.is(NS_A, expected_name) {
        return false;
    }
    if !el.no_text() || el.children.len() != 2 {
        return false;
    }
    let off = &el.children[0];
    let ext = &el.children[1];
    off.is(NS_A, "off")
        && off.attrs.len() == 2
        && off.children.is_empty()
        && off.no_text()
        && off.attr(None, "x").is_some_and(|v| check_emu_int(v, min_xy, 1_000_000_000))
        && off.attr(None, "y").is_some_and(|v| check_emu_int(v, min_xy, 1_000_000_000))
        && ext.is(NS_A, "ext")
        && ext.attrs.len() == 2
        && ext.children.is_empty()
        && ext.no_text()
        && ext.attr(None, "cx").is_some_and(|v| check_emu_int(v, 0, 1_000_000_000))
        && ext.attr(None, "cy").is_some_and(|v| check_emu_int(v, 0, 1_000_000_000))
}

fn parse_scheme_clr(el: &XmlEl, accents: &mut Vec<u8>, allow_tint_alpha: bool) -> Option<String> {
    if !el.is(NS_A, "schemeClr") || !el.no_text() {
        return None;
    }
    let val = el.single_unqualified_attr("val")?.to_string();
    if let Some(rest) = val.strip_prefix("accent") {
        let n: u8 = rest.parse().ok()?;
        if !(1..=6).contains(&n) {
            return None;
        }
        accents.push(n);
    } else if val != "lt1" && val != "tx1" {
        return None;
    }
    if !allow_tint_alpha {
        if !el.children.is_empty() {
            return None;
        }
        return Some(val);
    }
    let mut ci = 0;
    if el.children.get(ci).is_some_and(|c| c.is(NS_A, "tint")) {
        let t = &el.children[ci];
        ci += 1;
        let tv = t.single_unqualified_attr("val")?;
        if !t.children.is_empty() || !t.no_text() || !matches!(tv, "40000" | "60000") {
            return None;
        }
    }
    if el.children.get(ci).is_some_and(|c| c.is(NS_A, "alpha")) {
        let a = &el.children[ci];
        ci += 1;
        if !a.leaf_val(NS_A, "alpha", "60000") {
            return None;
        }
    }
    (ci == el.children.len()).then_some(val)
}

fn parse_paint(el: &XmlEl, accents: &mut Vec<u8>) -> bool {
    if el.leaf(NS_A, "noFill", &[]) {
        return true;
    }
    el.is(NS_A, "solidFill")
        && el.attrs.is_empty()
        && el.no_text()
        && el.children.len() == 1
        && parse_scheme_clr(&el.children[0], accents, true)
            .is_some_and(|v| v == "lt1" || v.starts_with("accent"))
}

fn parse_drawing_shapes(bytes: &[u8]) -> Option<Vec<DrawingShape>> {
    let root = XmlEl::parse(bytes)?;
    if !root.is(NS_DSP, "drawing")
        || !root.attrs.is_empty()
        || !root.no_text()
        || root.children.len() != 1
    {
        return None;
    }
    let tree = &root.children[0];
    if !tree.is(NS_DSP, "spTree")
        || !tree.attrs.is_empty()
        || !tree.no_text()
        || tree.children.len() < 2
    {
        return None;
    }
    let nv = &tree.children[0];
    if !(nv.is(NS_DSP, "nvGrpSpPr")
        && nv.attrs.is_empty()
        && nv.no_text()
        && nv.children.len() == 2
        && nv.children[0].leaf(NS_DSP, "cNvPr", &[(None, "id", "0"), (None, "name", "")])
        && nv.children[1].leaf(NS_DSP, "cNvGrpSpPr", &[]))
    {
        return None;
    }
    if !tree.children[1].leaf(NS_DSP, "grpSpPr", &[]) {
        return None;
    }

    let mut shapes = Vec::new();
    for (k, sp) in tree.children[2..].iter().enumerate() {
        let expected_id = smart_art_model_id(0x10000 + k);
        if !sp.is(NS_DSP, "sp")
            || !sp.exact_attrs(&[(None, "modelId", &expected_id)])
            || !sp.no_text()
            || !matches!(sp.children.len(), 3 | 5)
        {
            return None;
        }
        let nv_sp = &sp.children[0];
        if !(nv_sp.is(NS_DSP, "nvSpPr")
            && nv_sp.attrs.is_empty()
            && nv_sp.no_text()
            && nv_sp.children.len() == 2
            && nv_sp.children[0].leaf(NS_DSP, "cNvPr", &[(None, "id", "0"), (None, "name", "")])
            && nv_sp.children[1].leaf(NS_DSP, "cNvSpPr", &[]))
        {
            return None;
        }
        let sp_pr = &sp.children[1];
        if !sp_pr.is(NS_DSP, "spPr")
            || !sp_pr.attrs.is_empty()
            || !sp_pr.no_text()
            || sp_pr.children.len() != 4
        {
            return None;
        }
        // a:xfrm
        let xfrm = &sp_pr.children[0];
        if !xfrm.is(NS_A, "xfrm") || !xfrm.no_text() || xfrm.children.len() != 2 {
            return None;
        }
        for (ns, k, v) in &xfrm.attrs {
            if ns.is_some() {
                return None;
            }
            match k.as_str() {
                "rot" if check_emu_int(v, 0, 21_600_000) => {}
                "flipH" if v == "1" => {}
                _ => return None,
            }
        }
        if !check_off_ext(xfrm, "xfrm", -1_000_000_000) {
            return None;
        }
        // a:prstGeom
        let geom = &sp_pr.children[1];
        if !geom.is(NS_A, "prstGeom") || !geom.no_text() || geom.children.len() != 1 {
            return None;
        }
        let prst = geom.single_unqualified_attr("prst")?.to_string();
        if !matches!(
            prst.as_str(),
            "rect" | "roundRect" | "ellipse" | "triangle" | "trapezoid" | "rightArrow" | "line"
        ) {
            return None;
        }
        let av = &geom.children[0];
        if !av.is(NS_A, "avLst") || !av.attrs.is_empty() || !av.no_text() || av.children.len() > 1 {
            return None;
        }
        let has_adj = if let Some(gd) = av.children.first() {
            if !gd.is(NS_A, "gd")
                || gd.attrs.len() != 2
                || !gd.children.is_empty()
                || !gd.no_text()
                || gd.attr(None, "name") != Some("adj")
            {
                return None;
            }
            let fmla = gd.attr(None, "fmla")?;
            let val = fmla.strip_prefix("val ")?;
            if !check_emu_int(val, 0, 10_000_000) {
                return None;
            }
            true
        } else {
            false
        };

        let mut accents = Vec::new();
        if !parse_paint(&sp_pr.children[2], &mut accents) {
            return None;
        }
        let ln = &sp_pr.children[3];
        if !ln.is(NS_A, "ln") || !ln.no_text() || ln.children.len() != 1 {
            return None;
        }
        match ln.attrs.len() {
            0 => {
                if !ln.children[0].leaf(NS_A, "noFill", &[]) {
                    return None;
                }
            }
            1 => {
                let w = ln.single_unqualified_attr("w")?;
                if !check_emu_int(w, 1, 1_000_000_000) || !parse_paint(&ln.children[0], &mut accents)
                {
                    return None;
                }
            }
            _ => return None,
        }

        // dsp:style
        let style = &sp.children[2];
        if !(style.is(NS_DSP, "style")
            && style.attrs.is_empty()
            && style.no_text()
            && style.children.len() == 4)
        {
            return None;
        }
        for (idx, (tag, ref_idx)) in [("lnRef", "2"), ("fillRef", "1"), ("effectRef", "0")]
            .into_iter()
            .enumerate()
        {
            let r = &style.children[idx];
            if !(r.is(NS_A, tag)
                && r.exact_attrs(&[(None, "idx", ref_idx)])
                && r.no_text()
                && r.children.len() == 1
                && r.children[0].leaf(
                    NS_A,
                    "scrgbClr",
                    &[(None, "r", "0"), (None, "g", "0"), (None, "b", "0")],
                ))
            {
                return None;
            }
        }
        let font_ref = &style.children[3];
        if !(font_ref.is(NS_A, "fontRef")
            && font_ref.exact_attrs(&[(None, "idx", "minor")])
            && font_ref.no_text()
            && font_ref.children.len() == 1
            && parse_scheme_clr(&font_ref.children[0], &mut accents, false)
                .is_some_and(|v| v == "lt1" || v == "tx1"))
        {
            return None;
        }

        // Optional dsp:txBody + dsp:txXfrm
        let mut paras = Vec::new();
        if sp.children.len() == 5 {
            let tx_body = &sp.children[3];
            let tx_xfrm = &sp.children[4];
            if !tx_body.is(NS_DSP, "txBody")
                || !tx_body.attrs.is_empty()
                || !tx_body.no_text()
                || tx_body.children.len() < 3
            {
                return None;
            }
            let bp = &tx_body.children[0];
            if !(bp.is(NS_A, "bodyPr")
                && bp.exact_attrs(&[
                    (None, "spcFirstLastPara", "0"),
                    (None, "vert", "horz"),
                    (None, "wrap", "square"),
                    (None, "lIns", "0"),
                    (None, "tIns", "0"),
                    (None, "rIns", "0"),
                    (None, "bIns", "0"),
                    (None, "numCol", "1"),
                    (None, "spcCol", "0"),
                    (None, "anchor", "ctr"),
                    (None, "anchorCtr", "0"),
                ])
                && bp.no_text()
                && bp.children.len() == 1
                && bp.children[0].leaf(NS_A, "noAutofit", &[]))
            {
                return None;
            }
            if !tx_body.children[1].leaf(NS_A, "lstStyle", &[]) {
                return None;
            }
            for p in &tx_body.children[2..] {
                if !p.is(NS_A, "p") || !p.attrs.is_empty() || !p.no_text() || p.children.len() != 2
                {
                    return None;
                }
                let p_pr = &p.children[0];
                if !(p_pr.is(NS_A, "pPr")
                    && p_pr.attrs.len() == 2
                    && p_pr.no_text()
                    && p_pr.children.len() == 1
                    && p_pr.children[0].leaf(NS_A, "buNone", &[]))
                {
                    return None;
                }
                let lvl = p_pr.attr(None, "lvl")?;
                let algn = p_pr.attr(None, "algn")?;
                let is_child = match (lvl, algn) {
                    ("0", "ctr") => false,
                    ("1", "l") => true,
                    _ => return None,
                };
                let run = &p.children[1];
                let text = if run.is(NS_A, "endParaRPr") {
                    if !run.children.is_empty()
                        || !run.no_text()
                        || run.attrs.len() != 2
                        || run.attr(None, "lang") != Some("en-US")
                        || !run
                            .attr(None, "sz")
                            .is_some_and(|s| check_emu_int(s, 100, 10_000))
                    {
                        return None;
                    }
                    String::new()
                } else if run.is(NS_A, "r") {
                    if !run.attrs.is_empty() || !run.no_text() || run.children.len() != 2 {
                        return None;
                    }
                    let r_pr = &run.children[0];
                    if !(r_pr.is(NS_A, "rPr")
                        && r_pr.attrs.len() == 2
                        && r_pr.attr(None, "lang") == Some("en-US")
                        && r_pr
                            .attr(None, "sz")
                            .is_some_and(|s| check_emu_int(s, 100, 10_000))
                        && r_pr.no_text()
                        && r_pr.children.len() == 1
                        && r_pr.children[0].is(NS_A, "solidFill")
                        && r_pr.children[0].attrs.is_empty()
                        && r_pr.children[0].no_text()
                        && r_pr.children[0].children.len() == 1
                        && parse_scheme_clr(&r_pr.children[0].children[0], &mut accents, false)
                            .is_some_and(|v| v == "lt1" || v == "tx1"))
                    {
                        return None;
                    }
                    let a_t = &run.children[1];
                    if !a_t.is(NS_A, "t") || !a_t.attrs.is_empty() || !a_t.children.is_empty() {
                        return None;
                    }
                    a_t.text.clone()
                } else {
                    return None;
                };
                paras.push((text, is_child));
            }
            if !tx_xfrm.is(NS_DSP, "txXfrm")
                || !tx_xfrm.attrs.is_empty()
                || !check_off_ext(tx_xfrm, "txXfrm", -1_000_000_000)
            {
                return None;
            }
        }
        shapes.push(DrawingShape {
            prst,
            has_adj,
            accents,
            paras,
        });
    }
    Some(shapes)
}

fn expected_item_paras(items: &[SmartArtItemData], i: usize, with_children: bool) -> Vec<(String, bool)> {
    let mut out = vec![(items[i].text.clone(), false)];
    if with_children {
        for j in item_descendants(items, i) {
            out.push((format!("• {}", items[j].text), true));
        }
    }
    out
}

fn drawing_matches_data(shapes: &[DrawingShape], data: &DiagramDataModel) -> bool {
    if shapes
        .iter()
        .flat_map(|s| s.accents.iter())
        .any(|&a| !data.colors.allows_accent(a))
    {
        return false;
    }
    if shapes.is_empty() {
        return false;
    }
    let tops: Vec<usize> = data
        .items
        .iter()
        .enumerate()
        .filter(|(_, it)| it.level == 0)
        .map(|(i, _)| i)
        .collect();
    if tops.is_empty() {
        return false;
    }
    match data.layout {
        SmartArtLayoutKind::BasicList => {
            shapes.len() == tops.len()
                && shapes.iter().zip(&tops).all(|(sh, &i)| {
                    sh.prst == "rect"
                        && !sh.has_adj
                        && sh.paras == expected_item_paras(&data.items, i, true)
                })
        }
        SmartArtLayoutKind::Process => {
            let arrows = tops.len() - 1;
            shapes.len() == arrows + tops.len()
                && shapes[..arrows]
                    .iter()
                    .all(|sh| sh.prst == "rightArrow" && !sh.has_adj && sh.paras.is_empty())
                && shapes[arrows..].iter().zip(&tops).all(|(sh, &i)| {
                    sh.prst == "roundRect"
                        && !sh.has_adj
                        && sh.paras == expected_item_paras(&data.items, i, true)
                })
        }
        SmartArtLayoutKind::Cycle => {
            let arrows = shapes.len().saturating_sub(tops.len());
            if tops.len() == 1 && arrows != 0 {
                return false;
            }
            if tops.len() > 1 && arrows != 0 && arrows != tops.len() {
                return false;
            }
            shapes[..arrows]
                .iter()
                .all(|sh| sh.prst == "rightArrow" && !sh.has_adj && sh.paras.is_empty())
                && shapes[arrows..].iter().zip(&tops).all(|(sh, &i)| {
                    sh.prst == "ellipse"
                        && !sh.has_adj
                        && sh.paras == expected_item_paras(&data.items, i, true)
                })
        }
        SmartArtLayoutKind::Hierarchy => {
            let lines = shapes.len().saturating_sub(data.items.len());
            shapes.len() >= data.items.len()
                && shapes[..lines]
                    .iter()
                    .all(|sh| sh.prst == "line" && !sh.has_adj && sh.paras.is_empty())
                && shapes[lines..].iter().enumerate().all(|(i, sh)| {
                    sh.prst == "roundRect"
                        && !sh.has_adj
                        && sh.paras == expected_item_paras(&data.items, i, false)
                })
        }
        SmartArtLayoutKind::Pyramid => {
            shapes.len() == tops.len()
                && shapes.iter().zip(&tops).enumerate().all(|(k, (sh, &i))| {
                    let ok_geom = if k == 0 {
                        sh.prst == "triangle" && !sh.has_adj
                    } else {
                        sh.prst == "trapezoid" && sh.has_adj
                    };
                    ok_geom && sh.paras == expected_item_paras(&data.items, i, true)
                })
        }
        SmartArtLayoutKind::Radial => {
            let parents = item_parents(&data.items);
            let spokes: Vec<usize> = (1..data.items.len())
                .filter(|&i| matches!(parents.get(i), Some(Some(0)) | Some(None)))
                .collect();
            if spokes.is_empty() {
                shapes.len() == 1
                    && shapes[0].prst == "ellipse"
                    && !shapes[0].has_adj
                    && shapes[0].paras == expected_item_paras(&data.items, 0, false)
            } else {
                let n = spokes.len();
                shapes.len() == n + 1 + n
                    && shapes[..n]
                        .iter()
                        .all(|sh| sh.prst == "line" && !sh.has_adj && sh.paras.is_empty())
                    && shapes[n].prst == "ellipse"
                    && !shapes[n].has_adj
                    && shapes[n].paras == expected_item_paras(&data.items, 0, false)
                    && shapes[n + 1..].iter().zip(&spokes).all(|(sh, &i)| {
                        sh.prst == "ellipse"
                            && !sh.has_adj
                            && sh.paras == expected_item_paras(&data.items, i, true)
                    })
            }
        }
        SmartArtLayoutKind::Matrix => {
            shapes.len() == tops.len()
                && shapes.iter().zip(&tops).all(|(sh, &i)| {
                    sh.prst == "roundRect"
                        && !sh.has_adj
                        && sh.paras == expected_item_paras(&data.items, i, true)
                })
        }
        SmartArtLayoutKind::Venn => {
            let n = tops.len();
            shapes.len() == 3 * n
                && shapes[..2 * n]
                    .iter()
                    .all(|sh| sh.prst == "ellipse" && !sh.has_adj && sh.paras.is_empty())
                && shapes[2 * n..].iter().zip(&tops).all(|(sh, &i)| {
                    sh.prst == "rect"
                        && !sh.has_adj
                        && sh.paras == expected_item_paras(&data.items, i, true)
                })
        }
    }
}

// ---- Document.xml reference scanning ----

struct DocumentBindings {
    charts: BTreeSet<String>,
    diagrams: Vec<DiagramBinding>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DiagramBinding {
    data: String,
    layout: String,
    quick_style: String,
    colors: String,
}

#[derive(Clone)]
struct RelEntry {
    id: String,
    kind: String,
    target: String,
    external: bool,
}

fn parse_rels(bytes: &[u8]) -> Option<Vec<RelEntry>> {
    xml::relationships(bytes).ok()?;
    let events = xml::canonical(bytes).ok()?;
    let mut out = Vec::new();
    for event in &events {
        let Canonical::Start {
            namespace: Some(ns),
            name,
            attributes,
        } = event
        else {
            continue;
        };
        if ns.as_str() != "http://schemas.openxmlformats.org/package/2006/relationships"
            || name.as_str() != "Relationship"
        {
            continue;
        }
        let get = |key: &str| -> Option<String> {
            attributes
                .iter()
                .find(|(n, k, _)| n.is_none() && k.as_str() == key)
                .map(|(_, _, v)| v.to_string())
        };
        out.push(RelEntry {
            id: get("Id")?,
            kind: get("Type")?,
            target: get("Target")?,
            external: get("TargetMode").as_deref() == Some("External"),
        });
    }
    Some(out)
}

fn scan_document_bindings(bytes: &[u8], rels: &[RelEntry]) -> Option<DocumentBindings> {
    let events = xml::canonical(bytes).ok()?;
    let mut charts = BTreeSet::new();
    let mut diagrams = Vec::new();
    let by_id = |id: &str, kind: &str| -> Option<String> {
        let rel = rels
            .iter()
            .find(|r| !r.external && r.id == id && r.kind == kind)?;
        package::resolve(DOCUMENT_RELS, &rel.target)
    };
    for event in &events {
        let Canonical::Start {
            namespace: Some(ns),
            name,
            attributes,
        } = event
        else {
            continue;
        };
        let attr = |ans: Option<&str>, key: &str| -> Option<&str> {
            attributes
                .iter()
                .find(|(n, k, _)| n.as_deref() == ans && k.as_str() == key)
                .map(|(_, _, v)| v.as_str())
        };
        if ns.as_str() == NS_C && name.as_str() == "chart" {
            if let Some(id) = attr(Some(NS_R), "id") {
                if let Some(target) = by_id(id, CHART_REL) {
                    charts.insert(target);
                }
            }
        } else if ns.as_str() == NS_DGM && name.as_str() == "relIds" {
            let (Some(dm), Some(lo), Some(qs), Some(cs)) = (
                attr(Some(NS_R), "dm").and_then(|id| by_id(id, DIAGRAM_DATA_REL)),
                attr(Some(NS_R), "lo").and_then(|id| by_id(id, DIAGRAM_LAYOUT_REL)),
                attr(Some(NS_R), "qs").and_then(|id| by_id(id, DIAGRAM_QUICK_STYLE_REL)),
                attr(Some(NS_R), "cs").and_then(|id| by_id(id, DIAGRAM_COLORS_REL)),
            ) else {
                continue;
            };
            diagrams.push(DiagramBinding {
                data: dm,
                layout: lo,
                quick_style: qs,
                colors: cs,
            });
        }
    }
    diagrams.sort();
    diagrams.dedup();
    Some(DocumentBindings { charts, diagrams })
}

fn has_no_part_rels(original: &Package, output: &Package, name: &str) -> bool {
    let Some((dir, file)) = name.rsplit_once('/') else {
        return false;
    };
    let rels_part = format!("{dir}/_rels/{file}.rels");
    !original.parts.contains_key(&rels_part) && !output.parts.contains_key(&rels_part)
}

/// Admitted regenerated chart/SmartArt parts for `compare_saved_docx`.
pub(super) fn graphic_parts_regenerated(
    original: &Package,
    output: &Package,
) -> BTreeSet<String> {
    let mut admitted = BTreeSet::new();
    if original.get(DOCUMENT_RELS) != output.get(DOCUMENT_RELS) {
        return admitted;
    }
    let Some(rels) = original.get(DOCUMENT_RELS).and_then(parse_rels) else {
        return admitted;
    };
    let (Some(orig_doc), Some(out_doc)) = (
        original.get(DOCUMENT_XML).and_then(|b| scan_document_bindings(b, &rels)),
        output.get(DOCUMENT_XML).and_then(|b| scan_document_bindings(b, &rels)),
    ) else {
        return admitted;
    };

    // 1. Charts: bound in document.xml in both original & output, no .rels, strict ChartModel diff.
    for chart_part in orig_doc.charts.intersection(&out_doc.charts) {
        if !package::regenerated_graphic_part(chart_part)
            || !chart_part.starts_with("word/charts/chart")
            || !has_no_part_rels(original, output, chart_part)
        {
            continue;
        }
        let (Some(before), Some(after)) = (original.get(chart_part), output.get(chart_part)) else {
            continue;
        };
        if before == after {
            continue;
        }
        if chart_mutation_allowed(before, after) {
            admitted.insert(chart_part.clone());
        }
    }

    // 2. SmartArt diagrams: bound in document.xml in both original & output, mutually consistent
    //    data + layout + drawing models, preserving colors, quickStyle, and drawing relId.
    let mut drawing_rel_targets: BTreeMap<&str, String> = BTreeMap::new();
    for r in &rels {
        if !r.external && r.kind == DIAGRAM_DRAWING_REL {
            if let Some(target) = package::resolve(DOCUMENT_RELS, &r.target) {
                drawing_rel_targets.insert(r.id.as_str(), target);
            }
        }
    }

    for binding in &orig_doc.diagrams {
        if !out_doc.diagrams.contains(binding) {
            continue;
        }
        let parts = [&binding.data, &binding.layout, &binding.quick_style, &binding.colors];
        if !parts.iter().all(|p| {
            package::regenerated_graphic_part(p) && has_no_part_rels(original, output, p)
        }) {
            continue;
        }
        let (
            Some(before_data_bytes),
            Some(after_data_bytes),
            Some(before_layout_bytes),
            Some(after_layout_bytes),
        ) = (
            original.get(&binding.data),
            output.get(&binding.data),
            original.get(&binding.layout),
            output.get(&binding.layout),
        )
        else {
            continue;
        };
        let (Some(before_data), Some(after_data), Some(before_layout), Some(after_layout)) = (
            parse_diagram_data_model(before_data_bytes),
            parse_diagram_data_model(after_data_bytes),
            parse_layout_model(before_layout_bytes),
            parse_layout_model(after_layout_bytes),
        ) else {
            continue;
        };
        if before_data.colors != after_data.colors
            || before_data.drawing_rel != after_data.drawing_rel
            || before_layout != before_data.layout
            || after_layout != after_data.layout
        {
            continue;
        }
        let Some(drawing_part) = drawing_rel_targets.get(before_data.drawing_rel.as_str()) else {
            continue;
        };
        if !package::regenerated_graphic_part(drawing_part)
            || !drawing_part.starts_with("word/diagrams/drawing")
            || !has_no_part_rels(original, output, drawing_part)
        {
            continue;
        }
        let (Some(before_drawing_bytes), Some(after_drawing_bytes)) =
            (original.get(drawing_part), output.get(drawing_part))
        else {
            continue;
        };
        let (Some(before_shapes), Some(after_shapes)) = (
            parse_drawing_shapes(before_drawing_bytes),
            parse_drawing_shapes(after_drawing_bytes),
        ) else {
            continue;
        };
        if !drawing_matches_data(&before_shapes, &before_data)
            || !drawing_matches_data(&after_shapes, &after_data)
        {
            continue;
        }

        if before_data_bytes != after_data_bytes {
            admitted.insert(binding.data.clone());
        }
        if before_layout_bytes != after_layout_bytes {
            admitted.insert(binding.layout.clone());
        }
        if before_drawing_bytes != after_drawing_bytes {
            admitted.insert(drawing_part.clone());
        }
    }

    admitted
}
