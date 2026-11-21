#!/usr/bin/env python3
"""Run Stage 3-A on GDK Wayland in a test-owned nested Weston compositor."""
import argparse
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]


def load_workstream(number):
    entry = ROOT / f"scripts/tests/native-stage3a-p{number}.py"
    spec = importlib.util.spec_from_file_location(f"stage3a_p{number}", entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


p4, p5, p6 = (load_workstream(number) for number in (4, 5, 6))
h = p6.h
cases = {key: module.h.CASES[key] for key, module in (
    ("P4-H5-SEG-LINE", p4), ("P4-H5-POLY-POINT", p4),
    ("P5-DX-STORY-SIZE", p5), ("P5-TB-RANGE", p5),
    ("P6-HX-CAP-LEFT", p6), ("P6-HX-CAP-RIGHT", p6), ("P6-DX-TYPE", p6),
)}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--weston", required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--fixtures", type=Path, required=True)
parser.add_argument("--app", type=Path, required=True)
parser.add_argument("--xdotool", required=True)
parser.add_argument("--ibus", required=True)
parser.add_argument("--case", choices=cases, default="P6-HX-CAP-LEFT")
parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
args = parser.parse_args()
args.out = args.out.resolve()
args.fixtures = args.fixtures.resolve()
args.app = args.app.resolve()
args.out.mkdir(parents=True, exist_ok=False)

outer_environment = os.environ.copy()
socket = "geul-stage3a-wayland"
report = {"appSha256": h.digest(args.app), "cases": {}, "backend": "GDK Wayland, Weston 15 nested X11 host, no XWayland"}
row = report["cases"][args.case] = {}
h.p4.smoke.APP = str(args.app)
h.p4.smoke.DRIVER_LOG = str(args.out / "wayland-driver.log")


class WaylandAcceptance(h.p4.P4Acceptance):
    def command(self, *argv):
        if argv[0] == self.args.xdotool:
            return subprocess.check_output(argv, env=outer_environment, text=True).strip()
        return super().command(*argv)

    def open_native(self, fmt, path):
        self.wait("return document.hasFocus()", timeout=10)
        self.key("ctrl+o")
        self.wait("return !document.hasFocus()", timeout=10)
        self.key("ctrl+l", "ctrl+a")
        self.type(str(path))
        self.key("Return")
        deadline = time.monotonic() + 2
        while not self.d.js("return document.hasFocus()") and time.monotonic() < deadline:
            time.sleep(0.1)
        if not self.d.js("return document.hasFocus()"):
            self.key("Return")
        self.ready(fmt, path.name)

    def pointer(self, point):
        x, y = self.d.js("""
          const [page,x,y] = arguments[0], c=document.querySelectorAll(arguments[1])[page];
          const s=document.querySelector('.editor__scroll'), r=c.getBoundingClientRect();
          const k=r.width/c.clientWidth, v=s.getBoundingClientRect();
          s.scrollTop+=r.top+y*k-(v.top+v.height/2);
          const after=c.getBoundingClientRect();
          return [(after.left+x*k)*devicePixelRatio,(after.top+y*k)*devicePixelRatio];
        """, list(point), ".docx-page canvas" if args.case in {"P5-DX-STORY-SIZE", "P6-DX-TYPE"} else ".rhwp-page__canvas")
        self.command(self.args.xdotool, "mousemove", "--window", self.window, str(round(x)), str(round(y)), "click", "1")


with (args.out / "weston-stderr.log").open("w") as stderr:
    weston = subprocess.Popen([
        args.weston, "--backend=x11", "--renderer=pixman", "--shell=kiosk",
        f"--socket={socket}", "--no-config", "--idle-time=0", "--width=1280", "--height=900",
        f"--log={args.out / 'weston.log'}",
    ], env=outer_environment, stdout=stderr, stderr=stderr)
    try:
        deadline = time.monotonic() + 10
        log = args.out / "weston.log"
        while True:
            window = re.search(r"x11 output 1280x900, window id (\d+)", log.read_text()) if log.exists() else None
            if window and (Path(os.environ["XDG_RUNTIME_DIR"]) / socket).exists():
                break
            h.require(weston.poll() is None and time.monotonic() < deadline, "isolated Weston did not open its output")
            time.sleep(0.1)
        outer = window[1]
        subprocess.run([args.xdotool, "windowfocus", "--sync", outer], env=outer_environment, check=True)
        os.environ.pop("DISPLAY")
        os.environ.update(WAYLAND_DISPLAY=socket, GDK_BACKEND="wayland", GTK_IM_MODULE="simple", GTK_USE_PORTAL="0", WAYLAND_DEBUG="client")
        with tempfile.TemporaryDirectory(prefix="geul-stage3a-wayland-") as profile:
            with h.p4.smoke.tauri_driver(args.driver, 4479, profile) as start:
                driver = start()
                try:
                    acc = WaylandAcceptance(args, driver, row)
                    acc.window = outer
                    acc.wait("return !!document.querySelector('.document-bar')", timeout=30)
                    pids = [pid for pid in h.p4.smoke.pids_with(profile)
                            if Path(f"/proc/{pid}/exe").resolve() == args.app]
                    h.require(len(pids) == 1, "could not identify Wayland application process", pids)
                    env = Path(f"/proc/{pids[0]}/environ").read_bytes().split(b"\0")
                    h.require(b"GDK_BACKEND=wayland" in env and not any(e.startswith(b"DISPLAY=") for e in env),
                              "application is not forced to native Wayland")
                    row["processAppSha256"] = h.digest(Path(f"/proc/{pids[0]}/exe"))
                    h.require(row["processAppSha256"] == report["appSha256"], "unexpected live application binary")
                    acc.calibrate_pointer()
                    for module in (p4, p5, p6):
                        module.h.p6.pointer = lambda current, point: current.pointer(point)
                    acc.d.js("""
                      window.actualWaylandInput=[];
                      for (const type of ['pointerdown', 'keydown']) addEventListener(type, event => {
                        if (event.isTrusted) actualWaylandInput.push({type, key: event.key});
                      }, true);
                    """)
                    cases[args.case](acc, row, args.fixtures, args.out)
                    row["trustedInput"] = acc.d.js("return actualWaylandInput")
                    h.require({e["type"] for e in row["trustedInput"]} >= {"pointerdown", "keydown"},
                              "missing trusted pointer or keyboard event")
                except Exception:
                    driver.screenshot(args.out / "error.png")
                    raise
                finally:
                    driver.quit()
        trace = Path(h.p4.smoke.DRIVER_LOG).read_text(errors="replace")
        h.require("xdg_wm_base" in trace and "wl_pointer" in trace and "wl_keyboard" in trace,
                  "Wayland protocol activity was not captured")
        row["status"] = "PASS"
    except Exception:
        row.update(status="FAIL", error=traceback.format_exc())
    finally:
        if weston.poll() is None:
            weston.terminate()
            weston.wait(timeout=10)
        row["westonExit"] = weston.returncode
        row["driverCleanup"] = h.p4.smoke.TEARDOWN[-1] if h.p4.smoke.TEARDOWN else None
        (args.out / "result.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")

print(row["status"], row.get("error", ""))
raise SystemExit(row["status"] != "PASS")
