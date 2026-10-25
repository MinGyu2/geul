//! P1-A 재현(이전 API 전용): 이전 후보의 `Reservation::commit(backing, actual) -> Rc<SharedBacking>`에
//! 대해 fail-closed 기대를 단언한다. 이전 구현에서는 단언 실패가 정상적인 재현 결과다.
//! 수정 후보는 commit이 Result를 돌려주므로 이 파일은 의도적으로 컴파일되지 않는다
//! (수정 후 동작은 tests/integration/rhwp/cache-concurrency/decoded_lease_hardening_contract.rs).
mod surface_cache;
use std::{cell::Cell, rc::Rc};
use surface_cache::{Backing, DecodedLedger};

#[derive(Clone)]
struct Canvas(Rc<Cell<u32>>);
impl Backing for Canvas {
    fn dispose(&self) {
        self.0.set(self.0.get() + 1);
    }
}

#[test]
fn enforced_commit_above_reserved_capacity_must_not_charge_past_limit() {
    let ledger = Rc::new(DecodedLedger::default());
    let reservation = ledger.reserve(4, 0, 4, true).unwrap();
    let disposed = Rc::new(Cell::new(0));
    let lease = reservation.commit(Canvas(disposed.clone()), 8);
    let stats = ledger.stats();
    println!(
        "observed: unique_bytes={} unique_count={} reserved={} lease.bytes={} disposed={}",
        stats.unique_bytes,
        stats.unique_count,
        stats.reserved_bytes,
        lease.bytes(),
        disposed.get()
    );
    assert!(
        stats.unique_bytes <= 4,
        "enforced limit 4 but {} unique bytes were charged",
        stats.unique_bytes
    );
}

#[test]
fn overflowing_commit_must_not_return_a_disposed_backing_as_success() {
    let ledger = Rc::new(DecodedLedger::default());
    let first = ledger.reserve(usize::MAX - 1, 0, usize::MAX, false).unwrap();
    let _held = first.commit(Canvas(Rc::new(Cell::new(0))), usize::MAX - 1);
    let second = ledger.reserve(1, 0, 1, false).unwrap();
    let disposed = Rc::new(Cell::new(0));
    // 1 byte가 아니라 2 bytes로 commit하면 unique_bytes가 overflow한다.
    let lease = second.commit(Canvas(disposed.clone()), 2);
    let stats = ledger.stats();
    println!(
        "observed: returned lease bytes={} backing disposed={} accounting_errors={} unique_count={}",
        lease.bytes(),
        disposed.get(),
        stats.accounting_errors,
        stats.unique_count
    );
    assert_eq!(
        disposed.get(),
        0,
        "commit returned a lease whose backing was already disposed"
    );
}
