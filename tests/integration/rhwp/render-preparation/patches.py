"""고정 gitlink 대비 완전 패치와 이전 후보 대비 증분 패치를 생성·독립 적용 검증한다."""
from pathlib import Path
import argparse,difflib,hashlib,io,json,subprocess,tarfile,tempfile
from build_candidate import sources,PIN
ROOT=Path(__file__).resolve().parents[4]

def differences(before,after):
 chunks=[];changed=[]
 for n in sorted({p.relative_to(before).as_posix() for p in (before/'src').rglob('*.rs')}|{p.relative_to(after).as_posix() for p in (after/'src').rglob('*.rs')}):
  a,b=before/n,after/n
  left=a.read_text() if a.exists() else '';right=b.read_text() if b.exists() else ''
  if left==right:continue
  changed.append(n);chunks.append(f'diff --git a/{n} b/{n}\n'+('new file mode 100644\n' if not a.exists() else 'deleted file mode 100644\n' if not b.exists() else '')+''.join(difflib.unified_diff(left.splitlines(True),right.splitlines(True),fromfile='a/'+n if a.exists() else '/dev/null',tofile='b/'+n if b.exists() else '/dev/null')))
 return ''.join('\n' if line==' \n' else line for line in ''.join(chunks).splitlines(True)),changed

def main():
 p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--previous',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 if a.output.exists():raise SystemExit('이전 patch 증거 보존; 새 디렉터리 필요')
 a.output.mkdir(parents=True)
 with tempfile.TemporaryDirectory(prefix='geul-prep-patch-') as tmp:
  pinned=Path(tmp)/'pinned';pinned.mkdir()
  blob=subprocess.check_output(['git','-C',str(ROOT/'external/rhwp'),'archive',PIN,'src'])
  with tarfile.open(fileobj=io.BytesIO(blob)) as tar:tar.extractall(pinned,filter='data')
  report={'schema':1,'pinned':PIN,'sourceTreeSha256':sources(a.source)[1],'patches':[]}
  for name,base in [('complete',pinned),('incremental',a.previous)]:
   patch,paths=differences(base,a.source);target=a.output/f'upstream-rhwp-render-preparation-{name}.patch';target.write_text(patch)
   # Fresh archive, never modify either source or previous candidate.
   check=Path(tmp)/name;check.mkdir()
   if name=='complete':
    with tarfile.open(fileobj=io.BytesIO(blob)) as tar:tar.extractall(check,filter='data')
   else:
    import shutil
    shutil.copytree(base/'src',check/'src')
   subprocess.run(['git','apply','--check',str(target.resolve())],cwd=check,check=True)
   subprocess.run(['git','apply',str(target.resolve())],cwd=check,check=True)
   digest=sources(check)[1]
   if digest!=report['sourceTreeSha256']:raise ValueError('독립 패치 적용 소스 불일치')
   report['patches'].append(dict(name=name,paths=paths,sha256=hashlib.sha256(target.read_bytes()).hexdigest(),appliedSourceTreeSha256=digest,status='PASS'))
  (a.output/'patch-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
 print('PASS',report['sourceTreeSha256'])
if __name__=='__main__':main()
