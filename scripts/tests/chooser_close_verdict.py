"""Verdict for a WM close request sent while the real GTK restore chooser is open.

The harness observes the frontend's geul-close-requested listener count (window.__ndCloseObserved),
which Rust emits for every CloseRequested it receives. NOT REACHABLE is only a statement about the
observed, bounded interval in the tested environment; it is never a pass of the unreachable path.
"""

NOT_REACHABLE = 'NOT REACHABLE'
DELIVERED_DURING = 'DELIVERED DURING CHOOSER'
DELIVERED_LATE = 'DELIVERED AFTER CHOOSER'
INCONCLUSIVE = 'INCONCLUSIVE'


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def classify(obs):
    """Return (verdict, reason). `obs` keys:

    observerInstalled  listener registered before the probe
    requestSent        XSendEvent accepted the WM_DELETE_WINDOW client message
    before             counter immediately before the request
    during             counter at the end of the bounded interval with the chooser open
    dialogDuring       a close confirmation appeared in that interval
    afterCancel        counter at the end of the bounded interval after cancelling the chooser
    dialogAfterCancel  a close confirmation appeared in that interval
    restoreResult      the restoreRecovery() result after cancellation ('pending' if unknown)
    published          the chosen destination exists
    appAlive           the app processes were still alive after the intervals
    """
    if not obs.get('observerInstalled'):
        return INCONCLUSIVE, 'close-event observer was not installed'
    if not obs.get('requestSent'):
        return INCONCLUSIVE, 'the WM_DELETE_WINDOW request was not sent'
    before, during, after = (_count(obs.get(k)) for k in ('before', 'during', 'afterCancel'))
    if None in (before, during):
        return INCONCLUSIVE, 'close-event count before/during the chooser is missing or invalid'
    if during < before:
        return INCONCLUSIVE, 'close-event count decreased (observer reset or replaced)'
    if during > before or obs.get('dialogDuring'):
        return DELIVERED_DURING, f'close delta {during - before} while the chooser was open'
    if after is None:
        return INCONCLUSIVE, 'close-event count after chooser cancellation is missing or invalid'
    if after < during:
        return INCONCLUSIVE, 'close-event count decreased after cancellation'
    if after > during or obs.get('dialogAfterCancel'):
        return DELIVERED_LATE, f'close delta {after - before} appeared only after the chooser closed'
    if obs.get('restoreResult', 'pending') is not None:
        return INCONCLUSIVE, f'chooser cancellation did not end restore with null: {obs.get("restoreResult")!r}'
    if obs.get('published'):
        return INCONCLUSIVE, 'a recovery destination was published'
    if not obs.get('appAlive'):
        return INCONCLUSIVE, 'the app exited without an accepted close'
    return NOT_REACHABLE, f'close delta 0 (baseline {before}) during and after the modal chooser'
