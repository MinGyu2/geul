// Public artifact schema shared by runtime and Vite publication checks.
export type BuildIdentity = {
  schemaVersion: number;
  engine: string;
  commit: string;
  profile: string;
  tools: Record<string, string>;
  sourceFingerprint: string;
  generation: string;
  artifacts: Record<"rhwp.js" | "rhwp_bg.wasm", string>;
  optimization?: { tool: string; version: string | null; flags: string[] };
};
const digestPattern = /^[0-9a-f]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(",") === expected.sort().join(",");
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const sha256 = async (bytes: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export async function identityFrom(value: unknown): Promise<BuildIdentity> {
  if (!isRecord(value) || !keysAre(value, ["schemaVersion", "engine", "commit", "profile", "tools", "sourceFingerprint", "generation", "artifacts", ...(value.schemaVersion === 2 ? ["optimization"] : [])]) ||
      ![1, 2].includes(Number(value.schemaVersion)) || typeof value.schemaVersion !== "number" || value.engine !== "rhwp" || typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit) ||
      typeof value.profile !== "string" || !["debug", "release"].includes(value.profile) || !isRecord(value.tools) || !keysAre(value.tools, ["cargo", "rustc", "wasm-bindgen"]) ||
      Object.values(value.tools).some((version) => typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) ||
      !isRecord(value.artifacts) || !keysAre(value.artifacts, ["rhwp.js", "rhwp_bg.wasm"]) ||
      [value.generation, value.sourceFingerprint, ...Object.values(value.artifacts)].some((hash) => typeof hash !== "string" || !digestPattern.test(hash))) {
    throw new Error("rhwp build identity schema");
  }
  if (value.schemaVersion === 2) {
    const none = { tool: "none", version: null, flags: [] };
    const optimized = { tool: "wasm-opt", version: "117", flags: ["-O"] };
    if (canonical(value.optimization) !== canonical(none) && !(value.profile === "release" && canonical(value.optimization) === canonical(optimized))) throw new Error("rhwp optimizer configuration");
  }
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "generation"));
  if (await sha256(new TextEncoder().encode(canonical(unsigned) + "\n").buffer) !== value.generation) throw new Error("rhwp generation identity hash");
  return value as BuildIdentity;
}
