// @vitest-environment jsdom
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { controlledBackend, info, loaded, ok, flush } from "../../src/components/Editor/rhwp/testing";

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
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: () => doc }), { natural: null });
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
    expect(selected).toMatchObject({ kind: "chart", editable: false, address: { engine: "rhwp", path: [0, 0, 2] } });
    expect(selected?.graphic).toMatchObject({ kind: "chart", plot: "bar", title: null, series: JSON.parse(initial).series });
    expect(editor.typeText("ignored")).toBe(false);
    expect(editor.execute("object.deselect").accepted).toBe(true);
    expect(editor.objectSelection).toBeNull();
    expect(doc.getChartData!(0, 0, 2)).toBe(initial);
    expect(calls.filter(call => call.method === "commit")).toEqual([]);
  } finally { editor.dispose(); }
});
