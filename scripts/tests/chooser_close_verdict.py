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
    # A missing value is unknown, never a negative observation. Validate supplied boolean
    # observations even on partial delivery paths; future observations need not exist yet.
    if not isinstance(obs, dict):
        return INCONCLUSIVE, 'observations are missing or invalid'
    for key in ('observerInstalled', 'requestSent', 'dialogDuring', 'dialogAfterCancel', 'published', 'appAlive'):
        if key in obs and type(obs[key]) is not bool:
            return INCONCLUSIVE, f'{key} is not a boolean observation'
    if obs.get('observerInstalled') is not True:
        return INCONCLUSIVE, 'close-event observer was not installed'
    if obs.get('requestSent') is not True:
        return INCONCLUSIVE, 'the WM_DELETE_WINDOW request was not sent'
    before, during, after = (_count(obs.get(k)) for k in ('before', 'during', 'afterCancel'))
    if None in (before, during):
        return INCONCLUSIVE, 'close-event count before/during the chooser is missing or invalid'
    if during < before:
        return INCONCLUSIVE, 'close-event count decreased (observer reset or replaced)'
    if 'afterCancel' in obs and (after is None or after < during):
        return INCONCLUSIVE, 'close-event count after cancellation is invalid or decreased'
    if 'dialogDuring' not in obs:
        return INCONCLUSIVE, 'dialog observation during the chooser is missing'
    if during > before or obs['dialogDuring'] is True:
        return DELIVERED_DURING, f'close delta {during - before} while the chooser was open'
    if after is None:
        return INCONCLUSIVE, 'close-event count after chooser cancellation is missing or invalid'
    if 'dialogAfterCancel' not in obs:
        return INCONCLUSIVE, 'dialog observation after cancellation is missing'
    if after > during or obs['dialogAfterCancel'] is True:
        return DELIVERED_LATE, f'close delta {after - before} appeared only after the chooser closed'
    if 'restoreResult' not in obs or obs['restoreResult'] is not None:
        return INCONCLUSIVE, 'chooser cancellation did not explicitly end restore with null'
    if obs.get('published') is not False:
        return INCONCLUSIVE, 'absence of a recovery publication was not observed'
    if obs.get('appAlive') is not True:
        return INCONCLUSIVE, 'app survival was not observed'
    return NOT_REACHABLE, f'close delta 0 (baseline {before}) during and after the modal chooser'
