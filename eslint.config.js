import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // public/rhwp/: wasm-bindgen이 만든 rhwp WASM 접착 코드(scripts/build-rhwp-wasm.sh 산출물, Git 무시). target/: 빌드 캐시.
  { ignores: ["dist/", "src-tauri/", "external/", "node_modules/", "coverage/", "public/rhwp/", "target/"] },
  {
    files: ["**/*.{ts,tsx,js}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node } },
  },
);
