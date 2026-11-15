//! Header append rule using borrowed-input checkpoints, never whole canonical trees.
use super::package::*;
use crate::document::xml::{self, Canonical, Invalid, Piece, SemanticCursor};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

struct Definition<'a> {
    cursor: SemanticCursor<'a>,
    depth: usize,
    started: bool,
    seen: [bool; 4],
    /// `hh:ratio`·`hh:spacing`를 이미 봤는지(T012, 하나씩만).
    metrics: [bool; 2],
    policy: FormatPolicy,
    font_counts: Option<[usize; 7]>,
    font_ref_seen: bool,
}
impl<'a> Definition<'a> {
    fn new(
        cursor: SemanticCursor<'a>,
        policy: FormatPolicy,
        font_counts: Option<[usize; 7]>,
    ) -> Self {
        Self {
            cursor,
            depth: 0,
            started: false,
            seen: [false; 4],
            metrics: [false; 2],
            policy,
            font_counts,
            font_ref_seen: false,
        }
    }
    fn next(&mut self) -> Result<Option<Piece>, Invalid> {
        if self.started && self.depth == 0 {
            return Ok(None);
        }
        loop {
            let mut piece = self.cursor.next()?.ok_or(Invalid)?;
            if !self.started {
                let Piece::Event(Canonical::Start { attributes, .. }) = &mut piece else {
                    return Err(Invalid);
                };
                attributes.retain(|(ns, key, _)| !(ns.is_none() && key == "id"));
                self.started = true;
                self.depth = 1;
                return Ok(Some(piece));
            }
            if self.depth == 1 {
                if let Piece::Event(event) = &piece {
                    if let Some(slot) = HWPX_FORMAT_CHILDREN
                        .iter()
                        .position(|name| is_head(event, name))
                    {
                        if matches!(self.cursor.peek()?, Some(Piece::Event(Canonical::End))) {
                            let Canonical::Start { attributes, .. } = event else {
                                return Err(Invalid);
                            };
                            if self.seen[slot]
                                || (self.policy == FormatPolicy::Appended
                                    && !serializer_format_child(
                                        HWPX_FORMAT_CHILDREN[slot],
                                        attributes,
                                    ))
                            {
                                return Err(Invalid);
                            }
                            self.seen[slot] = true;
                            self.cursor.next()?;
                            continue;
                        }
                    }
                    // Font changes are authorized only against the separately validated
                    // language-specific header tables. Preserve element position and all
                    // surrounding XML; no generic child/attribute exemption.
                    if self.font_counts.is_some() && is_head(event, "fontRef") {
                        if self.font_ref_seen
                            || !matches!(self.cursor.peek()?, Some(Piece::Event(Canonical::End)))
                        {
                            return Err(Invalid);
                        }
                        let Piece::Event(Canonical::Start { attributes, .. }) = &mut piece else {
                            return Err(Invalid);
                        };
                        if !valid_font_ref(attributes, self.font_counts.unwrap()) {
                            return Err(Invalid);
                        }
                        self.font_ref_seen = true;
                        attributes.clear();
                        self.depth += 1;
                        return Ok(Some(piece));
                    }
                    // T012 장평·자간: 내용 없는 `hh:ratio`·`hh:spacing`은 자리(요소)는 그대로 비교하고 값(속성)만 뺀다. 덧붙인
                    // 정의의 값은 직렬화기 모양(7개 언어 속성 정확히, 정수, 앱이 쓰는 범위)이어야 한다.
                    if let Some(slot) = HWPX_METRIC_CHILDREN
                        .iter()
                        .position(|name| is_head(event, name))
                    {
                        if matches!(self.cursor.peek()?, Some(Piece::Event(Canonical::End))) {
                            if self.metrics[slot] {
                                return Err(Invalid);
                            }
                            self.metrics[slot] = true;
                            let Piece::Event(Canonical::Start { attributes, .. }) = &mut piece
                            else {
                                return Err(Invalid);
                            };
                            if self.policy == FormatPolicy::Appended
                                && !serializer_metric_child(HWPX_METRIC_CHILDREN[slot], attributes)
                            {
                                return Err(Invalid);
                            }
                            attributes.clear();
                            self.depth += 1;
                            return Ok(Some(piece));
                        }
                    }
                }
            }
            match &piece {
                Piece::Event(Canonical::Start { .. }) => self.depth += 1,
                Piece::Event(Canonical::End) => {
                    self.depth = self.depth.checked_sub(1).ok_or(Invalid)?
                }
                _ => {}
            }
            return Ok(Some(piece));
        }
    }
}
fn fingerprint(
    cursor: SemanticCursor<'_>,
    policy: FormatPolicy,
    fonts: Option<[usize; 7]>,
) -> Option<u64> {
    let mut definition = Definition::new(cursor, policy, fonts);
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let mut text = false;
    while let Some(piece) = definition.next().ok()? {
        match piece {
            Piece::Event(Canonical::Text(value)) => {
                if !text {
                    0u8.hash(&mut hash);
                    text = true;
                }
                // Byte writes make hashing independent of text/CDATA/reference segmentation.
                for byte in value.bytes() {
                    byte.hash(&mut hash);
                }
            }
            Piece::TextEnd => {
                1u8.hash(&mut hash);
                text = false;
            }
            Piece::Event(event) => {
                2u8.hash(&mut hash);
                event.hash(&mut hash);
            }
        }
    }
    #[cfg(test)]
    if COLLIDING.with(|flag| flag.get()) {
        return Some(0);
    }
    Some(hash.finish())
}
fn subtree_next(
    cursor: &mut SemanticCursor<'_>,
    depth: &mut usize,
    done: &mut bool,
) -> Result<Option<Piece>, Invalid> {
    if *done {
        return Ok(None);
    }
    let piece = cursor.next()?.ok_or(Invalid)?;
    match piece {
        Piece::Event(Canonical::Start { .. }) => *depth += 1,
        Piece::Event(Canonical::End) => {
            *depth = depth.checked_sub(1).ok_or(Invalid)?;
            *done = *depth == 0;
        }
        _ => {}
    }
    Ok(Some(piece))
}
fn definition_equal(
    a: &mut SemanticCursor<'_>,
    b: &mut SemanticCursor<'_>,
) -> Result<bool, Invalid> {
    let (mut ad, mut bd, mut ae, mut be) = (0, 0, false, false);
    xml::pieces_equal(
        || subtree_next(a, &mut ad, &mut ae),
        || subtree_next(b, &mut bd, &mut be),
    )
}
fn skip_definition(cursor: &mut SemanticCursor<'_>) -> Result<(), Invalid> {
    let (mut depth, mut done) = (0, false);
    while subtree_next(cursor, &mut depth, &mut done)?.is_some() {}
    Ok(())
}
fn id(cursor: &mut SemanticCursor<'_>) -> Result<u32, Invalid> {
    let Some(Piece::Event(event)) = cursor.peek()? else {
        return Err(Invalid);
    };
    if !is_head(event, "charPr") {
        return Err(Invalid);
    }
    plain_attribute(event, "id")
        .and_then(hwpx_id)
        .ok_or(Invalid)
}
/// First pass canonical_valid already validated BOTH tails with original precedence.
/// O(definition positions + shared open parser/namespace context + current event).
/// UTF-16 decode, current attributes/comments and body reference ids are additional.
/// Checkpoints for lookup are temporary; hash matches ALWAYS get full comparison.
pub(super) fn header_equal_or_appended(before: &[u8], after: &[u8], output: &Package) -> bool {
    fn check(before: &[u8], after: &[u8], output: &Package) -> Result<bool, Invalid> {
        let (before, after) = (xml::decode(before)?, xml::decode(after)?);
        let font_proof = font_tables_preserved(&before, &after);
        let old_fonts = font_proof.map(|p| p.0);
        let new_fonts = font_proof.map(|p| p.1);
        let (mut a, mut b) = (SemanticCursor::new(&before), SemanticCursor::new(&after));
        fn prefix(c: &mut SemanticCursor<'_>, fonts: bool) -> Result<Option<Piece>, Invalid> {
            if fonts
                && matches!(c.peek()?, Some(Piece::Event(event)) if is_head(event, "fontfaces"))
            {
                let marker = c.peek()?.cloned();
                skip_definition(c)?;
                return Ok(marker);
            }
            if matches!(c.peek()?, Some(Piece::Event(event)) if is_head(event, HWPX_SHAPE_LISTS[0]))
            {
                return Ok(None);
            }
            c.next()
        }
        if !xml::pieces_equal(
            || prefix(&mut a, font_proof.is_some()),
            || prefix(&mut b, font_proof.is_some()),
        )? {
            return Ok(false);
        }
        let (left, right) = (a.next()?, b.next()?);
        if left.is_none() && right.is_none() {
            return Ok(font_proof.is_none_or(|p| p.0 == p.1));
        }
        let (Some(Piece::Event(mut left)), Some(Piece::Event(mut right))) = (left, right) else {
            return Ok(false);
        };
        // Ordinary equality does not impose the append-only id/list restrictions.
        if left == right {
            return Ok(font_proof.is_none_or(|p| p.0 == p.1)
                && xml::pieces_equal(|| a.next(), || b.next())?);
        }
        if !is_head(&left, HWPX_SHAPE_LISTS[0]) || !is_head(&right, HWPX_SHAPE_LISTS[0]) {
            return Ok(false);
        }
        let count = |event: &Canonical| plain_attribute(event, "itemCnt").and_then(hwpx_id);
        let (Some(n), Some(total)) = (count(&left), count(&right)) else {
            return Ok(false);
        };
        if total <= n || total - 1 > HWPX_MAX_RESOURCE_ID {
            return Ok(false);
        }
        for event in [&mut left, &mut right] {
            if let Canonical::Start { attributes, .. } = event {
                attributes.retain(|(ns, key, _)| !(ns.is_none() && key == "itemCnt"));
            }
        }
        if left != right {
            return Ok(false);
        }
        crate::document::resources::charge(
            crate::document::resources::Category::Index,
            (n as usize)
                .checked_mul(
                    std::mem::size_of::<(u64, Vec<&[u8]>)>() + std::mem::size_of::<&[u8]>(),
                )
                .ok_or(Invalid)?,
        )
        .map_err(|_| Invalid)?;
        let anchor = a.clone();
        let mut bases: HashMap<u64, Vec<&[u8]>> = HashMap::new();
        bases.try_reserve(n as usize).map_err(|_| {
            crate::document::resources::allocation_refused();
            Invalid
        })?;
        let excess = bases
            .capacity()
            .checked_sub(n as usize)
            .and_then(|slots| slots.checked_mul(std::mem::size_of::<(u64, Vec<&[u8]>)>()))
            .ok_or(Invalid)?;
        crate::document::resources::charge(crate::document::resources::Category::Index, excess)
            .map_err(|_| Invalid)?;

        for expected in 0..n {
            let position = a.position()?;
            let checkpoint = anchor.sibling_at(position);
            if id(&mut a)? != expected
                || id(&mut b)? != expected
                || !definition_equal(&mut a, &mut b)?
            {
                return Ok(false);
            }
            if let Some(hash) = fingerprint(checkpoint.clone(), FormatPolicy::Original, old_fonts) {
                let bucket = bases.entry(hash).or_default();
                bucket.try_reserve_exact(1).map_err(|_| {
                    crate::document::resources::allocation_refused();
                    Invalid
                })?;
                bucket.push(position);
            }
        }
        if a.next()? != Some(Piece::Event(Canonical::End)) {
            return Ok(false);
        }
        let used = hwpx_char_shape_uses(output).ok_or(Invalid)?;
        for expected in n..total {
            let checkpoint = b.clone();
            if id(&mut b)? != expected || !used.contains(&expected) {
                return Ok(false);
            }
            let Some(hash) = fingerprint(checkpoint.clone(), FormatPolicy::Appended, new_fonts)
            else {
                return Ok(false);
            };
            let mut matched = false;
            if let Some(bucket) = bases.get(&hash) {
                for base in bucket {
                    let mut old =
                        Definition::new(anchor.sibling_at(base), FormatPolicy::Original, old_fonts);
                    let mut new =
                        Definition::new(checkpoint.clone(), FormatPolicy::Appended, new_fonts);
                    if xml::pieces_equal(|| old.next(), || new.next())? {
                        matched = true;
                        break;
                    }
                }
            }
            if !matched {
                return Ok(false);
            }
            skip_definition(&mut b)?;
        }
        if b.next()? != Some(Piece::Event(Canonical::End)) {
            return Ok(false);
        }
        let same = xml::pieces_equal(|| a.next(), || b.next())?;
        Ok(same
            && a.head_lists == 1
            && b.head_lists == 1
            && font_proof
                .is_none_or(|(old, new)| appended_fonts_referenced(&after, old, new, n, &used)))
    }
    check(before, after, output).unwrap_or(false)
}

#[cfg(test)]
thread_local! { static COLLIDING: std::cell::Cell<bool> = const {std::cell::Cell::new(false)}; }
#[cfg(test)]
pub(super) fn with_colliding_hashes<T>(run: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            COLLIDING.with(|flag| flag.set(self.0));
        }
    }
    let _restore = Restore(COLLIDING.with(|flag| flag.replace(true)));
    run()
}

const FONT_LANGUAGES: [&str; 7] = [
    "HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER",
];
const FONT_ATTRIBUTES: [&str; 7] = [
    "hangul", "latin", "hanja", "japanese", "other", "symbol", "user",
];

fn valid_font_ref(
    attributes: &[(Option<xml::Atom>, xml::Atom, xml::Atom)],
    counts: [usize; 7],
) -> bool {
    attributes.len() == 7
        && FONT_ATTRIBUTES.iter().enumerate().all(|(lang, key)| {
            let mut found = attributes
                .iter()
                .filter(|(ns, name, _)| ns.is_none() && name == key);
            matches!((found.next(), found.next()), (Some((_, _, value)), None)
            if hwpx_id(value).is_some_and(|id| id <= 65_535 && (id as usize) < counts[lang]))
        })
}

/// Validate actual font ordinals and counts rather than relying on a parser's
/// repaired IR. Original prefix comparison still preserves every font subtree.
fn existing_font_counts(header: &str) -> Option<[usize; 7]> {
    let mut cursor = SemanticCursor::new(header);
    let mut depth = 0usize;
    let mut found = None;
    while let Some(piece) = cursor.next().ok()? {
        match piece {
            Piece::Event(ref event) if is_head(event, "fontfaces") => {
                if depth != 2
                    || found.is_some()
                    || plain_attribute(event, "itemCnt").and_then(hwpx_id) != Some(7)
                {
                    return None;
                }
                let mut counts = [0usize; 7];
                for (lang, count) in counts.iter_mut().enumerate() {
                    let Some(Piece::Event(event)) = cursor.next().ok()? else {
                        return None;
                    };
                    if !is_head(&event, "fontface")
                        || plain_attribute(&event, "lang") != Some(FONT_LANGUAGES[lang])
                    {
                        return None;
                    }
                    *count = plain_attribute(&event, "fontCnt").and_then(hwpx_id)? as usize;
                    if *count == 0 || *count > 65_536 {
                        return None;
                    }
                    for id in 0..*count {
                        let Some(Piece::Event(event)) = cursor.peek().ok()? else {
                            return None;
                        };
                        if !is_head(event, "font")
                            || plain_attribute(event, "id").and_then(hwpx_id) != Some(id as u32)
                            || !plain_attribute(event, "face").is_some_and(|name| {
                                !name.is_empty()
                                    && name.len() <= 4096
                                    && !name.chars().any(char::is_control)
                            })
                        {
                            return None;
                        }
                        skip_definition(&mut cursor).ok()?;
                    }
                    if cursor.next().ok()? != Some(Piece::Event(Canonical::End)) {
                        return None;
                    }
                }
                if counts.iter().sum::<usize>() > 100_000
                    || cursor.next().ok()? != Some(Piece::Event(Canonical::End))
                {
                    return None;
                }
                found = Some(counts);
            }
            Piece::Event(Canonical::Start { .. }) => depth += 1,
            Piece::Event(Canonical::End) => depth = depth.checked_sub(1)?,
            _ => {}
        }
    }
    found
}

fn font_cursor<'a>(header: &'a str) -> Option<SemanticCursor<'a>> {
    let mut c = SemanticCursor::new(header);
    while let Some(piece) = c.peek().ok()? {
        if matches!(piece, Piece::Event(event) if is_head(event, "fontfaces")) {
            return Some(c);
        }
        c.next().ok()?;
    }
    None
}

/// Compare each original XML font subtree in its language slot. Counts and IDs
/// describe actual list items, never total-count-only evidence. New definitions
/// are the engine's plain nonembedded TTF named-face form, with no opaque fields.
fn font_tables_preserved(before: &str, after: &str) -> Option<([usize; 7], [usize; 7])> {
    let old = existing_font_counts(before)?;
    let new = existing_font_counts(after)?;
    let (mut a, mut b) = (font_cursor(before)?, font_cursor(after)?);
    if a.next().ok()? != b.next().ok()? {
        return None;
    } // fontfaces itemCnt is 7 on both.
    for lang in 0..7 {
        if new[lang] < old[lang] {
            return None;
        }
        let (Some(Piece::Event(mut left)), Some(Piece::Event(mut right))) =
            (a.next().ok()?, b.next().ok()?)
        else {
            return None;
        };
        for event in [&mut left, &mut right] {
            let Canonical::Start { attributes, .. } = event else {
                return None;
            };
            attributes.retain(|(ns, key, _)| !(ns.is_none() && key == "fontCnt"));
        }
        if left != right {
            return None;
        }
        for _ in 0..old[lang] {
            if !definition_equal(&mut a, &mut b).ok()? {
                return None;
            }
        }
        for id in old[lang]..new[lang] {
            let Some(Piece::Event(event)) = b.next().ok()? else {
                return None;
            };
            let Canonical::Start { attributes, .. } = &event else {
                return None;
            };
            if !is_head(&event, "font")
                || attributes.len() != 4
                || plain_attribute(&event, "id").and_then(hwpx_id) != Some(id as u32)
                || plain_attribute(&event, "type") != Some("TTF")
                || plain_attribute(&event, "isEmbedded") != Some("0")
                || !plain_attribute(&event, "face").is_some_and(|n| {
                    !n.is_empty()
                        && n.len() <= 128
                        && n.trim() == n
                        && !n.chars().any(char::is_control)
                })
                || b.next().ok()? != Some(Piece::Event(Canonical::End))
            {
                return None;
            }
        }
        if a.next().ok()? != Some(Piece::Event(Canonical::End))
            || b.next().ok()? != Some(Piece::Event(Canonical::End))
        {
            return None;
        }
    }
    if a.next().ok()? != Some(Piece::Event(Canonical::End))
        || b.next().ok()? != Some(Piece::Event(Canonical::End))
    {
        return None;
    }
    Some((old, new))
}

fn appended_fonts_referenced(
    header: &str,
    old: [usize; 7],
    new: [usize; 7],
    base: u32,
    used_shapes: &std::collections::BTreeSet<u32>,
) -> bool {
    fn check(
        header: &str,
        old: [usize; 7],
        new: [usize; 7],
        base: u32,
        used_shapes: &std::collections::BTreeSet<u32>,
    ) -> Option<()> {
        let count: usize = new
            .iter()
            .zip(old)
            .map(|(n, o)| n.checked_sub(o))
            .sum::<Option<usize>>()?;
        if count == 0 {
            return Some(());
        }
        crate::document::resources::charge(crate::document::resources::Category::Index, count)
            .ok()?;
        let mut seen: [Vec<bool>; 7] = std::array::from_fn(|_| Vec::new());
        for lang in 0..7 {
            seen[lang].try_reserve_exact(new[lang] - old[lang]).ok()?;
            seen[lang].resize(new[lang] - old[lang], false);
        }
        let mut c = SemanticCursor::new(header);
        let mut depth = 0usize;
        let mut shape = None;
        while let Some(piece) = c.next().ok()? {
            match piece {
                Piece::Event(ref e) if is_head(e, "fontRef") && depth == 4 && shape.is_some() => {
                    let Canonical::Start { attributes, .. } = e else {
                        return None;
                    };
                    if !valid_font_ref(attributes, new) {
                        return None;
                    }
                    for (lang, key) in FONT_ATTRIBUTES.iter().enumerate() {
                        let id = plain_attribute(e, key).and_then(hwpx_id)? as usize;
                        if id >= old[lang] {
                            *seen[lang].get_mut(id - old[lang])? = true;
                        }
                    }
                    depth += 1;
                }
                Piece::Event(ref e) if is_head(e, "charPr") && depth == 3 => {
                    let id = plain_attribute(e, "id").and_then(hwpx_id)?;
                    shape = (id >= base && used_shapes.contains(&id)).then_some(id);
                    depth += 1;
                }
                Piece::Event(Canonical::Start { .. }) => depth += 1,
                Piece::Event(Canonical::End) => {
                    depth = depth.checked_sub(1)?;
                    if depth == 3 {
                        shape = None;
                    }
                }
                _ => {}
            }
        }
        seen.iter().flatten().all(|v| *v).then_some(())
    }
    check(header, old, new, base, used_shapes).is_some()
}

#[cfg(test)]
mod font_preservation_tests {
    use super::*;
    fn header(appended: bool, new_faces: bool) -> String {
        let mut xml = format!(
            r#"<hh:head xmlns:hh="{HWPML_HEAD}" xmlns:x="urn:preserved"><hh:refList><hh:fontfaces itemCnt="7">"#
        );
        for (lang, language) in FONT_LANGUAGES.iter().enumerate() {
            let count = lang + 1 + usize::from(new_faces);
            xml += &format!(r#"<hh:fontface lang="{language}" fontCnt="{count}">"#);
            for id in 0..=lang {
                xml += &format!(
                    r#"<hh:font id="{id}" face="Family {id}" type="TTF" isEmbedded="0"/>"#
                );
            }
            if new_faces {
                xml += &format!(
                    r#"<hh:font id="{}" face="Registered Family" type="TTF" isEmbedded="0"/>"#,
                    lang + 1
                );
            }
            xml += "</hh:fontface>";
        }
        xml += &format!(
            r#"</hh:fontfaces><hh:charProperties itemCnt="{}">"#,
            if appended { 2 } else { 1 }
        );
        for id in 0..=usize::from(appended) {
            xml += &format!(r#"<hh:charPr id="{id}" height="1000"><hh:fontRef"#);
            for (lang, attr) in FONT_ATTRIBUTES.iter().enumerate() {
                xml += &format!(
                    r#" {attr}="{}""#,
                    if id == 0 {
                        0
                    } else {
                        lang + usize::from(new_faces)
                    }
                );
            }
            xml += r#"/><x:opaque attr="unchanged"/></hh:charPr>"#;
        }
        xml += "</hh:charProperties><x:preserved/></hh:refList></hh:head>";
        xml
    }
    fn package() -> Package {
        let body = br#"<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p id="0"><hp:run charPrIDRef="1"><hp:t>text</hp:t></hp:run></hp:p></hs:sec>"#;
        Package {
            order: vec!["Contents/section0.xml".into()],
            parts: [("Contents/section0.xml".into(), (0, body.to_vec()))]
                .into_iter()
                .collect(),
        }
    }
    #[test]
    fn font_proof_existing_and_appended_language_ids() {
        let original = header(false, false);
        for new_faces in [false, true] {
            let output = header(true, new_faces);
            assert!(
                header_equal_or_appended(original.as_bytes(), output.as_bytes(), &package()),
                "{new_faces}"
            );
        }
    }
    #[test]
    fn font_proof_rejects_invalid_counts_refs_and_unrelated_xml() {
        let original = header(false, false);
        let good = header(true, true);
        for bad in [
            good.replacen("fontCnt=\"2\"", "fontCnt=\"3\"", 1),
            good.replacen("hangul=\"1\"", "hangul=\"99\"", 1),
            good.replace("height=\"1000\"", "height=\"2000\""),
            good.replacen("<x:preserved/>", "<x:preserved changed=\"1\"/>", 1),
            good.replacen("attr=\"unchanged\"", "attr=\"changed\"", 1),
            good.replace(
                "face=\"Registered Family\"",
                "face=\"Registered Family\" x:unapproved=\"1\"",
            ),
            header(false, true), // new faces must have actual uses in derived shapes.
        ] {
            assert!(
                !header_equal_or_appended(original.as_bytes(), bad.as_bytes(), &package()),
                "accepted {bad}"
            );
        }
    }
}
