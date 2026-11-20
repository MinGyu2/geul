import argparse, hashlib, importlib.util, json, shutil, subprocess, sys, traceback
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]; sys.path.insert(0,str(ROOT/'scripts/tests'))
spec=importlib.util.spec_from_file_location('p6',ROOT/'scripts/tests/native-stage3-p6.py'); p6=importlib.util.module_from_spec(spec);spec.loader.exec_module(p6)
ORACLE=r'''
const fs=require('fs'),path=require('path'),root=process.cwd(), m=JSON.parse(fs.readFileSync('public/rhwp/RELEASE.json'));
const p=path.join(root,'public/rhwp/generations',m.generation), r=require(path.join(p,'rhwp.js'));r.initSync({module:fs.readFileSync(path.join(p,'rhwp_bg.wasm'))});
const d=new r.HwpDocument(fs.readFileSync(process.argv[1]));try {
const sh=JSON.parse(d.getPageControlLayout(0)).controls.find(x=>x.type==='shape');
const a=[sh.secIdx,sh.paraIdx,sh.controlIdx,65534], n=d.getCellParagraphCount(...a);
const texts=Array.from({length:n},(_,i)=>d.getTextInCell(...a,i,0,d.getCellParagraphLength(...a,i)));
const aligns=Array.from({length:n},(_,i)=>JSON.parse(d.getCellParaPropertiesAt(...a,i)).alignment);
const len=d.getCellParagraphLength(...a,0), caret=JSON.parse(d.getCursorRectInCell(...a,0,len));
console.log(JSON.stringify({generation:m.generation,shape:sh,props:JSON.parse(d.getShapeProperties(sh.secIdx,sh.paraIdx,sh.controlIdx)),texts,aligns,caret,body:d.getTextRange(0,0,0,d.getParagraphLength(0,0)),atnos:JSON.parse(d.getControls()).filter(c=>c.ctrlId==='atno')}));
} finally {d.free()}
'''
def oracle(path): return json.loads(subprocess.check_output(['node','-e',ORACLE,str(path)],cwd=ROOT,text=True))
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def run(acc,fmt,out):
    source=ROOT/'target/stage3-caption-native-20261120'/('fixture.'+fmt); target=out/('caption.'+fmt);shutil.copyfile(source,target)
    before=oracle(source); acc.open_native(fmt,target);acc.engine('xkb:us::eng'); p6.gso.choose(acc,before['shape'],'shape')
    at=before['caret'];p6.pointer(acc,(at['pageIndex'],at['x']+1,at['y']+at['height']/2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
    state=lambda:acc.status(fmt)
    first=state();acc.type('First');acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('First')");acc.settle(fmt)
    acc.key('Return');acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/') && document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText===''");acc.type('Second');acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText==='Second'");acc.settle(fmt)
    acc.key('Home','BackSpace');acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('FirstSecond')");acc.settle(fmt)
    acc.key('ctrl+z');acc.settle(fmt)
    (out / ('debug-undo-'+fmt+'.json')).write_text(json.dumps(state(),ensure_ascii=False,indent=2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText==='Second'",timeout=5)
    acc.key('Home','shift+Left');acc.type('-');acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('First-Second')");acc.settle(fmt)
    acc.key('ctrl+z');acc.settle(fmt)
    (out / ('debug-selection-undo-'+fmt+'.json')).write_text(json.dumps(state(),ensure_ascii=False,indent=2))
    acc.wait("const s=document.querySelector('[data-testid=rhwp-status]');return s?.dataset.paragraphText.endsWith('First') && s.dataset.selection!==''",timeout=5)
    acc.key('ctrl+y');acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('First-Second')");acc.settle(fmt)
    acc.key('ctrl+z');acc.wait("const s=document.querySelector('[data-testid=rhwp-status]');return s?.dataset.paragraphText.endsWith('First') && s.dataset.selection!==''");acc.settle(fmt)
    acc.key('Right');acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText==='Second'");acc.key('ctrl+e');acc.settle(fmt)
    saved=acc.save(fmt); after=oracle(target)
    assert after['texts']==[before['texts'][0]+'First','Second'],after
    assert after['aligns'][1]=='center',after['aligns'];assert after['atnos']==before['atnos'];assert after['props']==before['props'];assert after['body']==before['body']
    assert p6.p4.rhwp_poc.close_tab(acc.d,target.name);acc.open_native(fmt,target)
    at=after['caret'];p6.pointer(acc,(at['pageIndex'],at['x']+1,at['y']+at['height']/2));acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
    return {'status':'PASS','sourceSha256':sha(source),'savedSha256':sha(target),'firstCaret':first['caret'],'finalCaret':state()['caret'],'save':saved,'before':before,'after':after,'reopenedInApp':True,'input':'X11 pointer and xdotool keyboard; xkb:us::eng; no IBus composition'}
if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('--out',type=Path,required=True);a.add_argument('--xdotool',required=True);a.add_argument('--ibus',required=True);a.add_argument('--formats',nargs='+',default=['hwp','hwpx']);a.add_argument('--driver',default='/tmp/geul-tauri-driver-target/debug/tauri-driver');args=a.parse_args();args.out=args.out.resolve();args.out.mkdir(parents=True,exist_ok=False)
    app=ROOT/'src-tauri/target/release/geul';p6.p4.smoke.APP=str(app);p6.p4.smoke.DRIVER_LOG=str(args.out/'driver.log');report={'appSha256':sha(app),'cases':{}}
    for fmt in args.formats:
      try:
        with p6.p4.smoke.tauri_driver(args.driver,4469,str(args.out/('data-'+fmt))) as start:
          d=start()
          try:
            acc=p6.p4.P4Acceptance(args,d,report);acc.wait("return !!document.querySelector('.document-bar')",timeout=30);acc.focus_window();acc.calibrate_pointer();report['cases'][fmt]=run(acc,fmt,args.out)
          finally:d.quit()
      except Exception: report['cases'][fmt]={'status':'FAIL','error':traceback.format_exc()}
      (args.out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False,indent=2));sys.exit(0 if all(x['status']=='PASS' for x in report['cases'].values()) else 1)
