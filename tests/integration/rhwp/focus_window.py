#!/usr/bin/env python3
"""Native X11 focus destination for the existing --focus-window IME regressions.

Creates a real, empty X window. It emits no composition events or keyboard input.
Use the title 'ime-focus-target'; terminate this process after the native test.
"""
import argparse
import ctypes
import ctypes.util
import signal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--x11-library", default=ctypes.util.find_library("X11") or "libX11.so.6")
    args = parser.parse_args()
    x11 = ctypes.CDLL(args.x11_library)
    display = ctypes.c_void_p
    window = ctypes.c_ulong
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = display
    x11.XDefaultRootWindow.argtypes = [display]
    x11.XDefaultRootWindow.restype = window
    x11.XCreateSimpleWindow.argtypes = [display, window, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                                      ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
    x11.XCreateSimpleWindow.restype = window
    x11.XStoreName.argtypes = [display, window, ctypes.c_char_p]
    x11.XMapWindow.argtypes = [display, window]
    x11.XFlush.argtypes = [display]
    x11.XDestroyWindow.argtypes = [display, window]
    x11.XCloseDisplay.argtypes = [display]
    connection = x11.XOpenDisplay(None)
    if not connection:
        raise RuntimeError("No X11 display")
    target = x11.XCreateSimpleWindow(connection, x11.XDefaultRootWindow(connection), 0, 0, 240, 120, 0, 0, 0xDDDDDD)
    if not target:
        x11.XCloseDisplay(connection)
        raise RuntimeError("Could not create native focus window")
    x11.XStoreName(connection, target, b"ime-focus-target")
    x11.XMapWindow(connection, target)
    x11.XFlush(connection)

    def stop(_number, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    try:
        while True:
            signal.pause()
    finally:
        x11.XDestroyWindow(connection, target)
        x11.XCloseDisplay(connection)


if __name__ == "__main__":
    main()
