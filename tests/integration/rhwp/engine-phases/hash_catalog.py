#!/usr/bin/env python3
"""Explicit checksum records for published evidence; losslessly recover original JSON maps."""
import argparse
import json
from pathlib import Path
import re

HEX = re.compile(r'[0-9a-f]{64}\Z')
TAG = 'sha256Catalog'


def encode(value):
    if isinstance(value, dict):
        if value and all(isinstance(v, str) and HEX.fullmatch(v) for v in value.values()):
            return {TAG: [{'path': k, 'sha256': v} for k, v in value.items()]}
        return {k: encode(v) for k, v in value.items()}
    if isinstance(value, list): return [encode(v) for v in value]
    return value


def decode(value):
    if isinstance(value, dict):
        if set(value) == {TAG}:
            if not isinstance(value[TAG], list): raise ValueError('checksum catalog must be a list')
            result = {}
            for row in value[TAG]:
                if not isinstance(row, dict) or set(row) != {'path', 'sha256'} or not isinstance(row['path'], str) or not isinstance(row['sha256'], str) or not HEX.fullmatch(row['sha256']):
                    raise ValueError('invalid checksum record')
                if row['path'] in result: raise ValueError('duplicate checksum path')
                result[row['path']] = row['sha256']
            return result
        return {k: decode(v) for k, v in value.items()}
    if isinstance(value, list): return [decode(v) for v in value]
    return value


def load_json(path):
    return decode(json.loads(Path(path).read_text()))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['encode', 'decode']); p.add_argument('--input', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists(): p.error('preserve previous artifact')
    value = json.loads(a.input.read_text()); result = encode(value) if a.mode == 'encode' else decode(value)
    if a.mode == 'encode' and decode(result) != value: raise ValueError('checksum catalog round trip failed')
    a.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')


if __name__ == '__main__': main()
