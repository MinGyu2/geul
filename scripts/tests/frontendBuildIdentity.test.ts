import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { build } from "vite";
import { frontendBuildIdentity } from "../frontendBuildIdentity";

const folders: string[] = [];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(envFile?: string) {
  const root = mkdtempSync(join(tmpdir(), "geul-build-identity-"));
  folders.push(root);
  writeFileSync(join(root, "index.html"), '<!doctype html><html><head><title>fixture</title></head><body><main>fixture</main><script type="module" src="/src/main.js"></script></body></html>\n');
  const source = join(root, "src");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "main.js"), 'import "./style.css"; document.querySelector("main").dataset.ready = "yes";\n');
  writeFileSync(join(source, "style.css"), 'main { color: rgb(12, 34, 56); }\n');
  if (envFile) writeFileSync(join(root, envFile), "VITE_GEUL_TEST_HOOKS=1\n");
  return root;
}

async function output(root: string, mode = "production") {
  await build({
    configFile: false,
    root,
    mode,
    logLevel: "silent",
    plugins: [frontendBuildIdentity()],
    build: { outDir: "dist", emptyOutDir: true },
  });
  const out = join(root, "dist");
  return { out, manifest: JSON.parse(readFileSync(join(out, "frontend-build.json"), "utf8")) };
}

afterEach(() => {
  for (const root of folders.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("frontend build identity uses emitted Vite bytes and actual build flags", () => {
  test("normal production build records its mode, entrypoints, and HTML/JS/CSS hashes", async () => {
    const root = fixture();
    const { out, manifest } = await output(root);
    const html = readFileSync(join(out, "index.html"));
    expect(manifest).toMatchObject({ schema: "geul.frontend-build.v1", mode: "production", testFlags: {} });
    expect(manifest.indexSourceSha256).toBe(sha(html));
    const entrypoints = Array.from(html.toString().matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), match => match[1]).sort();
    expect(manifest.entrypoints).toEqual(entrypoints);
    expect(entrypoints.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.assets)).toEqual(expect.arrayContaining(entrypoints.map(path => path.slice(1))));
    expect(Object.keys(manifest.assets).some((path: string) => path.endsWith(".js"))).toBe(true);
    expect(Object.keys(manifest.assets).some((path: string) => path.endsWith(".css"))).toBe(true);
    for (const [path, digest] of Object.entries(manifest.assets) as [string, string][]) {
      expect(digest).toBe(sha(readFileSync(join(out, path))));
    }
  });

  test("test flags from .env.production are recorded even when absent from process.env", async () => {
    const root = fixture(".env.production");
    const old = process.env.VITE_GEUL_TEST_HOOKS;
    delete process.env.VITE_GEUL_TEST_HOOKS;
    try {
      const { manifest } = await output(root);
      expect(manifest.mode).toBe("production");
      expect(manifest.testFlags).toEqual({ VITE_GEUL_TEST_HOOKS: "1" });
    } finally {
      if (old === undefined) delete process.env.VITE_GEUL_TEST_HOOKS;
      else process.env.VITE_GEUL_TEST_HOOKS = old;
    }
  });

  test("unknown process test flags are recorded and non-production mode is retained", async () => {
    const root = fixture();
    const name = "VITE_GEUL_TEST_UNRECOGNIZED";
    const old = process.env[name];
    process.env[name] = "surprise";
    try {
      const { manifest } = await output(root, "staging");
      expect(manifest.mode).toBe("staging");
      expect(manifest.testFlags).toEqual({ [name]: "surprise" });
    } finally {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    }
  });
});
