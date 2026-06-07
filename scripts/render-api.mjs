#!/usr/bin/env node
import fs from "node:fs";

const API_BASE = "https://api.render.com/v1";
const KEY_PATHS = ["/Users/jamesgalbraith/code/label-printer/.env.prod", "/Users/jamesgalbraith/.render.env"];

function readEnvValue(raw, key) {
  const line = raw
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

function loadApiKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  for (const filePath of KEY_PATHS) {
    if (!fs.existsSync(filePath)) continue;
    const key = readEnvValue(fs.readFileSync(filePath, "utf8"), "RENDER_API_KEY");
    if (key) return key;
  }
  throw new Error("No Render API key found.");
}

async function request(pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${loadApiKey()}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
  }
  return { status: response.status, ok: response.ok, body };
}

const [command, id] = process.argv.slice(2);

if (command === "services") {
  console.log(JSON.stringify(await request("/services?limit=100"), null, 2));
} else if (command === "owners") {
  console.log(JSON.stringify(await request("/owners?limit=100"), null, 2));
} else if (command === "service" && id) {
  console.log(JSON.stringify(await request(`/services/${id}`), null, 2));
} else if (command === "deploys" && id) {
  console.log(JSON.stringify(await request(`/services/${id}/deploys?limit=20`), null, 2));
} else {
  console.error("Usage: node scripts/render-api.mjs services|owners|service <id>|deploys <serviceId>");
  process.exit(2);
}
