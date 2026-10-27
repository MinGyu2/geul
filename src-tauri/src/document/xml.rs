//! XML 판독과 저장 보존용 의미 사건 비교(OPC 관계·내용 형식·HWPX header/본문 포함).
//!
//! quick-xml은 미리 정의된 다섯 엔티티만 풀고 DTD의 사용자 엔티티는 확장하지 않는다(엔티티 폭탄 없음).
//! 알 수 없는 엔티티·형식 오류·UTF-8/UTF-16이 아닌 인코딩(BOM 또는 XML 선언)·선언하지 않은 이름공간 접두사·
//! 루트가 하나가 아닌 문서는 오류로 본다. 요소는 이름공간 URI와 지역 이름으로 구별한다(접두사는 보지 않는다).

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::Arc;

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
pub(crate) fn decode(bytes: &[u8]) -> Result<Cow<'_, str>, Invalid> {
    let utf16 = |pairs: &[u8], little: bool| {
        let units = || {
            pairs.as_chunks::<2>().0.iter().map(|p| {
                if little {
                    u16::from_le_bytes(*p)
                } else {
                    u16::from_be_bytes(*p)
                }
            })
        };
        // Count and validate before allocating: a 3-bytes/unit upper-bound reservation
        // over-allocates ASCII UTF-16. No intermediate Vec<u16> is retained.
        let needed = char::decode_utf16(units()).try_fold(0usize, |size, ch| {
            size.checked_add(ch.map_err(|_| Invalid)?.len_utf8())
                .ok_or(Invalid)
        })?;
        super::resources::charge(super::resources::Category::Decoder, needed)
            .map_err(|_| Invalid)?;
        let mut out = String::new();
        out.try_reserve_exact(needed).map_err(|_| {
            crate::document::resources::allocation_refused();
            Invalid
        })?;
        for ch in char::decode_utf16(units()) {
            out.push(ch.map_err(|_| Invalid)?);
        }
        Ok(Cow::Owned(out))
    };
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => std::str::from_utf8(rest)
            .map(Cow::Borrowed)
            .map_err(|_| Invalid),
        [0xFF, 0xFE, rest @ ..] if rest.len() % 2 == 0 => utf16(rest, true),
        [0xFE, 0xFF, rest @ ..] if rest.len() % 2 == 0 => utf16(rest, false),
        [0xFF, 0xFE, ..] | [0xFE, 0xFF, ..] => Err(Invalid),
        _ => std::str::from_utf8(bytes)
            .map(Cow::Borrowed)
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
        ResolveResult::Bound(namespace) => Ok(Some(fallible_string(namespace.as_ref())?)),
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
            .map_err(|_| Invalid)?;
        let value = match value {
            Cow::Owned(value) => value,
            Cow::Borrowed(value) => fallible_string(value)?,
        };
        attributes.try_reserve(1).map_err(|_| {
            crate::document::resources::allocation_refused();
            Invalid
        })?;
        attributes.push((
            namespace(resolved)?,
            fallible_string(local.as_ref())?,
            value,
        ));
    }
    Ok(Element {
        depth,
        namespace: namespace(resolved)?,
        name: fallible_string(local.as_ref())?,
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

/// Immutable interned XML spelling. Cloning an event/definition shares strings, not model state.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Atom(Arc<String>);
impl Atom {
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}
impl std::ops::Deref for Atom {
    type Target = str;
    fn deref(&self) -> &str {
        self.as_str()
    }
}
impl std::borrow::Borrow<str> for Atom {
    fn borrow(&self) -> &str {
        self.as_str()
    }
}
impl PartialEq<&str> for Atom {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}
impl PartialEq<str> for Atom {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}
impl std::fmt::Debug for Atom {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.as_str().fmt(f)
    }
}

#[derive(Clone, Default)]
struct Atoms {
    values: HashSet<Atom>,
    payload: usize,
}
impl Atoms {
    fn intern(&mut self, value: String) -> Result<Atom, Invalid> {
        if let Some(found) = self.values.get(value.as_str()) {
            return Ok(found.clone());
        }
        self.values.try_reserve(1).map_err(|_| {
            crate::document::resources::allocation_refused();
            Invalid
        })?;
        self.payload = self.payload.checked_add(value.capacity()).ok_or(Invalid)?;
        let atom = Atom(Arc::new(value));
        self.values.insert(atom.clone());
        Ok(atom)
    }
}

/// 정규화한 XML 사건(T009 보존 비교). 이름은 이름공간 URI와 지역 이름이고(접두사 무시), 속성은 이름순, 문자 데이터는
/// 참조를 풀어 이어 붙인 그대로다(공백도 같아야 한다). XML 선언은 넣지 않는다. 주석·처리 명령은 내용째 넣는다.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Canonical {
    Start {
        namespace: Option<Atom>,
        name: Atom,
        attributes: Vec<(Option<Atom>, Atom, Atom)>,
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
/// Requested retained payload accounting, not an allocator/RSS cap. Atom headers,
/// hash-table metadata, parser temporaries and package buffers are explicitly outside it.
#[derive(Clone, Copy, Debug, Default)]
pub struct CanonicalMemory {
    pub retained_payload_bytes: usize,
    pub events: usize,
    pub event_capacity_bytes: usize,
    pub attribute_capacity_bytes: usize,
    pub atom_payload_bytes: usize,
    pub text_capacity_bytes: usize,
}
#[derive(Debug, PartialEq, Eq)]
pub enum CanonicalFailure {
    Invalid,
    /// Explicit retained event/text Vec reservation failed. Other parser/Arc
    /// allocations are not comprehensively fallible and may still abort.
    Allocation,
    PayloadLimit,
}

/// Optional finite policy is prepared for review only; production uses None to preserve compatibility.
pub fn canonical_with_payload_limit(
    bytes: &[u8],
    limit: Option<usize>,
) -> Result<(Vec<Canonical>, CanonicalMemory), CanonicalFailure> {
    let mut out: Vec<Canonical> = Vec::new();
    let mut strings = 0usize;
    let mut attributes = 0usize;
    let mut memory = CanonicalMemory::default();
    let mut limited = false;
    let mut allocation_failed = false;
    let result = canonical_walk(bytes, true, |event, atoms| {
        let extra = match &event {
            Canonical::Start {
                attributes: attrs, ..
            } => attrs
                .capacity()
                .checked_mul(std::mem::size_of::<(Option<Atom>, Atom, Atom)>())
                .ok_or(Invalid)?,
            Canonical::Text(s) | Canonical::Comment(s) | Canonical::Instruction(s) => s.capacity(),
            Canonical::End => 0,
        };
        match event {
            Canonical::Text(piece) if matches!(out.last(), Some(Canonical::Text(_))) => {
                let Some(Canonical::Text(text)) = out.last_mut() else {
                    return Err(Invalid);
                };
                let old = text.capacity();
                text.try_reserve(piece.len()).map_err(|_| {
                    allocation_failed = true;
                    super::resources::allocation_refused();
                    Invalid
                })?;
                text.push_str(&piece);
                strings = strings.checked_add(text.capacity() - old).ok_or(Invalid)?;
            }
            event => {
                if matches!(event, Canonical::Start { .. }) {
                    attributes = attributes.checked_add(extra).ok_or(Invalid)?;
                } else {
                    strings = strings.checked_add(extra).ok_or(Invalid)?;
                }
                out.try_reserve(1).map_err(|_| {
                    allocation_failed = true;
                    super::resources::allocation_refused();
                    Invalid
                })?;
                out.push(event);
            }
        }
        // Account retained Vec capacity as well as atom/string capacities. A just-built
        // parser event is transient and not covered by this optional admission policy.
        let retained = out
            .capacity()
            .checked_mul(std::mem::size_of::<Canonical>())
            .and_then(|v| v.checked_add(attributes))
            .and_then(|v| v.checked_add(strings))
            .and_then(|v| v.checked_add(atoms))
            .ok_or(Invalid)?;
        memory.event_capacity_bytes = out.capacity() * std::mem::size_of::<Canonical>();
        memory.attribute_capacity_bytes = attributes;
        memory.atom_payload_bytes = atoms;
        memory.text_capacity_bytes = strings;
        memory.retained_payload_bytes = memory.retained_payload_bytes.max(retained);
        if limit.is_some_and(|cap| retained > cap) {
            limited = true;
            return Err(Invalid);
        }
        Ok(())
    });
    if result.is_err() {
        return Err(if limited {
            CanonicalFailure::PayloadLimit
        } else if allocation_failed {
            CanonicalFailure::Allocation
        } else {
            CanonicalFailure::Invalid
        });
    }
    memory.events = out.len();
    Ok((out, memory))
}

pub fn canonical(bytes: &[u8]) -> Result<Vec<Canonical>, Invalid> {
    canonical_with_payload_limit(bytes, None)
        .map(|(events, _)| events)
        .map_err(|_| Invalid)
}

/// Preserve selected controlled allocation/refusal provenance without conflating
/// syntax errors with exhausted resources in an active service operation.
pub(crate) fn canonical_checked(bytes: &[u8]) -> Result<(), CanonicalFailure> {
    let epoch = super::resources::failure_epoch();
    canonical_valid(bytes).map_err(|_| {
        if super::resources::failure_epoch() != epoch {
            CanonicalFailure::Allocation
        } else {
            CanonicalFailure::Invalid
        }
    })
}

/// Same full parser validation, without retaining the event vector.
pub fn canonical_valid(bytes: &[u8]) -> Result<(), Invalid> {
    canonical_walk(bytes, false, |_, _| Ok(()))
}

/// Comparison retains two parser cursors, one event per side, and at most 16 KiB
/// of owned text per cursor. Attributes/comments/PI, namespace stacks and decoded
/// UTF-16 remain proportional to their input; this is not a total heap cap.
const TEXT_CHUNK: usize = 16 * 1024;

#[derive(Clone)]
struct CanonicalCursor<'a, const RETAIN: bool, const STREAM: bool> {
    reader: NsReader<&'a [u8]>,
    atoms: Atoms,
    depth: usize,
    roots: usize,
    count: usize,
    last_text: bool,
    pending_end: bool,
    pending_text: Option<(&'a str, usize)>,
    validation_name: Atom,
}

impl<'a, const RETAIN: bool, const STREAM: bool> CanonicalCursor<'a, RETAIN, STREAM> {
    fn new(text: &'a str) -> Self {
        Self {
            reader: NsReader::from_str(text),
            atoms: Atoms::default(),
            depth: 0,
            roots: 0,
            count: 0,
            last_text: false,
            pending_end: false,
            pending_text: None,
            validation_name: Atom(Arc::new(String::new())),
        }
    }

    fn text(&mut self, piece: Cow<'a, str>) -> Result<Canonical, Invalid> {
        if !RETAIN {
            return Ok(Canonical::Text(String::new()));
        }
        // Slice-reader text and CDATA borrow the immutable decoded input.
        // No full text-node copy is needed by the comparison cursor.
        let piece = match piece {
            Cow::Borrowed(piece) if STREAM && piece.len() > TEXT_CHUNK => {
                self.pending_text = Some((piece, 0));
                return self.text_chunk();
            }
            piece => piece,
        };
        Ok(Canonical::Text(fallible_string(&piece)?))
    }

    fn text_chunk(&mut self) -> Result<Canonical, Invalid> {
        let (piece, start) = self.pending_text.ok_or(Invalid)?;
        let mut end = piece.len().min(start + TEXT_CHUNK);
        while !piece.is_char_boundary(end) {
            end -= 1;
        }
        self.pending_text = (end < piece.len()).then_some((piece, end));
        Ok(Canonical::Text(fallible_string(&piece[start..end])?))
    }

    #[inline]
    fn next(&mut self) -> Result<Option<Canonical>, Invalid> {
        if STREAM {
            self.atoms = Atoms::default();
        }
        let event = loop {
            let event = self.read()?;
            if self.last_text && matches!(&event, Some(Canonical::Text(s)) if s.is_empty()) {
                continue;
            }
            break event;
        };
        if let Some(event) = &event {
            let text = matches!(event, Canonical::Text(_));
            if !text || !self.last_text {
                self.count += 1;
            }
            self.last_text = text;
            if self.count > MAX_CANONICAL_EVENTS {
                return Err(Invalid);
            }
        }
        Ok(event)
    }

    #[inline]
    fn read(&mut self) -> Result<Option<Canonical>, Invalid> {
        if self.pending_text.is_some() {
            return self.text_chunk().map(Some);
        }
        if self.pending_end {
            self.pending_end = false;
            return Ok(Some(Canonical::End));
        }
        loop {
            let event = self.reader.read_event().map_err(|_| Invalid)?;
            let normalized = match event {
                Event::Start(ref start) | Event::Empty(ref start) => {
                    if self.depth == 0 {
                        self.roots += 1;
                        if self.roots > 1 {
                            return Err(Invalid);
                        }
                    }
                    let mut element = element(&self.reader, start, self.depth)?;
                    if matches!(event, Event::Start(_)) {
                        self.depth += 1;
                    } else {
                        self.pending_end = true;
                    }
                    if RETAIN {
                        element.attributes.retain(|(namespace, name, _)| {
                            namespace.as_deref() != Some(XMLNS)
                                && !(namespace.is_none() && name == "xmlns")
                        });
                        element.attributes.sort();
                        let namespace = element
                            .namespace
                            .map(|v| self.atoms.intern(v))
                            .transpose()?;
                        let name = self.atoms.intern(element.name)?;
                        let mut attributes = Vec::new();
                        attributes
                            .try_reserve_exact(element.attributes.len())
                            .map_err(|_| {
                                crate::document::resources::allocation_refused();
                                Invalid
                            })?;
                        for (ns, key, value) in element.attributes {
                            attributes.push((
                                ns.map(|v| self.atoms.intern(v)).transpose()?,
                                self.atoms.intern(key)?,
                                self.atoms.intern(value)?,
                            ));
                        }
                        Canonical::Start {
                            namespace,
                            name,
                            attributes,
                        }
                    } else {
                        Canonical::Start {
                            namespace: None,
                            name: self.validation_name.clone(),
                            attributes: Vec::new(),
                        }
                    }
                }
                Event::End(_) => {
                    self.depth = self.depth.checked_sub(1).ok_or(Invalid)?;
                    Canonical::End
                }
                Event::Text(content) => {
                    if self.depth == 0 {
                        if !content.as_ref().bytes().all(|b| b.is_ascii_whitespace()) {
                            return Err(Invalid);
                        }
                        continue;
                    }
                    self.text(content.into_inner())?
                }
                Event::CData(content) => {
                    if self.depth == 0 {
                        return Err(Invalid);
                    }
                    self.text(content.into_inner())?
                }
                Event::GeneralRef(reference) => {
                    check_reference(&reference)?;
                    if self.depth == 0 {
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
                    Canonical::Text(piece)
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
                    continue;
                }
                Event::DocType(_) => return Err(Invalid),
                Event::Comment(content) => Canonical::Comment(if RETAIN {
                    fallible_string(content.as_ref())?
                } else {
                    String::new()
                }),
                Event::PI(content) => Canonical::Instruction(if RETAIN {
                    fallible_string(content.as_ref())?
                } else {
                    String::new()
                }),
                Event::Eof if self.depth == 0 && self.roots == 1 => return Ok(None),
                Event::Eof => return Err(Invalid),
            };
            return Ok(Some(normalized));
        }
    }
}

fn fallible_string(value: &str) -> Result<String, Invalid> {
    let mut out = String::new();
    out.try_reserve_exact(value.len()).map_err(|_| {
        crate::document::resources::allocation_refused();
        Invalid
    })?;
    out.push_str(value);
    Ok(out)
}

// Keep the materialization/validation hot loop independent of the resumable
// comparison cursor. Both use the same decoder, namespace/attribute reader and
// entity checks; the frozen differential oracle covers their event semantics.
fn canonical_walk(
    bytes: &[u8],
    retain_content: bool,
    mut visit: impl FnMut(Canonical, usize) -> Result<(), Invalid>,
) -> Result<(), Invalid> {
    let text = decode(bytes)?;
    let mut reader = NsReader::from_str(&text);
    let mut atoms = Atoms::default();
    let validation_name = Atom(Arc::new(String::new()));
    let mut depth = 0usize;
    let mut roots = 0usize;
    let mut count = 0usize;
    let mut last_text = false;
    let mut emit = |event: Canonical, payload: usize| {
        let is_text = matches!(event, Canonical::Text(_));
        if !is_text || !last_text {
            count += 1;
        }
        last_text = is_text;
        if count > MAX_CANONICAL_EVENTS {
            return Err(Invalid);
        }
        visit(event, payload)
    };
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
                let mut element = element(&reader, start, depth)?;
                // 이름공간 선언은 접두사 선택이라 비교하지 않는다(요소·속성은 URI로 비교). 접두사를 값으로 쓰는 속성
                // (`mc:Ignorable` 등)은 값 그대로 비교하므로 접두사가 바뀌면 다르다고 본다.
                if retain_content {
                    element.attributes.retain(|(namespace, name, _)| {
                        namespace.as_deref() != Some(XMLNS)
                            && !(namespace.is_none() && name == "xmlns")
                    });
                    element.attributes.sort();
                    let namespace = element.namespace.map(|v| atoms.intern(v)).transpose()?;
                    let name = atoms.intern(element.name)?;
                    let mut attributes = Vec::new();
                    attributes
                        .try_reserve_exact(element.attributes.len())
                        .map_err(|_| {
                            crate::document::resources::allocation_refused();
                            Invalid
                        })?;
                    for (ns, key, value) in element.attributes {
                        attributes.push((
                            ns.map(|v| atoms.intern(v)).transpose()?,
                            atoms.intern(key)?,
                            atoms.intern(value)?,
                        ));
                    }
                    emit(
                        Canonical::Start {
                            namespace,
                            name,
                            attributes,
                        },
                        atoms.payload,
                    )?;
                } else {
                    // element() already validated every name/attribute/reference. Validation
                    // retains no spellings or text and never exposes these marker values.
                    emit(
                        Canonical::Start {
                            namespace: None,
                            name: validation_name.clone(),
                            attributes: Vec::new(),
                        },
                        0,
                    )?;
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                } else {
                    emit(Canonical::End, atoms.payload)?;
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or(Invalid)?;
                emit(Canonical::End, atoms.payload)?;
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
                emit(
                    Canonical::Text(if retain_content {
                        piece.to_owned()
                    } else {
                        String::new()
                    }),
                    atoms.payload,
                )?;
            }
            Event::CData(content) => {
                if depth == 0 {
                    return Err(Invalid);
                }
                let piece: &str = content.as_ref();
                emit(
                    Canonical::Text(if retain_content {
                        piece.to_owned()
                    } else {
                        String::new()
                    }),
                    atoms.payload,
                )?;
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
                emit(Canonical::Text(piece), atoms.payload)?;
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
                emit(
                    Canonical::Comment(if retain_content {
                        piece.to_owned()
                    } else {
                        String::new()
                    }),
                    atoms.payload,
                )?;
            }
            Event::PI(content) => {
                let piece: &str = content.as_ref();
                emit(
                    Canonical::Instruction(if retain_content {
                        piece.to_owned()
                    } else {
                        String::new()
                    }),
                    atoms.payload,
                )?;
            }
            Event::Eof if depth == 0 && roots == 1 => return Ok(()),
            Event::Eof => return Err(Invalid),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ComparisonFailure {
    OriginalInvalid,
    OutputInvalid,
    Resource,
}

/// Lockstep semantic equality. Text chunks may have different segmentation.
/// Always drain both parsers after a mismatch; original malformed takes precedence.
/// No hashes, retained event vectors or document-wide interning are used.
pub fn canonical_equal(before: &[u8], after: &[u8]) -> Result<bool, ComparisonFailure> {
    let before = decode(before).map_err(|_| ComparisonFailure::OriginalInvalid)?;
    let after = decode(after).map_err(|_| {
        if canonical_valid(before.as_bytes()).is_err() {
            ComparisonFailure::OriginalInvalid
        } else {
            ComparisonFailure::OutputInvalid
        }
    })?;
    let mut a = CanonicalCursor::<true, true>::new(&before);
    let mut b = CanonicalCursor::<true, true>::new(&after);
    let mut left = a.next();
    let mut right = b.next();
    let mut offsets = (0, 0);
    let mut equal = true;
    while let (Ok(Some(x)), Ok(Some(y))) = (&left, &right) {
        match (x, y) {
            (Canonical::Text(x), Canonical::Text(y)) => {
                let x = &x.as_bytes()[offsets.0..];
                let y = &y.as_bytes()[offsets.1..];
                let n = x.len().min(y.len());
                equal &= x[..n] == y[..n];
                offsets.0 += n;
                offsets.1 += n;
                if n == x.len() {
                    left = a.next();
                    offsets.0 = 0;
                }
                if n == y.len() {
                    right = b.next();
                    offsets.1 = 0;
                }
            }
            _ => {
                equal &= offsets == (0, 0) && x == y;
                left = a.next();
                right = b.next();
                offsets = (0, 0);
            }
        }
    }
    equal &= matches!((&left, &right), (Ok(None), Ok(None)));
    // Result errors are retained even when the other cursor failed first.
    let mut original_invalid = left.is_err();
    let mut output_invalid = right.is_err();
    if matches!(left, Ok(Some(_))) {
        loop {
            match a.next() {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {
                    original_invalid = true;
                    break;
                }
            }
        }
    }
    if matches!(right, Ok(Some(_))) {
        loop {
            match b.next() {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {
                    output_invalid = true;
                    break;
                }
            }
        }
    }
    if original_invalid {
        Err(ComparisonFailure::OriginalInvalid)
    } else if output_invalid {
        Err(ComparisonFailure::OutputInvalid)
    } else {
        Ok(equal)
    }
}

/// Bounded text pieces plus an explicit logical text boundary. Filtering a child
/// must not merge previously distinct text nodes (the legacy special rules do not).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Piece {
    Event(Canonical),
    TextEnd,
}

/// A checkpoint borrows decoded input and clones only open parser/namespace state,
/// a pending event and bounded text. An index of checkpoints is NOT constant space.
#[derive(Clone)]
pub(crate) struct SemanticCursor<'a> {
    raw: CanonicalCursor<'a, true, true>,
    pending: Option<Canonical>,
    lookahead: Option<Piece>,
    text: bool,
    pub head_lists: usize,
}

impl<'a> SemanticCursor<'a> {
    pub fn new(text: &'a str) -> Self {
        Self {
            raw: CanonicalCursor::new(text),
            pending: None,
            lookahead: None,
            text: false,
            head_lists: 0,
        }
    }
    /// Only between direct sibling subtrees in an already fully validated input.
    /// A shared parent anchor retains namespace/open-tag state once; the index
    /// retains borrowed slice positions, never one parser clone per definition.
    pub fn position(&self) -> Result<&'a [u8], Invalid> {
        if self.pending.is_some()
            || self.lookahead.is_some()
            || self.text
            || self.raw.pending_text.is_some()
            || self.raw.pending_end
        {
            return Err(Invalid);
        }
        Ok(*self.raw.reader.get_ref())
    }
    pub fn sibling_at(&self, position: &'a [u8]) -> Self {
        let mut cursor = self.clone();
        *cursor.raw.reader.get_mut() = position;
        cursor.raw.atoms = Atoms::default();
        cursor
    }
    pub fn peek(&mut self) -> Result<Option<&Piece>, Invalid> {
        if self.lookahead.is_none() {
            self.lookahead = self.read()?;
        }
        Ok(self.lookahead.as_ref())
    }
    pub fn next(&mut self) -> Result<Option<Piece>, Invalid> {
        if self.lookahead.is_some() {
            return Ok(self.lookahead.take());
        }
        self.read()
    }
    fn read(&mut self) -> Result<Option<Piece>, Invalid> {
        let event = match self.pending.take() {
            Some(event) => Some(event),
            None => self.raw.next()?,
        };
        if matches!(event, Some(Canonical::Text(_))) {
            self.text = true;
        } else if self.text {
            self.text = false;
            self.pending = event;
            return Ok(Some(Piece::TextEnd));
        }
        if matches!(&event, Some(Canonical::Start {namespace, name, ..})
            if namespace.as_deref() == Some("http://www.hancom.co.kr/hwpml/2011/head") && name == "charProperties")
        {
            self.head_lists += 1;
        }
        Ok(event.map(Piece::Event))
    }
}

/// Compare transformed semantic pieces, independently of raw Text/CDATA/reference
/// segmentation. TextEnd prevents filters from erasing logical text boundaries.
pub(crate) fn pieces_equal(
    mut left: impl FnMut() -> Result<Option<Piece>, Invalid>,
    mut right: impl FnMut() -> Result<Option<Piece>, Invalid>,
) -> Result<bool, Invalid> {
    let (mut a, mut b) = (left()?, right()?);
    let (mut x, mut y) = (0, 0);
    loop {
        match (&a, &b) {
            (Some(Piece::Event(Canonical::Text(av))), Some(Piece::Event(Canonical::Text(bv)))) => {
                let n = (av.len() - x).min(bv.len() - y);
                if av.as_bytes()[x..x + n] != bv.as_bytes()[y..y + n] {
                    return Ok(false);
                }
                x += n;
                y += n;
                let (advance_a, advance_b) = (x == av.len(), y == bv.len());
                if advance_a {
                    a = left()?;
                    x = 0;
                }
                if advance_b {
                    b = right()?;
                    y = 0;
                }
            }
            (None, None) => return Ok(true),
            _ if x == 0 && y == 0 && a == b => {
                a = left()?;
                b = right()?;
            }
            _ => return Ok(false),
        }
    }
}

/// Same special-rule context as canonical-vector comparison: only text under the
/// immediate matching element is ignored, and a Text event must exist on BOTH sides.
/// The first pass fully validates both tails with original-error precedence.
pub(crate) fn canonical_equal_except_text(
    before: &[u8],
    after: &[u8],
    ignore: impl Fn(Option<&str>, &str) -> bool,
) -> Result<bool, ComparisonFailure> {
    let original = canonical_checked(before);
    let output = canonical_checked(after);
    match (original, output) {
        (Err(CanonicalFailure::Invalid), _) => return Err(ComparisonFailure::OriginalInvalid),
        (Err(_), _) => return Err(ComparisonFailure::Resource),
        (_, Err(CanonicalFailure::Invalid)) => return Err(ComparisonFailure::OutputInvalid),
        (_, Err(_)) => return Err(ComparisonFailure::Resource),
        _ => {}
    }
    let before = decode(before).map_err(|_| ComparisonFailure::OriginalInvalid)?;
    let after = decode(after).map_err(|_| ComparisonFailure::OutputInvalid)?;
    let mut a = SemanticCursor::new(&before);
    let mut b = SemanticCursor::new(&after);
    // Filter replaces each logical statistic text with an empty Text, preserving
    // its existence and boundary. Nested unrelated elements get their own context.
    fn filtered(
        c: &mut SemanticCursor<'_>,
        stack: &mut Vec<bool>,
        ignore: &impl Fn(Option<&str>, &str) -> bool,
    ) -> Result<Option<Piece>, Invalid> {
        let event = c.next()?;
        match &event {
            Some(Piece::Event(Canonical::Start {
                namespace, name, ..
            })) => {
                stack.try_reserve(1).map_err(|_| {
                    crate::document::resources::allocation_refused();
                    Invalid
                })?;
                stack.push(ignore(namespace.as_deref(), name.as_str()));
            }
            Some(Piece::Event(Canonical::End)) => {
                stack.pop();
            }
            Some(Piece::Event(Canonical::Text(_))) if stack.last() == Some(&true) => {
                while matches!(c.peek()?, Some(Piece::Event(Canonical::Text(_)))) {
                    c.next()?;
                }
                return Ok(Some(Piece::Event(Canonical::Text(String::new()))));
            }
            _ => {}
        }
        Ok(event)
    }
    let (mut sa, mut sb) = (Vec::new(), Vec::new());
    pieces_equal(
        || filtered(&mut a, &mut sa, &ignore),
        || filtered(&mut b, &mut sb, &ignore),
    )
    .map_err(|_| ComparisonFailure::OutputInvalid)
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
#[cfg(test)]
pub fn element_starts(bytes: &[u8]) -> Result<Vec<ElementStart>, Invalid> {
    let mut out = Vec::new();
    visit_element_starts(bytes, |element| {
        out.try_reserve(1).map_err(|_| {
            crate::document::resources::allocation_refused();
            Invalid
        })?;
        out.push(element);
        Ok(())
    })?;
    Ok(out)
}

/// Visits all starts in order with identical ancestor indices; only the open ancestor stack is retained.
pub fn visit_element_starts(
    bytes: &[u8],
    mut visit: impl FnMut(ElementStart) -> Result<(), Invalid>,
) -> Result<(), Invalid> {
    let text = decode(bytes)?;
    let mut reader = NsReader::from_str(&text);
    let mut stack: Vec<(Option<String>, String, usize)> = Vec::new();
    let mut count = 0usize;
    loop {
        if count > MAX_CANONICAL_EVENTS {
            return Err(Invalid);
        }
        let event = reader.read_event().map_err(|_| Invalid)?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start) => {
                let element = element(&reader, start, stack.len())?;
                let self_closing = matches!(event, Event::Empty(_));
                let index = count;
                count += 1;
                visit(ElementStart {
                    namespace: element.namespace.clone(),
                    name: element.name.clone(),
                    attributes: element.attributes,
                    self_closing,
                    parent: stack
                        .last()
                        .map(|(namespace, name, _)| (namespace.clone(), name.clone())),
                    parent_index: stack.last().map(|(_, _, at)| *at),
                })?;
                if !self_closing {
                    stack.push((element.namespace, element.name, index));
                }
            }
            Event::End(_) => {
                stack.pop().ok_or(Invalid)?;
            }
            Event::DocType(_) => return Err(Invalid),
            Event::Eof if stack.is_empty() => return Ok(()),
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

#[cfg(test)]
#[path = "xml_legacy_test.rs"]
mod legacy_test;

#[cfg(test)]
mod resource_tests {
    use super::*;
    fn differential(bytes: &[u8]) {
        let old = legacy_test::canonical_legacy(bytes);
        let new = canonical(bytes);
        assert_eq!(
            old.is_ok(),
            new.is_ok(),
            "{:?}",
            String::from_utf8_lossy(bytes)
        );
        assert_eq!(canonical_valid(bytes).is_ok(), old.is_ok());
        if let (Ok(old), Ok(new)) = (old, new) {
            assert_eq!(format!("{old:?}"), format!("{new:?}"));
        }
    }
    #[test]
    fn legacy_equivalence_corpus() {
        for xml in [
            "<r/>",
            "<r></r>",
            "<r>a<![CDATA[b]]>&amp;&#99;d</r>",
            "<?xml version=\"1.0\"?><r xmlns:p=\"urn:p\" p:x=\" a&#10;b \" z=\"2\"/>",
            "<!--before--><r><?pi x?>text<!--middle-->tail</r><!--after-->",
            "<r xmlns=\"u\"><a xmlns=\"\"/><a xmlns=\"v\"/></r>",
            "<!DOCTYPE r><r/>",
            "<r>&unknown;</r>",
            "<p:r/>",
            "<r><x></r>",
            "<r/><s/>",
            "<r/>tail",
            "<r a=\"1\" a=\"2\"/>",
            "<r xmlns:p=\"u\" p:a=\"x\"><p:a/></r>",
        ] {
            differential(xml.as_bytes());
            for little in [true, false] {
                let mut bytes = if little {
                    vec![255, 254]
                } else {
                    vec![254, 255]
                };
                for word in xml.encode_utf16() {
                    bytes.extend(if little {
                        word.to_le_bytes()
                    } else {
                        word.to_be_bytes()
                    });
                }
                differential(&bytes);
            }
        }
        for size in [1, 30, 1024] {
            let dense = format!(
                "<r>{}</r>",
                "<a xmlns:p=\"urn:repeated\" p:x=\"same\"/><!--c-->".repeat(size)
            );
            differential(dense.as_bytes());
            differential(format!("{dense}<bad").as_bytes());
            differential(format!("<r>{}</r>", "a&amp;<![CDATA[b]]>".repeat(size)).as_bytes());
            differential(format!("{}x{}", "<a>".repeat(size), "</a>".repeat(size)).as_bytes());
            let attributes = (0..size)
                .map(|n| format!(" a{n}=\"v{n}\""))
                .collect::<String>();
            differential(format!("<r{attributes}/>").as_bytes());
        }
        differential(&[255, 254, 0]);
        differential(&[255, 254, 0, 216]);
        differential(&[b'<', b'r', b'>', 255]);
    }
    #[test]
    fn semantic_equalities_and_malformed_tail() {
        for (a, b) in [
            ("<r/>", "<r></r>"),
            ("<r>a&amp;b</r>", "<r><![CDATA[a&b]]></r>"),
            (
                "<p:r xmlns:p=\"u\" a=\"1\" b=\"2\"/>",
                "<q:r xmlns:q=\"u\" b=\"2\" a=\"1\"></q:r>",
            ),
        ] {
            assert_eq!(canonical(a.as_bytes()), canonical(b.as_bytes()));
        }
        assert_ne!(canonical(b"<r> </r>"), canonical(b"<r/>"));
        assert!(canonical_valid(b"<r/><bad").is_err());
    }
    #[test]
    fn streaming_comparison_matches_frozen_oracle_and_validates_both_tails() {
        let corpus = [
            "<r/>",
            "<r></r>",
            "<r><![CDATA[]]></r>",
            "<r>a</r>",
            "<r>a<![CDATA[]]></r>",
            "<r><![CDATA[]]>a</r>",
            "<r>a&amp;b&#99;</r>",
            "<r><![CDATA[a&bc]]></r>",
            "<p:r xmlns:p=\"u\" a=\"1\" b=\"2\"/>",
            "<q:r xmlns:q=\"u\" b=\"2\" a=\"1\"></q:r>",
            "<r xmlns:p=\"u\" a=\"p:x\"/>",
            "<r xmlns:q=\"u\" a=\"q:x\"/>",
            "<!--c--><r><?p i?> </r>",
            "<!--c--><r><?p i?>  </r>",
            "<r>different</r><bad",
            "<r/><s/>",
            "<r>&bad;</r>",
            "<p:r/>",
            "<!DOCTYPE r><r/>",
            "<r a=\"1\" a=\"2\"/>",
        ];
        for a in corpus {
            for b in corpus {
                let old_a = legacy_test::canonical_legacy(a.as_bytes());
                let old_b = legacy_test::canonical_legacy(b.as_bytes());
                let expected = match (old_a, old_b) {
                    (Err(_), _) => Err(ComparisonFailure::OriginalInvalid),
                    (_, Err(_)) => Err(ComparisonFailure::OutputInvalid),
                    (Ok(a), Ok(b)) => Ok(a == b),
                };
                assert_eq!(
                    canonical_equal(a.as_bytes(), b.as_bytes()),
                    expected,
                    "{a} vs {b}"
                );
                let utf16: Vec<u8> = [255, 254]
                    .into_iter()
                    .chain(b.encode_utf16().flat_map(u16::to_le_bytes))
                    .collect();
                assert_eq!(
                    canonical_equal(a.as_bytes(), &utf16),
                    expected,
                    "utf16 {a} vs {b}"
                );
            }
        }
        assert_eq!(
            canonical_equal(b"<r><bad", &[255]),
            Err(ComparisonFailure::OriginalInvalid)
        );
        for n in [1, TEXT_CHUNK - 1, TEXT_CHUNK, TEXT_CHUNK + 1, 1024 * 1024] {
            let text = "가&".repeat(n);
            let a = format!("<r><![CDATA[{text}]]></r>");
            let b = format!("<r>{}</r>", "가&amp;".repeat(n));
            assert_eq!(canonical_equal(a.as_bytes(), b.as_bytes()), Ok(true));
            assert_eq!(
                canonical_equal(a.as_bytes(), format!("{b}<bad").as_bytes()),
                Err(ComparisonFailure::OutputInvalid)
            );
        }
        let many = format!("<r>{}</r>", "<a x=\"same\"/>".repeat(100_000));
        assert_eq!(canonical_equal(many.as_bytes(), many.as_bytes()), Ok(true));
        let deep = format!("{}x{}", "<a>".repeat(4096), "</a>".repeat(4096));
        assert_eq!(canonical_equal(deep.as_bytes(), deep.as_bytes()), Ok(true));
        let text = format!("<r>{}</r>", "x".repeat(TEXT_CHUNK * 4));
        let mut cursor = CanonicalCursor::<true, true>::new(&text);
        while let Some(event) = cursor.next().unwrap() {
            if let Canonical::Text(s) = event {
                assert!(s.capacity() <= TEXT_CHUNK);
            }
            // No document-wide atom pool; max spellings for this fixture is one.
            assert!(cursor.atoms.values.len() <= 1);
        }
    }

    #[test]
    fn payload_policy_is_explicit_local_and_not_a_product_limit() {
        let bytes = format!("<r>{}</r>", "<a x=\"repeated\"/>".repeat(2048));
        let (events, memory) = canonical_with_payload_limit(bytes.as_bytes(), None).unwrap();
        assert_eq!(memory.events, events.len());
        assert!(memory.retained_payload_bytes > 0);
        assert_eq!(
            canonical_with_payload_limit(bytes.as_bytes(), Some(1)).unwrap_err(),
            CanonicalFailure::PayloadLimit
        );
        assert!(canonical_with_payload_limit(
            bytes.as_bytes(),
            Some(memory.retained_payload_bytes)
        )
        .is_ok());
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| assert_eq!(canonical(bytes.as_bytes()).unwrap(), events));
            }
        });
        assert!(matches!(decode(b"<r/>"), Ok(Cow::Borrowed(_))));
    }
    #[test]
    #[ignore = "isolated text-boundary probe; GEUL_XML_MIB and GEUL_XML_MODE=legacy/new/validate"]
    fn canonical_large_text_probe() {
        let mib: usize = std::env::var("GEUL_XML_MIB").unwrap().parse().unwrap();
        let mode = std::env::var("GEUL_XML_MODE").unwrap();
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(mib * 1024 * 1024).unwrap();
        bytes.extend_from_slice(b"<r>");
        bytes.resize(mib * 1024 * 1024 - 4, b'x');
        bytes.extend_from_slice(b"</r>");
        let started = std::time::Instant::now();
        let payload = match mode.as_str() {
            "legacy" => {
                let events = legacy_test::canonical_legacy(&bytes).unwrap();
                assert_eq!(events.len(), 3);
                None
            }
            "new" => {
                let (events, m) = canonical_with_payload_limit(&bytes, None).unwrap();
                assert_eq!(events.len(), 3);
                Some(m.retained_payload_bytes)
            }
            "stream" => {
                assert_eq!(canonical_equal(&bytes, &bytes), Ok(true));
                Some(2 * TEXT_CHUNK)
            }
            "pair" => {
                let a = canonical(&bytes).unwrap();
                let b = canonical(&bytes).unwrap();
                assert_eq!(a, b);
                None
            }
            "validate" => {
                canonical_valid(&bytes).unwrap();
                Some(0usize)
            }
            _ => panic!("unknown mode"),
        };
        let status = std::fs::read_to_string("/proc/self/status").ok();
        let hwm = status
            .as_ref()
            .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM:")))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0);
        println!(
            "{}",
            serde_json::json!({"mode":mode,"inputBytes":bytes.len(),"ms":started.elapsed().as_secs_f64()*1000.0,"processHighWaterKiB":hwm,"retainedEventPayloadBytes":payload,"scope":"isolated process HWM; excludes source/input from retained event payload; legacy payload unmeasured"})
        );
    }
    #[test]
    #[ignore = "explicit independent HWPX/DOCX corpus; GEUL_XML_CORPUS path list"]
    fn real_package_differential_corpus() {
        use crate::services::save::package;
        let paths = std::env::var_os("GEUL_XML_CORPUS").unwrap();
        let mut parts = 0usize;
        let mut corpus = Vec::new();
        let mut invalid = 0usize;
        let mut bytes = 0usize;
        for path in std::env::split_paths(&paths) {
            let input = std::fs::read(path).unwrap();
            let package = package::open(&input, package::Side::Original).unwrap();
            for (name, (_, data)) in package.parts {
                if !package::is_xml(&name, &data) {
                    continue;
                }
                let old = legacy_test::canonical_legacy(&data);
                let new = canonical(&data);
                assert_eq!(old.is_ok(), new.is_ok(), "{name}");
                assert_eq!(canonical_valid(&data).is_ok(), old.is_ok(), "{name}");
                assert_eq!(canonical_equal(&data, &data), Ok(true), "{name}");
                if let (Ok(old), Ok(new)) = (old, new) {
                    assert_eq!(format!("{old:?}"), format!("{new:?}"), "{name}");
                } else {
                    invalid += 1;
                }
                parts += 1;
                bytes += data.len();
                corpus.push(data);
            }
        }
        assert!(parts > 0);
        let mut legacy_ms = Vec::new();
        let mut current_ms = Vec::new();
        for trial in 0..7 {
            let legacy = || {
                let started = std::time::Instant::now();
                for data in &corpus {
                    drop(std::hint::black_box(
                        legacy_test::canonical_legacy(data).unwrap(),
                    ));
                }
                started.elapsed().as_secs_f64() * 1000.0
            };
            let current = || {
                let started = std::time::Instant::now();
                for data in &corpus {
                    drop(std::hint::black_box(canonical(data).unwrap()));
                }
                started.elapsed().as_secs_f64() * 1000.0
            };
            if trial % 2 == 0 {
                legacy_ms.push(legacy());
                current_ms.push(current());
            } else {
                current_ms.push(current());
                legacy_ms.push(legacy());
            }
        }
        println!(
            "{}",
            serde_json::json!({"parts":parts,"invalidBoth":invalid,"xmlBytes":bytes,"comparison":"full normalized event values, no hash-only equality","legacyCorpusMs":legacy_ms,"currentCorpusMs":current_ms,"cpuScope":"seven counterbalanced materialization+drop passes over expanded XML corpus; excludes ZIP/service/engine/native work"})
        );
    }
    #[test]
    #[ignore = "explicit high-event comparison; GEUL_XML_EVENTS and GEUL_XML_MODE=pair/stream"]
    fn canonical_comparison_event_probe() {
        let n: usize = std::env::var("GEUL_XML_EVENTS").unwrap().parse().unwrap();
        let mode = std::env::var("GEUL_XML_MODE").unwrap();
        let bytes = format!("<r>{}</r>", "<a x=\"same\"/>".repeat(n));
        let started = std::time::Instant::now();
        if mode == "stream" {
            assert_eq!(
                canonical_equal(bytes.as_bytes(), bytes.as_bytes()),
                Ok(true)
            );
        } else {
            assert_eq!(mode, "pair");
            let a = canonical(bytes.as_bytes()).unwrap();
            let b = canonical(bytes.as_bytes()).unwrap();
            assert_eq!(a, b);
        }
        let status = std::fs::read_to_string("/proc/self/status").unwrap();
        let hwm = status
            .lines()
            .find(|l| l.starts_with("VmHWM:"))
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        println!(
            "{}",
            serde_json::json!({"mode": mode, "events":n*2+2, "inputBytes": bytes.len(), "ms":started.elapsed().as_secs_f64()*1000., "processHighWaterKiB":hwm})
        );
    }

    #[test]
    #[ignore = "isolated XML accounting probe; GEUL_XML_EVENTS=n"]
    fn canonical_accounting_probe() {
        let n: usize = std::env::var("GEUL_XML_EVENTS").unwrap().parse().unwrap();
        let bytes = format!(
            "<r xmlns:p=\"urn:repeated\">{}</r>",
            "<p:a x=\"same\" y=\"same\"/>".repeat(n)
        );
        let started = std::time::Instant::now();
        let (_, m) = canonical_with_payload_limit(bytes.as_bytes(), None).unwrap();
        println!(
            "{}",
            serde_json::json!({"inputBytes":bytes.len(),"events":m.events,"retainedPayloadBytes":m.retained_payload_bytes,"ms":started.elapsed().as_secs_f64()*1000.0,"scope":"requested retained event/attribute/string payload, excludes allocator/Arc/hash metadata, parser/decoded temporaries and packages"})
        );
    }
}
