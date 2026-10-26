// Independent differential oracle: canonical implementation at 47eb616, test-only.
use super::*;
const MAX_CANONICAL_EVENTS: usize = 16_000_000;
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

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum LegacyCanonical {
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
pub fn canonical_legacy(bytes: &[u8]) -> Result<Vec<LegacyCanonical>, Invalid> {
    let text = decode(bytes)?;
    let mut reader = NsReader::from_str(&text);
    let mut out: Vec<LegacyCanonical> = Vec::new();
    let mut depth = 0usize;
    let mut roots = 0usize;
    let push_text = |out: &mut Vec<LegacyCanonical>, piece: &str| match out.last_mut() {
        Some(LegacyCanonical::Text(text)) => text.push_str(piece),
        _ => out.push(LegacyCanonical::Text(piece.to_owned())),
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
                out.push(LegacyCanonical::Start {
                    namespace: element.namespace,
                    name: element.name,
                    attributes: element.attributes,
                });
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                } else {
                    out.push(LegacyCanonical::End);
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or(Invalid)?;
                out.push(LegacyCanonical::End);
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
                out.push(LegacyCanonical::Comment(piece.to_owned()));
            }
            Event::PI(content) => {
                let piece: &str = content.as_ref();
                out.push(LegacyCanonical::Instruction(piece.to_owned()));
            }
            Event::Eof if depth == 0 && roots == 1 => return Ok(out),
            Event::Eof => return Err(Invalid),
        }
    }
}
