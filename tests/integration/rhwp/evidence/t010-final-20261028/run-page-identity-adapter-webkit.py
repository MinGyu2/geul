#!/usr/bin/env python3
"""Run the experimental page-identity harness in the real Tauri/WebKitGTK webview."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
sys.path.insert(0, str(ROOT / "tests/e2e"))
import tauri_smoke as smoke


def free_port() -> int:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--driver", type=Path, required=True)
    parser.add_argument("--webkit-driver", type=Path, required=True)
    parser.add_argument("--xvfb", type=Path, required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--driver-log", type=Path, required=True)
    args = parser.parse_args()

    output = args.output.resolve()
    driver_log = args.driver_log.resolve()
    result = {
        "status": "RUNNING",
        "official": False,
        "engine": "Tauri WebKitGTK via WebKitWebDriver",
        "target": args.url,
        "cleanup": {},
    }
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = driver_log
    display = subprocess.Popen(
        [str(args.xvfb), "-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    failure = None
    try:
        display_number = display.stdout.readline().strip()
        if not display_number:
            raise RuntimeError("Xvfb did not allocate a display")
        os.environ["DISPLAY"] = ":" + display_number
        os.environ["PATH"] = str(args.webkit_driver.resolve().parent) + os.pathsep + os.environ["PATH"]
        os.environ["WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"] = "1"
        os.environ["NO_AT_BRIDGE"] = "1"
        os.environ["GTK_A11Y"] = "none"
        with tempfile.TemporaryDirectory(prefix="geul-t010-page-identity-webkit-") as temporary:
            work = Path(temporary)
            for name in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR"):
                folder = work / name
                folder.mkdir()
                os.environ[name] = str(folder)
            result["display"] = display_number
            result["app"] = str(args.app.resolve())
            result["webkitDriver"] = str(args.webkit_driver.resolve())
            port = free_port()
            with smoke.tauri_driver(str(args.driver.resolve()), port, str(work / "XDG_DATA_HOME")) as start:
                driver = start()
                try:
                    smoke.wait_until(driver, "return document.readyState === 'complete'", timeout=30)
                    result["initialOrigin"] = driver.js("return location.origin")
                    driver.call("POST", "/url", {"url": args.url})
                    smoke.wait_until(
                        driver,
                        "return location.href.startsWith(arguments[0]) && !!document.querySelector('#out')",
                        args.url.rsplit("/tests/", 1)[0],
                        timeout=30,
                    )
                    result["userAgent"] = driver.js("return navigator.userAgent")
                    result["nativeDpr"] = driver.js("return devicePixelRatio")
                    deadline = time.monotonic() + 240
                    encoded = None
                    while time.monotonic() < deadline:
                        encoded = driver.js("return document.querySelector('#out')?.textContent || null")
                        if encoded and encoded != "RUNNING":
                            break
                        time.sleep(0.2)
                    if not encoded or encoded == "RUNNING":
                        raise TimeoutError("WebKitGTK page-identity harness remained RUNNING for 240 seconds")
                    harness = json.loads(encoded)
                    result["harness"] = harness
                    if harness.get("status") != "PASS":
                        raise AssertionError("WebKitGTK page-identity harness reported " + str(harness.get("status")))
                    result["status"] = "PASS"
                finally:
                    smoke.end_session(driver)
    except BaseException as error:
        failure = error
        result["status"] = "FAIL"
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        result["tauriDriverTeardown"] = smoke.TEARDOWN[-1] if smoke.TEARDOWN else None
        if display.poll() is None:
            display.terminate()
            try:
                display.wait(timeout=10)
                result["xvfbExit"] = display.returncode
            except subprocess.TimeoutExpired:
                display.kill()
                display.wait(timeout=5)
                result["xvfbExit"] = display.returncode
                result["xvfbForcedKill"] = True
        else:
            result["xvfbExit"] = display.returncode
        result["driverLog"] = str(driver_log)
        write_json(output, result)

    print(json.dumps({
        "status": result["status"],
        "output": str(output),
        "xvfbExit": result.get("xvfbExit"),
        "tauriDriverCleanup": result.get("tauriDriverTeardown", {}).get("complete") if result.get("tauriDriverTeardown") else None,
        "revisions": [
            {"label": row.get("label"), "fullJobsStarted": row.get("fullJobsStarted"),
             "identityJobsSkipped": row.get("identityJobsSkipped"), "exactPages": row.get("exactRGBA", {}).get("exactPages")}
            for row in result.get("harness", {}).get("revisions", [])
        ],
    }, ensure_ascii=False, indent=2))
    if failure:
        raise failure
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
