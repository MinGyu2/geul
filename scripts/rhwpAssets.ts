import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { canonical, identityFrom, type BuildIdentity } from "../src/components/Editor/rhwp/rhwpArtifactIdentity";

const names = ["rhwp.js", "rhwp_bg.wasm"] as const;
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export async function readRhwpGeneration(root: string): Promise<BuildIdentity | null> {
  if (!existsSync(join(root, "BUILD.json"))) return null; // Frontend-only CI needs no engine.
  const identity = await identityFrom(JSON.parse(readFileSync(join(root, "BUILD.json"), "utf8")));
  const selected = join(root, "generations", identity.generation);
  await verifyDirectory(selected, identity);
  return identity;
}

async function verifyDirectory(selected: string, identity: BuildIdentity): Promise<void> {
  const immutable = await identityFrom(JSON.parse(readFileSync(join(selected, "BUILD.json"), "utf8")));
  if (canonical(immutable) !== canonical(identity)) throw new Error("RHWP generation identity mismatch");
  for (const name of names) if (hash(join(selected, name)) !== identity.artifacts[name]) throw new Error(`RHWP generation hash mismatch: ${name}`);
}

export async function copyRhwpGeneration(source: string, output: string, identity: BuildIdentity): Promise<void> {
  const selected = join(source, "generations", identity.generation);
  const destination = join(output, "generations", identity.generation);
  mkdirSync(destination, { recursive: true });
  for (const name of [...names, "BUILD.json"]) copyFileSync(join(selected, name), join(destination, name));
  await verifyDirectory(destination, identity);
  // Vite may have copied a newer selector while a concurrent build published.
  // Replace it with the one captured at build start, after its files are ready.
  const pending = join(output, ".BUILD.json.pending");
  writeFileSync(pending, canonical(identity) + "\n");
  renameSync(pending, join(output, "BUILD.json"));
  const copied = await readRhwpGeneration(output);
  if (copied?.generation !== identity.generation) throw new Error("RHWP frontend generation changed");
}

export function rhwpGenerationPlugin(): Plugin {
  let source = "";
  let output = "";
  let selected: BuildIdentity | null = null;
  return {
    name: "rhwp-generation", apply: "build",
    configResolved(config) {
      source = join(config.publicDir, "rhwp");
      output = join(resolve(config.root, config.build.outDir), "rhwp");
    },
    async buildStart() { selected = await readRhwpGeneration(source); },
    async closeBundle() { if (selected) await copyRhwpGeneration(source, output, selected); },
  };
}
