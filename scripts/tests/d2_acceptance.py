#!/usr/bin/env python3
"""Prospective supported-runtime D2 gate; original E/U/F gate stays independent.

Consumes complete original native reports plus additional native safety oracles.
Never treats a missing/unsafe row as covered. Raw reports remain immutable.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

# Keep this evaluator independent of private test modules and native processes.
CASES = ('repeat-syllables', 'same-after-click', 'new-start-after-click', 'ordinary-key-between',
         'different-after-click', 'english', 'shift-redo', 'caret', 'focus-native', 'tab-ownership',
         'reload-generation', 'close-reopen', 'busy-key', 'busy-click', 'busy-button',
         'rhwp-wordcraft', 'wordcraft-rhwp')
GATE_SUFFIXES = (
    '선택 없는 취소는 문서/판/기록을 만들지 않음', '부분 Backspace는 하를 잃지 않고 학으로 확정·Undo',
    '여러 자모를 모두 취소해도 revision/기록 추가 없음', '조합 중 Ctrl+Z가 조합을 깨지 않음',
    '확정한 조합(한글) Ctrl+Z → 한 단계로 되돌림, Ctrl+Y → 정확히 복원',
    '이어진 한글 음절은 한 단계, 앞 그룹과 경계 유지',
    '선택을 조합으로 바꾸다 취소 → 바로 Ctrl+Z가 선택 글자를 되살림',
    '취소 직후 Undo의 Ctrl+Y/Ctrl+Shift+Z와 정확한 선택 복원',
    'native 1ms Backspace→Ctrl+Z, 원래 선택/글자와 revision+2',
    '조합 중 클릭(앱 확정·늦은 최종 글자) 뒤 Ctrl+Z → 그 조합만 되돌리고 Ctrl+Y → 복원',
    '조합 중 초점 잃음 뒤 돌아와 친 글자는 따로 된 단계(첫 Ctrl+Z가 뒤 글자만)',
    '빠른 연속 한글 → 음절 누락 없음, Ctrl+Z 한 번, Ctrl+Y 정확히')
CLOSE_GATE = '실행 취소·다시 실행 뒤 닫고 다시 열면 Ctrl+Z가 아무것도 바꾸지 않음'
GAP_SUFFIX = '실제 빈 끝~late final 사이 Ctrl+Z 거절·앞 거래 보존·나중 Undo/Redo'
GAP_MODES = [('key', 0), ('key', 1), ('key', 5), ('pointer', 0), ('pointer', 1), ('button', 0), ('button', 0)]


ASSERTIONS = {
    **{k: ('firstExact', 'newInputPreserved') for k in CASES[:5]},
    **{k: ('exactTextAndRedo', 'cursorRestored', 'revisionForward') for k in ('english','shift-redo')},
    'caret': ('anchoredInsertion','cursorRedo'), 'focus-native': ('focusInputPreserved','separateTransaction'),
    'tab-ownership': ('ownerText','otherUnchanged'), 'reload-generation': ('generationAdvanced','noOldTailOrHistory'),
    'close-reopen': ('newSession','noStaleHistoryOrInput'),
    **{k: ('noDuplicateOrLoss','exactRevision','newIdenticalInputPreserved') for k in ('busy-key','busy-click','busy-button')},
    **{k: ('noCrossContamination','newTargetInputPreserved','targetRevisionExact') for k in ('rhwp-wordcraft','wordcraft-rhwp')},
}
ASSERTIONS['new-start-after-click'] += ('newCompositionStart',)
ASSERTIONS['busy-button'] += ('redoExact','twoExplicitUndoRequests')


def required_assertions(case):
    common = ('trustedNativeInput','traceComplete','modelTextMatches')
    if case not in ('rhwp-wordcraft','wordcraft-rhwp'):
        common += ('readyAndCertain','revisionSynchronized')
    return common + ASSERTIONS[case]


SOURCE_PATHS = ('src/components/Editor/textInput.ts','src/components/CommandButton/editorFocus.ts',
    'src/components/Editor/rhwp/imeInput.ts','src/components/Editor/rhwp/RhwpEditorSession.ts',
    'src/components/Editor/rhwp/rhwpHistory.ts','src/components/Editor/rhwp/RhwpSurface.tsx',
    'src/components/Editor/wordcraft/DocxSurface.tsx','src/commands/registry.ts','src/commands/capability.ts')


def valid_identity(ex):
    digest = lambda value,n=64: isinstance(value,str) and re.fullmatch('[0-9a-f]{'+str(n)+'}',value) is not None
    runtime,identity = ex.get('runtime'),ex.get('servedIdentity')
    if not isinstance(runtime,dict) or not isinstance(identity,dict):return False
    if not all(runtime.get(k) for k in ('os','displayServer','nativeHost','webkitgtk','gtk','ibus','engine')):return False
    if runtime.get('generalHistoryConfiguration') != {'VITE_GEUL_TEST_HOOKS':'1','VITE_GEUL_TEST_RHWP_HISTORY':'1','GEUL_RHWP_PROFILE':'release'}:return False
    if identity.get('engine')!='rhwp' or identity.get('profile')!='release' or not digest(identity.get('commit'),40) or not digest(identity.get('generation')):return False
    if not all(digest(identity.get('artifacts',{}).get(k)) for k in ('rhwp.js','rhwp_bg.wasm')):return False
    integration=identity.get('integration',{});patches=integration.get('patches')
    if not digest(integration.get('sourceTreeSha256')) or not isinstance(patches,list) or not patches:return False
    if not all(isinstance(p,dict) and p.get('name') and digest(p.get('sha256')) for p in patches):return False
    sources=ex.get('applicationSourceSha256',{})
    if not isinstance(sources,dict) or not all(digest(sources.get(k)) for k in SOURCE_PATHS):return False
    hashes=ex.get('toolHashes',{})
    if not isinstance(hashes,dict) or not hashes or not all(digest(v) for v in hashes.values()):return False
    return digest(ex.get('head'),40) and all(digest(ex.get(k)) for k in ('appSha256','runnerSha256','viteConfigSha256','supplementHarnessSha256'))


def observed(trace):
    """Original native-d2-order.py E/U/F predicate, preserved verbatim in that file.

    Recomputed here from original records so an adapter's status cannot invent coverage.
    """
    records = trace['records']
    empty = [r[0] for r in records if r[2] == 'dom:compositionend' and r[3]['length'] == 0]
    final = [r[0] for r in records if r[2] == 'dom:input' and r[3]['inputType'] == 'insertFromComposition' and r[3]['length'] > 0]
    gap = lambda seq: any(e < seq < f for e in empty for f in final)
    requests = [r for r in records if r[2] == 'command:request' and r[3]['id'] == 'edit.undo']
    command = any(gap(r[0]) and r[3]['reason'] == 'composing' for r in requests)
    chord = any(gap(r[0]) and r[2] in ('dom:keydown', 'dom:keyup') and r[3].get('key') == 'mod:KeyZ' for r in records)
    return command or chord


def supplement_orderings(trace):
    """Apply the ORIGINAL predicate to one empty-end → first-final trial at a time.

    Supplemental rows include later deliberate new typing/Redo, unlike the
    original diagnostic's initial-trial trace. An E from an old transaction must
    never pair with a later composition's F (or a reset repeat after its first F).
    """
    pending = None
    seen = 0
    for record in trace.get('records',[]):
        kind,detail = record[2],record[3] or {}
        if kind=='dom:compositionstart':
            pending=None
        if kind=='dom:compositionend' and detail.get('length')==0:
            if pending is None:pending=[]
        if pending is not None:
            pending.append(record)
            if kind=='dom:input' and detail.get('inputType')=='insertFromComposition' and detail.get('length',0)>0:
                seen += int(observed({'records':pending}))
                pending=None
    return seen


def evaluate(baseline, execution, supplement, supplement_execution):
    missing, failures = [], []
    compat_seen, compat_failed, complete_gap, compat_pending = 0, False, 0, False
    required = [f'{fmt}: {suffix}' for fmt in ('hwp', 'hwpx') for suffix in GATE_SUFFIXES]+[CLOSE_GATE]
    gates = baseline.get('gates', [])
    for name in required:
        matching = [g for g in gates if g.get('gate') == 'D2' and g.get('item') == name]
        if len(matching) != 1 or matching[0].get('result') not in ('PASS', 'FAIL'):
            missing.append(name)
        elif matching[0]['result'] == 'FAIL':
            failures.append(name)
    # No confirmed safety failure, including unexpected extra gates, is ignored.
    failures += [g.get('item', 'unnamed gate') for g in gates if g.get('result') == 'FAIL']
    for fmt in ('hwp', 'hwpx'):
        rows = baseline.get('measurements', {}).get('nativeFinalGap', {}).get(fmt, [])
        if [(r.get('mode'), r.get('delayMs')) for r in rows] != GAP_MODES:
            missing.append(f'{fmt}: complete original seven-trial gap matrix')
        original = [g for g in gates if g.get('item') == f'{fmt}: {GAP_SUFFIX}']
        if len(original) != 1:
            missing.append(f'{fmt}: original compatibility gate')
        for i, row in enumerate(rows):
            safe = row.get('safe')
            if safe is False:
                failures.append(f'{fmt}:gap:{i}')
            elif safe is not True:
                missing.append(f'{fmt}:gap:{i}:safety')
            trace = row.get('trace', {})
            if trace.get('dropped') != 0 or not trace.get('records'):
                missing.append(f'{fmt}:gap:{i}:trace')
                continue
            complete_gap += 1
            seen = observed(trace)
            if seen:
                compat_seen += 1
                # Original assertions must also pass when the original ordering is observed.
                if safe is not True or not original or original[0].get('result') != 'PASS':
                    compat_failed = True
                    failures.append(f'{fmt}: observed E/U/F original safety not PASS')
    rows = supplement.get('measurements', {}).get('supportedNative', [])
    for row in rows:
        if any(v is not True for v in row.get('assertions',{}).values()):
            failures.append(f"{row.get('format')}:{row.get('case')}:assertions")
        seen = supplement_orderings(row.get('trace',{}))
        if seen:
            compat_seen += seen
            # A newly observed ordering in ANY supported scenario requires the
            # original native assertion suite; generic state checks cannot replace it.
            if any(v is not True for v in row.get('assertions',{}).values()):
                compat_failed = True
            else:
                compat_pending = True
                missing.append('supplement E/U/F: original native assertions not run for this trace')
    for fmt in ('hwp', 'hwpx'):
        for case in CASES:
            matching = [r for r in rows if (r.get('format'), r.get('case')) == (fmt, case)]
            if len(matching) != 1:
                missing.append(f'{fmt}:{case}')
                continue
            row = matching[0]
            checks = row.get('assertions', {})
            if any(key not in checks for key in required_assertions(case)):
                missing.append(f'{fmt}:{case}:mandatory assertions')
            if any(v is not True for v in checks.values()):
                failures.append(f'{fmt}:{case}:assertions')
            native = [e for e in row.get('events', []) if e.get('type') in ('keydown', 'input', 'compositionend')]
            if not native or any(e.get('trusted') is not True for e in row.get('events', [])):
                missing.append(f'{fmt}:{case}:trusted native events')
            if row.get('trace', {}).get('dropped') != 0 or not row.get('states'):
                missing.append(f'{fmt}:{case}:state/trace')
    failures += [g.get('item', 'unnamed supplement gate') for g in supplement.get('gates', []) if g.get('result') == 'FAIL']
    for name, ex in [('baseline', execution), ('supplement', supplement_execution)]:
        if not valid_identity(ex):
            missing.append(f'{name}:complete supported runtime/source/build identity')
        if (ex.get('sharedProbe') is not True or ex.get('imModule') != 'ibus'
            or ex.get('sourceStable') is not True or ex.get('applicationSourceStable') is not True or ex.get('appStable') is not True
            or ex.get('cleanup', {}).get('cleanupSucceeded') is not True
            or ex.get('cleanup', {}).get('survivors') != []):
            missing.append(f'{name}:native execution/cleanup identity')
        for field in ('head', 'appSha256', 'toolHashes', 'servedIdentity', 'servedHashes', 'viteConfigSha256', 'runnerSha256', 'ibus', 'ibusHangul', 'applicationSourceSha256', 'runtime', 'supplementHarnessSha256'):
            if not ex.get(field):
                missing.append(f'{name}:{field}')
        expected_exit = int(any(g.get('result') != 'PASS' for g in gates)) if name == 'baseline' else 0
        if ex.get('producerExit') != expected_exit:
            missing.append(f'{name}:producer termination')
    for field in ('head', 'appSha256', 'servedIdentity', 'servedHashes', 'viteConfigSha256', 'runnerSha256', 'applicationSourceSha256', 'runtime'):
        if execution.get(field) != supplement_execution.get(field):
            missing.append('execution mismatch:'+field)
    if baseline.get('measurements', {}).get('keyDelivery') != 'native X11 xdotool' or supplement.get('measurements', {}).get('keyDelivery') != 'native X11 xdotool':
        missing.append('native X11 input provenance (synthetic tests insufficient)')
    compat = ('VERIFIED FAIL' if compat_failed else 'NOT RUN' if compat_pending else 'VERIFIED PASS' if compat_seen else
              'NOT OBSERVED / UNVERIFIED' if complete_gap else 'NOT RUN')
    return {'policy': 'T010-D2-supported-runtime-v1',
            'supportedEnvironmentD2': 'FAIL' if failures else 'INCONCLUSIVE' if missing else 'PASS',
            'eufCompatibility': compat, 'eufObservedTrials': compat_seen,
            'mandatoryCounts': {'originalSafetyGates': len(required), 'originalGapTrials': complete_gap,
                                'supplementScenarios': len(rows)},
            'failures': sorted(set(failures)), 'missing': sorted(set(missing)),
            'otherEnvironments': 'NOT RUN / UNVERIFIED', 't010Functional': 'INCOMPLETE',
            'generalRhwpHistoryProduction': 'NO-GO', 'd4Performance': 'TARGET NOT MET'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('baseline', 'execution', 'supplement', 'supplement-execution', 'out'):
        p.add_argument('--'+name, type=Path, required=True)
    args = p.parse_args()
    paths = [args.baseline, args.execution, args.supplement, args.supplement_execution]
    result = evaluate(*(json.loads(path.read_text()) for path in paths))
    result['evidence'] = [{'path': str(p.resolve()), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths]
    result['environmentIdentity'] = json.loads(args.execution.read_text())
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({k: result[k] for k in ('supportedEnvironmentD2', 'eufCompatibility', 'mandatoryCounts', 'failures', 'missing')}, ensure_ascii=False))
    return 0 if result['supportedEnvironmentD2'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
