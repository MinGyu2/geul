//! Current supported BoundedCache contract (job-owned Rc leases; rhwp-undo-redo.md "T010 격리 resource scheduler 후속 계약").
//! Run: unit.py --suite current --source CANDIDATE/src/renderer/surface_cache.rs (with the cache's own internal tests).
//! Composition is fixed by cache_contract_mapping.json and checked by test_cache_contract_suites.py:
//! - the historical cache_contract.rs tests that remain valid, copied verbatim;
//! - three current-policy tests replacing only the two obsolete v2 expectations, copied verbatim from
//!   ../evidence/t010-decoded-lease-readiness-closure/repro/cache_disposition_contract.rs.
//! The historical suite (cache_contract.rs, unit.py --suite historical) is unchanged and still reports its two failures.
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
fn releases(h: &Handle) -> usize {
    *h.0.borrow()
}

// --- Carried from cache_contract.rs (still valid under the current contract) ---
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

// --- Current policy, replacing the two obsolete v2 expectations ---

// trim_during_load_does_not_release_the_pending_handle expects the v2 policy (trim keeps pending).
// Current policy: trim cancels the cache's pending reference exactly once; another owner (a job lease
// in the engine) keeps its own clone; late completion/failure cannot revive the entry.
#[test]
fn trim_cancels_the_cache_pending_reference_once_and_ignores_late_callbacks() {
    let mut c = BoundedCache::new(100, 2, false);
    let job_lease = handle();
    assert!(c.insert_pending(key(1), job_lease.clone(), 90));
    c.trim(0);
    let s = c.stats();
    assert_eq!((s.entries, s.pending_entries, s.bytes), (0, 0, 0), "{s:?}");
    assert_eq!(releases(&job_lease), 1, "cache reference released exactly once");
    assert_eq!(Rc::strong_count(&job_lease.0), 1, "the other owner's clone stays valid");
    assert!(c.loaded(&key(1), 10).is_none(), "late completion is ignored");
    c.failed(&key(1));
    c.trim(0);
    let s = c.stats();
    assert_eq!((s.entries, s.bytes), (0, 0), "{s:?}");
    assert_eq!(releases(&job_lease), 1, "no double release");
}

// Without trim cancelling pending entries, a cache-owned pending reference has no other bound release.
#[test]
fn pending_entries_are_bounded_and_trim_is_their_release_path() {
    let mut c = BoundedCache::new(100, 2, false);
    let handles: Vec<Handle> = (0..4).map(|_| handle()).collect();
    let admitted: Vec<bool> = handles
        .iter()
        .enumerate()
        .map(|(n, h)| c.insert_pending(key(n as u32), h.clone(), 40))
        .collect();
    assert_eq!(admitted, [true, true, false, false]);
    assert_eq!(c.stats().pending_entries, 2);
    c.trim(0);
    assert_eq!(c.stats().pending_entries, 0);
    assert_eq!(
        handles.iter().map(releases).collect::<Vec<_>>(),
        [1, 1, 0, 0],
        "only admitted cache references are released, once"
    );
}

// two_oversize_completions_can_be_available_for_one_full_page_draw expects both oversize images to be
// cache residents and discards loaded()'s return value. Current policy: oversize completions transfer a
// caller-owned ready lease (the job keeps it until its Full frame is published); residency stays bounded.
#[test]
fn two_oversize_completions_transfer_ready_leases_available_together() {
    let mut c = BoundedCache::new(100, 8, false);
    let small = handle();
    assert!(c.insert(key(9), Some(small.clone()), 20));
    let (a, b) = (handle(), handle());
    assert!(c.insert_pending(key(1), a.clone(), 1));
    assert!(c.insert_pending(key(2), b.clone(), 1));
    let lease_a = c.loaded(&key(1), 200).expect("ready lease for the first oversize image");
    let lease_b = c.loaded(&key(2), 200).expect("ready lease for the second oversize image");
    assert_eq!((lease_a.1, lease_b.1), (201, 201));
    // Both are available to the same draw at once and were not released by the cache.
    assert!(Rc::ptr_eq(&lease_a.0 .0, &a.0) && Rc::ptr_eq(&lease_b.0 .0, &b.0));
    assert_eq!((releases(&a), releases(&b)), (0, 0));
    let s = c.stats();
    assert!(s.bytes <= s.max_bytes && s.pending_entries == 0, "{s:?}");
    assert!(c.get(&key(9)).is_some(), "oversize completion did not evict the small resident");
    // The historical expectation (both resident) would need 402 resident bytes in a 100-byte budget.
    assert!(lease_a.1 + lease_b.1 + 20 > s.max_bytes);
    assert!(c.get(&key(1)).is_none() && c.get(&key(2)).is_none());
}
