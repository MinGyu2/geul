//! Frozen from 308961c; special-rule oracle. Do not update to match replacements.
use super::*;

/// `docProps/app.xml`이 통계 값만 다른지(정규화한 사건 열이 같고, 다른 문자 데이터는 통계 요소 안에만 있다).
pub(super) fn same_except_statistics(before: &[u8], after: &[u8]) -> Option<bool> {
    let (before, after) = (xml::canonical(before).ok()?, xml::canonical(after).ok()?);
    if before.len() != after.len() {
        return Some(false);
    }
    let mut stack: Vec<(Option<&str>, &str)> = Vec::new();
    for (a, b) in before.iter().zip(&after) {
        match (a, b) {
            (
                xml::Canonical::Start {
                    namespace, name, ..
                },
                _,
            ) if a == b => stack.push((namespace.as_deref(), name.as_str())),
            (xml::Canonical::End, xml::Canonical::End) => {
                stack.pop();
            }
            (xml::Canonical::Text(_), xml::Canonical::Text(_)) if a != b => {
                let statistic = stack.last().is_some_and(|(namespace, name)| {
                    *namespace == Some(EXTENDED_PROPERTIES) && STATISTICS.contains(name)
                });
                if !statistic {
                    return Some(false);
                }
            }
            _ if a == b => {}
            _ => return Some(false),
        }
    }
    Some(true)
}

/// DOCX 편집 저장 비교: `word/document.xml`(본문, 엔진 다시 읽기가 확인)을 빼고 원본과 같아야 하며, `docProps/app.xml`은
/// 통계 값만 다를 수 있다.
pub fn compare_saved_docx(original: &Package, output: &Package) -> Vec<Finding> {
    const BODY: &str = "word/document.xml";
    const APP: &str = "docProps/app.xml";
    let mut findings = compare(original, output, &|name| name == BODY || name == APP);
    if let (Some(before), Some(after)) = (original.get(APP), output.get(APP)) {
        if before != after && same_except_statistics(before, after) != Some(true) {
            findings.push(Finding::at(FindingCode::PartChanged, APP));
        }
    }
    // 본문을 바꿨는데 원본 썸네일이 그대로 남으면 편집 전 내용이 보인다. 그림 내용이 없음을 증명할 수 없으므로(JPEG·EMF
    // 등) 썸네일이 있으면 막는다.
    if original.get(BODY) != output.get(BODY) {
        for name in thumbnails(original) {
            if output
                .get(&name)
                .is_some_and(|data| original.get(&name) == Some(data))
            {
                findings.push(Finding::at(FindingCode::PreviewStale, &name));
            }
        }
    }
    findings
}

/// DOCX 썸네일 부분: 패키지 관계(`_rels/.rels`)의 thumbnail 대상과 관례 이름 `docProps/thumbnail.*`.
fn thumbnails(package: &Package) -> Vec<String> {
    const THUMBNAIL: &str = "/metadata/thumbnail";
    let mut names: Vec<String> = package
        .parts
        .keys()
        .filter(|name| name.starts_with("docProps/thumbnail"))
        .cloned()
        .collect();
    if let Some(relationships) = package
        .get("_rels/.rels")
        .and_then(|bytes| xml::relationships(bytes).ok())
    {
        for relationship in relationships {
            if !relationship.external && relationship.kind.ends_with(THUMBNAIL) {
                if let Some(target) = resolve("_rels/.rels", &relationship.target) {
                    if package.parts.contains_key(&target) && !names.contains(&target) {
                        names.push(target);
                    }
                }
            }
        }
    }
    names
}

/// HWPX 편집 저장 비교: 본문 부분을 빼고 원본과 같아야 한다. 본문을 바꿨다면 원본 그대로 남는 `Preview/*`는 내용이
/// 문서 내용과 무관함을 증명해야 한다(빈 값·고정 rhwp 빈 미리보기 상수와 바이트가 같음, `preview`). 그 밖의 미리보기 부분은
/// 증명할 수 없어 막는다.
pub fn compare_saved_hwpx(original: &Package, output: &Package) -> Vec<Finding> {
    let mut findings = compare(original, output, &|name| {
        hwpx_body(name) || name == HWPX_HEADER
    });
    // header는 원본과 같거나, 글자 서식이 덧붙인 글자 모양 정의만 다를 수 있다(T010 Phase 3B, `hwpx_char_shapes_appended`).
    // 빠지거나 생긴 header는 위 `compare`가 이미 적었다.
    // `compare_part`와 같은 판정이지만 header를 한 번만 정규화해 같음 비교와 덧붙임 규칙이 함께 쓴다(큰 header를 두 번씩 읽지 않음).
    if let (Some(before), Some(after)) = (original.get(HWPX_HEADER), output.get(HWPX_HEADER)) {
        if before != after {
            match (xml::canonical(before), xml::canonical(after)) {
                (Err(_), _) => {
                    findings.push(Finding::at(FindingCode::OriginalMalformed, HWPX_HEADER))
                }
                (_, Err(_)) => {
                    findings.push(Finding::at(FindingCode::OutputMalformed, HWPX_HEADER))
                }
                (Ok(b), Ok(a)) => {
                    if b != a && !hwpx_char_shapes_appended(&b, &a, output) {
                        findings.push(Finding::at(FindingCode::PartChanged, HWPX_HEADER));
                    }
                }
            }
        }
    }
    // 본문 부분 바이트를 복사하지 않고 비교한다.
    let body = |package| -> Vec<(&String, &Vec<u8>)> {
        let package: &Package = package;
        package
            .parts
            .iter()
            .filter(|(name, _)| hwpx_body(name))
            .map(|(name, (_, data))| (name, data))
            .collect()
    };
    if body(original) != body(output) {
        for (name, (_, data)) in &original.parts {
            if !name.starts_with("Preview/") || output.get(name) != Some(data.as_slice()) {
                continue;
            }
            let empty = match name.as_str() {
                "Preview/PrvText.txt" => preview::blank_utf8(data),
                "Preview/PrvImage.png" => preview::known_blank_png(data),
                _ => false,
            };
            if !empty {
                findings.push(Finding::at(FindingCode::PreviewStale, name));
            }
        }
    }
    findings
}

/// HWPX 글자·문단 모양 정의를 읽는 부분(고정 rhwp `parser/hwpx/reader.rs` `DOCUMENT_HEADER_PATH`).
const HWPX_HEADER: &str = "Contents/header.xml";
/// 고정 rhwp가 정의를 넣는 id 상한(`parser/hwpx/header.rs` `MAX_RESOURCE_ID`): 넘는 id의 정의는 말없이 버려진다.
const HWPX_MAX_RESOURCE_ID: u32 = 65_535;
/// 본문이 가리키는 모양 이름공간: (참조 속성, 정의 요소). 본문 어느 요소의 참조 속성이든 같은 이름공간을 가리킨다
/// (고정 rhwp: `hp:run`·`hp:formCharPr`의 `charPrIDRef`, `hp:p`의 `paraPrIDRef`).
const HWPX_SHAPE_REFERENCES: [(&str, &str); 2] =
    [("charPrIDRef", "charPr"), ("paraPrIDRef", "paraPr")];

/// 참조·정의 id의 글자 모양: 10진 숫자만(부호·공백·빈 값 없음), u32 범위. 고정 rhwp는 그 밖의 값을 말없이 0으로 읽는다
/// (`parser/hwpx/utils.rs` `parse_u32`·`parse_u16`의 `unwrap_or(0)`)이므로 받지 않는다.
fn hwpx_id(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// HWPML head 이름공간(고정 rhwp가 쓰는 `hh:` — `serializer/hwpx/header.rs`, 한컴 출력과 같음).
const HWPML_HEAD: &str = "http://www.hancom.co.kr/hwpml/2011/head";
/// 정의 요소 → 그 정의를 담는 목록 요소(`hh:charProperties`·`hh:paraProperties`).
const HWPX_SHAPE_LISTS: [&str; 2] = ["charProperties", "paraProperties"];

/// HWPML paragraph 이름공간(고정 rhwp `hp:` — `serializer/hwpx/content.rs`, 한컴 출력과 같음).
const HWPML_PARAGRAPH: &str = "http://www.hancom.co.kr/hwpml/2011/paragraph";

/// 선 모양 토큰 13종(고정 rhwp `serializer/hwpx/char_shape_tables/line_shape.rs` `LINE_SHAPE_HWPX` — 파서
/// `parser/hwpx/header.rs`의 밑줄·취소선 `shape` 표와 같다).
const HWPX_LINE_SHAPES: [&str; 13] = [
    "SOLID",
    "DASH",
    "DOT",
    "DASH_DOT",
    "DASH_DOT_DOT",
    "LONG_DASH",
    "CIRCLE",
    "DOUBLE_SLIM",
    "SLIM_THICK",
    "THICK_SLIM",
    "SLIM_THICK_SLIM",
    "WAVE",
    "DOUBLE_WAVE",
];

/// 글자 서식이 바꿀 수 있는 글자 모양 정의의 자식(T010 Phase 3B): 모두 내용 없는 `hh` 요소다.
const HWPX_FORMAT_CHILDREN: [&str; 4] = ["bold", "italic", "underline", "strikeout"];

/// 고정 rhwp 직렬화기 `color_hex`가 쓰는 색: `none`, `#RRGGBB`, `#AARRGGBB`(대문자 16진).
fn serializer_color(value: &str) -> bool {
    value == "none"
        || value.strip_prefix('#').is_some_and(|hex| {
            (hex.len() == 6 || hex.len() == 8)
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        })
}

/// 덧붙인 정의의 서식 자식 하나가 고정 rhwp 직렬화기(`serializer/hwpx/char_shapes.rs` `write_char_pr`)가 쓰는 모양과 값인지(T010
/// 교정 C1). 굵게·기울임은 속성 없음, 밑줄은 `type`(NONE·BOTTOM·TOP)·`shape`(선 모양 13종)·`color` 셋 모두, 취소선은
/// `shape`(NONE 또는 선 모양 13종)·`color` 둘 모두 — 빠지거나 더한 속성, 이름공간 붙은 속성, 그 밖의 값은 받지 않는다(엔진이 모르는
/// 값을 말없이 기본값으로 읽어 서식 의미를 증명할 수 없음).
fn serializer_format_child(
    local: &str,
    attributes: &[(Option<xml::Atom>, xml::Atom, xml::Atom)],
) -> bool {
    let value = |key: &str| {
        attributes
            .iter()
            .find(|(ns, name, _)| ns.is_none() && name == key)
            .map(|(_, _, value)| value.as_str())
    };
    let exactly = |keys: &[&str]| {
        attributes.len() == keys.len()
            && attributes
                .iter()
                .all(|(ns, name, _)| ns.is_none() && keys.contains(&name.as_str()))
    };
    match local {
        "bold" | "italic" => attributes.is_empty(),
        "underline" => {
            exactly(&["type", "shape", "color"])
                && value("type").is_some_and(|t| ["NONE", "BOTTOM", "TOP"].contains(&t))
                && value("shape").is_some_and(|s| HWPX_LINE_SHAPES.contains(&s))
                && value("color").is_some_and(serializer_color)
        }
        "strikeout" => {
            exactly(&["shape", "color"])
                && value("shape").is_some_and(|s| s == "NONE" || HWPX_LINE_SHAPES.contains(&s))
                && value("color").is_some_and(serializer_color)
        }
        _ => false,
    }
}

/// `events[start]`(Start)와 짝인 End의 위치.
fn element_end(events: &[xml::Canonical], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (index, event) in events.iter().enumerate().skip(start) {
        match event {
            xml::Canonical::Start { .. } => depth += 1,
            xml::Canonical::End => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn is_head(event: &xml::Canonical, local: &str) -> bool {
    matches!(event, xml::Canonical::Start { namespace, name, .. }
        if namespace.as_deref() == Some(HWPML_HEAD) && name == local)
}

fn plain_attribute<'a>(event: &'a xml::Canonical, key: &str) -> Option<&'a str> {
    let xml::Canonical::Start { attributes, .. } = event else {
        return None;
    };
    attributes
        .iter()
        .find(|(ns, name, _)| ns.is_none() && name == key)
        .map(|(_, _, value)| value.as_str())
}

/// 서식 자식을 어떻게 다루나: 덧붙인 정의는 직렬화기 정책(`serializer_format_child`)을 지켜야 하고, 원본 정의는 소급해 거부하지
/// 않는다(내용 없는 서식 자식이면 값과 관계없이 뺀다).
#[derive(Clone, Copy, PartialEq)]
enum FormatPolicy {
    Appended,
    Original,
}

/// 글자 모양 정의 하나(`hh:charPr` 사건 묶음)에서 `id`와 서식 자식을 뺀 나머지. 첫 사건(`id`를 뺀 시작)만 새로 만들고 나머지는
/// 원래 사건을 빌린다(큰 정의 집합에서 사건 벡터를 복제하지 않음). 같은 서식 자식이 두 번이거나 덧붙인 정의의 서식 자식이
/// 정책에 어긋나면 None.
fn without_format(
    definition: &[xml::Canonical],
    policy: FormatPolicy,
) -> Option<Vec<std::borrow::Cow<'_, xml::Canonical>>> {
    use std::borrow::Cow;
    let xml::Canonical::Start {
        namespace,
        name,
        attributes,
    } = definition.first()?
    else {
        return None;
    };
    let mut rest = vec![Cow::Owned(xml::Canonical::Start {
        namespace: namespace.clone(),
        name: name.clone(),
        attributes: attributes
            .iter()
            .filter(|(ns, key, _)| !(ns.is_none() && key == "id"))
            .cloned()
            .collect(),
    })];
    let mut seen = [false; HWPX_FORMAT_CHILDREN.len()];
    let mut index = 1;
    while index < definition.len() {
        let event = &definition[index];
        let format = HWPX_FORMAT_CHILDREN
            .iter()
            .position(|local| is_head(event, local));
        // 정의의 바로 아래 자식인 서식 요소만(깊이 1): 내용이 없어야(곧바로 End) 서식 자식이다.
        if let (Some(slot), Some(xml::Canonical::End)) = (format, definition.get(index + 1)) {
            let xml::Canonical::Start { attributes, .. } = event else {
                return None;
            };
            if seen[slot]
                || (policy == FormatPolicy::Appended
                    && !serializer_format_child(HWPX_FORMAT_CHILDREN[slot], attributes))
            {
                return None;
            }
            seen[slot] = true;
            index += 2;
            continue;
        }
        if let xml::Canonical::Start { .. } = event {
            // 서식이 아닌 자식은 통째로 그대로 둔다(그 안의 같은 이름 요소는 서식 자식이 아니다).
            let end = element_end(definition, index)?;
            rest.extend(definition[index..=end].iter().map(Cow::Borrowed));
            index = end + 1;
            continue;
        }
        rest.push(Cow::Borrowed(event));
        index += 1;
    }
    Some(rest)
}

/// HWPML section 이름공간(구역 뿌리 `hs:sec`).
const HWPML_SECTION: &str = "http://www.hancom.co.kr/hwpml/2011/section";
/// 고정 rhwp 문단 본문 루프가 `parse_form_object`로 읽는 양식 요소(`parser/hwpx/section.rs` `parse_paragraph_body`).
const HWPX_FORM_OBJECTS: [&str; 5] = ["btn", "checkBtn", "radioBtn", "comboBox", "edit"];

/// 출력 본문 구역들에서 엔진이 **글자 모양 참조로 읽는** 자리의 id(T010 교정 B, 2026-10-26 강화). 고정 rhwp 구역 파서
/// (`parser/hwpx/section.rs`)의 실제 경로만 센다(그 파서는 지역 이름만 보지만 판정은 `hp`/`hs` 이름공간까지 요구해 더 좁다):
/// - `run`(내용 있는 것·자기 닫힘 모두)의 `charPrIDRef`: 그 run의 부모가 **읽히는 문단**일 때.
/// - `formCharPr`의 `charPrIDRef`: 자기 닫힘(Empty — Start는 `parse_form_object`가 `skip_element`)이고, 부모가 내용 있는 양식 요소
///   (`HWPX_FORM_OBJECTS`, 문단 루프가 Start에서만 `parse_form_object`를 부름)이며, 그 양식의 부모가 읽히는 문단의 `run`일 때
///   (직렬화기는 양식을 `hp:run` 바로 아래에 쓴다. `hp:ctrl` 안은 `parse_ctrl`이 건너뛴다).
/// - 읽히는 문단 = 구역 뿌리 `hs:sec` 바로 아래 `hp:p`, 또는 `hp:subList` ← `hp:tc` ← `hp:tr` ← `hp:tbl` ← `hp:run` ← 읽히는 문단
///   (표 셀, 중첩 표 포함 — 실제 엔진 서식 출력의 경로). 글상자·머리말·각주 등 그 밖의 문단은 세지 않는다(fail-closed: 그 자리의
///   덧붙임 저장은 거부된다).
///
/// 이름공간 없는 `charPrIDRef` 속성만 보고, 주석·글은 세지 않는다. 읽을 수 없는 구역이면 None.
fn hwpx_char_shape_uses(output: &Package) -> Option<std::collections::BTreeSet<u32>> {
    let mut used = std::collections::BTreeSet::new();
    for (name, (_, data)) in &output.parts {
        if !hwpx_body(name) {
            continue;
        }
        let elements = xml::element_starts(data).ok()?;
        let is = |index: Option<usize>, namespace: &str, local: &str| {
            index.and_then(|i| elements.get(i)).is_some_and(|e| {
                e.namespace.as_deref() == Some(namespace) && e.name == local && !e.self_closing
            })
        };
        let up = |index: Option<usize>| {
            index
                .and_then(|i| elements.get(i))
                .and_then(|e| e.parent_index)
        };
        // 읽히는 문단인지: 조상 사슬을 따라 반복으로 올라간다(깊이는 요소 수로 유한).
        let paragraph = |mut at: Option<usize>| loop {
            if !is(at, HWPML_PARAGRAPH, "p") {
                return false;
            }
            let parent = up(at);
            if is(parent, HWPML_SECTION, "sec") && up(parent).is_none() {
                return true;
            }
            let (list, cell) = (parent, up(parent));
            let (row, table) = (up(cell), up(up(cell)));
            let run = up(table);
            if !(is(list, HWPML_PARAGRAPH, "subList")
                && is(cell, HWPML_PARAGRAPH, "tc")
                && is(row, HWPML_PARAGRAPH, "tr")
                && is(table, HWPML_PARAGRAPH, "tbl")
                && is(run, HWPML_PARAGRAPH, "run"))
            {
                return false;
            }
            at = up(run);
        };
        let run_in_paragraph =
            |index: Option<usize>| is(index, HWPML_PARAGRAPH, "run") && paragraph(up(index));
        for element in &elements {
            if element.namespace.as_deref() != Some(HWPML_PARAGRAPH) {
                continue;
            }
            let reads = match element.name.as_str() {
                "run" => paragraph(element.parent_index),
                "formCharPr" => {
                    let form = element.parent_index;
                    element.self_closing
                        && form.and_then(|i| elements.get(i)).is_some_and(|f| {
                            !f.self_closing
                                && f.namespace.as_deref() == Some(HWPML_PARAGRAPH)
                                && HWPX_FORM_OBJECTS.contains(&f.name.as_str())
                        })
                        && run_in_paragraph(up(form))
                }
                _ => false,
            };
            if !reads {
                continue;
            }
            for (ns, key, value) in &element.attributes {
                if ns.is_none() && key == "charPrIDRef" {
                    if let Some(id) = hwpx_id(value) {
                        used.insert(id);
                    }
                }
            }
        }
    }
    Some(used)
}

/// 원본과 출력 header의 차이가 글자 서식의 글자 모양 덧붙임뿐인지(T010 Phase 3B 좁은 header 규칙, 교정 B·C). 모두 성립해야 참:
/// - 두 header 모두 끝까지 읽히고 `hh:charProperties`가 정확히 하나이며, 그 앞뒤 사건이 같다.
/// - 목록 시작의 속성은 `itemCnt`만 다르고, 원본 `itemCnt` = 원본 정의 수 n이며 원본 정의 id가 정확히 0..n(고정 rhwp는 새 모양
///   id를 배열 길이로 정한다 — `model/document.rs` `find_or_create_char_shape`), 출력 `itemCnt` = n + k(k ≥ 1).
/// - 출력 목록은 원본 목록 내용 그대로 뒤에 `hh:charPr` 정의 k개만 덧붙였다(사이 글·주석 없음). 덧붙인 id는 n..n+k이고
///   엔진이 버리는 상한(65535) 이하.
/// - 덧붙인 정의 각각은 서식 자식이 직렬화기 정책(`serializer_format_child`)을 지키고, `id`와 서식 자식을 빼면 원본 정의 하나와
///   **정확히** 같다. 원본 정의를 정규화한 값의 해시 집합으로 찾는다(해시가 같아도 집합이 전체 값을 비교한다 — 해시 일치만으로
///   같다고 보지 않음). 원본 정의마다 한 번만 정규화한다(이전 판은 덧붙임마다 원본 전체를 훑어 n·k에 비례했다).
/// - 덧붙인 정의 각각을 출력 본문이 엔진이 읽는 글자 모양 참조로 가리킨다(`hwpx_char_shape_uses`).
///   정의가 엔진이 등록하는 모양(내용 있는 요소)인지는 `validate_hwpx_references`가 따로 확인한다.
fn hwpx_char_shapes_appended(
    before: &[xml::Canonical],
    after: &[xml::Canonical],
    output: &Package,
) -> bool {
    let list = |events: &[xml::Canonical]| -> Option<(usize, usize)> {
        let mut found = events
            .iter()
            .enumerate()
            .filter(|(_, event)| is_head(event, HWPX_SHAPE_LISTS[0]));
        let (start, _) = found.next()?;
        if found.next().is_some() {
            return None;
        }
        Some((start, element_end(events, start)?))
    };
    let (Some((b_start, b_end)), Some((a_start, a_end))) = (list(before), list(after)) else {
        return false;
    };
    if before[..b_start] != after[..a_start] || before[b_end..] != after[a_end..] {
        return false;
    }
    // 목록 시작: itemCnt 밖의 속성은 같아야 한다.
    let others = |event: &xml::Canonical| match event {
        xml::Canonical::Start {
            namespace,
            name,
            attributes,
        } => Some((
            namespace.clone(),
            name.clone(),
            attributes
                .iter()
                .filter(|(ns, key, _)| !(ns.is_none() && key == "itemCnt"))
                .cloned()
                .collect::<Vec<_>>(),
        )),
        _ => None,
    };
    if others(&before[b_start]) != others(&after[a_start]) {
        return false;
    }
    let count = |event| plain_attribute(event, "itemCnt").and_then(hwpx_id);
    let (Some(n), Some(total)) = (count(&before[b_start]), count(&after[a_start])) else {
        return false;
    };
    let original = &before[b_start + 1..b_end];
    let Some(appended) = after[a_start + 1..a_end].strip_prefix(original) else {
        return false;
    };
    let definitions = |events| -> Option<Vec<(u32, &[xml::Canonical])>> {
        let events: &[xml::Canonical] = events;
        let mut out = Vec::new();
        let mut index = 0;
        while index < events.len() {
            if !is_head(&events[index], "charPr") {
                return None;
            }
            let end = element_end(events, index)?;
            let id = plain_attribute(&events[index], "id").and_then(hwpx_id)?;
            out.push((id, &events[index..=end]));
            index = end + 1;
        }
        Some(out)
    };
    let (Some(old), Some(new)) = (definitions(original), definitions(appended)) else {
        return false;
    };
    let (Ok(n_defs), Ok(k)) = (u32::try_from(old.len()), u32::try_from(new.len())) else {
        return false;
    };
    if k == 0
        || n_defs != n
        || n.checked_add(k) != Some(total)
        || total - 1 > HWPX_MAX_RESOURCE_ID
        || !old.iter().zip(0u32..).all(|((id, _), i)| *id == i)
        || !new.iter().zip(n..).all(|((id, _), i)| *id == i)
    {
        return false;
    }
    let Some(used) = hwpx_char_shape_uses(output) else {
        return false;
    };
    if !new.iter().all(|(id, _)| used.contains(id)) {
        return false;
    }
    // 원본 정의는 소급해 거부하지 않는다: 같은 서식 자식이 둘인 정의는 덧붙임의 바탕이 될 수 없을 뿐이다.
    let bases: std::collections::HashSet<_> = old
        .iter()
        .filter_map(|(_, events)| without_format(events, FormatPolicy::Original))
        .collect();
    new.iter().all(|(_, events)| {
        without_format(events, FormatPolicy::Appended).is_some_and(|key| bases.contains(&key))
    })
}

/// header의 모양 정의 id 집합(이름공간마다) — 고정 rhwp가 실제로 등록하는 정의만(2026-10-22 2차 고침).
///
/// 엔진(`parser/hwpx/header.rs` `parse_hwpx_header_with_plain_margin_units`)은 지역 이름이 `charPr`·`paraPr`인 요소를 이름공간·위치와
/// 관계없이 `Event::Start`(내용이 있는 요소)에서만 등록하고, 자기 닫힘(`Event::Empty`)은 건너뛴다(실측: 자기 닫힘 정의를 가리키면 엔진은
/// 그 id를 보고하며 기본 모양으로 그리고, 내보내기는 그 정의를 빼고 쓴다). 그래서:
/// - 정의 = 내용이 있는 요소이고 `hh` 이름공간이며 부모가 같은 이름공간의 목록 요소(`charProperties`·`paraProperties`)인 것.
/// - 자기 닫힘 `charPr`·`paraPr`는 정의가 아니다(가리키면 `referenceInvalid`). 쓰지 않는 자기 닫힘 요소만으로는 막지 않는다.
/// - 엔진이 등록하지만 정의로 확인할 수 없는 요소(다른 이름공간·다른 위치의 내용 있는 `charPr`/`paraPr` — 엔진은 그것도 같은 배열에
///   넣어 정의를 덮을 수 있다), id가 없거나 숫자가 아님(엔진은 등장 순서·0으로 넣는다), 등록되는 요소끼리 같은 id(뒤의 것이 덮는다)이면
///   None: 참조가 무엇을 가리키는지 증명할 수 없다.
fn hwpx_definitions(header: &[u8]) -> Option<[std::collections::BTreeSet<u32>; 2]> {
    let mut sets = [
        std::collections::BTreeSet::new(),
        std::collections::BTreeSet::new(),
    ];
    xml::visit_element_starts(header, |element| {
        let Some(slot) = HWPX_SHAPE_REFERENCES
            .iter()
            .position(|(_, name)| *name == element.name)
        else {
            return Ok(());
        };
        if element.self_closing {
            return Ok(()); // 엔진이 등록하지 않는다
        }
        let in_list = element.namespace.as_deref() == Some(HWPML_HEAD)
            && element.parent.as_ref().is_some_and(|(namespace, name)| {
                namespace.as_deref() == Some(HWPML_HEAD) && name == HWPX_SHAPE_LISTS[slot]
            });
        if !in_list {
            return Err(xml::Invalid);
        }
        let id = element
            .attributes
            .iter()
            .find(|(ns, key, _)| ns.is_none() && key == "id")
            .and_then(|(_, _, value)| hwpx_id(value))
            .ok_or(xml::Invalid)?;
        if !sets[slot].insert(id) {
            return Err(xml::Invalid);
        }
        Ok(())
    })
    .ok()?;
    // 엔진이 버리는 id의 정의는 정의가 아니다(가리키면 기본 모양으로 대체된다).
    for set in &mut sets {
        set.retain(|id| *id <= HWPX_MAX_RESOURCE_ID);
    }
    Some(sets)
}

/// HWPX 출력의 모양 참조 무결성(T009, T010 Phase 0 Stage B 결함 수정): 출력 본문 부분(`Contents/section<N>.xml`, 표 셀·구역
/// 정의 run 등 중첩 포함 모든 요소)의 `charPrIDRef`·`paraPrIDRef`가 10진 숫자이고 출력 header에 정의된 id를 가리켜야 한다.
/// 고정 rhwp는 없는 id를 기본 모양으로, 숫자가 아닌 값을 0으로 말없이 바꿔 다시 열기 비교(쪽·글·컨트롤)로는 드러나지 않는다.
/// - 맞지 않는 참조: `referenceInvalid`(unsafe, 부분 이름).
/// - header가 없음·정의 id를 정할 수 없음: `unsupported`(unknown, `Contents/header.xml`) — 증명할 수 없으면 저장하지 않는다.
///   읽을 수 없는 header·본문은 `validate_hwpx`가 이미 `outputMalformed`로 막는다.
///
/// id가 이어져야 한다고 요구하지 않는다(엔진은 id를 배열 위치로 쓰고 빈 번호는 정의가 아니다).
pub fn validate_hwpx_references(output: &Package) -> Vec<Finding> {
    let sections: Vec<(&String, &Vec<u8>)> = output
        .parts
        .iter()
        .filter(|(name, _)| hwpx_body(name))
        .map(|(name, (_, data))| (name, data))
        .collect();
    if sections.is_empty() {
        return Vec::new();
    }
    let Some(header) = output.get(HWPX_HEADER) else {
        return vec![Finding::at(FindingCode::Unsupported, HWPX_HEADER)];
    };
    // 읽을 수 없는 header는 malformed_xml(validate_hwpx)이 이미 `outputMalformed`로 막는다(같은 까닭을 두 번 적지 않음).
    if xml::canonical_valid(header).is_err() {
        return Vec::new();
    }
    let Some(definitions) = hwpx_definitions(header) else {
        return vec![Finding::at(FindingCode::Unsupported, HWPX_HEADER)];
    };
    let mut findings = Vec::new();
    for (name, data) in sections {
        // 읽을 수 없는 본문은 malformed_xml(validate_hwpx)이 이미 막는다.
        let Ok(events) = xml::canonical(data) else {
            continue;
        };
        let invalid = events.iter().any(|event| {
            let xml::Canonical::Start { attributes, .. } = event else {
                return false;
            };
            attributes.iter().any(|(ns, key, value)| {
                ns.is_none()
                    && HWPX_SHAPE_REFERENCES.iter().zip(&definitions).any(
                        |((attribute, _), set)| {
                            key == attribute && !hwpx_id(value).is_some_and(|id| set.contains(&id))
                        },
                    )
            })
        });
        if invalid {
            findings.push(Finding::at(FindingCode::ReferenceInvalid, name));
        }
    }
    findings
}
