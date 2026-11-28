// Contract v1.0 regression for HWPX native curve anchors and LINE/CURVE segment conversion.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { objectEditRequest, validObjectEdit, type ObjectEdit } from "../../src/commands/objectSelection";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { FIXED_MEMORY_BYTES, controlledBackend, info, loaded, ok, flush } from "../../src/components/Editor/rhwp/testing";

const artifacts = resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS ?? "public/rhwp");
const identity = await readRhwpGeneration(artifacts, "release");
const generation = resolve(artifacts, "generations", identity.generation);
const engine = createRequire(import.meta.url)(resolve(generation, "rhwp.js"));
engine.initSync({ module: readFileSync(resolve(generation, "rhwp_bg.wasm")) });
const outputDirectory = process.env.GEUL_STAGE3_OUT ? resolve(process.env.GEUL_STAGE3_OUT) : undefined;
const fixture = resolve(process.cwd(), "scripts/tests/fixtures/hwpx-catmull-rom/SimpleCurve.canonical.hwpx");

type Frame = { type: string; x: number; y: number; w: number; h: number; controlIdx: number };

function packageEvidence(bytes: Uint8Array) {
  return JSON.parse(execFileSync("python3", ["-c", `
import copy, hashlib, io, json, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    root = ET.fromstring(z.read("Contents/section0.xml"))
    curves = root.findall(".//{http://www.hancom.co.kr/hwpml/2011/paragraph}curve")
    assert len(curves) == 1, len(curves)
    section_without_segments = copy.deepcopy(root)
    stripped_curve = section_without_segments.findall(".//{http://www.hancom.co.kr/hwpml/2011/paragraph}curve")[0]
    for segment in stripped_curve.findall("{http://www.hancom.co.kr/hwpml/2011/paragraph}seg"):
        stripped_curve.remove(segment)
    segments = []
    for node in curves[0].findall("{http://www.hancom.co.kr/hwpml/2011/paragraph}seg"):
        segments.append(list(node.attrib.items()))
    parts = {name: hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist()
             if name != "Contents/section0.xml"}
    print(json.dumps({"segments": segments, "parts": parts,
                      "nonSegmentSectionSha256": hashlib.sha256(ET.tostring(section_without_segments)).hexdigest()}))
`], { input: bytes, encoding: "utf8" }));
}

function openCurveFixture(bytes: Uint8Array) {
  return new Uint8Array(execFileSync("python3", ["-c", `
import io, re, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out=io.BytesIO()
    with zipfile.ZipFile(out,"w") as dst:
        for entry in src.infolist():
            data=src.read(entry)
            if entry.filename=="Contents/section0.xml":
                def make_open(match):
                    body=match.group(0)
                    segments=list(re.finditer(rb'<hp:seg\\b[^>]*/>',body))
                    assert len(segments)>=4, len(segments)
                    last=segments[-1]
                    return body[:last.start()]+body[last.end():]
                data,count=re.subn(rb'<hp:curve\\b[^>]*>.*?</hp:curve>',make_open,data,count=1,flags=re.S)
                assert count==1,count
            dst.writestr(entry,data)
    sys.stdout.buffer.write(out.getvalue())
`], { input: bytes }));
}

function unknownSegmentMetadataFixture(bytes: Uint8Array) {
  return new Uint8Array(execFileSync("python3", ["-c", `
import io, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out=io.BytesIO()
    with zipfile.ZipFile(out,"w") as dst:
        for entry in src.infolist():
            data=src.read(entry)
            if entry.filename=="Contents/section0.xml":
                root=ET.fromstring(data)
                segments=root.findall(".//{http://www.hancom.co.kr/hwpml/2011/paragraph}curve/{http://www.hancom.co.kr/hwpml/2011/paragraph}seg")
                assert len(segments)==6,len(segments)
                segments[0].set("marker","preserve")
                data=ET.tostring(root,encoding="utf-8",xml_declaration=True)
            dst.writestr(entry,data)
    sys.stdout.buffer.write(out.getvalue())
`], { input: bytes }));
}

function unknownSegmentTypeFixture(bytes: Uint8Array) {
  return new Uint8Array(execFileSync("python3", ["-c", `
import io, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out=io.BytesIO()
    with zipfile.ZipFile(out,"w") as dst:
        for entry in src.infolist():
            data=src.read(entry)
            if entry.filename=="Contents/section0.xml":
                root=ET.fromstring(data)
                segments=root.findall(".//{http://www.hancom.co.kr/hwpml/2011/paragraph}curve/{http://www.hancom.co.kr/hwpml/2011/paragraph}seg")
                assert len(segments)==6,len(segments)
                segments[0].set("type","SPLINE")
                data=ET.tostring(root,encoding="utf-8",xml_declaration=True)
            dst.writestr(entry,data)
    sys.stdout.buffer.write(out.getvalue())
`], { input: bytes }));
}

function duplicateLineSplitFixture(bytes: Uint8Array) {
  return new Uint8Array(execFileSync("python3", ["-c", `
import io, math, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out=io.BytesIO()
    with zipfile.ZipFile(out,"w") as dst:
        for entry in src.infolist():
            data=src.read(entry)
            if entry.filename=="Contents/section0.xml":
                root=ET.fromstring(data)
                segments=root.findall(".//{http://www.hancom.co.kr/hwpml/2011/paragraph}curve/{http://www.hancom.co.kr/hwpml/2011/paragraph}seg")
                assert len(segments)==6,len(segments)
                first=segments[0]
                first.set("type","LINE")
                x1,y1,x2,y2=(int(first.attrib[key]) for key in ("x1","y1","x2","y2"))
                dx,dy=x2-x1,y2-y1
                divisor=math.gcd(abs(dx),abs(dy))
                assert divisor>=2
                point=(x1+dx//divisor,y1+dy//divisor)
                segments[1].set("x2",str(point[0]))
                segments[1].set("y2",str(point[1]))
                segments[2].set("x1",str(point[0]))
                segments[2].set("y1",str(point[1]))
                data=ET.tostring(root,encoding="utf-8",xml_declaration=True)
            dst.writestr(entry,data)
    sys.stdout.buffer.write(out.getvalue())
`], { input: bytes }));
}

function pathOf(doc: RhwpDocument, control: number) {
  return JSON.parse(doc.getEditableShapePath!(0, 0, control));
}

function shapes(doc: RhwpDocument) {
  return (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).filter(frame => frame.type === "shape");
}

async function setup(bytes: Uint8Array) {
  const control = controlledBackend();
  const sessions = new DocumentSessions(control.backend);
  const opening = sessions.open("/contract-v1.hwpx");
  const sessionInfo = (patch: Parameters<typeof info>[0]) => info({ ...patch, format: "hwpx" });
  control.take("open").reply(ok(sessionInfo({ displayName: "contract-v1.hwpx" })));
  await opening;
  const doc = new engine.HwpDocument(bytes) as RhwpDocument;
  const editor = new RhwpEditorSession(1, control.backend, sessions,
    async () => ({ openDocument: input => new engine.HwpDocument(input) as RhwpDocument,
      memoryBytes: () => FIXED_MEMORY_BYTES }), { natural: null });
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
  const edit = (value: ObjectEdit) => editor.execute("object.edit", objectEditRequest(editor.objectSelection!, value)).accepted;
  return { editor, doc, pick, edit, confirm };
}

function expectReopen(doc: RhwpDocument, bytes: Uint8Array, report: string) {
  expect(JSON.parse(report)).toMatchObject({ count: 0 });
  const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
  try {
    expect(reopened.pageCount()).toBe(doc.pageCount());
    expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
    expect(reopened.getControls()).toBe(doc.getControls());
  } finally { reopened.free(); }
}

it("edits HWPX anchors and native segment types under Contract v1.0 with history and durable reopen", async () => {
  const original = readFileSync(fixture);
  const source = packageEvidence(original);
  expect(source.segments).toHaveLength(6);
  expect(source.segments.map((segment: [string, string][]) => segment.find(([name]) => name === "type")?.[1]))
    .toEqual(Array(6).fill("CURVE"));
  const { editor, doc, pick, edit, confirm } = await setup(original);
  try {
    const frame = shapes(doc).find(candidate => pathOf(doc, candidate.controlIdx)?.curveModel === "catmull-rom-derived-bezier");
    expect(frame).toBeDefined();
    const selected = pick(frame!);
    expect(selected.operations).toContain("pathVertex");
    expect(selected.operations).toContain("pathSegment");
    expect(selected.hwpxEditableCurveSegments).toEqual([0, 1, 2, 3, 4, 5]);
    expect(selected.shapePath?.nativeSegmentTypes).toEqual(Array(6).fill("CURVE"));
    expect(selected.shapePath?.points[0]).toEqual(selected.shapePath?.points.at(-1));

    const beforeReject = doc.exportHwpx();
    expect(validObjectEdit({ kind: "pathSegment", action: "exactCurveSplit", index: 0 })).toBe(false);
    expect(edit({ kind: "pathSegment", action: "convertHwpxType", index: 0, expected: "LINE", to: "CURVE" })).toBe(false);
    expect(() => doc.editHwpxCurveSegmentType!(0, 0, frame!.controlIdx, 0, "LINE", "CURVE")).toThrow();
    expect(() => doc.editHwpxCurveVertex!(0, 0, frame!.controlIdx, 0, true, -1, 4000)).toThrow();
    expect(edit({ kind: "pathVertex", action: "insert", index: 0,
      x: selected.shapePath!.points[1]!.x, y: selected.shapePath!.points[1]!.y })).toBe(false);
    expect(() => doc.editHwpxCurveSegmentType!(0, 0, frame!.controlIdx, 6, "CURVE", "LINE")).toThrow();
    expect(doc.exportHwpx()).toEqual(beforeReject);
    expect(editor.localRevision).toBe(0);
    expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });

    expect(edit({ kind: "pathSegment", action: "convertHwpxType", index: 0, expected: "CURVE", to: "LINE" })).toBe(true);
    await confirm();
    const convertedPath = pathOf(doc, frame!.controlIdx);
    expect(convertedPath.nativeSegmentTypes).toEqual(["LINE", "CURVE", "CURVE", "CURVE", "CURVE", "CURVE"]);
    expect(convertedPath.bezierSegments).toBeUndefined();
    expect(convertedPath.closed).toBe(true);
    expect(JSON.parse(doc.getHwpxEditableCurveSegments!(0, 0, frame!.controlIdx))).toEqual([0, 1, 2, 3, 4, 5]);

    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx).nativeSegmentTypes).toEqual(Array(6).fill("CURVE"));
    expect(editor.redo()).toBe(true);
    await confirm();
    pick(frame!);
    const lineSaved = doc.exportHwpxWithReport();
    let lineBytes: Uint8Array;
    try {
      lineBytes = lineSaved.takeBytes();
      expectReopen(doc, lineBytes, lineSaved.contentLoss());
      const reopened = new engine.HwpDocument(lineBytes) as RhwpDocument;
      try {
        expect(pathOf(reopened, frame!.controlIdx).nativeSegmentTypes)
          .toEqual(["LINE", "CURVE", "CURVE", "CURVE", "CURVE", "CURVE"]);
        expect((reopened as RhwpDocument & { renderPageSvg(page: number): string }).renderPageSvg(0).match(/\bC/g))
          .toHaveLength(5);
      } finally { reopened.free(); }
      const savedEvidence = packageEvidence(lineBytes);
      expect(savedEvidence.parts).toEqual(source.parts);
      expect(savedEvidence.segments.map((segment: [string, string][]) => segment.find(([name]) => name === "type")?.[1]))
        .toEqual(["LINE", "CURVE", "CURVE", "CURVE", "CURVE", "CURVE"]);
      for (let index = 0; index < source.segments.length; index++) {
        const before = source.segments[index] as [string, string][];
        const after = savedEvidence.segments[index] as [string, string][];
        expect(after.filter(([name]) => name !== "type")).toEqual(before.filter(([name]) => name !== "type"));
      }
      if (outputDirectory) {
        mkdirSync(outputDirectory, { recursive: true });
        writeFileSync(resolve(outputDirectory, "contract-v1-converted-line.hwpx"), lineBytes);
        writeFileSync(resolve(outputDirectory, "contract-v1-converted-line-report.json"), lineSaved.contentLoss());
      }
    } finally { lineSaved.free(); }

    pick(frame!);
    expect(edit({ kind: "pathSegment", action: "convertHwpxType", index: 0, expected: "LINE", to: "CURVE" })).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx).nativeSegmentTypes).toEqual(Array(6).fill("CURVE"));
    expect(editor.undo()).toBe(true);
    await confirm();
    pick(frame!);
    expect(editor.redo()).toBe(true);
    await confirm();

    pick(frame!);
    const initial = pathOf(doc, frame!.controlIdx);
    pick(frame!);
    expect(edit({ kind: "pathSegment", action: "convertHwpxType", index: 0, expected: "CURVE", to: "LINE" })).toBe(true);
    await confirm();
    pick(frame!);
    const rejectedMixedDeleteBefore = doc.exportHwpx();
    const revisionBeforeRejectedDelete = editor.localRevision;
    expect(edit({ kind: "pathVertex", action: "remove", index: 0 })).toBe(false);
    expect(editor.localRevision).toBe(revisionBeforeRejectedDelete);
    expect(editor.snapshot().history.undo).toBe(true);
    expect(doc.exportHwpx()).toEqual(rejectedMixedDeleteBefore);
    expect(editor.undo()).toBe(true);
    await confirm();

    pick(frame!);
    const arbitraryAnchor = { x: 4200, y: 7000 };
    expect(edit({ kind: "pathVertex", action: "insert", index: 0, ...arbitraryAnchor })).toBe(true);
    await confirm();
    const inserted = pathOf(doc, frame!.controlIdx);
    expect(inserted.points).toHaveLength(initial.points.length + 1);
    expect(inserted.nativeSegmentTypes).toHaveLength(7);
    expect(inserted.points[1]).toMatchObject(arbitraryAnchor);
    expect(inserted.points[0]).toEqual(inserted.points.at(-1));
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx).points).toEqual(initial.points);
    expect(editor.redo()).toBe(true);
    await confirm();

    pick(frame!);
    expect(edit({ kind: "pathVertex", action: "remove", index: 2 })).toBe(true);
    await confirm();
    const removed = pathOf(doc, frame!.controlIdx);
    expect(removed.points).toHaveLength(initial.points.length);
    expect(removed.closed).toBe(true);
    expect(removed.points[0]).toEqual(removed.points.at(-1));
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx).points).toEqual(inserted.points);
    expect(editor.redo()).toBe(true);
    await confirm();

    const saved = doc.exportHwpxWithReport();
    try {
      const bytes = saved.takeBytes();
      expectReopen(doc, bytes, saved.contentLoss());
      const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
      try {
        expect(pathOf(reopened, frame!.controlIdx)).toEqual(pathOf(doc, frame!.controlIdx));
        expect(pathOf(reopened, frame!.controlIdx).nativeSegmentTypes).toEqual(Array(6).fill("CURVE"));
      } finally { reopened.free(); }
      if (outputDirectory) {
        writeFileSync(resolve(outputDirectory, "contract-v1-anchors.hwpx"), bytes);
        writeFileSync(resolve(outputDirectory, "contract-v1-anchors-report.json"), saved.contentLoss());
      }
    } finally { saved.free(); }
  } finally { editor.dispose(); }
});

it("retains open HWPX topology, rejects endpoint deletion, and persists ordinary edits", async () => {
  const closedSource = readFileSync(fixture);
  const original = openCurveFixture(closedSource);
  const source = packageEvidence(original);
  expect(source.segments).toHaveLength(5);
  const sourcePath = new engine.HwpDocument(original) as RhwpDocument;
  try {
    const curves = (JSON.parse(sourcePath.getPageControlLayout!(0)).controls as Frame[])
      .filter(frame => frame.type === "shape");
    const candidate = curves.find(frame => pathOf(sourcePath, frame.controlIdx)?.kind === "curve");
    expect(candidate).toBeDefined();
    expect(pathOf(sourcePath, candidate!.controlIdx).closed).toBe(false);
    expect(pathOf(sourcePath, candidate!.controlIdx).points[0])
      .not.toEqual(pathOf(sourcePath, candidate!.controlIdx).points.at(-1));
  } finally { sourcePath.free(); }

  const { editor, doc, pick, edit, confirm } = await setup(original);
  try {
    const frame = shapes(doc).find(candidate => pathOf(doc, candidate.controlIdx)?.kind === "curve");
    expect(frame).toBeDefined();
    pick(frame!);
    const initial = pathOf(doc, frame!.controlIdx);
    expect(initial.closed).toBe(false);
    expect(initial.nativeSegmentTypes).toEqual(Array(5).fill("CURVE"));

    const untouched = doc.exportHwpx();
    const revisionBeforeReject = editor.localRevision;
    expect(edit({ kind: "pathVertex", action: "remove", index: 0 })).toBe(false);
    expect(edit({ kind: "pathVertex", action: "remove", index: initial.points.length - 1 })).toBe(false);
    expect(doc.exportHwpx()).toEqual(untouched);
    expect(editor.localRevision).toBe(revisionBeforeReject);
    expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });

    const insertion = { x: 4200, y: 7000 };
    expect(edit({ kind: "pathVertex", action: "insert", index: 1, ...insertion })).toBe(true);
    await confirm();
    const inserted = pathOf(doc, frame!.controlIdx);
    expect(inserted.closed).toBe(false);
    expect(inserted.points).toHaveLength(initial.points.length + 1);
    expect(inserted.points[2]).toMatchObject(insertion);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx)).toEqual(initial);
    expect(editor.redo()).toBe(true);
    await confirm();

    expect(edit({ kind: "pathVertex", action: "remove", index: 2 })).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx).points).toHaveLength(initial.points.length);
    expect(pathOf(doc, frame!.controlIdx).closed).toBe(false);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx)).toEqual(inserted);
    expect(editor.redo()).toBe(true);
    await confirm();

    const preMovePath = pathOf(doc, frame!.controlIdx);
    const moved = { x: initial.points[0].x + 17, y: initial.points[0].y + 9 };
    expect(edit({ kind: "pathPoint", index: 0, ...moved })).toBe(true);
    await confirm();
    const movedPath = pathOf(doc, frame!.controlIdx);
    expect(movedPath.closed).toBe(false);
    expect(movedPath.points[0]).toMatchObject(moved);
    expect(movedPath.points.at(-1)).toEqual(initial.points.at(-1));
    expect(movedPath.segments[0]).toContainEqual(["x1", String(moved.x)]);
    expect(movedPath.segments[0]).toContainEqual(["y1", String(moved.y)]);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx)).toEqual(preMovePath);
    expect(editor.redo()).toBe(true);
    await confirm();

    const saved = doc.exportHwpxWithReport();
    try {
      const output = saved.takeBytes();
      expectReopen(doc, output, saved.contentLoss());
      const actual = packageEvidence(output);
      expect(actual.parts).toEqual(source.parts);
      expect(actual.nonSegmentSectionSha256).toBe(source.nonSegmentSectionSha256);
      expect(actual.segments).toEqual(movedPath.segments);
      const reopened = new engine.HwpDocument(output) as RhwpDocument;
      try {
        expect(pathOf(reopened, frame!.controlIdx)).toEqual(movedPath);
        expect(pathOf(reopened, frame!.controlIdx).closed).toBe(false);
      } finally { reopened.free(); }
      if (outputDirectory) {
        writeFileSync(resolve(outputDirectory, "contract-v1-open-original.hwpx"), original);
        writeFileSync(resolve(outputDirectory, "contract-v1-open-edited.hwpx"), output);
        writeFileSync(resolve(outputDirectory, "contract-v1-open-report.json"), saved.contentLoss());
      }
    } finally { saved.free(); }
  } finally { editor.dispose(); }
});

it("preserves unknown segment metadata while withholding structural edit capabilities", async () => {
  const original = unknownSegmentMetadataFixture(readFileSync(fixture));
  const source = packageEvidence(original);
  expect(source.segments[0]).toContainEqual(["marker", "preserve"]);
  const { editor, doc, pick, edit, confirm } = await setup(original);
  try {
    const frame = shapes(doc).find(candidate => pathOf(doc, candidate.controlIdx)?.kind === "curve");
    expect(frame).toBeDefined();
    const selected = pick(frame!);
    expect(selected.operations).not.toContain("pathVertex");
    expect(selected.operations).not.toContain("pathSegment");
    expect(selected.operations).toContain("pathPoint");
    expect(selected.hwpxEditableCurveSegments).toBeUndefined();
    expect(JSON.parse(doc.getHwpxEditableCurveSegments!(0, 0, frame!.controlIdx))).toBeNull();

    const untouched = doc.exportHwpx();
    const revision = editor.localRevision;
    const selection = editor.objectSelection;
    expect(edit({ kind: "pathVertex", action: "insert", index: 0, x: 5000, y: 6000 })).toBe(false);
    expect(edit({ kind: "pathSegment", action: "convertHwpxType", index: 0, expected: "CURVE", to: "LINE" })).toBe(false);
    expect(() => doc.editHwpxCurveVertex!(0, 0, frame!.controlIdx, 0, true, 5000, 6000)).toThrow();
    expect(() => doc.editHwpxCurveSegmentType!(0, 0, frame!.controlIdx, 0, "CURVE", "LINE")).toThrow();
    expect(doc.exportHwpx()).toEqual(untouched);
    expect(editor.localRevision).toBe(revision);
    expect(editor.objectSelection).toBe(selection);
    expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });

    const anchor = selected.shapePath!.points[0]!;
    expect(edit({ kind: "pathPoint", index: 0, x: anchor.x + 11, y: anchor.y + 7 })).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx).segments[0]).toContainEqual(["marker", "preserve"]);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx).segments[0]).toContainEqual(["marker", "preserve"]);
    expect(editor.redo()).toBe(true);
    await confirm();

    const saved = doc.exportHwpxWithReport();
    try {
      const output = saved.takeBytes();
      expectReopen(doc, output, saved.contentLoss());
      const actual = packageEvidence(output);
      expect(actual.parts).toEqual(source.parts);
      expect(actual.nonSegmentSectionSha256).toBe(source.nonSegmentSectionSha256);
      expect(actual.segments).toEqual(source.segments);
      const reopened = new engine.HwpDocument(output) as RhwpDocument;
      try { expect(pathOf(reopened, frame!.controlIdx).segments).toEqual(pathOf(doc, frame!.controlIdx).segments); }
      finally { reopened.free(); }
    } finally { saved.free(); }
  } finally { editor.dispose(); }
});

it("supports exact collinear LINE split and merge separately from ordinary curve anchors", async () => {
  const original = readFileSync(fixture);
  const source = packageEvidence(original);
  const { editor, doc, pick, edit, confirm } = await setup(original);
  try {
    const frame = shapes(doc).find(candidate => pathOf(doc, candidate.controlIdx)?.kind === "curve");
    expect(frame).toBeDefined();
    pick(frame!);
    expect(edit({ kind: "pathSegment", action: "convertHwpxType", index: 0,
      expected: "CURVE", to: "LINE" })).toBe(true);
    await confirm();
    const converted = pathOf(doc, frame!.controlIdx);
    const start = converted.points[0]!;
    const end = converted.points[1]!;
    const dx = end.x - start.x, dy = end.y - start.y;
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const divisor = gcd(Math.abs(dx), Math.abs(dy));
    const steps = Math.floor(divisor / 2);
    expect(divisor).toBeGreaterThanOrEqual(2);
    const midpoint = { x: start.x + dx / divisor * steps, y: start.y + dy / divisor * steps };
    expect([midpoint.x, midpoint.y]).not.toEqual([start.x, start.y]);
    expect([midpoint.x, midpoint.y]).not.toEqual([end.x, end.y]);

    pick(frame!);
    expect(editor.objectSelection!.curveLineSegments).toContain(0);
    expect(edit({ kind: "pathSegment", action: "splitLine", index: 0, ...midpoint })).toBe(true);
    await confirm();
    const split = pathOf(doc, frame!.controlIdx);
    expect(split.points).toHaveLength(converted.points.length + 1);
    expect(split.nativeSegmentTypes.slice(0, 2)).toEqual(["LINE", "LINE"]);
    expect(split.points[1]).toMatchObject(midpoint);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx)).toEqual(converted);
    expect(editor.redo()).toBe(true);
    await confirm();
    pick(frame!);
    expect(edit({ kind: "pathSegment", action: "joinLines", index: 1 })).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx)).toEqual(converted);
    expect(editor.undo()).toBe(true);
    await confirm();
    expect(pathOf(doc, frame!.controlIdx)).toEqual(split);
    expect(editor.redo()).toBe(true);
    await confirm();

    const saved = doc.exportHwpxWithReport();
    try {
      const bytes = saved.takeBytes();
      expectReopen(doc, bytes, saved.contentLoss());
      const actual = packageEvidence(bytes);
      expect(actual.parts).toEqual(source.parts);
      expect(actual.nonSegmentSectionSha256).toBe(source.nonSegmentSectionSha256);
      expect(actual.segments.map((segment: [string, string][]) => segment.find(([name]) => name === "type")?.[1]))
        .toEqual(["LINE", "CURVE", "CURVE", "CURVE", "CURVE", "CURVE"]);
    } finally { saved.free(); }
  } finally { editor.dispose(); }
});

it("rejects an exact LINE split that would duplicate an existing anchor", async () => {
  const original = duplicateLineSplitFixture(readFileSync(fixture));
  const { editor, doc, pick, edit, confirm } = await setup(original);
  try {
    const frame = shapes(doc).find(candidate => pathOf(doc, candidate.controlIdx)?.kind === "curve");
    expect(frame).toBeDefined();
    const path = pathOf(doc, frame!.controlIdx);
    const duplicate = path.points[2]!;
    const a = path.points[0]!, b = path.points[1]!;
    expect((b.x - a.x) * (duplicate.y - a.y) - (b.y - a.y) * (duplicate.x - a.x)).toBe(0);
    pick(frame!);
    const beforeConversion = doc.exportHwpx();
    expect(edit({ kind: "pathSegment", action: "convertHwpxType", index: 0,
      expected: "CURVE", to: "LINE" })).toBe(true);
    await confirm();
    const beforeReject = doc.exportHwpx();
    const revision = editor.localRevision;
    const history = editor.snapshot().history;
    pick(frame!);
    expect(edit({ kind: "pathSegment", action: "splitLine", index: 0,
      x: duplicate.x, y: duplicate.y })).toBe(false);
    expect(doc.exportHwpx()).toEqual(beforeReject);
    expect(editor.localRevision).toBe(revision);
    expect(editor.snapshot().history).toEqual(history);
    expect(beforeConversion).not.toEqual(beforeReject);
  } finally { editor.dispose(); }
});

it("withholds anchor movement from an unknown HWPX segment type and preserves the source", async () => {
  const original = unknownSegmentTypeFixture(readFileSync(fixture));
  const source = packageEvidence(original);
  const { editor, doc, pick, edit } = await setup(original);
  try {
    const frame = shapes(doc).find(candidate => pathOf(doc, candidate.controlIdx)?.kind === "curve");
    expect(frame).toBeDefined();
    const selected = pick(frame!);
    expect(selected.operations).not.toContain("pathPoint");
    expect(selected.operations).not.toContain("pathVertex");
    expect(selected.operations).not.toContain("pathSegment");
    const path = pathOf(doc, frame!.controlIdx);
    const before = doc.exportHwpx();
    const revision = editor.localRevision;
    expect(edit({ kind: "pathPoint", index: 0, x: path.points[0].x + 3, y: path.points[0].y + 5 })).toBe(false);
    expect(() => doc.moveShapePathPoint!(0, 0, frame!.controlIdx, 0,
      path.points[0].x + 3, path.points[0].y + 5)).toThrow();
    expect(doc.exportHwpx()).toEqual(before);
    expect(editor.localRevision).toBe(revision);
    const saved = doc.exportHwpxWithReport();
    try {
      const bytes = saved.takeBytes();
      expectReopen(doc, bytes, saved.contentLoss());
      const actual = packageEvidence(bytes);
      expect(actual.parts).toEqual(source.parts);
      expect(actual.nonSegmentSectionSha256).toBe(source.nonSegmentSectionSha256);
      expect(actual.segments).toEqual(source.segments);
      expect(actual.segments[0]).toContainEqual(["type", "SPLINE"]);
    } finally { saved.free(); }
  } finally { editor.dispose(); }
});
