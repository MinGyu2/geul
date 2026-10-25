//! Decoded-resource lease and unique-byte ledger contracts (T010 decoded lease/accounting).
//! Runs against an explicit isolated surface_cache.rs through unit.py. A mock backing records
//! disposal; the browser contract verifies real Canvas backing lifetime separately.
mod surface_cache;
use std::{cell::Cell, collections::HashMap, rc::Rc};
use surface_cache::{Backing, BoundedCache, DecodedLedger, ImageKey, SharedBacking};

#[derive(Clone)]
struct Canvas(Rc<Cell<u32>>);
impl Backing for Canvas {
    fn dispose(&self) {
        self.0.set(self.0.get() + 1);
    }
}
type Lease = Rc<SharedBacking<Canvas>>;
fn key(n: u32) -> ImageKey {
    ImageKey::of(&n.to_le_bytes())
}
fn ledger() -> Rc<DecodedLedger> {
    Rc::new(DecodedLedger::default())
}
fn decode(l: &Rc<DecodedLedger>, bytes: usize) -> (Lease, Rc<Cell<u32>>) {
    let disposed = Rc::new(Cell::new(0));
    let r = l.reserve(bytes, 0, usize::MAX, true).unwrap();
    (r.commit(Canvas(disposed.clone()), bytes), disposed)
}

#[test]
fn unrelated_eviction_keeps_job_lease_backing_until_last_owner() {
    let l = ledger();
    let mut cache = BoundedCache::new(100, 1, false);
    let (x, disposed) = decode(&l, 20);
    assert!(cache.insert(key(1), Some(x.clone()), 20));
    let job: HashMap<ImageKey, Lease> = HashMap::from([(key(1), x)]);
    let (y, _) = decode(&l, 20);
    assert!(cache.insert(key(2), Some(y), 20)); // evicts key(1)'s cache reference
    assert_eq!(cache.stats().evictions, 1);
    assert_eq!(disposed.get(), 0, "eviction released only the cache reference");
    assert_eq!(l.stats().unique_bytes, 40, "evicted-but-leased bytes are still one allocation");
    drop(job);
    assert_eq!(disposed.get(), 1);
    assert_eq!(l.stats().unique_bytes, 20);
}

#[test]
fn cache_only_eviction_disposes_backing() {
    let l = ledger();
    let mut cache = BoundedCache::new(100, 1, false);
    let (x, disposed) = decode(&l, 20);
    cache.insert(key(1), Some(x), 20);
    let (y, _) = decode(&l, 20);
    cache.insert(key(2), Some(y), 20);
    assert_eq!(disposed.get(), 1);
    assert_eq!((l.stats().unique_bytes, l.stats().unique_count), (20, 1));
}

#[test]
fn shared_cache_and_jobs_are_counted_once() {
    let l = ledger();
    let mut cache = BoundedCache::new(1000, 8, false);
    let (x, disposed) = decode(&l, 200);
    cache.insert(key(1), Some(x.clone()), 200);
    let jobs: Vec<Lease> = (0..8).map(|_| x.clone()).collect();
    assert_eq!(Rc::strong_count(&x), 10);
    assert_eq!((l.stats().unique_bytes, l.stats().unique_count), (200, 1));
    drop(jobs);
    drop(x);
    cache.trim(0);
    assert_eq!(disposed.get(), 1);
    assert_eq!(l.stats(), surface_cache::LedgerStats { peak_bytes: 200, created: 1, disposed: 1, ..Default::default() });
}

#[test]
fn nonresident_temporary_is_counted_until_released() {
    let l = ledger();
    let mut cache: BoundedCache<Lease> = BoundedCache::new(0, 0, true);
    let (temp, disposed) = decode(&l, 300);
    assert!(!cache.insert(key(1), Some(temp.clone()), 300));
    assert_eq!(l.stats().unique_bytes, 300);
    drop(temp);
    assert_eq!((disposed.get(), l.stats().unique_bytes), (1, 0));
}

#[test]
fn enforced_reservation_refuses_before_allocation_and_releases_on_drop() {
    let l = ledger();
    assert!(l.reserve(60, 50, 100, true).is_none());
    assert_eq!(l.stats().refused, 1);
    let r = l.reserve(50, 50, 100, true).unwrap();
    assert_eq!(l.stats().reserved_bytes, 50);
    assert!(l.reserve(1, 50, 100, true).is_none(), "reservations count against the limit");
    drop(r); // error/cancel before commit
    assert_eq!(l.stats().reserved_bytes, 0);
    assert!(l.reserve(usize::MAX, 1, usize::MAX, true).is_none(), "overflow never fits");
    assert_eq!(l.stats().accounting_errors, 0);
}

#[test]
fn unenforced_legacy_reservation_is_explicit() {
    let l = ledger();
    let r = l.reserve(200, 0, 100, false).unwrap();
    assert_eq!(l.stats().over_limit, 1);
    let lease = r.commit(Canvas(Rc::new(Cell::new(0))), 200);
    assert_eq!(l.stats().unique_bytes, 200);
    drop(lease);
    assert_eq!(l.stats().unique_bytes, 0);
}

#[test]
fn repeated_release_and_trim_never_double_dispose() {
    let l = ledger();
    let mut cache = BoundedCache::new(1000, 8, false);
    let (x, disposed) = decode(&l, 100);
    cache.insert(key(1), Some(x.clone()), 100);
    for _ in 0..3 {
        cache.trim(0);
        cache.set_budget(0, 0);
        surface_cache::Release::release(&x);
    }
    assert_eq!(disposed.get(), 0);
    drop(x);
    assert_eq!(disposed.get(), 1);
    assert_eq!((l.stats().created, l.stats().disposed, l.stats().accounting_errors), (1, 1, 0));
}

#[test]
fn commit_uses_actual_bytes_and_peak_tracks_unique_plus_reserved() {
    let l = ledger();
    let r = l.reserve(100, 0, 1000, true).unwrap();
    let pending = l.reserve(50, 0, 1000, true).unwrap();
    let lease = r.commit(Canvas(Rc::new(Cell::new(0))), 80);
    assert_eq!((l.stats().unique_bytes, l.stats().reserved_bytes), (80, 50));
    assert_eq!(l.stats().peak_bytes, 150);
    drop(pending);
    drop(lease);
    assert_eq!((l.stats().unique_bytes, l.stats().reserved_bytes), (0, 0));
}

#[test]
fn peek_does_not_change_lru_or_statistics() {
    let l = ledger();
    let mut cache = BoundedCache::new(160, 2, false);
    let (a, _) = decode(&l, 40);
    let (b, _) = decode(&l, 40);
    assert!(cache.insert(key(1), Some(a.clone()), 40));
    assert!(cache.insert(key(2), Some(b), 40));
    let before = cache.stats();
    assert!(cache.peek(&key(1)).flatten().is_some_and(|v| Rc::ptr_eq(v, &a)));
    assert!(cache.peek(&key(9)).is_none());
    assert_eq!(cache.stats(), before);
    let (c, _) = decode(&l, 40);
    assert!(cache.insert(key(3), Some(c), 40)); // key(1) is still LRU despite peek
    assert!(cache.peek(&key(1)).is_none() && cache.peek(&key(2)).is_some());
}

#[test]
fn many_jobs_and_images_under_cache_pressure_balance_to_zero() {
    let l = ledger();
    let mut cache = BoundedCache::new(400, 3, true);
    let mut jobs: Vec<HashMap<ImageKey, Lease>> = (0..4).map(|_| HashMap::new()).collect();
    let mut disposals = Vec::new();
    for round in 0..6u32 {
        for (j, job) in jobs.iter_mut().enumerate() {
            let k = key((round + j as u32) % 7);
            let lease = match cache.get(&k).flatten().or_else(|| job.get(&k).cloned()) {
                Some(lease) => lease,
                None => {
                    let (lease, disposed) = decode(&l, 100);
                    disposals.push(disposed);
                    cache.insert(k, Some(lease.clone()), 100);
                    lease
                }
            };
            job.insert(k, lease);
        }
        // Unique bytes = resident + job-only, never the sum of references.
        let references: usize = jobs.iter().map(HashMap::len).sum();
        assert!(l.stats().unique_bytes <= 100 * (3 + references));
        assert!(cache.stats().bytes <= 300);
    }
    jobs.clear();
    cache.trim(0);
    assert_eq!((l.stats().unique_bytes, l.stats().unique_count, l.stats().reserved_bytes), (0, 0, 0));
    assert!(disposals.iter().all(|d| d.get() == 1));
    assert_eq!(l.stats().created, l.stats().disposed);
    assert_eq!(l.stats().accounting_errors, 0);
}
