//! Desired contracts. Failures are deliberately reported as failures, never inverted into PASS.
mod surface_cache;
use std::{cell::RefCell, rc::Rc};
use surface_cache::{BoundedCache, ImageKey, Release};
#[derive(Clone)]
struct Handle(Rc<RefCell<usize>>);
impl Release for Handle {
    fn release(&self) {
        *self.0.borrow_mut() += 1;
    }
}
fn handle() -> Handle {
    Handle(Rc::new(RefCell::new(0)))
}
fn key(n: u32) -> ImageKey {
    ImageKey::of(&n.to_le_bytes())
}
#[test]
fn three_pending_requests_respect_100_bytes_and_two_entries() {
    let mut c = BoundedCache::new(100, 2, false);
    for n in 0..3 {
        c.insert_pending(key(n), handle(), 90);
    }
    let s = c.stats();
    eprintln!("observed entries={} bytes={}", s.entries, s.bytes);
    assert!(s.entries <= 2 && s.bytes <= 100, "{s:?}");
}
#[test]
fn never_completing_requests_are_bounded() {
    let mut c = BoundedCache::new(100, 2, false);
    for n in 0..200 {
        c.insert_pending(key(n), handle(), 90);
    }
    let s = c.stats();
    assert!(s.entries <= 2 && s.bytes <= 100, "{s:?}");
}
#[test]
fn one_large_encoded_request_has_a_hard_bound() {
    let mut c = BoundedCache::new(100, 2, false);
    c.insert_pending(key(1), handle(), 1 << 20);
    assert!(c.stats().bytes <= 100, "{:?}", c.stats());
}
#[test]
fn budget_reduction_cannot_increase_pending_overcommit() {
    let mut c = BoundedCache::new(1000, 8, false);
    for n in 0..4 {
        c.insert_pending(key(n), handle(), 90);
    }
    c.set_budget(100, 2);
    assert!(
        c.stats().entries <= 2 && c.stats().bytes <= 100,
        "{:?}",
        c.stats()
    );
}
#[test]
fn trim_during_load_does_not_release_the_pending_handle() {
    let mut c = BoundedCache::new(100, 2, false);
    let h = handle();
    c.insert_pending(key(1), h.clone(), 90);
    c.trim(0);
    assert_eq!(*h.0.borrow(), 0);
    assert_eq!(c.stats().pending_entries, 1);
}
#[test]
fn transient_completion_does_not_evict_useful_small_residents() {
    let mut c = BoundedCache::new(400, 8, false);
    assert!(c.insert(key(1), Some(handle()), 80));
    c.insert_pending(key(2), handle(), 10);
    c.loaded(&key(2), 800);
    assert!(
        c.get(&key(1)).is_some(),
        "oversize completion evicted a useful resident"
    );
}
#[test]
fn failure_accounting_respects_tiny_budget() {
    let mut c = BoundedCache::new(10, 2, false);
    c.insert_pending(key(1), handle(), 1);
    c.failed(&key(1));
    assert!(c.stats().bytes <= 10, "{:?}", c.stats());
}
#[test]
fn late_completion_after_release_does_not_revive_entry() {
    let mut c = BoundedCache::new(100, 2, false);
    c.insert_pending(key(1), handle(), 1);
    c.loaded(&key(1), 10);
    c.trim(0);
    c.loaded(&key(1), 10);
    c.failed(&key(1));
    assert_eq!(c.stats().entries, 0);
    assert_eq!(c.stats().bytes, 0);
}
#[test]
fn two_oversize_completions_can_be_available_for_one_full_page_draw() {
    let mut c = BoundedCache::new(100, 8, false);
    c.insert_pending(key(1), handle(), 1);
    c.insert_pending(key(2), handle(), 1);
    c.loaded(&key(1), 200);
    c.loaded(&key(2), 200);
    assert!(
        c.get(&key(1)).is_some() && c.get(&key(2)).is_some(),
        "cannot repaint the complete page"
    );
}
