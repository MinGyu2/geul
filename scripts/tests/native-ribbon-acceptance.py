#!/usr/bin/env python3
"""Reuse T011 native protocols with current capabilities and protected fixtures.

Prebuild: python3 scripts/cargo-geul.py build --example wordcraft_fixture
--ime-runner selects the existing IBus protocol; all its assertions are retained.
The ordinary protocol adds native keyboard navigation and checks the four current
Hangul commands, including the read-only calculation's out-of-table refusal.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import types

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--ime-runner', action='store_true')
    parser.add_argument('--native-key-tool')
    options, remaining = parser.parse_known_args()
    name = 't011_ribbon_ime_native.py' if options.ime_runner else 't011_ribbon_native.py'
    path = ROOT / 'tests/e2e' / name
    source = path.read_text()
    module = types.ModuleType('geul_current_ribbon_acceptance')
    module.__file__ = str(path)
    sys.modules[module.__name__] = module
    module.CAPABILITY_REASONS = json.loads((ROOT / 'src/language/ko.json').read_text())
    if not options.ime_runner:
        assert options.native_key_tool, '--native-key-tool is required for actual XTest keys'
        old = '''hangul and len(planned) == 3 and all(p[1] == "true" and "아직 연결되지 않은 명령" in p[2] for p in planned)'''
        new = '''hangul and len(planned) == 4 and {p[0] for p in planned} == {"hangul.charWidth", "hangul.charSpacing", "hangul.tableFormula", "hangul.insertTableFormula"} and all(p[1] == "true" and p[2].endswith(CAPABILITY_REASONS["command.reason.notInTable"] if p[0] == "hangul.tableFormula" else CAPABILITY_REASONS["command.reason.engineUnsupported"]) for p in planned)'''
        assert source.count(old) == 1, 'legacy N8 protocol changed; review it'
        source = source.replace(old, new).replace('N8 한글 도구 명령은 모두 \'아직 연결되지 않은 명령\'으로 막힘', 'N8 제품 변형 명령은 미지원, 읽기 전용 계산은 표 밖 거부')
        marker = '                    select_doc(d, "a.hwp")\n                    st = d.js(STATE)'
        assert source.count(marker) == 1
        source = source.replace(marker, '                    native_keyboard(d, check)\n' + marker)
    exec(compile(source, str(path), 'exec'), module.__dict__)
    if options.ime_runner:
        # The legacy fixture helper runs Cargo directly. Execute the approved,
        # already-built example instead; the actual application remains unmodified.
        def fixture(out):
            binary = ROOT / 'src-tauri/target/debug/examples/wordcraft_fixture'
            assert binary.is_file(), 'prebuild the fixture with cargo-geul.py'
            return json.loads(subprocess.run([str(binary), str(out)], check=True, capture_output=True, text=True).stdout)
        module.wordcraft_poc.generate_fixtures = fixture
    else:
        def keyboard(d, check):
            before = {s['displayName']: (s['revision'], s['dirty']) for s in module.ipc(d, 'document_sessions')['ok']}
            d.js('document.querySelector(".ribbon__tabs [aria-selected=true]").focus()')
            for key, expected in [('Right', '편지'), ('Left', '참조'), ('End', '도움말'), ('Home', '파일'), ('Right', '홈')]:
                subprocess.run([options.native_key_tool, 'key', key], check=True)
                module.smoke.wait_until(d, 'const t=document.querySelector(".ribbon__tabs [aria-selected=true]");return t?.textContent===arguments[0] && document.activeElement===t', expected)
                state = d.js(module.STATE)
                check('native ribbon keyboard ' + key + ' → ' + expected, state['stops'] == 1 and state['labelled'] == state['selId'])
            after = {s['displayName']: (s['revision'], s['dirty']) for s in module.ipc(d, 'document_sessions')['ok']}
            check('native ribbon keyboard preserves every document', after == before)
            module.click_tab(d, '참조')
            d.js('document.querySelector(".docx-surface .rhwp-input").focus()')
        module.native_keyboard = keyboard
    sys.argv = [str(path), *remaining]
    return module.main()


if __name__ == '__main__':
    raise SystemExit(main())
