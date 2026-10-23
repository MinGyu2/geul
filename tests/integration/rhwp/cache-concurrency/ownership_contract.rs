//! Job-era cache boundary contracts. Original cache_contract.rs is preserved verbatim.
//! Pending rejection transfers no ownership; trim is explicit cancellation; oversized ready
//! resources transfer to a lease, never simultaneous implicit cache residency.
mod surface_cache;
use std::{cell::Cell, rc::Rc};
use surface_cache::{BoundedCache, ImageKey, Release};
#[derive(Clone)]
struct Handle(Rc<Cell<usize>>);
impl Release for Handle { fn release(&self) { self.0.set(self.0.get()+1); } }
fn handle() -> Handle { Handle(Rc::new(Cell::new(0))) }
fn key(n:u32) -> ImageKey { ImageKey::of(&n.to_le_bytes()) }
#[test]
fn three_90_byte_requests_respect_100_bytes_two_entries() {
    let mut c=BoundedCache::new(100,2,false); let mut admitted=0;
    for n in 0..3 { admitted+=usize::from(c.insert_pending(key(n),handle(),90)); }
    assert_eq!(admitted,1); assert_eq!((c.stats().bytes,c.stats().entries),(90,1));
}
#[test]
fn two_entry_limit_prevents_a_third_decode() {
    let mut c=BoundedCache::new(1000,2,false);
    assert!(c.insert_pending(key(1),handle(),1)); assert!(c.insert_pending(key(2),handle(),1));
    assert!(!c.insert_pending(key(3),handle(),1)); assert_eq!(c.stats().entries,2);
}
#[test]
fn two_hundred_never_complete_requests_are_bounded() {
    let mut c=BoundedCache::new(100,2,false);
    for n in 0..200 { let h=handle(); if !c.insert_pending(key(n),h.clone(),90) { h.release(); } }
    assert_eq!(c.stats().bytes,90); assert_eq!(c.stats().pending_entries,1);
}
#[test]
fn oversized_encoded_request_is_rejected_before_ownership() {
    let mut c:BoundedCache<Handle>=BoundedCache::new(100,2,false);
    assert!(!c.can_insert_pending(1<<20)); assert!(!c.insert_pending(key(1),handle(),1<<20));
    assert_eq!(c.stats().entries,0);
}
#[test]
fn budget_reduction_cancels_enough_pending_work() {
    let mut c=BoundedCache::new(1000,8,false);
    for n in 0..4 { assert!(c.insert_pending(key(n),handle(),90)); }
    c.set_budget(100,2); assert!(c.stats().bytes<=100 && c.stats().entries<=2);
}
#[test]
fn trim_zero_releases_pending_and_ignores_late_callbacks() {
    let h=handle(); let mut c=BoundedCache::new(100,2,false);
    assert!(c.insert_pending(key(1),h.clone(),90)); c.trim(0); assert_eq!(h.0.get(),1);
    assert!(c.loaded(&key(1),10).is_none()); c.failed(&key(1)); assert_eq!(c.stats().entries,0);
}
#[test]
fn failed_decode_releases_reservation_and_can_retry_after_eviction() {
    let h=handle(); let mut c=BoundedCache::new(100,2,false);
    assert!(c.insert_pending(key(1),h.clone(),90)); c.failed(&key(1)); assert_eq!(h.0.get(),1);
    assert_eq!(c.stats().pending_entries,0); c.trim(0);
    assert!(c.insert_pending(key(1),handle(),90));
}
#[test]
fn duplicate_pending_does_not_replace_or_restart() {
    let h=handle(); let mut c=BoundedCache::new(100,2,false);
    assert!(c.insert_pending(key(1),h.clone(),90));
    for _ in 0..100 { assert!(!c.insert_pending(key(1),handle(),90)); }
    assert_eq!(h.0.get(),0); assert_eq!(c.stats().bytes,90);
}
#[test]
fn tiny_negative_entries_do_not_exceed_budget() {
    let mut c=BoundedCache::new(10,2,false);
    assert!(c.insert_pending(key(1),handle(),1)); c.failed(&key(1));
    assert_eq!(c.stats().bytes,0); assert!(!c.insert(key(2),None,0));
}
#[test]
fn oversize_completion_transfers_lease_without_pollution() {
    let mut c=BoundedCache::new(400,8,false); let h=handle();
    assert!(c.insert(key(1),Some(handle()),80)); assert!(c.insert_pending(key(2),h.clone(),10));
    let (lease,bytes)=c.loaded(&key(2),800).expect("explicit ready lease");
    assert_eq!(bytes,810); assert_eq!(h.0.get(),0); assert!(c.get(&key(1)).is_some());
    assert_eq!(c.stats().bytes,80); lease.release(); assert_eq!(h.0.get(),1);
}
#[test]
fn completion_permits_next_waiting_reservation() {
    let mut c=BoundedCache::new(100,2,false);
    assert!(c.insert_pending(key(1),handle(),90)); assert!(!c.can_insert_pending(90));
    let (lease,_)=c.loaded(&key(1),100).unwrap(); assert!(c.can_insert_pending(90));
    assert!(c.insert_pending(key(2),handle(),90)); lease.release();
}
#[test]
fn zero_budget_and_zero_entries_retain_nothing() {
    let mut c=BoundedCache::new(0,0,false);
    assert!(!c.insert(key(1),Some(handle()),0)); assert!(!c.insert(key(2),None,0));
    assert!(!c.insert_pending(key(3),handle(),0)); assert_eq!(c.stats().entries,0);
}

#[test]
fn small_completion_with_other_pending_never_overcommits() {
    let mut c=BoundedCache::new(100,2,false);
    assert!(c.insert_pending(key(1),handle(),1));
    assert!(c.insert_pending(key(2),handle(),99));
    let (lease,_)=c.loaded(&key(1),20).unwrap();
    assert_eq!(c.stats().bytes,99);lease.release();
}
