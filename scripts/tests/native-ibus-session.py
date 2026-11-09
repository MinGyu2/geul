#!/usr/bin/env python3
"""Test-owned private X11 + D-Bus + IBus (Hangul) session for native acceptance runs.

Usage: python3 scripts/tests/native-ibus-session.py --out DIR -- COMMAND [ARGS...]

The command runs with DISPLAY, DBUS_SESSION_BUS_ADDRESS, IBUS_ADDRESS, GTK_IM_MODULE=ibus and
XMODIFIERS=@im=ibus pointing only at processes started here; nothing touches the user's session,
input-method settings or dconf database. `@XDOTOOL@` and `@IBUS@` in arguments expand to the tools.

Why each piece exists (diagnosed 2026-11-10, see docs/architecture/clipboard-preedit-acceptance.md):
- ibus-engine-hangul 1.5.5 requires the IBus config component. With `ibus-daemon --config=disable`
  the engine logs "Unable to connect to IBus config component" and exits with status 3, so
  `ibus engine hangul` (SetGlobalEngine) waits for a dead engine and fails with "Timeout was reached".
  The config component is ibus-dconf, which needs dconf-service on a session bus: a private
  dbus-daemon activates it from a private service directory, writing only under the temp directory.
- The development shell's LD_LIBRARY_PATH points at a glib that needs a newer glibc than the IBus
  binaries were linked with; it is removed from the session environment.
- Unix socket paths are limited to 108 bytes, so sockets live in a short private /tmp directory.
"""
import argparse
import contextlib
import glob
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def store(pattern, required):
    """Resolve an installed Nix store path containing `required`; override with GEUL_<NAME>."""
    for candidate in sorted(glob.glob('/nix/store/' + pattern)):
        if all(Path(candidate, r).exists() for r in required):
            return candidate
    raise SystemExit(f'BLOCKED: no installed /nix/store/{pattern} with {required}')


def proc_identity(pid):
    """(parent pid, start time) from /proc, or None when the pid no longer exists."""
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return int(fields[1]), int(fields[19])
    except (OSError, IndexError, ValueError):
        return None


def descendants(root):
    """Every live descendant of `root` as {pid: start time}. With this launcher as child subreaper,
    orphans of the test command are reparented here, so nothing it started can leave the tree."""
    children = {}
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            ident = proc_identity(int(entry.name))
            if ident:
                children.setdefault(ident[0], []).append((int(entry.name), ident[1]))
    found, stack = {}, [root]
    while stack:
        for pid, start in children.get(stack.pop(), []):
            found[pid] = start
            stack.append(pid)
    return found


def tool(env_name, pattern, required):
    return os.environ.get(env_name) or store(pattern, [required])


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True)
    p.add_argument('command', nargs=argparse.REMAINDER)
    args = p.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise SystemExit('missing command')
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    ibus = tool('GEUL_IBUS', '*-ibus-1.5.*', 'libexec/ibus-dconf')
    hangul = tool('GEUL_IBUS_HANGUL', '*-ibus-hangul-*', 'libexec/ibus-engine-hangul')
    dconf = tool('GEUL_DCONF', '*-dconf-*-lib', 'libexec/dconf-service')
    xvfb = tool('GEUL_XVFB', '*-xvfb-*', 'bin/Xvfb')
    xdotool = tool('GEUL_XDOTOOL', '*-xdotool-*', 'bin/xdotool')
    setxkbmap = tool('GEUL_SETXKBMAP', '*-setxkbmap-*', 'bin/setxkbmap')
    gtk3dev = tool('GEUL_GTK3_DEV', '*-gtk+3-*-dev', 'bin/gtk-query-immodules-3.0')
    dbus_daemon = shutil.which('dbus-daemon') or store('*-dbus-1.*', ['bin/dbus-daemon']) + '/bin/dbus-daemon'

    # PR_SET_CHILD_SUBREAPER: orphaned descendants of the test command reparent to this launcher.
    import ctypes
    subreaper = ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
    work = Path(tempfile.mkdtemp(prefix='geul-ibus-'))
    sock = Path(tempfile.mkdtemp(prefix='gx-', dir='/tmp'))
    env = {k: v for k, v in os.environ.items() if k not in (
        'LD_LIBRARY_PATH', 'IBUS_USE_PORTAL', 'IBUS_ADDRESS', 'DBUS_SESSION_BUS_ADDRESS', 'WAYLAND_DISPLAY',
        'DISPLAY', 'XAUTHORITY', 'GTK_IM_MODULE', 'QT_IM_MODULE', 'XMODIFIERS')}
    for key in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'):
        d = work / key
        d.mkdir(mode=0o700)
        env[key] = str(d)
    tools = work / 'tools'
    tools.mkdir()
    for name, target in {'xdotool': xdotool + '/bin/xdotool', 'setxkbmap': setxkbmap + '/bin/setxkbmap',
                         'ibus': ibus + '/bin/ibus'}.items():
        (tools / name).symlink_to(target)
    components = work / 'components'
    components.mkdir()
    for name in ('simple.xml', 'dconf.xml'):
        shutil.copy(Path(ibus, 'share/ibus/component', name), components / name)
    shutil.copy(Path(hangul, 'share/ibus/component/hangul.xml'), components / 'hangul.xml')
    services = work / 'services'
    services.mkdir()
    (services / 'ca.desrt.dconf.service').write_text(
        f'[D-BUS Service]\nName=ca.desrt.dconf\nExec={dconf}/libexec/dconf-service\n')
    bus_conf = work / 'session.conf'
    bus_conf.write_text(f'''<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir={sock}</listen><servicedir>{services}</servicedir>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
''')
    cache = work / 'immodules.cache'
    with cache.open('w') as f:
        subprocess.run([gtk3dev + '/bin/gtk-query-immodules-3.0', ibus + '/lib/gtk-3.0/3.0.0/immodules/im-ibus.so'],
                       stdout=f, check=True, env=env)
    env.update(PATH=str(tools) + ':' + env['PATH'], IBUS_ADDRESS='unix:path=' + str(sock / 'ibus'),
               IBUS_COMPONENT_PATH=str(components), GSETTINGS_BACKEND='memory', GTK_IM_MODULE='ibus',
               GTK_IM_MODULE_FILE=str(cache), XMODIFIERS='@im=ibus', GDK_BACKEND='x11')
    identity = {'work': str(work), 'ibus': ibus, 'ibusHangul': hangul, 'dconf': dconf, 'xvfb': xvfb,
                'xdotool': xdotool, 'dbusDaemon': dbus_daemon, 'imModule': ibus + '/lib/gtk-3.0/3.0.0/immodules/im-ibus.so'}
    processes = []
    code = 1

    def start(name, argv, **kw):
        proc = subprocess.Popen(argv, env=env, stderr=(out / f'{name}.log').open('w'), start_new_session=True, **kw)
        processes.append((name, proc))
        return proc

    try:
        xv = start('xvfb', [xvfb + '/bin/Xvfb', '-displayfd', '1', '-screen', '0', '1440x1000x24', '-dpi', '96',
                            '-nolisten', 'tcp'], stdout=subprocess.PIPE, text=True)
        env['DISPLAY'] = ':' + xv.stdout.readline().strip()
        bus = start('dbus', [dbus_daemon, '--config-file=' + str(bus_conf), '--nofork', '--print-address=1'],
                    stdout=subprocess.PIPE, text=True)
        env['DBUS_SESSION_BUS_ADDRESS'] = bus.stdout.readline().strip()
        subprocess.run([setxkbmap + '/bin/setxkbmap', 'us'], env=env, check=True)
        daemon = start('ibus-daemon', [ibus + '/bin/ibus-daemon', '--panel=disable', '--emoji-extension=disable',
                                       '--cache=none', '--address=' + env['IBUS_ADDRESS'], '--verbose'],
                       stdout=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while not (sock / 'ibus').exists():
            if daemon.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('IBus daemon did not start')
            time.sleep(.05)
        # Activation probe: the engine must stay alive and become the global engine.
        started = time.monotonic()
        probe = subprocess.run([ibus + '/bin/ibus', 'engine', 'hangul'], env=env, capture_output=True, text=True, timeout=30)
        engine = subprocess.run([ibus + '/bin/ibus', 'engine'], env=env, capture_output=True, text=True, timeout=10).stdout.strip()
        identity.update(display=env['DISPLAY'], dbus=env['DBUS_SESSION_BUS_ADDRESS'], ibusAddress=env['IBUS_ADDRESS'],
                        setGlobalEngine={'exit': probe.returncode, 'stderr': probe.stderr.strip(),
                                         'seconds': round(time.monotonic() - started, 3)}, globalEngine=engine,
                        ibusVersion=subprocess.run([ibus + '/bin/ibus', 'version'], env=env, capture_output=True,
                                                   text=True).stdout.strip(),
                        engineProcesses=subprocess.run(['pgrep', '-a', '-f', hangul + '/libexec/'], capture_output=True,
                                                       text=True).stdout.split('\n'))
        (out / 'session.json').write_text(json.dumps(identity, indent=2) + '\n')
        if probe.returncode != 0 or engine != 'hangul':
            print('BLOCKED: Hangul engine activation failed', json.dumps(identity['setGlobalEngine']), file=sys.stderr)
            return 2
        subprocess.run([ibus + '/bin/ibus', 'engine', 'xkb:us::eng'], env=env, check=True, timeout=30)
        argv = [a.replace('@XDOTOOL@', str(tools / 'xdotool')).replace('@IBUS@', str(tools / 'ibus')) for a in command]
        code = subprocess.run(argv, env=env).returncode
    finally:
        # Snapshot every test-owned process (pid + start time) before teardown; only these are touched.
        owned = descendants(os.getpid())
        for name, proc in reversed(processes):
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=5)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        leaked = {}
        deadline = time.monotonic() + 5
        while True:
            # Reap reparented orphans so they do not linger as zombies of this launcher.
            try:
                while os.waitpid(-1, os.WNOHANG)[0] > 0:
                    pass
            except ChildProcessError:
                pass
            alive = {pid: start for pid, start in owned.items() if (proc_identity(pid) or (None, None))[1] == start}
            if not alive or time.monotonic() > deadline:
                break
            for pid in alive:
                leaked.setdefault(pid, Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')[:200]
                                  if Path(f'/proc/{pid}').exists() else '')
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGTERM if time.monotonic() < deadline - 2 else signal.SIGKILL)
            time.sleep(.1)
        survivors = sorted(set(descendants(os.getpid())) | set(alive))
        cleanup = {'exit': code, 'subreaper': subreaper, 'ownedAtTeardown': len(owned),
                   'leakedAfterManagedStop': leaked, 'survivors': survivors,
                   'proven': subreaper and not survivors}
        (out / 'cleanup.json').write_text(json.dumps(cleanup) + '\n')
        if not cleanup['proven']:
            print('CLEANUP NOT PROVEN', json.dumps(cleanup), file=sys.stderr)
            code = code or 3
        shutil.rmtree(sock, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
