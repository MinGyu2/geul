"""Pure classification of one native preedit clipboard case (used by native-clipboard-preedit.py).

Evidence, all observed outside the app's internals:
- page capture listeners (observe only): the trusted command event, IME events, rendered button state;
- the app's own refusal notice in the status bar (MutationObserver, timestamped);
- an external X11 clipboard owner: TEXT_REQUEST (a Paste read the OS clipboard), SELECTION_CLEAR (a
  Copy/Cut wrote it).

Rules:
1. The intended trusted command event must have reached the app exactly once (a ribbon click must hit
   the exact command element). Silence is never evidence of blocking.
2. Every command has exactly one positive outcome: executed (OS read/write) or refused (a refusal notice
   for that command appearing after the event). Neither = lost command, both = inconsistent: FAIL.
3. A command that arrived during the IME transaction must be refused. After genuine settlement it may
   execute, or be refused only for a reason validated independently of the result (pendingEdits right
   after the IME commit, selectionRequired when the settled state has no selection).
The rendered button state at the event is recorded, but it is a React render that can trail the live
session state by a frame, so it is not used to decide.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_KO = json.loads((ROOT / 'src/language/ko.json').read_text())
REASONS = {v: k.split('.')[-1] for k, v in _KO.items() if k.startswith('command.reason.')}
LABELS = {op: _KO['command.edit.' + op] for op in ('copy', 'cut', 'paste')}
NOTICES = {k.split('.')[-1]: v for k, v in _KO.items() if k.startswith('command.unavailable.')}


def reason_of(state):
    """[disabled, title] -> None when available, else the command.reason key named in the title."""
    if not state or not state[0]:
        return None
    text = state[1].rsplit(' — ', 1)[-1] if ' — ' in state[1] else ''
    return REASONS.get(text, 'unknown:' + text)


def notice_reason(op, text):
    """The refusal reason if `text` is this command's refusal notice, else None."""
    for reason, template in NOTICES.items():
        if text == template.replace('{command}', LABELS[op]):
            return reason
    return None


def operation(action):
    op = action.split(':', 1)[1].split('+')[-1]
    return {'c': 'copy', 'x': 'cut', 'v': 'paste'}.get(op, op)


def command_events(action, action_events):
    """Trusted events that prove the intended command reached the app."""
    op = operation(action)
    if action.startswith('key:'):
        key = action[4:].split('+')[-1]
        return [e for e in action_events if e['type'] == 'keydown' and e.get('trusted') and e.get('ctrl')
                and not (e.get('shift') or e.get('alt') or e.get('meta'))
                and (e.get('key') or '').lower() == key and 'rhwp-input' in (e.get('target') or '')]
    return [e for e in action_events if e['type'] == 'click' and e.get('trusted') and e.get('command') == 'edit.' + op]


def classify(action, case_events, action_events, reads, clears, notices, settled_selection=None):
    """`notices`: [{'t', 'text'}] status-bar texts seen after priming. `settled_selection`: the copy
    button's displayed reason once the session had settled (independent selection evidence).
    Returns {'checks': [(name, ok, detail)], 'expected', 'observed', 'command', 'reason', ...}."""
    op = operation(action)
    checks = []
    commands = command_events(action, action_events)
    checks.append(('intended trusted command event delivered exactly once', len(commands) == 1,
                   [(e['type'], e.get('key'), e.get('command'), e.get('target')) for e in action_events]))
    result = {'checks': checks, 'expected': None, 'observed': None, 'command': commands[0] if commands else None,
              'reason': None, 'displayedReason': None}
    if len(commands) != 1:
        return result
    command = commands[0]
    result['displayedReason'] = reason_of((command.get('state') or {}).get(op))
    before = [e for e in case_events if e['t'] < command['t']]
    last_end = max((e['t'] for e in before if e['type'] == 'compositionend'), default=None)
    restarted = last_end is not None and any(e['type'] == 'compositionstart' and e['t'] > last_end for e in before)
    settled = last_end is not None and not restarted and not command.get('composing')
    refusals = [(n['t'], notice_reason(op, n['text'])) for n in notices if n['t'] >= command['t']]
    refusals = [r for r in refusals if r[1]]
    executed = (reads > 0) if op == 'paste' else (clears > 0)
    if executed and refusals:
        observed = 'inconsistent'
    elif op == 'paste' and reads > 1:
        observed = 'duplicate'
    elif executed:
        observed = 'execute'
    elif refusals:
        observed = 'refused-' + refusals[0][1]
    else:
        observed = 'lost'
    result['observed'] = observed
    result['reason'] = refusals[0][1] if refusals else None
    result['expected'] = 'refused (IME unsettled)' if not settled else 'execute, or refusal with a validated reason'
    checks.append(('command has exactly one positive outcome (executed or refusal notice)',
                   observed not in ('lost', 'inconsistent', 'duplicate'),
                   {'observed': observed, 'reads': reads, 'clears': clears, 'notices': notices}))
    if not settled:
        checks.append(('command during unsettled IME was refused', observed.startswith('refused-'), observed))
    elif observed.startswith('refused-'):
        reason = observed[len('refused-'):]
        if reason == 'pendingEdits':
            commits = [e for e in before if e['type'] == 'compositionend' and e.get('data')]
            ok = bool(commits) and command['t'] - commits[-1]['t'] < 500
            checks.append(('pendingEdits refusal is genuine (IME commit being applied)', ok, [e['type'] for e in before[-8:]]))
        elif reason == 'selectionRequired':
            checks.append(('selectionRequired refusal is genuine (settled state has no selection)',
                           op in ('copy', 'cut') and settled_selection == 'selectionRequired', settled_selection))
        else:
            checks.append(('refusal reason is one this scenario can legitimately produce', False, reason))
    return result
