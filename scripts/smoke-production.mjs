#!/usr/bin/env node
import fs from "node:fs";
import WebSocket from "ws";

const HTTP_BASE_URL = process.env.SMOKE_HTTP_BASE_URL || "https://lanart-realtime-phone-agent.onrender.com";
const BASE_URL = process.env.SMOKE_BASE_URL || HTTP_BASE_URL.replace(/^http/, "ws") + "/realtime";
const SMOKE_TOOL = process.env.SMOKE_TOOL || "meta";
const TIMEOUT_MS = 45_000;

function loadAuth() {
  if (process.env.SMOKE_USERNAME && process.env.SMOKE_PASSWORD) {
    return { username: process.env.SMOKE_USERNAME, password: process.env.SMOKE_PASSWORD };
  }
  const auth = JSON.parse(fs.readFileSync(".auth.local.json", "utf8"));
  return { username: auth.username, password: auth.password };
}

async function loginCookie() {
  const auth = loadAuth();
  const response = await fetch(`${HTTP_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(auth),
  });
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${await response.text()}`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Login did not return a session cookie.");
  return cookie;
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function main() {
  const cookie = await loginCookie();
  const ws = new WebSocket(BASE_URL, { headers: { Cookie: cookie } });
  const events = [];
  let assistantText = "";
  let toolStarted = 0;
  let toolDone = 0;
  let fatal = null;
  let connected = false;
  let turnDoneCount = 0;
  let mcpStatus = null;

  ws.on("message", (data) => {
    const event = JSON.parse(data.toString());
    events.push(event.type);
    if (event.type === "session.state" && event.state === "connected") connected = true;
    if (event.type === "mcp.status") mcpStatus = event;
    if (event.type === "tool.started") toolStarted += 1;
    if (event.type === "tool.done") toolDone += 1;
    if (event.type === "assistant.delta") assistantText += event.text ?? "";
    if (event.type === "assistant.done") assistantText += event.text ?? "";
    if (event.type === "turn.done") turnDoneCount += 1;
    if (event.type === "fatal" || event.type === "error") fatal = event.message || JSON.stringify(event.error ?? event);
  });

  await waitForOpen(ws);
  ws.send(
    JSON.stringify({
      type: "session.start",
      serverNames: [],
      responseMode: "text",
      instructions:
        "Production smoke test. You must use the requested cloud tool. Do not send email, do not update budgets, and do not call any write tool.",
    }),
  );

  const startedAt = Date.now();
  while (!connected && !fatal && Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!connected) throw new Error(fatal || "Realtime session did not connect.");

  const text =
    SMOKE_TOOL === "gmail"
      ? "This is a required tool test. Call cloud_search_recent_emails with query newer_than:2d and maxResults 1 now. Then reply with only the subject and from value from the tool output."
      : "This is a required tool test. Call cloud_list_top_meta_ads with datePreset today and limit 2 now. Then reply with only the ad names and spend values from the tool output.";

  ws.send(JSON.stringify({ type: "message.send", text }));

  while ((toolDone < 1 || turnDoneCount < 2) && !fatal && Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  ws.close();
  if (fatal) throw new Error(fatal);
  if (turnDoneCount < 1) throw new Error("Realtime turn did not finish.");
  const summary = {
    connected,
    smokeTool: SMOKE_TOOL,
    toolStarted,
    toolDone,
    turnDoneCount,
    assistantPreview: assistantText.replace(/\s+/g, " ").trim().slice(0, 1000),
    mcpToolCount: mcpStatus?.tools?.length ?? null,
    cloudTools: mcpStatus?.tools?.filter?.((tool) => tool.serverName === "cloud").map((tool) => tool.functionName) ?? null,
    eventTypes: [...new Set(events)],
  };
  if (toolStarted < 1 || toolDone < 1) {
    console.log(JSON.stringify(summary, null, 2));
    throw new Error("Cloud tool was not executed.");
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
