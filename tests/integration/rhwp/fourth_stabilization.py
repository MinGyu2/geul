#!/usr/bin/env python3
"""Fourth stabilization: real WASM + Rust IPC in Tauri, synthetic terminal events, resource rejection.

Uses the same test-hooks build and WebDriver environment as rhwp_poc.py. These DOM IME cases
are synthetic and do not replace --ime. --native-close additionally sends X11 WM_DELETE_WINDOW
(native GTK close request, not an emitted JS event), and checks cancellation and final closure.
Use an awake compositor (weston --idle-time=0); --scenario dpi requires actual compositor/GTK DPR >= 2.
"""
from __future__ import annotations
import argparse
import ctypes
import ctypes.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
import rhwp_poc as p

s = p.smoke


def check(name, condition, detail=""):
    p.check(name, condition, detail)


def terminal(d, kind, text="하"):
    d.js("""const i=document.querySelector('.rhwp-input'); i.value=arguments[1];
      if(arguments[0]==='start') i.dispatchEvent(new CompositionEvent('compositionstart'));
      else if(arguments[0]==='end') i.dispatchEvent(new CompositionEvent('compositionend',{data:arguments[1]}));
      else i.dispatchEvent(new InputEvent('input',{data:arguments[1],inputType:'insertFromComposition',isComposing:false}));""", kind, text)


def wait_revision(d, revision):
    s.wait_until(d, "const e=document.querySelector('[data-testid=rhwp-status]'); return e?.dataset.revision===String(arguments[0])", revision)


def async_races(d, fixtures, scratch):
    for outcome in ("success", "StaleLoad", "RevisionMismatch", "StaleSession"):
        file = scratch / f"race-{outcome}.hwp"
        shutil.copy(fixtures / "basic-ko.hwp", file)
        p.open_document(d, file)
        p.require_test_hooks(d)
        before = p.status(d)["paragraphText"]
        # Tauri invoke is immutable. Its debug callback Map lets this test delay only the actual
        # Rust commit response; no application API/test hook or permission is added.
        d.js("""window.__callbackMap=window.__TAURI_INTERNALS__.callbacks;
          window.__oldGet=window.__callbackMap.get; window.__callbackKeys=new Set(window.__callbackMap.keys());
          window.__held=[]; window.__hold=true;
          window.__callbackMap.get=function(id){
            const fn=window.__oldGet.call(this,id);
            if(!fn) return fn;
            return data=>{
              if(window.__hold && data?.state==='ready' && data.loadGeneration===1 && data.revision===1){
                const errorId=[...this.keys()].find(k=>k!==id&&!window.__callbackKeys.has(k));
                const error=window.__oldGet.call(this,errorId);
                window.__held.push({resolve:()=>fn(data),reject:e=>error(e),sessionId:data.sessionId});
              } else fn(data);
            };
          };""")
        p.press(d, "x")
        s.wait_until(d, "return window.__held.length===1")
        # Actual WASM mutation succeeds, then actual render preparation throws to enter protected failure.
        d.js("window.__oldContext=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(){throw Error('test render failure')}")
        p.press(d, "y")
        p.wait_status(d, "failed")
        d.js("HTMLCanvasElement.prototype.getContext=window.__oldContext; window.__hold=false")
        p.press_button(d, "[data-testid=rhwp-load]")
        p.confirm_discard(d, "reload")
        p.wait_status(d, "ready")
        check(f"{outcome}: reload restores real document with backend revision 1", p.status(d)["paragraphText"] == before and p.status(d)["localRevision"] == "1")
        p.press(d, "z")
        wait_revision(d, 2)
        current = p.status(d)
        check(f"{outcome}: generation 2 commits while old generation unresolved", current["localRevision"] == "2" and current["paragraphText"].startswith("z"))
        projection = p.ipc(d, "document_sessions")["ok"]
        d.js("""const old=window.__held.shift(); if(arguments[0]==='success') old.resolve();
          else if(arguments[0]==='StaleLoad') old.reject({code:'StaleLoad',sessionId:old.sessionId,loadGeneration:2});
          else if(arguments[0]==='RevisionMismatch') old.reject({code:'RevisionMismatch',sessionId:old.sessionId,revision:2});
          else old.reject({code:arguments[0],sessionId:old.sessionId});
          window.__callbackMap.get=window.__oldGet;""", outcome)
        time.sleep(.15)
        after = p.status(d)
        check(f"{outcome}: late old response preserves model/revision/status/projection", all(after[k] == current[k] for k in ("status", "revision", "localRevision", "paragraphText", "caret")) and p.ipc(d, "document_sessions")["ok"] == projection)


def terminal_cases(d, fixtures, scratch):
    paths = []
    for name in ("terminal-A.hwp", "terminal-B.hwp"):
        path = scratch / name
        shutil.copy(fixtures / "basic-ko.hwp", path)
        paths.append(path)
        p.open_document(d, path)
    p.select_tab(d, paths[0].name)
    before = p.status(d)["paragraphText"]
    terminal(d, "start"); terminal(d, "end"); terminal(d, "input"); terminal(d, "end")
    wait_revision(d, 1)
    a = p.status(d)
    check("synthetic real WebView: end-input-end inserts and commits once with caret +1", a["paragraphText"] == "하" + before and a["localRevision"] == "1" and p.offset_of(a["caret"]) == 1 and not a["selection"])
    p.select_tab(d, paths[1].name)
    before_b = p.status(d)
    terminal(d, "input"); terminal(d, "end")
    time.sleep(.15)
    b = p.status(d)
    check("synthetic real WebView: late A terminal notifications preserve B", all(b[k] == before_b[k] for k in ("paragraphText", "revision", "localRevision", "caret", "selection")))
    terminal(d, "start"); terminal(d, "end")
    wait_revision(d, 1)
    check("synthetic real WebView: new identical B syllable preserved", p.status(d)["paragraphText"] == "하" + before_b["paragraphText"] and p.offset_of(p.status(d)["caret"]) == 1)


def resource_cases(d, fixtures, scratch):
    source = (fixtures / "basic-ko.hwpx").read_bytes()
    section = zipfile.ZipFile(io.BytesIO(source)).read("Contents/section0.xml").decode()
    # HWPUNIT = 1/75 CSS px at 96 dpi; these remain within the 16384 dimension contract.
    for name, width, height in (("wide", 1200000, 307200), ("tall", 307200, 1200000), ("near-limit", 1228725, 1228725)):
        changed = re.sub(r'(<hp:pagePr[^>]*?\bwidth=")\d+(")', lambda m: f'{m[1]}{width}{m[2]}', section, count=1)
        changed = re.sub(r'(<hp:pagePr[^>]*?\bheight=")\d+(")', lambda m: f'{m[1]}{height}{m[2]}', changed, count=1)
        if changed == section:
            raise s.Failure("pagePr fixture replacement failed")
        path = scratch / f"oversize-{name}.hwpx"
        path.write_bytes(s.with_entry(source, "Contents/section0.xml", changed.encode()))
        # 5차: 예산은 그리는 배율에 대한 것이다. 50%에서 그릴 수 있는 wide/tall은 100%에서 표시 한도(ready, 그리지 않음),
        # 가장 작은 배율로도 넘는 near-limit만 ready 전에 RenderLimit으로 거부한다.
        limited = name != "near-limit"
        st = p.open_document(d, path, expected="ready" if limited else "failed")
        backend = p.ipc(d, "document_sessions")["ok"]
        state = next(x for x in backend if x["displayName"] == path.name)["state"]
        if limited:
            check(f"real WASM oversized {name}: 100% is a recoverable display limit without canvas allocation", st["status"] == "ready" and d.exists("[data-testid=rhwp-render-limit]") and not d.exists("canvas.rhwp-page__canvas") and state == "ready")
        else:
            check(f"real WASM oversized {name}: RenderLimit before canvas allocation", st["status"] == "failed" and not d.exists("canvas.rhwp-page__canvas") and state == "failed" and "화면 메모리 한도" in d.js("return document.querySelector('[data-testid=rhwp-error]').textContent"))
    # More than ten pages are allowed when the total pixel budget fits. A genuine many-page
    # HWPX with ordinary individual pages must still fail when their aggregate exceeds 128 MiB.
    import copy
    import xml.etree.ElementTree as ET
    root = ET.fromstring(section)
    paragraphs = [child for child in root if child.tag.endswith("}p")]
    for index in range(45):
        paragraph = copy.deepcopy(paragraphs[-1])
        paragraph.set("pageBreak", "1")
        paragraph.set("id", str(1000 + index))
        root.append(paragraph)
    # First use the same source to check that a reasonable >10-page workload remains supported.
    small_root = ET.fromstring(section)
    for index in range(11):
        paragraph = copy.deepcopy(paragraphs[-1])
        paragraph.set("pageBreak", "1"); paragraph.set("id", str(2000 + index))
        small_root.append(paragraph)
    twelve = scratch / "twelve-pages.hwpx"
    twelve.write_bytes(s.with_entry(source, "Contents/section0.xml", ET.tostring(small_root, encoding="utf-8")))
    st = p.open_document(d, twelve)
    canvases_ready = "const cs=[...document.querySelectorAll('canvas')];return cs.length===12&&cs.every(c=>c.width>0&&c.height>0)"
    try:
        s.wait_until(d, canvases_ready, timeout=15)
    except s.Failure:
        print("12-page rendering diagnostic", p.status(d), d.js("return [...document.querySelectorAll('canvas')].map(c=>[c.width,c.height])"), flush=True)
        raise
    check("real 12-page document remains editable within pixel budget", st["status"] == "ready" and st["pages"] == "12" and d.js("const cs=[...document.querySelectorAll('canvas')];return cs.length===12&&cs.every(c=>c.width>0&&c.height>0)&&cs.reduce((n,c)=>n+c.width*c.height,0)<=32*1024*1024"))
    many = scratch / "oversize-aggregate.hwpx"
    many.write_bytes(s.with_entry(source, "Contents/section0.xml", ET.tostring(root, encoding="utf-8")))
    st = p.open_document(d, many)
    check("real WASM aggregate of ordinary pages: 100% display limit before canvas allocation (5차: 50%에서 표시)", st["status"] == "ready" and d.exists("[data-testid=rhwp-render-limit]") and not d.exists("canvas.rhwp-page__canvas"))
    p.select_tab(d, "terminal-B.hwp")
    d.js("window.__detachedCanvas=document.querySelector('canvas')")
    p.select_tab(d, "terminal-A.hwp")
    check("real tab switch releases detached bitmap", d.js("return [window.__detachedCanvas.width,window.__detachedCanvas.height]") == [0, 0])
    p.set_zoom(d, 200)
    p.set_zoom(d, 100)
    p.set_zoom(d, 200)
    check("real rapid zoom leaves valid current canvas", p.status(d)["status"] == "ready" and d.js("return document.querySelector('canvas').width") > 1500)


def native_close_request(window_id, library=None):
    # GTK's supported WM_DELETE_WINDOW protocol. Unlike XDestroyWindow, this is cancelable.
    x = ctypes.CDLL(library or ctypes.util.find_library("X11") or "libX11.so.6")
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XInternAtom.restype = ctypes.c_ulong
    class Data(ctypes.Union):
        _fields_ = [("l", ctypes.c_long * 5)]
    class Client(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("data", Data)]
    class Event(ctypes.Union):
        _fields_ = [("client", Client), ("pad", ctypes.c_long * 24)]
    display = x.XOpenDisplay(None)
    if not display: raise s.Failure("cannot open X11 display")
    event = Event()
    event.client = Client(33, 0, 1, display, window_id, x.XInternAtom(display, b"WM_PROTOCOLS", 0), 32, Data())
    event.client.data.l[0] = x.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
    x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
    x.XFlush.argtypes = [ctypes.c_void_p]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    try:
        if not x.XSendEvent(display, window_id, 0, 0, ctypes.byref(event)): raise s.Failure("WM_DELETE_WINDOW not sent")
        x.XFlush(display)
    finally: x.XCloseDisplay(display)


def close_cases(d, xdotool, library):
    window_id = int(subprocess.check_output([xdotool, "search", "--name", "^geul$"], text=True).splitlines()[-1])
    before = p.status(d)["paragraphText"]
    p.press_button(d, ".document-tab__close")
    p.smoke.wait_until(d, "return document.querySelector('[data-action=close]') !== null")
    d.js("document.querySelector('[data-testid=discard-confirm]').focus()")
    native_close_request(window_id, library)
    p.smoke.wait_until(d, "return document.querySelector('[data-action=window]') !== null")
    native_close_request(window_id, library)
    check("native WM_DELETE_WINDOW: group discard dialog once, cancel focused", d.js("return document.querySelectorAll('[role=alertdialog]').length===1 && document.activeElement.dataset.testid==='discard-cancel'"))
    p.press_button(d, "[data-testid=discard-cancel]")
    check("native cancel keeps actual WASM model editable", p.status(d)["paragraphText"] == before and d.exists(".rhwp-input"))
    native_close_request(window_id, library)
    p.smoke.wait_until(d, "return document.querySelector('[data-action=window]') !== null")
    p.press_button(d, "[data-testid=discard-confirm]")
    for _ in range(50):
        if subprocess.run([xdotool, "getwindowname", str(window_id)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            check("native confirm destroys window without recursive close dialog", True)
            return
        time.sleep(.1)
    raise s.Failure("confirmed native window still exists")



def clean_close(d, xdotool, library):
    window_id = int(subprocess.check_output([xdotool, "search", "--name", "^geul$"], text=True).splitlines()[-1])
    native_close_request(window_id, library)
    for _ in range(50):
        if subprocess.run([xdotool, "getwindowname", str(window_id)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            check("native clean workspace closes directly", True)
            return
        time.sleep(.1)
    raise s.Failure("clean workspace did not close")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("all", "async", "terminal", "render", "close", "dpi"), default="all")
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--port", type=int, default=4471)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--driver-log")
    parser.add_argument("--native-close", action="store_true")
    parser.add_argument("--x11-library", help="libX11 path when the system linker cannot locate it")
    parser.add_argument("--xdotool", default="xdotool")
    args = parser.parse_args()
    if args.scenario == "close" and not args.native_close:
        parser.error("--scenario close requires --native-close")
    if args.native_close and not os.environ.get("DISPLAY"):
        parser.error("--native-close requires X11 DISPLAY")
    s.APP = os.path.abspath(args.app)
    s.DRIVER_LOG = args.driver_log
    try:
        with tempfile.TemporaryDirectory(prefix="geul-fourth-") as temp:
            scratch = Path(temp); fixtures = scratch / "fixtures"
            subprocess.run(["node", str(p.ROOT / "tests/fixtures/rhwp/generate.mjs"), str(fixtures)], check=True, stdout=subprocess.DEVNULL)
            with s.tauri_driver(args.driver, args.port, str(scratch / "data")) as start:
                d = start()
                try:
                    s.wait_until(d, "return document.querySelector('.document-bar')!==null")
                    if args.scenario == "dpi":
                        check("actual WebView high-DPI compositor", d.js("return window.devicePixelRatio") >= 2)
                        p.scenario_load_render(d, fixtures, None)
                    if args.scenario in ("all", "async"): async_races(d, fixtures, scratch)
                    if args.scenario in ("all", "terminal", "render"): terminal_cases(d, fixtures, scratch)
                    if args.scenario in ("all", "render"): resource_cases(d, fixtures, scratch)
                    if args.scenario == "close":
                        p.open_document(d, fixtures / "basic-ko.hwp")
                        p.press(d, "x"); wait_revision(d, 1)
                    if args.native_close: close_cases(d, args.xdotool, args.x11_library)
                finally:
                    try: d.quit()
                    except (s.Failure, OSError): pass
            if args.native_close:
                with s.tauri_driver(args.driver, args.port, str(scratch / "clean-data")) as start:
                    d = start()
                    try:
                        s.wait_until(d, "return document.querySelector('.document-bar')!==null")
                        clean_close(d, args.xdotool, args.x11_library)
                    finally:
                        try: d.quit()
                        except (s.Failure, OSError): pass
        print(f"Fourth stabilization integration: {len(p.RESULTS)} passed")
        return 0
    except (s.Failure, OSError, TimeoutError) as error:
        import traceback
        traceback.print_exc()
        print(f"[실패] {error}")
        return 1
    finally:
        if args.report: args.report.write_text(json.dumps({"results": p.RESULTS, "measurements": p.REPORT}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    raise SystemExit(main())
