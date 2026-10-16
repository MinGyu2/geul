//! 판별에 필요한 작은 XML 항목(OPC 관계·내용 형식)만 읽는다.
//!
//! quick-xml은 미리 정의된 다섯 엔티티만 풀고 DTD의 사용자 엔티티는 확장하지 않는다(엔티티 폭탄 없음).
//! 알 수 없는 엔티티·형식 오류·UTF-8/UTF-16이 아닌 인코딩은 오류로 본다.

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use quick_xml::XmlVersion;

#[derive(Debug, PartialEq, Eq)]
pub struct Invalid;

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
        _ => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| Invalid),
    }
}

/// 모든 시작·빈 요소를 (지역 이름, 속성 목록)으로 넘긴다.
fn for_each_element(
    bytes: &[u8],
    mut visit: impl FnMut(&str, &[(String, String)]),
) -> Result<(), Invalid> {
    let text = decode(bytes)?;
    let mut reader = Reader::from_str(&text);
    loop {
        match reader.read_event().map_err(|_| Invalid)? {
            Event::Start(element) | Event::Empty(element) => {
                let (name, attributes) = element_parts(&element)?;
                visit(&name, &attributes);
            }
            Event::Eof => return Ok(()),
            _ => {}
        }
    }
}

fn element_parts(element: &BytesStart<'_>) -> Result<(String, Vec<(String, String)>), Invalid> {
    let name = element.local_name().as_ref().to_owned();
    let mut attributes = Vec::new();
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|_| Invalid)?;
        let key = attribute.key.local_name().as_ref().to_owned();
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|_| Invalid)?
            .into_owned();
        attributes.push((key, value));
    }
    Ok((name, attributes))
}

fn attribute<'a>(attributes: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

#[derive(Debug, PartialEq, Eq)]
pub struct Relationship {
    pub kind: String,
    pub target: String,
    pub external: bool,
}

/// `_rels/.rels` 같은 관계 항목의 `Relationship` 요소.
pub fn relationships(bytes: &[u8]) -> Result<Vec<Relationship>, Invalid> {
    let mut found = Vec::new();
    let mut missing = false;
    for_each_element(bytes, |name, attributes| {
        if name != "Relationship" {
            return;
        }
        match (
            attribute(attributes, "Type"),
            attribute(attributes, "Target"),
        ) {
            (Some(kind), Some(target)) => found.push(Relationship {
                kind: kind.to_owned(),
                target: target.to_owned(),
                external: attribute(attributes, "TargetMode") == Some("External"),
            }),
            _ => missing = true,
        }
    })?;
    if missing {
        return Err(Invalid);
    }
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
    /// 부분 이름(`/word/document.xml` 형식)의 내용 형식. OPC처럼 대소문자를 무시한다.
    pub fn of(&self, part_name: &str) -> Option<&str> {
        if let Some((_, kind)) = self
            .overrides
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(part_name))
        {
            return Some(kind);
        }
        let extension = part_name.rsplit_once('.').map(|(_, extension)| extension)?;
        self.defaults
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(extension))
            .map(|(_, kind)| kind.as_str())
    }
}

/// `[Content_Types].xml`의 `Default`·`Override` 요소.
pub fn content_types(bytes: &[u8]) -> Result<ContentTypes, Invalid> {
    let mut types = ContentTypes::default();
    let mut missing = false;
    for_each_element(bytes, |name, attributes| {
        let pair = match name {
            "Default" => (attribute(attributes, "Extension"), &mut types.defaults),
            "Override" => (attribute(attributes, "PartName"), &mut types.overrides),
            _ => return,
        };
        match (pair.0, attribute(attributes, "ContentType")) {
            (Some(key), Some(kind)) => pair.1.push((key.to_owned(), kind.to_owned())),
            _ => missing = true,
        }
    })?;
    if missing {
        return Err(Invalid);
    }
    Ok(types)
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
              <r:Relationship xmlns:r="x" Id="rId2" Type="ext" Target="https://example.invalid/" TargetMode="External"/>
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

        let types = content_types(br#"<Types><Default Extension="XML" ContentType="a"/><Override PartName="/Word/Document.xml" ContentType="b"/></Types>"#).unwrap();
        assert_eq!(types.of("/word/document.xml"), Some("b"));
        assert_eq!(types.of("/word/styles.xml"), Some("a"));
        assert_eq!(types.of("/word/image"), None);
    }

    #[test]
    fn utf16_bom을_받고_다른_인코딩과_깨진_xml은_거부한다() {
        let text = r#"<Types><Override PartName="/a.xml" ContentType="k"/></Types>"#;
        let mut le = vec![0xFF, 0xFE];
        le.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(content_types(&le).unwrap().of("/a.xml"), Some("k"));
        let mut be = vec![0xFE, 0xFF];
        be.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(content_types(&be).unwrap().of("/a.xml"), Some("k"));

        assert_eq!(content_types(&[0xC3, 0x28]), Err(Invalid));
        assert_eq!(
            content_types(b"<Types><Override PartName=\"/a\"/></Types>"),
            Err(Invalid)
        );
        assert_eq!(
            relationships(b"<Relationships><Relationship Type=\"t\""),
            Err(Invalid)
        );
        assert_eq!(
            relationships(
                b"<Relationships><Relationship Type=\"&custom;\" Target=\"x\"/></Relationships>"
            ),
            Err(Invalid)
        );
    }

    #[test]
    fn dtd의_사용자_엔티티를_확장하지_않는다() {
        let bomb = br#"<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>
            <Relationships><Relationship Type="&b;" Target="x"/></Relationships>"#;
        assert_eq!(relationships(bomb), Err(Invalid));
    }
}
