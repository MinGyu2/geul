// @vitest-environment jsdom
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { hwpReopenEqual, hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import { controlledBackend, FIXED_MEMORY_BYTES, info, loaded, ok, flush } from "../../src/components/Editor/rhwp/testing";
import { objectEditRequest } from "../../src/commands/objectSelection";

const assets = resolve("public/rhwp");
const identity = await readRhwpGeneration(assets, "release");
const generation = resolve(assets, "generations", identity.generation);
const engine = createRequire(import.meta.url)(resolve(generation, "rhwp.js"));
engine.initSync({ module: readFileSync(resolve(generation, "rhwp_bg.wasm")) });

it.each(["hwp", "hwpx"] as const)("inspects an owned %s chart without touching revision or chart data", async format => {
  const bytes = readFileSync(resolve(`external/rhwp/samples/issue7406/7406_OLE__CHART.${format}`));
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const sessionInfo = (value: Parameters<typeof info>[0]) => info({ ...value, format });
  const open = sessions.open(`/chart.${format}`);
  take("open").reply(ok(sessionInfo({ displayName: `chart.${format}` })));
  await open;
  const doc = new engine.HwpDocument(bytes) as RhwpDocument;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: () => doc, memoryBytes: () => FIXED_MEMORY_BYTES }), { natural: null });
  try {
    const loading = editor.load();
    take("load").reply(loaded(bytes));
    await flush();
    take("session").reply(ok(sessionInfo({ state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(sessionInfo({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await loading;
    const { x, y, w, h } = JSON.parse(doc.getPageControlLayout!(0)).controls.find((control: { type: string }) => control.type === "ole");
    const initial = doc.getChartData!(0, 0, 2);
    expect(editor.pointAt(0, x + w / 2, y + h / 2, false, false, true)).toBe(true);
    const selected = editor.objectSelection;
    expect(selected).toMatchObject({ kind: "chart", editable: format === "hwpx", address: { engine: "rhwp", path: [0, 0, 2] } });
    if (format === "hwpx") expect(selected?.operations).toEqual(["deselect", "chart"]);
    expect(selected?.graphic).toMatchObject({ kind: "chart", plot: "bar", title: null, series: JSON.parse(initial).series });
    expect(editor.typeText("ignored")).toBe(false);
    expect(editor.execute("object.deselect").accepted).toBe(true);
    expect(editor.objectSelection).toBeNull();
    expect(doc.getChartData!(0, 0, 2)).toBe(initial);
    expect(calls.filter(call => call.method === "commit")).toEqual([]);
  } finally { editor.dispose(); }
});

it.each([
  ["bar", "external/rhwp/samples/chart/세로막대형/묶은세로막대형.hwpx"],
  ["line", "external/rhwp/samples/chart/라인/꺽은선형.hwpx"],
  ["pie", "external/rhwp/samples/chart/원형/2차원원형.hwpx"],
  ["7406", "external/rhwp/samples/issue7406/7406_OLE__CHART.hwpx"],
] as const)("edits %s HWPX chart data with save/reopen, undo/redo, and unsupported refusal", async (tag, samplePath) => {
  const bytes = readFileSync(resolve(samplePath));
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const sessionInfo = (value: Parameters<typeof info>[0]) => info({ ...value, format: "hwpx" });
  const open = sessions.open(`/chart-${tag}.hwpx`);
  take("open").reply(ok(sessionInfo({ displayName: `chart-${tag}.hwpx` })));
  await open;
  let doc: RhwpDocument | undefined;
  const editor = new RhwpEditorSession(1, backend, sessions,
    async () => ({ openDocument: (b: Uint8Array) => { const d = new engine.HwpDocument(b) as RhwpDocument; doc ??= d; return d; }, memoryBytes: () => FIXED_MEMORY_BYTES }), { natural: null });
  const confirm = async (revision: number) => {
    const pending = take("commit");
    expect(pending.args).toEqual([1, 1, revision - 1, 1]);
    pending.reply(ok(sessionInfo({ state: "ready", revision, dirty: true, loadGeneration: 1, sequence: 2 + revision })));
    await flush();
  };
  try {
    const loading = editor.load();
    take("load").reply(loaded(bytes));
    await flush();
    take("session").reply(ok(sessionInfo({ state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(sessionInfo({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await loading;

    const { x, y, w, h } = JSON.parse(doc.getPageControlLayout!(0)).controls.find((control: { type: string }) => control.type === "ole");
    const select = () => {
      expect(editor.pointAt(0, x + w / 2, y + h / 2, false, false, true)).toBe(true);
      return editor.objectSelection!;
    };
    const initial = JSON.parse(doc.getChartData!(0, 0, 2)) as {
      plot: string;
      labels: string[];
      series: { name: string | null; values: (string | null)[] }[];
    };

    const sel = select();
    expect(sel.operations).toEqual(["deselect", "chart"]);
    // Unsupported chart mutations and invalid null/no-op inputs are rejected without committing.
    expect(editor.execute("object.edit", objectEditRequest(sel, { kind: "chartTitle", text: "제목" })).accepted).toBe(false);
    expect(editor.execute("object.edit", objectEditRequest(sel, { kind: "chartType", plot: "area" })).accepted).toBe(false);
    expect(editor.execute("object.edit", objectEditRequest(sel, {
      kind: "chartData",
      categories: initial.labels,
      series: initial.series.map((s, si) => ({ name: s.name ?? "S", values: s.values.map((v, vi) => si === 0 && vi === 0 ? null : Number(v)) })),
    })).accepted).toBe(false);
    expect(calls.filter(c => c.method === "commit")).toEqual([]);

    const editedCategories = initial.labels.map((l, i) => (i === 0 ? `${l}-편집` : l));
    const editedSeries = initial.series.map((s, si) => ({
      name: s.name !== null ? (si === 0 ? `${s.name} 수정` : s.name) : "",
      values: s.values.map((v, vi) => (si === 0 && vi === 0 ? 12.75 : Number(v))),
    }));
    expect(editor.execute("object.edit", objectEditRequest(sel, {
      kind: "chartData",
      categories: editedCategories,
      series: editedSeries,
    })).accepted).toBe(true);
    await confirm(1);

    const editedExport = doc.exportHwpxWithReport!();
    let editedBytes: Uint8Array;
    try {
      expect(JSON.parse(editedExport.contentLoss())).toMatchObject({ count: 0 });
      editedBytes = editedExport.takeBytes();
    } finally { editedExport.free(); }

    const outDir = process.env.GEUL_STAGE3_OUT;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, `hwpx-chart-${tag}-orig.hwpx`), bytes);
      writeFileSync(resolve(outDir, `hwpx-chart-${tag}-edited.hwpx`), editedBytes);
    }

    const reopened = new engine.HwpDocument(editedBytes) as RhwpDocument & { getControls(): string; getTextFileText(): string };
    try {
      const live = doc as RhwpDocument & { getControls(): string; getTextFileText(): string };
      expect(reopened.pageCount()).toBe(live.pageCount());
      expect(reopened.getTextFileText()).toBe(live.getTextFileText());
      expect(reopened.getControls()).toBe(live.getControls());
      const got = JSON.parse(reopened.getChartData!(0, 0, 2)) as typeof initial;
      expect(got.labels).toEqual(editedCategories);
      if (initial.series[0]!.name !== null) expect(got.series[0]!.name).toBe(`${initial.series[0]!.name} 수정`);
      expect(Number(got.series[0]!.values[0])).toBe(12.75);
      expect(got.series[0]!.values[1]).toBe(initial.series[0]!.values[1]);
    } finally { reopened.free(); }

    // Undo restores original values & Redo restores edited values.
    expect(editor.undo()).toBe(true);
    await confirm(2);
    expect(JSON.parse(doc.getChartData!(0, 0, 2))).toMatchObject({ labels: initial.labels, series: initial.series });
    expect(editor.redo()).toBe(true);
    await confirm(3);
    expect(JSON.parse(doc.getChartData!(0, 0, 2)).labels).toEqual(editedCategories);
    expect(Number(JSON.parse(doc.getChartData!(0, 0, 2)).series[0].values[0])).toBe(12.75);
  } finally { editor.dispose(); }
});

it("edits HWP chart data after SAFE preflight with reopen equality, undo/redo, and pre-preflight refusal", async () => {
  const bytes = readFileSync(resolve("external/rhwp/samples/issue7406/7406_OLE__CHART.hwp"));
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const sessionInfo = (value: Parameters<typeof info>[0]) => info({ ...value, format: "hwp" });
  const open = sessions.open("/chart.hwp");
  take("open").reply(ok(sessionInfo({ displayName: "chart.hwp" })));
  await open;
  let doc: RhwpDocument | undefined;
  const editor = new RhwpEditorSession(1, backend, sessions,
    async () => ({ openDocument: (b: Uint8Array) => { const d = new engine.HwpDocument(b) as RhwpDocument; doc ??= d; return d; }, memoryBytes: () => FIXED_MEMORY_BYTES }), { natural: null });
  const confirm = async (revision: number) => {
    const pending = take("commit");
    expect(pending.args).toEqual([1, 1, revision - 1, 1]);
    pending.reply(ok(sessionInfo({ state: "ready", revision, dirty: true, loadGeneration: 1, sequence: 2 + revision })));
    await flush();
  };
  try {
    const loading = editor.load();
    take("load").reply(loaded(bytes));
    await flush();
    take("session").reply(ok(sessionInfo({ state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(sessionInfo({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await loading;

    take("original").reply(ok(bytes));
    await flush();
    take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
    await flush();

    const baseline = hwpReopenModel(doc!).structure;
    const { x, y, w, h } = JSON.parse(doc!.getPageControlLayout!(0)).controls.find((control: { type: string }) => control.type === "ole");
    expect(editor.pointAt(0, x + w / 2, y + h / 2, false, false, true)).toBe(true);
    const sel = editor.objectSelection!;
    expect(sel.kind).toBe("chart");
    expect(sel.editable).toBe(true);
    expect(sel.operations).toEqual(["deselect", "chart"]);

    const initial = JSON.parse(doc!.getChartData!(0, 0, 2)) as {
      labels: string[];
      series: { name: string | null; values: (string | null)[] }[];
    };

    expect(editor.execute("object.edit", objectEditRequest(sel, { kind: "chartTitle", text: "제목" })).accepted).toBe(false);
    expect(calls.filter(c => c.method === "commit")).toEqual([]);

    const editedCategories = initial.labels.map((l, i) => (i === 0 ? `${l}-HWP` : l));
    const editedSeries = initial.series.map((s, si) => ({
      name: s.name !== null ? (si === 0 ? `${s.name} HWP` : s.name) : "",
      values: s.values.map((v, vi) => (si === 0 && vi === 0 ? 42.5 : Number(v))),
    }));
    expect(editor.execute("object.edit", objectEditRequest(sel, {
      kind: "chartData",
      categories: editedCategories,
      series: editedSeries,
    })).accepted).toBe(true);
    await confirm(1);

    const exported = doc!.exportHwpWithReport!();
    let editedBytes: Uint8Array;
    try {
      expect(JSON.parse(exported.contentLoss())).toMatchObject({ count: 0 });
      editedBytes = exported.takeBytes();
    } finally { exported.free(); }

    const outDir = process.env.GEUL_STAGE3_OUT;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, "hwp-chart-7406-orig.hwp"), bytes);
      writeFileSync(resolve(outDir, "hwp-chart-7406-edited.hwp"), editedBytes);
    }

    const reopened = new engine.HwpDocument(editedBytes) as RhwpDocument & { getControls(): string; getTextFileText(): string };
    try {
      const live = doc! as RhwpDocument & { getControls(): string; getTextFileText(): string };
      expect(reopened.pageCount()).toBe(live.pageCount());
      expect(reopened.getTextFileText()).toBe(live.getTextFileText());
      expect(reopened.getControls()).toBe(live.getControls());
      expect(hwpReopenEqual(hwpReopenModel(doc!), hwpReopenModel(reopened), baseline)).toBe(true);
      const got = JSON.parse(reopened.getChartData!(0, 0, 2)) as typeof initial;
      expect(got.labels).toEqual(editedCategories);
      if (initial.series[0]!.name !== null) expect(got.series[0]!.name).toBe(`${initial.series[0]!.name} HWP`);
      expect(Number(got.series[0]!.values[0])).toBe(42.5);
    } finally { reopened.free(); }

    expect(editor.undo()).toBe(true);
    await confirm(2);
    expect(JSON.parse(doc!.getChartData!(0, 0, 2))).toMatchObject({ labels: initial.labels, series: initial.series });
    expect(editor.redo()).toBe(true);
    await confirm(3);
    expect(JSON.parse(doc!.getChartData!(0, 0, 2)).labels).toEqual(editedCategories);
    expect(Number(JSON.parse(doc!.getChartData!(0, 0, 2)).series[0].values[0])).toBe(42.5);
  } finally { editor.dispose(); }
});
