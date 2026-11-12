// Build-time evidence, embedded with the frontend. Runtime environment is separate evidence.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Plugin } from "vite";

export function frontendBuildIdentity(): Plugin {
  let output = "";
  let mode = "";
  let testFlags: Record<string, string> = {};
  return {
    name: "frontend-build-identity",
    apply: "build",
    configResolved(config) {
      output = resolve(config.root, config.build.outDir);
      mode = config.mode;
      testFlags = Object.fromEntries(Object.entries({ ...process.env, ...config.env })
        .filter(([key]) => key.startsWith("VITE_GEUL_TEST_"))) as Record<string, string>;
    },
    closeBundle() {
      const assets: Record<string, string> = {};
      const visit = (dir: string) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, item.name);
          if (item.isDirectory() && item.name === "assets") visit(path);
          else if (/\.(?:js|css)$/.test(item.name)) {
            assets[relative(output, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
          }
        }
      };
      visit(output);
      // Tauri parses HTML and adds CSP/nonces. Hash JS/CSS bytes and compare the
      // actual entrypoint URLs; retain the original HTML hash as build evidence.
      const html = readFileSync(join(output, "index.html"), "utf8");
      const entrypoints = Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), match => match[1]).sort();
      writeFileSync(join(output, "frontend-build.json"), JSON.stringify({
        schema: "geul.frontend-build.v1", mode, testFlags, assets, entrypoints,
        indexSourceSha256: createHash("sha256").update(html).digest("hex"),
      }) + "\n");
    },
  };
}
