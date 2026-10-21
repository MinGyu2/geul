// T010 Phase 0 PoC 분석 도우미(시험 전용): HWP CFB·레코드, HWPX ZIP·header.xml 비교. 문서 내용은 돌려주지 않는다.
import { inflateRawSync } from "node:zlib";

// ---------- 컨테이너 판독(분석용) ----------
export function zipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lstart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(lstart, lstart + csize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

export function cfbStreams(buf) {
  const ssz = 1 << buf.readUInt16LE(30), mssz = 1 << buf.readUInt16LE(32);
  const sec = (n) => 512 + n * ssz;
  const difat = [];
  for (let i = 0; i < 109; i++) difat.push(buf.readInt32LE(76 + i * 4));
  let dn = buf.readInt32LE(68);
  for (let k = buf.readUInt32LE(72); k > 0 && dn >= 0; k--) {
    for (let i = 0; i < ssz / 4 - 1; i++) difat.push(buf.readInt32LE(sec(dn) + i * 4));
    dn = buf.readInt32LE(sec(dn) + ssz - 4);
  }
  const fat = [];
  for (const s of difat) if (s >= 0) for (let i = 0; i < ssz / 4; i++) fat.push(buf.readInt32LE(sec(s) + i * 4));
  const chain = (start, table) => { const c = []; for (let s = start; s >= 0 && c.length < 1e6; s = table[s]) c.push(s); return c; };
  const read = (start) => Buffer.concat(chain(start, fat).map((s) => buf.subarray(sec(s), sec(s) + ssz)));
  const dir = read(buf.readInt32LE(48));
  const ents = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = dir.readUInt16LE(o + 64);
    ents.push({ name: dir.subarray(o, o + Math.max(0, nl - 2)).toString("utf16le"), type: dir[o + 66], left: dir.readInt32LE(o + 68),
      right: dir.readInt32LE(o + 72), child: dir.readInt32LE(o + 76), start: dir.readInt32LE(o + 116), size: dir.readUInt32LE(o + 120) });
  }
  const minifat = [];
  const mf = read(buf.readInt32LE(60));
  for (let i = 0; i + 4 <= mf.length; i += 4) minifat.push(mf.readInt32LE(i));
  const ministream = read(ents[0].start);
  const streams = new Map();
  const walk = (i, prefix) => {
    if (i < 0) return;
    const e = ents[i];
    walk(e.left, prefix); walk(e.right, prefix);
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === 2) {
      const data = e.size < 4096 ? Buffer.concat(chain(e.start, minifat).map((s) => ministream.subarray(s * mssz, (s + 1) * mssz)))
        : read(e.start);
      streams.set(path, data.subarray(0, e.size));
    } else if (e.type === 1) walk(e.child, path);
  };
  walk(ents[0].child, "");
  return streams;
}

export function records(data) {
  const recs = [];
  for (let p = 0; p + 4 <= data.length;) {
    const h = data.readUInt32LE(p); p += 4;
    let size = h >>> 20;
    if (size === 0xfff) { size = data.readUInt32LE(p); p += 4; }
    recs.push({ tag: h & 0x3ff, level: (h >>> 10) & 0x3ff, data: data.subarray(p, p + size) });
    p += size;
  }
  return recs;
}
export const TAG = { DOCUMENT_PROPERTIES: 16, ID_MAPPINGS: 17, CHAR_SHAPE: 21, PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, PARA_LINE_SEG: 69 };

export function hwpParts(bytes) {
  const streams = cfbStreams(Buffer.from(bytes));
  const compressed = (streams.get("FileHeader").readUInt32LE(36) & 1) === 1;
  const unpack = (d) => (compressed ? inflateRawSync(d) : d);
  const docinfo = records(unpack(streams.get("DocInfo")));
  const sections = [...streams.keys()].filter((n) => /^BodyText\/Section\d+$/.test(n)).map((n) => ({ name: n, recs: records(unpack(streams.get(n))) }));
  return { streams, docinfo, sections };
}
const hex = (b) => Buffer.from(b).toString("hex");
const idMappings = (docinfo) => {
  const r = docinfo.find((x) => x.tag === TAG.ID_MAPPINGS);
  return Array.from({ length: r.data.length / 4 }, (_, i) => r.data.readInt32LE(i * 4));
};

/** HWP DocInfo 비교: 태그별 레코드 수·바뀐 자리, 덧붙인 CHAR_SHAPE를 빼고 ID_MAPPINGS 글자 모양 수를 되돌리면 원본과 같은지. */
export function docinfoDiff(origBytes, outBytes) {
  const a = hwpParts(origBytes).docinfo, b = hwpParts(outBytes).docinfo;
  const byTag = (recs) => recs.reduce((m, r) => m.set(r.tag, (m.get(r.tag) ?? 0) + 1), new Map());
  const ta = byTag(a), tb = byTag(b);
  const counts = {};
  for (const t of new Set([...ta.keys(), ...tb.keys()])) if (ta.get(t) !== tb.get(t)) counts[t] = [ta.get(t) ?? 0, tb.get(t) ?? 0];
  const ma = idMappings(a), mb = idMappings(b);
  const mapDiff = ma.map((v, i) => (v !== mb[i] ? { index: i, before: v, after: mb[i] } : null)).filter(Boolean);
  // 좁은 예외 가정: 출력에서 원본 수를 넘는 CHAR_SHAPE를 지우고 ID_MAPPINGS[9]를 원본 값으로 되돌리면 원본 레코드 열과 같다(캐럿 제외).
  const origShapes = ta.get(TAG.CHAR_SHAPE) ?? 0;
  let seen = 0;
  const reduced = b.filter((r) => r.tag !== TAG.CHAR_SHAPE || seen++ < origShapes)
    .map((r) => (r.tag === TAG.ID_MAPPINGS ? { ...r, data: Buffer.from(a.find((x) => x.tag === TAG.ID_MAPPINGS).data) } : r));
  const changedAt = [];
  const len = Math.max(a.length, reduced.length);
  for (let i = 0; i < len; i++) {
    const x = a[i], y = reduced[i];
    if (!x || !y || x.tag !== y.tag || x.level !== y.level || !x.data.equals(y.data)) {
      const caretOnly = x && y && x.tag === TAG.DOCUMENT_PROPERTIES && x.data.length === 26 && y.data.length === 26 && x.data.subarray(0, 14).equals(y.data.subarray(0, 14));
      if (!caretOnly) changedAt.push({ index: i, tag: x?.tag ?? null, outTag: y?.tag ?? null, origLen: x?.data.length, outLen: y?.data.length });
    }
  }
  // 덧붙인 모양: 원본의 어떤 CHAR_SHAPE와 attr 서식 비트(기울임 0·굵게 1·밑줄 2-3·밑줄 모양 4-7·취소선 18-20·취소선 모양 26-29)만 다른가.
  const FORMAT_BITS = (1 << 0) | (1 << 1) | (0b11 << 2) | (0b1111 << 4) | (0b111 << 18) | (0b1111 << 26);
  const oShapes = a.filter((r) => r.tag === TAG.CHAR_SHAPE), nShapes = b.filter((r) => r.tag === TAG.CHAR_SHAPE).slice(origShapes);
  const ATTR = 46; // 언어별 글꼴 ID(14)·장평(7)·자간(7)·상대 크기(7)·글자 위치(7)·기준 크기(4) 뒤의 속성 u32
  const appended = nShapes.map((n) => {
    const match = oShapes.findIndex((o) => o.data.length === n.data.length
      && o.data.subarray(0, ATTR).equals(n.data.subarray(0, ATTR)) && o.data.subarray(ATTR + 4).equals(n.data.subarray(ATTR + 4))
      && ((o.data.readUInt32LE(ATTR) ^ n.data.readUInt32LE(ATTR)) & ~FORMAT_BITS) === 0);
    return { len: n.data.length, onlyFormatBitsFrom: match };
  });
  const unchangedPrefixShapes = oShapes.every((o, i) => o.data.equals(b.filter((r) => r.tag === TAG.CHAR_SHAPE)[i]?.data ?? Buffer.alloc(0)));
  return { recordCounts: counts, idMappingChanges: mapDiff, appendedCharShapes: appended, originalCharShapesUnchanged: unchangedPrefixShapes,
    otherRecordDifferencesAfterRemovingAppended: changedAt, narrowExceptionWouldCover: changedAt.length === 0 && appended.every((x) => x.onlyFormatBitsFrom >= 0) && unchangedPrefixShapes };
}

/** HWP 본문 구역 비교: 레코드 태그별로 몇 개가 바뀌었나(PARA_CHAR_SHAPE·LINE_SEG 등). */
export function sectionDiff(origBytes, outBytes) {
  const a = hwpParts(origBytes).sections, b = hwpParts(outBytes).sections;
  const res = {};
  a.forEach((s) => {
    const t = b.find((x) => x.name === s.name)?.recs ?? []; // CFB 디렉터리 순서는 파일마다 다를 수 있어 이름으로 짝짓는다
    const changed = {};
    for (let k = 0; k < Math.max(s.recs.length, t.length); k++) {
      const x = s.recs[k], y = t[k];
      if (!x || !y || x.tag !== y.tag || !x.data.equals(y.data)) { const tag = x?.tag ?? y?.tag; changed[tag] = (changed[tag] ?? 0) + 1; }
    }
    res[s.name] = { records: [s.recs.length, t.length], changedByTag: changed };
  });
  return res;
}

export const charPrs = (xml) => [...xml.matchAll(/<hh:charPr\b[\s\S]*?<\/hh:charPr>/g)].map((m) => m[0]);
const charPrBody = (el) => el.replace(/^<hh:charPr\b([^>]*)>/, (_, attrs) => `<hh:charPr${attrs.replace(/\sid="\d+"/, "")}>`);
/** HWPX header.xml·구역 비교: 덧붙인 charPr·itemCnt·다른 차이, 구역의 charPrIDRef 변화, 그 밖의 부분. */
export function hwpxDiff(origBytes, outBytes) {
  const a = zipEntries(Buffer.from(origBytes)), b = zipEntries(Buffer.from(outBytes));
  const ha = a.get("Contents/header.xml").toString("utf8"), hb = b.get("Contents/header.xml").toString("utf8");
  const ca = charPrs(ha), cb = charPrs(hb);
  const itemCnt = (x) => x.match(/<hh:charProperties itemCnt="(\d+)"/)?.[1];
  // 좁은 예외 가정: 덧붙인 charPr을 지우고 itemCnt를 되돌리면 원본 header.xml 문자열과 같다.
  let reduced = hb;
  for (const el of cb.slice(ca.length)) reduced = reduced.replace(el, "");
  reduced = reduced.replace(/<hh:charProperties itemCnt="\d+"/, `<hh:charProperties itemCnt="${itemCnt(ha)}"`);
  const strip = (el) => charPrBody(el).replace(/<hh:(bold|italic)\/>/g, "").replace(/<hh:underline [^>]*\/>/, "").replace(/<hh:strikeout [^>]*\/>/, "");
  const appended = cb.slice(ca.length).map((el) => ({ id: el.match(/\sid="(\d+)"/)?.[1], onlyFormatFrom: ca.findIndex((o) => strip(o) === strip(el)) }));
  const parts = [...new Set([...a.keys(), ...b.keys()])].filter((n) => !a.has(n) || !b.has(n) || !a.get(n).equals(b.get(n)));
  const sections = {};
  for (const n of parts.filter((x) => /^Contents\/section\d+\.xml$/.test(x))) {
    const sa = a.get(n)?.toString("utf8") ?? "", sb = b.get(n)?.toString("utf8") ?? "";
    const refs = (s) => [...s.matchAll(/charPrIDRef="(\d+)"/g)].map((m) => m[1]);
    const neutral = (s) => s.replace(/charPrIDRef="\d+"/g, 'charPrIDRef="*"');
    sections[n] = { charPrIDRefs: [refs(sa).length, refs(sb).length], changedRefs: refs(sa).filter((r, i) => r !== refs(sb)[i]).length,
      sameApartFromCharPrIDRef: neutral(sa) === neutral(sb) };
  }
  return { charPrCount: [ca.length, cb.length], itemCnt: [itemCnt(ha), itemCnt(hb)], originalCharPrUnchanged: ca.every((x, i) => x === cb[i]),
    headerSameAfterRemovingAppended: reduced === ha, appendedCharPr: appended, changedParts: parts, sections,
    narrowExceptionWouldCover: reduced === ha && appended.every((x) => x.onlyFormatFrom >= 0) };
}

