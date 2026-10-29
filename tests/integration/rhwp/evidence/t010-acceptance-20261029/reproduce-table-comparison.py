#!/usr/bin/env python3
"""고정 upstream과 공통 표 패치의 8문서 독립 비교. 새 작업 폴더만 사용한다."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
REVISION = '1a76570e833917d15817415a53c09ad61ab3203f'
INPUTS = {
    HERE / 'independent-table-fixtures.json': 'fa49a282851e11046093335703d5424e4f8c25ea89f9d0630adc41115019c994',
    HERE / 'independent-table-producer.rs': '1a098570abd015407aaa1385a85a1e9ca36544cd3eb5e91711c6d99f731fa7fd',
    HERE / 'saved-vpos-common-layout.patch': '9f8b533a55f9af9e81f88f5ac62f08842ec2656d28eb6ebf7aa10628c2813fff',
    HERE.parent / 't010-final-20261028/huge-table-pagination-fix.patch': '3e8e3e86b2e74727b8ca8a4a4bfb14c908e2a8b95bcc2730eca293b76a4b16eb',
}
ARCHIVE_PATHS = ['Cargo.toml','Cargo.lock','build.rs','rustfmt.toml','src','crates','assets','bindings','vendor','saved/blank2010.hwp','ttfs/opensource/NotoSansKR-Regular.ttf']
MODULE_PATTERN = re.compile(r'#\[cfg\(test\)\](\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?!geul_independent_table_tests\b))')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_inputs(root=ROOT):
    upstream = root / 'external/rhwp'
    revision = subprocess.check_output(['git','-C',str(upstream),'rev-parse','HEAD'],text=True).strip()
    if revision != REVISION or subprocess.check_output(['git','-C',str(upstream),'status','--porcelain','--untracked-files=all'],text=True).strip():
        raise RuntimeError('고정 RHWP source가 바뀌었거나 수정되어 있음')
    for path, expected in INPUTS.items():
        if sha(path) != expected:
            raise RuntimeError('비교 입력 신원 불일치: ' + path.name)
    compiler = subprocess.check_output(['rustc','--version'],text=True).strip()
    if not compiler.startswith('rustc 1.99.0 '):
        raise RuntimeError('기존 Rust 1.99.0 도구를 사용해야 함: ' + compiler)
    return upstream, compiler


def prepare(work_root, upstream):
    if work_root.exists() or work_root.is_symlink():
        raise FileExistsError('기존 작업 폴더는 덮어쓰지 않음: ' + str(work_root))
    work_root.mkdir(parents=True)
    archive = subprocess.check_output(['git','-C',str(upstream),'archive',REVISION,*ARCHIVE_PATHS])
    for arm in ('upstream','common'):
        source = work_root / (arm + '-src')
        source.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
            entries.extractall(source,filter='data')
        for directory in ('samples','tests','tools'):
            (source / directory).symlink_to(upstream / directory,target_is_directory=True)
        if arm == 'common':
            for path in (HERE.parent / 't010-final-20261028/huge-table-pagination-fix.patch',HERE / 'saved-vpos-common-layout.patch'):
                command = ['patch','-p1','--batch','--forward','--input',str(path)]
                subprocess.run([*command,'--dry-run'],cwd=source,check=True,capture_output=True)
                subprocess.run(command,cwd=source,check=True,capture_output=True)
        shutil.copy2(HERE / 'independent-table-producer.rs',source / 'src/document_core/geul_independent_table_tests.rs')
        module = source / 'src/document_core/mod.rs'
        module.write_text(module.read_text() + '\n#[cfg(test)]\nmod geul_independent_table_tests;\n')
        # 비교와 무관한 upstream unit-test 모듈의 최적화 빌드를 제외한다.
        # 함수 내부 cfg(test) 분기·필드는 유지한다. 전체 Rust test 합격을 대신하지 않는다.
        excluded = 0
        for path in (source / 'src').rglob('*.rs'):
            if path.name == 'geul_independent_table_tests.rs':
                continue
            old = path.read_text()
            new, count = MODULE_PATTERN.subn(r'#[cfg(any())]\1',old)
            excluded += count
            if new != old:
                path.write_text(new)
        if excluded != 289:
            raise RuntimeError('격리한 test 모듈 수가 기존 비교와 다름: ' + str(excluded))
    return work_root


def verify_arm(source, output, fixtures):
    identity = json.loads((output / 'engine-identity.json').read_text())
    expected = {'manifestRoot':str(source.resolve()),'layoutSha256':sha(source / 'src/renderer/layout/table_layout.rs'),'typesetSha256':sha(source / 'src/renderer/typeset.rs')}
    if identity != expected:
        raise RuntimeError('다른 source의 바이너리 또는 input 신원 불일치')
    required = set()
    samples = ROOT / 'external/rhwp/samples'
    for index, name in enumerate(fixtures):
        name_json = str(index) + '.json'
        required.add(name_json)
        row = json.loads((output / name_json).read_text())
        if row['path'] != name or row['sha256'] != sha(samples / name):
            raise RuntimeError('실행 문서 신원 불일치: ' + name)
        if [s['step'] for s in row['states']] != list(range(13)):
            raise RuntimeError('필수 편집 단계가 빠짐: ' + name)
        for state in row['states']:
            stem = f'{index}-{state["step"]}'
            pagination = stem + '.pagination'
            required.add(pagination)
            if sha(output / pagination) != state['paginationSha256']:
                raise RuntimeError('canonical 출력 신원 불일치')
            svg_hashes = state['svgSha256']
            if len(svg_hashes) != (state['pages'] if state['step'] in (0,12) else 0):
                raise RuntimeError('SVG 필수 계수가 빠짐')
            for page, digest in enumerate(svg_hashes):
                name_svg = f'{stem}-{page}.svg'
                required.add(name_svg)
                if sha(output / name_svg) != digest:
                    raise RuntimeError('SVG 출력 신원 불일치')
    actual = {p.name for p in output.iterdir() if p.is_file() and p.name != 'engine-identity.json'}
    if actual != required:
        raise RuntimeError('누락되거나 예상하지 않은 출력이 있음')
    return identity, required


def compare(upstream_source, common_source, upstream_output, common_output):
    fixtures = json.loads((HERE / 'independent-table-fixtures.json').read_text())
    left, left_names = verify_arm(upstream_source,upstream_output,fixtures)
    right, right_names = verify_arm(common_source,common_output,fixtures)
    if left['layoutSha256'] == right['layoutSha256'] or left['typesetSha256'] == right['typesetSha256']:
        raise RuntimeError('패치가 다른 source 또는 실제 재빌드를 확인할 수 없음')
    differences = sorted(name for name in left_names | right_names if name not in left_names or name not in right_names or (upstream_output / name).read_bytes() != (common_output / name).read_bytes())
    return {'status':'FAIL' if differences else 'PASS','scope':'고정 upstream 대 공통 표 패치의 8문서 독립 비교','fixtures':len(fixtures),'editsPerDocument':12,'canonicalStatesPerDocument':13,'comparedFiles':len(left_names | right_names),'svgComparisons':sum(n.endswith('.svg') for n in left_names),'differences':differences,'upstreamIdentity':left,'commonIdentity':right}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-root',required=True,type=Path)
    parser.add_argument('--target-dir',required=True,type=Path,help='기존 Cargo target 캐시')
    parser.add_argument('--prepare-only',action='store_true')
    args = parser.parse_args()
    upstream, compiler = validate_inputs()
    work = prepare(args.work_root.resolve(),upstream)
    record = {'status':'PREPARED','compiler':compiler,'revision':REVISION,'inputSha256':{p.name:sha(p) for p in INPUTS},'commands':[]}
    (work / 'result.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
    if args.prepare_only:
        print(json.dumps(record,ensure_ascii=False));return 0
    for arm in ('upstream','common'):
        source = work / (arm + '-src')
        # Cargo 공유 target의 이전 arm 바이너리를 재사용하지 않도록 매 실행 직전에 갱신한다.
        (source / 'src/lib.rs').touch()
        command = ['cargo','test','--profile','release-test','--locked','--offline','-p','rhwp','--manifest-path',str(source / 'Cargo.toml'),'--target-dir',str(args.target_dir.resolve()),'--lib','geul_independent_table_layout','--','--ignored','--nocapture']
        env = dict(os.environ,CARGO_BUILD_JOBS='2',GEUL_TABLE_SAMPLES=str(upstream / 'samples'),GEUL_TABLE_MANIFEST=str(HERE / 'independent-table-fixtures.json'),GEUL_TABLE_OUTPUT=str(work / (arm + '-output')))
        with (work / (arm + '.log')).open('x') as log:
            process = subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=600)
        record['commands'].append({'arm':arm,'command':command,'exitCode':process.returncode})
        if process.returncode:
            record['status']='FAIL';(work / 'result.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n');return 1
    record.update(compare(work / 'upstream-src',work / 'common-src',work / 'upstream-output',work / 'common-output'))
    (work / 'result.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in record.items() if k not in ('commands','upstreamIdentity','commonIdentity')},ensure_ascii=False))
    return 0 if record['status']=='PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
