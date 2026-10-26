//! 판별에 필요한 작은 XML 항목(OPC 관계·내용 형식, HWPX manifest·content.hpf)만 읽는다.
//!
//! quick-xml은 미리 정의된 다섯 엔티티만 풀고 DTD의 사용자 엔티티는 확장하지 않는다(엔티티 폭탄 없음).
//! 알 수 없는 엔티티·형식 오류·UTF-8/UTF-16이 아닌 인코딩(BOM 또는 XML 선언)·선언하지 않은 이름공간 접두사·
//! 루트가 하나가 아닌 문서는 오류로 본다. 요소는 이름공간 URI와 지역 이름으로 구별한다(접두사는 보지 않는다).

use quick_xml::events::{BytesRef, BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::reader::NsReader;
use quick_xml::XmlVersion;

use super::package::part_name;

#[derive(Debug, PartialEq, Eq)]
pub struct Invalid;

const OPC_RELATIONSHIPS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const OPC_CONTENT_TYPES: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const ODF_MANIFEST: &str = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
/// HWPX(한컴)는 끝에 `/`가 있는 이름을 쓰고, OPF(EPUB) 표준 이름에는 없다.
const OPF: [&str; 2] = [
    "http://www.idpf.org/2007/opf/",
    "http://www.idpf.org/2007/opf",
];

/// UTF-8(BOM 있음/없음)과 BOM이 있는 UTF-16만 받는다.
fn decode(bytes: &[u8]) -> Result<String, Invalid> {
    let utf16 = |pairs: Vec<u16>| String::from_utf16(&pairs).map_err(|_| Invalid);
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => std::str::from_utf8(rest)
            .map(str::to_owned)
            .map_err(|_| Invalid),
        [0xFF, 0xFE, rest @ ..] if rest.len() % 2 == 0 => utf16(
            rest.as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .collect(),
        ),
        [0xFE, 0xFF, rest @ ..] if rest.len() % 2 == 0 => utf16(
            rest.as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_be_bytes(*pair))
                .collect(),
        ),
        [0xFF, 0xFE, ..] | [0xFE, 0xFF, ..] => Err(Invalid),
        _ => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| Invalid),
    }
}

/// 이름공간을 푼 요소. `depth`는 루트가 0이다.
struct Element {
    depth: usize,
    namespace: Option<String>,
    name: String,
    /// (이름공간, 지역 이름, 값). 접두사 없는 속성은 이름공간이 없다.
    attributes: Vec<(Option<String>, String, String)>,
}

impl Element {
    fn is(&self, namespace: &str, name: &str) -> bool {
        self.namespace.as_deref() == Some(namespace) && self.name == name
    }

    /// 접두사 없는 속성(OPC 속성은 모두 이름공간이 없다).
    fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(namespace, key, _)| namespace.is_none() && key == name)
            .map(|(_, _, value)| value.as_str())
    }
}

enum Node<'a> {
    Element(&'a Element),
    /// 공백이 아닌 문자 데이터(텍스트·CDATA·문자/엔티티 참조). 값은 넘기지 않는다.
    Text,
}

fn namespace(resolved: ResolveResult<'_>) -> Result<Option<String>, Invalid> {
    match resolved {
        ResolveResult::Unbound => Ok(None),
        ResolveResult::Bound(namespace) => Ok(Some(namespace.as_ref().to_owned())),
        ResolveResult::Unknown(_) => Err(Invalid), // 선언하지 않은 접두사
    }
}

fn element(
    reader: &NsReader<&[u8]>,
    start: &BytesStart<'_>,
    depth: usize,
) -> Result<Element, Invalid> {
    let (resolved, local) = reader.resolver().resolve_element(start.name());
    let mut attributes = Vec::new();
    for attribute in start.attributes() {
        let attribute = attribute.map_err(|_| Invalid)?;
        let (resolved, local) = reader.resolver().resolve_attribute(attribute.key);
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|_| Invalid)?
            .into_owned();
        attributes.push((namespace(resolved)?, local.as_ref().to_owned(), value));
    }
    Ok(Element {
        depth,
        namespace: namespace(resolved)?,
        name: local.as_ref().to_owned(),
        attributes,
    })
}

/// 미리 정의된 엔티티와 올바른 문자 참조만 받는다.
fn check_reference(reference: &BytesRef<'_>) -> Result<(), Invalid> {
    if reference.is_char_ref() {
        return match reference.resolve_char_ref() {
            Ok(Some(_)) => Ok(()),
            _ => Err(Invalid),
        };
    }
    match reference.as_ref() {
        "lt" | "gt" | "amp" | "apos" | "quot" => Ok(()),
        _ => Err(Invalid),
    }
}

/// 문서 전체를 읽으며 요소와 공백이 아닌 문자 데이터를 넘긴다. 루트가 정확히 하나이고 모든 요소가 닫혀야 한다.
/// `doctype`이 거짓이면 DTD 선언을 거부한다(OPC는 DTD를 금지한다).
fn walk(
    bytes: &[u8],
    doctype: bool,
    mut visit: impl FnMut(Node<'_>) -> Result<(), Invalid>,
) -> Result<(), Invalid> {
    let text = decode(bytes)?;
    let mut reader = NsReader::from_str(&text);
    let mut depth = 0usize;
    let mut roots = 0usize;
    loop {
        let event = reader.read_event().map_err(|_| Invalid)?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start) => {
                if depth == 0 {
                    roots += 1;
                    if roots > 1 {
                        return Err(Invalid);
                    }
                }
                visit(Node::Element(&element(&reader, start, depth)?))?;
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) => depth = depth.checked_sub(1).ok_or(Invalid)?,
            Event::Text(content) => {
                if !content
                    .as_ref()
                    .bytes()
                    .all(|byte| byte.is_ascii_whitespace())
                {
                    if depth == 0 {
                        return Err(Invalid); // 루트 밖의 문자 데이터
                    }
                    visit(Node::Text)?;
                }
            }
            Event::CData(_) => {
                if depth == 0 {
                    return Err(Invalid);
                }
                visit(Node::Text)?;
            }
            Event::GeneralRef(reference) => {
                check_reference(&reference)?;
                if depth == 0 {
                    return Err(Invalid);
                }
                visit(Node::Text)?;
            }
            Event::Decl(declaration) => {
                if let Some(encoding) = declaration.encoding() {
                    let encoding = encoding.map_err(|_| Invalid)?;
                    if !["utf-8", "utf-16"]
                        .iter()
                        .any(|name| encoding.eq_ignore_ascii_case(name))
                    {
                        return Err(Invalid);
                    }
                }
            }
            Event::DocType(_) if !doctype => return Err(Invalid),
            Event::DocType(_) | Event::Comment(_) | Event::PI(_) => {}
            Event::Eof if depth == 0 && roots == 1 => return Ok(()),
            Event::Eof => return Err(Invalid),
        }
    }
}

/// 정규화한 XML 사건(T009 보존 비교). 이름은 이름공간 URI와 지역 이름이고(접두사 무시), 속성은 이름순, 문자 데이터는
/// 참조를 풀어 이어 붙인 그대로다(공백도 같아야 한다). XML 선언은 넣지 않는다. 주석·처리 명령은 내용째 넣는다.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Canonical {
    Start {
        namespace: Option<String>,
        name: String,
        attributes: Vec<(Option<String>, String, String)>,
    },
    End,
    Text(String),
    Comment(String),
    Instruction(String),
}

/// 이름공간 선언 속성의 이름공간(quick-xml이 `xmlns:p`를 이렇게 푼다).
const XMLNS: &str = "http://www.w3.org/2000/xmlns/";

/// 정규화한 XML 사건 수 상한(한 부분).
const MAX_CANONICAL_EVENTS: usize = 16_000_000;

/// XML 문서 전체를 정규화한 사건 열로 읽는다. 형식 오류·DTD·알 수 없는 엔티티·선언하지 않은 접두사·루트가 하나가
/// 아닌 문서·상한 초과는 `Invalid`(끝까지 읽지 못한 문서를 비교하지 않는다).
pub fn canonical(bytes: &[u8]) -> Result<Vec<Canonical>, Invalid> {
    let text = decode(bytes)?;
    let mut reader = NsReader::from_str(&text);
    let mut out: Vec<Canonical> = Vec::new();
    let mut depth = 0usize;
    let mut roots = 0usize;
    let push_text = |out: &mut Vec<Canonical>, piece: &str| match out.last_mut() {
        Some(Canonical::Text(text)) => text.push_str(piece),
        _ => out.push(Canonical::Text(piece.to_owned())),
    };
    loop {
        if out.len() > MAX_CANONICAL_EVENTS {
            return Err(Invalid);
        }
        let event = reader.read_event().map_err(|_| Invalid)?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start) => {
                if depth == 0 {
                    roots += 1;
                    if roots > 1 {
                        return Err(Invalid);
                    }
                }
                let mut element = element(&reader, start, depth)?;
                // 이름공간 선언은 접두사 선택이라 비교하지 않는다(요소·속성은 URI로 비교). 접두사를 값으로 쓰는 속성
                // (`mc:Ignorable` 등)은 값 그대로 비교하므로 접두사가 바뀌면 다르다고 본다.
                element.attributes.retain(|(namespace, name, _)| {
                    namespace.as_deref() != Some(XMLNS) && !(namespace.is_none() && name == "xmlns")
                });
                element.attributes.sort();
                out.push(Canonical::Start {
                    namespace: element.namespace,
                    name: element.name,
                    attributes: element.attributes,
                });
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                } else {
                    out.push(Canonical::End);
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or(Invalid)?;
                out.push(Canonical::End);
            }
            Event::Text(content) => {
                let piece: &str = content.as_ref();
                if depth == 0 {
                    // 루트 밖에는 공백만 올 수 있고 비교하지 않는다.
                    if !piece.bytes().all(|byte| byte.is_ascii_whitespace()) {
                        return Err(Invalid);
                    }
                    continue;
                }
                push_text(&mut out, piece);
            }
            Event::CData(content) => {
                if depth == 0 {
                    return Err(Invalid);
                }
                let piece: &str = content.as_ref();
                push_text(&mut out, piece);
            }
            Event::GeneralRef(reference) => {
                check_reference(&reference)?;
                if depth == 0 {
                    return Err(Invalid);
                }
                let piece = match reference.resolve_char_ref() {
                    Ok(Some(c)) => c.to_string(),
                    _ => match reference.as_ref() {
                        "lt" => "<".to_owned(),
                        "gt" => ">".to_owned(),
                        "amp" => "&".to_owned(),
                        "apos" => "'".to_owned(),
                        "quot" => "\"".to_owned(),
                        _ => return Err(Invalid),
                    },
                };
                push_text(&mut out, &piece);
            }
            Event::Decl(declaration) => {
                if let Some(encoding) = declaration.encoding() {
                    let encoding = encoding.map_err(|_| Invalid)?;
                    if !["utf-8", "utf-16"]
                        .iter()
                        .any(|name| encoding.eq_ignore_ascii_case(name))
                    {
                        return Err(Invalid);
                    }
                }
            }
            Event::DocType(_) => return Err(Invalid),
            Event::Comment(content) => {
                let piece: &str = content.as_ref();
                out.push(Canonical::Comment(piece.to_owned()));
            }
            Event::PI(content) => {
                let piece: &str = content.as_ref();
                out.push(Canonical::Instruction(piece.to_owned()));
            }
            Event::Eof if depth == 0 && roots == 1 => return Ok(out),
            Event::Eof => return Err(Invalid),
        }
    }
}

/// 요소 하나의 시작(T009 모양 참조 무결성). `canonical`과 달리 자기 닫힘(`<a/>`)과 내용이 있는 요소(`<a></a>`)를 구별하고
/// 부모 요소를 함께 준다: 고정 rhwp HWPX header 파서는 `Event::Start`에서만 `charPr`·`paraPr` 정의를 등록하고 `Event::Empty`는
/// 건너뛴다(`parser/hwpx/header.rs`) — 정규화한 사건 열로는 그 차이를 볼 수 없다.
#[derive(Debug, PartialEq, Eq)]
pub struct ElementStart {
    pub namespace: Option<String>,
    pub name: String,
    pub attributes: Vec<(Option<String>, String, String)>,
    pub self_closing: bool,
    /// 부모 요소의 (이름공간, 지역 이름). 루트는 None.
    pub parent: Option<(Option<String>, String)>,
    /// 부모 요소가 결과 목록에서 차지하는 위치(조상 경로를 따라 올라가는 데 쓴다). 루트는 None.
    pub parent_index: Option<usize>,
}

/// 문서의 모든 요소 시작을 문서 순서로 읽는다. 형식 오류·선언하지 않은 접두사·DTD는 `Invalid`.
pub fn element_starts(bytes: &[u8]) -> Result<Vec<ElementStart>, Invalid> {
    let text = decode(bytes)?;
    let mut reader = NsReader::from_str(&text);
    let mut stack: Vec<(Option<String>, String, usize)> = Vec::new();
    let mut out = Vec::new();
    loop {
        if out.len() > MAX_CANONICAL_EVENTS {
            return Err(Invalid);
        }
        let event = reader.read_event().map_err(|_| Invalid)?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start) => {
                let element = element(&reader, start, stack.len())?;
                let self_closing = matches!(event, Event::Empty(_));
                let index = out.len();
                out.push(ElementStart {
                    namespace: element.namespace.clone(),
                    name: element.name.clone(),
                    attributes: element.attributes,
                    self_closing,
                    parent: stack
                        .last()
                        .map(|(namespace, name, _)| (namespace.clone(), name.clone())),
                    parent_index: stack.last().map(|(_, _, at)| *at),
                });
                if !self_closing {
                    stack.push((element.namespace, element.name, index));
                }
            }
            Event::End(_) => {
                stack.pop().ok_or(Invalid)?;
            }
            Event::DocType(_) => return Err(Invalid),
            Event::Eof if stack.is_empty() => return Ok(out),
            Event::Eof => return Err(Invalid),
            _ => {}
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Relationship {
    pub kind: String,
    pub target: String,
    pub external: bool,
}

/// `_rels/.rels` 같은 관계 항목. 루트는 OPC 관계 이름공간의 `Relationships`, 자식은 같은 이름공간의 빈
/// `Relationship` 요소만 있어야 하고 `Id`는 겹치지 않는다(ECMA-376 Part 2 관계 스키마).
pub fn relationships(bytes: &[u8]) -> Result<Vec<Relationship>, Invalid> {
    let mut found = Vec::new();
    let mut ids = std::collections::HashSet::new();
    walk(bytes, false, |node| {
        let Node::Element(element) = node else {
            return Err(Invalid);
        };
        match element.depth {
            0 if element.is(OPC_RELATIONSHIPS, "Relationships") => Ok(()),
            1 if element.is(OPC_RELATIONSHIPS, "Relationship") => {
                let (Some(id), Some(kind), Some(target)) = (
                    element.attribute("Id"),
                    element.attribute("Type"),
                    element.attribute("Target"),
                ) else {
                    return Err(Invalid);
                };
                let external = match element.attribute("TargetMode") {
                    None | Some("Internal") => false,
                    Some("External") => true,
                    Some(_) => return Err(Invalid),
                };
                if !ids.insert(id.to_owned()) {
                    return Err(Invalid);
                }
                found.push(Relationship {
                    kind: kind.to_owned(),
                    target: target.to_owned(),
                    external,
                });
                Ok(())
            }
            _ => Err(Invalid),
        }
    })?;
    Ok(found)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ContentTypes {
    /// (확장자, 내용 형식)
    pub defaults: Vec<(String, String)>,
    /// (부분 이름, 내용 형식)
    pub overrides: Vec<(String, String)>,
}

impl ContentTypes {
    /// 부분 이름(`/word/document.xml` 형식)의 내용 형식. OPC처럼 대소문자를 무시하고, Override가 Default보다 앞선다.
    /// 확장자는 마지막 경로 조각에서만 찾는다.
    pub fn of(&self, part_name: &str) -> Option<&str> {
        if let Some((_, kind)) = self
            .overrides
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(part_name))
        {
            return Some(kind);
        }
        let segment = part_name.rsplit('/').next()?;
        let extension = segment.rsplit_once('.').map(|(_, extension)| extension)?;
        self.defaults
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(extension))
            .map(|(_, kind)| kind.as_str())
    }
}

/// `[Content_Types].xml`. 루트는 OPC 내용 형식 이름공간의 `Types`, 자식은 같은 이름공간의 빈 `Default`·`Override`
/// 요소만 있어야 한다. 같은 확장자의 Default나 같은 부분 이름의 Override가 둘이면(대소문자 무시) 어느 쪽을 따를지
/// 정할 수 없으므로 거부한다.
pub fn content_types(bytes: &[u8]) -> Result<ContentTypes, Invalid> {
    let mut types = ContentTypes::default();
    walk(bytes, false, |node| {
        let Node::Element(element) = node else {
            return Err(Invalid);
        };
        let kind = element
            .attribute("ContentType")
            .filter(|kind| !kind.is_empty());
        let (key, list) = match element.depth {
            0 if element.is(OPC_CONTENT_TYPES, "Types") => return Ok(()),
            1 if element.is(OPC_CONTENT_TYPES, "Default") => (
                element
                    .attribute("Extension")
                    .filter(|extension| !extension.is_empty() && !extension.contains(['.', '/'])),
                &mut types.defaults,
            ),
            1 if element.is(OPC_CONTENT_TYPES, "Override") => (
                element
                    .attribute("PartName")
                    .filter(|name| name.starts_with('/') && part_name(name).is_some()),
                &mut types.overrides,
            ),
            _ => return Err(Invalid),
        };
        let (Some(key), Some(kind)) = (key, kind) else {
            return Err(Invalid);
        };
        if list.iter().any(|(name, _)| name.eq_ignore_ascii_case(key)) {
            return Err(Invalid);
        }
        list.push((key.to_owned(), kind.to_owned()));
        Ok(())
    })?;
    Ok(types)
}

/// HWPX `META-INF/manifest.xml`(ODF manifest)이 항목 암호화를 선언하는지. 루트는 ODF manifest 이름공간의
/// `manifest`여야 하고, 같은 이름공간의 `encryption-data` 요소가 있으면 암호화 문서다. 주석·텍스트·속성 값이나
/// 다른 이름공간의 같은 이름은 표식이 아니다. ODF 1.0 manifest에는 DTD 선언이 있을 수 있어 받아들인다(확장하지 않음).
pub fn odf_manifest_encrypted(bytes: &[u8]) -> Result<bool, Invalid> {
    let mut encrypted = false;
    walk(bytes, true, |node| {
        if let Node::Element(element) = node {
            if element.depth == 0 && !element.is(ODF_MANIFEST, "manifest") {
                return Err(Invalid);
            }
            encrypted |= element.is(ODF_MANIFEST, "encryption-data");
        }
        Ok(())
    })?;
    Ok(encrypted)
}

/// HWPX `Contents/content.hpf`가 OPF 패키지 문서인지(루트가 OPF 이름공간의 `package`). 내용 목록은 엔진이 읽는다.
pub fn opf_package(bytes: &[u8]) -> Result<(), Invalid> {
    walk(bytes, true, |node| match node {
        Node::Element(element)
            if element.depth == 0
                && !OPF.iter().any(|namespace| element.is(namespace, "package")) =>
        {
            Err(Invalid)
        }
        _ => Ok(()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 관계와_내용_형식을_읽는다() {
        let rels = br#"<?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <!-- comment -->
              <Relationship Id="rId1" Type="t&amp;1" Target="word/document.xml"/>
              <Relationship Id="rId2" Type="ext" Target="https://example.invalid/" TargetMode="External"/>
            </Relationships>"#;
        let found = relationships(rels).unwrap();
        assert_eq!(
            found[0],
            Relationship {
                kind: "t&1".into(),
                target: "word/document.xml".into(),
                external: false
            }
        );
        assert!(found[1].external);

        let types = content_types(br#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="XML" ContentType="a"/><Override PartName="/Word/Document.xml" ContentType="b"/></Types>"#).unwrap();
        assert_eq!(types.of("/word/document.xml"), Some("b"));
        assert_eq!(types.of("/word/styles.xml"), Some("a"));
        assert_eq!(types.of("/word/image"), None);
        assert_eq!(types.of("/word.xml/image"), None);
    }

    #[test]
    fn utf16_bom을_받고_다른_인코딩과_깨진_xml은_거부한다() {
        let text = r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/a.xml" ContentType="k"/></Types>"#;
        let mut le = vec![0xFF, 0xFE];
        le.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(content_types(&le).unwrap().of("/a.xml"), Some("k"));
        let mut be = vec![0xFE, 0xFF];
        be.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(content_types(&be).unwrap().of("/a.xml"), Some("k"));
        le.pop();
        assert_eq!(content_types(&le), Err(Invalid)); // 홀수 길이 UTF-16

        assert_eq!(content_types(&[0xC3, 0x28]), Err(Invalid));
        assert_eq!(
            content_types(b"<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/a\"/></Types>"),
            Err(Invalid)
        );
        assert_eq!(
            relationships(b"<Relationships><Relationship Type=\"t\""),
            Err(Invalid)
        );
        assert_eq!(
            relationships(
                b"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"a\" Type=\"&custom;\" Target=\"x\"/></Relationships>"
            ),
            Err(Invalid)
        );
    }

    #[test]
    fn dtd의_사용자_엔티티를_확장하지_않는다() {
        let bomb = br#"<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>
            <Relationships><Relationship Type="&b;" Target="x"/></Relationships>"#;
        assert_eq!(relationships(bomb), Err(Invalid));
        // DTD를 받는 manifest에서도 사용자 엔티티 참조는 오류다.
        let manifest = br#"<!DOCTYPE m [<!ENTITY a "x">]><m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">&a;</m:manifest>"#;
        assert_eq!(odf_manifest_encrypted(manifest), Err(Invalid));
        let manifest = br#"<!DOCTYPE manifest:manifest PUBLIC "-//OpenOffice.org//DTD Manifest 1.0//EN" "Manifest.dtd"><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>"#;
        assert_eq!(odf_manifest_encrypted(manifest), Ok(false));
    }
}
