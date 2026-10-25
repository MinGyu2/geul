"""실제 Chrome/WebKit에서 격리 준비 실험을 실행한다. 수신 JSON을 별도 계약으로 다시 검증한다."""
from pathlib import Path
from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
import argparse,base64,hashlib,json,os,shutil,subprocess,sys,tempfile,threading,time,urllib.error
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[3]
sys.path.insert(0,str(HERE.parent/'cache-concurrency'))
from run import engine,free_port,request,stop
sys.path.insert(0,str(HERE))
from evidence_contract import validate,validate_performance,validate_historical_preparation
from native_d1_result import loads_strict

def main():
 p=argparse.ArgumentParser();p.add_argument('--baseline',type=Path,required=True);p.add_argument('--reference',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True)
 p.add_argument('--browser',choices=('chrome','webkit'),required=True);p.add_argument('--chrome',default=shutil.which('google-chrome'));p.add_argument('--webkit-driver',default=shutil.which('WebKitWebDriver'));p.add_argument('--xvfb');p.add_argument('--timeout',type=float,default=600);mode=p.add_mutually_exclusive_group();mode.add_argument('--probe',action='store_true');mode.add_argument('--performance',action='store_true');mode.add_argument('--historical-preparation',action='store_true');p.add_argument('--output',type=Path,required=True)
 a=p.parse_args()
 if a.output.exists():p.error('기존 실행 증거 보존')
 result={'schema':1,'contract':1,'browser':a.browser,'status':'FAIL','probe':a.probe};received=[];complete=threading.Event();held={}
 paths=[HERE.parent/'ownership-poc/preparation-contract-browser.mjs' if a.historical_preparation else HERE/('probe.mjs' if a.probe else 'performance.mjs' if a.performance else 'browser.mjs'),HERE/'run.py',HERE/'evidence_contract.py',HERE/'runtime.mjs',ROOT/'external/rhwp/samples/rnote/연구노트(화학).hwp']
 paths.extend([ROOT/'external/rhwp/samples/한셀OLE.hwpx',ROOT/'external/rhwp/samples/hwp-3.0-HWPML.hwp',ROOT/'tests/integration/rhwp/ownership-poc/native_d1_result.py'])
 def inputs():
  return {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}|{label+'/'+n:hashlib.sha256((pkg/n).read_bytes()).hexdigest() for label,pkg in [('baseline',a.baseline),('reference',a.reference),('candidate',a.candidate)] for n in ('rhwp.js','rhwp_bg.wasm')}
 # 추가 공식 fixture도 moving branch가 아닌 고정 blob과 대조한다.
 from native_d1_result import RHWP_REVISION,pinned_samples_valid
 if not pinned_samples_valid(ROOT):raise RuntimeError('고정 submodule/기본 sample 신원 불일치')
 for relative in ('samples/한셀OLE.hwpx','samples/hwp-3.0-HWPML.hwp'):
  data=subprocess.check_output(['git','-C',str(ROOT/'external/rhwp'),'show',RHWP_REVISION+':'+relative])
  if (ROOT/'external/rhwp'/relative).read_bytes()!=data:raise RuntimeError('추가 fixture 고정 blob 불일치')
 before=inputs()
 if a.performance and any(before['baseline/'+n]!=before['candidate/'+n] for n in ('rhwp.js','rhwp_bg.wasm')):raise RuntimeError('동일 실행물 성능 대조 필요')
 with ExitStack() as stack:
  tmp=Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='geul-preparation-browser-')));web=tmp/'web';web.mkdir()
  result['identities']={n:engine(src.resolve(),web/n) for n,src in [('baseline',a.baseline),('reference',a.reference),('candidate',a.candidate)]}
  if a.historical_preparation:shutil.copytree(web/'candidate',web/'phase')
  shutil.copyfile(paths[0],web/'browser.mjs');shutil.copyfile(HERE/'runtime.mjs',web/'runtime.mjs');shutil.copyfile(ROOT/'external/rhwp/samples/rnote/연구노트(화학).hwp',web/'chemical.hwp');shutil.copyfile(ROOT/'external/rhwp/samples/한셀OLE.hwpx',web/'ole.hwpx');shutil.copyfile(ROOT/'external/rhwp/samples/hwp-3.0-HWPML.hwp',web/'background.hwp');(web/'index.html').write_text('<meta charset="utf-8"><script type="module" src="/browser.mjs"></script>')
  class Handler(SimpleHTTPRequestHandler):
   def __init__(self,*args,**kw):super().__init__(*args,directory=str(web),**kw)
   def log_message(self,*args):pass
   def end_headers(self):self.send_header('Cache-Control','no-store');super().end_headers()
   def do_GET(self):
    from urllib.parse import urlparse,parse_qs
    parsed=urlparse(self.path);q=parse_qs(parsed.query)
    if parsed.path in ('/held-image','/release-image'):
     event=held.setdefault(q.get('key',[''])[0],threading.Event())
     if parsed.path=='/release-image':event.set();self.send_response(204);self.end_headers();return
     event.wait(20);self.send_response(200);self.send_header('Content-Type','image/svg+xml');self.end_headers()
     try:self.wfile.write(base64.b64decode(q['data'][0].split(',')[1]) if 'error' not in q else b'invalid image')
     except (BrokenPipeError,ConnectionResetError):pass
     return
    super().do_GET()
   def do_POST(self):
    size=int(self.headers.get('Content-Length','0'))
    if self.path!='/result' or not 0<size<16<<20:self.send_error(400);return
    try:value=loads_strict(self.rfile.read(size).decode())
    except ValueError:self.send_error(400);return
    received.append(value);self.send_response(204);self.end_headers();complete.set()
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
  threading.Thread(target=server.serve_forever,daemon=True).start();stack.callback(server.server_close);stack.callback(server.shutdown)
  url=f'http://127.0.0.1:{server.server_port}/index.html';log=stack.enter_context((tmp/'browser.log').open('w+b'))
  try:
   if a.browser=='chrome':
    if not a.chrome:raise RuntimeError('Chrome 없음')
    result['browserVersion']=subprocess.check_output([a.chrome,'--version'],text=True).strip()
    browser=subprocess.Popen([a.chrome,'--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+str(tmp/'profile'),url],stdout=log,stderr=subprocess.STDOUT)
    stack.callback(stop,browser)
   else:
    env={**os.environ,'TMPDIR':str(tmp),'LIBGL_ALWAYS_SOFTWARE':'1','WEBKIT_DISABLE_DMABUF_RENDERER':'1','XDG_DATA_HOME':str(tmp/'data'),'XDG_CACHE_HOME':str(tmp/'cache'),'XDG_CONFIG_HOME':str(tmp/'config')}
    if a.xvfb:
     display=stack.enter_context((tmp/'display').open('w+b'));xvfb=subprocess.Popen([a.xvfb,'-displayfd',str(display.fileno()),'-screen','0','1280x1024x24','-dpi','96'],pass_fds=(display.fileno(),),stdout=log,stderr=subprocess.STDOUT);stack.callback(stop,xvfb)
     deadline=time.monotonic()+10
     while True:
      display.seek(0);number=display.read().decode().strip()
      if number:break
      if time.monotonic()>deadline:raise RuntimeError('Xvfb 시작 실패')
      time.sleep(.05)
     env.update(DISPLAY=':'+number,GDK_BACKEND='x11');env.pop('WAYLAND_DISPLAY',None)
    port=free_port();base=f'http://127.0.0.1:{port}';browser=subprocess.Popen([a.webkit_driver,f'--port={port}'],env=env,stdout=log,stderr=subprocess.STDOUT);stack.callback(stop,browser)
    deadline=time.monotonic()+15
    while True:
     try:request(base,'GET','/status');break
     except (OSError,urllib.error.URLError):
      if time.monotonic()>deadline:raise RuntimeError('WebKit driver 시작 실패')
      time.sleep(.1)
    session=request(base,'POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'MiniBrowser'}}});sid=session['sessionId'];stack.callback(request,base,'DELETE','/session/'+sid)
    result['browserVersion']={k:v for k,v in session['capabilities'].items() if k!='webkit:processID'};request(base,'POST','/session/'+sid+'/url',{'url':url})
   deadline=time.monotonic()+a.timeout
   while not complete.wait(.25):
    if browser.poll() is not None:raise RuntimeError('브라우저 조기 종료')
    if time.monotonic()>deadline:raise RuntimeError('브라우저 완료 결과 없음, 시간 초과')
   time.sleep(.1)
   if len(received)!=1:raise RuntimeError('중복 완료 결과')
   result['run']=received[0]
   if a.historical_preparation:validate_historical_preparation(received[0])
   elif a.performance:validate_performance(received[0])
   else:validate(received[0],probe=a.probe)
   result['status']='DIAGNOSTIC_COMPLETE' if a.probe else 'PASS'
  except Exception as error:result['error']=str(error).replace(str(tmp),'<temporary>')[:1500]
  finally:
   log.seek(0);result['browserLogTail']=log.read().decode(errors='replace')[-2500:].replace(str(tmp),'<temporary>')
   after=inputs();result.update(inputsBefore=before,inputsAfter=after,executedDependenciesStable=before==after)
   if before!=after:result['status']='FAIL';result['dependencyError']='실행 입력 변경'
   text=json.dumps(result,ensure_ascii=False,indent=2).replace(str(ROOT),'<workspace>').replace(str(Path.home()),'<home>')
   a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(text+'\n')
 print(a.browser,result['status'],result.get('error'),flush=True)
 return 0 if result['status'] in ('PASS','DIAGNOSTIC_COMPLETE') else 1

if __name__=='__main__':raise SystemExit(main())
