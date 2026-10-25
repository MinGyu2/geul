"""변경하지 않은 과거 및 이번 실제 native 기록을 최종 계약으로 다시 대조한다."""
from pathlib import Path
import argparse, hashlib, json, sys
ROOT=Path(__file__).resolve().parents[6]
sys.path.insert(0,str(ROOT/'tests/integration/rhwp/ownership-poc'))
import native_d1_result as c


def verdict(result,lifecycle,version,attempt):
    trusted=c.load_trust_anchor(ROOT)
    after=result.get('executedDependencySha256After',result['executedDependencySha256'] if result.get('executedDependenciesStable') is True else {})
    return c.validate(harness_exit=result['parentExit'],result=result,result_error=None,expected_wasm=trusted['rhwp_bg.wasm'],
                      candidate_wasm_before=result['executedDependencySha256']['rhwp_bg.wasm'],
                      candidate_wasm_after=after.get('rhwp_bg.wasm'),
                      dependencies_before=result['executedDependencySha256'],dependencies_after=after,
                      lifecycle=lifecycle,trusted_identity=trusted,manifest_version=version,attempt=attempt)


def main():
    a=argparse.ArgumentParser();a.add_argument('--output',type=Path,required=True);args=a.parse_args()
    if args.output.exists():raise SystemExit('기존 증거 보존')
    current=ROOT/'tests/integration/rhwp/evidence/t010-native-evidence-final-integrity'
    rows=[]
    for name,version,attempts in [('t010-readiness-residual-stabilization',1,(1,2,3)),
                                  ('t010-native-evidence-security-hardening',2,(1,2,3)),
                                  ('t010-native-evidence-final-integrity',3,(1,2,4,5,6,7,8,9,10))]:
        base=current.parent/name
        for attempt in attempts:
            rp=base/f'native-d1-attempt{attempt}.json';lp=base/f'native-d1-attempt{attempt}-lifecycle.json'
            r=c.loads_strict(rp.read_text());l=c.loads_strict(lp.read_text());v=verdict(r,l,version,attempt)
            expected='FAIL' if version==3 and attempt==4 else 'PASS'
            assert v['status']==expected,(name,attempt,v['failures'])
            row={'디렉터리':name,'attempt':attempt,'계약':version,'재판정schema':v['schema'],'재판정':v['status'],
                 '범주':v['categories'],'하네스종료':r['parentExit'],'기록된wrapper상태':r['wrapperVerdict']['status'],
                 '단언수':len(r['tests']),'정확RGBA수':r['verifiedExactReferenceCount'],
                 '문서':{d['sample']:d.get('sourceSha256') for d in r['documents']},
                 '의존개수':len(r['executedDependencySha256']),'전후동일보고':r['executedDependenciesStable'],'별도실행후map존재':'executedDependencySha256After' in r,
                 'driverKilled':r['teardown'][0]['driverKilled'],'driverExit':r['teardown'][0]['driverExit'],
                 'DELETE':r['teardown'][0]['sessionDeletes'],'관찰표본':l['samples'],'최종소유생존':len(l['leftAtEnd']),
                 '결과파일SHA256':hashlib.sha256(rp.read_bytes()).hexdigest(),'lifecycle파일SHA256':hashlib.sha256(lp.read_bytes()).hexdigest()}
            if version==3:
                v2=verdict(r,l,2,attempt);assert v2['status']=='FAIL'
                record=c.loads_strict((base/f'native-d1-attempt{attempt}-wrapper-verdict.json').read_text())
                row['기록된wrapper종료규칙']=c.exit_code(record['verdict'],record['harnessExit'])
            else:
                assert verdict(r,l,3,attempt)['status']=='FAIL'
            rows.append(row)
    args.output.write_text(json.dumps({'분류':'VERIFIED 최종 validator로 실제 증거 재판정. 과거 기록은 수정하지 않음',
                                      '주의':'과거 v1/v2 PASS는 v3 실제 실행 통과가 아님. 이번 attempt1/2 후 validator의 pinned map·시간 검사 추가, 최종 코드 재판정 PASS. attempt5/6/7 뒤 독립 호출 attempt 누락 거부를 추가했고, 최종 코드 실제 실행은 attempt8/9/10이다.',
                                      '검증':rows},ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
