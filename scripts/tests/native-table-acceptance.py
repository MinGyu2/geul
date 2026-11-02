#!/usr/bin/env python3
"""Native T007/T008 follow-up in a prepared X11/IBus + Vite environment.

External test helpers and generated fixtures stay in the separate tests/ tree.
This probe observes the application's loader facade, rather than importing a
second WASM module URL. No product source or DOM composition is changed.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
for folder in ("tests/e2e", "tests/integration/rhwp", "tests/integration/wordcraft"):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp
import wordcraft_poc as docx

INSTALL = r"""
window.__tableProbeReady=false;
(async()=>{
 const loader=await import('/src/components/Editor/rhwp/rhwpModule.ts');
 const facade=await loader.loadRhwpModule();
 const docs=new Map(), owners=new Map();let serial=0,last=null;
 const p=window.__tableProbe={hits:[],created:0,freed:0,pointer:[],bindings:[]};
 const identity=await fetch('/rhwp/BUILD.json').then(r=>r.json());
 const raw=await import('/rhwp/generations/'+identity.generation+'/rhwp.js');
 p.rawPrototypeIsApp=[];
 const original=facade.openDocument;
 facade.openDocument=function(...args){
  const d=original.apply(this,args),id=++serial;docs.set(id,d);last=id;p.created++;
  p.rawPrototypeIsApp.push(Object.getPrototypeOf(d)===raw.HwpDocument.prototype);
  const hit=d.hitTest,free=d.free;
  d.hitTest=function(...args){const raw=hit.apply(this,args);p.hits.push({id,page:args[0],x:args[1],y:args[2],raw:JSON.parse(raw)});return raw;};
  d.free=function(...args){docs.delete(id);for(const [owner,value]of owners)if(value===id)owners.delete(owner);if(last===id)last=null;p.freed++;return free.apply(this,args);};
  return d;
 };
 p.bind=owner=>{
  if(!owners.has(owner)){if(!docs.has(last))throw Error('No live application document');owners.set(owner,last);p.bindings.push({owner,id:last});}
  return owners.get(owner);
 };
 const owned=owner=>{const d=docs.get(owners.get(owner));if(!d)throw Error('Owner not bound to live document');return d;};
 p.cell=(owner,parent,control,cell)=>{
  const d=owned(owner),g=JSON.parse(d.getCursorRectInCell(0,parent,control,cell,0,0));
  return {...g,page:JSON.parse(d.getPageInfo(g.pageIndex)),id:owners.get(owner),controls:JSON.parse(d.getControls()).filter(c=>c.ctrlId==='tbl')};
 };
 p.body=owner=>{const d=owned(owner),g=JSON.parse(d.getCursorRect(0,0,0));return {...g,page:JSON.parse(d.getPageInfo(g.pageIndex)),id:owners.get(owner)};};
 p.resources=()=>performance.getEntriesByType('resource').map(r=>r.name).filter(n=>n.includes('rhwp.js'));
 window.addEventListener('mousedown',e=>p.pointer.push({x:e.clientX,y:e.clientY,owner:document.querySelector('.document-tab__select[aria-selected=true]')?.dataset.session}),true);
 window.__tableProbeReady=true;
})().catch(e=>window.__tableProbeError=String(e));
"""


def owner(d):
    return d.js("return document.querySelector('.document-tab__select[aria-selected=true]')?.dataset.session")


def calibrate(d):
    d.js("window.__probeMove=null;window.addEventListener('mousemove',e=>window.__probeMove=[e.clientX,e.clientY],true)")
    for point in (100, 200):
        d.js("window.__probeMove=null")
        scale = getattr(d, "pointer_scale", (1, 1))
        rhwp.perform(d, [{"type": "pointer", "id": "calibration", "parameters": {"pointerType": "mouse"},
                         "actions": [{"type": "pointerMove", "x": round(point * scale[0]),
                                      "y": round(point * scale[1]), "origin": "viewport"}]}])
        smoke.wait_until(d, "return window.__probeMove!==null")
        received = d.js("return window.__probeMove")
        if point == 100:
            assert all(value > 0 for value in received)
            d.pointer_scale = (100 / received[0], 100 / received[1])
        else:
            assert max(abs(value - point) for value in received) <= 2, received


def click_geometry(d, g):
    assert g and g["height"] > 0
    # Page logical units -> current canvas CSS client coordinates. The canvas
    # backing-store DPR is not a CSS pointer scale. Scroll both axes as needed.
    point = d.js(r"""
 const g=arguments[0],c=document.querySelectorAll('.rhwp-page__canvas')[g.pageIndex],s=document.querySelector('.editor__scroll');
 const logical={x:g.x+1,y:g.y+g.height/2};
 let r=c.getBoundingClientRect(),v=s.getBoundingClientRect();
 s.scrollTop+=r.top+logical.y*r.height/g.page.height-(v.top+s.clientHeight/2);
 s.scrollLeft+=r.left+logical.x*r.width/g.page.width-(v.left+s.clientWidth/2);
 r=c.getBoundingClientRect();
 return {x:r.left+logical.x*r.width/g.page.width,y:r.top+logical.y*r.height/g.page.height,
  logical,page:g.pageIndex,rect:{left:r.left,top:r.top,width:r.width,height:r.height},
  backing:{width:c.width,height:c.height},dpr:devicePixelRatio,scroll:{top:s.scrollTop,left:s.scrollLeft}};
 """, g)
    rhwp.click(d, point["x"], point["y"])
    time.sleep(0.1)
    delivered = d.js("return window.__tableProbe.pointer.at(-1)")
    assert delivered and abs(delivered["x"] - point["x"]) <= 2 and abs(delivered["y"] - point["y"]) <= 2, (point, delivered)
    return {**point, "delivered": delivered}


_ORIGINAL_DRAG = rhwp.drag


def calibrated_drag(d, start, end):
    sx, sy = getattr(d, "pointer_scale", (1, 1))
    return _ORIGINAL_DRAG(d, (start[0] * sx, start[1] * sy), (end[0] * sx, end[1] * sy))


def native_press(d, *keys, shift=False, pause=0):
    # WebDriver's Backspace identifier is not the X11 BackSpace keysym.
    names = {"Backspace": "BackSpace"}
    command = ["env", "-u", "LD_LIBRARY_PATH", d.native_key_tool, "key", "--delay", str(pause or 20),
               *[("shift+" if shift else "") + names.get(key, key) for key in keys]]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    assert "No such key" not in result.stderr, result.stderr
    time.sleep(0.15)


def selected_cell(d, expected, parent, control, expected_owner, expected_doc):
    st = rhwp.status(d)
    assert owner(d) == expected_owner
    assert st["caret"].startswith(f"0:{parent}:") and st["caret"].endswith(f"@{control}/{expected}/0"), st
    hit = d.js("return window.__tableProbe.hits.at(-1)")
    assert hit and hit["id"] == expected_doc, hit
    return st


LATENCY_INSTALL = r"""
window.__nativeLatencyReady=false;
(async()=>{
 const p=window.__nativeLatency={capture:false,events:[],samples:[]};
 for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput'])
  document.addEventListener(type,e=>{if(p.capture&&e.target?.classList.contains('rhwp-input'))p.events.push({type,inputType:e.inputType??null,trusted:e.isTrusted,at:performance.now()});},true);
 const rhwp=await import('/src/components/Editor/rhwp/RhwpEditorSession.ts');
 const docx=await import('/src/components/Editor/wordcraft/DocxEditorSession.ts');
 for(const cls of [rhwp.RhwpEditorSession,docx.DocxEditorSession]){
  const record=cls.prototype.recordLatency;
  cls.prototype.recordLatency=function(ms){if(p.capture)p.samples.push({ms,session:this.sessionId,at:performance.now()});return record.call(this,ms);};
 }
 window.__nativeLatencyReady=true;
})().catch(e=>window.__nativeLatencyError=String(e));
"""


def measure_ime(d, args, fmt):
    probe = docx if fmt == "docx" else rhwp
    probe.open_document(d, args.fixtures / ("basic-ko." + fmt))
    time.sleep(0.8)
    d.js(LATENCY_INSTALL)
    smoke.wait_until(d, "return window.__nativeLatencyReady===true", timeout=30)
    command = lambda *argv: subprocess.run(["env", "-u", "LD_LIBRARY_PATH", *argv], check=True, capture_output=True, text=True)
    window = command(args.xdotool, "search", "--onlyvisible", "--name", "^geul").stdout.split()[-1]
    command(args.xdotool, "windowfocus", "--sync", window)
    d.js("document.querySelector('.rhwp-input').focus({preventScroll:true})")
    time.sleep(0.3)
    command(args.ibus, "engine", "hangul")
    command(args.xdotool, "key", "End")
    before = probe.settle(d, "native latency start")
    expected_owner = owner(d)
    d.js("window.__nativeLatency.capture=true")
    command(args.xdotool, "type", "--delay", "140", "rk" * 20)
    command(args.xdotool, "key", "End")
    after = probe.settle(d, "native latency committed")
    d.js("window.__nativeLatency.capture=false")
    measured = d.js("return window.__nativeLatency")
    assert after["paragraphText"] == before["paragraphText"] + "가" * 20, (fmt, after)
    assert measured["samples"] and all(str(v["session"]) == expected_owner for v in measured["samples"])
    events = measured["events"]
    assert sum(e["type"] == "compositionupdate" and e["trusted"] for e in events) >= 20, events
    assert all(e["trusted"] for e in events), "synthetic event in native interval"
    values = sorted(v["ms"] for v in measured["samples"])
    assert len(values) >= 20, values
    percentile = lambda q: values[min(len(values)-1, __import__('math').ceil(len(values)*q)-1)]
    stats = {"samples": len(values), "p50": percentile(.5), "p95": percentile(.95), "max": values[-1],
             "rawMs": [v["ms"] for v in measured["samples"]], "thresholdMs": 150,
             "passed": percentile(.95) <= 150, "nativeCompositionEvents": len(events),
             "trustedEvents": True, "owner": expected_owner, "dpr": d.js("return devicePixelRatio"),
             "zoom": d.js("return document.querySelector('.statusbar__zoom-value').textContent"),
             "metric": "native Hangul-only interval; existing input-event to caret-page draw plus two RAF metric",
             "keyboard": "xdotool native GTK -> IBus hangul; rk repeated20, delay140ms; no DOM composition"}
    assert stats["passed"], stats
    # Real empty composition cancellation, followed by a native key to drain it.
    canvas_before = d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL())")
    assert canvas_before
    text0 = after["paragraphText"]
    rev_key = "revision" if fmt == "docx" else "localRevision"
    rev0 = after[rev_key]
    command(args.xdotool, "type", "--delay", "140", "g")
    composing = probe.settle(d, "native cancellation preedit")
    command(args.xdotool, "key", "BackSpace", "End")
    cancelled = probe.settle(d, "native cancellation end")
    assert composing["composing"] == "true" and cancelled["composing"] == "false"
    assert cancelled["paragraphText"] == text0 and cancelled[rev_key] == rev0
    canvas_after = d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL())")
    assert canvas_before == canvas_after, "visible page pixels differ after canceled composition"
    stats["compositionCancellation"] = "PASS: text/revision unchanged after BackSpace and End"
    stats["cancelledCanvasEqual"] = True
    stats["cancelledCanvasSha256"] = [hashlib.sha256(value.encode()).hexdigest() for value in canvas_after]
    # Selection replacement uses actual Shift+Left and native composition.
    command(args.xdotool, "key", "shift+Left", "shift+Left")
    selected = probe.settle(d, "native selection")
    assert selected.get("selection")
    command(args.xdotool, "type", "--delay", "140", "gk")
    command(args.xdotool, "key", "space")
    replaced = probe.settle(d, "native replacement")
    assert replaced["paragraphText"] == text0[:-2] + "하 ", replaced
    assert owner(d) == expected_owner and replaced["composing"] == "false"
    backend = rhwp.ipc(d, "document_session", {"sessionId": int(expected_owner)})["ok"]
    assert backend["revision"] == int(replaced[rev_key]), (backend, replaced)
    stats["selectionReplacement"] = "PASS: selected two syllables replaced once; backend revision matches"
    stats["renderAfterCancellation"] = {"status": cancelled["status"],
                                         "canvasPixels": d.js("const c=document.querySelector('.rhwp-page__canvas');return c?c.width*c.height:0"),
                                         "beforeAfterVisibleCanvasEqual": True, "independentEngineReplay": "NOT RUN"}
    return stats


def run(args):
    args.out.mkdir(parents=True, exist_ok=False)
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / "driver.log"
    report = {"status": "RUNNING", "probeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "appSha256": hashlib.sha256(args.app.read_bytes()).hexdigest(),
              "rhwpBuild": json.loads((ROOT / "public/rhwp/BUILD.json").read_text()),
              "environment": {"os": os.uname().sysname, "kernel": os.uname().release,
                              "display": os.environ.get("GDK_BACKEND"), "ime": "IBus hangul; native xdotool" if args.ime else "not measured",
                              "softwareRenderingRequested": os.environ.get("LIBGL_ALWAYS_SOFTWARE"),
                              "loadAverageStart": os.getloadavg(), "cpuCount": os.cpu_count(),
                              "additionalCpuStress": False, "syntheticComposition": False},
              "fixtures": {name: hashlib.sha256((args.fixtures/name).read_bytes()).hexdigest()
                           for name in ("basic-ko.hwp", "basic-ko.hwpx", "basic-ko.docx")},
              "table": [], "ordinary": {}, "ime": {}, "nativeImeLatency": {}}
    meta = json.loads((args.rhwp_meta or args.fixtures / "basic-ko.json").read_text())
    parent, control = meta["table"]["paragraph"], meta["table"]["control"]
    bindings = {}
    rhwp.press = native_press
    rhwp.drag = calibrated_drag
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / "appdata")) as start:
            if not (args.ime_only or args.latency_only or args.docx_only):
                d = start()
                try:
                    d.js(INSTALL)
                    smoke.wait_until(d, "return window.__tableProbeReady===true", timeout=30)
                    calibrate(d)
                    d.native_key_tool = args.xdotool
                    rhwp.press = native_press
                    for fmt in ("hwp", "hwpx"):
                        rhwp.REPORT.setdefault(fmt, {})
                        rhwp.open_document(d, args.fixtures / ("basic-ko." + fmt))
                        current_owner = owner(d)
                        document_id = d.js("return window.__tableProbe.bind(arguments[0])", current_owner)
                        bindings[fmt] = (current_owner, document_id)
                        rev = rhwp.status(d)["localRevision"]
                        for zoom in (100, 200):
                            rhwp.set_zoom(d, zoom)
                            time.sleep(0.8)  # render and layout must settle after zoom
                            g = d.js("return window.__tableProbe.cell(...arguments)", current_owner, parent, control, 0)
                            assert g.get("cellBounds") and g["controls"], g
                            point = click_geometry(d, g)
                            if args.require_dpr is not None:
                                assert point["dpr"] == args.require_dpr, point
                            assert abs(point["backing"]["width"] - point["rect"]["width"] * point["dpr"]) <= 2
                            assert abs(point["backing"]["height"] - point["rect"]["height"] * point["dpr"]) <= 2
                            selected_cell(d, 0, parent, control, current_owner, document_id)
                            rhwp.press(d, "Tab")
                            selected_cell(d, 1, parent, control, current_owner, document_id)
                            rhwp.press(d, "Tab", shift=True)
                            selected_cell(d, 0, parent, control, current_owner, document_id)
                            last = d.js("return window.__tableProbe.cell(...arguments)", current_owner, parent, control, 3)
                            click_geometry(d, last)
                            rhwp.press(d, "Tab")
                            selected_cell(d, 3, parent, control, current_owner, document_id)
                            assert rhwp.status(d)["localRevision"] == rev, "navigation changed revision"
                            body = d.js("return window.__tableProbe.body(arguments[0])", current_owner)
                            click_geometry(d, body)
                            assert "@" not in rhwp.caret_key(d) and rhwp.caret_key(d).startswith("0:0:"), rhwp.status(d)
                            report["table"].append({"format": fmt, "zoom": zoom, "owner": current_owner, "document": document_id,
                                                    "dpr": point["dpr"], "point": point, "clickTabShiftTabLastCell": "PASS",
                                                    "paragraphHit": "PASS", "revisionUnchanged": True})
                    assert bindings["hwp"][0] != bindings["hwpx"][0] and bindings["hwp"][1] != bindings["hwpx"][1]
                    for fmt in ("hwp", "hwpx", "hwp"):
                        rhwp.select_tab(d, "basic-ko." + fmt)
                        rhwp.set_zoom(d, 100)
                        time.sleep(0.8)
                        current_owner, document_id = bindings[fmt]
                        g = d.js("return window.__tableProbe.cell(...arguments)", current_owner, parent, control, 1)
                        click_geometry(d, g)
                        selected_cell(d, 1, parent, control, current_owner, document_id)
                    report["documentSwitching"] = "PASS"
                    report["resources"] = d.js("return window.__tableProbe.resources()")
                    report["factoryCreated"] = d.js("return window.__tableProbe.created")
                    report["rawPrototypeIsApp"] = d.js("return window.__tableProbe.rawPrototypeIsApp")
                    report["pointerScale"] = list(d.pointer_scale)
                    # Reuse established real native input scenarios, replacing only
                    # their test cell-location helper with measured owner geometry.
                    def cell_click(driver, cell):
                        current = owner(driver)
                        g = driver.js("return window.__tableProbe.cell(...arguments)", current, parent, control, cell)
                        click_geometry(driver, g)
                        selected_cell(driver, cell, parent, control, current, g["id"])
                        rhwp.press(driver, "Home")
                    rhwp.click_cell = cell_click
                    if args.ordinary:
                        rhwp.RESULTS.clear()
                        for fmt in ("hwp", "hwpx"):
                            rhwp.select_tab(d, "basic-ko." + fmt)
                            rhwp.scenario_hit_test(d, fmt)
                            rhwp.scenario_selection_keyboard(d, fmt)
                            time.sleep(0.8)
                            pixels_before = d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL())")
                            rhwp.scenario_revision(d, fmt)
                            pixels_after = d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL())")
                            assert pixels_before and pixels_before == pixels_after, "render changed after rejected revision/load operation"
                        report["ordinary"] = {"checks": rhwp.RESULTS.copy(), "measurements": rhwp.REPORT.copy()}
                except Exception:
                    report["diagnostic"] = {"status": rhwp.status(d), "owner": owner(d),
                                            "probe": d.js("const p=window.__tableProbe;return p?{created:p.created,hits:p.hits.slice(-8),bindings:p.bindings,resources:p.resources?.()}:null")}
                    raise
                finally:
                    smoke.end_session(d)
            if args.docx_only:
                d = start()
                try:
                    smoke.wait_until(d, "return document.querySelector('#document-path')!==null", timeout=30)
                    docx.RESULTS.clear()
                    docx.REPORT.clear()
                    docx.calibrate_pointer(d)
                    docx.scenario_load_render(d, args.fixtures, json.loads((args.fixtures / "basic-ko.json").read_text()), None)
                    docx.scenario_hit_test(d)
                    docx.scenario_selection_keyboard(d)
                    pixels_before = d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL())")
                    docx.scenario_revision(d)
                    pixels_after = d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL())")
                    assert pixels_before and pixels_before == pixels_after
                    docx.scenario_roundtrip_ui(d)
                    report["docxOrdinary"] = {"checks": docx.RESULTS.copy(), "measurements": docx.REPORT.copy(),
                                               "renderAfterRejectedOperations": "PASS"}
                finally:
                    smoke.end_session(d)
            if args.ime and not args.latency_only:
                for name, probe in (("rhwp", rhwp), ("docx", docx)):
                    d = start()
                    try:
                        smoke.wait_until(d, "return document.querySelector('#document-path')!==null", timeout=30)
                        d.native_key_tool = args.xdotool
                        probe.GATE.clear()
                        probe.REPORT.clear()
                        probe.scenario_ime(d, args.fixtures, args.xdotool, args.ibus, None, None)
                        code = probe.ime_exit_code(False) if name == "rhwp" else probe.ime_exit_code()
                        report["ime"][name] = {"exit": code, "gates": probe.GATE.copy(), "measurements": probe.REPORT.copy()}
                        assert code == 0
                    finally:
                        smoke.end_session(d)
            if args.ime:
                for fmt in ("hwp", "hwpx", "docx"):
                    d = start()
                    try:
                        smoke.wait_until(d, "return document.querySelector('#document-path')!==null", timeout=30)
                        report["nativeImeLatency"][fmt] = measure_ime(d, args, fmt)
                    finally:
                        smoke.end_session(d)
        report["driverTeardown"] = smoke.TEARDOWN
        report["status"] = "PASS"
    except Exception as error:
        report.update(status="FAIL", error=type(error).__name__ + ": " + str(error))
        if isinstance(error, subprocess.CalledProcessError):
            report["commandFailure"] = {"command": error.cmd, "stdout": error.stdout, "stderr": error.stderr}
        traceback.print_exc()
    finally:
        (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(report["status"], report.get("error", ""))
    return 0 if report["status"] == "PASS" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--rhwp-meta", type=Path, help="RHWP generator metadata; keep separate from WordCraft basic-ko.json")
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    parser.add_argument("--ime", action="store_true")
    parser.add_argument("--ime-only", action="store_true", help="run only native IME phases; reuse separate verified table/ordinary results")
    parser.add_argument("--latency-only", action="store_true", help="native IME latency and cancellation/replacement only; reuse verified IME gate results")
    parser.add_argument("--docx-only", action="store_true", help="DOCX native ordinary input/table/revision/reopen only")
    parser.add_argument("--ordinary", action="store_true")
    parser.add_argument("--require-dpr", type=int, choices=[1, 2], help="fail if the prepared native environment does not expose this DPR")
    parser.add_argument("--port", type=int, default=4444)
    args = parser.parse_args()
    if sum((args.ime_only, args.latency_only, args.docx_only)) > 1:
        parser.error("select one phase-only mode")
    if (args.ime_only or args.latency_only) and not args.ime:
        parser.error("--ime-only/--latency-only require --ime")
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
