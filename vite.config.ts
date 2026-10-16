import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// Tauri 개발 서버 규칙: 고정 포트, 오류 시 다른 포트로 바꾸지 않음, src-tauri 변경은 감시하지 않음.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    ...(host ? { hmr: { protocol: "ws", host, port: 1421 } } : {}),
    watch: { ignored: ["**/src-tauri/**", "**/external/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // Linux/macOS WebView(WebKit)와 Windows WebView2에서 지원하는 문법으로 낮춘다.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
