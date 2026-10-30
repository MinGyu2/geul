import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { canonical, identityFrom, type BuildIdentity } from "../src/components/Editor/rhwp/rhwpArtifactIdentity";

const names = ["rhwp.js", "rhwp_bg.wasm"] as const;
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export type RhwpProfile = "release" | "debug";

export async function readRhwpGeneration(root: string, profile: RhwpProfile = "release"): Promise<BuildIdentity> {
  // Never consult the mutable legacy BUILD selector for product selection.
  // Development prefers Debug; an absent Debug pointer permits Release.
  const selectedProfile = profile === "debug" && existsSync(join(root, "DEBUG.json")) ? "debug" : "release";
  const pointer = join(root, selectedProfile.toUpperCase() + ".json");
  if (!existsSync(pointer)) throw new Error(`RHWP requires ${selectedProfile} generation: build WASM first (${pointer})`);
  const identity = await identityFrom(JSON.parse(readFileSync(pointer, "utf8")));
  if (identity.profile !== selectedProfile) throw new Error(`RHWP ${selectedProfile} selector contains ${identity.profile} WASM`);
  await verifyDirectory(join(root, "generations", identity.generation), identity);
  return identity;
}

async function verifyDirectory(selected: string, identity: BuildIdentity): Promise<void> {
  const immutable = await identityFrom(JSON.parse(readFileSync(join(selected, "BUILD.json"), "utf8")));
  if (canonical(immutable) !== canonical(identity)) throw new Error("RHWP generation identity mismatch");
  for (const name of names) if (hash(join(selected, name)) !== identity.artifacts[name]) throw new Error(`RHWP generation hash mismatch: ${name}`);
}

export async function copyRhwpGeneration(source: string, output: string, identity: BuildIdentity): Promise<void> {
  const selected = join(source, "generations", identity.generation);
  // Recheck captured files, never re-read a mutable profile pointer.
  await verifyDirectory(selected, identity);
  const destination = join(output, "generations", identity.generation);
  mkdirSync(destination, { recursive: true });
  for (const name of [...names, "BUILD.json"]) cpSync(join(selected, name), join(destination, name));
  await verifyDirectory(destination, identity);
  const pending = join(output, ".BUILD.json.pending");
  writeFileSync(pending, canonical(identity) + "\n");
  renameSync(pending, join(output, "BUILD.json"));
}

export function rhwpGenerationPlugin(): Plugin {
  let source = "";
  let output = "";
  let publicDir = "";
  let profile: RhwpProfile = "release";
  let frontendOnly = false;
  let build = false;
  let selected: BuildIdentity | null = null;
  return {
    name: "rhwp-generation",
    apply: (_config, { command, mode }) => command === "build" || mode !== "test",
    config() { return { build: { copyPublicDir: false } }; },
    configResolved(config) {
      publicDir = config.publicDir;
      build = config.command === "build";
      source = join(publicDir, "rhwp");
      output = resolve(config.root, config.build.outDir);
      frontendOnly = config.mode === "frontend-only";
      const explicit = process.env.GEUL_RHWP_PROFILE;
      if (frontendOnly && (explicit || process.env.TAURI_ENV_PLATFORM)) throw new Error("Tauri product builds cannot use frontend-only mode");
      if (explicit !== undefined && explicit !== "release" && explicit !== "debug") throw new Error("Invalid GEUL_RHWP_PROFILE");
      profile = explicit ?? (config.command === "serve" ? "debug" : "release");
      // Vite's default public copy would include unrelated Debug generations
      // and a racing legacy selector. Copy other public assets in closeBundle.
    },
    async buildStart() { selected = frontendOnly ? null : await readRhwpGeneration(source, profile); },
    configureServer(server) {
      // buildStart captures once for the dev server as well. The immutable URL
      // remains the module-cache key; restart Vite to select a newly built WASM.
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        const artifact = pathname?.match(/^\/rhwp\/generations\/([0-9a-f]{64})\/(rhwp\.js|rhwp_bg\.wasm|BUILD\.json)$/);
        if (artifact) {
          // Vite's ?import transform rejects JS under public/ and would change
          // verified bytes. Serve retained immutable generations before that
          // transform, including requests from older module-cache readers.
          try {
            const bytes = readFileSync(join(source, "generations", artifact[1]!, artifact[2]!));
            response.setHeader("Content-Type", artifact[2] === "rhwp.js" ? "application/javascript" : artifact[2] === "rhwp_bg.wasm" ? "application/wasm" : "application/json");
            response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            response.setHeader("Content-Length", bytes.byteLength);
            response.end(request.method === "HEAD" ? undefined : bytes);
          } catch {
            response.statusCode = 404;
            response.end("RHWP immutable artifact unavailable");
          }
          return;
        }
        if (pathname !== "/rhwp/BUILD.json") return next();
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json");
        response.statusCode = selected ? 200 : 404;
        response.end(selected ? canonical(selected) + "\n" : "RHWP generation unavailable");
      });
    },
    async closeBundle() {
      if (!build || !output) return;
      mkdirSync(output, { recursive: true });
      if (existsSync(publicDir)) for (const name of readdirSync(publicDir)) {
        if (name !== "rhwp") cpSync(join(publicDir, name), join(output, name), { recursive: true });
      }
      if (selected) await copyRhwpGeneration(source, join(output, "rhwp"), selected);
    },
  };
}
