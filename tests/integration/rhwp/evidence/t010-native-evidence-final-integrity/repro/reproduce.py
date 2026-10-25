"""이전 판정과 현재 판정에 같은 합성 변조를 적용한다. 실제 native 사건이 아니다."""
from pathlib import Path
import argparse, copy, hashlib, importlib.util, json, subprocess, sys, tempfile
ROOT = Path(__file__).resolve().parents[6]
P = 'tests/integration/rhwp/ownership-poc/'
sys.path.insert(0, str(ROOT / P))
import native_d1_result as current


def main():
    a = argparse.ArgumentParser(); a.add_argument('--output', type=Path, required=True); args = a.parse_args()
    if args.output.exists(): raise SystemExit('기존 증거 보존')
    data = subprocess.check_output(['git', '-C', str(ROOT), 'show', '68c0492:' + P + 'native_d1_result.py'])
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp)/'old.py'; p.write_bytes(data)
        spec = importlib.util.spec_from_file_location('previous', p); old = importlib.util.module_from_spec(spec); spec.loader.exec_module(old)
    base = ROOT/'tests/integration/rhwp/evidence/t010-native-evidence-security-hardening'
    result = json.loads((base/'native-d1-attempt1.json').read_text()); lifecycle = json.loads((base/'native-d1-attempt1-lifecycle.json').read_text())
    trusted = current.load_trust_anchor(ROOT)
    mutations = [('원본', lambda r,l:None), ('문서해시모두교체',lambda r,l:[d.update(sourceSha256='0'*64) for d in r['documents']]),
                 ('문서해시누락',lambda r,l:r['documents'][0].pop('sourceSha256')),
                 ('PID없는프로세스',lambda r,l:l.update(processes=[{'comm':'geul','gone':1}])),
                 ('PID_bool',lambda r,l:l['processes'][0].update(pid=True)),
                 ('상태카운터음수',lambda r,l:l['processes'][0].update(states={'S':-1})),
                 ('관찰시간역전',lambda r,l:l['processes'][0].update(firstSeen=99999)),
                 ('이벤트누락',lambda r,l:l.update(events=[]))]
    records=[]
    for label,change in mutations:
        r,l=copy.deepcopy(result),copy.deepcopy(lifecycle);change(r,l)
        row={'경우':label,'분류':'합성 변조' if label!='원본' else '과거 실제 기록'}
        for name,c,version in [('이전',old,2),('이후',current,3)]:
            # New complete dependency map is only a synthetic control for the validation seam.
            deps={n:trusted.get(n,{path:current.FIXTURE_SHA256[sample] for sample,path in current.PINNED_FIXTURES.items()}.get(n,hashlib.sha256(n.encode()).hexdigest())) for n in c.DEPENDENCY_MANIFESTS[version]}
            v=c.validate(harness_exit=0,result=r,result_error=None,expected_wasm=trusted['rhwp_bg.wasm'],candidate_wasm_before=trusted['rhwp_bg.wasm'],candidate_wasm_after=trusted['rhwp_bg.wasm'],dependencies_before=deps,dependencies_after=deps,lifecycle=l,trusted_identity=trusted,manifest_version=version,**({'attempt':1} if version==3 else {}))
            row[name]={'상태':v['status'],'종료':c.exit_code(v,0),'범주':v['categories']}
        records.append(row)
    report={'분류':'VERIFIED 판정 seam 합성 변조. v3 의존 map은 제어용이며 과거 기록을 v3 실제 실행으로 표시하지 않음.',
            '변조':records,'schema_float':{name:c.exit_code({'schema':float(c.SCHEMA),'status':'PASS','failures':[],'categories':[]},0) for name,c in [('이전',old),('이후',current)]},
            'manifest_v3':list(current.DEPENDENCY_MANIFESTS[3]),'v2에서_누락':[n for n in current.DEPENDENCY_MANIFESTS[3] if n not in old.DEPENDENCY_MANIFESTS[2]]}
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')


if __name__ == '__main__': main()
