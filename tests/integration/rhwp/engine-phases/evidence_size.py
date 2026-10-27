#!/usr/bin/env python3
"""Report committed evidence size and classify it for retention; read-only, no limit is enforced.

Classes: A acceptance evidence (verdicts, reports, patches, security/delivery records), B compact identities,
summaries, analyses and replay manifests, C large raw producer traces (per-row timings, RGBA/trace dumps) that a
future run keeps local-only under .git/<task>-raw with only their SHA-256 and a summary committed.
"""
import argparse
import hashlib
import json
from pathlib import PurePosixPath
import subprocess

RAW_BYTES = 1 << 20
ACCEPTANCE = ('REPORT', 'REPRODUCE', 'delivery', 'security', 'final-measurement-summary', 'final-native-d1')


def classify(name, size):
    stem = PurePosixPath(name).stem
    if stem.startswith(ACCEPTANCE) or name.endswith('.patch'): return 'A'
    if size >= RAW_BYTES: return 'C'
    return 'B'


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True).stdout


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--tree', default='HEAD'); p.add_argument('--path', required=True); p.add_argument('--output')
    a = p.parse_args()
    commit = git('rev-parse', a.tree).decode().strip()
    entries = [line.split('\t', 1) for line in git('ls-tree', '-r', '-z', commit, '--', a.path).decode().split('\0') if line]
    blobs = [(meta.split()[2], path) for meta, path in entries if meta.split()[1] == 'blob']
    check = subprocess.run(['git', 'cat-file', '--batch-check=%(objectname) %(objectsize) %(objectsize:disk)'],
                           input=''.join(o+'\n' for o, _ in blobs).encode(), check=True, capture_output=True).stdout.decode().split('\n')
    rows = []
    for (oid, path), line in zip(blobs, check):
        name, size, disk = line.split(); size, disk = int(size), int(disk)
        if name != oid: raise ValueError('object listing mismatch')
        rows.append({'path': PurePosixPath(path).name, 'bytes': size, 'objectBytesOnDisk': disk, 'class': classify(path, size),
                     'contentSha256': hashlib.sha256(git('cat-file', 'blob', oid)).hexdigest()})
    total = lambda key, cls=None: sum(r[key] for r in rows if cls is None or r['class'] == cls)
    out = {'commit': commit, 'path': a.path, 'files': len(rows), 'bytes': total('bytes'), 'objectBytesOnDisk': total('objectBytesOnDisk'),
           'objectBytesNote': 'loose zlib or pack delta size in this clone; packing changes it, so it is indicative only',
           'byClass': {c: {'files': sum(r['class'] == c for r in rows), 'bytes': total('bytes', c), 'objectBytesOnDisk': total('objectBytesOnDisk', c)} for c in 'ABC'},
           'rules': {'A': 'REPORT/REPRODUCE/delivery/security/final summaries, native verdict, source patches',
                     'B': f'other files under {RAW_BYTES} bytes: identities, analyses, replay and catalog manifests',
                     'C': f'other files of at least {RAW_BYTES} bytes: raw per-row producer output'},
           'rows': sorted(rows, key=lambda r: -r['bytes'])}
    text = json.dumps(out, ensure_ascii=False, indent=1)+'\n'
    if a.output:
        with open(a.output, 'x', encoding='utf-8') as f: f.write(text)
    else: print(text, end='')


if __name__ == '__main__': main()
