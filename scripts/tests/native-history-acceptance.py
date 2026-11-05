#!/usr/bin/env python3
"""Run unchanged T010 native protocols with the actual-document observer.

Inputs, assertions, fixtures, 3-RAF timing endpoints and 50/1500ms thresholds in
undo_native.py are unchanged. ASCII performance input uses the XKB engine.
"""
import os
import subprocess
import sys
from pathlib import Path
from native_rhwp_observer import app_observer

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'tests/integration/rhwp'))
import native_probe
import undo_native

install = native_probe.install
observer = app_observer(native_probe.INSTALL)
native_probe.install = lambda d, script=observer: install(d, script)
if __name__ == '__main__':
    if '--perf' in sys.argv:
        ibus = sys.argv[sys.argv.index('--ibus')+1] if '--ibus' in sys.argv else 'ibus'
        env = {k:v for k,v in os.environ.items() if k != 'LD_LIBRARY_PATH'}
        subprocess.run([ibus,'engine','xkb:us::eng'],env=env,check=True)
    sys.exit(undo_native.main())
