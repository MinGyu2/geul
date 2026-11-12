"""Owned filesystem cleanup and atomic finalization for the native IBus launcher.

Process teardown remains in native-ibus-session.py. Only mkdtemp-created roots
registered by that invocation may be removed; replaced roots are left untouched.
"""
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import secrets

import t010_acceptance as gate

RESOURCE_NAMES = ('work', 'socket')


def create_directory(name, run_id, *, parent=None):
    gate.require(name in RESOURCE_NAMES and bool(run_id), 'invalid temporary resource owner')
    path = Path(tempfile.mkdtemp(prefix='geul-ibus-' if name == 'work' else 'gx-', dir=parent)).absolute()
    resource = {'name': name, 'runId': run_id, 'path': str(path), 'device': None, 'inode': None, 'uid': os.getuid(),
                'ownerMarker': '.geul-launcher-owner', 'ownerToken': secrets.token_hex(32)}
    try:
        st = path.lstat()
        resource.update(device=st.st_dev, inode=st.st_ino, uid=st.st_uid)
        with (path / resource['ownerMarker']).open('x') as marker:
            marker.write(resource['ownerToken'])
    except OSError as error:
        # Retain the created path in the ledger even if initialization fails.
        resource['creationError'] = {'type': type(error).__name__, 'message': str(error)}
    return resource


def cleanup_directories(resources, run_id):
    """Attempt every registered root independently, retaining failure diagnostics."""
    results = []
    for resource in resources:
        result = {**resource, 'attempted': False, 'deleteAttempted': False, 'ownershipVerified': False,
                  'status': 'not-performed', 'remaining': None, 'error': None}
        path = Path(resource['path'])
        try:
            gate.require(resource['runId'] == run_id and resource['name'] in RESOURCE_NAMES
                         and path.is_absolute() and type(resource['inode']) is int and resource['inode'] > 0
                         and resource['uid'] == os.getuid() and resource.get('ownerMarker') == '.geul-launcher-owner'
                         and gate.digest(resource.get('ownerToken')), 'wrong temporary resource ownership')
            result['attempted'] = True
            try:
                st = path.lstat()
            except FileNotFoundError:
                result.update(ownershipVerified=True, status='already-absent', remaining=False)
            else:
                gate.require(stat.S_ISDIR(st.st_mode) and not path.is_symlink()
                             and (st.st_dev, st.st_ino, st.st_uid) == (resource['device'], resource['inode'], resource['uid']),
                             'temporary resource replaced; refusing deletion')
                marker = path / resource['ownerMarker']
                gate.require(not marker.is_symlink() and stat.S_ISREG(marker.lstat().st_mode)
                             and marker.read_text() == resource['ownerToken'], 'temporary ownership marker missing/mismatched')
                result['ownershipVerified'] = True
                result['deleteAttempted'] = True
                try:
                    shutil.rmtree(path)
                except FileNotFoundError:
                    # A concurrently removed owned root is acceptable only if now absent.
                    if os.path.lexists(path):
                        raise
                result['remaining'] = os.path.lexists(path)
                result['status'] = 'removed' if not result['remaining'] else 'failed'
        except (OSError, ValueError) as error:
            result.update(status='failed' if result['deleteAttempted'] else 'not-performed',
                          error={'type': type(error).__name__, 'message': str(error)})
            result['remaining'] = os.path.lexists(path)
        results.append(result)
    return results


def atomic_json(path, value):
    path = Path(path)
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='.' + path.name + '-', suffix='.pending',
                                         dir=path.parent, delete=False) as f:
            pending = Path(f.name)
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(pending, path)
    finally:
        if pending is not None and pending.exists():
            pending.unlink()


def prepare_report(path, run_id):
    """Invalidate a previous result before starting this invocation, never after it."""
    path = Path(path)
    # A new output directory is created by the child harness (production requires
    # it not to exist). With no parent there cannot be an old authoritative PASS.
    if not path.parent.exists():
        return
    gate.require(not path.is_symlink(), 'acceptance report must not be a symlink')
    atomic_json(path, {'status': 'PENDING_CLEANUP', 'runId': run_id, 'phase': 'launcher-starting'})


def finalize_report(path, identity, cleanup, command_code, *, writer=atomic_json):
    """Return final launcher exit code; a failed replacement leaves no authoritative PASS."""
    path = Path(path)
    try:
        report = json.loads(path.read_text())
        gate.require(report.get('runId') == identity['runId'], 'report from wrong invocation')
        gate.require(report.get('status') != 'PASS', 'child claimed PASS before launcher cleanup')
        inner = (gate.verdict(gate.production, report, report.get('expectedIdentity', {})) if 'formats' in report
                 else gate.verdict(gate.usability, report, report.get('formatsRequested'), report.get('cases')))
        # A failed command or earlier native failure remains a failure, even if cleanup succeeds.
        previous_failure = report.get('status') in ('FAIL', 'INCONCLUSIVE') or command_code != 0
        if identity.get('error'):
            report['launcherError'] = identity['error']
            previous_failure = True
        report['nativeExecutionStatus'] = report.get('status')
        report['nativeCommandExit'] = command_code
        report['nativeAcceptance'] = report.get('acceptance')
        report['acceptance'] = inner
        report['launcherCleanup'] = cleanup
        report['launcherAcceptance'] = gate.verdict(gate.launcher_cleanup, report, identity, cleanup)
        # Only a completed child awaiting outer cleanup is eligible for final success.
        ok = (report['nativeExecutionStatus'] == 'PENDING_CLEANUP' and not previous_failure
              and inner['status'] == 'PASS' and report['launcherAcceptance']['status'] == 'PASS')
        report['status'] = 'PASS' if ok else 'FAIL'
        code = 0 if ok else (command_code or 3)
        report['launcherExit'] = code
        if 'formatsRequested' in report:
            report['usabilityCoverage'] = gate.usability_coverage(report, report['formatsRequested'], report.get('cases'))
            if not ok and report['usabilityCoverage']['fullUsabilityCoverage'] == 'PASS':
                report['usabilityCoverage']['fullUsabilityCoverage'] = 'FAIL'
        writer(path, report)
        return code
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        failure = {'status': 'FAIL', 'runId': identity['runId'], 'launcherExit': command_code or 2,
                   'phase': 'finalization-failed', 'error': f'{type(error).__name__}: {error}'}
        # Use the normal writer independently if an injected/failed final writer left a child PASS.
        # A pending/failed child is already safe and is retained with its native diagnostics.
        try:
            current = json.loads(path.read_text())
            if current.get('status') == 'PASS':
                try:
                    atomic_json(path, {**current, **failure})
                except OSError:
                    path.unlink()  # this explicitly designated report cannot remain authoritative PASS
        except (OSError, ValueError, AttributeError):
            pass
        try:
            atomic_json(path.with_name(path.name + '.finalization.json'), failure)
        except OSError:
            pass  # Nonzero launcher exit and stderr still report an unwritable filesystem.
        print('ACCEPTANCE FINALIZATION FAILED:', failure['error'], file=__import__('sys').stderr)
        return failure['launcherExit']
