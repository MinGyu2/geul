// Remove workstation metadata from synthetic HWP5 fixtures without changing
// their document records or CFB stream inventory.
const assert = require('node:assert/strict');

const CFB_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function cfb(bytes) {
  assert(bytes.subarray(0, 8).equals(CFB_SIGNATURE), 'expected a CFB/HWP5 document');
  const sectorSize = 1 << bytes.readUInt16LE(30);
  const miniSectorSize = 1 << bytes.readUInt16LE(32);
  const fatCount = bytes.readUInt32LE(44);
  const directoryStart = bytes.readUInt32LE(48);
  const miniCutoff = bytes.readUInt32LE(56);
  const miniFatStart = bytes.readUInt32LE(60);
  const miniFatCount = bytes.readUInt32LE(64);
  const difatStart = bytes.readUInt32LE(68);
  const difatCount = bytes.readUInt32LE(72);
  const sectorOffset = (id) => (id + 1) * sectorSize;
  const sector = (id) => {
    const start = sectorOffset(id);
    assert(start >= 0 && start + sectorSize <= bytes.length, `CFB sector ${id} is out of bounds`);
    return bytes.subarray(start, start + sectorSize);
  };
  const chain = (start, table) => {
    const result = [];
    const seen = new Set();
    while (start !== ENDOFCHAIN && start !== FREESECT) {
      assert(start < table.length && !seen.has(start), 'invalid or cyclic CFB allocation chain');
      seen.add(start);
      result.push(start);
      start = table[start];
    }
    return result;
  };

  const difat = Array.from({ length: 109 }, (_, index) => bytes.readUInt32LE(76 + index * 4))
    .filter((value) => value !== FREESECT);
  let nextDifat = difatStart;
  for (let index = 0; index < difatCount; index++) {
    const values = sector(nextDifat);
    for (let at = 0; at < sectorSize - 4; at += 4) {
      const value = values.readUInt32LE(at);
      if (value !== FREESECT) difat.push(value);
    }
    nextDifat = values.readUInt32LE(sectorSize - 4);
  }
  assert(difat.length >= fatCount, 'CFB FAT sector list is truncated');
  const fat = [];
  for (const id of difat.slice(0, fatCount)) {
    const values = sector(id);
    for (let at = 0; at < sectorSize; at += 4) fat.push(values.readUInt32LE(at));
  }

  const directorySectors = chain(directoryStart, fat);
  let directory = Buffer.concat(directorySectors.map(sector));
  const entries = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameBytes = directory.readUInt16LE(offset + 64);
    const name = nameBytes >= 2
      ? directory.toString('utf16le', offset, offset + nameBytes - 2)
      : '';
    entries.push({
      name,
      type: directory[offset + 66],
      left: directory.readUInt32LE(offset + 68),
      right: directory.readUInt32LE(offset + 72),
      child: directory.readUInt32LE(offset + 76),
      start: directory.readUInt32LE(offset + 116),
      size: Number(directory.readBigUInt64LE(offset + 120)),
      directoryOffset: offset,
    });
  }
  assert(entries[0]?.type === 5, 'CFB root directory entry is missing');

  const fatBytes = (start, size) => Buffer.concat(chain(start, fat).map(sector)).subarray(0, size);
  const root = entries[0];
  const miniStream = fatBytes(root.start, root.size);
  const miniFat = [];
  for (const id of chain(miniFatStart, fat).slice(0, miniFatCount)) {
    const values = sector(id);
    for (let at = 0; at < sectorSize; at += 4) miniFat.push(values.readUInt32LE(at));
  }
  const miniChain = (start) => chain(start, miniFat);
  const miniBytes = (start, size) => Buffer.concat(miniChain(start).map((id) => {
    const from = id * miniSectorSize;
    return miniStream.subarray(from, from + miniSectorSize);
  })).subarray(0, size);
  const entriesByPath = new Map();
  const visited = new Set();
  const walk = (index, prefix) => {
    if (index === FREESECT || index === ENDOFCHAIN) return;
    assert(index < entries.length && !visited.has(index), 'invalid CFB directory tree');
    visited.add(index);
    const entry = entries[index];
    walk(entry.left, prefix);
    walk(entry.right, prefix);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 2) entriesByPath.set(path, entry);
    if (entry.type === 1) walk(entry.child, path);
  };
  walk(root.child, '');

  const writeMiniStream = (entry, replacement) => {
    assert(entry.size < miniCutoff, `${entry.name} unexpectedly requires a regular CFB stream`);
    assert(replacement.length === entry.size, `${entry.name} replacement must keep its stream size`);
    const ids = miniChain(entry.start);
    for (let index = 0; index < ids.length; index++) {
      const dataOffset = index * miniSectorSize;
      if (dataOffset >= replacement.length) break;
      const miniOffset = ids[index] * miniSectorSize;
      const fatSector = Math.floor(miniOffset / sectorSize);
      const withinSector = miniOffset % sectorSize;
      const physical = sectorOffset(chain(root.start, fat)[fatSector]) + withinSector;
      const count = Math.min(miniSectorSize, replacement.length - dataOffset);
      replacement.copy(bytes, physical, dataOffset, dataOffset + count);
    }
  };
  const readStream = (path) => {
    const entry = entriesByPath.get(path);
    assert(entry, `missing CFB stream ${path}`);
    return entry.size < miniCutoff
      ? miniBytes(entry.start, entry.size)
      : fatBytes(entry.start, entry.size);
  };
  const writeStream = (path, replacement) => {
    const entry = entriesByPath.get(path);
    assert(entry, `missing CFB stream ${path}`);
    if (entry.size < miniCutoff) writeMiniStream(entry, replacement);
    else {
      assert(replacement.length === entry.size, `${path} replacement must keep its stream size`);
      let offset = 0;
      for (const id of chain(entry.start, fat)) {
        if (offset >= replacement.length) break;
        const count = Math.min(sectorSize, replacement.length - offset);
        replacement.copy(bytes, sectorOffset(id), offset, offset + count);
        offset += count;
      }
      assert(offset >= replacement.length, `${path} replacement exceeds its CFB allocation`);
    }
  };
  const scrubDirectoryTimes = () => {
    for (const entry of entries) {
      if (entry.type !== 1 && entry.type !== 2 && entry.type !== 5) continue;
      directory.fill(0, entry.directoryOffset + 100, entry.directoryOffset + 116);
    }
    directorySectors.forEach((id, index) => {
      const offset = sectorOffset(id);
      directory.copy(bytes, offset, index * sectorSize, (index + 1) * sectorSize);
    });
  };

  return { readStream, writeStream, scrubDirectoryTimes };
}

function scrubSummaryInformation(source) {
  const summary = Buffer.from(source);
  assert(summary.length >= 48 && summary.readUInt16LE(0) === 0xfffe, 'invalid HWP SummaryInformation property set');
  const sectionOffset = summary.readUInt32LE(44);
  assert(sectionOffset + 8 <= summary.length, 'SummaryInformation section is out of bounds');
  const sectionSize = summary.readUInt32LE(sectionOffset);
  const propertyCount = summary.readUInt32LE(sectionOffset + 4);
  assert(sectionOffset + sectionSize <= summary.length && propertyCount <= 256, 'invalid SummaryInformation section');
  const properties = [];
  for (let index = 0; index < propertyCount; index++) {
    const at = sectionOffset + 8 + index * 8;
    assert(at + 8 <= sectionOffset + sectionSize, 'truncated SummaryInformation property table');
    properties.push({
      id: summary.readUInt32LE(at),
      offset: summary.readUInt32LE(at + 4),
    });
  }
  const offsets = [...new Set(properties.map((item) => item.offset))].sort((a, b) => a - b);
  for (const { offset } of properties) {
    const value = sectionOffset + offset;
    assert(value + 4 <= sectionOffset + sectionSize, 'SummaryInformation value is out of bounds');
    const type = summary.readUInt32LE(value);
    if (type === 31 || type === 30) { // VT_LPWSTR / VT_LPSTR
      const next = offsets.find((candidate) => candidate > offset) ?? sectionSize;
      const end = sectionOffset + next;
      assert(value + 8 <= end, 'SummaryInformation string header is truncated');
      summary.fill(0, value, end);
      summary.writeUInt32LE(type, value);
      summary.writeUInt32LE(1, value + 4); // empty string plus its terminator
    } else if (type === 64) { // VT_FILETIME
      assert(value + 12 <= sectionOffset + sectionSize, 'SummaryInformation timestamp is truncated');
      summary.fill(0, value + 4, value + 12);
    }
  }
  return summary;
}

function scrubHwp5Fixture(input) {
  const bytes = Buffer.from(input);
  const container = cfb(bytes);
  const summary = scrubSummaryInformation(container.readStream('\x05HwpSummaryInformation'));
  container.writeStream('\x05HwpSummaryInformation', summary);
  container.writeStream('DocOptions/_LinkDoc', Buffer.alloc(container.readStream('DocOptions/_LinkDoc').length));
  container.scrubDirectoryTimes();

  const decoded = new TextDecoder('utf-16le').decode(bytes);
  assert(!/[A-Z]:\\(?:Users|home)\\|AppData\\Local\\Temp|prv[0-9a-f]{8,}\.png/i.test(decoded),
    'fixture still contains workstation path metadata');
  const cleaned = cfb(bytes);
  const cleanSummary = cleaned.readStream('\x05HwpSummaryInformation');
  const sectionOffset = cleanSummary.readUInt32LE(44);
  const sectionSize = cleanSummary.readUInt32LE(sectionOffset);
  const propertyCount = cleanSummary.readUInt32LE(sectionOffset + 4);
  for (let index = 0; index < propertyCount; index++) {
    const at = sectionOffset + 8 + index * 8;
    const offset = sectionOffset + cleanSummary.readUInt32LE(at + 4);
    const type = cleanSummary.readUInt32LE(offset);
    if (type === 31 || type === 30) assert.equal(cleanSummary.readUInt32LE(offset + 4), 1, 'summary strings must be empty');
    if (type === 64) assert(cleanSummary.subarray(offset + 4, offset + 12).every((byte) => byte === 0), 'summary timestamps must be empty');
  }
  assert.equal(sectionOffset + sectionSize, cleanSummary.length, 'unexpected SummaryInformation tail');
  assert(cleaned.readStream('DocOptions/_LinkDoc').every((byte) => byte === 0), 'link-document metadata must be empty');
  return bytes;
}

module.exports = { scrubHwp5Fixture };
