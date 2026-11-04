// The loader exposes createEmptyDocument only when the verified generation's shared
// HwpDocument.createEmpty factory is callable. Opening never depends on it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonical, sha256 } from "./rhwpArtifactIdentity";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

async function artifacts() {
  const js = bytes("generated js"), wasm = bytes("generated wasm");
  const unsigned = {
    schemaVersion: 1, engine: "rhwp", commit: "1a76570e833917d15817415a53c09ad61ab3203f", profile: "debug",
    tools: { cargo: "1.99.0", rustc: "1.99.0", "wasm-bindgen": "0.2.127" },
    sourceFingerprint: "d".repeat(64), artifacts: { "rhwp.js": await sha256(js), "rhwp_bg.wasm": await sha256(wasm) },
  };
  const generation = await sha256(new TextEncoder().encode(canonical(unsigned) + "\n").buffer);
  const build = new TextEncoder().encode(JSON.stringify({ ...unsigned, generation })).buffer;
  const files: Record<string, ArrayBuffer> = { "/rhwp/BUILD.json": build, [`/rhwp/generations/${generation}/BUILD.json`]: build,
    [`/rhwp/generations/${generation}/rhwp.js`]: js, [`/rhwp/generations/${generation}/rhwp_bg.wasm`]: wasm };
  return async (url: string) => new Response(files[url]!, { status: files[url] ? 200 : 404 });
}

async function load(createEmpty: unknown) {
  vi.resetModules(); // the loader caches one module per process
  const { loadRhwpModule } = await import("./rhwpModule");
  const opened: Uint8Array[] = [];
  class HwpDocument { constructor(input: Uint8Array) { opened.push(input); } }
  if (createEmpty !== undefined) Object.assign(HwpDocument, { createEmpty });
  const module = await loadRhwpModule(async () => ({ default: async () => ({}), HwpDocument }), await artifacts());
  return { module, opened, HwpDocument };
}

beforeEach(() => vi.restoreAllMocks());

describe("RHWP shared creation factory", () => {
  it("the verified API exists: createEmptyDocument calls HwpDocument.createEmpty", async () => {
    const model = { kind: "blank" };
    const createEmpty = vi.fn(() => model);
    const { module, HwpDocument } = await load(createEmpty);
    expect(module.createEmptyDocument?.()).toBe(model);
    expect(createEmpty).toHaveBeenCalledTimes(1);
    expect(createEmpty.mock.contexts[0]).toBe(HwpDocument);
  });

  it.each([["missing", undefined], ["non-callable", 42], ["non-callable object", {}]])("a %s factory is not exposed and never called; opening still works", async (_label, createEmpty) => {
    const { module, opened } = await load(createEmpty);
    expect(module.createEmptyDocument).toBeUndefined();
    const input = new Uint8Array([1, 2]);
    expect(module.openDocument(input)).toBeTruthy();
    expect(opened).toEqual([input]);
  });
});
