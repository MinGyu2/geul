#!/usr/bin/env python3
"""Capture product Canvas previews for every case in <corpus>/cases.json (headless Firefox, local Vite).

    python3 scripts/tests/hwp-canvas/run.py src-tauri/target/hwp-phase4/engine [evidence-dir]

Starts the bounded Vite server, opens canvas.html once in a throw-away Firefox profile, waits for every
case's canvas-proof.json (newer than the start), then stops both processes. Exit 0 only on success.
"""
import json, os, signal, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[3]
corpus = Path(sys.argv[1]).resolve()
evidence = Path(sys.argv[2] if len(sys.argv) > 2 else corpus).resolve()
rel = corpus.relative_to(root).as_posix()
ids = [c["id"] for c in json.loads((corpus / "cases.json").read_text())]
(corpus / "canvas-error.json").unlink(missing_ok=True)
start = time.time()
server_log = (evidence / "canvas-server.log").open("w")
# Serve mode would select the Debug RHWP generation: evidence must use the approved Release generation.
server = subprocess.Popen(["npx", "vite", "--config", "scripts/tests/hwp-canvas/vite.config.mjs"], cwd=root,
                          env={**os.environ, "GEUL_RHWP_PROFILE": "release"},
                          stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True)
profile = Path(tempfile.mkdtemp(prefix="hwp-canvas-", dir=evidence))
(profile / "user.js").write_text("".join(f'user_pref("{k}", {v});\n' for k, v in {
    "browser.shell.checkDefaultBrowser": "false", "browser.startup.page": "0", "datareporting.healthreport.uploadEnabled": "false",
    "toolkit.telemetry.enabled": "false", "network.captive-portal-service.enabled": "false"}.items()))
result = {"corpus": rel, "cases": ids, "result": "FAIL"}
browser = None
try:
    for _ in range(150):
        try:
            urllib.request.urlopen("http://127.0.0.1:43899/rhwp/BUILD.json", timeout=1); break
        except Exception:
            if server.poll() is not None: raise RuntimeError("vite exited")
            time.sleep(0.2)
    else: raise RuntimeError("vite did not start")
    url = f"http://127.0.0.1:43899/scripts/tests/hwp-canvas/canvas.html?dir={rel}&ids={','.join(ids)}"
    env = {k: v for k, v in os.environ.items() if k not in ("LD_LIBRARY_PATH", "GTK_PATH")}
    env["TMPDIR"] = str(profile)
    browser = subprocess.Popen(["firefox", "--headless", "--no-remote", "--profile", str(profile), url],
                               stdout=server_log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    result["url"] = url
    while time.time() - start < max(120, 2 * len(ids)):
        if (corpus / "canvas-error.json").exists(): raise RuntimeError((corpus / "canvas-error.json").read_text())
        if all((corpus / i / "canvas-proof.json").exists() and (corpus / i / "canvas-proof.json").stat().st_mtime >= start for i in ids):
            release = json.loads((root / "public/rhwp/BUILD.json").read_text())["generation"]
            generations = {json.loads((corpus / i / "canvas-proof.json").read_text())["generation"] for i in ids}
            if generations != {release}: raise RuntimeError(f"canvas generation {generations} != release {release}")
            result["generation"] = release; result["result"] = "PASS"; break
        if browser.poll() is not None: raise RuntimeError(f"firefox exited {browser.returncode}")
        time.sleep(0.2)
    else: raise RuntimeError("canvas timeout")
except Exception as error:
    result["error"] = str(error)[:2000]
finally:
    for process in (browser, server):
        if process is None: continue
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)
    server_log.close()
    shutil.rmtree(profile, ignore_errors=True)
    result["elapsedSeconds"] = round(time.time() - start, 2)
    (evidence / "canvas-run.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))
sys.exit(0 if result["result"] == "PASS" else 1)
