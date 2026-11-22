// @vitest-environment jsdom
// Stage 3 P3: HWPX shape/text box insertion and outer formatting on the Release engine.
// With GEUL_STAGE3_OUT=<dir>, writes original/edited HWPX bytes and loss reports for `save_check`.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { ImeInput } from "../../src/components/Editor/rhwp/imeInput";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { hwpReopenEqual, hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import { documentCommandState } from "../../src/commands/capability";
import type { PlainClipboard } from "../../src/commands/clipboard";
import {
  OBJECT_CLIPBOARD_MIME, createHwpObjectClipboardPayload, createRichObjectClipboardPayload, parseObjectClipboardPayload,
} from "../../src/commands/objectClipboard";
import { objectEditRequest, type ObjectEdit } from "../../src/commands/objectSelection";
import { clearStructuredClipboard } from "../../src/commands/tableClipboard";
import { FIXED_MEMORY_BYTES, controlledBackend, info, loaded, ok, flush } from "../../src/components/Editor/rhwp/testing";

const artifacts = resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS ?? "public/rhwp");
const identity = await readRhwpGeneration(artifacts, "release");
const folder = resolve(artifacts, "generations", identity.generation);
const engine = createRequire(import.meta.url)(resolve(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(resolve(folder, "rhwp_bg.wasm")) });
const out = process.env.GEUL_STAGE3_OUT;
/** The save path's reopen evidence (RhwpEditorSession export check): pages, text and controls equal, no loss. */
function expectReopenEvidence(doc: RhwpDocument, bytes: Uint8Array, report: string) {
  const reopened = new engine.HwpDocument(bytes) as RhwpDocument & { getControls(): string; getTextFileText(): string };
  const live = doc as RhwpDocument & { getControls(): string; getTextFileText(): string };
  try {
    expect(JSON.parse(report)).toMatchObject({ count: 0 });
    expect(reopened.pageCount()).toBe(live.pageCount());
    expect(reopened.getTextFileText()).toBe(live.getTextFileText());
    expect(reopened.getControls()).toBe(live.getControls());
  } finally { reopened.free(); }
}
type Frame = { type: string; x: number; y: number; w: number; h: number; controlIdx: number };
const shapes = (doc: RhwpDocument) => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).filter(c => c.type === "shape");

function source(format: "hwp" | "hwpx"): Uint8Array {
  const doc = engine.HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, "shape anchor paragraph with some text");
    return format === "hwpx" ? doc.exportHwpx() : doc.exportHwp();
  } finally { doc.free(); }
}

async function setup(format: "hwp" | "hwpx", initial?: Uint8Array) {
  const control = controlledBackend();
  const sessions = new DocumentSessions(control.backend);
  const open = sessions.open(`/shape.${format}`);
  const sessionInfo = (patch: Parameters<typeof info>[0]) => info({ ...patch, format });
  control.take("open").reply(ok(sessionInfo({ displayName: `shape.${format}` })));
  await open;
  const bytes = initial ?? source(format);
  const doc = new engine.HwpDocument(bytes) as RhwpDocument;
  let firstOpen = true;
  const editor = new RhwpEditorSession(1, control.backend, sessions,
    async () => ({ openDocument: (input: Uint8Array) => {
      if (!firstOpen) return new engine.HwpDocument(input) as RhwpDocument;
      firstOpen = false;
      return doc;
    }, memoryBytes: () => FIXED_MEMORY_BYTES }), { natural: null });
  const loading = editor.load();
  control.take("load").reply(loaded(bytes));
  await flush();
  control.take("session").reply(ok(sessionInfo({ state: "loading", sequence: 1, loadGeneration: 1 })));
  control.take("setState").reply(ok(sessionInfo({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  let revision = 0;
  const confirm = async () => {
    revision += 1;
    const pending = control.take("commit");
    expect(pending.args).toEqual([1, 1, revision - 1, 1]);
    pending.reply(ok(sessionInfo({ state: "ready", revision, dirty: true, loadGeneration: 1, sequence: 2 + revision })));
    await flush();
  };
  const pick = (frame: Frame) => {
    expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
    return editor.objectSelection!;
  };
  const edit = (edit: ObjectEdit) => editor.execute("object.edit", objectEditRequest(editor.objectSelection!, edit)).accepted;
  return { editor, doc, bytes, pick, edit, confirm, ...control };
}

const groupFrame = (doc: RhwpDocument) =>
  (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;

function assignNestedContainerIds(bytes: Uint8Array) {
  return execFileSync("python3", ["-c", `
import io, re, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == "Contents/section0.xml":
                xml = data.decode("utf-8")
                tags = list(re.finditer(r'<hp:container\\b[^>]*>', xml))
                assert len(tags) == 2, len(tags)
                for match, (ident, instid) in reversed(list(zip(tags, [(9001, 9101), (7001, 8001)]))):
                    tag = re.sub(r'\\bid="[^"]*"', f'id="{ident}"', match.group(), count=1)
                    tag, count = re.subn(r'\\binstid="[^"]*"', f'instid="{instid}"', tag, count=1)
                    assert count == 1
                    xml = xml[:match.start()] + tag + xml[match.end():]
                data = xml.encode("utf-8")
            dst.writestr(entry, data)
    sys.stdout.buffer.write(out.getvalue())
`], { input: bytes });
}

function inspectNestedContainerTree(bytes: Uint8Array) {
  return JSON.parse(execFileSync("python3", ["-c", `
import io, json, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as zf:
    root = ET.fromstring(zf.read("Contents/section0.xml"))
container = root.find(".//{*}container")
def tree(node):
    return {
        "tag": node.tag.split("}")[-1],
        "attrs": dict(sorted(node.attrib.items())),
        "text": (node.text or "").strip(),
        "children": [tree(child) for child in node],
    }
print(json.dumps(tree(container)))
`], { input: bytes, encoding: "utf8" }));
}

const xmlChild = (node: { children: { tag: string; attrs: Record<string, string>; children: unknown[] }[] }, tag: string) =>
  node.children.find(child => child.tag === tag)!;
const px = (hu: number) => hu * 96 / 7200;

it("Stage 3-A P4-HX-NEST addresses, edits, saves, and reopens nested HWPX group descendants", async () => {
  type GroupFactory = RhwpDocument & { groupShapes(json: string): string };
  const created = new engine.HwpDocument(source("hwpx")) as GroupFactory;
  let nestedBytes: Uint8Array;
  try {
    const make = (x: number, y: number, width: number, height: number, color: number) => {
      const result = JSON.parse(created.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "rectangle", width, height,
        treatAsChar: false, textWrap: "Square", horzOffset: x, vertOffset: y,
      })));
      created.setShapeProperties!(0, 0, result.controlIdx, JSON.stringify({ fillType: "solid", fillBgColor: color }));
      return result as { controlIdx: number };
    };
    const red = make(1500, 500, 1200, 800, 0x00ff0000);
    const green = make(3000, 500, 1200, 800, 0x0000ff00);
    const inner = JSON.parse(created.groupShapes(JSON.stringify({ sectionIdx: 0, targets: [
      { paraIdx: 0, controlIdx: red.controlIdx }, { paraIdx: 0, controlIdx: green.controlIdx },
    ] })));
    expect(inner.ok).toBe(true);
    const blue = make(100, 500, 600, 600, 0x000000ff);
    const controls = JSON.parse(created.getPageControlLayout!(0)).controls as Frame[];
    const innerFrame = controls.find(c => c.type === "group")!;
    const blueFrame = controls.find(c => c.type === "shape")!;
    const outer = JSON.parse(created.groupShapes(JSON.stringify({ sectionIdx: 0, targets: [
      { paraIdx: innerFrame.stableIndex[1], controlIdx: innerFrame.stableIndex[2] },
      { paraIdx: blueFrame.stableIndex[1], controlIdx: blueFrame.stableIndex[2] },
    ] })));
    expect(outer.ok).toBe(true);
    nestedBytes = assignNestedContainerIds(created.exportHwpx());
  } finally { created.free(); }

  const originalBytes = Buffer.from(nestedBytes);
  const originalTree = inspectNestedContainerTree(nestedBytes);
  const originalInner = xmlChild(originalTree, "container");
  const originalInnerRects = originalInner.children.filter(child => child.tag === "rect");
  const originalRed = originalInnerRects[0]!;
  const originalGreen = originalInnerRects[1]!;
  const originalBlue = originalTree.children.find(child => child.tag === "rect")!;
  expect(originalTree.attrs).toMatchObject({ id: "9001", instid: "9101", groupLevel: "0" });
  expect(originalInner.attrs).toMatchObject({ id: "7001", instid: "8001", groupLevel: "1" });
  expect(originalInner.children.filter(child => child.tag === "rect")).toHaveLength(2);
  expect(originalInner.children.filter(child => child.tag === "rect").map(child => child.attrs.groupLevel)).toEqual(["2", "2"]);
  expect(originalTree.children.find(child => child.tag === "rect")!.attrs.groupLevel).toBe("1");
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "a-p4-hx-nest-original.hwpx"), nestedBytes);
    const fixtures = resolve(out, "fixtures");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(resolve(fixtures, "a-p4-hx-nest-original.hwpx"), nestedBytes);
  }

  const { editor, doc, pick, edit, confirm } = await setup("hwpx", nestedBytes);
  try {
    const frame = groupFrame(doc);
    const selected = pick(frame);
    expect(selected.groupChildren).toBeDefined();
    const group = selected.groupChildren!;
    expect(group.children).toHaveLength(3);
    const [red, green, blue] = group.children;
    expect(red).toMatchObject({ kind: "rectangle", x: 1400, y: 0, width: 1200, height: 800, canMove: true, canResize: true });
    expect(red.path).toEqual([
      { index: 0, id: 7001, instId: 8001 },
      { index: 0, id: red.id, instId: red.instId },
    ]);
    expect(green).toMatchObject({ kind: "rectangle", x: 2900, y: 0, width: 1200, height: 800, canMove: true, canResize: true });
    expect(green.path).toEqual([
      { index: 0, id: 7001, instId: 8001 },
      { index: 1, id: green.id, instId: green.instId },
    ]);
    expect(blue).toMatchObject({ kind: "rectangle", x: 0, y: 0, width: 600, height: 600, canMove: true, canResize: true });
    expect(blue.path).toBeUndefined();

    const svgRect = (color: string) => {
      const match = new RegExp(`<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="${color}"`).exec(
        (doc as RhwpDocument & { renderPageSvg(page: number): string }).renderPageSvg(0),
      );
      expect(match, `SVG rectangle ${color}`).not.toBeNull();
      return match!.slice(1, 5).map(Number);
    };
    expect(svgRect("#0000ff")).toEqual([
      expect.closeTo(px(1500), 6), expect.closeTo(px(500), 6), expect.closeTo(px(1200), 6), expect.closeTo(px(800), 6),
    ]);

    const stalePath = JSON.parse(JSON.stringify(red.path));
    stalePath[0].instId += 1;
    const beforeStale = Buffer.from(doc.exportHwpx());
    expect(() => doc.moveNestedGroupChild!(0, 0, frame.controlIdx, red.index, red.id, red.instId,
      JSON.stringify(stalePath), 1700, 100)).toThrow();
    expect(Buffer.from(doc.exportHwpx())).toEqual(beforeStale);
    expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });

    expect(edit({ kind: "nestedGroupChildMove", index: red.index, id: red.id, instId: red.instId,
      path: red.path!, x: 1600, y: 0 })).toBe(true);
    await confirm();
    expect(JSON.parse(doc.getEditableGroupChildren!(0, 0, frame.controlIdx)).children[0])
      .toMatchObject({ x: 1600, y: 0, width: 1200, height: 800 });
    expect(svgRect("#0000ff")).toEqual([
      expect.closeTo(px(1700), 6), expect.closeTo(px(500), 6), expect.closeTo(px(1200), 6), expect.closeTo(px(800), 6),
    ]);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(JSON.parse(doc.getEditableGroupChildren!(0, 0, frame.controlIdx)).children[0])
      .toMatchObject({ x: 1400, y: 0, width: 1200, height: 800 });
    expect(editor.redo()).toBe(true);
    await confirm();

    pick(frame);
    const currentRed = editor.objectSelection!.groupChildren!.children[0]!;
    expect(edit({ kind: "nestedGroupChildResize", index: currentRed.index, id: currentRed.id, instId: currentRed.instId,
      path: currentRed.path!, width: 1000, height: 700 })).toBe(true);
    await confirm();
    const finalChildren = JSON.parse(doc.getEditableGroupChildren!(0, 0, frame.controlIdx));
    expect(finalChildren.children[0]).toMatchObject({ x: 1600, y: 0, width: 1000, height: 700 });
    expect(finalChildren.children[1]).toMatchObject({ x: 2900, y: 0, width: 1200, height: 800 });
    expect(finalChildren.children[2]).toMatchObject({ x: 0, y: 0, width: 600, height: 600 });
    expect(svgRect("#0000ff")).toEqual([
      expect.closeTo(px(1700), 6), expect.closeTo(px(500), 6), expect.closeTo(px(1000), 6), expect.closeTo(px(700), 6),
    ]);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(JSON.parse(doc.getEditableGroupChildren!(0, 0, frame.controlIdx)).children[0])
      .toMatchObject({ x: 1600, y: 0, width: 1200, height: 800 });
    expect(editor.redo()).toBe(true);
    await confirm();

    const exported = doc.exportHwpxWithReport();
    try {
      const saved = exported.takeBytes();
      expectReopenEvidence(doc, saved, exported.contentLoss());
      const savedTree = inspectNestedContainerTree(saved);
      const savedInner = xmlChild(savedTree, "container");
      const savedRects = savedInner.children.filter(child => child.tag === "rect");
      expect(savedTree.attrs).toMatchObject({ id: "9001", instid: "9101" });
      expect(savedInner.attrs).toMatchObject({ id: "7001", instid: "8001" });
      const savedRed = savedRects.find(child => child.attrs.id === String(red.id))!;
      const savedGreen = savedRects.find(child => child.attrs.id === String(green.id))!;
      const savedBlue = savedTree.children.find(child => child.tag === "rect")!;
      const leafOffset = xmlChild(savedRed, "offset");
      const leafOrgSize = xmlChild(savedRed, "orgSz");
      const leafCurSize = xmlChild(savedRed, "curSz");
      const leafSize = xmlChild(savedRed, "sz");
      expect(leafOffset.attrs).toMatchObject({ x: "200", y: "0" });
      expect(leafOrgSize.attrs).toMatchObject({ width: "1000", height: "700" });
      expect(leafCurSize.attrs).toMatchObject({ width: "1000", height: "700" });
      expect(leafSize.attrs).toMatchObject({ width: "1000", height: "700" });
      const savedMatrices = xmlChild(savedRed, "renderingInfo").children;
      const savedTranslation = savedMatrices.find(matrix => matrix.tag === "transMatrix")!;
      const savedScale = savedMatrices.find(matrix => matrix.tag === "scaMatrix")!;
      expect(savedTranslation.attrs).toMatchObject({ e1: "1", e2: "0", e3: "200", e4: "0", e5: "1", e6: "0" });
      expect(savedScale.attrs).toMatchObject({ e1: "1", e2: "0", e4: "0", e5: "1", e6: "0" });
      expect(xmlChild(savedRed, "fillBrush")).toEqual(xmlChild(originalRed, "fillBrush"));
      expect(savedGreen).toEqual(originalGreen);
      expect(savedBlue).toEqual(originalBlue);
      const beforeParts = JSON.parse(execFileSync("python3", ["-c", `
import hashlib, io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as zf:
    print(json.dumps({name: hashlib.sha256(zf.read(name)).hexdigest() for name in zf.namelist()}))
`], { input: originalBytes, encoding: "utf8" }));
      const afterParts = JSON.parse(execFileSync("python3", ["-c", `
import hashlib, io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as zf:
    print(json.dumps({name: hashlib.sha256(zf.read(name)).hexdigest() for name in zf.namelist()}))
`], { input: saved, encoding: "utf8" }));
      expect(Object.keys(afterParts).sort()).toEqual(Object.keys(beforeParts).sort());
      for (const [name, hash] of Object.entries(beforeParts)) {
        if (name !== "Contents/section0.xml") expect(afterParts[name]).toBe(hash);
      }
      const reopened = new engine.HwpDocument(saved) as RhwpDocument & { renderPageSvg(page: number): string };
      try {
        expect(JSON.parse(reopened.getEditableGroupChildren!(0, 0, frame.controlIdx)).children).toEqual(finalChildren.children);
        expect(reopened.renderPageSvg(0)).toContain(`fill="#0000ff"`);
        const reopenedRect = /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#0000ff"/.exec(reopened.renderPageSvg(0));
        expect(reopenedRect?.slice(1, 5).map(Number)).toEqual([
          expect.closeTo(px(1700), 6), expect.closeTo(px(500), 6), expect.closeTo(px(1000), 6), expect.closeTo(px(700), 6),
        ]);
      } finally { reopened.free(); }
      expect(Buffer.from(nestedBytes)).toEqual(originalBytes);
    } finally { exported.free(); }
  } finally { editor.dispose(); }
});

function patchGroupFixture(change: string, fixture = readFileSync(resolve("target/stage3a-p4/fixtures/a-p4-group-original.hwpx"))) {
  return execFileSync("python3", ["-c", `
import io, re, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == "Contents/section0.xml":
                xml = data.decode("utf-8")
                exec(sys.argv[1], globals())
                data = xml.encode("utf-8")
            dst.writestr(entry, data)
    sys.stdout.buffer.write(out.getvalue())
`, change], { input: fixture });
}


it("Stage 3-A P4-GROUP-XFM edits exact scaled HWPX group-child geometry", async () => {
  type GroupFactory = RhwpDocument & { groupShapes(json: string): string };
  const created = new engine.HwpDocument(source("hwpx")) as GroupFactory;
  let groupedBytes: Uint8Array;
  try {
    const targets = ["rectangle", "ellipse"].map((shapeType, i) => {
      const { controlIdx } = JSON.parse(created.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2 + i, shapeType, width: 5200, height: 4100,
        treatAsChar: false, textWrap: "Square", horzOffset: i * 6500, vertOffset: i * 800,
      })));
      created.setShapeProperties!(0, 0, controlIdx, JSON.stringify({ fillType: "solid", fillBgColor: i ? 0x601234 : 0x348951 }));
      return { paraIdx: 0, controlIdx };
    });
    const grouped = JSON.parse(created.groupShapes(JSON.stringify({ sectionIdx: 0, targets })));
    expect(grouped.ok).toBe(true);
    created.setShapeProperties!(0, 0, grouped.controlIdx, '{"textWrap":"Square","horzOffset":500,"vertOffset":500}');
    groupedBytes = created.exportHwpx();
  } finally { created.free(); }

  const transformedBytes = patchGroupFixture(`
rect_start = xml.index('<hp:rect ')
rect_end = xml.index('</hp:rect>', rect_start) + len('</hp:rect>')
rect = xml[rect_start:rect_end]
rect, count = re.subn(
    r'<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>',
    '<hc:scaMatrix e1="0.5" e2="0" e3="0" e4="0" e5="0.5" e6="0"/>',
    rect, count=1,
)
assert count == 1
rect, count = re.subn(
    r'<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>',
    '<hc:transMatrix e1="1" e2="0" e3="200" e4="0" e5="1" e6="100"/>',
    rect, count=1,
)
assert count == 1
xml = xml[:rect_start] + rect + xml[rect_end:]
`, groupedBytes);
  const sourceSnapshot = Buffer.from(transformedBytes);
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "a-p4-group-transform-original.hwpx"), transformedBytes);
  }
  const inspect = (bytes: Uint8Array) => JSON.parse(execFileSync("python3", ["-c", `
import io, json, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as zf:
    root = ET.fromstring(zf.read("Contents/section0.xml"))
group = root.find(".//{*}container")
def item(tag):
    el = group.find("{*}" + tag)
    def tree(node):
        return {
            "tag": node.tag.split("}")[-1],
            "attrs": dict(sorted(node.attrib.items())),
            "text": (node.text or "").strip(),
            "children": [tree(child) for child in node],
        }
    return {
        "id": el.attrib.get("id"),
        "instId": el.attrib.get("instid"),
        "offset": dict(el.find("{*}offset").attrib),
        "orgSz": dict(el.find("{*}orgSz").attrib),
        "curSz": dict(el.find("{*}curSz").attrib),
        "size": dict(el.find("{*}sz").attrib),
        "matrices": [(m.tag.split("}")[-1], dict(m.attrib)) for m in el.find("{*}renderingInfo")],
        "tree": tree(el),
    }
print(json.dumps({"groupSize": dict(group.find("{*}orgSz").attrib), "rect": item("rect"), "ellipse": item("ellipse")}))
`], { input: bytes, encoding: "utf8" }));
  const partHashes = (bytes: Uint8Array) => JSON.parse(execFileSync("python3", ["-c", `
import hashlib, io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as zf:
    print(json.dumps({name: hashlib.sha256(zf.read(name)).hexdigest() for name in zf.namelist()}))
`], { input: bytes, encoding: "utf8" }));
  const original = inspect(transformedBytes);
  expect(original.rect.matrices.find(([name]: [string]) => name === "scaMatrix")[1]).toMatchObject({ e1: "0.5", e5: "0.5" });
  expect(original.rect.matrices.find(([name]: [string]) => name === "transMatrix")[1]).toMatchObject({ e3: "200", e6: "100" });

  const { editor, doc, pick, edit, confirm } = await setup("hwpx", transformedBytes);
  try {
    const frame = groupFrame(doc);
    const selected = pick(frame);
    expect(selected.groupChildren).toBeDefined();
    const group = selected.groupChildren!;
    expect(group).toMatchObject({ width: 11700, height: 4900 });
    const rect = group.children[0]!;
    const ellipse = group.children[1]!;
    expect(rect).toMatchObject({ x: 200, y: 100, width: 2600, height: 2050, canMove: true, canResize: true });
    expect(ellipse).toMatchObject({ x: 6500, y: 800, width: 5200, height: 4100, canMove: true, canResize: true });

    const svgRect = () => {
      const match = /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#518934"/.exec(
        (doc as RhwpDocument & { renderPageSvg(page: number): string }).renderPageSvg(0),
      );
      expect(match).not.toBeNull();
      return match!.slice(1, 5).map(Number);
    };
    const px = (hu: number) => hu * 96 / 7200;
    expect(svgRect()).toEqual([expect.closeTo(px(700), 6), expect.closeTo(px(600), 6), expect.closeTo(px(2600), 6), expect.closeTo(px(2050), 6)]);

    expect(edit({ kind: "groupChildMove", index: rect.index, id: rect.id, instId: rect.instId, x: 400, y: 300 })).toBe(true);
    await confirm();
    expect(JSON.parse(doc.getEditableGroupChildren!(0, 0, frame.controlIdx)).children[0]).toMatchObject({ x: 400, y: 300, width: 2600, height: 2050 });
    expect(svgRect()).toEqual([expect.closeTo(px(900), 6), expect.closeTo(px(800), 6), expect.closeTo(px(2600), 6), expect.closeTo(px(2050), 6)]);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(JSON.parse(doc.getEditableGroupChildren!(0, 0, frame.controlIdx)).children[0]).toMatchObject({ x: 200, y: 100, width: 2600, height: 2050 });
    expect(editor.redo()).toBe(true);
    await confirm();

    // Undo/Redo intentionally invalidates the object selection epoch.
    pick(frame);
    expect(edit({ kind: "groupChildResize", index: rect.index, id: rect.id, instId: rect.instId, width: 3000, height: 2500 })).toBe(true);
    await confirm();
    const finalChildren = JSON.parse(doc.getEditableGroupChildren!(0, 0, frame.controlIdx));
    expect(finalChildren.children[0]).toMatchObject({ x: 400, y: 300, width: 3000, height: 2500, canMove: true, canResize: true });
    expect(finalChildren.children[1]).toEqual(ellipse);
    expect(svgRect()).toEqual([expect.closeTo(px(900), 6), expect.closeTo(px(800), 6), expect.closeTo(px(3000), 6), expect.closeTo(px(2500), 6)]);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(JSON.parse(doc.getEditableGroupChildren!(0, 0, frame.controlIdx)).children[0]).toMatchObject({ x: 400, y: 300, width: 2600, height: 2050 });
    expect(editor.redo()).toBe(true);
    await confirm();

    const exported = doc.exportHwpxWithReport();
    try {
      const output = exported.takeBytes();
      expectReopenEvidence(doc, output, exported.contentLoss());
      const after = inspect(output);
      expect(after.groupSize).toEqual(original.groupSize);
      expect(after.rect).toMatchObject({
        id: original.rect.id,
        offset: { x: "400", y: "300" },
        orgSz: { width: "6000", height: "5000" },
        curSz: { width: "6000", height: "5000" },
        size: { width: "6000", height: "5000" },
      });
      expect(after.rect.matrices).toEqual(original.rect.matrices.map(([name, attrs]: [string, Record<string, string>]) => name === "transMatrix"
        ? [name, { ...attrs, e3: "400", e6: "300" }] : name === "scaMatrix" ? [name, { ...attrs, e1: "0.5", e5: "0.5" }] : [name, attrs]));
      expect(after.ellipse).toEqual(original.ellipse);
      const beforeParts = partHashes(transformedBytes);
      const afterParts = partHashes(output);
      expect(Object.keys(afterParts).sort()).toEqual(Object.keys(beforeParts).sort());
      for (const [name, hash] of Object.entries(beforeParts)) {
        if (name !== "Contents/section0.xml") expect(afterParts[name]).toBe(hash);
      }
      const reopened = new engine.HwpDocument(output) as RhwpDocument & { renderPageSvg(page: number): string };
      try {
        expect(JSON.parse(reopened.getEditableGroupChildren!(0, 0, frame.controlIdx)).children).toEqual(finalChildren.children);
        const reopenedRect = /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#518934"/.exec(reopened.renderPageSvg(0));
        expect(reopenedRect?.slice(1, 5).map(Number)).toEqual([expect.closeTo(px(900), 6), expect.closeTo(px(800), 6), expect.closeTo(px(3000), 6), expect.closeTo(px(2500), 6)]);
      } finally { reopened.free(); }
      expect(Buffer.from(transformedBytes)).toEqual(sourceSnapshot);
    } finally { exported.free(); }
  } finally { editor.dispose(); }

  // The generated sibling carries two identity transform pairs. Moving it must
  // retain both pairs while updating only the source translation matrix.
  const identityRun = await setup("hwpx", transformedBytes);
  try {
    const frame = groupFrame(identityRun.doc);
    const selected = identityRun.pick(frame);
    const child = selected.groupChildren!.children[1]!;
    expect(child).toMatchObject({ x: 6500, y: 800, width: 5200, height: 4100, canMove: true, canResize: true });
    const chainBefore = inspect(transformedBytes);
    expect(chainBefore.ellipse.matrices.filter(([name]: [string]) => name === "scaMatrix")).toHaveLength(2);
    expect(identityRun.edit({ kind: "groupChildMove", index: child.index, id: child.id, instId: child.instId, x: 5200, y: 200 })).toBe(true);
    await identityRun.confirm();
    expect(JSON.parse(identityRun.doc.getEditableGroupChildren!(0, 0, frame.controlIdx)).children[1])
      .toMatchObject({ x: 5200, y: 200, width: 5200, height: 4100 });
    expect(identityRun.editor.undo()).toBe(true);
    await identityRun.confirm();
    expect(JSON.parse(identityRun.doc.getEditableGroupChildren!(0, 0, frame.controlIdx)).children[1])
      .toMatchObject({ x: 6500, y: 800, width: 5200, height: 4100 });
    expect(identityRun.editor.redo()).toBe(true);
    await identityRun.confirm();

    const chainExport = identityRun.doc.exportHwpxWithReport();
    try {
      const output = chainExport.takeBytes();
      expectReopenEvidence(identityRun.doc, output, chainExport.contentLoss());
      const chainAfter = inspect(output);
      expect(chainAfter.rect).toEqual(chainBefore.rect);
      expect(chainAfter.ellipse.offset).toEqual({ x: "5200", y: "200" });
      expect(chainAfter.ellipse.matrices).toEqual(chainBefore.ellipse.matrices.map(([name, attrs]: [string, Record<string, string>]) => name === "transMatrix"
        ? [name, { ...attrs, e3: "5200", e6: "200" }] : [name, attrs]));
      const expectedTree = JSON.parse(JSON.stringify(chainBefore.ellipse.tree));
      const updateTree = (node: { tag: string; attrs: Record<string, string>; children: unknown[] }, tag: string, attrs: Record<string, string>) => {
        if (node.tag === tag) {
          Object.assign(node.attrs, attrs);
          return true;
        }
        return node.children.some(child => updateTree(child as typeof node, tag, attrs));
      };
      expect(updateTree(expectedTree, "offset", { x: "5200", y: "200" })).toBe(true);
      expect(updateTree(expectedTree, "pos", { horzOffset: "5200", vertOffset: "200" })).toBe(true);
      expect(updateTree(expectedTree, "transMatrix", { e3: "5200", e6: "200" })).toBe(true);
      expect(chainAfter.ellipse.tree).toEqual(expectedTree);
      const beforeParts = partHashes(transformedBytes);
      const afterParts = partHashes(output);
      for (const [name, hash] of Object.entries(beforeParts)) {
        if (name !== "Contents/section0.xml") expect(afterParts[name]).toBe(hash);
      }
    } finally { chainExport.free(); }
  } finally { identityRun.editor.dispose(); }

  const shearedBytes = patchGroupFixture(`
rect_start = xml.index('<hp:rect ')
rect_end = xml.index('</hp:rect>', rect_start) + len('</hp:rect>')
rect = xml[rect_start:rect_end]
rect, count = re.subn(
    r'<hc:scaMatrix e1="0.5" e2="0" e3="0" e4="0" e5="0.5" e6="0"/>',
    '<hc:scaMatrix e1="0.5" e2="0.125" e3="0" e4="0" e5="0.5" e6="0"/>',
    rect, count=1,
)
assert count == 1
xml = xml[:rect_start] + rect + xml[rect_end:]
`, transformedBytes);
  const unsupported = await setup("hwpx", shearedBytes);
  try {
    const frame = groupFrame(unsupported.doc);
    const selected = unsupported.pick(frame);
    expect(selected.groupChildren).toBeUndefined();
    expect(JSON.parse(unsupported.doc.getEditableGroupChildren!(0, 0, frame.controlIdx))).toBeNull();
    const before = inspect(unsupported.doc.exportHwpx());
    expect(unsupported.edit({
      kind: "groupChildMove", index: 0, id: Number(original.rect.id), instId: Number(original.rect.instId), x: 500, y: 350,
    })).toBe(false);
    expect(JSON.parse(unsupported.doc.getEditableGroupChildren!(0, 0, frame.controlIdx))).toBeNull();
    expect(inspect(unsupported.doc.exportHwpx())).toEqual(before);
  } finally { unsupported.editor.dispose(); }
});

type GroupChildIds = readonly [string | number | null, string | number | null];

function withGroupChildIds(index: 0 | 1, ids: GroupChildIds, sibling?: GroupChildIds | null) {
  const tags = ["rect", "ellipse"] as const;
  const updates = [[tags[index], ids]];
  if (sibling) updates.push([tags[1 - index]!, sibling]);
  return patchGroupFixture(`
import json
from xml.sax.saxutils import quoteattr

def set_ids(match, ids):
    element = match[0]
    for attr, val in zip(("id", "instid"), ids, strict=True):
        spelling = '' if val is None else f' {attr}={quoteattr(str(val))}'
        element, count = re.subn(r' '+attr+r'="[0-9]+"', lambda _: spelling, element)
        assert count == 1
    return element

for tag, ids in json.loads(${JSON.stringify(JSON.stringify(updates))}):
    xml, count = re.subn(r'<hp:'+tag+r' [^>]+>', lambda m: set_ids(m, ids), xml)
    assert count == 1
`);
}

const identityMatrix = [1, 0, 0, 0, 1, 0];

function boundaryGroupXml(bytes: Uint8Array): {
  parent: string;
  children: { owner: (string | null)[]; matrices: number[][]; offset: number[]; other: string[] }[];
} {
  return JSON.parse(execFileSync("python3", ["-c", `
import io, json, sys, zipfile
from xml.etree import ElementTree as ET

with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as zf:
    group = ET.fromstring(zf.read("Contents/section0.xml")).find(".//{*}container")

def tag(el):
    return el.tag.split("}")[-1]

def pair(el, keys):
    return [int(el.attrib[key]) for key in keys]

children = []
for shape in list(group):
    if tag(shape) not in ("rect", "ellipse"):
        continue
    group.remove(shape)
    info = {
        "owner": [tag(shape), shape.get("id"), shape.get("instid")],
        "offset": pair(shape.find("{*}offset"), ["x", "y"]),
        "sizes": [pair(shape.find("{*}"+key), ["width", "height"]) for key in ("orgSz", "curSz", "sz")],
        "rotation": pair(shape.find("{*}rotationInfo"), ["centerX", "centerY"]),
        "matrices": [[float(m.attrib["e"+str(i)]) for i in range(1, 7)] for m in shape.find("{*}renderingInfo")],
    }
    coordinates = ("center", "ax1", "ax2", "start1", "end1", "start2", "end2") if tag(shape) == "ellipse" else ("pt0", "pt1", "pt2", "pt3")
    info.update({key: pair(shape.find("{*}"+key), ["x", "y"]) for key in coordinates})
    geometry = {"offset", "orgSz", "curSz", "sz", "rotationInfo", "renderingInfo", *coordinates}
    info["other"] = [ET.tostring(el, encoding="unicode") for el in shape if tag(el) not in geometry]
    children.append(info)
print(json.dumps({"parent": ET.tostring(group, encoding="unicode"), "children": children}))
`], { input: bytes, encoding: "utf8" }));
}

function expectUnchangedRefusal({ doc, editor }: Awaited<ReturnType<typeof setup>>, attempt: () => void) {
  const before = doc.exportHwpx();
  attempt();
  expect(editor.localRevision).toBe(0);
  expect(editor.hasUnpreservedChanges).toBe(false);
  expect(editor.snapshot()).toMatchObject({ revision: 0, pending: false, history: { undo: false, redo: false } });
  expect(doc.exportHwpx()).toEqual(before);
}

function expectGroupIdentityRefusal(run: Awaited<ReturnType<typeof setup>>, index: number, id: number, instId: number, label: string) {
  const { doc, edit } = run;
  expectUnchangedRefusal(run, () => {
    expect(edit({ kind: "groupChildMove", index, id, instId, x: 100, y: 150 }), label).toBe(false);
    expect(edit({ kind: "groupChildResize", index, id, instId, width: 4000, height: 3000 }), label).toBe(false);
    expect(() => doc.moveGroupChild!(0, 0, 2, index, id, instId, 100, 150), label).toThrow();
    expect(() => doc.resizeGroupChild!(0, 0, 2, index, id, instId, 4000, 3000), label).toThrow();
  });
}

function writeGroupBoundaryEvidence(label: string, source: Uint8Array, saved: Uint8Array, report: string) {
  const dir = process.env.GEUL_P46_BOUNDARY_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${label}-original.hwpx`), source);
  writeFileSync(resolve(dir, `${label}-saved.hwpx`), saved);
  writeFileSync(resolve(dir, `${label}-report.json`), report);
}

const props = (doc: RhwpDocument, control: number) => JSON.parse(doc.getShapeProperties!(0, 0, control));

function hwpShapeInventory(doc: RhwpDocument) {
  const controls: unknown = JSON.parse(doc.getControls!());
  if (!Array.isArray(controls)) throw new Error("HWP controls unavailable");
  const rootShapes = controls.filter((value): value is Record<string, unknown> => !!value && typeof value === "object"
    && !Array.isArray(value) && value.list === 0 && value.para === 0 && value.ctrlId === "gso");
  const indices = rootShapes.map(owner => owner.controlIndex);
  expect(new Set(indices).size).toBe(rootShapes.length);
  return rootShapes.map(owner => {
    expect(Number.isSafeInteger(owner.controlIndex)).toBe(true);
    const value = props(doc, owner.controlIndex as number) as Record<string, unknown>;
    expect(owner.props).toMatchObject({ Width: value.width, Height: value.height, TreatAsChar: value.treatAsChar ? 1 : 0 });
    const family = value.tbVerticalAlign !== undefined ? "textbox"
      : owner.userDesc === "사각형" ? "rectangle"
        : owner.userDesc === "타원" ? "ellipse"
          : owner.userDesc === "직선" ? "line" : "unknown";
    return { family, width: value.width, height: value.height, verticalAlign: value.tbVerticalAlign };
  });
}

function polygonFixture(format: "hwp" | "hwpx" = "hwpx"): { bytes: Uint8Array; index: number } {
  const doc = new engine.HwpDocument(source(format)) as RhwpDocument;
  try {
    const created = JSON.parse(doc.createShapeControl!(JSON.stringify({
      sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "polygon",
      width: 10800, height: 7200, treatAsChar: false, textWrap: "Square", horzOffset: 1200, vertOffset: 600,
      polygonPoints: [{ x: 1600, y: 1300 }, { x: 9700, y: 700 }, { x: 6400, y: 6500 }, { x: 1600, y: 1300 }],
    })));
    return { index: created.controlIdx, bytes: format === "hwp" ? doc.exportHwp() : doc.exportHwpx() };
  } finally { doc.free(); }
}

function curveFixture(firstType = "CURVE"): { bytes: Uint8Array; index: number } {
  const polygon = polygonFixture("hwpx");
  const bytes = execFileSync("python3", ["-c", `
import io, re, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == "Contents/section0.xml":
                def convert(match):
                    shape = match[0].decode("utf-8")
                    points = re.findall(r'<hc:pt x="(-?\\d+)" y="(-?\\d+)"\\s*/>', shape)
                    assert len(points) == 4 and points[0] == points[-1]
                    segments = []
                    for i, (start, end) in enumerate(zip(points, points[1:])):
                        kind = sys.argv[1] if i == 0 else ("LINE", "CURVE")[i - 1]
                        marker = ' marker="preserve &amp; me"' if i == 0 else ""
                        segments.append(f'<hp:seg type="{kind}" x1="{start[0]}" y1="{start[1]}" x2="{end[0]}" y2="{end[1]}"{marker}/>' )
                    shape = re.sub(r'<hp:polygon\\b', '<hp:curve', shape, count=1)
                    shape = shape.replace("</hp:polygon>", "</hp:curve>")
                    shape = re.sub(r'<hc:pt\\b[^>]*/>', "", shape)
                    size = "<hp:sz"
                    assert shape.count(size) == 1
                    return shape.replace(size, "".join(segments) + size, 1).encode("utf-8")
                data, count = re.subn(rb'<hp:polygon\\b.*?</hp:polygon>', convert, data, flags=re.S)
                assert count == 1
            dst.writestr(entry, data)
    sys.stdout.buffer.write(out.getvalue())
`, firstType], { input: polygon.bytes });
  return { bytes, index: polygon.index };
}

function curveSegments(bytes: Uint8Array): Record<string, string>[] {
  return JSON.parse(execFileSync("python3", ["-c", `
import io, json, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as doc:
    root = ET.fromstring(doc.read("Contents/section0.xml"))
curve = root.find(".//{*}curve")
assert curve is not None
print(json.dumps([dict(segment.attrib) for segment in curve.findall("{*}seg")]))
`], { input: bytes, encoding: "utf8" }));
}

function unchangedHwpxParts(original: Uint8Array, output: Uint8Array): boolean {
  return execFileSync("python3", ["-c", `
import base64, io, json, sys, zipfile
left, right = (base64.b64decode(value) for value in json.load(sys.stdin))
with zipfile.ZipFile(io.BytesIO(left)) as a, zipfile.ZipFile(io.BytesIO(right)) as b:
    names_a = {name for name in a.namelist() if name != "Contents/section0.xml" and not name.startswith("Preview/")}
    names_b = {name for name in b.namelist() if name != "Contents/section0.xml" and not name.startswith("Preview/")}
    assert names_a == names_b
    assert all(a.read(name) == b.read(name) for name in names_a)
print("true")
`], { input: JSON.stringify([Buffer.from(original).toString("base64"), Buffer.from(output).toString("base64")]), encoding: "utf8" }).trim() === "true";
}

function withPolygonTransform(bytes: Uint8Array, original: string, replacement: string): Uint8Array {
  return execFileSync("python3", ["-c", `
import io, re, sys, zipfile
original, replacement = (a.encode() for a in sys.argv[1:])
def change(match):
    polygon = match[0]
    assert original in polygon
    return polygon.replace(original, replacement, 1)
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == 'Contents/section0.xml':
                data, count = re.subn(rb'<hp:polygon\\b.*?</hp:polygon>', change, data, flags=re.S)
                assert count == 1
            dst.writestr(entry, data)
    sys.stdout.buffer.write(out.getvalue())
`, original, replacement], { input: bytes });
}

function polygonXml(bytes: Uint8Array): { section: string; points: [number, number][] } {
  return JSON.parse(execFileSync("python3", ["-c", `
from xml.etree import ElementTree as ET
import io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as doc:
    root = ET.fromstring(doc.read("Contents/section0.xml"))
polygon = root.find(".//{*}polygon")
vertices = polygon.findall("{*}pt")
points = [(int(pt.attrib["x"]), int(pt.attrib["y"])) for pt in vertices]
for pt in vertices:
    polygon.remove(pt)
print(json.dumps(dict(section=ET.tostring(root, encoding="unicode"), points=points)))
`], { input: bytes, encoding: "utf8" }));
}

function mixedTextBoxFixture(joinRange?: 2 | 3 | "differentMiddle"): { bytes: Uint8Array; control: number } {
  const fixture = new engine.HwpDocument(source("hwpx")) as RhwpDocument;
  try {
    const created = JSON.parse(fixture.createShapeControl!(JSON.stringify({
      sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "textbox", width: 16000, height: 9600,
      treatAsChar: true, textWrap: "Square",
    })));
    const control = created.controlIdx;
    fixture.setShapeProperties!(0, 0, control, '{"tbVerticalAlign":"Bottom","tbMarginLeft":640,"tbMarginTop":310}');
    const address = [0, 0, control, 0] as const;
    fixture.insertTextInCell(...address, 0, 0, "First paragraph");
    fixture.splitParagraphInCell(...address, 0, 15);
    fixture.insertTextInCell(...address, 1, 0, "Bold plain");
    fixture.applyParaFormatInCell!(...address, 1, '{"alignment":"center"}');
    fixture.applyCharFormatInCell!(...address, 1, 0, 4, '{"bold":true,"textColor":"#992244"}');
    fixture.applyCharFormatInCell!(...address, 1, 5, 10, '{"italic":true}');
    fixture.splitParagraphInCell(...address, 1, 10);
    fixture.insertTextInCell(...address, 2, 0, "Trailing paragraph");
    if (joinRange) fixture.splitParagraphInCell(...address, 1, 5);
    if (joinRange === 3 || joinRange === "differentMiddle") {
      fixture.splitParagraphInCell(...address, 2, 0);
      fixture.insertTextInCell(...address, 2, 0, "middle");
      if (joinRange === "differentMiddle") fixture.applyParaFormatInCell!(...address, 2, '{"alignment":"right"}');
    }
    return { bytes: fixture.exportHwpx(), control };
  } finally { fixture.free(); }
}

describe("Stage 3 shapes on the Release engine", () => {
  it("inserts a rectangle and a text box, formats, moves, resizes, layers and deletes the outer shape", async () => {
    const { editor, doc, bytes, pick, edit, confirm } = await setup("hwpx");
    try {
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(true);
      await confirm();
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();
      const drawn = shapes(doc);
      expect(drawn).toHaveLength(2);
      const rect = drawn.find(s => s.w > 100 && Math.abs(s.h - drawn[0]!.h) < 1 && props(doc, s.controlIdx).tbVerticalAlign === undefined)!;
      const selected = pick(rect);
      expect(selected.kind).toBe("shape");
      expect(selected.operations).toEqual(["deselect", "move", "resize", "delete", "wrap", "fill", "outline", "rotate", "zOrder", "copy", "cut"]);
      const control = rect.controlIdx;
      expect(edit({ kind: "outline", color: null })).toBe(false);
      expect(edit({ kind: "outline", color: "112233", width: 0 })).toBe(false);
      expect(edit({ kind: "fill", color: "FF8800" })).toBe(true);
      await confirm();
      expect(props(doc, control)).toMatchObject({ fillType: "solid", fillBgColor: 0x0088ff });
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "outline", color: "003366" })).toBe(true);
      await confirm();
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "rotate", degrees: 30, flipH: true, flipV: false })).toBe(true);
      await confirm();
      expect(props(doc, control)).toMatchObject({ borderColor: 0x663300, rotationAngle: 30, horzFlip: true });
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "rotate", degrees: 0, flipH: false, flipV: false })).toBe(true);
      await confirm();
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "nudge", dx: 10, dy: 5 })).toBe(true);
      await confirm();
      const moved = props(doc, control);
      expect(moved).toMatchObject({ horzOffset: 1000, vertOffset: 500 });
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "bounds", width: 120, height: 40 })).toBe(true);
      await confirm();
      expect(props(doc, control)).toMatchObject({ width: 12000, height: 4000, horzOffset: 1000 });
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      expect(props(doc, control).zOrder).toBe(2);
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      expect(props(doc, control).zOrder).toBe(0);
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "layer", front: false })).toBe(false);
      const exported = doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expectReopenEvidence(doc, edited, report);
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          const all = shapes(reopened).map(s => props(reopened, s.controlIdx));
          expect(all).toHaveLength(2);
          expect(all.find(p => p.tbVerticalAlign === undefined)).toMatchObject({ fillBgColor: 0x0088ff, borderColor: 0x663300, width: 12000, height: 4000, horzOffset: 1000, vertOffset: 500 });
          expect(all.some(p => p.tbVerticalAlign !== undefined)).toBe(true);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "shape-original.hwpx"), bytes);
          writeFileSync(resolve(out, "shape-edited.hwpx"), edited);
          writeFileSync(resolve(out, "shape-report.json"), report);
        }
      } finally { exported.free(); }
      // Delete the rectangle, then undo restores it with its formatting.
      const target = shapes(doc).find(s => props(doc, s.controlIdx).tbVerticalAlign === undefined)!;
      pick(target);
      expect(edit({ kind: "delete" })).toBe(true);
      await confirm();
      expect(shapes(doc)).toHaveLength(1);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(shapes(doc)).toHaveLength(2);
    } finally { editor.dispose(); }
  });

  it("changes overlapping HWPX shape z-order with hit-testing, reopen equality and undo/redo", async () => {
    const { editor, doc, pick, edit, confirm } = await setup("hwpx");
    try {
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(true);
      await confirm();
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "ellipse" }).accepted).toBe(true);
      await confirm();

      const initial = shapes(doc);
      expect(initial).toHaveLength(2);
      const [first, second0] = initial as [Frame, Frame];
      // Nudge `second` partially so both an overlapping region and an exposed corner exist.
      pick(second0);
      expect(edit({ kind: "nudge", dx: 40, dy: 20 })).toBe(true);
      await confirm();
      const second = shapes(doc).find(s => s.controlIdx === second0.controlIdx)!;
      const overlapX = first.x + first.w - 5;
      const overlapY = first.y + first.h - 5;
      const exposedX = second.x + second.w - 5;
      const exposedY = second.y + second.h - 5;

      // Initially `second` has higher zOrder and wins overlapping hit-testing.
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);

      // Send `second` to back -> `first` becomes topmost on overlap.
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      expect(props(doc, second.controlIdx).zOrder).toBeLessThan(props(doc, first.controlIdx).zOrder);
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, first.controlIdx]);

      // Select `second` via its exposed corner and bring it back to front -> `second` wins overlap again.
      expect(editor.pointAt(0, exposedX, exposedY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      expect(props(doc, second.controlIdx).zOrder).toBeGreaterThan(props(doc, first.controlIdx).zOrder);
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);

      // Send `second` to back, export HWPX and independently reopen.
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      const exported = doc.exportHwpxWithReport();
      try {
        const bytes = exported.takeBytes();
        const report = exported.contentLoss();
        expectReopenEvidence(doc, bytes, report);
        const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
        try {
          expect(reopened.getPageControlLayout!(0)).toBe(doc.getPageControlLayout!(0));
          expect(reopened.getPageLayerTree!(0)).toBe(doc.getPageLayerTree!(0));
          expect(props(reopened, second.controlIdx).zOrder).toBe(props(doc, second.controlIdx).zOrder);
          expect(props(reopened, first.controlIdx).zOrder).toBe(props(doc, first.controlIdx).zOrder);
          const reopenedShapes = shapes(reopened);
          expect(reopenedShapes.map(s => s.controlIdx)).toEqual([second.controlIdx, first.controlIdx]);
        } finally { reopened.free(); }
      } finally { exported.free(); }

      // Undo/Redo preserve stacking order transitions.
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(props(doc, second.controlIdx).zOrder).toBeGreaterThan(props(doc, first.controlIdx).zOrder);
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(props(doc, second.controlIdx).zOrder).toBeLessThan(props(doc, first.controlIdx).zOrder);
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, first.controlIdx]);
    } finally { editor.dispose(); }
  });

  it("edits an existing HWP polygon outline and geometry cleanly while keeping T009 outline fixtures", async () => {
    const fixture = new engine.HwpDocument(source("hwp")) as RhwpDocument;
    let bytes: Uint8Array, control: number;
    try {
      const created = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "polygon",
        width: 10800, height: 7200, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      control = created.controlIdx;
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, control, '{"textWrap":"Square","rotationAngle":30}')))
        .toMatchObject({ ok: true });
      bytes = fixture.exportHwp();
    } finally { fixture.free(); }
    const { editor, doc, pick, edit, confirm, take } = await setup("hwp", bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const ops = pick(shapes(doc)[0]!).operations;
      expect(ops).toContain("outline");
      expect(ops).toContain("resize");
      expect(ops).toContain("rotate");
      expect(ops).toContain("fill");
      expect(ops).toContain("wrap");
      expect(ops).toContain("delete");
      const before = props(doc, control);
      expect(before.rotationAngle).toBe(30);
      expect(edit({ kind: "outline", color: "334455", width: 2.45 })).toBe(true);
      await confirm();
      const expected = { ...before, borderColor: 0x554433, borderWidth: 245 };
      expect(props(doc, control)).toEqual(expected);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(props(doc, control)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(props(reopened, control)).toEqual(expected);
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p3-polygon-original.hwp"), bytes);
          writeFileSync(resolve(out, "p3-polygon-edited.hwp"), output);
          writeFileSync(resolve(out, "p3-polygon-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("Stage 3-A edits owned HWP5 polygon points and splits or joins straight edges", async () => {
    const { bytes, index } = polygonFixture("hwp");
    const { editor, doc, pick, edit, confirm, take } = await setup("hwp", bytes);
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const selection = pick(shapes(doc)[0]!);
      expect(selection.address.path).toEqual([0, 0, index]);
      expect(selection.operations).toEqual(expect.arrayContaining(["pathPoint", "pathVertex"]));
      const initial = selection.shapePath!;
      expect(initial).toMatchObject({ kind: "polygon", closed: true, width: 10800, height: 7200 });
      const read = () => JSON.parse(doc.getEditableShapePath!(0, 0, index));
      const properties = doc.getShapeProperties!(0, 0, index);
      const untouched = doc.exportHwp();
      const move = { kind: "pathPoint", index: 0, x: 1602, y: 1300 } as const;
      const request = objectEditRequest(selection, move);
      expect(editor.execute("object.edit", { ...request, sessionId: selection.sessionId + 1 }).accepted).toBe(false);
      expect(() => doc.moveShapePathPoint!(0, 1, index, 0, 1602, 1300)).toThrow();
      expect(edit({ kind: "pathPoint", index: 0, x: 9700, y: 700 })).toBe(false);
      expect(edit({ kind: "pathPoint", index: 0, x: 10801, y: 1300 })).toBe(false);
      expect(edit({ kind: "pathVertex", action: "insert", index: 2, x: 4000, y: 3901 })).toBe(false);
      expect(doc.exportHwp()).toEqual(untouched);
      expect(editor.localRevision).toBe(0);
      expect(editor.undo()).toBe(false);

      function verifyOutput(name: string) {
        const report = doc.exportHwpWithReport();
        try {
          const output = report.takeBytes();
          expectReopenEvidence(doc, output, report.contentLoss());
          const reopened = new engine.HwpDocument(output) as RhwpDocument;
          try {
            expect(JSON.parse(reopened.getEditableShapePath!(0, 0, index))).toEqual(read());
            expect(reopened.getShapeProperties!(0, 0, index)).toBe(properties);
            expect(reopened.canEditPolygonVertices!(0, 0, index)).toBe(true);
            expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), null)).toBe(true);
          } finally { reopened.free(); }
          if (out) {
            mkdirSync(out, { recursive: true });
            writeFileSync(resolve(out, "a-p4-hwp5-polygon-original.hwp"), bytes);
            writeFileSync(resolve(out, `a-p4-hwp5-polygon-${name}.hwp`), output);
          }
        } finally { report.free(); }
      }

      expect(editor.execute("object.edit", request).accepted).toBe(true);
      await confirm();
      expect(editor.execute("object.edit", request).accepted).toBe(false);
      const moved = { ...initial, points: initial.points.map((p, i, a) =>
        i === 0 || i === a.length - 1 ? { ...p, x: 1602 } : p) };
      expect(read()).toEqual(moved);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(initial);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toEqual(moved);
      verifyOutput("moved");
      expect(editor.undo()).toBe(true);
      await confirm();
      pick(shapes(doc)[0]!);

      expect(edit({ kind: "pathVertex", action: "insert", index: 2, x: 4000, y: 3900 })).toBe(true);
      await confirm();
      const inserted = { ...initial, points: [...initial.points.slice(0, -1),
        { x: 4000, y: 3900, control: false }, initial.points[0]] };
      expect(read()).toEqual(inserted);
      expect(edit({ kind: "pathVertex", action: "remove", index: 0 })).toBe(false);
      expect(read()).toEqual(inserted);
      verifyOutput("split");
      expect(edit({ kind: "pathVertex", action: "remove", index: 3 })).toBe(true);
      await confirm();
      expect(read()).toEqual(initial);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(inserted);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toEqual(initial);
      verifyOutput("joined");
    } finally { editor.dispose(); }
  });

  it("Stage 3-A edits a closed HWPX polygon point as one history step", async () => {
    const { bytes, index } = polygonFixture();
    const { editor, doc, pick, edit, confirm } = await setup("hwpx", bytes);
    try {
      const sel = pick(shapes(doc)[0]!);
      const firstRenderedPoint = () => {
        const rendered = (doc as RhwpDocument & { renderPageSvg(page: number): string }).renderPageSvg(0);
        const coordinates = /<path d="M([0-9.]+) ([0-9.]+) L/.exec(rendered)!;
        return [Number(coordinates[1]), Number(coordinates[2])];
      };
      const original = sel.shapePath!;
      expect(original).toMatchObject({ kind: "polygon", closed: true, width: 10800, height: 7200 });
      const read = () => JSON.parse(doc.getEditableShapePath!(0, 0, index));
      expect(original.points).toEqual([
        { x: 1600, y: 1300, control: false }, { x: 9700, y: 700, control: false },
        { x: 6400, y: 6500, control: false }, { x: 1600, y: 1300, control: false },
      ]);
      expect(sel.frame).toMatchObject({ x: 16, y: 8, width: 144, height: 96 });
      const projected = (x: number, y: number) => {
        const [screenX, screenY] = firstRenderedPoint();
        expect(screenX).toBeCloseTo(sel.frame.x + x * sel.frame.width / original.width, 8);
        expect(screenY).toBeCloseTo(sel.frame.y + y * sel.frame.height / original.height, 8);
      };
      projected(1600, 1300);
      const beforeProperties = doc.getShapeProperties!(0, 0, index);
      const untouched = doc.exportHwpx();
      for (const invalid of [
        { index: 3, x: 1800, y: 1400 }, { index: 0, x: 9700, y: 700 },
        { index: 0, x: 5.1, y: 1400 }, { index: 0, x: 10801, y: 1400 },
      ]) expect(edit({ kind: "pathPoint", ...invalid })).toBe(false);
      expect(read()).toEqual(original);
      expect(doc.exportHwpx()).toEqual(untouched);
      expect(editor.snapshot().history?.undo).toBe(false);
      expect(editor.objectSelection?.epoch).toBe(sel.epoch);
      const request = objectEditRequest(sel, { kind: "pathPoint", index: 0, x: 2701, y: 1502 });
      expect(editor.execute("object.edit", request).accepted).toBe(true);
      await confirm();
      expect(editor.execute("object.edit", request).accepted).toBe(false);
      const after = { ...original, points: original.points.map((point, i) =>
        i === 0 || i === 3 ? { ...point, x: 2701, y: 1502 } : point) };
      expect(read()).toEqual(after);
      projected(2701, 1502);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(original);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toEqual(after);
      expect(doc.getShapeProperties!(0, 0, index)).toBe(beforeProperties);
      const exported = doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes();
        expectReopenEvidence(doc, output, exported.contentLoss());
        expect(polygonXml(output)).toEqual({
          section: polygonXml(bytes).section,
          points: after.points.map(({ x, y }) => [x, y]),
        });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(JSON.parse(reopened.getEditableShapePath!(0, 0, index))).toEqual(after); }
        finally { reopened.free(); }
        if (out) {
          writeFileSync(resolve(out, "a-p4-polygon-original.hwpx"), bytes);
          writeFileSync(resolve(out, "a-p4-polygon-edited.hwpx"), output);
          writeFileSync(resolve(out, "a-p4-polygon-report.json"), exported.contentLoss());
        }
      } finally { exported.free(); }
      const lock = doc as RhwpDocument & { setControlLock(para: number, control: number, locked: boolean): string };
      expect(JSON.parse(lock.setControlLock(0, index, true))).toMatchObject({ ok: true });
      expect(pick(shapes(doc)[0]!).operations).not.toContain("pathPoint");
      expect(() => doc.moveShapePathPoint!(0, 0, index, 0, 2801, 1602)).toThrow();
    } finally { editor.dispose(); }
  });

  it("preserves HWPX curve segment identity and edits connected endpoints losslessly", async () => {
    const { bytes, index } = curveFixture();
    const { editor, doc, pick, edit, confirm } = await setup("hwpx", bytes);
    try {
      const frame = shapes(doc).find(shape => shape.controlIdx === index)!;
      const selected = pick(frame);
      expect(selected.operations).toContain("pathPoint");
      const initial = selected.shapePath!;
      expect(initial).toMatchObject({ kind: "curve", closed: true, width: 10800, height: 7200 });
      expect(initial.points).toEqual([
        { x: 1600, y: 1300, control: false }, { x: 9700, y: 700, control: false },
        { x: 6400, y: 6500, control: false }, { x: 1600, y: 1300, control: false },
      ]);
      const originalSegments = curveSegments(bytes);
      expect(originalSegments.map(segment => segment.type)).toEqual(["CURVE", "LINE", "CURVE"]);
      expect(originalSegments[0]).toMatchObject({ marker: "preserve & me" });
      const read = () => JSON.parse(doc.getEditableShapePath!(0, 0, index));
      expect(read().segments.map((attributes: [string, string][]) => Object.fromEntries(attributes)))
        .toEqual(originalSegments);
      const beforeProperties = doc.getShapeProperties!(0, 0, index);
      const untouched = doc.exportHwpx();
      if (out) writeFileSync(resolve(out, "a-p4-hwpx-curve-unedited.hwpx"), untouched);
      expect(edit({ kind: "pathPoint", index: 3, x: 1800, y: 1400 })).toBe(false);
      expect(edit({ kind: "pathPoint", index: 1, x: 10801, y: 1400 })).toBe(false);
      expect(doc.exportHwpx()).toEqual(untouched);
      expect(editor.localRevision).toBe(0);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });

      const moved = { kind: "pathPoint", index: 1, x: 5100, y: 1800 } as const;
      expect(editor.execute("object.edit", objectEditRequest(selected, moved)).accepted).toBe(true);
      await confirm();
      const expectedPoints = initial.points.map((point, pointIndex) => pointIndex === 1
        ? { ...point, x: 5100, y: 1800 } : point);
      const expectedSegments = originalSegments.map(segment => ({ ...segment }));
      expectedSegments[0]!.x2 = "5100";
      expectedSegments[0]!.y2 = "1800";
      expectedSegments[1]!.x1 = "5100";
      expectedSegments[1]!.y1 = "1800";
      expect(read()).toMatchObject({ points: expectedPoints, closed: true });
      const editedBytes = doc.exportHwpx();
      expect(curveSegments(editedBytes)).toEqual(expectedSegments);
      expect(unchangedHwpxParts(bytes, editedBytes)).toBe(true);
      expect(doc.getShapeProperties!(0, 0, index)).toBe(beforeProperties);

      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read().segments.map((attributes: [string, string][]) => Object.fromEntries(attributes)))
        .toEqual(originalSegments);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read().segments.map((attributes: [string, string][]) => Object.fromEntries(attributes)))
        .toEqual(expectedSegments);

      const saved = doc.exportHwpxWithReport();
      try {
        const output = saved.takeBytes();
        expectReopenEvidence(doc, output, saved.contentLoss());
        expect(curveSegments(output)).toEqual(expectedSegments);
        expect(unchangedHwpxParts(bytes, output)).toBe(true);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(reopened.getEditableShapePath!(0, 0, index)).toBe(doc.getEditableShapePath!(0, 0, index)); }
        finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "a-p4-hwpx-curve-original.hwpx"), bytes);
          writeFileSync(resolve(out, "a-p4-hwpx-curve-edited.hwpx"), output);
          writeFileSync(resolve(out, "a-p4-hwpx-curve-report.json"), saved.contentLoss());
        }
      } finally { saved.free(); }
    } finally { editor.dispose(); }

    const unsupported = curveFixture("SPLINE");
    const sourceDoc = new engine.HwpDocument(unsupported.bytes) as RhwpDocument;
    try {
      expect(sourceDoc.getEditableShapePath!(0, 0, unsupported.index)).toBe("null");
      expect(curveSegments(sourceDoc.exportHwpx())[0]?.type).toBe("SPLINE");
    } finally { sourceDoc.free(); }
  });

  it("Stage 3-A inserts on the closing HWPX edge and removes the first vertex", async () => {
    const { bytes, index } = polygonFixture();
    const { editor, doc, pick, edit, confirm } = await setup("hwpx", bytes);
    try {
      const selected = pick(shapes(doc)[0]!);
      expect(selected.operations).toContain("pathVertex");
      const initial = selected.shapePath!;
      const path = () => JSON.parse(doc.getEditableShapePath!(0, 0, index));
      const before = doc.exportHwpx();
      for (const invalid of [
        { kind: "pathVertex", action: "remove", index: 0 },
        { kind: "pathVertex", action: "insert", index: 0, x: 1600, y: 1300 },
        { kind: "pathVertex", action: "insert", index: 0, x: 2000, y: 1200 },
        { kind: "pathVertex", action: "insert", index: 3, x: 5650, y: 1000 },
      ] as const) expect(edit(invalid)).toBe(false);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwpx()).toEqual(before);
      const insert = objectEditRequest(selected, { kind: "pathVertex", action: "insert", index: 2, x: 4000, y: 3900 });
      expect(editor.execute("object.edit", insert).accepted).toBe(true);
      await confirm();
      expect(editor.execute("object.edit", insert).accepted).toBe(false);
      const inserted = { ...initial, points: [
        ...initial.points.slice(0, -1), { x: 4000, y: 3900, control: false }, initial.points[0],
      ] };
      expect(path()).toEqual(inserted);
      const insertedBytes = doc.exportHwpx();
      expect(polygonXml(insertedBytes)).toEqual({
        section: polygonXml(bytes).section,
        points: [[1600, 1300], [9700, 700], [6400, 6500], [4000, 3900], [1600, 1300]],
      });
      const independentlyInserted = new engine.HwpDocument(insertedBytes) as RhwpDocument;
      try { expect(JSON.parse(independentlyInserted.getEditableShapePath!(0, 0, index))).toEqual(inserted); }
      finally { independentlyInserted.free(); }

      expect(edit({ kind: "pathVertex", action: "remove", index: 0 })).toBe(true);
      await confirm();
      const final = { ...initial, points: [...inserted.points.slice(1, -1), initial.points[1]] };
      expect(path()).toEqual(final);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(path()).toEqual(inserted);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(path()).toEqual(initial);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(path()).toEqual(inserted);
      expect(editor.redo()).toBe(true);
      await confirm();
      const exported = doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes();
        expectReopenEvidence(doc, output, exported.contentLoss());
        expect(polygonXml(output)).toEqual({
          section: polygonXml(bytes).section,
          points: [[9700, 700], [6400, 6500], [4000, 3900], [9700, 700]],
        });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getEditableShapePath!(0, 0, index))).toEqual(final);
          expect(reopened.canEditPolygonVertices!(0, 0, index)).toBe(true);
        } finally { reopened.free(); }
        if (out) {
          writeFileSync(resolve(out, "a-p4-vertices-original.hwpx"), bytes);
          writeFileSync(resolve(out, "a-p4-vertices-inserted.hwpx"), insertedBytes);
          writeFileSync(resolve(out, "a-p4-vertices-edited.hwpx"), output);
          writeFileSync(resolve(out, "a-p4-vertices-report.json"), exported.contentLoss());
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("Stage 3-A refuses a vertex deletion that creates an intersecting HWPX polygon", async () => {
    const { bytes, index } = polygonFixture();
    const points = (pairs: number[][]) => pairs.map(([x, y]) => `<hc:pt x="${x}" y="${y}"/>`).join("");
    const initial = [[1600, 1300], [9700, 700], [6400, 6500], [1600, 1300]];
    const concave = [[1000, 1000], [9000, 1000], [9000, 6000], [5000, 3000], [1000, 6000], [1000, 1000]];
    const { editor, doc, pick, edit } = await setup("hwpx", withPolygonTransform(bytes, points(initial), points(concave)));
    try {
      const picked = pick(shapes(doc)[0]!);
      expect(picked.operations).toContain("pathVertex");
      const previous = doc.exportHwpx();
      expect(edit({ kind: "pathVertex", action: "remove", index: 1 })).toBe(false);
      expect(() => doc.editPolygonVertex!(0, 0, index, 1, false, 0, 0)).toThrow();
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwpx()).toEqual(previous);
      expect(polygonXml(doc.exportHwpx()).points).toEqual(concave);
    } finally { editor.dispose(); }
  });

  it("Stage 3-A refuses structural edits of a polygon with an ambiguous source vertex", async () => {
    const { bytes, index } = polygonFixture();
    const converted = withPolygonTransform(bytes, '<hc:pt x="9700" y="700"/>', '<hc:pt y="700"/>');
    const { editor, doc, pick, edit } = await setup("hwpx", converted);
    try {
      expect(pick(shapes(doc)[0]!).operations).not.toContain("pathVertex");
      const unchanged = doc.exportHwpx();
      expect(edit({ kind: "pathVertex", action: "insert", index: 2, x: 4000, y: 3900 })).toBe(false);
      expect(() => doc.editPolygonVertex!(0, 0, index, 2, true, 4000, 3900)).toThrow();
      expect(editor.localRevision).toBe(0);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwpx()).toEqual(unchanged);
    } finally { editor.dispose(); }
  });

  it.each([
    ["raw translation", 'transMatrix e1="1" e2="0" e3="0"', 'transMatrix e1="1" e2="0" e3="4500"'],
    ["raw nonuniform scale", 'scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1"', 'scaMatrix e1="2" e2="0" e3="0" e4="0" e5="0.5"'],
    ["raw reflection", 'scaMatrix e1="1"', 'scaMatrix e1="-1"'],
    ["raw skew", 'rotMatrix e1="1" e2="0"', 'rotMatrix e1="1" e2="0.25"'],
    ["malformed component offset", 'offset x="0" y="0"', 'offset x="invalid" y="0"'],
    ["out of range component offset", 'offset x="0" y="0"', 'offset x="2000001" y="0"'],
    ["singular matrix", 'scaMatrix e1="1"', 'scaMatrix e1="0"'],
    ["nonfinite matrix", 'transMatrix e1="1"', 'transMatrix e1="NaN"'],
    ["malformed translation", 'transMatrix e1="1" e2="0" e3="0"', 'transMatrix e1="1" e2="0" e3="invalid"'],
    ["missing matrix value", 'transMatrix e1="1" e2="0"', 'transMatrix e1="1"'],
    ["duplicate matrix value", 'transMatrix e1="1" e2="0"', 'transMatrix e1="1" e2="0" e2="0"'],
    ["duplicate matrix element", '</hp:renderingInfo>', '<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>'],
  ])("Stage 3-A refuses HWPX polygon point edits with %s", async (_label, original, replacement) => {
    const { bytes, index } = polygonFixture();
    const { editor, doc, pick, edit } = await setup("hwpx", withPolygonTransform(bytes, original, replacement));
    try {
      const frame = shapes(doc).find(shape => shape.controlIdx === index)!;
      expect(frame).toMatchObject({ x: 16, y: 8, w: 144, h: 96 });
      const selection = pick(frame);
      expect(selection.operations).not.toContain("pathPoint");
      expect(selection.shapePath).toBeUndefined();
      const before = doc.exportHwpx();
      const owners = doc.getControls!();
      const history = editor.snapshot().history;
      expect(history).toMatchObject({ undo: false, redo: false });
      expect(edit({ kind: "pathPoint", index: 0, x: 2701, y: 1502 })).toBe(false);
      expect(() => doc.moveShapePathPoint!(0, 0, index, 0, 2701, 1502)).toThrow();
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toEqual(history);
      expect(editor.objectSelection).toEqual(selection);
      expect(doc.getControls!()).toBe(owners);
      expect(doc.exportHwpx()).toEqual(before);
    } finally { editor.dispose(); }
  });

  it("Stage 3-A maps transformed HWPX path handles to source points and preserves shape metadata", async () => {
    const fixture = polygonFixture();
    const bytes = withPolygonTransform(
      withPolygonTransform(
        withPolygonTransform(fixture.bytes, 'offset x="0" y="0"', 'offset x="2200" y="300"'),
        'flip horizontal="0" vertical="0"', 'flip horizontal="1" vertical="0"'),
      'rotationInfo angle="0"', 'rotationInfo angle="30"');
    const { editor, doc, pick, edit, confirm } = await setup("hwpx", bytes);
    try {
      const frame = shapes(doc).find(shape => shape.controlIdx === fixture.index)!;
      const selected = pick(frame);
      expect(selected.operations).toContain("pathPoint");
      expect(selected.shape).toMatchObject({ rotation: 30, flipH: true, flipV: false });
      const path = () => JSON.parse(doc.getEditableShapePath!(0, 0, fixture.index));
      const original = path();
      const expected = { ...original, points: original.points.map((point: { x: number; y: number }, index: number) =>
        index === 1 ? { ...point, x: 5100, y: 1800 } : point) };
      expect(edit({ kind: "pathPoint", index: 1, x: 5100, y: 1800 })).toBe(true);
      await confirm();
      expect(path()).toEqual(expected);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(path()).toEqual(original);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(path()).toEqual(expected);
      const exported = doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes();
        expectReopenEvidence(doc, output, exported.contentLoss());
        expect(polygonXml(output)).toEqual({ section: polygonXml(bytes).section,
          points: expected.points.map((point: { x: number; y: number }) => [point.x, point.y]) });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getEditableShapePath!(0, 0, fixture.index))).toEqual(expected);
          expect(JSON.parse(reopened.getShapeProperties!(0, 0, fixture.index)))
            .toMatchObject({ rotationAngle: 30, horzFlip: true });
        } finally { reopened.free(); }
        expect(unchangedHwpxParts(bytes, output)).toBe(true);
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "a-p4-path-transform-original.hwpx"), bytes);
          writeFileSync(resolve(out, "a-p4-path-transform-edited.hwpx"), output);
          writeFileSync(resolve(out, "a-p4-path-transform-report.json"), exported.contentLoss());
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.skipIf(!process.env.GEUL_STAGE3_CUBIC)("Stage 3-A edits rotated and flipped HWP5 cubic handles with nonzero placement offsets", async () => {
    const sourceBytes = new Uint8Array(readFileSync(process.env.GEUL_STAGE3_CUBIC!));
    const sourceDoc = new engine.HwpDocument(sourceBytes) as RhwpDocument;
    let bytes: Uint8Array;
    try {
      const candidate = shapes(sourceDoc).find(frame => JSON.parse(sourceDoc.getEditableShapePath!(0, 0, frame.controlIdx)) !== null)!;
      const originalProperties = JSON.parse(sourceDoc.getShapeProperties!(0, 0, candidate.controlIdx));
      expect(JSON.parse(sourceDoc.setShapeProperties!(0, 0, candidate.controlIdx, JSON.stringify({
        rotationAngle: 30, horzFlip: true, vertFlip: false,
        horzOffset: originalProperties.horzOffset + 1200, vertOffset: originalProperties.vertOffset + 800,
      })))).toMatchObject({ ok: true });
      bytes = sourceDoc.exportHwp();
    } finally { sourceDoc.free(); }
    const { editor, doc, pick, edit, confirm, take } = await setup("hwp", bytes);
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const frame = shapes(doc).find(frame => JSON.parse(doc.getEditableShapePath!(0, 0, frame.controlIdx)) !== null)!;
      const selection = pick(frame), index = frame.controlIdx;
      const path = selection.shapePath!;
      expect(selection.operations).not.toContain("pathVertex");
      const read = () => JSON.parse(doc.getEditableShapePath!(0, 0, index));
      expect(path.kind).toBe("curve");
      expect(path.points.map(point => point.control)).toEqual([false, true, true, false, false, true, true, false]);
      const beforeProperties = doc.getShapeProperties!(0, 0, index);
      expect(edit({ kind: "pathPoint", index: 1, x: 3001, y: 1402 })).toBe(true);
      await confirm();
      const first = read();
      expect(first.points[1]).toEqual({ x: 3001, y: 1402, control: true });
      expect(edit({ kind: "pathPoint", index: 3, x: 7602, y: 4901 })).toBe(true);
      await confirm();
      const after = { ...first, points: first.points.map((p: unknown, i: number) =>
        i === 3 ? { x: 7602, y: 4901, control: false } : p) };
      expect(read()).toEqual(after);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(first);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(path);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toEqual(after);
      expect(doc.getShapeProperties!(0, 0, index)).toBe(beforeProperties);
      const exported = doc.exportHwpWithReport();
      try {
        const output = exported.takeBytes();
        expectReopenEvidence(doc, output, exported.contentLoss());
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(JSON.parse(reopened.getEditableShapePath!(0, 0, index))).toEqual(after); }
        finally { reopened.free(); }
        const proofDir = mkdtempSync(join(tmpdir(), "geul-p4-path-transform-h5-"));
        try {
          const originalPath = join(proofDir, "original.hwp"), editedPath = join(proofDir, "edited.hwp");
          writeFileSync(originalPath, bytes);
          writeFileSync(editedPath, output);
          type RecordDiff = {
            streams: Record<string, {
              original: string | null;
              output: string | null;
              changes?: Array<{
                op: string;
                original: Array<{ index: number; tag: number; level: number; len: number }>;
                output: Array<{ index: number; tag: number; level: number; len: number }>;
              }>;
            }>;
          };
          const recordDiff = JSON.parse(execFileSync("python3", ["scripts/tests/hwp_record_diff.py", originalPath, editedPath], { encoding: "utf8" })) as RecordDiff;
          const changedStreams = Object.entries(recordDiff.streams)
            .filter(([, stream]) => stream.original !== stream.output).map(([name]) => name);
          expect(changedStreams).toEqual(["BodyText/Section0"]);
          const changes = recordDiff.streams["BodyText/Section0"]!.changes ?? [];
          expect(changes).toHaveLength(1);
          const change = changes[0]!;
          expect(change.op).toBe("replace");
          expect(change.original).toHaveLength(1);
          expect(change.output).toHaveLength(1);
          expect(change.original[0]).toMatchObject({ tag: 83, level: 3, len: 79, index: change.output[0]!.index });
          expect(change.output[0]).toMatchObject({ tag: 83, level: 3, len: 79 });
        } finally { rmSync(proofDir, { recursive: true, force: true }); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "a-p4-path-transform-h5-original.hwp"), bytes);
          writeFileSync(resolve(out, "a-p4-path-transform-h5-edited.hwp"), output);
          writeFileSync(resolve(out, "a-p4-curve-edited.hwp"), output);
          writeFileSync(resolve(out, "a-p4-curve-report.json"), exported.contentLoss());
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.skipIf(!process.env.GEUL_STAGE3_TRANSLATED_CUBIC)("Stage 3-A refuses a real HWP5 cubic with matrix translation", async () => {
    const bytes = new Uint8Array(readFileSync(process.env.GEUL_STAGE3_TRANSLATED_CUBIC!));
    const { editor, doc, pick, edit, take } = await setup("hwp", bytes);
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const frame = shapes(doc).find(shape => Math.abs(shape.x - 266.7) < 0.1 && shape.y === 160)!;
      const before = doc.exportHwp();
      expect(pick(frame).operations).not.toContain("pathPoint");
      expect(edit({ kind: "pathPoint", index: 1, x: 3001, y: 1402 })).toBe(false);
      expect(() => doc.moveShapePathPoint!(0, 0, frame.controlIdx, 1, 3001, 1402)).toThrow();
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwp()).toEqual(before);
    } finally { editor.dispose(); }
  });

  it.skipIf(!process.env.GEUL_STAGE3_CUBIC)("Stage 3-A appends and removes terminal HWP5 line segments without changing the cubic", async () => {
    const bytes = new Uint8Array(readFileSync(process.env.GEUL_STAGE3_CUBIC!));
    const { editor, doc, pick, edit, confirm, take } = await setup("hwp", bytes);
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const frame = shapes(doc).find(frame => doc.getCurveTerminalLineEdits!(0, 0, frame.controlIdx) !== "null")!;
      const index = frame.controlIdx;
      const selection = pick(frame);
      const read = () => JSON.parse(doc.getEditableShapePath!(0, 0, index));
      const initial = selection.shapePath!;
      const before = doc.getShapeProperties!(0, 0, index);
      const initialBytes = doc.exportHwp();
      expect(selection.curveTerminalLine).toEqual({ append: true, remove: true });
      expect(edit({ kind: "pathSegment", action: "append", x: 0, y: 2000 })).toBe(false);
      expect(edit({ kind: "pathSegment", action: "append", x: 10000, y: 4200 })).toBe(false);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(doc.exportHwp()).toEqual(initialBytes);
      const append = objectEditRequest(selection, { kind: "pathSegment", action: "append", x: 10600, y: 5500 });
      expect(editor.execute("object.edit", append).accepted).toBe(true);
      await confirm();
      expect(editor.execute("object.edit", append).accepted).toBe(false);
      const added = { ...initial, points: [...initial.points, { x: 10600, y: 5500, control: false }] };
      expect(read()).toEqual(added);
      function verifyOutput(filename: string, expected: unknown) {
        const exported = doc.exportHwpWithReport();
        try {
          const output = exported.takeBytes();
          expectReopenEvidence(doc, output, exported.contentLoss());
          const fresh = new engine.HwpDocument(output) as RhwpDocument;
          try {
            expect(JSON.parse(fresh.getEditableShapePath!(0, 0, index))).toEqual(expected);
            expect(fresh.getShapeProperties!(0, 0, index)).toBe(before);
          } finally { fresh.free(); }
          if (out) writeFileSync(resolve(out, filename), output);
        } finally { exported.free(); }
      }
      verifyOutput("a-p4-curve-line-appended.hwp", added);
      expect(edit({ kind: "pathSegment", action: "remove" })).toBe(true);
      await confirm();
      expect(read()).toEqual(initial);
      expect(edit({ kind: "pathSegment", action: "remove" })).toBe(true);
      await confirm();
      const removed = { ...initial, points: initial.points.slice(0, -1) };
      expect(read()).toEqual(removed);
      expect(editor.objectSelection?.curveTerminalLine).toEqual({ append: true, remove: false });
      expect(edit({ kind: "pathSegment", action: "remove" })).toBe(false);
      expect(() => doc.editCurveTerminalLine!(0, 0, index, false, 0, 0)).toThrow();
      expect(editor.localRevision).toBe(3);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(initial);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toEqual(removed);
      expect(doc.getShapeProperties!(0, 0, index)).toBe(before);
      verifyOutput("a-p4-curve-line-removed.hwp", removed);
    } finally { editor.dispose(); }
  });

  it.skipIf(!process.env.GEUL_STAGE3_CUBIC_INTERIOR)("Stage 3-A splits and joins HWP5 straight segments between cubics", async () => {
    const bytes = new Uint8Array(readFileSync(process.env.GEUL_STAGE3_CUBIC_INTERIOR!));
    const { editor, doc, pick, edit, confirm, take } = await setup("hwp", bytes);
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const frame = shapes(doc).find(f => doc.getCurveTerminalLineEdits!(0, 0, f.controlIdx) !== "null")!;
      const address = [0, 0, frame.controlIdx] as const;
      const selection = pick(frame);
      const initial = selection.shapePath!;
      const shape = doc.getShapeProperties!(...address);
      const baseline = doc.exportHwp();
      const read = () => JSON.parse(doc.getEditableShapePath!(...address));
      expect(selection.curveLineStructure).toBe(true);
      expect(edit({ kind: "pathSegment", action: "splitLine", index: 3, x: 9050, y: 5001 })).toBe(false);
      expect(edit({ kind: "pathSegment", action: "splitLine", index: 0, x: 2500, y: 1000 })).toBe(false);
      expect(edit({ kind: "pathSegment", action: "joinLines", index: 3 })).toBe(false);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwp()).toEqual(baseline);

      const split = objectEditRequest(editor.objectSelection!, { kind: "pathSegment", action: "splitLine", index: 3, x: 9050, y: 5000 });
      expect(editor.execute("object.edit", split).accepted).toBe(true);
      await confirm();
      expect(editor.execute("object.edit", split).accepted).toBe(false);
      const next = { ...initial, points: [...initial.points.slice(0, 4), { x: 9050, y: 5000, control: false }, ...initial.points.slice(4)] };
      expect(read()).toEqual(next);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(initial);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toEqual(next);

      function verifyOutput(filename: string, expected: unknown) {
        const exported = doc.exportHwpWithReport();
        try {
          const output = exported.takeBytes();
          expectReopenEvidence(doc, output, exported.contentLoss());
          const reopened = new engine.HwpDocument(output) as RhwpDocument;
          try {
            expect(JSON.parse(reopened.getEditableShapePath!(...address))).toEqual(expected);
            expect(reopened.getShapeProperties!(...address)).toBe(shape);
          } finally { reopened.free(); }
          if (out) writeFileSync(resolve(out, filename), output);
        } finally { exported.free(); }
      }
      verifyOutput("a-p4-curve-interior-split.hwp", next);
      pick(frame);
      expect(edit({ kind: "pathSegment", action: "joinLines", index: 4 })).toBe(true);
      await confirm();
      expect(read()).toEqual(initial);
      verifyOutput("a-p4-curve-interior-joined.hwp", initial);
    } finally { editor.dispose(); }
  });

  it.skipIf(!process.env.GEUL_STAGE3_CUBIC_INTERIOR)("Stage 3-A inserts and removes one HWP5 cubic segment without changing neighboring commands", async () => {
    const bytes = new Uint8Array(readFileSync(process.env.GEUL_STAGE3_CUBIC_INTERIOR!));
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(resolve(out, "a-p4-curve-interior-original.hwp"), bytes);
    }
    const { editor, doc, pick, edit, confirm, take } = await setup("hwp", bytes);
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const frame = shapes(doc).find(candidate => JSON.parse(doc.getEditableShapePath!(0, 0, candidate.controlIdx))?.kind === "curve")!;
      const address = [0, 0, frame.controlIdx] as const;
      const selection = pick(frame);
      const before = doc.exportHwp();
      const original = selection.shapePath!;
      const read = () => JSON.parse(doc.getEditableShapePath!(...address));
      expect(original.points.map(point => point.control)).toEqual([false, true, true, false, false, true, true, false]);
      expect(selection.curveCubicStructure).toBe(true);

      expect(edit({ kind: "pathSegment", action: "insertCubic", index: 1,
        c1x: 8500, c1y: 6800, c2x: 9500, c2y: 6800, x: 10300, y: 5500 })).toBe(false);
      expect(edit({ kind: "pathSegment", action: "insertCubic", index: 3,
        c1x: 8500, c1y: 6800, c2x: 9500, c2y: 6800, x: original.points[3]!.x, y: original.points[3]!.y })).toBe(false);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwp()).toEqual(before);

      const insert = objectEditRequest(editor.objectSelection!, { kind: "pathSegment", action: "insertCubic", index: 3,
        c1x: 8500, c1y: 6800, c2x: 9500, c2y: 6800, x: 10300, y: 5500 });
      const outcome = editor.execute("object.edit", insert);
      expect(outcome.accepted).toBe(true);
      await confirm();
      const added = { ...original, points: [...original.points.slice(0, 4),
        { x: 8500, y: 6800, control: true }, { x: 9500, y: 6800, control: true },
        { x: 10300, y: 5500, control: false }, ...original.points.slice(4)] };
      expect(read()).toEqual(added);
      expect(editor.execute("object.edit", insert).accepted).toBe(false);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(original);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toEqual(added);

      const insertedExport = doc.exportHwpWithReport();
      try {
        const output = insertedExport.takeBytes();
        expectReopenEvidence(doc, output, insertedExport.contentLoss());
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(JSON.parse(reopened.getEditableShapePath!(...address))).toEqual(added); }
        finally { reopened.free(); }
        if (out) writeFileSync(resolve(out, "a-p4-curve-cubic-inserted.hwp"), output);
      } finally { insertedExport.free(); }

      const currentFrame = shapes(doc).find(candidate => JSON.parse(doc.getEditableShapePath!(0, 0, candidate.controlIdx))?.kind === "curve")!;
      const removal = objectEditRequest(pick(currentFrame), { kind: "pathSegment", action: "removeCubic", index: 4 });
      expect(editor.execute("object.edit", removal).accepted).toBe(true);
      await confirm();
      expect(read()).toEqual(original);
      expect(editor.execute("object.edit", removal).accepted).toBe(false);
      expect(editor.localRevision).toBe(4);
      const removedExport = doc.exportHwpWithReport();
      try {
        const output = removedExport.takeBytes();
        expectReopenEvidence(doc, output, removedExport.contentLoss());
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(JSON.parse(reopened.getEditableShapePath!(...address))).toEqual(original); }
        finally { reopened.free(); }
        if (out) writeFileSync(resolve(out, "a-p4-curve-cubic-removed.hwp"), output);
      } finally { removedExport.free(); }
    } finally { editor.dispose(); }
  });

  it.skipIf(!process.env.GEUL_STAGE3_CUBIC_UNMODELED)("Stage 3-A refuses HWP5 line segment edits with unmodeled curve padding", async () => {
    const bytes = new Uint8Array(readFileSync(process.env.GEUL_STAGE3_CUBIC_UNMODELED!));
    const { editor, doc, pick, edit, take } = await setup("hwp", bytes);
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const frame = shapes(doc).find(frame => JSON.parse(doc.getEditableShapePath!(0, 0, frame.controlIdx))?.kind === "curve")!;
      const before = doc.exportHwp();
      expect(pick(frame).operations).not.toContain("pathSegment");
      expect(edit({ kind: "pathSegment", action: "remove" })).toBe(false);
      expect(() => doc.editCurveTerminalLine!(0, 0, frame.controlIdx, false, 0, 0)).toThrow();
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwp()).toEqual(before);
    } finally { editor.dispose(); }
  });

  it("Stage 3-A edits only the selected HWPX group child's solid fill", async () => {
    const fixture = new engine.HwpDocument(source("hwpx")) as RhwpDocument & { groupShapes(json: string): string };
    let bytes: Uint8Array, index: number;
    try {
      const targets = ["rectangle", "ellipse"].map((shapeType, i) => {
        const { controlIdx } = JSON.parse(fixture.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 2 + i, shapeType, width: 5200, height: 4100,
          treatAsChar: false, textWrap: "Square", horzOffset: i * 6500, vertOffset: i * 800,
        })));
        fixture.setShapeProperties!(0, 0, controlIdx, JSON.stringify({ fillType: "solid", fillBgColor: i ? 0x601234 : 0x348951 }));
        return { paraIdx: 0, controlIdx };
      });
      const grouped = JSON.parse(fixture.groupShapes(JSON.stringify({ sectionIdx: 0, targets })));
      expect(grouped.ok).toBe(true);
      index = grouped.controlIdx;
      fixture.setShapeProperties!(0, 0, index, '{"textWrap":"Square","horzOffset":500,"vertOffset":500}');
      bytes = fixture.exportHwpx();
    } finally { fixture.free(); }
    const { editor, doc, pick, edit, confirm } = await setup("hwpx", bytes);
    try {
      const frame = (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      const selected = pick(frame);
      expect(selected.groupChildFills).toEqual([
        { index: 0, kind: "rectangle", color: "518934" }, { index: 1, kind: "ellipse", color: "341260" },
      ]);
      const read = () => doc.getEditableGroupFills!(0, 0, index);
      const original = read();
      expect(edit({ kind: "groupChildFill", index: 2, color: "FF8833" })).toBe(false);
      expect(editor.snapshot().history?.undo).toBe(false);
      expect(read()).toBe(original);
      const beforeProperties = doc.getShapeProperties!(0, 0, index);
      expect(edit({ kind: "groupChildFill", index: 1, color: "FF8833" })).toBe(true);
      await confirm();
      const after = read();
      expect(JSON.parse(after)).toEqual([{ index: 0, kind: "rectangle", color: 0x348951 }, { index: 1, kind: "ellipse", color: 0x3388ff }]);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toBe(original);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toBe(after);
      expect(doc.getShapeProperties!(0, 0, index)).toBe(beforeProperties);
      const exported = doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes();
        expectReopenEvidence(doc, output, exported.contentLoss());
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(reopened.getEditableGroupFills!(0, 0, index)).toBe(after); }
        finally { reopened.free(); }
        if (out) {
          writeFileSync(resolve(out, "a-p4-group-original.hwpx"), bytes);
          writeFileSync(resolve(out, "a-p4-group-edited.hwpx"), output);
          writeFileSync(resolve(out, "a-p4-group-report.json"), exported.contentLoss());
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("Stage 3-A P4.6-1 preserves HWPX group child geometry, rendering, save/reopen, parent translation, and fill edits", async () => {
    const svgShapes = (d: RhwpDocument) => {
      const svg = (d as RhwpDocument & { renderPageSvg(page: number): string }).renderPageSvg(0);
      const rectMatch = /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#518934"/.exec(svg);
      const ellipseMatch = /<ellipse cx="([^"]+)" cy="([^"]+)" rx="([^"]+)" ry="([^"]+)" fill="#(341260|ff8833)"/i.exec(svg);
      expect(rectMatch, `missing group rect in SVG: ${svg}`).not.toBeNull();
      expect(ellipseMatch, `missing group ellipse in SVG: ${svg}`).not.toBeNull();
      return {
        rect: rectMatch!.slice(1, 5).map(Number) as [number, number, number, number],
        ellipse: ellipseMatch!.slice(1, 5).map(Number) as [number, number, number, number],
      };
    };
    const inspectGroupXml = (bytes: Uint8Array) => JSON.parse(execFileSync("python3", ["-c", `
from xml.etree import ElementTree as ET
import io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as zf:
    root = ET.fromstring(zf.read("Contents/section0.xml"))
c = root.find(".//{*}container")
def child_info(el):
    return {
        "tag": el.tag.split("}")[-1],
        "id": el.attrib.get("id"),
        "offset": el.find("{*}offset").attrib,
        "orgSz": el.find("{*}orgSz").attrib,
        "curSz": el.find("{*}curSz").attrib,
        "sz": el.find("{*}sz").attrib,
        "pos": el.find("{*}pos").attrib,
        "matrices": [(m.tag.split("}")[-1], m.attrib) for m in el.find("{*}renderingInfo")],
    }
print(json.dumps({
    "parent": {
        "pos": c.find("{*}pos").attrib,
        "orgSz": c.find("{*}orgSz").attrib,
        "curSz": c.find("{*}curSz").attrib,
    },
    "children": [child_info(ch) for ch in c if ch.tag.split("}")[-1] in ("rect", "ellipse")],
}))
`], { input: bytes, encoding: "utf8" }));

    // G1 & G2: groupShapes -> exportHwpx emits non-zero transMatrix matching child offset, and renders identically before & after reopen.
    const created = new engine.HwpDocument(source("hwpx")) as RhwpDocument & { groupShapes(json: string): string };
    let generatedBytes: Uint8Array;
    let groupIndex: number;
    try {
      const targets = ["rectangle", "ellipse"].map((shapeType, i) => {
        const { controlIdx } = JSON.parse(created.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 2 + i, shapeType, width: 5200, height: 4100,
          treatAsChar: false, textWrap: "Square", horzOffset: i * 6500, vertOffset: i * 800,
        })));
        created.setShapeProperties!(0, 0, controlIdx, JSON.stringify({ fillType: "solid", fillBgColor: i ? 0x601234 : 0x348951 }));
        return { paraIdx: 0, controlIdx };
      });
      const grouped = JSON.parse(created.groupShapes(JSON.stringify({ sectionIdx: 0, targets })));
      expect(grouped.ok).toBe(true);
      groupIndex = grouped.controlIdx;
      created.setShapeProperties!(0, 0, groupIndex, '{"textWrap":"Square","horzOffset":500,"vertOffset":500}');
      const inMemory = svgShapes(created);
      expect(inMemory.rect[0]).toBeCloseTo(500 * 96 / 7200, 6);
      expect(inMemory.rect[1]).toBeCloseTo(500 * 96 / 7200, 6);
      expect(inMemory.ellipse[0]).toBeCloseTo((500 + 6500 + 2600) * 96 / 7200, 6);
      expect(inMemory.ellipse[1]).toBeCloseTo((500 + 800 + 2050) * 96 / 7200, 6);
      generatedBytes = created.exportHwpx();
    } finally { created.free(); }

    const genXml = inspectGroupXml(generatedBytes);
    expect(genXml.children).toHaveLength(2);
    expect(genXml.children[1].offset).toEqual({ x: "6500", y: "800" });
    expect(genXml.children[1].matrices[0]).toEqual(["transMatrix", { e1: "1", e2: "0", e3: "6500", e4: "0", e5: "1", e6: "800" }]);

    // G3 & G5: Identity renderingInfo with nonzero <hp:offset> preserves child placement without double-apply, and survives no-op save/reopen.
    const identityMatrixHwpx = execFileSync("python3", ["-c", `
import io, re, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == "Contents/section0.xml":
                identity = (
                    b'<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
                    b'<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
                    b'<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
                )
                data, count = re.subn(
                    rb'(<hp:(?:rect|ellipse)\\b[^>]*>.*?<hp:renderingInfo>).*?(</hp:renderingInfo>)',
                    lambda m: m.group(1) + identity + m.group(2), data, flags=re.S,
                )
                assert count == 2, f"expected two direct group-child renderingInfo blocks, got {count}"
            dst.writestr(entry, data)
    sys.stdout.buffer.write(out.getvalue())
`], { input: generatedBytes });
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(resolve(out, "a-p4-group-original.hwpx"), identityMatrixHwpx);
    }
    const legacyFixtures: Uint8Array[] = [identityMatrixHwpx];
    const recordedFixture = resolve("target/stage3a-p4/fixtures/a-p4-group-original.hwpx");
    if (existsSync(recordedFixture)) legacyFixtures.push(new Uint8Array(readFileSync(recordedFixture)));

    for (const fixtureBytes of legacyFixtures) {
      const d = new engine.HwpDocument(fixtureBytes) as RhwpDocument;
      try {
        const rendered = svgShapes(d);
        expect(rendered.rect[0]).toBeCloseTo(500 * 96 / 7200, 6);
        expect(rendered.rect[1]).toBeCloseTo(500 * 96 / 7200, 6);
        expect(rendered.ellipse[0]).toBeCloseTo((500 + 6500 + 2600) * 96 / 7200, 6);
        expect(rendered.ellipse[1]).toBeCloseTo((500 + 800 + 2050) * 96 / 7200, 6);
        const noop = d.exportHwpxWithReport();
        try {
          const noopBytes = noop.takeBytes();
          expectReopenEvidence(d, noopBytes, noop.contentLoss());
          expect(inspectGroupXml(noopBytes)).toEqual(inspectGroupXml(fixtureBytes));
          const reopened = new engine.HwpDocument(noopBytes) as RhwpDocument;
          try { expect(svgShapes(reopened)).toEqual(rendered); }
          finally { reopened.free(); }
        } finally { noop.free(); }
      } finally { d.free(); }
    }

    // G6: Non-identity renderingInfo (explicit transMatrix + scaMatrix) must not double-apply offset_x/y and preserves raw matrices.
    const scaledMatrixHwpx = execFileSync("python3", ["-c", `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == "Contents/section0.xml":
                data = data.replace(
                    b'<hc:transMatrix e1="1" e2="0" e3="6500" e4="0" e5="1" e6="800"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>',
                    b'<hc:transMatrix e1="1" e2="0" e3="6500" e4="0" e5="1" e6="800"/><hc:scaMatrix e1="0.5" e2="0" e3="0" e4="0" e5="0.5" e6="0"/>',
                    1,
                )
            dst.writestr(entry, data)
    sys.stdout.buffer.write(out.getvalue())
`], { input: generatedBytes });
    const scaledDoc = new engine.HwpDocument(scaledMatrixHwpx) as RhwpDocument;
    try {
      const scaledSvg = svgShapes(scaledDoc);
      expect(scaledSvg.ellipse[0]).toBeCloseTo((500 + 6500 + 1300) * 96 / 7200, 6);
      expect(scaledSvg.ellipse[1]).toBeCloseTo((500 + 800 + 1025) * 96 / 7200, 6);
      const savedScaled = scaledDoc.exportHwpx();
      expect(inspectGroupXml(savedScaled)).toEqual(inspectGroupXml(scaledMatrixHwpx));
    } finally { scaledDoc.free(); }

    // G4 & G7: Parent translation and child fill edit preserve relative geometry across save/reopen.
    const { editor, doc, pick, edit, confirm } = await setup("hwpx", identityMatrixHwpx);
    try {
      const frame = (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      pick(frame);
      expect(edit({ kind: "nudge", dx: 15, dy: 10 })).toBe(true);
      await confirm();
      const movedSvg = svgShapes(doc);
      expect(movedSvg.rect[0]).toBeCloseTo(2000 * 96 / 7200, 6);
      expect(movedSvg.rect[1]).toBeCloseTo(1500 * 96 / 7200, 6);
      expect(movedSvg.ellipse[0]).toBeCloseTo((2000 + 6500 + 2600) * 96 / 7200, 6);
      expect(movedSvg.ellipse[1]).toBeCloseTo((1500 + 800 + 2050) * 96 / 7200, 6);
      const movedFrame = (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      pick(movedFrame);
      expect(edit({ kind: "groupChildFill", index: 1, color: "FF8833" })).toBe(true);
      await confirm();
      const exported = doc.exportHwpxWithReport();
      try {
        const outBytes = exported.takeBytes();
        expectReopenEvidence(doc, outBytes, exported.contentLoss());
        const afterXml = inspectGroupXml(outBytes);
        const beforeXml = inspectGroupXml(identityMatrixHwpx);
        expect(afterXml.parent.pos.horzOffset).toBe("2000");
        expect(afterXml.parent.pos.vertOffset).toBe("1500");
        expect(afterXml.children).toEqual(beforeXml.children);
        const reopened = new engine.HwpDocument(outBytes) as RhwpDocument;
        try { expect(svgShapes(reopened)).toEqual(movedSvg); }
        finally { reopened.free(); }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("Stage 3-A P4.6-2 moves and resizes flat-group rectangle and ellipse children with Undo/Redo and save preservation (P1-P4)", async () => {
    const svgShapes = (d: RhwpDocument) => {
      const svg = (d as RhwpDocument & { renderPageSvg(page: number): string }).renderPageSvg(0);
      const rectMatch = /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#518934"/.exec(svg);
      const ellipseMatch = /<ellipse cx="([^"]+)" cy="([^"]+)" rx="([^"]+)" ry="([^"]+)" fill="#341260"/.exec(svg);
      expect(rectMatch, `missing rect in SVG: ${svg}`).not.toBeNull();
      expect(ellipseMatch, `missing ellipse in SVG: ${svg}`).not.toBeNull();
      return {
        rect: rectMatch!.slice(1, 5).map(Number) as [number, number, number, number],
        ellipse: ellipseMatch!.slice(1, 5).map(Number) as [number, number, number, number],
      };
    };
    const px = (hu: number) => hu * 96 / 7200;
    const fixturePath = resolve("target/stage3a-p4/fixtures/a-p4-group-original.hwpx");
    const fixtureBytes = new Uint8Array(readFileSync(fixturePath));

    const { editor, doc, pick, edit, confirm } = await setup("hwpx", fixtureBytes);
    try {
      const controls = JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[];
      const groupFrame = controls.find(c => c.type === "group")!;
      const [sec, para, ctrl] = groupFrame.stableIndex;
      const beforeProps = doc.getShapeProperties!(sec, para, ctrl);

      const sel0 = pick(groupFrame)!;
      expect(sel0.operations).toContain("groupChildGeometry");
      const gc0 = sel0.groupChildren!;
      expect(gc0.width).toBe(11700);
      expect(gc0.height).toBe(4900);
      expect(gc0.children).toEqual([
        { index: 0, kind: "rectangle", id: 2112144572, instId: 1038402749, x: 0, y: 0, width: 5200, height: 4100, sizeProtect: false, locked: false, canMove: true, canResize: true },
        { index: 1, kind: "ellipse", id: 2112169928, instId: 1038428105, x: 6500, y: 800, width: 5200, height: 4100, sizeProtect: false, locked: false, canMove: true, canResize: true },
      ]);

      // P1: Move rectangle inside parent
      expect(edit({ kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: 400, y: 300 })).toBe(true);
      await confirm();
      expect(doc.getShapeProperties!(sec, para, ctrl)).toBe(beforeProps);
      let svg = svgShapes(doc);
      expect(svg.rect[0]).toBeCloseTo(px(500 + 400), 6);
      expect(svg.rect[1]).toBeCloseTo(px(500 + 300), 6);
      expect(svg.ellipse[0]).toBeCloseTo(px(500 + 6500 + 2600), 6);
      expect(svg.ellipse[1]).toBeCloseTo(px(500 + 800 + 2050), 6);

      // P2: Move ellipse left/up inside parent
      expect(edit({ kind: "groupChildMove", index: 1, id: 2112169928, instId: 1038428105, x: 5200, y: 200 })).toBe(true);
      await confirm();
      svg = svgShapes(doc);
      expect(svg.ellipse[0]).toBeCloseTo(px(500 + 5200 + 2600), 6);
      expect(svg.ellipse[1]).toBeCloseTo(px(500 + 200 + 2050), 6);

      // P3: Resize rectangle & ellipse (left/top anchored)
      expect(edit({ kind: "groupChildResize", index: 0, id: 2112144572, instId: 1038402749, width: 4200, height: 3500 })).toBe(true);
      await confirm();
      expect(edit({ kind: "groupChildResize", index: 1, id: 2112169928, instId: 1038428105, width: 4600, height: 3200 })).toBe(true);
      await confirm();

      const expectedAfter = {
        parentId: 0, width: 11700, height: 4900,
        children: [
          { index: 0, kind: "rectangle", id: 2112144572, instId: 1038402749, x: 400, y: 300, width: 4200, height: 3500, sizeProtect: false, locked: false, canMove: true, canResize: true },
          { index: 1, kind: "ellipse", id: 2112169928, instId: 1038428105, x: 5200, y: 200, width: 4600, height: 3200, sizeProtect: false, locked: false, canMove: true, canResize: true },
        ],
      };
      expect(JSON.parse(doc.getEditableGroupChildren!(sec, para, ctrl))).toEqual(expectedAfter);
      svg = svgShapes(doc);
      expect(svg.rect).toEqual([expect.closeTo(px(900), 6), expect.closeTo(px(800), 6), expect.closeTo(px(4200), 6), expect.closeTo(px(3500), 6)]);
      expect(svg.ellipse).toEqual([expect.closeTo(px(500 + 5200 + 2300), 6), expect.closeTo(px(500 + 200 + 1600), 6), expect.closeTo(px(2300), 6), expect.closeTo(px(1600), 6)]);

      // P4: Repeated Undo/Redo restores exact intermediate & final child states
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(JSON.parse(doc.getEditableGroupChildren!(sec, para, ctrl)).children[1]).toMatchObject({ x: 5200, y: 200, width: 5200, height: 4100 });
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(JSON.parse(doc.getEditableGroupChildren!(sec, para, ctrl)).children[0]).toMatchObject({ x: 400, y: 300, width: 5200, height: 4100 });
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(JSON.parse(doc.getEditableGroupChildren!(sec, para, ctrl))).toEqual(expectedAfter);

      // Save, independent XML inspection, reopen, and save_check verification
      const exported = doc.exportHwpxWithReport();
      try {
        const outBytes = exported.takeBytes();
        expectReopenEvidence(doc, outBytes, exported.contentLoss());
        const reopened = new engine.HwpDocument(outBytes) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getEditableGroupChildren!(sec, para, ctrl))).toEqual(expectedAfter);
          expect(svgShapes(reopened)).toEqual(svg);
        } finally { reopened.free(); }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.skipIf(!process.env.GEUL_STAGE3_HWP5_GROUP || !out)("Stage 3-A P4-H5-GROUP edits owned HWP5 group children with T009 and reopen evidence", async () => {
    type HwpGroupFactory = RhwpDocument & { groupShapes(json: string): string };
    const makeFixture = () => {
      const fixture = engine.HwpDocument.createEmpty() as HwpGroupFactory;
      try {
        fixture.createBlankDocument();
        fixture.insertText(0, 0, 0, "HWP5 group child acceptance");
        const rect = JSON.parse(fixture.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: "rectangle",
          width: 5000, height: 4000, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
        }))) as { ok: boolean; controlIdx: number };
        const ellipse = JSON.parse(fixture.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 1, shapeType: "ellipse",
          width: 5000, height: 4000, treatAsChar: false, textWrap: "Square", horzOffset: 5900, vertOffset: 0,
        }))) as { ok: boolean; controlIdx: number };
        expect(rect.ok && ellipse.ok).toBe(true);
        expect(JSON.parse(fixture.setShapeProperties!(0, 0, rect.controlIdx,
          JSON.stringify({ fillType: "solid", fillBgColor: 0x00112233 }))).ok).toBe(true);
        expect(JSON.parse(fixture.setShapeProperties!(0, 0, ellipse.controlIdx,
          JSON.stringify({ fillType: "solid", fillBgColor: 0x00445566 }))).ok).toBe(true);
        const group = JSON.parse(fixture.groupShapes(JSON.stringify({
          sectionIdx: 0,
          targets: [{ paraIdx: 0, controlIdx: rect.controlIdx }, { paraIdx: 0, controlIdx: ellipse.controlIdx }],
        }))) as { ok: boolean; controlIdx: number };
        expect(group.ok).toBe(true);
        expect(JSON.parse(fixture.setShapeProperties!(0, 0, group.controlIdx,
          '{"textWrap":"Square","horzOffset":800,"vertOffset":900}')).ok).toBe(true);
        return fixture.exportHwp();
      } finally { fixture.free(); }
    };
    const originalBytes = makeFixture();
    mkdirSync(out!, { recursive: true });
    writeFileSync(resolve(out!, "p4-h5-group-original.hwp"), originalBytes);

    const state = (doc: RhwpDocument) => {
      const frame = (JSON.parse(doc.getPageControlLayout!(0)).controls as (Frame & { stableIndex: [number, number, number] })[])
        .find(item => item.type === "group");
      expect(frame, "expected one exported HWP5 group").toBeDefined();
      const [sec, para, ctrl] = frame!.stableIndex;
      return { frame: frame!, address: [sec, para, ctrl] as const,
        value: JSON.parse(doc.getEditableGroupChildren!(sec, para, ctrl)) as {
          parentId: number; width: number; height: number;
          children: { index: number; kind: string; id: number; instId: number; x: number; y: number;
            width: number; height: number; canMove: boolean; canResize: boolean; locked: boolean; sizeProtect: boolean }[];
        } };
    };
    const baseline = new engine.HwpDocument(originalBytes) as RhwpDocument;
    try {
      const parsed = state(baseline);
      expect(parsed.value).toMatchObject({ width: 10900, height: 4000, children: [
        { index: 0, kind: "rectangle", x: 0, y: 0, width: 5000, height: 4000, canMove: true, canResize: true },
        { index: 1, kind: "ellipse", x: 5900, y: 0, width: 5000, height: 4000, canMove: true, canResize: true },
      ] });
      expect(parsed.value.children[0]!.id).not.toBe(parsed.value.children[1]!.id);
      expect(parsed.value.children[0]!.instId).not.toBe(parsed.value.children[1]!.instId);
    } finally { baseline.free(); }

    const session = await setup("hwp", originalBytes);
    session.take("original").reply(ok(originalBytes));
    await flush();
    session.take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
    await flush();
    const write = (name: string) => {
      const exported = session.doc.exportHwpWithReport();
      try {
        const bytes = exported.takeBytes();
        expectReopenEvidence(session.doc, bytes, exported.contentLoss());
        const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
        try {
          expect(state(reopened).value).toEqual(state(session.doc).value);
        } finally { reopened.free(); }
        writeFileSync(resolve(out!, `p4-h5-group-session-${name}.hwp`), bytes);
      } finally { exported.free(); }
    };
    try {
      const initial = state(session.doc);
      const selection = session.pick(initial.frame)!;
      expect(selection.operations).toEqual(expect.arrayContaining(["groupChildGeometry", "groupChildFill"]));
      expect(selection.groupChildren).toEqual(initial.value);

      const child = initial.value.children[0]!;
      expect(session.edit({ kind: "groupChildMove", index: child.index, id: child.id, instId: child.instId, x: 100, y: 0 })).toBe(true);
      await session.confirm();
      expect(state(session.doc).value.children[0]).toMatchObject({ x: 100, y: 0 });
      write("move");
      expect(session.editor.undo()).toBe(true);
      await session.confirm();
      expect(state(session.doc).value).toEqual(initial.value);
      expect(session.editor.redo()).toBe(true);
      await session.confirm();
      expect(state(session.doc).value.children[0]).toMatchObject({ x: 100, y: 0 });

      const moved = state(session.doc);
      session.pick(moved.frame);
      expect(session.edit({ kind: "groupChildResize", index: child.index, id: child.id, instId: child.instId, width: 4800, height: 3500 })).toBe(true);
      await session.confirm();
      expect(state(session.doc).value.children[0]).toMatchObject({ width: 4800, height: 3500 });
      write("resize");
      expect(session.editor.undo()).toBe(true);
      await session.confirm();
      expect(state(session.doc).value.children[0]).toMatchObject({ x: 100, y: 0, width: 5000, height: 4000 });
      expect(session.editor.redo()).toBe(true);
      await session.confirm();
      expect(state(session.doc).value.children[0]).toMatchObject({ width: 4800, height: 3500 });

      const resized = state(session.doc);
      session.pick(resized.frame);
      const originalFill = JSON.parse(session.doc.getEditableGroupFills!(...resized.address))
        .find((item: { index: number }) => item.index === 0).color as number;
      expect(session.edit({ kind: "groupChildFill", index: child.index, color: "00AA55" })).toBe(true);
      await session.confirm();
      expect(JSON.parse(session.doc.getEditableGroupFills!(...resized.address))
        .find((item: { index: number }) => item.index === 0).color).toBe(0x0055AA00);
      write("fill");
      expect(session.editor.undo()).toBe(true);
      await session.confirm();
      expect(JSON.parse(session.doc.getEditableGroupFills!(...resized.address)).find((item: { index: number }) => item.index === 0).color)
        .toBe(originalFill);
      expect(session.editor.redo()).toBe(true);
      await session.confirm();

      const filled = state(session.doc);
      session.pick(filled.frame);
      const sibling = filled.value.children[1]!;
      expect(session.edit({ kind: "groupChildFill", index: sibling.index, color: "AABB99" })).toBe(true);
      await session.confirm();
      write("combined");
      session.editor.dispose();
    } catch (error) {
      session.editor.dispose();
      throw error;
    }

    const writeIndependentVariant = (name: string,
      apply: (doc: RhwpDocument, address: readonly [number, number, number],
        children: ReturnType<typeof state>["value"]["children"]) => void) => {
      const doc = new engine.HwpDocument(originalBytes) as RhwpDocument;
      try {
        const before = state(doc);
        apply(doc, before.address, before.value.children);
        const exported = doc.exportHwpWithReport();
        try {
          const bytes = exported.takeBytes();
          expectReopenEvidence(doc, bytes, exported.contentLoss());
          const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
          try { expect(state(reopened).value).toEqual(state(doc).value); }
          finally { reopened.free(); }
          writeFileSync(resolve(out!, `p4-h5-group-${name}.hwp`), bytes);
        } finally { exported.free(); }
      } finally { doc.free(); }
    };
    writeIndependentVariant("move", (doc, address, children) => {
      const child = children[0]!;
      doc.moveGroupChild!(...address, child.index, child.id, child.instId, 100, 0);
    });
    writeIndependentVariant("resize", (doc, address, children) => {
      const child = children[0]!;
      doc.resizeGroupChild!(...address, child.index, child.id, child.instId, 4800, 3500);
    });
    writeIndependentVariant("fill", (doc, address) => doc.setGroupChildFill!(...address, 0, 0x0055AA00));
    writeIndependentVariant("combined", (doc, address, children) => {
      const rect = children[0]!, ellipse = children[1]!;
      doc.moveGroupChild!(...address, rect.index, rect.id, rect.instId, 100, 0);
      doc.resizeGroupChild!(...address, rect.index, rect.id, rect.instId, 4800, 3500);
      doc.setGroupChildFill!(...address, rect.index, 0x0055AA00);
      doc.setGroupChildFill!(...address, ellipse.index, 0x0099BBAA);
    });
  });

  it("Stage 3-A P4.6-2 rejects unsupported, protected, transformed, out-of-range, and misowned group child geometry edits (N1-N12)", async () => {
    const fixturePath = resolve("target/stage3a-p4/fixtures/a-p4-group-original.hwpx");
    const fixtureBytes = new Uint8Array(readFileSync(fixturePath));
    const patchSection = (pyReplace: string) => execFileSync("python3", ["-c", `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == "Contents/section0.xml":
                xml = data.decode("utf-8")
                ${pyReplace}
                data = xml.encode("utf-8")
            dst.writestr(entry, data)
    sys.stdout.buffer.write(out.getvalue())
`], { input: fixtureBytes });

    // N1: HWP5 file & non-group shape HWPX must reject getEditableGroupChildren
    const hwpDoc = new engine.HwpDocument(source("hwp")) as RhwpDocument;
    try {
      expect(hwpDoc.getEditableGroupChildren!(0, 0, 0)).toBe("null");
    } finally { hwpDoc.free(); }

    const nonGroupDoc = new engine.HwpDocument(source("hwpx")) as RhwpDocument;
    try {
      const created = JSON.parse(nonGroupDoc.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "rectangle", width: 3600, height: 2400, treatAsChar: false,
      })));
      expect(nonGroupDoc.getEditableGroupChildren!(0, 0, created.controlIdx)).toBe("null");
      expect(() => nonGroupDoc.moveGroupChild!(0, 0, created.controlIdx, 0, 0, 0, 100, 100)).toThrow();
    } finally { nonGroupDoc.free(); }

    // N2..N5, N7..N8, N11..N12: Group-level blockers must yield null; child-level blockers must mark child non-editable & throw on mutate
    const rejectGroupCases: [string, string][] = [
      ["N2-nested-group", `xml = xml.replace('<hp:ellipse ', '<hp:container id="9" groupLevel="1"><hp:offset x="0" y="0"/><hp:orgSz width="100" height="100"/><hp:curSz width="100" height="100"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="50" centerY="50" rotateimage="0"/></hp:container><hp:ellipse ', 1)`],
      ["N3-locked-parent", `xml = xml.replace('<hp:container id="0" zOrder="2" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="0"', '<hp:container id="0" zOrder="2" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="1"', 1)`],
      ["N3-size-protect-parent", `xml = xml.replace('<hp:sz width="11700" widthRelTo="ABSOLUTE" height="4900" heightRelTo="ABSOLUTE" protect="0"/>', '<hp:sz width="11700" widthRelTo="ABSOLUTE" height="4900" heightRelTo="ABSOLUTE" protect="1"/>', 1)`],
      ["N4-rotated-parent", `xml = xml.replace('<hp:rotationInfo angle="0" centerX="5850" centerY="2450" rotateimage="0"/>', '<hp:rotationInfo angle="15" centerX="5850" centerY="2450" rotateimage="0"/>', 1)`],
      ["N4-flipped-parent", `xml = xml.replace('<hp:flip horizontal="0" vertical="0"/>', '<hp:flip horizontal="1" vertical="0"/>', 1)`],
      ["N4-scaled-parent", `xml = xml.replace('<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>', '<hc:scaMatrix e1="0.8" e2="0" e3="0" e4="0" e5="1" e6="0"/>', 1)`],
      ["N4-skewed-parent", `xml = xml.replace('<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>', '<hc:rotMatrix e1="1" e2="0.2" e3="0" e4="0" e5="1" e6="0"/>', 1)`],
      ["N5-all-locked-children", `xml = xml.replace('id="2112144572" zOrder="0" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="0"', 'id="2112144572" zOrder="0" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="1"', 1).replace('id="2112169928" zOrder="1" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="0"', 'id="2112169928" zOrder="1" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="1"', 1)`],
      ["N7-captioned-parent", `xml = xml.replace('<hp:shapeComment>묶음 개체입니다.</hp:shapeComment>', '<hp:caption side="BOTTOM" fullSz="0" width="850" gap="850" lastWidth="11700"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>c</hp:t></hp:run></hp:p></hp:subList></hp:caption><hp:shapeComment>묶음 개체입니다.</hp:shapeComment>', 1)`],
      ["N8-all-textbox-children", `xml = xml.replace('<hp:shapeComment>사각형입니다.</hp:shapeComment>', '<hp:drawText lastWidth="5200" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>t</hp:t></hp:run></hp:p></hp:subList></hp:drawText><hp:shapeComment>사각형입니다.</hp:shapeComment>', 1).replace('<hp:shapeComment>타원입니다.</hp:shapeComment>', '<hp:drawText lastWidth="5200" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>t2</hp:t></hp:run></hp:p></hp:subList></hp:drawText><hp:shapeComment>타원입니다.</hp:shapeComment>', 1)`],
      ["N11-duplicate-ids", `xml = xml.replace('id="2112169928"', 'id="2112144572"', 1).replace('instid="1038428105"', 'instid="1038402749"', 1)`],
      ["N12-nonzero-parent-offset", `xml = xml.replace('<hp:offset x="0" y="0"/>', '<hp:offset x="100" y="0"/>', 1)`],
    ];

    for (const [label, script] of rejectGroupCases) {
      const modBytes = patchSection(script);
      const d = new engine.HwpDocument(modBytes) as RhwpDocument;
      try {
        const ctrls = JSON.parse(d.getPageControlLayout!(0)).controls as Frame[];
        const g = ctrls.find(c => c.type === "group");
        if (g) {
          const [s, p, c] = g.stableIndex;
          expect(d.getEditableGroupChildren!(s, p, c), label).toBe("null");
          expect(() => d.moveGroupChild!(s, p, c, 0, 2112144572, 1038402749, 10, 10), label).toThrow();
        }
      } finally { d.free(); }
    }

    // Per-child transform/textbox blockers must mark only the affected child non-editable & throw on mutate
    const rejectChildCases: [string, string][] = [
      ["N4-rotated-child", `xml = xml.replace('<hp:rotationInfo angle="0" centerX="2600" centerY="2050" rotateimage="0"/>', '<hp:rotationInfo angle="15" centerX="2600" centerY="2050" rotateimage="0"/>', 1)`],
      ["N4-flipped-child", `xml = xml.replace('<hp:flip horizontal="0" vertical="0"/>', '<hp:flip horizontal="1" vertical="0"/>', 2).replace('<hp:flip horizontal="1" vertical="0"/>', '<hp:flip horizontal="0" vertical="0"/>', 1)`],
      ["N4-scaled-child", `xml = xml.replace('<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>', '<hc:scaMatrix e1="0.8" e2="0" e3="0" e4="0" e5="1" e6="0"/>', 2).replace('<hc:scaMatrix e1="0.8" e2="0" e3="0" e4="0" e5="1" e6="0"/>', '<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>', 1)`],
      ["N8-textbox-child", `xml = xml.replace('<hp:shapeComment>사각형입니다.</hp:shapeComment>', '<hp:drawText lastWidth="5200" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>t</hp:t></hp:run></hp:p></hp:subList></hp:drawText><hp:shapeComment>사각형입니다.</hp:shapeComment>', 1)`],
    ];
    for (const [label, script] of rejectChildCases) {
      const modBytes = patchSection(script);
      const d = new engine.HwpDocument(modBytes) as RhwpDocument;
      try {
        const ctrls = JSON.parse(d.getPageControlLayout!(0)).controls as Frame[];
        const g = ctrls.find(c => c.type === "group")!;
        const [s, p, c] = g.stableIndex;
        const parsed = JSON.parse(d.getEditableGroupChildren!(s, p, c));
        expect(parsed.children[0], label).toMatchObject({ canMove: false, canResize: false });
        expect(() => d.moveGroupChild!(s, p, c, 0, 2112144572, 1038402749, 10, 10), label).toThrow();
        expect(() => d.resizeGroupChild!(s, p, c, 0, 2112144572, 1038402749, 4000, 3000), label).toThrow();
      } finally { d.free(); }
    }

    // N5 mixed (locked rect + unlocked ellipse) & N6 size-protected ellipse (move OK, resize refused)
    const protectedBytes = patchSection(
      `xml = xml.replace('id="2112144572" zOrder="0" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="0"', 'id="2112144572" zOrder="0" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="1"', 1).replace('<hp:sz width="5200" height="4100" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE" protect="0"/>', '<hp:sz width="5200" height="4100" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE" protect="1"/>', 1)`
    );
    const protSetup = await setup("hwpx", protectedBytes);
    try {
      const g = (JSON.parse(protSetup.doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      const [s, p, c] = g.stableIndex;
      const sel = protSetup.pick(g)!;
      expect(sel.groupChildren?.children[0]).toMatchObject({ canMove: false, canResize: false, locked: true });
      expect(sel.groupChildren?.children[1]).toMatchObject({ canMove: true, canResize: false, sizeProtect: true });
      expect(protSetup.edit({ kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: 100, y: 100 })).toBe(false);
      expect(protSetup.edit({ kind: "groupChildResize", index: 1, id: 2112169928, instId: 1038428105, width: 4000, height: 3000 })).toBe(false);
      expect(() => protSetup.doc.resizeGroupChild!(s, p, c, 1, 2112169928, 1038428105, 4000, 3000)).toThrow();
      expect(protSetup.edit({ kind: "groupChildMove", index: 1, id: 2112169928, instId: 1038428105, x: 5800, y: 400 })).toBe(true);
      await protSetup.confirm();
    } finally { protSetup.editor.dispose(); }

    // N9 & N10: Out-of-bounds, invalid sizes, no-op, and wrong child ownership
    const baseSetup = await setup("hwpx", fixtureBytes);
    try {
      const g = (JSON.parse(baseSetup.doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      const [s, p, c] = g.stableIndex;
      const sel = baseSetup.pick(g)!;
      expect(sel).toBeTruthy();
      for (const bad of [
        { kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: -1, y: 0 },
        { kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: 6501, y: 0 },
        { kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: 0, y: 0 },
        { kind: "groupChildMove", index: 0, id: 999, instId: 1038402749, x: 100, y: 100 },
        { kind: "groupChildMove", index: 0, id: 2112144572, instId: 999, x: 100, y: 100 },
        { kind: "groupChildMove", index: 1, id: 2112144572, instId: 1038402749, x: 100, y: 100 },
        { kind: "groupChildResize", index: 0, id: 2112144572, instId: 1038402749, width: 0, height: 100 },
        { kind: "groupChildResize", index: 0, id: 2112144572, instId: 1038402749, width: 11701, height: 100 },
        { kind: "groupChildResize", index: 0, id: 2112144572, instId: 1038402749, width: 5200, height: 4100 },
      ] as const) {
        expect(baseSetup.edit(bad as never), JSON.stringify(bad)).toBe(false);
      }
      expect(() => baseSetup.doc.moveGroupChild!(s, p, c, 0, 999, 1038402749, 100, 100)).toThrow();
      expect(() => baseSetup.doc.resizeGroupChild!(s, p, c, 0, 2112144572, 1038402749, 0, 100)).toThrow();
      expect(() => baseSetup.doc.resizeGroupChild!(s, p, c, 0, 2112144572, 1038402749, 12000, 100)).toThrow();
    } finally { baseSetup.editor.dispose(); }
  });

  it("Stage 3-A P4.6 group child stabilization rejects composite/nonfinite raw transforms (T1-T8) and guards ellipse geometry (E1-E7)", async () => {
    const fixturePath = resolve("target/stage3a-p4/fixtures/a-p4-group-original.hwpx");
    const fixtureBytes = new Uint8Array(readFileSync(fixturePath));
    const patchXml = (fn: string) => patchGroupFixture(fn, fixtureBytes);

    const idRI = '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>';
    const cancelScaleRI = '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="2" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="0.5" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>';
    const cancelRotRI = '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="0" e2="-1" e3="0" e4="1" e5="0" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="0" e2="1" e3="0" e4="-1" e5="0" e6="0"/></hp:renderingInfo>';
    const cancelTransRI = '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="100" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="-100" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>';
    const nanRI = '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="NaN" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>';
    const infRI = '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="Infinity" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>';
    const hugeTxRI = '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="1e20" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>';
    const mismatchTxRI = '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="100" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>';

    const replaceChild0RI = (newRI: string) =>
      `parts = xml.split(${JSON.stringify(idRI)}); assert len(parts) == 4; xml = parts[0] + ${JSON.stringify(idRI)} + parts[1] + ${JSON.stringify(newRI)} + parts[2] + ${JSON.stringify(idRI)} + parts[3]`;

    // T1: Empty/absent <hp:renderingInfo/> on rect child still accepted when modeled transform is clean identity
    const emptyRawBytes = patchXml(replaceChild0RI(""));
    const emptyDoc = new engine.HwpDocument(emptyRawBytes) as RhwpDocument;
    try {
      const parsed = JSON.parse(emptyDoc.getEditableGroupChildren!(0, 0, 2));
      expect(parsed.children[0]).toMatchObject({ canMove: true, canResize: true });
    } finally { emptyDoc.free(); }

    // T3/T4/T5/T6/T8: Canceling composites (scale 2*0.5, rot 90*-90, trans +100/-100), nonfinite NaN/Inf/1e20, and mismatched translation on child or parent fail closed
    for (const [label, replaceScript] of [
      ["T3-child-mismatch-trans", replaceChild0RI(mismatchTxRI)],
      ["T4-child-cancel-scale", replaceChild0RI(cancelScaleRI)],
      ["T4-child-cancel-rot", replaceChild0RI(cancelRotRI)],
      ["T4-child-cancel-trans", replaceChild0RI(cancelTransRI)],
      ["T5-child-nan-matrix", replaceChild0RI(nanRI)],
      ["T5-child-inf-trans", replaceChild0RI(infRI)],
      ["T5-child-huge-trans", replaceChild0RI(hugeTxRI)],
      ["T8-parent-cancel-scale", `xml = xml.replace(${JSON.stringify(idRI)}, ${JSON.stringify(cancelScaleRI)}, 1)`],
    ] as const) {
      const modBytes = patchXml(replaceScript);
      const d = new engine.HwpDocument(modBytes) as RhwpDocument;
      try {
        const raw = d.getEditableGroupChildren!(0, 0, 2);
        if (label.startsWith("T8")) {
          expect(raw, label).toBe("null");
        } else {
          const parsed = JSON.parse(raw);
          expect(parsed.children[0], label).toMatchObject({ canMove: false, canResize: false });
        }
        expect(() => d.moveGroupChild!(0, 0, 2, 0, 2112144572, 1038402749, 10, 10), label).toThrow();
        expect(() => d.resizeGroupChild!(0, 0, 2, 0, 2112144572, 1038402749, 4000, 3000), label).toThrow();
      } finally { d.free(); }
    }

    // E2: Standard odd-sized ellipse (101x51) moves and resizes to odd (85x39) and survives save/reopen
    const oddBytes = patchXml(`
head, ell = xml.split('<hp:ellipse ', 1)
ell = ell.replace('<hp:orgSz width="5200" height="4100"/><hp:curSz width="5200" height="4100"/>', '<hp:orgSz width="101" height="51"/><hp:curSz width="101" height="51"/>', 1).replace('<hc:center x="2600" y="2050"/><hc:ax1 x="5200" y="2050"/><hc:ax2 x="2600" y="4100"/><hc:start1 x="5200" y="2050"/><hc:end1 x="5200" y="2050"/><hc:start2 x="5200" y="2050"/><hc:end2 x="5200" y="2050"/><hp:sz width="5200" height="4100"', '<hc:center x="50" y="25"/><hc:ax1 x="101" y="25"/><hc:ax2 x="50" y="51"/><hc:start1 x="101" y="25"/><hc:end1 x="101" y="25"/><hc:start2 x="101" y="25"/><hc:end2 x="101" y="25"/><hp:sz width="101" height="51"', 1)
xml = head + '<hp:ellipse ' + ell
`.trim().replace(/\n/g, "; "));
    const oddSetup = await setup("hwpx", oddBytes);
    try {
      const g = (JSON.parse(oddSetup.doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      oddSetup.pick(g);
      expect(oddSetup.edit({ kind: "groupChildResize", index: 1, id: 2112169928, instId: 1038428105, width: 85, height: 39 })).toBe(true);
      await oddSetup.confirm();
      const exported = oddSetup.doc.exportHwpxWithReport();
      try {
        const outBytes = exported.takeBytes();
        expectReopenEvidence(oddSetup.doc, outBytes, exported.contentLoss());
        const reopened = new engine.HwpDocument(outBytes) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getEditableGroupChildren!(0, 0, 2)).children[1]).toMatchObject({ width: 85, height: 39 });
        } finally { reopened.free(); }
      } finally { exported.free(); }
    } finally { oddSetup.editor.dispose(); }

    // E3: Noncanonical ellipse endpoints (equal start1==end1==(0,0)) refuse resize without normalizing, while safe move preserves them verbatim
    const noncanonBytes = patchXml(
      `xml = xml.replace('<hc:start1 x="5200" y="2050"/><hc:end1 x="5200" y="2050"/>', '<hc:start1 x="0" y="0"/><hc:end1 x="0" y="0"/>', 1)`
    );
    const noncanonSetup = await setup("hwpx", noncanonBytes);
    try {
      const g = (JSON.parse(noncanonSetup.doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      const sel = noncanonSetup.pick(g)!;
      expect(sel.groupChildren?.children[1]).toMatchObject({ canMove: true, canResize: false });
      expectUnchangedRefusal(noncanonSetup, () => {
        expect(noncanonSetup.edit({ kind: "groupChildResize", index: 1, id: 2112169928, instId: 1038428105, width: 4000, height: 3000 })).toBe(false);
        expect(() => noncanonSetup.doc.resizeGroupChild!(0, 0, 2, 1, 2112169928, 1038428105, 4000, 3000)).toThrow();
      });
      expect(noncanonSetup.edit({ kind: "groupChildMove", index: 1, id: 2112169928, instId: 1038428105, x: 5800, y: 400 })).toBe(true);
      await noncanonSetup.confirm();
      const exported = noncanonSetup.doc.exportHwpxWithReport();
      try {
        const outBytes = exported.takeBytes();
        expectReopenEvidence(noncanonSetup.doc, outBytes, exported.contentLoss());
        const savedXml = execFileSync("python3", ["-c", `import io,sys,zipfile; print(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read("Contents/section0.xml").decode())`], { input: outBytes, encoding: "utf8" });
        expect(savedXml).toContain('<hc:start1 x="0" y="0"/><hc:end1 x="0" y="0"/>');
      } finally { exported.free(); }
    } finally { noncanonSetup.editor.dispose(); }

    // E4 & E5: Extreme i32::MIN+1 / i32::MAX center & invalid/degenerate axes fail closed without overflow or mutation
    for (const [label, replaceScript] of [
      ["E4-extreme-center", `xml = xml.replace('<hc:center x="2600" y="2050"/>', '<hc:center x="-2147483647" y="2147483647"/>', 1)`],
      ["E5-degenerate-axis1", `xml = xml.replace('<hc:ax1 x="5200" y="2050"/>', '<hc:ax1 x="0" y="0"/>', 1)`],
    ] as const) {
      const modBytes = patchXml(replaceScript);
      const d = new engine.HwpDocument(modBytes) as RhwpDocument;
      try {
        const parsed = JSON.parse(d.getEditableGroupChildren!(0, 0, 2));
        expect(parsed.children[1], label).toMatchObject({ canMove: false, canResize: false });
        expect(() => d.moveGroupChild!(0, 0, 2, 1, 2112169928, 1038428105, 5800, 400), label).toThrow();
        expect(() => d.resizeGroupChild!(0, 0, 2, 1, 2112169928, 1038428105, 4000, 3000), label).toThrow();
      } finally { d.free(); }
    }
  });

  it.each([
    { label: "E8 upper odd width", from: [101, 51, 51, 26], to: [101, 39, 51, 19] },
    { label: "E9 upper odd height", from: [101, 51, 51, 26], to: [85, 51, 42, 26] },
    { label: "E10 even", from: [100, 50, 50, 25], to: [100, 40, 50, 20] },
    { label: "E11 lower odd", from: [101, 51, 50, 25], to: [101, 39, 50, 19] },
    { label: "E12 both axes", from: [101, 51, 51, 26], to: [85, 39, 42, 19] },
  ])("Stage 3-A P4.6 group ellipse single-axis preservation ($label)", async ({ label, from, to }) => {
    const [oldW, oldH, oldX, oldY] = from;
    const [width, height, cx, cy] = to;
    const bytes = patchGroupFixture(`
def resize_source(m):
    shape = m[0].replace('width="5200"', 'width="${oldW}"').replace('height="4100"', 'height="${oldH}"')
    shape = shape.replace('centerX="2600" centerY="2050"', 'centerX="${oldX}" centerY="${oldY}"')
    shape = shape.replace('<hc:center x="2600" y="2050"', '<hc:center x="${oldX}" y="${oldY}"')
    shape = shape.replace('<hc:ax2 x="2600" y="4100"', '<hc:ax2 x="${oldX}" y="${oldH}"')
    return shape.replace('x="5200" y="2050"', 'x="${oldW}" y="${oldY}"')
xml, count = re.subn(r'<hp:ellipse .*?</hp:ellipse>', resize_source, xml, flags=re.S)
assert count == 1
`);
    const sourceXml = boundaryGroupXml(bytes);
    const [rect, ellipse] = sourceXml.children;
    const expectedGeometry = (w: number, h: number, x: number, y: number) => ({
      sizes: [[w, h], [w, h], [w, h]],
      center: [x, y], ax1: [w, y], ax2: [x, h],
      start1: [w, y], end1: [w, y], start2: [w, y], end2: [w, y],
      rotation: [x, y], offset: [6500, 800],
    });
    expect(ellipse).toMatchObject({ ...expectedGeometry(oldW, oldH, oldX, oldY), matrices: [identityMatrix, identityMatrix, identityMatrix] });

    const run = await setup("hwpx", bytes);
    const read = (doc: RhwpDocument) => JSON.parse(doc.getEditableGroupChildren!(0, 0, 2));
    const svg = (doc: RhwpDocument) => {
      const shape = /<ellipse cx="([^"]+)" cy="([^"]+)" rx="([^"]+)" ry="([^"]+)" fill="#341260"/
        .exec((doc as RhwpDocument & { renderPageSvg(page: number): string }).renderPageSvg(0));
      expect(shape).not.toBeNull();
      return shape!.slice(1).map(Number);
    };
    try {
      const { doc, editor, pick, edit, confirm } = run;
      const group = pick(groupFrame(doc)).groupChildren!;
      const child = group.children[1]!;
      expect(child).toMatchObject({ x: 6500, y: 800, width: oldW, height: oldH, canResize: true });
      expect(boundaryGroupXml(doc.exportHwpx())).toEqual(sourceXml);
      const beforeSvg = svg(doc);
      const resize = { kind: "groupChildResize", index: 1, id: child.id, instId: child.instId } as const;

      if (label.startsWith("E8")) {
        // E13: no-op at the command and engine boundaries leaves history and publication intact.
        expectUnchangedRefusal(run, () => {
          expect(edit({ ...resize, width: oldW, height: oldH })).toBe(false);
          expect(() => doc.resizeGroupChild!(0, 0, 2, 1, child.id, child.instId, oldW, oldH)).toThrow();
        });
      }

      expect(edit({ ...resize, width, height })).toBe(true);
      await confirm();
      expect(read(doc)).toEqual({ ...group, children: [group.children[0], { ...child, width, height }] });
      expect(editor.snapshot().history).toMatchObject({ undo: true, redo: false });
      const afterSvg = svg(doc);
      const px = (hu: number) => hu * 96 / 7200;
      expect(afterSvg).toEqual([
        expect.closeTo(px(7000 + width / 2), 6), expect.closeTo(px(1300 + height / 2), 6),
        expect.closeTo(px(width / 2), 6), expect.closeTo(px(height / 2), 6),
      ]);
      if (width === oldW) expect([afterSvg[0], afterSvg[2]]).toEqual([beforeSvg[0], beforeSvg[2]]);
      if (height === oldH) expect([afterSvg[1], afterSvg[3]]).toEqual([beforeSvg[1], beforeSvg[3]]);
      const exported = doc.exportHwpxWithReport();
      try {
        const saved = exported.takeBytes();
        const expectedXml = {
          ...sourceXml, children: [rect, {
            ...ellipse, ...expectedGeometry(width, height, cx, cy),
            matrices: [[1, 0, 6500, 0, 1, 800], identityMatrix, identityMatrix, identityMatrix, identityMatrix],
          }],
        };
        expect(boundaryGroupXml(saved)).toEqual(expectedXml);
        expectReopenEvidence(doc, saved, exported.contentLoss());
        const reopened = new engine.HwpDocument(saved) as RhwpDocument;
        try {
          expect(read(reopened)).toEqual(read(doc));
          expect(svg(reopened)).toEqual(afterSvg);
          expect(boundaryGroupXml(reopened.exportHwpx())).toEqual(expectedXml);
        } finally { reopened.free(); }
        writeGroupBoundaryEvidence(label.split(" ")[0]!, bytes, saved, exported.contentLoss());
      } finally { exported.free(); }
    } finally { run.editor.dispose(); }
  });

  it("Stage 3-A P4.6 group child identity keeps independent IDs through save/reopen (I1-I9)", async () => {
    const cases = [
      { label: "I1", index: 0, source: [2112144572, 1038402749] },
      { label: "I2", index: 0, source: [0, 1] },
      { label: "I3", index: 1, source: [1, 0] },
      { label: "I2-omitted-id", index: 1, source: [null, 2] },
      { label: "I3-omitted-instid", index: 0, source: [2, null] },
      { label: "I4", index: 0, source: [0, 0] },
      { label: "I5", index: 0, source: [2112169928, 1038428105] },
      // The old fallback either merged or produced these pairs on reopen.
      { label: "I2-I3-distinct", index: 0, source: [0, 1], sibling: [1, 0] },
      { label: "A11-leading-zero", index: 0, source: ["0000", "0001"], numbers: [0, 1] },
      { label: "A12-sign-and-whitespace", index: 1, source: ["-00", "\t+0042\n"], numbers: [0, 42] },
      { label: "A13-u32-max", index: 0, source: ["4294967295", "0"], numbers: [4294967295, 0] },
      { label: "A9-equivalent-spellings", index: 0, source: ["0001", "2"], sibling: [1, 2], numbers: [1, 2] },
    ] as const;
    for (const { label, index, source, ...extra } of cases) {
      const bytes = withGroupChildIds(index, source, "sibling" in extra ? extra.sibling : null);
      const orig = boundaryGroupXml(bytes);
      const [id, instId] = "numbers" in extra ? extra.numbers : source.map(value => Number(value ?? 0)) as [number, number];
      const run = await setup("hwpx", bytes);
      try {
        const { doc, pick, edit, confirm } = run;
        const before = pick(groupFrame(doc)).groupChildren;
        const move = { kind: "groupChildMove", index, id, instId, x: 100, y: 150 } as const;
        if (label === "I4" || label === "I5" || label === "A9-equivalent-spellings") {
          if (label === "I4") expect(before?.children[index]).toMatchObject({ id: 0, instId: 0, canMove: false, canResize: false });
          else expect(before).toBeUndefined();
          expectGroupIdentityRefusal(run, index, id, instId, label);
          continue;
        }

        expect(before?.children[index], label).toMatchObject({ id, instId, canMove: true, canResize: true });
        if (label === "I1") {
          for (const owner of [
            { index, id: id + 1, instId }, { index, id, instId: instId + 1 }, { index: 1, id, instId },
          ]) expectGroupIdentityRefusal(run, owner.index, owner.id, owner.instId, label);
        }
        expect(edit(move), label).toBe(true);
        await confirm();
        if (label === "A12-sign-and-whitespace") expect(run.editor.roundTrip("hwpx")).toMatchObject({ passed: true });
        const exported = doc.exportHwpxWithReport();
        try {
          const saved = exported.takeBytes();
          const xml = boundaryGroupXml(saved);
          expect(xml.parent).toEqual(orig.parent);
          expect(xml.children.map(child => child.owner)).toEqual(orig.children.map(child => child.owner));
          expect(xml.children[1 - index]).toEqual(orig.children[1 - index]);
          expect(xml.children[index]).toMatchObject({ offset: [100, 150] });
          expectReopenEvidence(doc, saved, exported.contentLoss());
          const reopened = new engine.HwpDocument(saved) as RhwpDocument;
          try {
            const state = JSON.parse(reopened.getEditableGroupChildren!(0, 0, 2));
            const children = before!.children.map((child, at) => at === index ? { ...child, x: 100, y: 150 } : child);
            expect(state).toEqual({ ...before, children });
          } finally { reopened.free(); }
          writeGroupBoundaryEvidence(label, bytes, saved, exported.contentLoss());
        } finally { exported.free(); }
      } finally { run.editor.dispose(); }
    }
  });

  it("Stage 3-A P4.6 group child identity refuses malformed identifiers and preserves the source XML (A5-A8)", async () => {
    const cases = [
      { label: "A5-invalid-id", index: 0, source: ["invalid", 1], alias: [0, 1] },
      { label: "A6-invalid-instid", index: 1, source: [1, "invalid"], alias: [1, 0] },
      { label: "A7-negative", index: 0, source: ["-1", 1], alias: [0, 1] },
      { label: "A8-overflow", index: 1, source: [1, "4294967296"], alias: [1, 0] },
      { label: "A14-empty", index: 0, source: ["", 1], alias: [0, 1] },
      { label: "A15-fractional", index: 1, source: [1, "0.5"], alias: [1, 0] },
      { label: "A16-whitespace-only", index: 0, source: [" \t ", 1], alias: [0, 1] },
      { label: "A17-escaped-id", index: 0, source: ['a<&"\t', 1], alias: [0, 1] },
      { label: "A18-escaped-instid", index: 1, source: [1, 'a<&"\n'], alias: [1, 0] },
    ] as const;
    for (const { label, index, source, alias } of cases) {
      const bytes = withGroupChildIds(index, source);
      const xml = boundaryGroupXml(bytes);
      expect(xml.children[index]!.owner.slice(1), label).toEqual(source.map(String));
      const run = await setup("hwpx", bytes);
      try {
        const { doc, pick } = run;
        const group = pick(groupFrame(doc));
        expect(group.groupChildren, label).toBeUndefined();
        expect(group.operations, label).not.toContain("groupChildGeometry");
        expect(doc.getEditableGroupChildren!(0, 0, 2), label).toBe("null");
        expectGroupIdentityRefusal(run, index, ...alias, label);

        const exported = doc.exportHwpxWithReport();
        try {
          const saved = exported.takeBytes();
          expect(boundaryGroupXml(saved), label).toEqual(xml);
          expectReopenEvidence(doc, saved, exported.contentLoss());
          const reopened = new engine.HwpDocument(saved) as RhwpDocument;
          try {
            expect(reopened.getEditableGroupChildren!(0, 0, 2), label).toBe("null");
            expect(boundaryGroupXml(reopened.exportHwpx()), label).toEqual(xml);
          } finally { reopened.free(); }
          writeGroupBoundaryEvidence(label, bytes, saved, exported.contentLoss());
        } finally { exported.free(); }
      } finally { run.editor.dispose(); }
    }
  });

  it("Stage 3-A P4.6 group cloning keeps regenerated child IDs independent of source spelling", () => {
    const bytes = withGroupChildIds(0, ["invalid", 1]);
    const doc = new engine.HwpDocument(bytes) as RhwpDocument;
    try {
      expect(JSON.parse(doc.copyControl!(0, 0, "[]", 2))).toMatchObject({ ok: true });
      const { ok, paraIdx, controlIdx } = JSON.parse(doc.pasteControl!(0, 0, 0));
      expect(ok).toBe(true);
      const cloned = doc.getEditableGroupChildren!(0, paraIdx, controlIdx);
      expect(JSON.parse(cloned)?.children[0]).toMatchObject({ canMove: true, canResize: true });
      const saved = doc.exportHwpx();
      expect(boundaryGroupXml(saved).children[0]!.owner).toEqual(["rect", "invalid", "1"]);
      const reopened = new engine.HwpDocument(saved) as RhwpDocument;
      try {
        expect(reopened.getEditableGroupChildren!(0, 0, 2)).toBe("null");
        expect(reopened.getEditableGroupChildren!(0, paraIdx, controlIdx)).toBe(cloned);
      } finally { reopened.free(); }
    } finally { doc.free(); }
  });

  it("Stage 3-A P4.6 group refuses an externally incomplete nonidentity matrix pair without mutation", async () => {
    const bytes = patchGroupFixture(`
def incomplete(m):
    shape = m[0]
    shape, count = re.subn(r'<hc:rotMatrix [^>]*/>', '', shape)
    assert count == 1
    return shape.replace('<hc:scaMatrix e1="1"', '<hc:scaMatrix e1="2"')
xml, count = re.subn(r'<hp:rect .*?</hp:rect>', incomplete, xml, flags=re.S)
assert count == 1
`);
    expect(boundaryGroupXml(bytes).children[0]!.matrices).toEqual([identityMatrix, [2, 0, 0, 0, 1, 0]]);
    const run = await setup("hwpx", bytes);
    try {
      const { doc, pick, edit } = run;
      const children = pick(groupFrame(doc)).groupChildren!.children;
      const { id, instId } = children[0]!;
      expect(children[0]).toMatchObject({ canMove: false, canResize: false });
      expect(children[1]).toMatchObject({ canMove: true, canResize: true });
      // The parser fills the absent rotation with identity before constructing the buffer.
      expect(boundaryGroupXml(doc.exportHwpx()).children[0]!.matrices)
        .toEqual([identityMatrix, [2, 0, 0, 0, 1, 0], identityMatrix]);
      expectUnchangedRefusal(run, () => {
        expect(edit({ kind: "groupChildMove", index: 0, id, instId, x: 100, y: 150 })).toBe(false);
        expect(edit({ kind: "groupChildResize", index: 0, id, instId, width: 4000, height: 3000 })).toBe(false);
        expect(() => doc.moveGroupChild!(0, 0, 2, 0, id, instId, 100, 150)).toThrow();
        expect(() => doc.resizeGroupChild!(0, 0, 2, 0, id, instId, 4000, 3000)).toThrow();
      });
    } finally { run.editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("edits %s polygon and curve outer geometry, transforms, and deletion cleanly", async format => {
    const fixture = new engine.HwpDocument(source(format)) as RhwpDocument;
    let baseHwpx: Uint8Array;
    try {
      const created = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "polygon",
        width: 10800, height: 7200, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, created.controlIdx, '{"textWrap":"Square"}')))
        .toMatchObject({ ok: true });
      baseHwpx = fixture.exportHwpx();
    } finally { fixture.free(); }

    // Turn the polygon copy into a document holding BOTH an unlocked polygon and an unlocked curve.
    const tmpDir = mkdirSync(resolve("/tmp", `geul-p3-curve-${format}-${Date.now()}`), { recursive: true })!;
    const inZip = resolve(tmpDir, "in.hwpx");
    const outZip = resolve(tmpDir, "out.hwpx");
    writeFileSync(inZip, baseHwpx);
    const { execFileSync } = await import("node:child_process");
    execFileSync("python3", ["-c", `import sys, zipfile, re
with zipfile.ZipFile(sys.argv[1]) as zin:
    items = [(i.filename, zin.read(i.filename)) for i in zin.infolist()]
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as zout:
    for name, data in items:
        if name == 'Contents/section0.xml':
            xml = data.decode('utf-8')
            m = re.search(r'<hp:polygon\\b.*?</hp:polygon>', xml, re.S)
            assert m, 'missing polygon'
            poly = re.sub(r'zOrder="[^"]*"', 'zOrder="1"', m.group(0), count=1)
            curve = re.sub(r'^<hp:polygon\\b', '<hp:curve', poly, count=1)
            curve = re.sub(r'</hp:polygon>$', '</hp:curve>', curve, count=1)
            curve = re.sub(r'id="\\d+"', 'id="999001"', curve, count=1)
            curve = re.sub(r'zOrder="[^"]*"', 'zOrder="2"', curve, count=1)
            curve = re.sub(r'<hp:offset\\b[^>]*/>', '<hp:offset x="15000" y="0"/>', curve, count=1)
            segs = '<hp:seg type="CURVE" x1="0" y1="0" x2="10800" y2="7200"/><hp:seg type="CURVE" x1="10800" y1="7200" x2="0" y2="7200"/>'
            curve = re.sub(r'(?:<hc:pt\\b[^>]*/>)+', segs, curve, count=1)
            assert '<hp:seg ' in curve, 'failed to inject curve segs'
            xml = xml.replace(m.group(0), poly + curve, 1)
            data = xml.encode('utf-8')
        zout.writestr(name, data)
`, inZip, outZip]);
    const hwpxWithBoth = new Uint8Array(readFileSync(outZip));
    let bytes: Uint8Array;
    const converter = new engine.HwpDocument(hwpxWithBoth) as RhwpDocument;
    try {
      const gsoIndices = (JSON.parse(converter.getControls!()) as { list: number; para: number; ctrlId: string; controlIndex: number }[])
        .filter(c => c.list === 0 && c.para === 0 && c.ctrlId === "gso")
        .map(c => c.controlIndex);
      expect(gsoIndices).toHaveLength(2);
      expect(JSON.parse(converter.setShapeProperties!(0, 0, gsoIndices[1]!, '{"textWrap":"Square"}'))).toMatchObject({ ok: true });
      if (format === "hwp") {
        // Canonical HWP5 curve serialization writes `cnt - 1` segment_types when section raw_stream is rebuilt.
        const hwpOnce = converter.exportHwp();
        const canonical = new engine.HwpDocument(hwpOnce) as RhwpDocument;
        try {
          expect(JSON.parse(canonical.setShapeProperties!(0, 0, gsoIndices[1]!, '{"horzOffset":20000,"vertOffset":12000}'))).toMatchObject({ ok: true });
          bytes = canonical.exportHwp();
        } finally { canonical.free(); }
      } else {
        expect(JSON.parse(converter.setShapeProperties!(0, 0, gsoIndices[1]!, '{"horzOffset":20000,"vertOffset":12000}'))).toMatchObject({ ok: true });
        bytes = converter.exportHwpx();
      }
    } finally { converter.free(); }

    const { editor, doc, pick, edit, confirm, take } = await setup(format, bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      if (format === "hwp") {
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const frames = shapes(doc);
      expect(frames).toHaveLength(2);
      const polyIdx = frames[0]!.controlIdx;
      const curveIdx = frames[1]!.controlIdx;
      const frameOf = (index: number) => shapes(doc).find(f => f.controlIdx === index)!;
      for (const index of [polyIdx, curveIdx]) {
        const sel = pick(frameOf(index));
        expect(sel.operations).toEqual(expect.arrayContaining(["move", "resize", "delete", "wrap", "fill", "outline", "rotate", "zOrder"]));
      }

      // Edit curve geometry, rotation/flip, fill, and outline; verify exact preservation + Undo/Redo.
      pick(frameOf(curveIdx));
      const beforeCurve = props(doc, curveIdx);
      expect(edit({ kind: "bounds", width: 150, height: 90 })).toBe(true);
      await confirm();
      pick(frameOf(curveIdx));
      expect(edit({ kind: "nudge", dx: 12, dy: 8 })).toBe(true);
      await confirm();
      pick(frameOf(curveIdx));
      expect(edit({ kind: "rotate", degrees: 45, flipH: true, flipV: false })).toBe(true);
      await confirm();
      pick(frameOf(curveIdx));
      expect(edit({ kind: "fill", color: "2288CC" })).toBe(true);
      await confirm();
      pick(frameOf(curveIdx));
      expect(edit({ kind: "outline", color: "AA3311", width: 1.5 })).toBe(true);
      await confirm();

      const expectedCurve = {
        ...beforeCurve,
        width: 15000,
        height: 9000,
        horzOffset: beforeCurve.horzOffset + 1200,
        vertOffset: beforeCurve.vertOffset + 800,
        rotationAngle: 45,
        horzFlip: true,
        vertFlip: false,
        fillType: "solid",
        fillBgColor: 0xCC8822,
        borderColor: 0x1133AA,
        borderWidth: 150,
      };
      expect(props(doc, curveIdx)).toEqual(expectedCurve);

      // Edit polygon wrap cleanly, and verify geometry+transform+style+wrap save & reopen BEFORE layer reordering.
      pick(frameOf(polyIdx));
      expect(edit({ kind: "wrap", wrap: "topAndBottom" })).toBe(true);
      await confirm();

      expect(editor.undo()).toBe(true);
      await confirm();
      expect(editor.redo()).toBe(true);
      await confirm();

      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      const liveCurve = props(doc, curveIdx);
      expect(liveCurve).toMatchObject(expectedCurve);
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened, curveIdx)).toEqual(liveCurve);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p3-poly-curve-original.${format}`), bytes);
          writeFileSync(resolve(out, `p3-poly-curve-edited.${format}`), output);
          writeFileSync(resolve(out, `p3-poly-curve-report.${format}.json`), report);
        }
      } finally { exported.free(); }

      // Restore Square wrap plane so both shapes share one HWP drawing plane, then test zOrder front/undo.
      pick(frameOf(polyIdx));
      expect(edit({ kind: "wrap", wrap: "square" })).toBe(true);
      await confirm();
      pick(frameOf(polyIdx));
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      expect(editor.undo()).toBe(true);
      await confirm();

      // Delete the curve and verify Undo restores both shapes.
      pick(frameOf(curveIdx));
      expect(edit({ kind: "delete" })).toBe(true);
      await confirm();
      expect(shapes(doc)).toHaveLength(1);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(shapes(doc)).toHaveLength(2);
    } finally {
      editor.dispose();
    }
  });

  it.each(["hwp", "hwpx"] as const)("edits outer geometry, position, and wrap of an existing %s group while keeping children intact", async format => {
    const fixture = new engine.HwpDocument(source(format)) as RhwpDocument & {
      groupShapes(json: string): string;
    };
    let bytes: Uint8Array, groupControl: number;
    try {
      const rect = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "rectangle",
        width: 5000, height: 4000, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      const ell = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 3, shapeType: "ellipse",
        width: 5000, height: 4000, treatAsChar: false, textWrap: "Square", horzOffset: 6000, vertOffset: 1000,
      })));
      const grouped = JSON.parse(fixture.groupShapes(JSON.stringify({
        sectionIdx: 0,
        targets: [{ paraIdx: 0, controlIdx: rect.controlIdx }, { paraIdx: 0, controlIdx: ell.controlIdx }],
      })));
      expect(grouped).toMatchObject({ ok: true });
      groupControl = grouped.controlIdx;
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, groupControl, '{"textWrap":"Square","horzOffset":500,"vertOffset":500}'))).toMatchObject({ ok: true });
      bytes = format === "hwp" ? fixture.exportHwp() : fixture.exportHwpx();
    } finally { fixture.free(); }

    const { editor, doc, edit, confirm, take } = await setup(format, bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      if (format === "hwp") {
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const groupFrame = () => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      const pickGroup = () => {
        const frame = groupFrame();
        expect(frame).toBeDefined();
        expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
        return editor.objectSelection!;
      };
      const sel = pickGroup();
      expect(sel.kind).toBe("group");
      expect(sel.operations).toContain("move");
      expect(sel.operations).toContain("resize");
      expect(sel.operations).toContain("wrap");
      expect(sel.operations).toContain("delete");

      const before = props(doc, groupControl);
      expect(edit({ kind: "bounds", x: sel.frame.x, y: sel.frame.y - 10, width: 110, height: 60 })).toBe(false);
      expect(props(doc, groupControl)).toEqual(before);
      expect(editor.snapshot().history?.undo).toBe(false);
      expect(edit({ kind: "bounds", width: 160, height: 80 })).toBe(true);
      await confirm();
      pickGroup();
      expect(edit({ kind: "nudge", dx: 10, dy: 5 })).toBe(true);
      await confirm();
      pickGroup();
      expect(edit({ kind: "wrap", wrap: "topAndBottom" })).toBe(true);
      await confirm();

      const expected = {
        ...before,
        width: 16000,
        height: 8000,
        horzOffset: before.horzOffset + 1000,
        vertOffset: before.vertOffset + 500,
        textWrap: "TopAndBottom",
      };
      expect(props(doc, groupControl)).toEqual(expected);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(props(doc, groupControl).textWrap).toBe("Square");
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(props(doc, groupControl)).toEqual(expected);

      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened, groupControl)).toEqual(expected);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p3-group-original.${format}`), bytes);
          writeFileSync(resolve(out, `p3-group-edited.${format}`), output);
          writeFileSync(resolve(out, `p3-group-report.${format}.json`), report);
        }
      } finally { exported.free(); }

      if (format === "hwpx") {
        pickGroup();
        expect(edit({ kind: "delete" })).toBe(true);
        await confirm();
        expect(JSON.parse(doc.getPageControlLayout!(0)).controls.some((c: { type: string }) => c.type === "group")).toBe(false);
        expect(editor.undo()).toBe(true);
        await confirm();
        expect(groupFrame()).toBeDefined();
      } else {
        const locks = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
        expect(JSON.parse(locks.setControlLock(0, groupControl, true))).toMatchObject({ ok: true });
        expect(pickGroup().operations).toEqual(["deselect"]);
        expect(edit({ kind: "bounds", width: 120, height: 60 })).toBe(false);
      }
    } finally { editor.dispose(); }
  });

  it("B2.2: safely deletes flat HWP5 group containers with shared BinData preservation and refuses unsafe groups", async () => {
    const samplePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
    const buildFlatGroupFixture = (opts?: { captioned?: boolean; nested?: boolean; locked?: boolean }) => {
      const fixture = new engine.HwpDocument(source("hwp")) as RhwpDocument & {
        groupShapes(json: string): string;
        setControlLock(para: number, index: number, locked: boolean): string;
      };
      try {
        // Surviving standalone picture sharing the same PNG image bytes/BinData.
        const survivorPic = JSON.parse(fixture.insertPicture!(0, 0, 2, "[]", samplePng, 3600, 2400, 10, 10, "png", "survivor-pic"));
        expect(survivorPic).toMatchObject({ ok: true });
        expect(JSON.parse(fixture.setPictureProperties!(0, 0, survivorPic.controlIdx, JSON.stringify({
          textWrap: "Square", horzOffset: 500, vertOffset: 6500,
        })))).toMatchObject({ ok: true });

        // Children for flat group: rectangle + picture sharing samplePng.
        const rect = JSON.parse(fixture.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 4, shapeType: "rectangle",
          width: 4800, height: 3200, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
        })));
        const childPic = JSON.parse(fixture.insertPicture!(0, 0, 5, "[]", samplePng, 3200, 2400, 10, 10, "png", "child-pic"));
        expect(childPic).toMatchObject({ ok: true });
        expect(JSON.parse(fixture.setPictureProperties!(0, 0, childPic.controlIdx, JSON.stringify({
          textWrap: "Square", horzOffset: 5500, vertOffset: 400,
        })))).toMatchObject({ ok: true });

        const grouped = JSON.parse(fixture.groupShapes(JSON.stringify({
          sectionIdx: 0,
          targets: [{ paraIdx: 0, controlIdx: rect.controlIdx }, { paraIdx: 0, controlIdx: childPic.controlIdx }],
        })));
        expect(grouped).toMatchObject({ ok: true });
        let targetCtrl = grouped.controlIdx as number;
        expect(JSON.parse(fixture.setShapeProperties!(0, 0, targetCtrl, '{"textWrap":"Square","horzOffset":500,"vertOffset":500}'))).toMatchObject({ ok: true });

        if (opts?.nested) {
          const extra = JSON.parse(fixture.createShapeControl!(JSON.stringify({
            sectionIdx: 0, paraIdx: 0, charOffset: 6, shapeType: "ellipse",
            width: 3000, height: 2000, treatAsChar: false, textWrap: "Square", horzOffset: 1000, vertOffset: 1000,
          })));
          const nested = JSON.parse(fixture.groupShapes(JSON.stringify({
            sectionIdx: 0,
            targets: [{ paraIdx: 0, controlIdx: targetCtrl }, { paraIdx: 0, controlIdx: extra.controlIdx }],
          })));
          expect(nested).toMatchObject({ ok: true });
          targetCtrl = nested.controlIdx;
        }
        if (opts?.captioned) {
          expect(JSON.parse(fixture.setShapeProperties!(0, 0, targetCtrl, '{"hasCaption":true,"captionDirection":"Bottom"}'))).toMatchObject({ ok: true });
        }
        if (opts?.locked) {
          expect(JSON.parse(fixture.setControlLock(0, targetCtrl, true))).toMatchObject({ ok: true });
        }
        return fixture.exportHwp();
      } finally { fixture.free(); }
    };

    // 1. Positive: flat HWP5 group (rect + picture) deleted cleanly, Undo/Redo works, surviving picture preserved.
    const bytes = buildFlatGroupFixture();
    const { editor, doc, edit, confirm, take } = await setup("hwp", bytes);
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();

      const groupFrame = () => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group");
      const picFrames = () => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).filter(c => c.type === "image");
      expect(groupFrame()).toBeDefined();
      expect(picFrames()).toHaveLength(1);
      const frame = groupFrame()!;
      expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
      const sel = editor.objectSelection!;
      expect(sel.kind).toBe("group");
      expect(sel.operations).toContain("delete");

      expect(edit({ kind: "delete" })).toBe(true);
      await confirm();
      expect(groupFrame()).toBeUndefined();
      expect(picFrames()).toHaveLength(1);
      expect(editor.objectSelection).toBeNull();

      // Undo restores group & children; Redo deletes again cleanly.
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(groupFrame()).toBeDefined();
      expect(picFrames()).toHaveLength(1);

      expect(editor.redo()).toBe(true);
      await confirm();
      expect(groupFrame()).toBeUndefined();
      expect(picFrames()).toHaveLength(1);

      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        editor.save();
        await flush();
        take("save").reply(ok({ durable: true }));
        await flush();

        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument & {
          getControlImageData(section: number, para: number, cellPathJson: string, control: number): Uint8Array;
        };
        try {
          const rGroups = (JSON.parse(reopened.getPageControlLayout!(0)).controls as Frame[]).filter(c => c.type === "group");
          const rPics = (JSON.parse(reopened.getPageControlLayout!(0)).controls as Frame[]).filter(c => c.type === "image");
          expect(rGroups).toHaveLength(0);
          expect(rPics).toHaveLength(1);
          expect(Buffer.from(reopened.getControlImageData(0, 0, "[]", rPics[0]!.controlIdx))).toEqual(samplePng);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "b2-2-group-delete-original.hwp"), bytes);
          writeFileSync(resolve(out, "b2-2-group-delete-edited.hwp"), output);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }

    // 2. Negative refusals: nested group, captioned group, and locked group cannot be deleted.
    for (const [label, opts] of [
      ["nested", { nested: true }],
      ["captioned", { captioned: true }],
      ["locked", { locked: true }],
    ] as const) {
      const unsafeBytes = buildFlatGroupFixture(opts);
      const { editor: uEd, doc: uDoc, edit: uEdit } = await setup("hwp", unsafeBytes);
      try {
        const gf = (JSON.parse(uDoc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group");
        if (gf) {
          uEd.pointAt(0, gf.x + gf.w / 2, gf.y + gf.h / 2, false, false, true);
          expect(uEd.objectSelection?.operations ?? [], `${label} group must refuse delete`).not.toContain("delete");
        }
        expect(uEdit({ kind: "delete" }), `${label} group delete edit must fail`).toBe(false);
      } finally { uEd.dispose(); }
    }
  });

  it("reorders existing HWP basic shapes without moving their anchors", async () => {
    const fixture = new engine.HwpDocument(source("hwp")) as RhwpDocument;
    let bytes: Uint8Array;
    try {
      for (const [i, shapeType] of ["rectangle", "ellipse"].entries()) {
        const added = JSON.parse(fixture.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 2 + i, shapeType, width: 10800, height: 7200,
          treatAsChar: false, textWrap: "Square", horzOffset: i * 4000, vertOffset: i * 2000,
        })));
        expect(JSON.parse(fixture.setShapeProperties!(0, 0, added.controlIdx, '{"textWrap":"Square"}'))).toMatchObject({ ok: true });
      }
      bytes = fixture.exportHwp();
    } finally { fixture.free(); }
    const { editor, doc, pick, edit, confirm, take, calls } = await setup("hwp", bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const [first, second] = shapes(doc) as [Frame, Frame];
      const a = props(doc, first.controlIdx), b = props(doc, second.controlIdx);
      const overlap = [first.x + first.w - 10, first.y + first.h - 10] as const;
      const top = () => {
        expect(editor.pointAt(0, ...overlap, false, false, true)).toBe(true);
        return editor.objectSelection?.address.path;
      };
      expect(top()).toEqual([0, 0, second.controlIdx]);
      expect(editor.objectSelection!.operations).toContain("zOrder");
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      const lowered = { ...b, zOrder: a.zOrder - 1 };
      expect(props(doc, second.controlIdx)).toEqual(lowered);
      expect(props(doc, first.controlIdx)).toEqual(a);
      expect(top()).toEqual([0, 0, first.controlIdx]);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(top()).toEqual([0, 0, second.controlIdx]);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(top()).toEqual([0, 0, first.controlIdx]);
      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened, first.controlIdx)).toEqual(a);
          expect(props(reopened, second.controlIdx)).toEqual(lowered);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p3-layer-original.hwp"), bytes);
          writeFileSync(resolve(out, "p3-layer-edited.hwp"), output);
          writeFileSync(resolve(out, "p3-layer-report.json"), report);
        }
      } finally { exported.free(); }
      const exposed = shapes(doc).find(frame => frame.controlIdx === second.controlIdx)!;
      expect(editor.pointAt(0, exposed.x + exposed.w - 4, exposed.y + exposed.h - 4, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);
      expect(edit({ kind: "layer", front: false })).toBe(false);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      expect(top()).toEqual([0, 0, second.controlIdx]);
      const owner = pick(second);
      const lock = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
      expect(JSON.parse(lock.setControlLock(0, first.controlIdx, true))).toMatchObject({ ok: true });
      expect(editor.execute("object.edit", objectEditRequest(owner, { kind: "layer", front: false })).accepted).toBe(false);
    } finally { editor.dispose(); }
  });

  it("reorders multiple HWP basic shapes in one save with undo/redo and reopen", async () => {
    const fixture = new engine.HwpDocument(source("hwp")) as RhwpDocument;
    let bytes: Uint8Array;
    try {
      for (const [i, shapeType] of ["rectangle", "ellipse", "rectangle"].entries()) {
        const added = JSON.parse(fixture.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 2 + i, shapeType, width: 10800, height: 7200,
          treatAsChar: false, textWrap: "Square", horzOffset: i * 1500, vertOffset: i * 1000,
        })));
        expect(JSON.parse(fixture.setShapeProperties!(0, 0, added.controlIdx, '{"textWrap":"Square"}'))).toMatchObject({ ok: true });
      }
      bytes = fixture.exportHwp();
    } finally { fixture.free(); }

    const { editor, doc, pick, edit, confirm, take } = await setup("hwp", bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();

      const all = shapes(doc);
      expect(all).toHaveLength(3);
      const [first, second, third] = all as [Frame, Frame, Frame];
      const beforeA = props(doc, first.controlIdx);
      const beforeB = props(doc, second.controlIdx);
      const beforeC = props(doc, third.controlIdx);
      const commonOverlap = [third.x + 10, third.y + 10] as const;
      const topAt = (pt: readonly [number, number]) => {
        expect(editor.pointAt(0, pt[0], pt[1], false, false, true)).toBe(true);
        return editor.objectSelection?.address.path;
      };
      // Initially: third > second > first
      expect(topAt(commonOverlap)).toEqual([0, 0, third.controlIdx]);

      // Move third (top) to back -> zOrder < first.zOrder
      pick(third);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, third.controlIdx]);
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      const zThirdBack = props(doc, third.controlIdx).zOrder as number;
      expect(zThirdBack).toBe(beforeA.zOrder - 1);

      // Move first (hit its exposed top-left corner) to front -> zOrder > second.zOrder
      expect(editor.pointAt(0, first.x + 2, first.y + 2, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, first.controlIdx]);
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      const zFirstFront = props(doc, first.controlIdx).zOrder as number;
      expect(zFirstFront).toBe(beforeB.zOrder + 1);

      // Move second (hit its exposed top-right strip above third and right of first) to front -> zOrder > first's new zOrder
      expect(editor.pointAt(0, second.x + second.w - 3, second.y + 2, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      const zSecondFront = props(doc, second.controlIdx).zOrder as number;
      expect(zSecondFront).toBe(zFirstFront + 1);
      expect(topAt(commonOverlap)).toEqual([0, 0, second.controlIdx]);

      // Undo -> first returns to top; Redo -> second returns to top
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(topAt(commonOverlap)).toEqual([0, 0, first.controlIdx]);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(topAt(commonOverlap)).toEqual([0, 0, second.controlIdx]);

      // Geometry, fill, outline, and anchors stay identical; only zOrder changed.
      expect(props(doc, first.controlIdx)).toEqual({ ...beforeA, zOrder: zFirstFront });
      expect(props(doc, second.controlIdx)).toEqual({ ...beforeB, zOrder: zSecondFront });
      expect(props(doc, third.controlIdx)).toEqual({ ...beforeC, zOrder: zThirdBack });

      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened, first.controlIdx)).toEqual({ ...beforeA, zOrder: zFirstFront });
          expect(props(reopened, second.controlIdx)).toEqual({ ...beforeB, zOrder: zSecondFront });
          expect(props(reopened, third.controlIdx)).toEqual({ ...beforeC, zOrder: zThirdBack });
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "b1-1-multi-layer-original.hwp"), bytes);
          writeFileSync(resolve(out, "b1-1-multi-layer-edited.hwp"), output);
        }
      } finally { exported.free(); }

      // Locked shape participation still fails closed without partial commit.
      const lock = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
      expect(JSON.parse(lock.setControlLock(0, third.controlIdx, true))).toMatchObject({ ok: true });
      const selFirst = pick(first);
      expect(editor.execute("object.edit", objectEditRequest(selFirst, { kind: "layer", front: false })).accepted).toBe(false);
    } finally { editor.dispose(); }
  });

  it("saves a newly inserted HWP rectangle with an edited outline width", async () => {
    const { editor, doc, bytes, take, confirm, pick, edit } = await setup("hwp");
    try {
      const original = hwpReopenModel(doc);
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(true);
      await confirm();
      const frame = shapes(doc)[0]!;
      const before = props(doc, frame.controlIdx);
      expect(pick(frame).shape?.outlineWidthEditable).toBe(true);
      expect(edit({ kind: "outline", color: "000000", width: 2.45 })).toBe(true);
      await confirm();
      const expected = { ...before, borderWidth: 245 };
      expect(props(doc, frame.controlIdx)).toEqual(expected);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(props(doc, frame.controlIdx)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      const exported = doc.exportHwpWithReport();
      try {
        const edited = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(doc, edited, report);
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), original.structure)).toBe(true);
          expect(props(reopened, frame.controlIdx)).toEqual(expected);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "combined-outline-original.hwp"), bytes);
          writeFileSync(resolve(out, "combined-outline-edited.hwp"), edited);
          writeFileSync(resolve(out, "combined-outline-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("persists an existing %s solid outline width", async format => {
    const originalDoc = new engine.HwpDocument(source(format)) as RhwpDocument;
    let original: Uint8Array;
    try {
      const created = JSON.parse(originalDoc.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: "rectangle", width: 10800, height: 7200,
        treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      expect(JSON.parse(originalDoc.setShapeProperties!(0, 0, created.controlIdx, '{"textWrap":"Square"}'))).toMatchObject({ ok: true });
      original = format === "hwp" ? originalDoc.exportHwp() : originalDoc.exportHwpx();
    } finally { originalDoc.free(); }

    const { editor, doc, pick, edit, confirm, take } = await setup(format, original);
    try {
      if (format === "hwp") {
        take("original").reply(ok(original));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const frame = shapes(doc)[0]!, before = props(doc, frame.controlIdx);
      expect(pick(frame).shape?.outlineWidthEditable).toBe(true);
      expect(edit({ kind: "outline", color: "000000", width: 0 })).toBe(false);
      expect(edit({ kind: "outline", color: "000000", width: 2.45 })).toBe(true);
      await confirm();
      expect(props(doc, frame.controlIdx)).toEqual({ ...before, borderWidth: 245 });
      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(props(reopened, frame.controlIdx)).toEqual({ ...before, borderWidth: 245 }); }
        finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p3-width-original.${format}`), original);
          writeFileSync(resolve(out, `p3-width-edited.${format}`), output);
          writeFileSync(resolve(out, `p3-width-${format}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("resizes an %s table-cell picture through its owned layout path", async format => {
    const docSource = new engine.HwpDocument(source(format)) as RhwpDocument;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
    const table = JSON.parse(docSource.createTable!(0, 0, 1, 1, 2));
    const host = table.paraIdx as number, control = table.controlIdx as number;
    const path = JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]);
    let bytes: Uint8Array;
    try {
      docSource.insertTextInCell(0, host, control, 0, 0, 0, "owned cell");
      docSource.insertTextInCell(0, host, control, 1, 0, 0, "sibling");
      expect(JSON.parse(docSource.insertPictureInCellByPath!(0, host, path, 2, png, 3600, 4800, 48, 64, "png", ""))).toMatchObject({ ok: true, controlIdx: 0 });
      bytes = format === "hwp" ? docSource.exportHwp() : docSource.exportHwpx();
    } finally { docSource.free(); }

    const { editor, doc, confirm, take } = await setup(format, bytes);
    const picture = (file: RhwpDocument) => JSON.parse(file.getCellPictureByPath!(0, host, path, 0));
    try {
      const baseline = format === "hwp" ? hwpReopenModel(doc) : null;
      if (baseline) {
        expect(baseline.complete).toBe(true);
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const before = picture(doc);
      const frame = JSON.parse(doc.getPageControlLayout!(0)).controls.find((item: Frame) => item.type === "image");
      expect(frame).toBeDefined();
      expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
      const selected = editor.objectSelection!;
      expect(selected.operations).toEqual(
        format === "hwpx" ? ["deselect", "resize", "delete", "crop", "altText"] : ["deselect", "resize"],
      );
      expect(editor.execute("object.edit", objectEditRequest(selected, { kind: "bounds", width: 42, height: 42 })).accepted).toBe(true);
      await confirm();
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();

      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          if (baseline) {
            expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          }
          expect(picture(reopened)).toEqual({ ...before, width: 4200, height: 4200 });
          expect(reopened.getTextInCell(0, host, control, 0, 0, 0, 10)).toBe("owned cell");
          expect(reopened.getTextInCell(0, host, control, 1, 0, 0, 7)).toBe("sibling");
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p2-cell-picture-original.${format}`), bytes);
          writeFileSync(resolve(out, `p2-cell-picture-edited.${format}`), output);
          writeFileSync(resolve(out, `p2-cell-picture-${format}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("resizes a depth-2 nested %s table-cell picture through its multi-level owned layout path", async format => {
    const docSource = new engine.HwpDocument(source(format)) as RhwpDocument;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
    const outer = JSON.parse(docSource.createTable!(0, 0, 1, 1, 2));
    const host = outer.paraIdx as number, outerCtrl = outer.controlIdx as number;
    const cell0Path = JSON.stringify([{ controlIndex: outerCtrl, cellIndex: 0, cellParaIndex: 0 }]);
    const inner = JSON.parse(docSource.createTableInCellByPath!(0, host, cell0Path, 0, 1, 2));
    const innerCtrl = inner.controlIdx as number;
    const nestedPath = JSON.stringify([
      { controlIndex: outerCtrl, cellIndex: 0, cellParaIndex: 0 },
      { controlIndex: innerCtrl, cellIndex: 0, cellParaIndex: 0 },
    ]);
    let bytes: Uint8Array;
    try {
      docSource.insertTextInCellByPath!(0, host, nestedPath, 0, "deep cell");
      docSource.insertTextInCell(0, host, outerCtrl, 1, 0, 0, "outer sibling");
      expect(JSON.parse(docSource.insertPictureInCellByPath!(0, host, nestedPath, 2, png, 3000, 2400, 48, 64, "png", ""))).toMatchObject({ ok: true, controlIdx: 0 });
      bytes = format === "hwp" ? docSource.exportHwp() : docSource.exportHwpx();
    } finally { docSource.free(); }

    const { editor, doc, confirm, take } = await setup(format, bytes);
    const picture = (file: RhwpDocument) => JSON.parse(file.getCellPictureByPath!(0, host, nestedPath, 0));
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      if (format === "hwp") {
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const before = picture(doc);
      const frame = JSON.parse(doc.getPageControlLayout!(0)).controls.find((item: Frame) => item.type === "image");
      expect(frame).toBeDefined();
      expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
      const selected = editor.objectSelection!;
      expect(selected.operations).toEqual(
        format === "hwpx" ? ["deselect", "resize", "delete", "crop", "altText"] : ["deselect", "resize"],
      );
      expect(editor.execute("object.edit", objectEditRequest(selected, { kind: "bounds", width: 42, height: 36 })).accepted).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual({ ...before, width: 4200, height: 3600 });
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual({ ...before, width: 4200, height: 3600 });

      const exported = format === "hwp" ? doc.exportHwpWithReport!() : doc.exportHwpxWithReport!();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(picture(reopened)).toEqual({ ...before, width: 4200, height: 3600 });
          expect(reopened.getTextInCellByPath!(0, host, nestedPath, 0, 9)).toBe("deep cell");
          expect(reopened.getTextInCell(0, host, outerCtrl, 1, 0, 0, 13)).toBe("outer sibling");
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p2-nested-cell-picture-original.${format}`), bytes);
          writeFileSync(resolve(out, `p2-nested-cell-picture-edited.${format}`), output);
          writeFileSync(resolve(out, `p2-nested-cell-picture-${format}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("edits crop, altText, and deletion on an HWPX table-cell picture with undo, redo, and reopen", async () => {
    const docSource = new engine.HwpDocument(source("hwpx")) as RhwpDocument;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
    const table = JSON.parse(docSource.createTable!(0, 0, 1, 1, 2));
    const host = table.paraIdx as number, control = table.controlIdx as number;
    const path = JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]);
    let bytes: Uint8Array;
    try {
      docSource.insertTextInCell(0, host, control, 0, 0, 0, "hwpx cell");
      expect(JSON.parse(docSource.insertPictureInCellByPath!(0, host, path, 2, png, 3600, 4800, 48, 64, "png", ""))).toMatchObject({ ok: true, controlIdx: 0 });
      bytes = docSource.exportHwpx();
    } finally { docSource.free(); }

    const { editor, doc, confirm } = await setup("hwpx", bytes);
    const props = (d: RhwpDocument) => JSON.parse(d.getCellPicturePropertiesByPath!(0, host, path, 0));
    const imageFrame = () => JSON.parse(doc.getPageControlLayout!(0)).controls.find((item: Frame) => item.type === "image") as Frame | undefined;
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      const selectCellPic = () => {
        const frame = imageFrame()!;
        expect(frame).toBeDefined();
        expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
        return editor.objectSelection!;
      };
      expect(editor.execute("object.edit", objectEditRequest(selectCellPic(), { kind: "altText", text: "셀 그림 설명" })).accepted).toBe(true);
      await confirm();
      expect(editor.execute("object.edit", objectEditRequest(selectCellPic(), { kind: "crop", left: 0.1, top: 0, right: 0.2, bottom: 0 })).accepted).toBe(true);
      await confirm();
      expect(props(doc)).toMatchObject({ description: "셀 그림 설명" });
      expect(props(doc).cropLeft).toBeGreaterThan(0);

      const exportedEdited = doc.exportHwpxWithReport!();
      try {
        const editedBytes = exportedEdited.takeBytes();
        expect(JSON.parse(exportedEdited.contentLoss())).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(editedBytes) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened)).toMatchObject({ description: "셀 그림 설명", cropLeft: props(doc).cropLeft, cropRight: props(doc).cropRight });
        } finally { reopened.free(); }
      } finally { exportedEdited.free(); }

      expect(editor.execute("object.edit", objectEditRequest(selectCellPic(), { kind: "delete" })).accepted).toBe(true);
      await confirm();
      expect(imageFrame()).toBeUndefined();
      const exportedDeleted = doc.exportHwpxWithReport!();
      try {
        const deletedBytes = exportedDeleted.takeBytes();
        expect(JSON.parse(exportedDeleted.contentLoss())).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(deletedBytes) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(JSON.parse(reopened.getPageControlLayout!(0)).controls.some((c: { type: string }) => c.type === "image")).toBe(false);
        } finally { reopened.free(); }
      } finally { exportedDeleted.free(); }

      expect(editor.undo()).toBe(true);
      await confirm();
      expect(imageFrame()).toBeDefined();
      expect(props(doc)).toMatchObject({ description: "셀 그림 설명" });
    } finally { editor.dispose(); }
  });

  it("requires an explicit HWP GSO unlock and preserves independent size protection", async () => {
    const { editor, doc, bytes, take, confirm, pick, edit, calls } = await setup("hwp");
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(true);
      await confirm();
      const frame = shapes(doc)[0]!, index = frame.controlIdx;
      const inventory = doc.getControls!.bind(doc);
      const lock = (locked: boolean) => {
        const controls = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
        expect(JSON.parse(controls.setControlLock(0, index, locked))).toMatchObject({ ok: true });
      };
      expect(JSON.parse(inventory()).find((c: { controlIndex: number }) => c.controlIndex === index)?.props.Lock).toBe(0);
      expect(pick(frame).operations).toContain("resize");
      lock(true);
      expect(JSON.parse(inventory()).find((c: { controlIndex: number }) => c.controlIndex === index)?.props.Lock).toBe(1);
      expect(edit({ kind: "bounds", width: 90, height: 60 })).toBe(false);
      expect(pick(frame).operations).toEqual(["deselect"]);
      lock(false);
      for (const props of [undefined, {}, { Lock: 2 }, { Lock: false }, { Lock: "0" }]) {
        expect(pick(frame).operations).toContain("outline");
        doc.getControls = () => JSON.stringify(JSON.parse(inventory()).map((c: { ctrlId: string }) =>
          c.ctrlId === "gso" ? { ...c, props } : c));
        expect(edit({ kind: "outline", color: "333333" })).toBe(false);
        expect(pick(frame).operations).toEqual(["deselect"]);
        doc.getControls = inventory;
      }
      expect(JSON.parse(doc.setShapeProperties!(0, 0, index, '{"sizeProtect":true}'))).toMatchObject({ ok: true });
      expect(props(doc, index).sizeProtect).toBe(true);
      const protectedFrame = shapes(doc)[0]!;
      expect(pick(protectedFrame).operations).toContain("outline");
      expect(editor.objectSelection!.operations).not.toContain("resize");
      expect(edit({ kind: "bounds", width: 90, height: 60 })).toBe(false);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
      expect(edit({ kind: "outline", color: "333333" })).toBe(true);
      await confirm();
    } finally { editor.dispose(); }
  });

  it("binds delayed text-box IME commits to one live owner", async () => {
    const { editor, doc, confirm, calls } = await setup("hwpx");
    try {
      for (let i = 0; i < 2; i++) {
        expect(editor.execute("insert.textBox").accepted).toBe(true);
        await confirm();
      }
      const [first, second] = shapes(doc).map(frame => frame.controlIdx);
      const moveToBox = (index: number) => {
        const cursor = JSON.parse(doc.getCursorRectInCell(0, 0, index, 0, 0, 0));
        expect(editor.pointAt(cursor.pageIndex, cursor.x + 1, cursor.y + cursor.height / 2, false)).toBe(true);
      };
      const contents = (index: number) =>
        doc.getTextInCell(0, 0, index, 0, 0, 0, doc.getCellParagraphLength(0, 0, index, 0, 0));
      const ime = new ImeInput(editor);
      moveToBox(first!);
      ime.pointerDown();
      moveToBox(second!);
      ime.input("한", "insertFromComposition", false);
      ime.compositionEnd("한");
      ime.compositionEnd("한");
      await confirm();
      expect(contents(first!)).toBe("한");
      expect(contents(second!)).toBe("");
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(contents(first!)).toBe("");
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(contents(first!)).toBe("한");

      moveToBox(first!);
      const lockedTarget = editor.markCaret();
      moveToBox(second!);
      const locks = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
      expect(JSON.parse(locks.setControlLock(0, first!, true))).toMatchObject({ ok: true });
      const beforeRefusal = editor.localRevision;
      expect(editor.insertCommittedAt(lockedTarget, "글")).toBe(false);
      expect(contents(first!)).toBe("한");
      expect(contents(second!)).toBe("");

      const cancelled = new ImeInput(editor);
      cancelled.pointerDown();
      cancelled.compositionEnd("");
      expect(editor.localRevision).toBe(beforeRefusal);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);

      const staleTarget = editor.markCaret();
      expect(editor.typeText("새")).toBe(true);
      await confirm();
      expect(editor.insertCommittedAt(staleTarget, "옛")).toBe(false);
      expect(contents(second!)).toBe("새");

      moveToBox(second!);
      const removedTarget = editor.markCaret();
      {
        const frame = shapes(doc).find(item => item.controlIdx === second)!;
        expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
        expect(editor.execute("object.edit", objectEditRequest(editor.objectSelection!, { kind: "delete" })).accepted).toBe(true);
        await confirm();
      }
      expect(editor.insertCommittedAt(removedTarget, "옛")).toBe(false);
      expect(shapes(doc).map(frame => frame.controlIdx)).toHaveLength(1);

      const finalTarget = editor.markCaret();
      const other = await setup("hwpx");
      try { expect(other.editor.insertCommittedAt(finalTarget, "옛")).toBe(false); }
      finally { other.editor.dispose(); }
      editor.dispose();
      expect(editor.insertCommittedAt(finalTarget, "옛")).toBe(false);
    } finally { editor.dispose(); }
  });

  it("Stage 3-A P6 transfers a proven closed HWPX polygon across documents", async () => {
    const input = source("hwpx");
    const fixture = new engine.HwpDocument(input) as RhwpDocument;
    let bytes: Uint8Array, control: number;
    const points = [{ x: 1601, y: 1302 }, { x: 9703, y: 705 }, { x: 6404, y: 6506 }, { x: 1601, y: 1302 }];
    try {
      const created = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "polygon",
        width: 10800, height: 7200, treatAsChar: true, textWrap: "Square", polygonPoints: points,
      })));
      control = created.controlIdx;
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, control,
        '{"lineType":0,"borderWidth":0,"borderColor":0,"fillType":"solid","fillBgColor":7807556,"description":"Portable polygon"}')).ok).toBe(true);
      bytes = fixture.exportHwpx();
    } finally { fixture.free(); }
    const destination = new engine.HwpDocument(input) as RhwpDocument;
    let destinationBytes: Uint8Array, sibling: number;
    try {
      const shape = JSON.parse(destination.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: "rectangle", width: 3000, height: 2400,
        treatAsChar: true, textWrap: "Square",
      })));
      expect(shape.ok).toBe(true);
      sibling = shape.controlIdx;
      destinationBytes = destination.exportHwpx();
    } finally { destination.free(); }
    const from = await setup("hwpx", bytes), to = await setup("hwpx", destinationBytes);
    const owns = () => true;
    let data = "", plain = "";
    const clip: PlainClipboard = {
      readText: async () => plain, writeText: async text => { plain = text; data = ""; },
      readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? data : null,
      writeStructured: async (mime, payload, text) => {
        expect(mime).toBe(OBJECT_CLIPBOARD_MIME); data = payload; plain = text;
      },
    };
    try {
      const original = from.doc.exportHwpx();
      const originalDestination = to.doc.exportHwpx();
      const siblingProperties = props(to.doc, sibling);
      from.pick(shapes(from.doc)[0]!);
      expect(await from.editor.executeClipboard("edit.copy", owns, clip)).toBe(true);
      const payload = parseObjectClipboardPayload(data);
      expect(payload).toMatchObject({ version: 3, sourceFormat: "hwpx", object: "shape",
        portable: { shapeType: "polygon", polygonPoints: points, borderWidth: 0, lineType: 0 } });
      const validData = data;
      const invalid = JSON.parse(validData);
      invalid.portable.polygonPoints[3].x += 1;
      data = JSON.stringify(invalid);
      expect(await to.editor.executeClipboard("edit.paste", owns, clip)).toBe(false);
      expect(to.doc.exportHwpx()).toEqual(originalDestination);
      expect(to.editor.snapshot().history?.undo).toBe(false);
      data = validData;
      expect(await to.editor.executeClipboard("edit.paste", owns, clip)).toBe(true);
      await to.confirm();
      const index = shapes(to.doc).find(frame => frame.controlIdx !== sibling)!.controlIdx;
      const getPath = (document: RhwpDocument, ctrl: number) => JSON.parse(document.getEditableShapePath!(0, 0, ctrl));
      expect(getPath(to.doc, index)).toEqual(getPath(from.doc, control));
      expect(props(to.doc, index).instanceId).not.toBe(props(from.doc, control).instanceId);
      expect(props(to.doc, index).instanceId).not.toBe(siblingProperties.instanceId);
      expect(props(to.doc, sibling)).toEqual(siblingProperties);
      expect(from.doc.exportHwpx()).toEqual(original);
      expect(to.editor.undo()).toBe(true);
      await to.confirm();
      expect(shapes(to.doc).map(frame => frame.controlIdx)).toEqual([sibling]);
      expect(to.editor.redo()).toBe(true);
      await to.confirm();
      expect(getPath(to.doc, index)).toEqual(getPath(from.doc, control));
      const exported = to.doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(to.doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(getPath(reopened, index)).toEqual(getPath(from.doc, control));
          expect(props(reopened, index)).toEqual(props(to.doc, index));
        } finally { reopened.free(); }
        if (out) {
          writeFileSync(resolve(out, "a-p6-polygon-source.hwpx"), bytes);
          writeFileSync(resolve(out, "a-p6-polygon-destination.hwpx"), destinationBytes);
          writeFileSync(resolve(out, "a-p6-polygon-edited.hwpx"), output);
          writeFileSync(resolve(out, "a-p6-polygon-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { from.editor.dispose(); to.editor.dispose(); clearStructuredClipboard(); }
  });

  it.each(["side", "spacing", "Left", "Right"] as const)("Stage 3-A P6 changes picture caption %s without changing its number, runs, or picture", async field => {
    const fixture = new engine.HwpDocument(source("hwpx")) as RhwpDocument;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADYAAAAbCAIAAAC4FetiAAAAN0lEQVR4nO3OUQkAIBBAsethFvv3MIklBN/HYAE2Z+24+T5QVFRUbFFUrFBUrFBUrFBUrFB84QIyEvyvRSPr3QAAAABJRU5ErkJggg==", "base64");
    const lateral = field === "Left" || field === "Right";
    let bytes: Uint8Array, control: number;
    try {
      const created = JSON.parse(fixture.insertPicture!(0, 0, 0, "[]", png,
        lateral ? 4050 : 6300, lateral ? 2025 : 3150, 54, 27, "png", "Owned picture"));
      expect(created.ok).toBe(true);
      control = created.controlIdx;
      expect(JSON.parse(fixture.setPictureProperties!(0, 0, control, JSON.stringify({
        hasCaption: true, captionDirection: "Bottom", treatAsChar: !lateral, captionWidth: field === "spacing" ? 0 : 8000,
        ...(lateral ? { horzRelTo: "Column", vertRelTo: "Para", horzOffset: 3000, vertOffset: 3000 } : {}),
      }))).ok).toBe(true);
      const length = fixture.getCellParagraphLength(0, 0, control, 0, 0);
      fixture.insertTextInCell(0, 0, control, 0, 0, length, " caption");
      fixture.applyCharFormatInCell!(0, 0, control, 0, 0, length + 1, length + 8, '{"bold":true}');
      bytes = fixture.exportHwpx();
    } finally { fixture.free(); }
    const { editor, doc, pick, edit, confirm } = await setup("hwpx", bytes);
    try {
      const picture = () => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "image")!;
      const before = JSON.parse(doc.getPictureProperties!(0, 0, control));
      const owner = doc.getControls!();
      const read = () => JSON.parse(doc.getPictureProperties!(0, 0, control));
      const selection = pick(picture());
      expect(selection.captionSide).toBe("Bottom");
      expect(selection.captionSpacing).toBe(0);
      expect(selection.captionLateral === true, JSON.stringify(before)).toBe(lateral);
      const untouched = doc.exportHwpx();
      expect(edit({ kind: "captionSide", side: "Bottom" })).toBe(false);
      expect(edit({ kind: "captionVerticalAlign", align: "Center" })).toBe(false);
      if (!lateral) expect(edit({ kind: "captionSide", side: "Left" })).toBe(false);
      for (const spacing of [0, -1, 32768, 425.5]) expect(edit({ kind: "captionSpacing", spacing })).toBe(false);
      expect(doc.getControls!()).toBe(owner);
      expect(doc.exportHwpx()).toEqual(untouched);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      const change = field === "spacing" ? { kind: "captionSpacing", spacing: 425 } as const
        : { kind: "captionSide", side: field === "side" ? "Top" : field } as const;
      let expected = change.kind === "captionSide" ? { ...before, captionDirection: change.side } : { ...before, captionSpacing: 425 };
      expect(edit(change)).toBe(true);
      await confirm();
      expect(read()).toEqual(expected);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read()).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read()).toEqual(expected);
      if (lateral) {
        const aligned = pick(picture());
        expect(aligned.captionVerticalAlign).toBe("Top");
        expect(aligned.captionSpacing).toBeUndefined();
        const align = field === "Left" ? "Center" : "Bottom";
        expect(edit({ kind: "captionVerticalAlign", align })).toBe(true);
        await confirm();
        expect(read()).toEqual({ ...expected, captionVertAlign: align });
        expect(editor.undo()).toBe(true);
        await confirm();
        expect(read()).toEqual(expected);
        expect(editor.redo()).toBe(true);
        await confirm();
        expected = { ...expected, captionVertAlign: align };
        expect(read()).toEqual(expected);
      }
      expect(doc.getControls!()).toBe(owner);
      const exported = doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(JSON.parse(reopened.getPictureProperties!(0, 0, control))).toEqual(read()); }
        finally { reopened.free(); }
        if (out) {
          const name = field === "side" ? "a-p6-caption" : `a-p6-caption-${field.toLowerCase()}`;
          writeFileSync(resolve(out, `${name}-original.hwpx`), bytes);
          writeFileSync(resolve(out, `${name}-edited.hwpx`), output);
          writeFileSync(resolve(out, `${name}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("Stage 3-A splits an owned mixed-format HWPX text box paragraph", async () => {
    const { bytes, control } = mixedTextBoxFixture();
    const { editor, doc, confirm } = await setup("hwpx", bytes);
    const address = [0, 0, control, 0] as const;
    const read = (file: RhwpDocument) => ({
      shape: JSON.parse(file.getShapeProperties!(0, 0, control)),
      paragraphs: Array.from({ length: file.getCellParagraphCount(...address) }, (_, para) => {
        const length = file.getCellParagraphLength(...address, para);
        return { text: file.getTextInCell(...address, para, 0, length),
          format: JSON.parse(file.getFormattingRuns!(...address, para, 0, length)),
          properties: JSON.parse(file.getCellParaPropertiesAt!(...address, para)) };
      }),
    });
    try {
      const before = read(doc);
      const cursor = JSON.parse(doc.getCursorRectInCell(...address, 1, 5));
      expect(editor.pointAt(cursor.pageIndex, cursor.x + 0.1, cursor.y + cursor.height / 2, false)).toBe(true);
      expect(editor.caret).toMatchObject({ cell: { textBox: true, cellParagraph: 1 }, offset: 5 });
      expect(before.paragraphs[1]!.format.runs).toEqual([[0, 4, 1], [4, 5, 0], [5, 10, 2]]);
      expect(editor.enter()).toBe(true);
      await confirm();
      expect(editor.caret).toMatchObject({ cell: { textBox: true, cellParagraph: 2 }, offset: 0 });
      const after = read(doc);
      expect(after.shape).toEqual(before.shape);
      expect(after.paragraphs.map(p => p.text)).toEqual(["First paragraph", "Bold ", "plain", "Trailing paragraph"]);
      expect(after.paragraphs[1]!.format.runs).toEqual([[0, 4, 1], [4, 5, 0]]);
      expect(after.paragraphs[2]!.format.runs).toEqual([[0, 5, 2]]);
      expect(after.paragraphs.slice(1, 3).map(p => p.properties)).toEqual([before.paragraphs[1]!.properties, before.paragraphs[1]!.properties]);
      expect(after.paragraphs[0]).toEqual(before.paragraphs[0]);
      expect(after.paragraphs[3]).toEqual(before.paragraphs[2]);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read(doc)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read(doc)).toEqual(after);
      const exported = doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(read(reopened)).toEqual(after); } finally { reopened.free(); }
        if (out) {
          writeFileSync(resolve(out, "a-p5-textbox-original.hwpx"), bytes);
          writeFileSync(resolve(out, "a-p5-textbox-edited.hwpx"), output);
          writeFileSync(resolve(out, "a-p5-textbox-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.each([2, 3] as const)("Stage 3-A deletes an owned selection spanning %i compatible HWPX text box paragraphs", async span => {
    const { bytes, control } = mixedTextBoxFixture(span);
    const { editor, doc, confirm } = await setup("hwpx", bytes);
    const address = [0, 0, control, 0] as const;
    const point = (paragraph: number, offset: number, extend = false) => {
      const cursor = JSON.parse(doc.getCursorRectInCell(...address, paragraph, offset));
      expect(editor.pointAt(cursor.pageIndex, cursor.x + 0.1, cursor.y + cursor.height / 2, extend)).toBe(true);
      expect(editor.caret).toMatchObject({ cell: { textBox: true, cellParagraph: paragraph }, offset });
    };
    const paragraphs = (file: RhwpDocument) => Array.from({ length: file.getCellParagraphCount(...address) }, (_, p) => {
      const n = file.getCellParagraphLength(...address, p);
      return { text: file.getTextInCell(...address, p, 0, n), props: file.getCellParaPropertiesAt!(...address, p),
        runs: JSON.parse(file.getFormattingRuns!(...address, p, 0, n)).runs };
    });
    try {
      const before = paragraphs(doc);
      expect(before.map(p => p.text)).toEqual([
        "First paragraph", "Bold ", ...(span === 3 ? ["middle"] : []), "plain", "Trailing paragraph",
      ]);
      const shape = doc.getShapeProperties!(0, 0, control);
      const untouched = doc.exportHwpx();
      point(1, 0);
      expect(editor.backspace()).toBe(false); // Different paragraph format on the preceding paragraph.
      point(0, 2);
      point(span, 2, true);
      expect(editor.deleteForward()).toBe(false); // An incompatible paragraph anywhere in the range.
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwpx()).toEqual(untouched);

      if (span === 2) {
        point(2, 0);
        expect(editor.backspace()).toBe(true);
        await confirm();
        expect(editor.caret).toMatchObject({ cell: { textBox: true, cellParagraph: 1 }, offset: 5 });
        expect(paragraphs(doc)).toEqual([
          before[0], { ...before[1], text: "Bold plain", runs: [[0, 4, 1], [4, 5, 0], [5, 10, 2]] }, before[3],
        ]);
        expect(editor.undo()).toBe(true);
        await confirm();
        expect(paragraphs(doc)).toEqual(before);
      }

      point(1, 2);
      point(span, 2, true);
      expect(editor.typeText("blocked")).toBe(false);
      expect(editor.deleteForward()).toBe(true);
      await confirm();
      expect(editor.caret).toMatchObject({ cell: { textBox: true, cellParagraph: 1 }, offset: 2 });
      const after = [before[0], { ...before[1], text: "Boain", runs: [[0, 2, 1], [2, 5, 2]] }, before[span + 1]];
      expect(paragraphs(doc)).toEqual(after);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(paragraphs(doc)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(paragraphs(doc)).toEqual(after);
      expect(doc.getShapeProperties!(0, 0, control)).toBe(shape);
      const exported = doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(paragraphs(reopened)).toEqual(after);
          expect(reopened.getShapeProperties!(0, 0, control)).toBe(shape);
        } finally { reopened.free(); }
        if (out) {
          const name = span === 2 ? "a-p5-textbox-join" : "a-p5-textbox-range";
          writeFileSync(resolve(out, `${name}-original.hwpx`), bytes);
          writeFileSync(resolve(out, `${name}-edited.hwpx`), output);
          writeFileSync(resolve(out, `${name}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("Stage 3-A replaces a compatible HWPX text box range with clipboard paragraphs atomically", async () => {
    const { bytes, control } = mixedTextBoxFixture(3);
    const { editor, doc, confirm } = await setup("hwpx", bytes);
    const address = [0, 0, control, 0] as const;
    const point = (paragraph: number, offset: number, extend = false) => {
      const cursor = JSON.parse(doc.getCursorRectInCell(...address, paragraph, offset));
      expect(editor.pointAt(cursor.pageIndex, cursor.x + 0.1, cursor.y + cursor.height / 2, extend)).toBe(true);
      expect(editor.caret).toMatchObject({ cell: { textBox: true, cellParagraph: paragraph }, offset });
    };
    const select = () => { point(1, 2); point(3, 2, true); };
    const read = (file: RhwpDocument) => Array.from({ length: file.getCellParagraphCount(...address) }, (_, p) => {
      const n = file.getCellParagraphLength(...address, p);
      return { text: file.getTextInCell(...address, p, 0, n), props: file.getCellParaPropertiesAt!(...address, p),
        runs: JSON.parse(file.getFormattingRuns!(...address, p, 0, n)).fontRuns };
    });
    const paste = (payload: string) => editor.executeClipboard("edit.paste", () => true,
      { readText: async () => payload, writeText: async () => undefined });
    try {
      const before = read(doc);
      const original = doc.exportHwpx();
      const shape = doc.getShapeProperties!(0, 0, control);
      select();
      expect(documentCommandState("edit.paste", editor.snapshot()).available).toBe(true);
      let deliver!: (text: string) => void;
      const stale = editor.executeClipboard("edit.paste", () => true, {
        readText: () => new Promise(resolve => { deliver = resolve; }), writeText: async () => undefined,
      });
      point(1, 1);
      deliver("stale");
      expect(await stale).toBe(false);
      select();
      expect(await paste("first\n\nthird")).toBe(false);
      expect(await paste("tab\trefused")).toBe(false);
      let interrupted: string[] | undefined;
      const failure = vi.spyOn(doc, "splitParagraphInCell").mockImplementationOnce(() => {
        interrupted = read(doc).map(p => p.text);
        throw new Error("injected failure after deletion and insertion");
      });
      try {
        expect(await paste("새\nnext")).toBe(false);
        expect(failure).toHaveBeenCalledOnce();
        expect(interrupted).toEqual(["First paragraph", "Bo새ain", "Trailing paragraph"]);
      } finally { failure.mockRestore(); }
      expect(read(doc)).toEqual(before);
      expect(doc.exportHwpx()).toEqual(original);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(editor.hasSelection).toBe(true);

      expect(await paste("새\r\nnext")).toBe(true);
      await confirm();
      const after = read(doc);
      expect(after.map(p => p.text)).toEqual(["First paragraph", "Bo새", "nextain", "Trailing paragraph"]);
      expect(after[0]).toEqual(before[0]);
      expect(after[3]).toEqual(before[4]);
      expect(after.slice(1, 3).map(p => p.props)).toEqual([before[1]!.props, before[1]!.props]);
      const styleAt = (p: typeof before[number], offset: number) => p.runs
        .find(([start, end]: number[]) => start! <= offset && offset < end!)?.slice(2);
      expect([0, 1].map(i => styleAt(after[1]!, i))).toEqual([0, 1].map(i => styleAt(before[1]!, i)));
      expect([4, 5, 6].map(i => styleAt(after[2]!, i))).toEqual([2, 3, 4].map(i => styleAt(before[3]!, i)));
      expect(editor.caret).toMatchObject({ cell: { textBox: true, cellParagraph: 2 }, offset: 4 });
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(read(doc)).toEqual(before);
      expect(editor.snapshot().history?.undo).toBe(false);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(read(doc)).toEqual(after);
      expect(doc.getShapeProperties!(0, 0, control)).toBe(shape);
      const exported = doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(read(reopened)).toEqual(after);
          expect(reopened.getShapeProperties!(0, 0, control)).toBe(shape);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "a-p5-textbox-paste-original.hwpx"), bytes);
          writeFileSync(resolve(out, "a-p5-textbox-paste-edited.hwpx"), output);
          writeFileSync(resolve(out, "a-p5-textbox-paste-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("Stage 3-A refuses a fully selected incompatible HWPX text box paragraph", async () => {
    const { bytes, control } = mixedTextBoxFixture("differentMiddle");
    const { editor, doc } = await setup("hwpx", bytes);
    try {
      const start = JSON.parse(doc.getCursorRectInCell(0, 0, control, 0, 1, 2));
      const end = JSON.parse(doc.getCursorRectInCell(0, 0, control, 0, 3, 2));
      const before = doc.exportHwpx();
      expect(editor.pointAt(start.pageIndex, start.x + 0.1, start.y + start.height / 2, false)).toBe(true);
      expect(editor.pointAt(end.pageIndex, end.x + 0.1, end.y + end.height / 2, true)).toBe(true);
      expect(editor.caret).toMatchObject({ cell: { textBox: true, cellParagraph: 3 }, offset: 2 });
      expect(editor.deleteForward()).toBe(false);
      expect(await editor.executeClipboard("edit.paste", () => true, {
        readText: async () => "replacement", writeText: async () => undefined,
      })).toBe(false);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      expect(doc.exportHwpx()).toEqual(before);
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("edits the second existing paragraph of an owned %s text box", async format => {
    const fixture = new engine.HwpDocument(source(format)) as RhwpDocument;
    let bytes: Uint8Array, control: number;
    try {
      const created = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "textbox",
        width: 10800, height: 7200, treatAsChar: true, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      control = created.controlIdx;
      fixture.insertTextInCell(0, 0, control, 0, 0, 0, "first");
      fixture.splitParagraphInCell(0, 0, control, 0, 0, 5);
      fixture.insertTextInCell(0, 0, control, 0, 1, 0, "second");
      if (format === "hwpx") fixture.applyParaFormatInCell!(0, 0, control, 0, 1, '{"alignment":"center"}');
      bytes = format === "hwp" ? fixture.exportHwp() : fixture.exportHwpx();
    } finally { fixture.free(); }
    const { editor, doc, take, confirm, calls } = await setup(format, bytes);
    const paragraphs = (file: RhwpDocument) => [0, 1].map(p =>
      file.getTextInCell(0, 0, control, 0, p, 0, file.getCellParagraphLength(0, 0, control, 0, p)));
    try {
      const baseline = format === "hwp" ? hwpReopenModel(doc) : null;
      if (baseline) {
        expect(baseline.complete).toBe(true);
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const cursor = JSON.parse(doc.getCursorRectInCell(0, 0, control, 0, 1, 0));
      expect(editor.pointAt(cursor.pageIndex, cursor.x + 1, cursor.y + cursor.height / 2, false)).toBe(true);
      expect(editor.caret.cell?.cellParagraph).toBe(1);
      expect(editor.enter()).toBe(false);
      expect(editor.backspace()).toBe(false); // HWP5 and incompatible HWPX paragraph formats are refused.
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
      expect(editor.typeText("새 ")).toBe(true);
      await confirm();
      expect(paragraphs(doc)).toEqual(["first", "새 second"]);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(paragraphs(doc)).toEqual(["first", "second"]);
      expect(editor.redo()).toBe(true);
      await confirm();
      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(paragraphs(reopened)).toEqual(["first", "새 second"]);
          if (baseline) expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p2-multipara-original.${format}`), bytes);
          writeFileSync(resolve(out, `p2-multipara-edited.${format}`), output);
          writeFileSync(resolve(out, `p2-multipara-${format}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("edits one owned HWPX text box with Hangul composition and paragraph alignment", async () => {
    const { editor, doc, confirm } = await setup("hwpx");
    try {
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();

      const [target, sibling] = shapes(doc);
      expect(target).toBeDefined();
      expect(sibling).toBeDefined();
      const control = target!.controlIdx;
      const otherControl = sibling!.controlIdx;
      const lock = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
      expect(JSON.parse(lock.setControlLock(0, otherControl, true))).toMatchObject({ ok: true });
      const original = doc.exportHwpx();
      const lockedCaret = JSON.parse(doc.getCursorRectInCell(0, 0, otherControl, 0, 0, 0));
      expect(editor.pointAt(lockedCaret.pageIndex, lockedCaret.x + 1, lockedCaret.y + lockedCaret.height / 2, false)).toBe(false);
      const paragraphAt = (d: RhwpDocument, index: number) =>
        d.getTextInCell(0, 0, index, 0, 0, 0, d.getCellParagraphLength(0, 0, index, 0, 0));
      const body = doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0));
      const cursor = JSON.parse(doc.getCursorRectInCell(0, 0, control, 0, 0, 0));
      expect(editor.pointAt(cursor.pageIndex, cursor.x + 1, cursor.y + cursor.height / 2, false)).toBe(true);
      expect(editor.enter()).toBe(false);

      editor.beginComposition();
      editor.updateComposition("하");
      editor.updateComposition("한");
      expect(editor.endComposition("한글")).toBe("한글");
      await confirm();
      expect(paragraphAt(doc, control)).toBe("한글");
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(paragraphAt(doc, control)).toBe("");
      expect(editor.redo()).toBe(true);
      await confirm();

      expect(editor.moveHorizontal(-1, true)).toBe(true);
      expect(editor.selectionRects()).not.toHaveLength(0);
      expect(editor.moveHorizontal(1, false)).toBe(true);
      expect(editor.execute("paragraph.alignCenter").accepted).toBe(true);
      await confirm();
      const alignment = (d: RhwpDocument) => JSON.parse(d.getCellParaPropertiesAt!(0, 0, control, 0, 0)).alignment;
      expect(alignment(doc)).toBe("center");
      const exported = doc.exportHwpxWithReport();
      try {
        const bytes = exported.takeBytes();
        const report = exported.contentLoss();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
        try {
          expect(paragraphAt(reopened, control)).toBe("한글");
          expect(paragraphAt(reopened, otherControl)).toBe("");
          expect(reopened.getTextRange(0, 0, 0, reopened.getParagraphLength(0, 0))).toBe(body);
          expect(alignment(reopened)).toBe("center");
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p2-textbox-original.hwpx"), original);
          writeFileSync(resolve(out, "p2-textbox-edited.hwpx"), bytes);
          writeFileSync(resolve(out, "p2-textbox-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("edits a plain HWP text box after SAFE preflight and preserves the outer object", async () => {
    const { editor, doc, bytes, take, confirm } = await setup("hwp");
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();
      const control = shapes(doc)[0]!.controlIdx;
      const originalWithBox = doc.exportHwp();
      const outer = props(doc, control);
      const base = doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0));
      const at = JSON.parse(doc.getCursorRectInCell(0, 0, control, 0, 0, 0));
      expect(editor.pointAt(at.pageIndex, at.x + 1, at.y + at.height / 2, false)).toBe(true);
      expect(editor.typeText("본문과 별도")).toBe(true);
      await confirm();
      expect(editor.execute("paragraph.alignCenter").accepted).toBe(true);
      await confirm();
      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          expect(reopened.getTextInCell(0, 0, control, 0, 0, 0, 6)).toBe("본문과 별도");
          expect(reopened.getTextRange(0, 0, 0, reopened.getParagraphLength(0, 0))).toBe(base);
          expect(JSON.parse(reopened.getCellParaPropertiesAt!(0, 0, control, 0, 0)).alignment).toBe("center");
          expect(props(reopened, control)).toEqual(outer);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p2-hwp-before.hwp"), bytes);
          writeFileSync(resolve(out, "p2-hwp-existing.hwp"), originalWithBox);
          writeFileSync(resolve(out, "p2-hwp-edited.hwp"), edited);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("inserts the four supported HWP shape families after SAFE preflight and reopens them without loss", async () => {
    const { editor, doc, bytes, confirm, take, calls } = await setup("hwp");
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      const bodyText = (file: RhwpDocument) => file.getTextRange(0, 0, 0, file.getParagraphLength(0, 0));
      const originalText = bodyText(doc);
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(false);
      expect(editor.execute("insert.textBox").accepted).toBe(false);
      expect(shapes(doc)).toHaveLength(0);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);

      // Match the editor's normal load-time original preflight, then admit the same actions only
      // after the owned original has a SAFE verdict.
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();

      const insertShape = async (kind: "rectangle" | "ellipse" | "line") => {
        expect(editor.execute("insert.shape", { command: "insert.shape", kind }).accepted).toBe(true);
        await confirm();
      };
      await insertShape("rectangle");
      await insertShape("ellipse");
      await insertShape("line");
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();

      const liveShapes = hwpShapeInventory(doc);
      expect(liveShapes).toHaveLength(4);
      expect(liveShapes.map(shape => shape.family).sort()).toEqual(["ellipse", "line", "rectangle", "textbox"]);
      expect(liveShapes).toContainEqual({ family: "rectangle", width: 10800, height: 7200, verticalAlign: undefined });
      expect(liveShapes).toContainEqual({ family: "ellipse", width: 10800, height: 7200, verticalAlign: undefined });
      expect(liveShapes).toContainEqual({ family: "line", width: 10800, height: 100, verticalAlign: undefined });
      expect(liveShapes).toContainEqual({ family: "textbox", width: 10800, height: 7200, verticalAlign: "Center" });
      expect(bodyText(doc)).toBe(originalText);

      // Undo/Redo the most recent insertion once; each history application is its own revision.
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(hwpShapeInventory(doc).map(shape => shape.family).sort()).toEqual(["ellipse", "line", "rectangle"]);
      expect(editor.redo()).toBe(true);
      await confirm();

      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(edited) as RhwpDocument & { getControls(): string; getTextFileText(): string };
        try {
          const reopenedModel = hwpReopenModel(reopened);
          expect(reopenedModel.complete).toBe(true);
          expect(hwpReopenEqual(hwpReopenModel(doc), reopenedModel, baseline.structure)).toBe(true);
          expect(bodyText(reopened)).toBe(originalText);
          expect(reopened.getTextFileText()).toBe(doc.getTextFileText!());
          expect(hwpShapeInventory(reopened)).toEqual(liveShapes);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p1-shapes-original.hwp"), bytes);
          writeFileSync(resolve(out, "p1-shapes-edited.hwp"), edited);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("copies, cuts, and pastes HWPX body pictures, shapes, text boxes, and groups with unique IDs, cross-doc, HWP5, and DOCX refusal", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAADYAAAAbCAIAAAC4FetiAAAAN0lEQVR4nO3OUQkAIBBAsethFvv3MIklBN/HYAE2Z+24+T5QVFRUbFFUrFBUrFBUrFBUrFB84QIyEvyvRSPr3QAAAABJRU5ErkJggg==",
      "base64",
    );
    const makeMemoryClipboard = (): { clip: PlainClipboard; reset: () => void; mimes: () => Map<string, string> } => {
      let plain = "";
      const structured = new Map<string, string>();
      return {
        clip: {
          readText: async () => plain,
          writeText: async text => { plain = text; structured.clear(); },
          readStructured: async mime => structured.get(mime) ?? null,
          writeStructured: async (mime, data, text) => { plain = text; structured.clear(); structured.set(mime, data); },
        },
        reset: () => { plain = ""; structured.clear(); },
        mimes: () => new Map(structured),
      };
    };

    // Build an HWPX fixture containing 1 picture, 1 rectangle shape, 1 multi-paragraph textBox, and 1 group.
    type ExtendedFixtureDoc = RhwpDocument & {
      createBlankDocument(): void;
      groupShapes(json: string): string;
    };
    let bytes: Uint8Array;
    const fixture = engine.HwpDocument.createEmpty() as ExtendedFixtureDoc;
    try {
      fixture.createBlankDocument();
      fixture.insertText(0, 0, 0, "clipboard seed");
      const pic = JSON.parse(fixture.insertPicture!(0, 0, 0, "[]", png, 4200, 2100, 54, 27, "png", "copied-pic"));
      expect(pic.ok).toBe(true);
      expect(JSON.parse(fixture.setPictureProperties!(0, 0, pic.controlIdx,
        '{"treatAsChar":false,"textWrap":"Square","horzRelTo":"Para","vertRelTo":"Para","horzOffset":2000,"vertOffset":2000}')).ok).toBe(true);

      const rect = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 1, shapeType: "rectangle",
        width: 5000, height: 3200, treatAsChar: false, textWrap: "Square", horzOffset: 2000, vertOffset: 10000,
      })));
      expect(rect.ok).toBe(true);
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, rect.controlIdx, JSON.stringify({
        textWrap: "Square", fillType: "solid", fillBgColor: 0x00aabbcc, borderColor: 0x00112233, borderWidth: 150,
      }))).ok).toBe(true);

      const box = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "textbox",
        width: 8000, height: 4200, treatAsChar: false, textWrap: "Square", horzOffset: 2000, vertOffset: 18000,
      })));
      expect(box.ok).toBe(true);
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, box.controlIdx, JSON.stringify({
        textWrap: "Square", fillType: "solid", fillBgColor: 0x00ffeecc, borderColor: 0x00334455, borderWidth: 100,
        tbVerticalAlign: "Center", tbMarginLeft: 200, tbMarginRight: 200, tbMarginTop: 100, tbMarginBottom: 100,
      }))).ok).toBe(true);
      expect(JSON.parse(fixture.insertTextInCell(0, 0, box.controlIdx, 0, 0, 0, "첫 문단")).ok).toBe(true);
      expect(JSON.parse(fixture.splitParagraphInCell(0, 0, box.controlIdx, 0, 0, 4)).ok).toBe(true);
      expect(JSON.parse(fixture.insertTextInCell(0, 0, box.controlIdx, 0, 1, 0, "둘째 문단")).ok).toBe(true);
      expect(JSON.parse(fixture.applyParaFormatInCell!(0, 0, box.controlIdx, 0, 0, '{"alignment":"center"}')).ok).toBe(true);
      expect(JSON.parse(fixture.applyParaFormatInCell!(0, 0, box.controlIdx, 0, 1, '{"alignment":"right"}')).ok).toBe(true);

      const g1 = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 3, shapeType: "rectangle",
        width: 3000, height: 2200, treatAsChar: false, textWrap: "Square", horzOffset: 20000, vertOffset: 2000,
      })));
      const g2 = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 4, shapeType: "ellipse",
        width: 2400, height: 2400, treatAsChar: false, textWrap: "Square", horzOffset: 24000, vertOffset: 2000,
      })));
      const grouped = JSON.parse(fixture.groupShapes(JSON.stringify({
        sectionIdx: 0, targets: [{ paraIdx: 0, controlIdx: g1.controlIdx }, { paraIdx: 0, controlIdx: g2.controlIdx }],
      })));
      expect(grouped.ok).toBe(true);
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, grouped.controlIdx, '{"textWrap":"Square","horzOffset":20000,"vertOffset":2000}')).ok).toBe(true);

      bytes = fixture.exportHwpx();
    } finally { fixture.free(); }

    clearStructuredClipboard();
    const { clip, mimes } = makeMemoryClipboard();
    const layoutFrames = (doc: RhwpDocument) => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]);
    const listControls = (doc: RhwpDocument) => JSON.parse(doc.getControls!()) as {
      list: number; para: number; controlIndex: number; ctrlId: string; userDesc: string;
    }[];
    const shapePropsAt = (doc: RhwpDocument, para: number, control: number) =>
      JSON.parse(doc.getShapeProperties!(0, para, control)) as Record<string, unknown>;

    const src = await setup("hwpx", bytes);
    let copiedTextBoxMime!: string;
    let copiedPicMime!: string;
    let copiedGroupMime!: string;
    try {
      const picFrames = () => layoutFrames(src.doc).filter(f => f.type === "image");
      const groupFrames = () => layoutFrames(src.doc).filter(f => f.type === "group");
      const shapeFrames = () => layoutFrames(src.doc).filter(f => f.type === "shape");

      // 1. Picture copy -> deselect -> paste (unique control + BinData survival + cascade).
      const selPic = src.pick(picFrames()[0]!);
      expect(selPic.operations).toContain("copy");
      expect(selPic.operations).toContain("cut");
      expect(documentCommandState("edit.copy", src.editor.snapshot())).toEqual({ available: true });
      expect(documentCommandState("edit.cut", src.editor.snapshot())).toEqual({ available: true });
      expect(documentCommandState("edit.paste", src.editor.snapshot())).toEqual({ available: false, reason: "protected" });
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      copiedPicMime = mimes().get(OBJECT_CLIPBOARD_MIME)!;
      const parsedPic = parseObjectClipboardPayload(copiedPicMime);
      expect(parsedPic).toMatchObject({ version: 3, sourceFormat: "hwpx", object: "picture" });
      expect(parsedPic && parsedPic.version === 3 ? parsedPic.portable : undefined).toMatchObject({ kind: "picture", mime: "image/png" });

      expect(src.editor.execute("object.deselect").accepted).toBe(true);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await src.confirm();
      expect(picFrames()).toHaveLength(2);

      // 2. Rectangle shape cut -> deselect -> paste -> recreated with unique scInstId.
      const rectFrame = shapeFrames().find(f => src.pick(f).kind === "shape")!;
      expect(rectFrame).toBeDefined();
      expect(documentCommandState("edit.cut", src.editor.snapshot())).toEqual({ available: true });
      const beforeCutIds = new Set(listControls(src.doc)
        .filter(c => c.list === 0 && c.userDesc === "사각형")
        .map(c => shapePropsAt(src.doc, c.para, c.controlIndex).scInstId));
      const shapeCountBefore = shapeFrames().length;
      expect(await src.editor.executeClipboard("edit.cut", () => true, clip)).toBe(true);
      await src.confirm();
      expect(shapeFrames()).toHaveLength(shapeCountBefore - 1);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await src.confirm();
      expect(shapeFrames()).toHaveLength(shapeCountBefore);
      const rectCtrls = listControls(src.doc).filter(c => c.list === 0 && c.userDesc === "사각형");
      expect(new Set(rectCtrls.map(c => shapePropsAt(src.doc, c.para, c.controlIndex).scInstId)).size).toBe(rectCtrls.length);
      expect(rectCtrls.some(c => !beforeCutIds.has(shapePropsAt(src.doc, c.para, c.controlIndex).scInstId))).toBe(true);

      // 3. TextBox copy -> paste in same doc.
      const boxFrame = shapeFrames().find(f => src.pick(f).kind === "textBox")!;
      expect(boxFrame).toBeDefined();
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      copiedTextBoxMime = mimes().get(OBJECT_CLIPBOARD_MIME)!;
      const parsedBox = parseObjectClipboardPayload(copiedTextBoxMime);
      expect(parsedBox && parsedBox.version === 3 ? parsedBox.portable : undefined).toMatchObject({ shapeType: "textbox" });
      const boxCountBefore = shapeFrames().filter(f => src.pick(f).kind === "textBox").length;
      expect(src.editor.execute("object.deselect").accepted).toBe(true);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await src.confirm();
      const boxCtrls = listControls(src.doc).filter(c => c.list === 0 && (c.userDesc === "사각형" || c.userDesc === "글상자"))
        .filter(c => shapePropsAt(src.doc, c.para, c.controlIndex).tbVerticalAlign !== undefined);
      expect(boxCtrls).toHaveLength(boxCountBefore + 1);
      expect(new Set(boxCtrls.map(c => shapePropsAt(src.doc, c.para, c.controlIndex).scInstId)).size).toBe(boxCtrls.length);

      // 4. Group copy -> paste in same doc -> Undo / Redo.
      const selGroup = src.pick(groupFrames()[0]!);
      expect(selGroup.kind).toBe("group");
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      copiedGroupMime = mimes().get(OBJECT_CLIPBOARD_MIME)!;
      expect(src.editor.execute("object.deselect").accepted).toBe(true);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await src.confirm();
      expect(groupFrames()).toHaveLength(2);
      const groupCtrls = listControls(src.doc).filter(c => c.list === 0 && c.userDesc === "그리기");
      expect(new Set(groupCtrls.map(c => `${c.para}:${c.controlIndex}`)).size).toBe(2);

      expect(src.editor.undo()).toBe(true);
      await src.confirm();
      expect(groupFrames()).toHaveLength(1);
      expect(src.editor.redo()).toBe(true);
      await src.confirm();
      expect(groupFrames()).toHaveLength(2);

      const exported = src.doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        expectReopenEvidence(src.doc, edited, report);
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p4-clipboard-original.hwpx"), bytes);
          writeFileSync(resolve(out, "p4-clipboard-edited.hwpx"), edited);
          writeFileSync(resolve(out, "p4-clipboard-report.hwpx.json"), report);
        }
      } finally { exported.free(); }
    } finally { src.editor.dispose(); }

    // Cross-document HWPX portable paste (picture + textBox) + fail-closed refusals (cross-doc group, DOCX v2, HWP5).
    const dst = await setup("hwpx");
    try {
      const boxObj = parseObjectClipboardPayload(copiedTextBoxMime)!;
      const boxClipboard: PlainClipboard = {
        readText: async () => `Geul textBox [${boxObj.token}]`,
        writeText: async () => undefined,
        readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? copiedTextBoxMime : null,
      };
      expect(await dst.editor.executeClipboard("edit.paste", () => true, boxClipboard)).toBe(true);
      await dst.confirm();
      expect(layoutFrames(dst.doc).filter(f => f.type === "shape" && dst.pick(f).kind === "textBox")).toHaveLength(1);
      expect(dst.editor.execute("object.deselect").accepted).toBe(true);

      const picClipboard: PlainClipboard = {
        readText: async () => "fallback",
        writeText: async () => undefined,
        readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? copiedPicMime : null,
      };
      expect(await dst.editor.executeClipboard("edit.paste", () => true, picClipboard)).toBe(true);
      await dst.confirm();
      expect(layoutFrames(dst.doc).filter(f => f.type === "image")).toHaveLength(1);

      const revBeforeRefusals = dst.editor.snapshot().revision;
      const commitsBefore = dst.calls.filter(c => c.method === "commit").length;
      // Cross-doc group and DOCX v2 payload must fail closed without mutating dst.
      for (const rejectedPayload of [
        copiedGroupMime,
        JSON.stringify(createRichObjectClipboardPayload("shape", JSON.stringify({ fragment: {}, media: [] }))!),
      ]) {
        const badClip: PlainClipboard = {
          readText: async () => "fallback",
          writeText: async () => undefined,
          readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? rejectedPayload : null,
        };
        expect(await dst.editor.executeClipboard("edit.paste", () => true, badClip)).toBe(false);
      }
      expect(dst.calls.filter(c => c.method === "commit")).toHaveLength(commitsBefore);
      expect(dst.editor.snapshot().revision).toBe(revBeforeRefusals);
    } finally { dst.editor.dispose(); }

    // HWP5 documents must never offer copy/cut on locked objects or accept HWPX v3 object paste.
    let hwpBytes: Uint8Array;
    const hwpFix = engine.HwpDocument.createEmpty() as ExtendedFixtureDoc & {
      setControlLock(para: number, index: number, locked: boolean): string;
    };
    try {
      hwpFix.createBlankDocument();
      hwpFix.insertText(0, 0, 0, "hwp target");
      const r = JSON.parse(hwpFix.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: "rectangle",
        width: 4000, height: 3000, treatAsChar: false, textWrap: "Square", horzOffset: 2000, vertOffset: 2000,
      })));
      expect(r.ok).toBe(true);
      expect(JSON.parse(hwpFix.setControlLock(0, r.controlIdx, true))).toMatchObject({ ok: true });
      hwpBytes = hwpFix.exportHwp();
    } finally { hwpFix.free(); }

    const hwp = await setup("hwp", hwpBytes);
    try {
      const hwpRect = layoutFrames(hwp.doc).find(f => f.type === "shape")!;
      const hwpSel = hwp.pick(hwpRect);
      expect(hwpSel.operations).not.toContain("copy");
      expect(hwpSel.operations).not.toContain("cut");
      expect(hwp.editor.snapshot().clipboard?.shape).toBeUndefined();
      expect(documentCommandState("edit.copy", hwp.editor.snapshot())).toEqual({ available: false, reason: "protected" });
      expect(hwp.editor.execute("object.deselect").accepted).toBe(true);
      const boxClip: PlainClipboard = {
        readText: async () => "fallback",
        writeText: async () => undefined,
        readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? copiedTextBoxMime : null,
      };
      expect(await hwp.editor.executeClipboard("edit.paste", () => true, boxClip)).toBe(false);
    } finally { hwp.editor.dispose(); }
  });

  it("B3.1: copies, cuts, and pastes HWP5 pictures, shapes, text boxes, and flat groups within one document and refuses unsafe/cross-doc transfers", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC",
      "base64",
    );
    type ExtendedHwpDoc = RhwpDocument & {
      groupShapes(json: string): string;
      getControls(): string;
      setControlLock(para: number, index: number, locked: boolean): string;
      splitParagraph(sec: number, para: number, offset: number): string;
    };
    const layoutFrames = (doc: RhwpDocument) => JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[];
    const listControls = (doc: RhwpDocument) =>
      JSON.parse((doc as ExtendedHwpDoc).getControls()) as { list: number; para: number; controlIndex: number; userDesc: string; instanceId?: number }[];

    const makeFixture = () => {
      const fix = engine.HwpDocument.createEmpty() as ExtendedHwpDoc;
      try {
        fix.createBlankDocument();
        fix.insertText(0, 0, 0, "anchor para");
        fix.splitParagraph(0, 0, 11);
        fix.insertText(0, 1, 0, "paste target");

        const pic = JSON.parse(fix.insertPicture!(0, 0, 1, "[]", png, 4200, 2100, 48, 64, "png", "b31-pic"));
        expect(pic.ok).toBe(true);
        expect(JSON.parse(fix.setPictureProperties!(0, 0, pic.controlIdx, JSON.stringify({
          textWrap: "Square", horzOffset: 1000, vertOffset: 1500, hasCaption: true,
        }))).ok).toBe(true);

        const shape = JSON.parse(fix.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "rectangle",
          width: 4800, height: 3200, treatAsChar: false, textWrap: "Square", horzOffset: 7000, vertOffset: 1500,
        })));
        expect(JSON.parse(fix.setShapeProperties!(0, 0, shape.controlIdx, JSON.stringify({
          fillType: "solid", fillBgColor: 0x00446688, borderWidth: 100,
        }))).ok).toBe(true);

        const box = JSON.parse(fix.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 3, shapeType: "textbox",
          width: 6000, height: 3200, treatAsChar: false, textWrap: "Square", horzOffset: 13000, vertOffset: 1500,
        })));
        expect(JSON.parse(fix.insertTextInCell!(0, 0, box.controlIdx, 0, 0, 0, "hwp5 textbox line")).ok).toBe(true);

        const g1 = JSON.parse(fix.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 4, shapeType: "rectangle",
          width: 2400, height: 1800, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
        })));
        const g2 = JSON.parse(fix.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 5, shapeType: "ellipse",
          width: 2400, height: 1800, treatAsChar: false, textWrap: "Square", horzOffset: 2600, vertOffset: 0,
        })));
        const grp = JSON.parse(fix.groupShapes(JSON.stringify({
          sectionIdx: 0,
          targets: [{ paraIdx: 0, controlIdx: g1.controlIdx }, { paraIdx: 0, controlIdx: g2.controlIdx }],
        })));
        expect(grp.ok).toBe(true);
        expect(JSON.parse(fix.setShapeProperties!(0, 0, grp.controlIdx, '{"textWrap":"Square","horzOffset":20000,"vertOffset":1500}')).ok).toBe(true);
        return fix.exportHwp();
      } finally { fix.free(); }
    };

    const origBytes = makeFixture();
    // 1. Copy + Paste all four object classes within the same HWP5 document + Undo/Redo + reopen.
    const src = await setup("hwp", origBytes);
    let copiedShapeMime = "";
    try {
      src.take("original").reply(ok(origBytes));
      await flush();
      src.take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();

      const clipboard = new Map<string, string>();
      let plainText = "";
      const bridge: PlainClipboard = {
        readText: async () => plainText,
        writeText: async text => { plainText = text; },
        readStructured: async mime => clipboard.get(mime) ?? null,
        writeStructured: async (mime, data) => { clipboard.set(mime, data); },
      };

      const pasteAtCaret = async () => {
        expect(src.editor.execute("object.deselect").accepted).toBe(true);
        expect(await src.editor.executeClipboard("edit.paste", () => true, bridge)).toBe(true);
        await src.confirm();
      };

      const picFrame = layoutFrames(src.doc).find(f => f.type === "image")!;
      expect(src.pick(picFrame).operations).toEqual(expect.arrayContaining(["copy", "cut"]));
      expect(await src.editor.executeClipboard("edit.copy", () => true, bridge)).toBe(true);
      await pasteAtCaret();

      const shapeFrames = () => layoutFrames(src.doc).filter(f => f.type === "shape");
      const rectFrame = shapeFrames().find(f => src.pick(f).kind === "shape")!;
      expect(src.pick(rectFrame).operations).toEqual(expect.arrayContaining(["copy", "cut"]));
      expect(await src.editor.executeClipboard("edit.copy", () => true, bridge)).toBe(true);
      copiedShapeMime = clipboard.get(OBJECT_CLIPBOARD_MIME)!;
      expect(parseObjectClipboardPayload(copiedShapeMime)).toMatchObject({ sourceFormat: "hwp", object: "shape" });
      await pasteAtCaret();

      const boxFrame = shapeFrames().find(f => src.pick(f).kind === "textBox")!;
      expect(src.pick(boxFrame).operations).toEqual(expect.arrayContaining(["copy", "cut"]));
      expect(await src.editor.executeClipboard("edit.copy", () => true, bridge)).toBe(true);
      await pasteAtCaret();

      const grpFrame = layoutFrames(src.doc).find(f => f.type === "group")!;
      expect(src.pick(grpFrame).operations).toEqual(expect.arrayContaining(["copy", "cut"]));
      expect(await src.editor.executeClipboard("edit.copy", () => true, bridge)).toBe(true);
      await pasteAtCaret();

      expect(layoutFrames(src.doc).filter(f => f.type === "image")).toHaveLength(2);
      expect(shapeFrames()).toHaveLength(4);
      expect(layoutFrames(src.doc).filter(f => f.type === "group")).toHaveLength(2);

      // Verify Undo/Redo cleanly removes and restores the last pasted group.
      expect(src.editor.undo()).toBe(true);
      await src.confirm();
      expect(layoutFrames(src.doc).filter(f => f.type === "group")).toHaveLength(1);
      expect(src.editor.redo()).toBe(true);
      await src.confirm();
      expect(layoutFrames(src.doc).filter(f => f.type === "group")).toHaveLength(2);

      // Reserved plain-text fallback without structured MIME must fail closed.
      const fallbackClip: PlainClipboard = {
        readText: async () => plainText,
        writeText: async () => undefined,
        readStructured: async () => null,
      };
      expect(src.editor.objectSelection).toBeNull();
      expect(await src.editor.executeClipboard("edit.paste", () => true, fallbackClip)).toBe(false);

      const exported = src.doc.exportHwpWithReport();
      try {
        const output = exported.takeBytes();
        expectReopenEvidence(src.doc, output, exported.contentLoss());
        const reopened = new engine.HwpDocument(output) as ExtendedHwpDoc;
        try {
          const gsoCtrls = listControls(reopened).filter(c => c.list === 0 && ["그림", "사각형", "그리기"].includes(c.userDesc));
          expect(gsoCtrls).toHaveLength(8);
          expect(new Set(gsoCtrls.map(c => `${c.para}:${c.controlIndex}`)).size).toBe(8);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "b3-1-copy-paste-original.hwp"), origBytes);
          writeFileSync(resolve(out, "b3-1-copy-paste-edited.hwp"), output);
        }
      } finally { exported.free(); }
    } finally { src.editor.dispose(); }

    // 2. Cut + Paste within HWP5 document (styled rectangle + flat group) + Undo/Redo + reopen.
    const cutSession = await setup("hwp", origBytes);
    try {
      cutSession.take("original").reply(ok(origBytes));
      await flush();
      cutSession.take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const clipboard = new Map<string, string>();
      const bridge: PlainClipboard = {
        readText: async () => "",
        writeText: async () => undefined,
        readStructured: async mime => clipboard.get(mime) ?? null,
        writeStructured: async (mime, data) => { clipboard.set(mime, data); },
      };

      const grpFrame = layoutFrames(cutSession.doc).find(f => f.type === "group")!;
      cutSession.pick(grpFrame);
      expect(await cutSession.editor.executeClipboard("edit.cut", () => true, bridge)).toBe(true);
      await cutSession.confirm();
      expect(layoutFrames(cutSession.doc).filter(f => f.type === "group")).toHaveLength(0);

      expect(await cutSession.editor.executeClipboard("edit.paste", () => true, bridge)).toBe(true);
      await cutSession.confirm();
      const pastedGroups = layoutFrames(cutSession.doc).filter(f => f.type === "group");
      expect(pastedGroups).toHaveLength(1);
      expect(pastedGroups[0]!.x).toBeGreaterThan(grpFrame.x);

      const exported = cutSession.doc.exportHwpWithReport();
      try {
        const output = exported.takeBytes();
        expectReopenEvidence(cutSession.doc, output, exported.contentLoss());
        if (out) {
          writeFileSync(resolve(out, "b3-1-cut-paste-original.hwp"), origBytes);
          writeFileSync(resolve(out, "b3-1-cut-paste-edited.hwp"), output);
        }
      } finally { exported.free(); }
    } finally { cutSession.editor.dispose(); }

    // 3. Cross-doc HWP5 -> HWP5 and cross-format HWP5 -> HWPX paste must fail closed.
    const dstHwp = await setup("hwp", origBytes);
    try {
      dstHwp.take("original").reply(ok(origBytes));
      await flush();
      dstHwp.take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const foreignClip: PlainClipboard = {
        readText: async () => "fallback",
        writeText: async () => undefined,
        readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? copiedShapeMime : null,
      };
      expect(await dstHwp.editor.executeClipboard("edit.paste", () => true, foreignClip)).toBe(false);
      expect(dstHwp.editor.snapshot().revision).toBe(0);
    } finally { dstHwp.editor.dispose(); }

    const dstHwpx = await setup("hwpx", source("hwpx"));
    try {
      const crossFmtClip: PlainClipboard = {
        readText: async () => "fallback",
        writeText: async () => undefined,
        readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? copiedShapeMime : null,
      };
      expect(await dstHwpx.editor.executeClipboard("edit.paste", () => true, crossFmtClip)).toBe(false);
      expect(dstHwpx.editor.snapshot().revision).toBe(0);

      // Tampered HWP5 payload carrying portable data must be rejected by parser & session.
      const hwpPayload = createHwpObjectClipboardPayload("shape", 1, 1)!;
      expect(parseObjectClipboardPayload(JSON.stringify({ ...hwpPayload, portable: { shapeType: "rectangle" } }))).toBeNull();
    } finally { dstHwpx.editor.dispose(); }
  });
});
