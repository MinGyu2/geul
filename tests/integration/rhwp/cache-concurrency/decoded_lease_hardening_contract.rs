//! Reservation/actual-size and lease-metadata contracts (T010 decoded lease accounting hardening).
//! Runs against an explicit isolated surface_cache.rs through unit.py. A mock backing records
//! allocation and disposal so refusal before allocation is distinguished from disposal after it.
mod surface_cache;
use std::{
    cell::Cell,
    collections::HashMap,
    rc::{Rc, Weak},
};
use surface_cache::{
    insert_lease_bounded, prune_dead_leases, Backing, BoundedCache, CommitError, DecodedLedger,
    ImageKey, LedgerStats, SharedBacking,
};

/// Counts allocations (constructions) and disposals of mock Canvas backings.
#[derive(Default)]
struct Probe {
    allocated: Cell<u32>,
    disposed: Cell<u32>,
}
struct Canvas(Rc<Probe>);
impl Canvas {
    fn allocate(probe: &Rc<Probe>) -> Self {
        probe.allocated.set(probe.allocated.get() + 1);
        Canvas(probe.clone())
    }
}
impl Backing for Canvas {
    fn dispose(&self) {
        self.0.disposed.set(self.0.disposed.get() + 1);
    }
}
type Lease = Rc<SharedBacking<Canvas>>;

fn key(n: u32) -> ImageKey {
    ImageKey::of(&n.to_le_bytes())
}
fn ledger() -> Rc<DecodedLedger> {
    Rc::new(DecodedLedger::default())
}
fn counters(s: LedgerStats) -> (usize, usize, usize, u64, u64) {
    (s.unique_bytes, s.unique_count, s.reserved_bytes, s.created, s.disposed)
}

#[test]
fn actual_below_reservation_is_charged_actual_size() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let r = l.reserve(100, 0, 100, true).unwrap();
    let lease = r.commit(Canvas::allocate(&p), 60).expect("smaller allocation fits");
    assert_eq!(counters(l.stats()), (60, 1, 0, 1, 0));
    assert_eq!(lease.bytes(), 60);
    drop(lease);
    assert_eq!(counters(l.stats()), (0, 0, 0, 1, 1));
    assert_eq!(p.disposed.get(), 1);
}

#[test]
fn actual_equal_to_reservation_commits() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let r = l.reserve(4, 0, 4, true).unwrap();
    let lease = r.commit(Canvas::allocate(&p), 4).expect("exact allocation fits");
    assert_eq!(counters(l.stats()), (4, 1, 0, 1, 0));
    assert_eq!((p.disposed.get(), l.stats().rejected_commits), (0, 0));
    drop(lease);
    assert_eq!(p.disposed.get(), 1);
}

#[test]
fn actual_above_enforced_reservation_is_rejected_after_allocation_and_disposed_once() {
    // Reported counterexample: reserve(4, 0, 4, true) then commit(backing, 8).
    let l = ledger();
    let p = Rc::new(Probe::default());
    let r = l.reserve(4, 0, 4, true).unwrap();
    let result = r.commit(Canvas::allocate(&p), 8);
    assert_eq!(
        result.err(),
        Some(CommitError::ExceedsReservation {
            reserved: 4,
            actual: 8
        })
    );
    assert_eq!((p.allocated.get(), p.disposed.get()), (1, 1), "disposed exactly once");
    assert_eq!(counters(l.stats()), (0, 0, 0, 0, 0), "no charge, reservation released");
    assert_eq!((l.stats().rejected_commits, l.stats().accounting_errors), (1, 0));
    // The freed capacity is usable again.
    let again = l.reserve(4, 0, 4, true).unwrap();
    let lease = again.commit(Canvas::allocate(&p), 4).unwrap();
    assert_eq!(counters(l.stats()), (4, 1, 0, 1, 0));
    drop(lease);
    assert_eq!(p.disposed.get(), 2);
}

#[test]
fn unenforced_legacy_reservation_still_cannot_commit_above_itself() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let r = l.reserve(200, 0, 100, false).unwrap();
    assert_eq!(l.stats().over_limit, 1, "legacy over-limit is explicit");
    assert!(r.commit(Canvas::allocate(&p), 201).is_err());
    assert_eq!((p.disposed.get(), l.stats().unique_bytes, l.stats().reserved_bytes), (1, 0, 0));
}

#[test]
fn authorizes_refuses_before_any_backing_is_allocated() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let r = l.reserve(16, 0, 16, true).unwrap();
    assert_eq!(r.authorizes(16), Ok(()));
    assert_eq!(r.authorizes(0), Ok(()));
    assert!(matches!(r.authorizes(17), Err(CommitError::ExceedsReservation { .. })));
    // Caller refuses: no backing exists, so nothing is disposed; dropping releases the bytes.
    drop(r);
    assert_eq!((p.allocated.get(), p.disposed.get()), (0, 0));
    assert_eq!(counters(l.stats()), (0, 0, 0, 0, 0));
    assert_eq!(l.stats().rejected_commits, 0, "pre-allocation refusal is not a commit");
}

#[test]
fn zero_sized_reservation_and_commit_are_valid() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let r = l.reserve(0, 0, 0, true).unwrap();
    let lease = r.commit(Canvas::allocate(&p), 0).expect("zero fits zero");
    assert_eq!(counters(l.stats()), (0, 1, 0, 1, 0));
    let r = l.reserve(0, 0, 0, true).unwrap();
    assert!(r.commit(Canvas::allocate(&p), 1).is_err(), "zero reservation authorizes nothing more");
    drop(lease);
    assert_eq!(counters(l.stats()), (0, 0, 0, 1, 1));
    assert_eq!(p.disposed.get(), 2);
}

#[test]
fn overflowing_charge_fails_closed_without_a_lease() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let big = l.reserve(usize::MAX - 1, 0, usize::MAX, false).unwrap();
    let held = big.commit(Canvas::allocate(&p), usize::MAX - 1).unwrap();
    // reserved + unique are separate cells; the sum is checked at commit.
    let small = l.reserve(2, 0, 2, true).unwrap();
    assert_eq!(small.authorizes(2), Err(CommitError::Overflow));
    assert_eq!(small.commit(Canvas::allocate(&p), 2).err(), Some(CommitError::Overflow));
    assert_eq!(p.disposed.get(), 1, "only the rejected backing was disposed");
    assert_eq!(counters(l.stats()), (usize::MAX - 1, 1, 0, 1, 0));
    assert_eq!((l.stats().accounting_errors, l.stats().rejected_commits), (1, 1));
    assert!(l.reserve(usize::MAX, 1, usize::MAX, true).is_none(), "overflow never fits");
    drop(held);
    assert_eq!(counters(l.stats()), (0, 0, 0, 1, 1));
    assert_eq!(p.disposed.get(), 2);
}

#[test]
fn failed_commit_followed_by_cleanup_is_idempotent() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let mut cache: BoundedCache<Lease> = BoundedCache::new(1000, 4, false);
    let ok = l.reserve(10, 0, 100, true).unwrap().commit(Canvas::allocate(&p), 10).unwrap();
    cache.insert(key(1), Some(ok.clone()), 10);
    let failed = l.reserve(10, 0, 100, true).unwrap().commit(Canvas::allocate(&p), 11);
    assert!(failed.is_err());
    drop(failed);
    for _ in 0..3 {
        cache.trim(0);
        cache.set_budget(0, 0);
        surface_cache::Release::release(&ok);
    }
    assert_eq!(p.disposed.get(), 1, "only the rejected backing so far");
    drop(ok);
    let s = l.stats();
    assert_eq!(counters(s), (0, 0, 0, 1, 1));
    assert_eq!((p.allocated.get(), p.disposed.get()), (2, 2));
    assert_eq!((s.accounting_errors, s.rejected_commits), (0, 1));
}

#[test]
fn multiple_outstanding_reservations_keep_independent_charges() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let a = l.reserve(30, 0, 100, true).unwrap();
    let b = l.reserve(30, 0, 100, true).unwrap();
    let c = l.reserve(40, 0, 100, true).unwrap();
    assert!(l.reserve(1, 0, 100, true).is_none(), "reservations count against the limit");
    assert_eq!(l.stats().reserved_bytes, 100);
    assert!(b.commit(Canvas::allocate(&p), 31).is_err());
    assert_eq!((l.stats().reserved_bytes, l.stats().unique_bytes), (70, 0));
    let la = a.commit(Canvas::allocate(&p), 30).unwrap();
    let lc = c.commit(Canvas::allocate(&p), 20).unwrap();
    assert_eq!(counters(l.stats()), (50, 2, 0, 2, 0));
    assert_eq!(l.stats().peak_bytes, 100);
    drop((la, lc));
    assert_eq!(counters(l.stats()), (0, 0, 0, 2, 2));
    assert_eq!(p.disposed.get(), 3);
}

#[test]
fn shared_rc_owners_are_unaffected_by_a_rejected_commit() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let mut cache: BoundedCache<Lease> = BoundedCache::new(1000, 1, false);
    let x = l.reserve(8, 0, 100, true).unwrap().commit(Canvas::allocate(&p), 8).unwrap();
    cache.insert(key(1), Some(x.clone()), 8);
    let jobs: Vec<HashMap<ImageKey, Lease>> =
        (0..3).map(|_| HashMap::from([(key(1), x.clone())])).collect();
    drop(x);
    assert!(l.reserve(8, 8, 100, true).unwrap().commit(Canvas::allocate(&p), 9).is_err());
    assert_eq!(p.disposed.get(), 1, "the shared backing is still alive");
    cache.trim(0);
    let mut jobs = jobs.into_iter();
    drop(jobs.next());
    drop(jobs.next());
    assert_eq!(p.disposed.get(), 1);
    drop(jobs);
    assert_eq!(p.disposed.get(), 2);
    assert_eq!(counters(l.stats()), (0, 0, 0, 1, 1));
}

#[test]
fn lease_map_is_bounded_by_entry_count_independently_of_bytes() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let max = 4;
    let mut job: HashMap<ImageKey, Lease> = HashMap::new();
    let mut refused = Vec::new();
    for n in 0..10 {
        let lease = l.reserve(4, 0, 1 << 20, true).unwrap().commit(Canvas::allocate(&p), 4).unwrap();
        if !insert_lease_bounded(&mut job, key(n), lease.clone(), max) {
            // The draw-scoped owner is still valid for its use.
            assert_eq!(p.disposed.get(), 0);
            refused.push(lease);
        }
    }
    assert_eq!((job.len(), refused.len()), (4, 6));
    // An existing key replaces in place without growth.
    let again = job.get(&key(0)).unwrap().clone();
    assert!(insert_lease_bounded(&mut job, key(0), again, max));
    assert_eq!(job.len(), 4);
    drop(refused);
    assert_eq!(p.disposed.get(), 6, "unretained draw-scoped leases dispose after their use");
    // A refused key re-resolves later once the job has room.
    job.remove(&key(1));
    let later = l.reserve(4, 0, 1 << 20, true).unwrap().commit(Canvas::allocate(&p), 4).unwrap();
    assert!(insert_lease_bounded(&mut job, key(9), later, max));
    drop(job);
    assert_eq!(counters(l.stats()), (0, 0, 0, 11, 11));
}

#[test]
fn dead_registry_entries_are_pruned() {
    let l = ledger();
    let p = Rc::new(Probe::default());
    let mut registry: HashMap<ImageKey, Weak<SharedBacking<Canvas>>> = HashMap::new();
    let mut live = Vec::new();
    for n in 0..100 {
        let lease = l.reserve(4, 0, 1 << 20, true).unwrap().commit(Canvas::allocate(&p), 4).unwrap();
        registry.insert(key(n), Rc::downgrade(&lease));
        if n % 10 == 0 {
            live.push(lease);
        }
    }
    prune_dead_leases(&mut registry);
    assert_eq!(registry.len(), 10);
    drop(live);
    prune_dead_leases(&mut registry);
    assert!(registry.is_empty());
    assert_eq!(counters(l.stats()), (0, 0, 0, 100, 100));
}

#[test]
fn many_tiny_images_across_jobs_keep_metadata_bounded_and_clean_up() {
    // 8 jobs x 300 distinct 1x1 images (4 bytes each), a 16-entry cache, shared keys across jobs.
    let l = ledger();
    let p = Rc::new(Probe::default());
    let (max_jobs, max_leases, images) = (8usize, 256usize, 300u32);
    let mut cache: BoundedCache<Lease> = BoundedCache::new(1 << 20, 16, false);
    let mut registry: HashMap<ImageKey, Weak<SharedBacking<Canvas>>> = HashMap::new();
    let mut jobs: Vec<HashMap<ImageKey, Lease>> = (0..max_jobs).map(|_| HashMap::new()).collect();
    let (mut refusals, mut peak_unique) = (0, 0);
    for (j, job) in jobs.iter_mut().enumerate() {
        for n in 0..images {
            let k = key(n + (j as u32 % 2) * 1000);
            // Lookup order of the engine: cache, own job, then a live owner from the registry.
            let found = cache
                .get(&k)
                .flatten()
                .or_else(|| job.get(&k).cloned())
                .or_else(|| registry.get(&k).and_then(Weak::upgrade));
            let lease = match found {
                Some(lease) => lease,
                None => {
                    let lease = l.reserve(4, 0, 96 << 20, true).unwrap();
                    let lease = lease.commit(Canvas::allocate(&p), 4).unwrap();
                    peak_unique = peak_unique.max(l.stats().unique_count);
                    prune_dead_leases(&mut registry);
                    registry.insert(k, Rc::downgrade(&lease));
                    lease
                }
            };
            cache.insert(k, Some(lease.clone()), 4);
            if !insert_lease_bounded(job, k, lease.clone(), max_leases) {
                refusals += 1;
            }
            // Dead entries persist only until the next prune: bounded by the live peak.
            peak_unique = peak_unique.max(l.stats().unique_count);
            assert!(registry.len() <= peak_unique);
        }
        assert!(job.len() <= max_leases);
        prune_dead_leases(&mut registry);
        assert_eq!(registry.len(), l.stats().unique_count, "pruned registry = live backings");
    }
    let s = l.stats();
    assert!(refusals > 0, "metadata pressure was exercised");
    // Two key families shared across jobs: unique backings never exceed distinct keys.
    assert!(s.unique_count <= 2 * images as usize);
    assert!(jobs.iter().map(HashMap::len).sum::<usize>() <= max_jobs * max_leases);
    // Cancel half, then trim and release the rest.
    for job in jobs.iter_mut().step_by(2) {
        job.clear();
    }
    cache.trim(0);
    jobs.clear();
    prune_dead_leases(&mut registry);
    assert!(registry.is_empty());
    let s = l.stats();
    assert_eq!(counters(s), (0, 0, 0, s.created, s.created));
    assert_eq!((s.accounting_errors, s.rejected_commits), (0, 0));
    assert_eq!(p.allocated.get(), p.disposed.get());
}
