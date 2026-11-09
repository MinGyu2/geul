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
        return code
    finally:
        for name, proc in reversed(processes):
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=5)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        # Engine/config/dconf children stay in the sessions created above; none of ours may survive.
        survivors = [line for name, proc in processes for line in subprocess.run(
            ['pgrep', '-a', '-s', str(proc.pid)], capture_output=True, text=True).stdout.splitlines()]
        (out / 'cleanup.json').write_text(json.dumps({'exit': code, 'survivors': survivors}) + '\n')
        shutil.rmtree(sock, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
