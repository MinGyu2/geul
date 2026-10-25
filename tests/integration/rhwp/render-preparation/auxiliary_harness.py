"""변경하지 않은 native pending/D3/D5 producer를 실행하고 실제 smoke teardown을 함께 보존한다."""
from pathlib import Path
import json,os,runpy,sys
ROOT=Path(__file__).resolve().parents[4]
SCRIPTS={'pending':'history-pending-native.py','safety':'candidate-safety.py'}
script=ROOT/'tests/integration/rhwp/ownership-poc'/SCRIPTS[os.environ['GEUL_PREPARATION_AUXILIARY']]
sys.path.insert(0,str(script.parent));sys.argv[0]=str(script)
namespace=runpy.run_path(str(script),run_name='observed_auxiliary_producer')
code=1
try:code=namespace['main']()
finally:
 output=Path(sys.argv[sys.argv.index('--output')+1])
 if output.exists():
  value=json.loads(output.read_text());value['teardown']=namespace['smoke'].TEARDOWN
  output.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
raise SystemExit(code)
