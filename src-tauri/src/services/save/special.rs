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
    policy: FormatPolicy,
}
impl<'a> Definition<'a> {
    fn new(cursor: SemanticCursor<'a>, policy: FormatPolicy) -> Self {
        Self {
            cursor,
            depth: 0,
            started: false,
            seen: [false; 4],
            policy,
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
fn fingerprint(cursor: SemanticCursor<'_>, policy: FormatPolicy) -> Option<u64> {
    let mut definition = Definition::new(cursor, policy);
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
        let (mut a, mut b) = (SemanticCursor::new(&before), SemanticCursor::new(&after));
        fn prefix(c: &mut SemanticCursor<'_>) -> Result<Option<Piece>, Invalid> {
            if matches!(c.peek()?, Some(Piece::Event(event)) if is_head(event, HWPX_SHAPE_LISTS[0]))
            {
                return Ok(None);
            }
            c.next()
        }
        if !xml::pieces_equal(|| prefix(&mut a), || prefix(&mut b))? {
            return Ok(false);
        }
        let (left, right) = (a.next()?, b.next()?);
        if left.is_none() && right.is_none() {
            return Ok(true);
        }
        let (Some(Piece::Event(mut left)), Some(Piece::Event(mut right))) = (left, right) else {
            return Ok(false);
        };
        // Ordinary equality does not impose the append-only id/list restrictions.
        if left == right {
            return xml::pieces_equal(|| a.next(), || b.next());
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
            if let Some(hash) = fingerprint(checkpoint.clone(), FormatPolicy::Original) {
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
            let Some(hash) = fingerprint(checkpoint.clone(), FormatPolicy::Appended) else {
                return Ok(false);
            };
            let mut matched = false;
            if let Some(bucket) = bases.get(&hash) {
                for base in bucket {
                    let mut old = Definition::new(anchor.sibling_at(base), FormatPolicy::Original);
                    let mut new = Definition::new(checkpoint.clone(), FormatPolicy::Appended);
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
        Ok(same && a.head_lists == 1 && b.head_lists == 1)
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
