"""Execution and coverage are separate for native close probes.

Legacy status/negative fields remain readable. Summaries never count a bounded
NOT REACHABLE observation as behavior PASS, including in historical reports.
"""
import argparse
import json
from pathlib import Path

from chooser_close_verdict import classify, _count, NOT_REACHABLE, DELIVERED_DURING, INCONCLUSIVE

COVERAGE_STATES = ('PASS', NOT_REACHABLE, 'NOT RUN', INCONCLUSIVE, 'FAIL')


def observer_control(obs):
    control = obs.get('positiveControl')
    if control is None:
        return 'NOT RUN'
    if not isinstance(control, dict):
        return 'FAIL'
    before, after = (_count(control.get(k)) for k in ('before', 'after'))
    return 'PASS' if (before is not None and after is not None and after == before + 1
                      and before == obs.get('afterCancel')) else 'FAIL'


def coverage(report):
    """Derive from observations/assertions, not a top-level PASS or stored verdict alone."""
    if report.get('status') == 'NOT RUN':
        return 'NOT RUN', 'NOT RUN', 'NOT RUN', 'probe was not run'
    if report.get('mode') == 'restore-chooser':
        obs = report.get('chooserCloseDelivery', {})
        result, reason = classify(obs)
        if not isinstance(obs, dict):
            return INCONCLUSIVE, 'FAIL', 'NOT RUN', reason
        control = observer_control(obs)
        if obs.get('verdict') != result:
            return INCONCLUSIVE, 'FAIL', control, 'stored delivery verdict contradicts validated observations'
        if result == INCONCLUSIVE:
            return INCONCLUSIVE, 'FAIL', control, reason
        if result == NOT_REACHABLE:
            if control != 'PASS':
                return INCONCLUSIVE, 'FAIL', control, 'non-delivery needs a passing positive observer control'
            behavior = NOT_REACHABLE if report.get('status') == 'PASS' else INCONCLUSIVE
            return behavior, 'PASS', control, reason
        # Delivery is evidence of reachability, not proof of the product assertions.
        verified = (result == DELIVERED_DURING and obs.get('dialogDuring') is True
                    and obs.get('busyDuring') is True and obs['during'] > obs['before']
                    and obs.get('transitionVerified') is True)
        if verified and report.get('status') == 'PASS':
            return 'PASS', 'PASS', control, 'close confirmed while choosing; no publication; candidate retained; app exited'
        failed = obs.get('transitionAttempted') is True and report.get('failureKind') == 'assertion'
        return 'FAIL' if failed else INCONCLUSIVE, 'PASS', control, reason + '; transition not verified'
    cases = report.get('negative', [])
    if report.get('status') == 'PASS' and cases and all(case.get('status') == 'PASS' for case in cases):
        return 'PASS', 'NOT RUN', 'NOT RUN', 'recorded native transition assertions passed'
    if report.get('status') == 'FAIL' and report.get('failureKind') == 'assertion':
        return 'FAIL', 'NOT RUN', 'NOT RUN', 'native assertion failed (see failurePhase)'
    return INCONCLUSIVE, 'NOT RUN', 'NOT RUN', 'no complete native transition evidence'


def finalize(report):
    """Extend result.json in place; keep status/exit code as harness execution success."""
    behavior, validity, control, reason = coverage(report)
    if report.get('status') == 'PASS' and behavior not in ('PASS', NOT_REACHABLE):
        report.update(status='FAIL', failureKind=report.get('failureKind', 'observation'))
    report.update(executionStatus=report['status'], behaviorVerdict=behavior,
                  observationValidity=validity, observerControl=control, coverageReason=reason)
    report['coverageCounts'] = {state: int(state == behavior) for state in COVERAGE_STATES}


def summarize(reports):
    """Read both historical and extended reports, without rewriting either."""
    counts = dict.fromkeys(COVERAGE_STATES, 0)
    execution = dict.fromkeys(('PASS', 'FAIL', 'NOT RUN'), 0)
    for report in reports:
        # Derive legacy chooser reports too: status=PASS/negative=NOT REACHABLE is not coverage.
        behavior = coverage(report)[0]
        counts[behavior] += 1
        status = report.get('executionStatus', report.get('status', 'NOT RUN'))
        execution[status if status in execution else 'FAIL'] += 1
    return {'executionCounts': execution, 'coverageCounts': counts}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results', type=Path, nargs='+')
    args = parser.parse_args()
    print(json.dumps(summarize([json.loads(path.read_text()) for path in args.results]), indent=2))
