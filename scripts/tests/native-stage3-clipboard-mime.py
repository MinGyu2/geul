#!/usr/bin/env python3
"""Verify GTK structured clipboard transport against a separate GTK process under private X11."""

import argparse
import ctypes as c
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/e2e"))
import tauri_smoke as smoke

OBJECT = "application/x-geul-object+json"
TABLE = "application/x-geul-table-cells+json"


def gtk_peer(args):
    gtk = c.CDLL(str(args.gtk))
    ptr = c.c_void_p
    signatures = {
        "gtk_init_check": (c.c_int, ptr, ptr),
        "gdk_atom_intern": (ptr, c.c_char_p, c.c_int),
        "gtk_clipboard_get": (ptr, ptr),
        "gtk_clipboard_wait_for_contents": (ptr, ptr, ptr),
        "gtk_selection_data_get_length": (c.c_int, ptr),
        "gtk_selection_data_get_data": (ptr, ptr),
        "gtk_selection_data_free": (None, ptr),
        "gtk_clipboard_set_text": (None, ptr, c.c_char_p, c.c_int),
        "gtk_main": (None,),
    }
    for name, (result, *params) in signatures.items():
        fn = getattr(gtk, name)
        fn.restype, fn.argtypes = result, params
    assert gtk.gtk_init_check(None, None)
    atom = lambda name: gtk.gdk_atom_intern(name.encode(), 0)
    clipboard = gtk.gtk_clipboard_get(atom("CLIPBOARD"))
    if args.peer == "read":
        selection = gtk.gtk_clipboard_wait_for_contents(clipboard, atom(args.mime))
        assert selection, args.mime
        try:
            length = gtk.gtk_selection_data_get_length(selection)
            assert 0 <= length <= 12 * 1024 * 1024
            sys.stdout.buffer.write(c.string_at(gtk.gtk_selection_data_get_data(selection), length))
        finally:
            gtk.gtk_selection_data_free(selection)
        return

    if args.mime == "UTF8_STRING":
        data = sys.stdin.buffer.read()
        gtk.gtk_clipboard_set_text(clipboard, data, len(data))
    else:
        class Target(c.Structure):
            _fields_ = [("name", c.c_char_p), ("flags", c.c_uint), ("info", c.c_uint)]

        getter = c.CFUNCTYPE(None, ptr, ptr, c.c_uint, ptr)
        gtk.gtk_clipboard_set_with_data.restype = c.c_int
        gtk.gtk_clipboard_set_with_data.argtypes = [ptr, c.POINTER(Target), c.c_uint, getter, ptr, ptr]
        gtk.gtk_selection_data_set.restype = None
        gtk.gtk_selection_data_set.argtypes = [ptr, ptr, c.c_int, c.c_char_p, c.c_int]
        data = sys.stdin.buffer.read()
        payloads = [(args.mime, data)]
        if args.plain is not None:
            payloads.append(("UTF8_STRING", args.plain.encode()))

        @getter
        def serve(_clipboard, selection, info, _user):
            mime, payload = payloads[info]
            gtk.gtk_selection_data_set(selection, atom(mime), 8, payload, len(payload))

        targets = (Target * len(payloads))(
            *(Target(mime.encode(), 0, i) for i, (mime, _) in enumerate(payloads)))
        if not gtk.gtk_clipboard_set_with_data(clipboard, targets, len(payloads), serve, None, None):
            raise RuntimeError("GTK did not acquire clipboard ownership")

    print("ready", flush=True)
    gtk.gtk_main()


def native_probe(args, d, report):
    def invoke(command, **payload):
        d.js("""
          window.__clipResult=null;
          window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(
            value=>window.__clipResult={value}, error=>window.__clipResult={error});
        """, command, payload)
        smoke.wait_until(d, "return window.__clipResult!==null")
        return d.js("return window.__clipResult")

    def peer(mode, mime):
        return [sys.executable, __file__, "--gtk", str(args.gtk), "--peer", mode, "--mime", mime]

    def read(mime):
        return subprocess.check_output(peer("read", mime), timeout=15).decode()

    def offer(mime, data, action):
        with subprocess.Popen(peer("offer", mime), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as owner:
            try:
                owner.stdin.write(data)
                owner.stdin.close()
                assert owner.stdout.readline().strip() == "ready"
                return action()
            finally:
                owner.terminate()

    formats = [
        (OBJECT, json.dumps({
            "kind": "geul.object", "version": 1, "sourceFormat": "docx",
            "object": {"kind": "shape", "shape": "rectangle", "widthPt": 108, "heightPt": 72,
                       "placement": "inline", "fill": "#156082", "outline": "#0E405A", "outlinePt": 1},
            "token": "0" * 24,
        }), "Geul rectangle [" + "0" * 24 + "]"),
        (TABLE, json.dumps({
            "kind": "geul.tableCells", "version": 1, "sourceFormat": "hwpx", "rows": 1, "cols": 1,
            "cells": [{"row": 0, "col": 0, "rowSpan": 1, "colSpan": 1,
                       "paragraphs": [{"runs": [{"text": "한글😀"}]}]}], "plainText": "한글😀",
        }, ensure_ascii=False), "한글😀"),
    ]
    assert invoke("clipboard_write_structured", mime="text/html", data="<p>x</p>", plainText="x") == {
        "error": "UnsupportedFormat"
    }
    for mime, data, plain in formats:
        assert invoke("clipboard_write_structured", mime=mime, data=data, plainText=plain) == {"value": None}
        assert read(mime) == data
        assert read("UTF8_STRING") == plain
        assert offer(mime, data, lambda: invoke("clipboard_read_structured", mime=mime)) == {"value": data}
        report["formats"].append(mime)

    def plain_owner():
        assert invoke("clipboard_read_structured", mime=OBJECT) == {"value": None}
        assert invoke("clipboard_read_text") == {"value": "외부 텍스트"}

    offer("UTF8_STRING", "외부 텍스트", plain_owner)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gtk", type=Path, required=True)
    parser.add_argument("--peer", choices=("read", "offer"))
    parser.add_argument("--mime")
    parser.add_argument("--plain", help="additional UTF8_STRING target when offering structured MIME")
    for name in ("app", "driver", "out"):
        parser.add_argument("--" + name, type=Path)
    args = parser.parse_args()
    if args.peer:
        gtk_peer(args)
        return
    args.out.mkdir(parents=True, exist_ok=False)
    smoke.APP = str(args.app)
    smoke.DRIVER_LOG = str(args.out / "driver.log")
    report = {"status": "FAIL", "formats": []}
    try:
        with smoke.tauri_driver(str(args.driver), 4444, str(args.out / "profile")) as start:
            driver = start()
            try:
                native_probe(args, driver, report)
            finally:
                smoke.end_session(driver)
        report["status"] = "PASS"
    finally:
        (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
