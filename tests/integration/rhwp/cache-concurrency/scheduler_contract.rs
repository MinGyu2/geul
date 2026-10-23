#[path = "surface_cache.rs"]
mod surface_cache;
use std::{cell::Cell, rc::Rc};
use surface_cache::{BoundedCache, ImageKey, Release};
#[derive(Clone)]
struct Lease(Rc<Cell<usize>>);
impl Release for Lease {
    fn release(&self) {}
}
fn key(n: u16) -> ImageKey {
    ImageKey::of(&n.to_le_bytes())
}
#[test]
fn full_256_reclaims_only_oldest_inactive_resident() {
    let mut c = BoundedCache::new(1024 * 1024, 256, false);
    for n in 0..256 {
        assert!(c.insert(key(n), Some(Lease(Rc::new(Cell::new(0)))), 128));
    }
    let active = c.get(&key(0)).flatten().unwrap();
    assert_eq!(
        c.resident_capacity_where(|v| Rc::strong_count(&v.0) == 1),
        (255, 255 * 128)
    );
    assert!(c.evict_resident_where(|v| Rc::strong_count(&v.0) == 1));
    assert!(c.get(&key(0)).is_some());
    assert!(c.get(&key(1)).is_none());
    assert!(c.insert(key(256), Some(Lease(Rc::new(Cell::new(1)))), 128));
    assert_eq!(c.stats().entries, 256);
    assert_eq!(c.stats().bytes, 256 * 128);
    assert_eq!(active.0.get(), 0);
}
#[test]
fn byte_reclamation_requires_multiple_eligible_victims() {
    let mut c = BoundedCache::new(1000, 256, false);
    for n in 0..8 {
        assert!(c.insert(key(n), Some(Lease(Rc::new(Cell::new(0)))), 125));
    }
    let keep = c.get(&key(0)).flatten().unwrap();
    while c.stats().bytes > 500 {
        assert!(c.evict_resident_where(|v| Rc::strong_count(&v.0) == 1));
    }
    assert_eq!(c.stats().evictions, 4);
    assert_eq!(keep.0.get(), 0);
    assert!(c.get(&key(0)).is_some());
}
#[test]
fn all_active_and_pending_are_not_reclaimable() {
    let mut c = BoundedCache::new(1000, 8, false);
    let a = Lease(Rc::new(Cell::new(0)));
    assert!(c.insert(key(0), Some(a.clone()), 100));
    assert!(c.insert_pending(key(1), Lease(Rc::new(Cell::new(0))), 100));
    assert!(!c.evict_resident_where(|v| Rc::strong_count(&v.0) == 1));
    assert_eq!(c.stats().entries, 2);
    drop(a);
    assert!(c.evict_resident_where(|v| Rc::strong_count(&v.0) == 1));
    assert_eq!(c.stats().pending_entries, 1);
}
#[test]
fn budget_and_trim_drop_only_cache_owned_rc() {
    let mut c = BoundedCache::new(1000, 8, false);
    let a = Lease(Rc::new(Cell::new(9)));
    c.insert(key(0), Some(a.clone()), 100);
    c.set_budget(0, 0);
    assert_eq!(a.0.get(), 9);
    assert_eq!(Rc::strong_count(&a.0), 1);
    c.set_budget(1000, 8);
    c.insert_pending(key(1), a.clone(), 100);
    c.trim(0);
    assert_eq!(c.stats().bytes, 0);
    assert_eq!(a.0.get(), 9);
}
