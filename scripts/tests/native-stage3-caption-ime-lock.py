import argparse, importlib.util, json, shutil, sys, traceback
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/tests'))
s=importlib.util.spec_from_file_location('acc',ROOT/'scripts/tests/native-stage3-caption-acceptance.py');a=importlib.util.module_from_spec(s);s.loader.exec_module(a);p=a.p6
PARSER=argparse.ArgumentParser();PARSER.add_argument('--out',type=Path,required=True);PARSER.add_argument('--xdotool',required=True);PARSER.add_argument('--ibus',required=True);PARSER.add_argument('--driver',default='/tmp/geul-tauri-driver-target/debug/tauri-driver');args=PARSER.parse_args();args.out=args.out.resolve();args.out.mkdir(parents=True,exist_ok=False)
app=ROOT/'src-tauri/target/release/geul';p.p4.smoke.APP=str(app);p.p4.smoke.DRIVER_LOG=str(args.out/'driver.log');report={'appSha256':a.sha(app),'cases':{}}
for case in ['ime','locked']:
 try:
  with p.p4.smoke.tauri_driver(args.driver,4469,str(args.out/('data-'+case))) as start:
   d=start()
   try:
    acc=p.p4.P4Acceptance(args,d,report);acc.wait("return !!document.querySelector('.document-bar')",timeout=30);acc.focus_window();acc.calibrate_pointer()
    fixture=ROOT/'target/stage3-caption-native-20261120'/('fixture.hwpx' if case=='ime' else 'locked.hwpx');target=args.out/(case+'.hwpx');shutil.copyfile(fixture,target);before=a.oracle(fixture)
    acc.open_native('hwpx',target);acc.engine('xkb:us::eng');p.gso.choose(acc,before['shape'],'shape');at=before['caret'];p.pointer(acc,(at['pageIndex'],at['x']+1,at['y']+at['height']/2))
    if case=='locked':
     acc.settle('hwpx');status=acc.status('hwpx');assert '@caption/' not in status['caret'],status;assert status['revision']=='0';assert a.sha(fixture)==a.sha(target)
     report['cases'][case]={'status':'PASS','sourceSha256':a.sha(fixture),'caret':status['caret'],'revision':status['revision'],'note':'locked shape caption click refused caption entry'}
    else:
     acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
     d.js("window.__imeEvents=[];for(const t of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(t,e=>window.__imeEvents.push({type:t,data:e.data,isTrusted:e.isTrusted}),true)")
     acc.engine('hangul');acc.type('gksrmf');acc.key('End');acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('한글')");acc.settle('hwpx');events=d.js('return window.__imeEvents');assert any(e['type']=='compositionend' and e['isTrusted'] for e in events),events
     save=acc.save('hwpx');after=a.oracle(target);assert after['texts']==[before['texts'][0]+'한글'];assert before['atnos']==after['atnos'] and before['props']==after['props'] and before['body']==after['body'];assert p.p4.rhwp_poc.close_tab(d,target.name);acc.open_native('hwpx',target)
     report['cases'][case]={'status':'PASS','sourceSha256':a.sha(fixture),'savedSha256':a.sha(target),'events':events,'save':save,'after':after['texts'],'reopenedInApp':True}
   finally:d.quit()
 except Exception:report['cases'][case]={'status':'FAIL','error':traceback.format_exc()}
 (args.out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2));sys.exit(0 if all(x['status']=='PASS' for x in report['cases'].values()) else 1)
