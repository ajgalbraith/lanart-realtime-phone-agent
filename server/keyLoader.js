import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const home = os.homedir();
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_ROOTS = [
  appRoot,
  path.resolve(appRoot, ".."),
  path.join(home, "code"),
  path.join(home, "Documents", "Codex"),
  path.join(home, ".codex"),
  path.join(home, ".openclaw"),
];

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "dist",
  "node_modules",
  "Library",
]);

let cachedKey = null;
let cachedAt = 0;

function isEnvLike(filePath) {
  const base = path.basename(filePath).toLowerCase();
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".env") ||
    base.includes("openai") ||
    base.includes("secret") ||
    base.includes("key")
  );
}

function walkFiles(root, files = [], depth = 0) {
  if (depth > 7 || !fs.existsSync(root)) return files;

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && !entry.name.startsWith(".env") && entry.name !== ".codex") {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkFiles(fullPath, files, depth + 1);
      continue;
    }

    if (entry.isFile() && isEnvLike(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function readOpenAIKey(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.includes("OPENAI_API_KEY") && !raw.includes("sk-")) return null;
    const parsed = dotenv.parse(raw);
    return parsed.OPENAI_API_KEY || null;
  } catch {
    return null;
  }
}

export function loadOpenAIKey({ refresh = false } = {}) {
  if (!refresh && cachedKey && Date.now() - cachedAt < 30_000) {
    return cachedKey;
  }

  if (process.env.OPENAI_API_KEY) {
    cachedKey = {
      apiKey: process.env.OPENAI_API_KEY,
      sourceKind: "environment",
      sourcePath: "process.env.OPENAI_API_KEY",
      foundAt: new Date().toISOString(),
    };
    cachedAt = Date.now();
    return cachedKey;
  }

  const candidates = [];
  for (const root of SEARCH_ROOTS) {
    for (const filePath of walkFiles(root)) {
      const apiKey = readOpenAIKey(filePath);
      if (!apiKey) continue;
      const stat = fs.statSync(filePath);
      candidates.push({ filePath, apiKey, mtimeMs: stat.mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = candidates[0];

  if (selected) {
    cachedKey = {
      apiKey: selected.apiKey,
      sourceKind: "env-file",
      sourcePath: selected.filePath,
      foundAt: new Date().toISOString(),
    };
  } else {
    cachedKey = {
      apiKey: null,
      sourceKind: "missing",
      sourcePath: null,
      foundAt: new Date().toISOString(),
    };
  }

  cachedAt = Date.now();
  return cachedKey;
}

export function publicKeyStatus() {
  const key = loadOpenAIKey();
  return {
    available: Boolean(key.apiKey),
    sourceKind: key.sourceKind,
    sourcePath: key.sourcePath,
    foundAt: key.foundAt,
  };
}
