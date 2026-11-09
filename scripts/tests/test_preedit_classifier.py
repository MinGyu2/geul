"""The native preedit classifier must fail for lost, misdirected, premature, duplicated, inconsistent
or wrongly justified commands. Event shapes follow what native runs actually recorded."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preedit_classifier import LABELS, NOTICES, REASONS, classify  # noqa: E402

TITLE = {v: k for k, v in REASONS.items()}


def state(paste=None, copy='selectionRequired', cut='selectionRequired'):
    def one(label, reason):
        return [False, label] if reason is None else [True, f'{label} — {TITLE[reason]}']
    return {'paste': one('붙여넣기 (Ctrl+V)', paste), 'copy': one('복사 (Ctrl+C)', copy), 'cut': one('잘라내기 (Ctrl+X)', cut)}


def notice(op, reason, t):
    return {'t': t, 'text': NOTICES[reason].replace('{command}', LABELS[op])}


def composition(t0=0):
    return [
        {'type': 'compositionstart', 't': t0, 'trusted': True},
        {'type': 'compositionupdate', 't': t0 + 5, 'data': '하', 'trusted': True},
        {'type': 'compositionend', 't': t0 + 100, 'data': '', 'trusted': True},
        {'type': 'compositionend', 't': t0 + 110, 'data': '하', 'trusted': True},
    ]


def key(k, t, **kw):
    return {'type': 'keydown', 't': t, 'key': k, 'ctrl': True, 'shift': False, 'alt': False, 'meta': False,
            'trusted': True, 'target': 'rhwp-input', 'composing': False, 'state': state(), **kw}


def click(command, t, **kw):
    return {'type': 'click', 't': t, 'trusted': True, 'command': command, 'target': 'command__label', 'state': state(), **kw}


def failed(result):
    return [name for name, ok, _ in result['checks'] if not ok]


def run(action, command_events, reads=0, clears=0, notices=(), settled_selection='selectionRequired', events=None):
    events = (composition() if events is None else events) + command_events
    return classify(action, events, command_events, reads, clears, list(notices), settled_selection)


def test_settled_paste_executes_exactly_once():
    assert not failed(run('key:ctrl+v', [key('v', 200)], reads=1))
    assert failed(run('key:ctrl+v', [key('v', 200)], reads=2))                       # duplicate
    assert failed(run('key:ctrl+v', [key('v', 200)], reads=0))                       # lost: no read, no notice
    assert failed(run('key:ctrl+v', [key('v', 200)], reads=1, notices=[notice('paste', 'pendingEdits', 210)]))


def test_stale_rendered_state_does_not_decide():
    # Rendered pendingEdits at keydown, but the live session had settled and Paste ran once: valid.
    stale = run('key:ctrl+v', [key('v', 200, state=state(paste='pendingEdits'))], reads=1)
    assert not failed(stale) and stale['displayedReason'] == 'pendingEdits' and stale['observed'] == 'execute'


def test_missing_or_misdirected_command_fails():
    assert failed(run('key:ctrl+v', [], notices=[notice('paste', 'pendingEdits', 210)]))
    assert failed(run('key:ctrl+v', [key('v', 200, target='document-bar__path')], reads=1))
    assert failed(run('key:ctrl+v', [key('v', 200, trusted=False)], reads=1))
    assert failed(run('key:ctrl+v', [key('v', 200, shift=True)], reads=1))
    assert failed(run('key:ctrl+c', [key('v', 200)], reads=1))
    assert failed(run('ribbon:paste', [click('edit.copy', 200)], reads=1))
    assert failed(run('ribbon:paste', [click(None, 200)], reads=1))


def test_refusals_need_the_apps_notice_and_a_genuine_reason():
    ok = run('ribbon:paste', [click('edit.paste', 200)], notices=[notice('paste', 'pendingEdits', 205)])
    assert not failed(ok) and ok['observed'] == 'refused-pendingEdits'
    late = run('ribbon:paste', [click('edit.paste', 5000)], notices=[notice('paste', 'pendingEdits', 5005)])
    assert 'pendingEdits refusal is genuine (IME commit being applied)' in failed(late)
    other_command = run('ribbon:paste', [click('edit.paste', 200)], notices=[notice('copy', 'pendingEdits', 205)])
    assert failed(other_command)                                                      # not this command's notice
    before_event = run('ribbon:paste', [click('edit.paste', 200)], notices=[notice('paste', 'pendingEdits', 150)])
    assert failed(before_event)
    odd = run('ribbon:paste', [click('edit.paste', 200)], notices=[notice('paste', 'protected', 205)])
    assert failed(odd)


def test_selection_required_is_checked_against_the_settled_state():
    assert not failed(run('key:ctrl+c', [key('c', 200)], notices=[notice('copy', 'selectionRequired', 205)]))
    assert failed(run('key:ctrl+c', [key('c', 200)], notices=[notice('copy', 'selectionRequired', 205)],
                      settled_selection=None))
    assert failed(run('key:ctrl+v', [key('v', 200)], notices=[notice('paste', 'selectionRequired', 205)]))


def test_execution_during_unsettled_ime_fails():
    early = [e for e in composition() if e['t'] < 50]
    composing = [key('v', 50, composing=True)]
    assert failed(run('key:ctrl+v', composing, reads=1, events=early))
    assert not failed(run('key:ctrl+v', composing, notices=[notice('paste', 'composing', 55)], events=early))


def test_copy_cut_write_counts_as_execution():
    assert not failed(run('key:ctrl+x', [key('x', 200)], clears=1))
    assert failed(run('key:ctrl+x', [key('x', 200)], clears=1, notices=[notice('cut', 'selectionRequired', 210)]))
