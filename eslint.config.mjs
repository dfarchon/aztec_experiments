import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["apps/dist", "apps/src/df-billboard-test/node_modules"]),
  {
    files: ["apps/src/df-billboard-test/**/*.{ts,tsx,mjs}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      prettierConfig,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      parserOptions: { sourceType: "module" },
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
      "react-hooks": reactHooks,
    },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
      "no-compare-neg-zero": "off",
    },
  },
  {
    // Existing SDK adapters opt out of type checking; keep this exception narrow.
    files: [
      "apps/src/df-billboard-test/controller.ts",
      "apps/src/df-billboard-test/toxicity.worker.ts",
    ],
    rules: { "@typescript-eslint/ban-ts-comment": "off" },
  },
]);
