#!/usr/bin/env python3
"""Fifth stabilization: real WASM + Rust IPC in Tauri for render-limit recovery and failure/reload ordering.

Uses the same test-hooks build and WebDriver environment as rhwp_poc.py (awake compositor, e.g.
weston --idle-time=0). Edits are real WebDriver key input. The only injected faults are a thrown
HTMLCanvasElement.getContext (a genuine render exception path) and holding the actual Rust
document_set_state response in the debug callback map; no application API or permission is added.
These cases do not replace the native IME gate (rhwp_poc.py --ime).
"""
from __future__ import annotations
import argparse
import copy
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
import rhwp_poc as p

s = p.smoke
LIMIT = "[data-testid=rhwp-render-limit]"


def check(name, condition, detail=""):
    p.check(name, condition, detail)


def wait_revision(d, revision):
    s.wait_until(d, "const e=document.querySelector('[data-testid=rhwp-status]'); return e?.dataset.revision===String(arguments[0])", revision)


def backend(d, name):
    return next(x for x in p.ipc(d, "document_sessions")["ok"] if x["displayName"] == name)


def canvases(d):
    return d.js("return [...document.querySelectorAll('canvas.rhwp-page__canvas')].map(c=>[c.width,c.height])")


def zoom_to(d, zoom):
    p.set_zoom(d, zoom)
    time.sleep(0.3)


def section_with(source: bytes, edit) -> bytes:
    section = zipfile.ZipFile(io.BytesIO(source)).read("Contents/section0.xml").decode()
    changed = edit(section)
    if changed == section:
        raise s.Failure("section0.xml fixture edit failed")
    return s.with_entry(source, "Contents/section0.xml", changed.encode())


def page_size(width, height):
    def edit(section):
        changed = re.sub(r'(<hp:pagePr[^>]*?\bwidth=")\d+(")', lambda m: f'{m[1]}{width}{m[2]}', section, count=1)
        return re.sub(r'(<hp:pagePr[^>]*?\bheight=")\d+(")', lambda m: f'{m[1]}{height}{m[2]}', changed, count=1)
    return edit


def many_pages(count):
    def edit(section):
        root = ET.fromstring(section)
        paragraphs = [child for child in root if child.tag.endswith("}p")]
        for index in range(count - 1):
            paragraph = copy.deepcopy(paragraphs[-1])
            paragraph.set("pageBreak", "1"); paragraph.set("id", str(3000 + index))
            root.append(paragraph)
        return ET.tostring(root, encoding="utf-8").decode()
    return edit


def zoom_recovery(d, fixtures, scratch, safe=100, excessive=200):
    """3000 × 3000 CSS px page (HWPUNIT 225000): bitmap scale 1 fits the per-canvas budget, scale 2 does not.
    At DPR 1 that is 100%/200%; at a real DPR 2 compositor it is 50%/100%."""
    source = (fixtures / "basic-ko.hwpx").read_bytes()
    path = scratch / f"large-page-{safe}.hwpx"
    path.write_bytes(section_with(source, page_size(225000, 225000)))
    zoom_to(d, safe)
    st = p.open_document(d, path)
    p.require_test_hooks(d)
    s.wait_until(d, "const c=document.querySelector('canvas.rhwp-page__canvas'); return c && c.width > 2900", timeout=15)
    before = st["paragraphText"]
    p.press(d, "x")
    wait_revision(d, 1)
    check(f"large page: real key edit at {safe}% commits revision 1", p.status(d)["paragraphText"] == "x" + before)
    zoom_to(d, excessive)
    s.wait_until(d, f"return document.querySelector('{LIMIT}') !== null", timeout=10)
    st = p.status(d)
    record = backend(d, path.name)
    check(f"{excessive}% over budget: recoverable display limit, not engine failure (frontend+backend ready, revision 1)",
          st["status"] == "ready" and record["state"] == "ready" and record["revision"] == 1 and st["localRevision"] == "1"
          and not st.get("uncertain") == "true", json.dumps([st.get("status"), record]))
    check(f"{excessive}% over budget: no page canvas allocated, input disabled, localized zoom shown",
          canvases(d) == [] and d.js("return document.querySelector('.rhwp-input').disabled")
          and f"{excessive}%" in d.js(f"return document.querySelector('{LIMIT}').textContent")
          and d.js("return parseInt(document.querySelector('.statusbar__zoom-value').textContent)") == excessive)
    p.press(d, "z")
    time.sleep(0.2)
    check("keys during display limit do not mutate the model", p.status(d)["localRevision"] == "1" and backend(d, path.name)["revision"] == 1)
    zoom_to(d, safe)
    s.wait_until(d, "const c=document.querySelector('canvas.rhwp-page__canvas'); return c && c.width > 2900", timeout=15)
    st = p.status(d)
    check(f"back to {safe}%: same model resumes editable, edit retained without reload",
          st["status"] == "ready" and not d.exists(LIMIT) and st["paragraphText"] == "x" + before
          and not d.js("return document.querySelector('.rhwp-input').disabled"), json.dumps(st, ensure_ascii=False))
    p.press(d, "y")
    wait_revision(d, 2)
    check("editing continues after recovery (revision 2)", p.status(d)["paragraphText"] == "xy" + before)
    for zoom in (excessive, safe, excessive, safe):
        p.set_zoom(d, zoom)
    s.wait_until(d, "const c=document.querySelector('canvas.rhwp-page__canvas'); return c && c.width > 2900", timeout=15)
    check("rapid zoom changes end editable at the safe zoom with revision unchanged",
          p.status(d)["status"] == "ready" and backend(d, path.name)["revision"] == 2 and canvases(d)[0][0] <= 3002)


def low_zoom_document(d, fixtures, scratch):
    """46 ordinary A4 pages: aggregate at 100% exceeds 128 MiB, 50% fits."""
    source = (fixtures / "basic-ko.hwpx").read_bytes()
    path = scratch / "many-pages.hwpx"
    path.write_bytes(section_with(source, many_pages(46)))
    st = p.open_document(d, path)
    check("46 pages at 100%: ready with display limit, no canvas", st["status"] == "ready" and d.exists(LIMIT) and canvases(d) == [])
    zoom_to(d, 50)
    s.wait_until(d, "const cs=[...document.querySelectorAll('canvas.rhwp-page__canvas')]; return cs.length===46 && cs.every(c=>c.width>0)", timeout=30)
    total = sum(w * h for w, h in canvases(d))
    check(f"46 pages at 50%: all pages drawn within aggregate budget ({total} px)", total <= 32 * 1024 * 1024)
    p.press(d, "k")
    wait_revision(d, 1)
    check("46 pages at 50%: real key edit commits", p.status(d)["localRevision"] == "1")
    zoom_to(d, 100)
    s.wait_until(d, f"return document.querySelector('{LIMIT}') !== null", timeout=10)
    check("46 pages back at 100%: limit again, edit retained, backing stores released", canvases(d) == [] and p.status(d)["localRevision"] == "1")
    zoom_to(d, 100)


HOLD = """window.__callbackMap=window.__TAURI_INTERNALS__.callbacks;
  window.__oldGet=window.__callbackMap.get; window.__held=[]; window.__hold=true;
  window.__callbackMap.get=function(id){
    const fn=window.__oldGet.call(this,id);
    if(!fn) return fn;
    return data=>{
      if(window.__hold && data && !Array.isArray(data) && data.state==='failed' && data.loadGeneration===1) window.__held.push(()=>fn(data));
      else fn(data);
    };
  };"""


def failure_ordering(d, fixtures, scratch):
    for name in ("basic-ko.hwp", "basic-ko.hwpx"):
        fmt = name.split(".")[-1]
        path = scratch / f"ordering.{fmt}"
        shutil.copy(fixtures / name, path)
        p.open_document(d, path)
        before = p.status(d)["paragraphText"]
        p.press(d, "x")
        wait_revision(d, 1)
        d.js(HOLD)
        # Genuine render exception after a successful real edit: protected failure, then ready → failed.
        d.js("window.__oldContext=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(){throw Error('test render failure')}")
        p.press(d, "y")
        p.wait_status(d, "failed")
        d.js("HTMLCanvasElement.prototype.getContext=window.__oldContext")
        s.wait_until(d, "return window.__held.length===1", timeout=10)
        check(f"{fmt}: render exception stays an engine failure (not a display limit)",
              not d.exists(LIMIT) and "편집 엔진" in d.js("return document.querySelector('[data-testid=rhwp-error]').textContent"))
        p.press_button(d, "[data-testid=rhwp-load]")
        p.confirm_discard(d, "reload")
        time.sleep(0.4)
        record = backend(d, path.name)
        check(f"{fmt}: while the failed-transition response is held, reload does not start a new load generation",
              p.status(d)["status"] == "failed" and record["loadGeneration"] == 1 and record["state"] == "failed"
              and p.status(d)["unpreserved"] == "true", json.dumps(record))
        d.js("window.__hold=false; for(const release of window.__held.splice(0)) release(); window.__callbackMap.get=window.__oldGet")
        st = p.wait_status(d, "ready")
        record = backend(d, path.name)
        check(f"{fmt}: after the acknowledgement reload reaches ready generation 2 without InvalidState",
              record["loadGeneration"] == 2 and record["state"] == "ready" and st["paragraphText"] == before
              and st["localRevision"] == str(record["revision"]) and record["revision"] >= 1 and not d.exists("[data-testid=rhwp-error]"),
              json.dumps([record, st.get("paragraphText")], ensure_ascii=False))
        p.press(d, "z")
        wait_revision(d, record["revision"] + 1)
        check(f"{fmt}: new generation commits normally", p.status(d)["paragraphText"] == "z" + before)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("all", "zoom", "ordering", "dpi"), default="all",
                        help="dpi: render-limit recovery on an actual DPR >= 2 compositor (weston --scale=2)")
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--port", type=int, default=4472)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--driver-log")
    args = parser.parse_args()
    s.APP = os.path.abspath(args.app)
    s.DRIVER_LOG = args.driver_log
    try:
        with tempfile.TemporaryDirectory(prefix="geul-fifth-") as temp:
            scratch = Path(temp); fixtures = scratch / "fixtures"
            subprocess.run(["node", str(p.ROOT / "tests/fixtures/rhwp/generate.mjs"), str(fixtures)], check=True, stdout=subprocess.DEVNULL)
            with s.tauri_driver(args.driver, args.port, str(scratch / "data")) as start:
                d = start()
                try:
                    s.wait_until(d, "return document.querySelector('.document-bar')!==null")
                    if args.scenario == "dpi":
                        check("actual WebView high-DPI compositor", d.js("return window.devicePixelRatio") >= 2)
                        zoom_recovery(d, fixtures, scratch, safe=50, excessive=100)
                    if args.scenario in ("all", "zoom"):
                        zoom_recovery(d, fixtures, scratch)
                        low_zoom_document(d, fixtures, scratch)
                    if args.scenario in ("all", "ordering"):
                        failure_ordering(d, fixtures, scratch)
                finally:
                    try: d.quit()
                    except (s.Failure, OSError): pass
        print(f"Fifth stabilization integration: {len(p.RESULTS)} passed")
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
