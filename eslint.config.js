import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  js.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    languageOptions: {
      globals: {
        atob: "readonly",
        btoa: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        AudioContext: "readonly",
        WebSocket: "readonly",
        MediaStreamAudioSourceNode: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        URL: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        Blob: "readonly",
        FileReader: "readonly",
        HTMLDivElement: "readonly",
        atob: "readonly",
        btoa: "readonly",
        fetch: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
    },
  },
];
