//! Operation-owned reservations, not a process heap/RSS cap. Production has no new
//! finite byte policy. Charges conservatively last until the blocking owner exits.
use super::{DocumentError, LimitKind};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Category {
    Ipc,
    Payload,
    Original,
    Expanded,
    Decoder,
    Index,
    Staging,
    Parsing,
    Comparison,
    BeforePublication,
}
#[derive(Default)]
struct State {
    used: usize,
    peak: usize,
    categories: [usize; 10],
    category_peaks: [usize; 10],
    limit: Option<usize>,
    #[cfg(test)]
    deny: Option<Category>,
}
#[derive(Default)]
pub(crate) struct Pool(Mutex<State>);
pub(crate) struct Operation {
    pool: Arc<Pool>,
    bytes: Mutex<(usize, [usize; 10])>,
    failed: AtomicBool,
    failure_epoch: AtomicUsize,
    publication: AtomicU8,
}
pub(crate) fn refused() -> DocumentError {
    DocumentError::ResourceLimit {
        limit: LimitKind::Memory,
    }
}
impl Pool {
    pub fn operation(self: &Arc<Self>) -> Arc<Operation> {
        Arc::new(Operation {
            pool: self.clone(),
            bytes: Mutex::new((0, [0; 10])),
            failed: AtomicBool::new(false),
            failure_epoch: AtomicUsize::new(0),
            publication: AtomicU8::new(0),
        })
    }
    #[cfg(test)]
    pub fn limited(limit: usize) -> Arc<Self> {
        Arc::new(Self(Mutex::new(State {
            limit: Some(limit),
            ..State::default()
        })))
    }
    #[cfg(test)]
    pub fn deny(&self, category: Option<Category>) {
        self.0.lock().unwrap().deny = category;
    }
    #[cfg(test)]
    pub fn category_peaks(&self) -> [usize; 10] {
        self.0.lock().unwrap().category_peaks
    }
    #[cfg(test)]
    pub fn usage(&self) -> (usize, usize) {
        let s = self.0.lock().unwrap();
        (s.used, s.peak)
    }
}
impl Operation {
    pub fn charge(&self, category: Category, bytes: usize) -> Result<(), DocumentError> {
        let mut pool = self.pool.0.lock().map_err(|_| DocumentError::Internal)?;
        let mut own = self.bytes.lock().map_err(|_| DocumentError::Internal)?;
        let reject = || {
            self.failed.store(true, Ordering::Release);
            self.failure_epoch.fetch_add(1, Ordering::AcqRel);
            refused()
        };
        let used = pool.used.checked_add(bytes).ok_or_else(reject)?;
        let next = own.0.checked_add(bytes).ok_or_else(reject)?;
        let slot = category as usize;
        let category_total = pool.categories[slot]
            .checked_add(bytes)
            .ok_or_else(reject)?;
        let owned_category = own.1[slot].checked_add(bytes).ok_or_else(reject)?;
        #[cfg(test)]
        if pool.deny == Some(category) {
            return Err(reject());
        }
        if pool.limit.is_some_and(|limit| used > limit) {
            return Err(reject());
        }
        pool.used = used;
        pool.peak = pool.peak.max(used);
        own.0 = next;
        own.1[slot] = owned_category;
        pool.categories[slot] = category_total;
        pool.category_peaks[slot] = pool.category_peaks[slot].max(category_total);
        Ok(())
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let own = *self.bytes.lock().unwrap_or_else(|e| e.into_inner());
        let mut pool = self.pool.0.lock().unwrap_or_else(|e| e.into_inner());
        pool.used = pool
            .used
            .checked_sub(own.0)
            .expect("owned reservation invariant");
        for (used, owned) in pool.categories.iter_mut().zip(own.1) {
            *used = used
                .checked_sub(owned)
                .expect("category reservation invariant");
        }
    }
}
thread_local! { static CURRENT: RefCell<Option<Arc<Operation>>> = const { RefCell::new(None) }; }
pub(crate) fn charge(category: Category, bytes: usize) -> Result<(), DocumentError> {
    CURRENT.with(|current| match current.borrow().as_ref() {
        Some(op) => op.charge(category, bytes),
        None => Ok(()),
    })
}
pub(crate) fn scope<T>(operation: Arc<Operation>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<Arc<Operation>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|c| {
                c.replace(self.0.take());
            });
        }
    }
    let _restore = Restore(CURRENT.with(|c| c.replace(Some(operation))));
    work()
}

/// Record a selected fallible allocator failure while preserving its provenance
/// through legacy Invalid-returning parser APIs. Only the active operation is affected.
pub(crate) fn allocation_refused() {
    CURRENT.with(|c| {
        if let Some(op) = c.borrow().as_ref() {
            op.failed.store(true, Ordering::Release);
            op.failure_epoch.fetch_add(1, Ordering::AcqRel);
        }
    });
}
pub(crate) fn failed() -> bool {
    CURRENT.with(|c| {
        c.borrow()
            .as_ref()
            .is_some_and(|op| op.failed.load(Ordering::Acquire))
    })
}

/// Caller cancellation marks work, but NEVER releases its owned reservation.
pub(crate) struct Cancellation {
    operation: Arc<Operation>,
    armed: bool,
}
impl Cancellation {
    pub fn new(operation: Arc<Operation>) -> Self {
        Self {
            operation,
            armed: true,
        }
    }
    pub fn disarm(&mut self) {
        self.armed = false;
    }
}
impl Drop for Cancellation {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.operation.publication.compare_exchange(
                0,
                1,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }
}
pub(crate) fn active() -> Result<(), DocumentError> {
    CURRENT.with(|c| {
        if c.borrow()
            .as_ref()
            .is_some_and(|op| op.publication.load(Ordering::Acquire) == 1)
        {
            Err(DocumentError::InvalidRequest)
        } else {
            Ok(())
        }
    })
}

/// Cancellation linearizes before this permit; after it, atomic publication owns
/// completion. No blocking mutex is acquired by the async caller's Drop.
pub(crate) fn publication<T>(
    work: impl FnOnce() -> Result<T, DocumentError>,
) -> Result<T, DocumentError> {
    let operation = CURRENT.with(|c| c.borrow().clone());
    if let Some(op) = operation.as_ref() {
        op.publication
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| DocumentError::InvalidRequest)?;
    }
    let result = work();
    if let Some(op) = operation {
        op.publication.store(3, Ordering::Release);
    }
    result
}

pub(crate) fn failure_epoch() -> usize {
    CURRENT.with(|c| {
        c.borrow()
            .as_ref()
            .map_or(0, |op| op.failure_epoch.load(Ordering::Acquire))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_boundary_shared_concurrent_overflow_and_raii() {
        let pool = Pool::limited(8);
        let a = pool.operation();
        let b = pool.operation();
        a.charge(Category::Payload, 3).unwrap();
        b.charge(Category::Payload, 5).unwrap();
        assert_eq!(pool.usage(), (8, 8));
        assert_eq!(b.charge(Category::Payload, 1), Err(refused()));
        assert_eq!(pool.usage(), (8, 8));
        drop(a);
        assert_eq!(pool.usage(), (5, 8));
        drop(b);
        assert_eq!(pool.usage(), (0, 8));
        let operation = pool.operation();
        operation.charge(Category::Payload, 8).unwrap();
        drop(operation);
        assert_eq!(pool.usage(), (0, 8));
        let large = Pool::limited(usize::MAX);
        let op = large.operation();
        op.charge(Category::Payload, usize::MAX).unwrap();
        assert_eq!(op.charge(Category::Payload, 1), Err(refused()));
        drop(op);
        assert_eq!(large.usage().0, 0);
    }
    #[test]
    fn overlapping_workers_own_their_reservations_and_panics_restore_scope() {
        let pool = Pool::limited(12);
        let barrier = std::sync::Barrier::new(3);
        std::thread::scope(|threads| {
            let a = pool.operation();
            let b = pool.operation();
            let run = |operation| {
                scope(operation, || {
                    charge(Category::Original, 6).unwrap();
                    barrier.wait();
                    barrier.wait();
                })
            };
            threads.spawn(move || run(a));
            threads.spawn(move || run(b));
            barrier.wait();
            assert_eq!(pool.usage().0, 12);
            barrier.wait();
        });
        assert_eq!(pool.usage().0, 0);
        let _ = std::panic::catch_unwind(|| {
            scope(pool.operation(), || {
                charge(Category::Original, 2).unwrap();
                panic!("controlled worker panic");
            })
        });
        assert_eq!(pool.usage().0, 0);
        assert!(!failed());
    }
}
