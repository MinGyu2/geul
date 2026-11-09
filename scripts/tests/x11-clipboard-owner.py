"""Test-owned external X11 UTF8_STRING clipboard owner, no Python dependencies."""
import ctypes as C
import ctypes.util
import glob
import json
import os
import sys
import time

try:
    x = C.CDLL(C.util.find_library('X11') or 'libX11.so.6')
except OSError:
    # Existing local native runners use Nix store tools without installing them.
    candidates = glob.glob('/nix/store/*libx11-*/lib/libX11.so.6')
    if not candidates:
        raise RuntimeError('existing X11 library unavailable')
    x = C.CDLL(candidates[0])
U = C.c_ulong
P = C.c_void_p
class Request(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', U), ('send_event', C.c_int), ('display', P), ('owner', U), ('requestor', U), ('selection', U), ('target', U), ('property', U), ('time', U)]
class Notify(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', U), ('send_event', C.c_int), ('display', P), ('requestor', U), ('selection', U), ('target', U), ('property', U), ('time', U)]
class Event(C.Union):
    _fields_ = [('type', C.c_int), ('request', Request), ('notify', Notify), ('padding', C.c_long * 24)]
for name, args, result in [
    ('XOpenDisplay', [C.c_char_p], P), ('XDefaultRootWindow', [P], U),
    ('XCreateSimpleWindow', [P, U, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, U, U], U),
    ('XInternAtom', [P, C.c_char_p, C.c_int], U), ('XSetSelectionOwner', [P, U, U, U], C.c_int),
    ('XMapWindow', [P, U], C.c_int),
    ('XGetSelectionOwner', [P, U], U), ('XFlush', [P], C.c_int), ('XNextEvent', [P, P], C.c_int),
    ('XChangeProperty', [P, U, U, U, C.c_int, C.c_int, P, C.c_int], C.c_int),
    ('XSendEvent', [P, U, C.c_int, C.c_long, P], C.c_int),
]:
    fn = getattr(x, name); fn.argtypes = args; fn.restype = result

d = x.XOpenDisplay(None)
if not d:
    raise RuntimeError('no X11 display')
w = x.XCreateSimpleWindow(d, x.XDefaultRootWindow(d), 0, 0, 1, 1, 0, 0, 0)
atoms = {n: x.XInternAtom(d, n.encode(), 0) for n in ['CLIPBOARD', 'UTF8_STRING', 'TARGETS', 'TEXT', 'STRING', 'ATOM']}
if len(sys.argv) > 3 and sys.argv[3] == 'map':
    x.XMapWindow(d, w)
x.XSetSelectionOwner(d, atoms['CLIPBOARD'], w, 0); x.XFlush(d)
if x.XGetSelectionOwner(d, atoms['CLIPBOARD']) != w:
    raise RuntimeError('clipboard ownership failed')
# '@PATH' serves the UTF-8 bytes of a file (megabyte payloads exceed argv limits).
if sys.argv[1].startswith('@'):
    with open(sys.argv[1][1:], 'rb') as f:
        payload = f.read()
    shown = {'file': sys.argv[1][1:], 'bytes': len(payload)}
else:
    payload = sys.argv[1].encode()
    shown = {'text': sys.argv[1]}
print(json.dumps({'pid': os.getpid(), 'owner': w, **shown}), flush=True)
while True:
    event = Event(); x.XNextEvent(d, C.byref(event))
    if event.type == 29:
        # SelectionClear: another client (the app) took CLIPBOARD. Observation only;
        # callers that never read stdout beyond the first line are unaffected.
        print('SELECTION_CLEAR', flush=True)
        continue
    if event.type != 30:
        continue
    r = event.request
    prop = r.property or r.target
    if r.target == atoms['TARGETS']:
        supported = (U * 4)(atoms['UTF8_STRING'], atoms['TEXT'], atoms['STRING'], atoms['TARGETS'])
        x.XChangeProperty(d, r.requestor, prop, atoms['ATOM'], 32, 0, supported, 4)
    elif r.target in (atoms['UTF8_STRING'], atoms['TEXT'], atoms['STRING']):
        if len(sys.argv) > 2:
            print('TEXT_REQUEST', flush=True)
            time.sleep(float(sys.argv[2]))
        text = C.create_string_buffer(payload)
        x.XChangeProperty(d, r.requestor, prop, atoms['UTF8_STRING'], 8, 0, text, len(payload))
    else:
        prop = 0
    reply = Event(); reply.notify = Notify(31, 0, 1, d, r.requestor, r.selection, r.target, prop, r.time)
    x.XSendEvent(d, r.requestor, 0, 0, C.byref(reply)); x.XFlush(d)
