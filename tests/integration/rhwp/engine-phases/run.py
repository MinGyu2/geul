#!/usr/bin/env python3
"""Fresh real-time Chrome diagnostic, explicitly separate from official native D4."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
# Module constants so failure-path tests can shorten them; the real defaults are unchanged.
RESULT_TIMEOUT = 240; TERM_TIMEOUT = 10; KILL_TIMEOUT = 10; METADATA_TIMEOUT = 60
SERVER_READY_TIMEOUT = 10; SERVER_STOP_TIMEOUT = 10
UNAVAILABLE = 'UNAVAILABLE'


def validate(result, config=None):
    check_order = config is not None or 'requestConfig' in result
    config = config or result.get('requestConfig', {'arms': ['baseline', 'off', 'on'], 'trials': 3})
    arms = set(config['arms'])
    if arms not in ({'baseline', 'off', 'on'}, {'baseline', 'off', 'on', 'candidate'}) or config['trials'] not in (3, 8):
        raise ValueError('unsupported diagnostic matrix')
    if result.get('status') != 'DIAGNOSTIC_COMPLETE' or result.get('official') is not False:
        raise ValueError('diagnostic did not complete')
    rows = result.get('rows', [])
    expected = {(s, p, t) for s, pages in [('basic-ko.hwp', [0]), ('basic-ko.hwpx', [0]),
        ('chemical.hwp', [0,14,15,16,19,20,21,23]), ('asset.hwpx', [0])]
        for p in pages for t in range(config['trials'])}
    if len(rows) != len(expected) or {(r['sample'],r['page'],r['trial']) for r in rows} != expected:
        raise ValueError('incomplete/duplicate measurement matrix')
    for row in rows:
        if check_order and (len(row.get('armOrder', [])) != len(arms) or set(row['armOrder']) != arms):
            raise ValueError('incomplete arm execution order')
        if row.get('exactRGBA') is not True: raise ValueError('RGBA disagreement')
        if set(row.get('arms', {})) != arms: raise ValueError('missing arm')
        for arm in arms:
            r = row['arms'][arm]
            if type(r.get('polls')) is not int or not 1 <= r['polls'] <= 512: raise ValueError('invalid poll count')
            for key in ['ms', 'queueMs', 'afterPublicationRaf1Ms', 'afterPublicationRaf2Ms']:
                value = r.get(key)
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise ValueError('invalid wall timing')
            if r['outcome'] != 'COMPLETE' or r['traceComplete'] is not True or r['dropped'] != 0:
                raise ValueError('job/trace incomplete')
        phases = row['arms']['on']['phases']
        if not phases or not any(p['name'] == 'poll.total' for p in phases):
            raise ValueError('missing total phase')
        ids = {p['id'] for p in phases}
        if len(ids) != len(phases): raise ValueError('duplicate span')
        for phase in phases:
            if phase['parent'] is not None and phase['parent'] not in ids: raise ValueError('missing parent')
            for key in ['at','ms']:
                value = phase[key]
                if type(value) not in (int,float) or not math.isfinite(value):
                    raise ValueError('invalid timing')
            if phase['ms'] < 0: raise ValueError('negative monotonic span')
            context = phase.get('context', {})
            if any(context.get(k) != row[k] for k in ['sample', 'page', 'trial']) or context.get('arm') != 'on':
                raise ValueError('wrong span context')
            if phase['parent'] is not None:
                parent = next(p for p in phases if p['id'] == phase['parent'])
                if parent['at'] > phase['at'] or phase['at'] + phase['ms'] > parent['at'] + parent['ms'] + 0.01:
                    raise ValueError('span outside parent')
        if not any(p['parent'] is None and p['name'] == 'poll.total' for p in phases):
            raise ValueError('missing root poll')
    if check_order:
        for sample, page in {(r['sample'], r['page']) for r in rows}:
            group = [r for r in rows if r['sample'] == sample and r['page'] == page]
            for arm in arms:
                counts = [sum(r['armOrder'][position] == arm for r in group) for position in range(len(arms))]
                if max(counts) - min(counts) > 1: raise ValueError('unbalanced arm order')
    if set(result.get('cleanup', {})) != arms: raise ValueError('missing cleanup')
    for cleanup in result['cleanup'].values():
        j,c=cleanup['jobs'],cleanup['cache']
        if j['activeJobs'] != 0 or j['activeLeaseCount'] != 0 or j['ownedEstimatedBytes'] != 0 or c['decoded']['bytes'] != 0 or c['images']['bytes'] != 0:
            raise ValueError('resource leak')


def _stat(pid):
    """(ppid, pgid, start time, state) of a live /proc entry, or None once the PID is gone."""
    try: raw = Path(f'/proc/{pid}/stat').read_text()
    except OSError: return None
    fields = raw[raw.rindex(')')+2:].split()
    return int(fields[1]), int(fields[2]), int(fields[19]), fields[0]


class Browser:
    """One launched browser: its own process group plus descendants seen as (pid, start time).

    The leader is reaped only at the very end, so its PGID cannot be reused while signals are sent.
    A descendant that calls setsid (the WebKit launcher's driver) is recognised by its recorded start
    time, and is signalled through a pidfd so a reused PID is never touched.
    """
    def __init__(self, process):
        self.process = process; self.tracked = {}
        self.record = {'pid': process.pid, 'pgid': process.pid, 'leaderExitedBeforeStop': None,
            'terminateAttempted': False, 'residualTerminateAttempted': False, 'killAttempted': False,
            'exitCode': None, 'exitSignal': None, 'reaped': False, 'trackedDescendants': 0,
            'survivors': UNAVAILABLE, 'gracefulExit': False, 'cleanupSucceeded': False, 'errors': []}

    def exited(self):
        if self.process.returncode is not None: return True
        try: return os.waitid(os.P_PID, self.process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
        except ChildProcessError: return True

    def observe(self):
        try: entries = [int(e.name) for e in Path('/proc').iterdir() if e.name.isdigit()]
        except OSError as error: self.record['errors'].append('process table: '+str(error)); return
        table = {pid: info for pid in entries if (info := _stat(pid))}
        leader = self.process.pid; seen = {leader}; frontier = {leader}
        while frontier:
            frontier = {pid for pid, info in table.items() if info[0] in frontier and pid not in seen}; seen |= frontier
        for pid, info in table.items():
            if pid != leader and (pid in seen or info[1] == leader): self.tracked.setdefault(pid, info[2])
        self.record['trackedDescendants'] = len(self.tracked)

    def alive(self):
        return sorted(pid for pid, start in self.tracked.items()
                      if (info := _stat(pid)) and info[2] == start and info[3] != 'Z')

    def _send(self, sig, group):
        if group and not self.record['reaped']:
            try: os.killpg(self.process.pid, sig)
            except ProcessLookupError: pass
            except OSError as error: self.record['errors'].append(f'killpg {sig}: {error}')
        for pid in self.alive():
            try: fd = os.pidfd_open(pid)
            except ProcessLookupError: continue
            except OSError as error: self.record['errors'].append(f'pidfd {pid}: {error}'); continue
            try:
                info = _stat(pid)
                if info and info[2] == self.tracked[pid]: signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError: pass
            except OSError as error: self.record['errors'].append(f'signal {pid} {sig}: {error}')
            finally: os.close(fd)

    def _wait(self, timeout):
        deadline = time.monotonic()+timeout
        while not self.exited() or self.alive():
            if time.monotonic() > deadline: return False
            time.sleep(.05)
        return True

    def stop(self):
        """Idempotent. Graceful leader SIGTERM first, so the launcher can close its own session."""
        r = self.record
        if r['reaped']: return r
        if not Path('/proc/self/stat').exists(): r['errors'].append('process table unavailable')
        self.observe(); r['leaderExitedBeforeStop'] = self.exited()
        if not r['leaderExitedBeforeStop']:
            r['terminateAttempted'] = True
            try: self.process.send_signal(signal.SIGTERM)
            except OSError as error: r['errors'].append('terminate: '+str(error))
        released = self._wait(TERM_TIMEOUT)
        if not released and self.exited():  # leader gone, owned descendants remain: ask them too
            r['residualTerminateAttempted'] = True; self._send(signal.SIGTERM, group=True); released = self._wait(TERM_TIMEOUT)
        if not released:
            r['killAttempted'] = True; self._send(signal.SIGKILL, group=True); self._wait(KILL_TIMEOUT)
        try: self.process.wait(timeout=KILL_TIMEOUT); r['reaped'] = True
        except subprocess.TimeoutExpired: r['errors'].append('leader not reaped after SIGKILL')
        code = self.process.returncode
        if code is not None: r['exitCode'], r['exitSignal'] = (code, None) if code >= 0 else (None, -code)
        r['survivors'] = self.alive()
        r['gracefulExit'] = code in (0, -signal.SIGTERM) and not r['killAttempted'] and not r['residualTerminateAttempted']
        r['cleanupSucceeded'] = r['reaped'] and not r['survivors'] and not r['errors']
        return r


class LocalServer:
    """Local HTTP server driven by its own handle_request() loop.

    BaseServer.shutdown() waits for serve_forever() to acknowledge and blocks forever if that loop never
    started. Here stopping is a flag checked every POLL seconds, so stop() never depends on how far startup
    got and its wait is bounded by SERVER_STOP_TIMEOUT. Readiness means one loop iteration completed.
    """
    POLL = 0.05

    def __init__(self, handler):
        self.handler = handler; self.server = self.thread = None
        self.stopping = threading.Event(); self.settled = threading.Event(); self.exited = threading.Event()
        self.record = {'created': False, 'threadCreated': False, 'threadStarted': False, 'started': False, 'loopError': None,
                       'stopRequested': False, 'threadJoined': None, 'socketClosed': False, 'shutdown': False, 'error': None}

    def _loop(self):
        try:
            while not self.stopping.is_set():
                self.server.handle_request(); self.settled.set()
        except BaseException as error: self.record['loopError'] = f'{type(error).__name__}: {error}'
        finally: self.exited.set(); self.settled.set()

    def start(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.handler)
        self.server.daemon_threads = True; self.server.timeout = self.POLL; self.record['created'] = True
        self.thread = threading.Thread(target=self._loop, name='engine-phases-http', daemon=True); self.record['threadCreated'] = True
        self.thread.start(); self.record['threadStarted'] = True
        if not self.settled.wait(SERVER_READY_TIMEOUT): raise TimeoutError('server loop not ready before deadline')
        if self.exited.is_set(): raise RuntimeError('server loop exited before readiness: '+str(self.record['loopError']))
        self.record['started'] = True
        return self.server.server_port

    def stop(self):
        """Idempotent; releases what exists and reports what could not be released."""
        r = self.record
        if r['shutdown'] or self.server is None: return r
        errors = []
        if r['threadStarted']:
            self.stopping.set(); r['stopRequested'] = True
            self.thread.join(SERVER_STOP_TIMEOUT); r['threadJoined'] = not self.thread.is_alive()
            if not r['threadJoined']: errors.append('server thread still running after stop timeout')
        if not r['socketClosed']:
            try: self.server.server_close(); r['socketClosed'] = True
            except Exception as error: errors.append(f'server_close {type(error).__name__}: {error}')
        if r['loopError']: errors.append('server loop failed: '+r['loopError'])
        r['shutdown'] = r['socketClosed'] and r['threadJoined'] is not False
        if errors: r['error'] = '; '.join(errors); raise RuntimeError(r['error'])
        return r


def _text(value):
    """Diagnostic text that can always be written: lone surrogates become backslash escapes."""
    return str(value).encode('utf-8', 'backslashreplace').decode('utf-8')


def encode_evidence(result):
    """Strict UTF-8 JSON bytes, the encoding used, and the serialization error if a fallback was needed.

    A lone surrogate (valid escaped JSON from a browser) cannot be UTF-8 encoded; one ASCII-escaped retry keeps
    the identical value. Anything else unserializable (or NaN) yields a labelled minimal FAIL record instead.
    """
    attempt = result.get('attempt') if isinstance(result.get('attempt'), dict) else None
    failure = None
    for encoding, ascii_only in [('utf-8', False), ('ascii-escaped', True)]:
        if attempt is not None: attempt['evidenceEncoding'] = encoding
        try: return (json.dumps(result, ensure_ascii=ascii_only, allow_nan=False, indent=2)+'\n').encode('utf-8'), encoding, None
        except UnicodeEncodeError as error: failure = error  # only a lone surrogate; the ASCII retry escapes it
        except (TypeError, ValueError, RecursionError) as error: failure = error; break
    if attempt is not None: attempt['evidenceEncoding'] = 'fallback'
    error = failure
    fallback = {'status': 'FAIL', 'official': False, 'validDiagnosticEvidence': False,
                'evidenceSerializationError': _text(f'{type(error).__name__}: {error}'), 'originalStatus': _text(result.get('status')),
                'attemptId': attempt and attempt.get('attemptId'), 'failures': attempt and attempt.get('failures'),
                'note': 'full attempt record was not JSON-serializable; this minimal record replaces it'}
    data = json.dumps(fallback, ensure_ascii=True, allow_nan=False, indent=2, default=lambda o: f'UNSERIALIZABLE {type(o).__name__}')
    return (data+'\n').encode('utf-8'), 'fallback', error


def persist(output, data, attempt_id):
    """Never replaces an existing file: write a unique sibling, then hard-link it into place."""
    pending = output.with_name(f'{output.name}.{attempt_id}.pending'); created = False
    try:
        with open(pending, 'xb') as f:
            created = True; f.write(data); f.flush(); os.fsync(f.fileno())
    except OSError as error:
        if created:  # only our own incomplete file; an unrelated file of the same name is left alone
            try: pending.unlink()
            except OSError: pass
        sys.stderr.write(_text(f'EVIDENCE_PERSISTENCE_FAILED {type(error).__name__}: {error}')+'\n'+data.decode('utf-8')); return None
    try: os.link(pending, output)
    except OSError as error:
        sys.stderr.write(_text(f'EVIDENCE_PERSISTENCE_FAILED {type(error).__name__}: {error}; record kept at {pending}')+'\n'); return pending
    try: pending.unlink()
    except OSError as error: sys.stderr.write(_text(f'evidence written; pending copy not removed: {error}')+'\n')
    return output


def check_load(value):
    if not isinstance(value, (tuple, list)) or len(value)!=3 or any(
        type(x) not in (int, float) or not math.isfinite(x) or x<0 for x in value):
        raise ValueError('load average must contain three finite nonnegative numbers')


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['baseline','phase','chrome','fixtures','output']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--candidate', type=Path)
    p.add_argument('--trials', type=int, choices=[3, 8], default=3)
    p.add_argument('--backend', choices=['chrome', 'webkit'], default='chrome')
    p.add_argument('--samples', type=Path, default=ROOT/'external/rhwp/samples', help='rhwp sample root (default: pinned submodule)')
    a=p.parse_args(argv)
    # Preflight: nothing launched yet, so a failure here is a usage error without an attempt record.
    if a.output.exists() or a.output.is_symlink():p.error('preserve previous output')
    if not a.output.parent.is_dir():p.error('output directory does not exist')
    bases={'baseline':a.baseline.resolve(),'off':a.phase.resolve(),'on':a.phase.resolve()}
    if a.candidate: bases['candidate']=a.candidate.resolve()
    config={'arms':list(bases),'trials':a.trials}
    fixtures={'basic-ko.hwp':a.fixtures/'basic-ko.hwp','basic-ko.hwpx':a.fixtures/'basic-ko.hwpx',
              'chemical.hwp':a.samples/'rnote/연구노트(화학).hwp',
              'asset.hwpx':a.samples/'issue6031/3249937_asset_management_rules.hwpx'}
    inputs={'harness':Path(__file__),'browser':HERE/'browser.mjs','browserLauncher':a.chrome.resolve(),**fixtures}
    for label,base in bases.items():
        if not base.is_dir():p.error(f'{label} package directory missing')
        for f in base.rglob('*'):
            if f.is_file():inputs[label+'/'+str(f.relative_to(base))]=f
    hashes=lambda:{k:hashlib.sha256(f.read_bytes()).hexdigest() for k,f in inputs.items()}
    try: before=hashes()
    except OSError as error: p.error(f'input unavailable: {error}')
    try:
        load_before=os.getloadavg(); check_load(load_before)
    except Exception as error:
        p.error(f'load average unavailable or invalid: {_text(error)}')

    # Execution attempt: from here every outcome is persisted, failures included.
    attempt={'attemptId':uuid.uuid4().hex,'stage':'server-start','failures':[],'browserProcess':None,
             'server':None,'receivedResultCount':0,'validated':False,
             'profileRemoved':None,'validDiagnosticEvidence':False}
    def fail(category,error):
        attempt['failures'].append({'stage':attempt['stage'],'category':category,'type':type(error).__name__,'message':_text(error)})
    received=[];complete=threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            size=int(self.headers.get('Content-Length','0'))
            if self.path!='/result' or not 0<size<8<<20:self.send_error(400);return
            try: row=json.loads(self.rfile.read(size))
            except (ValueError,UnicodeError):self.send_error(400);return
            received.append(row);self.send_response(204);self.end_headers();complete.set()
        def do_GET(self):
            name=self.path.split('?')[0];data=None;mime='text/javascript'
            if name=='/config.json':data=json.dumps(config).encode();mime='application/json'
            elif name=='/':data=b'<script type="module" src="/browser.mjs"></script>';mime='text/html'
            elif name=='/browser.mjs':data=(HERE/'browser.mjs').read_bytes()
            elif name.startswith('/fixtures/') and name[10:] in fixtures:data=fixtures[name[10:]].read_bytes();mime='application/octet-stream'
            else:
                for label,base in bases.items():
                    prefix='/'+label+'/'
                    if name.startswith(prefix):
                        f=(base/name[len(prefix):]).resolve()
                        if f.is_relative_to(base) and f.is_file():data=f.read_bytes();mime='application/wasm' if f.suffix=='.wasm' else 'text/javascript'
            if data is None:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',mime);self.end_headers();self.wfile.write(data)
    server=LocalServer(Handler);attempt['server']=server.record;browser=profile=log=None;interrupted=None
    try:
        port=server.start()
        attempt['stage']='browser-launch'
        profile=tempfile.mkdtemp(prefix='geul-engine-phases-');log=tempfile.TemporaryFile(mode='w+')
        process=subprocess.Popen([str(a.chrome),'--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-sync','--user-data-dir='+profile,'http://127.0.0.1:'+str(port)],stdout=log,stderr=log,start_new_session=True)
        browser=Browser(process);attempt['browserProcess']=browser.record
        attempt['stage']='await-result'
        deadline=time.monotonic()+RESULT_TIMEOUT
        while not complete.wait(1):
            browser.observe()
            if browser.exited():raise RuntimeError('browser exited before reporting')
            if time.monotonic()>deadline:raise TimeoutError('no browser result before deadline')
        time.sleep(.2);browser.observe()
        attempt['stage']='validate'
        if len(received)!=1:raise ValueError('duplicate completion')
        if not isinstance(received[0],dict):raise ValueError('browser result is not a JSON object')
        validate(received[0],config);attempt['validated']=True
    except Exception as error:
        fail({'browser-launch':'launch','await-result':'browser-result','validate':'validation'}.get(attempt['stage'],'setup'),error)
    except BaseException as error:
        fail('interrupted',error);interrupted=error
    # Cleanup: each owned resource is released independently; one failure never skips the others.
    attempt['stage']='cleanup'
    if browser:
        try:browser.stop()
        except Exception as error:fail('browser-cleanup',error)
    tail=None
    if log:
        try:log.seek(0);tail=log.read()[-1500:]
        except Exception as error:fail('log-collection',error)
        try:log.close()
        except Exception as error:fail('log-collection',error)
    try:server.stop()
    except Exception as error:fail('server-cleanup',error)
    if profile:
        try:shutil.rmtree(profile);attempt['profileRemoved']=True
        except Exception as error:attempt['profileRemoved']=False;fail('profile-cleanup',error)
    attempt['receivedResultCount']=len(received)
    if len(received)>1 and attempt['validated']:fail('browser-result',ValueError('duplicate completion after validation'))
    payload=received[0] if received else None
    result=dict(payload) if isinstance(payload,dict) else {}
    if payload is not None and not isinstance(payload,dict):result['invalidBrowserResult']=payload
    result['browserReportedStatus']=payload.get('status',UNAVAILABLE) if isinstance(payload,dict) else UNAVAILABLE
    attempt['stage']='dependency-recheck';stable=None
    try:stable=hashes()==before
    except Exception as error:fail('dependency-recheck',error)
    if stable is False:fail('dependency-recheck',RuntimeError('executed dependency hashes changed'))
    attempt['stage']='metadata';version=None
    try:version=subprocess.check_output([str(a.chrome),'--version'],text=True,timeout=METADATA_TIMEOUT,stderr=subprocess.DEVNULL).strip()
    except Exception as error:result['browserMetadataError']=str(error);fail('metadata',error)
    record=browser.record if browser else None
    if record and not record['cleanupSucceeded']:fail('browser-cleanup',RuntimeError('owned browser processes not fully released'))
    if record and record['cleanupSucceeded'] and not record['gracefulExit']:
        result['launcherError']='browser launcher failed during shutdown';fail('browser-cleanup',RuntimeError(result['launcherError']))
    # System metadata is acceptance-relevant: collect independently before the verdict.
    attempt['stage']='system-metadata'
    system={}
    def collect(field, getter, validate_value):
        try:
            value=getter(); validate_value(value); system[field]=value
        except Exception as error:
            system[field]=None
            fail('system-metadata',error)
            attempt['failures'][-1]['field']=field
    def check_cpu(value):
        # os.cpu_count() explicitly permits None when the count cannot be determined.
        if value is not None and (type(value) is not int or value<1):
            raise ValueError('logical CPU count must be a positive integer or None')
    def check_allowed(value):
        if type(value) is not int or value<1: raise ValueError('allowed CPU count must be a positive integer')
    collect('loadBefore',lambda:load_before,check_load)
    collect('loadAfter',os.getloadavg,check_load)
    collect('logicalCpuCount',os.cpu_count,check_cpu)
    def allowed_cpu_count():
        cpus=os.sched_getaffinity(0)
        if not isinstance(cpus, set) or any(type(cpu) is not int or cpu<0 for cpu in cpus):
            raise ValueError('CPU affinity must be a set of nonnegative integers')
        return len(cpus)
    collect('allowedCpuCount',allowed_cpu_count,check_allowed)
    attempt['stage']='persist'
    ok=not attempt['failures'] and attempt['validated'] and stable is True and version is not None
    attempt['validDiagnosticEvidence']=ok
    result.update(status='DIAGNOSTIC_COMPLETE' if ok else 'FAIL',attempt=attempt,candidate={k:v for k,v in before.items() if k.startswith('candidate/') and k.endswith('.wasm')} or None,
        browserExitAfterStop=browser.process.returncode if browser else None,
        browserLogTail=tail,system=system,
        requestConfig=config,identities=before,executedDependenciesStable=stable,browserBackend=a.backend,official=False,browserVersion=version)
    if attempt['failures']:result['validationError']=attempt['failures'][0]['message']
    data,encoding,serialization_error=encode_evidence(result)
    if serialization_error is not None:
        sys.stderr.write(_text(f'EVIDENCE_SERIALIZATION_FAILED {type(serialization_error).__name__}: {serialization_error}; diagnostic status {result["status"]}; writing minimal FAIL record')+'\n')
    written=persist(a.output,data,attempt['attemptId'])
    print(result['status'],_text(result.get('validationError')),flush=True)
    if interrupted is not None:raise interrupted
    if written!=a.output or serialization_error is not None:return 3
    return 0 if ok else 1


if __name__=='__main__':raise SystemExit(main())
