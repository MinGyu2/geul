#!/usr/bin/env python3
"""Record-level diff of two HWP 5 files (original vs edited export), for serializer diagnosis.

    python3 -I scripts/tests/hwp_record_diff.py ORIGINAL.hwp EDITED.hwp [--json OUT] [--stream DocInfo]

Minimal read-only CFB (v3/v4) reader + raw-deflate (FileHeader bit 0) + HWP record headers
(tag 10 bits, level 10 bits, size 12 bits; 0xFFF = 32-bit extended size). Streams are compared by
name and SHA-256; record streams (DocInfo, BodyText/Section*) are aligned with difflib on
(tag, level, payload hash) and reported as inserted / deleted / modified / equal runs.
"""
import difflib, hashlib, json, struct, sys, zlib

FREESECT, ENDOFCHAIN = 0xFFFFFFFF, 0xFFFFFFFE


def cfb_streams(data):
    if data[:8] != bytes.fromhex("d0cf11e0a1b11ae1"):
        raise ValueError("not CFB")
    sector_shift, mini_shift = struct.unpack_from("<HH", data, 30)
    ss, ms = 1 << sector_shift, 1 << mini_shift
    n_fat, dir_start, _, mini_cutoff, minifat_start, n_minifat, difat_start, n_difat = struct.unpack_from("<IIIIIIII", data, 44)
    sector = lambda i: data[(i + 1) * ss:(i + 2) * ss]
    difat = list(struct.unpack_from("<109I", data, 76))
    d = difat_start
    for _ in range(n_difat):
        s = sector(d); vals = struct.unpack(f"<{ss // 4}I", s); difat += vals[:-1]; d = vals[-1]
    fat = []
    for i in difat[:n_fat]:
        fat += struct.unpack(f"<{ss // 4}I", sector(i))
    def chain(start, table):
        out, seen = [], set()
        while start not in (ENDOFCHAIN, FREESECT) and start < len(table) and start not in seen:
            seen.add(start); out.append(start); start = table[start]
        return out
    directory = b"".join(sector(i) for i in chain(dir_start, fat))
    entries = []
    for off in range(0, len(directory), 128):
        e = directory[off:off + 128]
        name_len = struct.unpack_from("<H", e, 64)[0]
        name = e[:max(0, name_len - 2)].decode("utf-16-le", "replace")
        typ = e[66]; left, right, child = struct.unpack_from("<III", e, 68)
        start, size = struct.unpack_from("<IQ", e, 116)
        entries.append(dict(name=name, type=typ, left=left, right=right, child=child, start=start, size=size & 0xFFFFFFFF))
    root = entries[0]
    ministream = b"".join(sector(i) for i in chain(root["start"], fat))
    minifat = []
    for i in chain(minifat_start, fat):
        minifat += struct.unpack(f"<{ss // 4}I", sector(i))
    streams = {}
    def walk(i, prefix):
        if i >= len(entries) or i == FREESECT: return
        e = entries[i]
        walk(e["left"], prefix); walk(e["right"], prefix)
        path = prefix + e["name"]
        if e["type"] == 2:
            if e["size"] < mini_cutoff:
                raw = b"".join(ministream[j * ms:(j + 1) * ms] for j in chain(e["start"], minifat))
            else:
                raw = b"".join(sector(j) for j in chain(e["start"], fat))
            streams[path] = raw[:e["size"]]
        elif e["type"] == 1:
            walk(e["child"], path + "/")
    walk(root["child"], "")
    return streams


def records(raw):
    out, at = [], 0
    while at + 4 <= len(raw):
        h = struct.unpack_from("<I", raw, at)[0]; at += 4
        tag, level, size = h & 0x3FF, (h >> 10) & 0x3FF, h >> 20
        if size == 0xFFF:
            size = struct.unpack_from("<I", raw, at)[0]; at += 4
        out.append((tag, level, raw[at:at + size])); at += size
    return out


def unpacked(streams, name):
    data = streams[name]
    compressed = streams["FileHeader"][36] & 1
    return zlib.decompress(data, -15) if compressed else data


def diff_stream(a, b):
    ra, rb = records(a), records(b)
    key = lambda r: (r[0], r[1], hashlib.sha256(r[2]).hexdigest()[:16])
    ka, kb = [key(r) for r in ra], [key(r) for r in rb]
    ops = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ka, kb, autojunk=False).get_opcodes():
        if op == "equal": continue
        item = {"op": op, "original": [], "output": []}
        for i in range(i1, i2): item["original"].append({"index": i, "tag": ra[i][0], "level": ra[i][1], "len": len(ra[i][2]), "hex": ra[i][2][:96].hex()})
        for j in range(j1, j2): item["output"].append({"index": j, "tag": rb[j][0], "level": rb[j][1], "len": len(rb[j][2]), "hex": rb[j][2][:96].hex()})
        ops.append(item)
    return {"records": [len(ra), len(rb)], "changes": ops}


def main():
    args = sys.argv[1:]
    out = None; only = None
    if "--json" in args: i = args.index("--json"); out = args[i + 1]; del args[i:i + 2]
    if "--stream" in args: i = args.index("--stream"); only = args[i + 1]; del args[i:i + 2]
    a, b = (cfb_streams(open(p, "rb").read()) for p in args[:2])
    result = {"streams": {}}
    for name in sorted(set(a) | set(b)):
        if only and only not in name: continue
        entry = {"original": hashlib.sha256(a[name]).hexdigest() if name in a else None,
                 "output": hashlib.sha256(b[name]).hexdigest() if name in b else None}
        if name in a and name in b and (name == "DocInfo" or name.startswith("BodyText/")) and entry["original"] != entry["output"]:
            entry.update(diff_stream(unpacked(a, name), unpacked(b, name)))
        result["streams"][name] = entry
    text = json.dumps(result, indent=1)
    if out: open(out, "w").write(text)
    else: print(text)


if __name__ == "__main__":
    main()
