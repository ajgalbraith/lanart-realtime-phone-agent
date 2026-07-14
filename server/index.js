import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import { clearSessionCookie, createSessionCookie, publicAuthStatus, readSession, requireAuth, verifyCredentials } from "./auth.js";
import { loadCodexMcpConfig } from "./codexConfig.js";
import { callCloudTool, getCloudPublicTools, getCloudRealtimeTools, getCloudTool } from "./cloudTools.js";
import { loadOpenAIKey, publicKeyStatus } from "./keyLoader.js";
import { McpManager } from "./mcpManager.js";
import { PhoneRealtimeBridge, registerAllowedPhoneCall } from "./phoneBridge.js";
import { estimateRealtimeCost, estimateTranscriptionCost, GPT_REALTIME_2_1_MINI_PRICING, REALTIME_MODEL } from "./pricing.js";
import {
  buildExternalUrl,
  getPhoneAgentPaths,
  loadTwilioConfig,
  normalizePhoneNumber,
  publicTwilioStatus,
  purchasePhoneNumber,
  searchAvailableLocalNumbers,
  toWebSocketUrl,
  validateTwilioWebhook,
} from "./twilioConfig.js";

const PORT = Number(process.env.PORT || 8797);
const HOST = process.env.HOST || "0.0.0.0";
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(appRoot, "dist");
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
const DEBUG_REALTIME = process.env.DEBUG_REALTIME === "1";

const DEFAULT_SELECTED_MCPS = [];

const SYSTEM_INSTRUCTIONS = `You are a local Codex-like assistant for James Galbraith, Vice President of Lanart Rug Inc.

Work pragmatically and verify real state through tools when useful. Use MCP tools when they are relevant, but keep tool calls narrow and explain important limitations in plain language.

Company details:
James Galbraith
Vice President, Lanart Rug Inc
300 Rue Saint-Louis, Saint-Jean-sur-Richelieu, QC J3B 1Y4, Canada
Phone: +1-438-787-0109
Email: james@lanartrug.com

Never guess service domains. If a request depends on a website or service domain, verify the official domain before using it.

Colleagues include Rachel (rgagnon@lanartrug.com), Alex (alex@lanartrug.com), Derek (derek@lanartrug.com), Guilaume (guillaume@lanartrug.com), and Gen (gen@lanartrug.com).`;

function safetyIdentifier() {
  const raw = `${os.userInfo().username}:${os.hostname()}:lanart-realtime-lab`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function sendJson(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function parseJson(data) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function debugRealtime(...args) {
  if (DEBUG_REALTIME) console.log("[realtime]", ...args);
}

function parseArguments(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function addUsageTotals(totals, usage) {
  if (!usage) return totals;
  const next = { ...totals };
  next.total_tokens += usage.total_tokens ?? 0;
  next.input_tokens += usage.input_tokens ?? 0;
  next.output_tokens += usage.output_tokens ?? 0;
  next.input_text_tokens += usage.input_token_details?.text_tokens ?? 0;
  next.input_audio_tokens += usage.input_token_details?.audio_tokens ?? 0;
  next.input_image_tokens += usage.input_token_details?.image_tokens ?? 0;
  next.cached_tokens += usage.input_token_details?.cached_tokens ?? 0;
  next.output_text_tokens += usage.output_token_details?.text_tokens ?? 0;
  next.output_audio_tokens += usage.output_token_details?.audio_tokens ?? 0;
  return next;
}

class RealtimeBridge {
  constructor(clientWs) {
    this.clientWs = clientWs;
    this.openaiWs = null;
    this.mcp = null;
    this.pendingApprovals = new Map();
    this.handledCalls = new Set();
    this.emittedTextItems = new Set();
    this.responseMode = "text";
    this.voiceMode = false;
    this.voice = "marin";
    this.costTotal = 0;
    this.usageTotals = {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      input_text_tokens: 0,
      input_audio_tokens: 0,
      input_image_tokens: 0,
      cached_tokens: 0,
      output_text_tokens: 0,
      output_audio_tokens: 0,
    };
  }

  async start(payload) {
    const key = loadOpenAIKey();
    if (!key.apiKey) {
      sendJson(this.clientWs, {
        type: "fatal",
        message: "No OPENAI_API_KEY was found in the environment or recent .env files.",
      });
      return;
    }

    const { rawServers } = loadCodexMcpConfig();
    const selectedMcpServers = Array.isArray(payload.serverNames) ? payload.serverNames : [];
    this.voiceMode = payload.voiceMode === true;
    this.responseMode = this.voiceMode || payload.responseMode === "audio" ? "audio" : "text";
    this.voice = typeof payload.voice === "string" && payload.voice ? payload.voice : "marin";

    this.mcp = new McpManager(rawServers);
    const serverStates = await this.mcp.connectSelected(selectedMcpServers);
    sendJson(this.clientWs, {
      type: "mcp.status",
      servers: serverStates,
      tools: [...this.mcp.getPublicTools(), ...getCloudPublicTools()],
    });

    this.openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "OpenAI-Safety-Identifier": safetyIdentifier(),
      },
    });

    this.openaiWs.on("open", () => {
      sendJson(this.clientWs, {
        type: "session.state",
        state: "connected",
        model: REALTIME_MODEL,
        keySource: { sourceKind: key.sourceKind, sourcePath: key.sourcePath },
      });
      this.sendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: payload.instructions
            ? `${SYSTEM_INSTRUCTIONS}\n\nAdditional instructions from dashboard:\n${payload.instructions}`
            : SYSTEM_INSTRUCTIONS,
          output_modalities: [this.responseMode],
          max_output_tokens: 4096,
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
              },
              noise_reduction: { type: "near_field" },
              turn_detection: this.voiceMode
                ? {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 650,
                    create_response: true,
                    interrupt_response: true,
                  }
                : null,
            },
            output: {
              format: { type: "audio/pcm", rate: 24000 },
              voice: this.voice,
            },
          },
          tools: [...this.mcp.getRealtimeTools(), ...getCloudRealtimeTools()],
          tool_choice: "auto",
          tracing: "auto",
          truncation: {
            type: "retention_ratio",
            retention_ratio: 0.85,
          },
        },
      });
    });

    this.openaiWs.on("message", (data) => {
      const event = parseJson(data);
      if (event) void this.handleOpenAIEvent(event);
    });

    this.openaiWs.on("close", (code, reason) => {
      sendJson(this.clientWs, {
        type: "session.state",
        state: "disconnected",
        code,
        reason: reason?.toString(),
      });
    });

    this.openaiWs.on("error", (error) => {
      sendJson(this.clientWs, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  sendOpenAI(event) {
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify(event));
    }
  }

  createResponse(mode = this.responseMode) {
    this.sendOpenAI({
      type: "response.create",
      response: {
        output_modalities: [mode],
        audio: {
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: this.voice,
          },
        },
      },
    });
  }

  sendText(text) {
    if (!text?.trim()) return;
    this.responseMode = this.voiceMode ? "audio" : "text";
    this.sendOpenAI({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.createResponse(this.responseMode);
  }

  appendAudio(base64Audio) {
    if (!base64Audio) return;
    this.responseMode = "audio";
    this.sendOpenAI({ type: "input_audio_buffer.append", audio: base64Audio });
  }

  commitAudio() {
    if (this.voiceMode) return;
    this.responseMode = "audio";
    this.sendOpenAI({ type: "input_audio_buffer.commit" });
    this.createResponse("audio");
  }

  cancelResponse() {
    this.sendOpenAI({ type: "response.cancel" });
  }

  async handleOpenAIEvent(event) {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        sendJson(this.clientWs, {
          type: "session.updated",
          session: {
            id: event.session?.id,
            model: event.session?.model,
            output_modalities: event.session?.output_modalities,
            tools: event.session?.tools?.length ?? 0,
          },
        });
        break;
      case "response.output_text.delta":
      case "response.text.delta":
        debugRealtime("text.delta", event.delta);
        sendJson(this.clientWs, { type: "assistant.delta", text: event.delta ?? "" });
        break;
      case "response.output_text.done":
      case "response.text.done":
        debugRealtime("text.done", event.text);
        this.emitAssistantDoneText(event.text, event.item_id);
        break;
      case "response.content_part.done":
        debugRealtime("content_part.done", event.part?.type, event.part?.text ?? event.part?.transcript);
        this.emitAssistantDoneText(event.part?.text ?? event.part?.transcript, event.item_id);
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        sendJson(this.clientWs, { type: "assistant.delta", text: event.delta ?? "" });
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        sendJson(this.clientWs, { type: "audio.delta", audio: event.delta });
        break;
      case "response.output_audio.done":
      case "response.audio.done":
        sendJson(this.clientWs, { type: "voice.event", state: "assistant_done" });
        break;
      case "conversation.item.input_audio_transcription.delta":
        sendJson(this.clientWs, {
          type: "user.transcript.delta",
          itemId: event.item_id,
          text: event.delta ?? "",
        });
        break;
      case "conversation.item.input_audio_transcription.completed":
        sendJson(this.clientWs, {
          type: "user.transcript.done",
          itemId: event.item_id,
          text: event.transcript ?? "",
        });
        if (event.usage) {
          const cost = estimateTranscriptionCost(event.usage);
          this.costTotal += cost.usd;
          this.usageTotals = addUsageTotals(this.usageTotals, event.usage);
          sendJson(this.clientWs, {
            type: "usage.update",
            usage: event.usage,
            cost,
            totalCost: this.costTotal,
            totals: this.usageTotals,
            source: "input_transcription",
          });
        }
        break;
      case "conversation.item.input_audio_transcription.failed":
        sendJson(this.clientWs, {
          type: "voice.event",
          state: "transcription_failed",
          message: event.error?.message ?? "Input transcription failed",
        });
        break;
      case "input_audio_buffer.speech_started":
        sendJson(this.clientWs, { type: "voice.event", state: "user_speaking" });
        break;
      case "input_audio_buffer.speech_stopped":
        sendJson(this.clientWs, { type: "voice.event", state: "thinking" });
        break;
      case "input_audio_buffer.committed":
        sendJson(this.clientWs, {
          type: "voice.event",
          state: "committed",
          itemId: event.item_id,
          previousItemId: event.previous_item_id,
        });
        break;
      case "response.function_call_arguments.done":
        await this.handleFunctionCall({
          callId: event.call_id,
          functionName: event.name,
          argumentsRaw: event.arguments,
        });
        break;
      case "response.output_item.done":
        if (event.item?.type === "function_call") {
          await this.handleFunctionCall({
            callId: event.item.call_id,
            functionName: event.item.name,
            argumentsRaw: event.item.arguments,
          });
        } else if (event.item?.type === "message") {
          this.emitAssistantDoneText(extractTextFromItem(event.item), event.item.id);
        }
        break;
      case "response.done": {
        const usage = event.response?.usage;
        debugRealtime("response.done", event.response?.status, extractTextFromResponse(event.response), usage);
        const cost = estimateRealtimeCost(usage);
        this.costTotal += cost.usd;
        this.usageTotals = addUsageTotals(this.usageTotals, usage);
        sendJson(this.clientWs, {
          type: "usage.update",
          usage,
          cost,
          totalCost: this.costTotal,
          totals: this.usageTotals,
        });
        sendJson(this.clientWs, {
          type: "turn.done",
          status: event.response?.status,
          statusDetails: event.response?.status_details,
        });
        this.emitAssistantDoneTextFromResponse(event.response);
        if (event.response?.status && event.response.status !== "completed") {
          sendJson(this.clientWs, {
            type: "turn.status",
            status: event.response.status,
            statusDetails: event.response.status_details,
          });
        }
        break;
      }
      case "error":
        sendJson(this.clientWs, {
          type: "error",
          message: event.error?.message ?? "Realtime API error",
          error: event.error,
        });
        break;
      default:
        if (
          event.type?.startsWith("response.mcp_") ||
          event.type?.startsWith("mcp_") ||
          event.type?.startsWith("input_audio_buffer.")
        ) {
          sendJson(this.clientWs, { type: "realtime.event", event });
        }
    }
  }

  async handleFunctionCall({ callId, functionName, argumentsRaw }) {
    if (!callId || !functionName || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);

    const args = parseArguments(argumentsRaw);
    const cloudTool = getCloudTool(functionName);
    const tool = cloudTool
      ? {
          serverName: "cloud",
          originalName: cloudTool.name,
          requiresApproval: cloudTool.requiresApproval,
          cloud: true,
        }
      : this.mcp?.getTool(functionName);
    if (!tool) {
      this.sendToolOutput(callId, JSON.stringify({ error: `Unknown tool: ${functionName}` }));
      this.createResponse(this.responseMode);
      return;
    }

    const request = {
      callId,
      functionName,
      serverName: tool.serverName,
      toolName: tool.originalName,
      args,
      requiresApproval: tool.requiresApproval,
      cloud: tool.cloud === true,
    };

    if (tool.requiresApproval) {
      const approvalId = crypto.randomUUID();
      this.pendingApprovals.set(approvalId, request);
      sendJson(this.clientWs, { type: "approval.required", id: approvalId, request });
      return;
    }

    await this.executeToolCall(request);
  }

  async resolveApproval(id, approved) {
    const request = this.pendingApprovals.get(id);
    if (!request) return;
    this.pendingApprovals.delete(id);

    if (!approved) {
      const output = JSON.stringify({ error: "Tool call was rejected by the user." });
      this.sendToolOutput(request.callId, output);
      sendJson(this.clientWs, { type: "tool.rejected", request });
      this.createResponse(this.responseMode);
      return;
    }

    await this.executeToolCall(request);
  }

  async executeToolCall(request) {
    sendJson(this.clientWs, { type: "tool.started", request });
    try {
      const output = request.cloud
        ? await callCloudTool(request.functionName, request.args)
        : await this.mcp.callTool(request.functionName, request.args);
      sendJson(this.clientWs, {
        type: "tool.done",
        request,
        outputPreview: output.slice(0, 2000),
      });
      this.sendToolOutput(request.callId, output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(this.clientWs, { type: "tool.error", request, message });
      this.sendToolOutput(request.callId, JSON.stringify({ error: message }));
    }
    this.createResponse(this.responseMode);
  }

  sendToolOutput(callId, output) {
    this.sendOpenAI({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
  }

  emitAssistantDoneText(text, itemId) {
    if (!text || typeof text !== "string") return;
    if (itemId && this.emittedTextItems.has(itemId)) return;
    if (itemId) this.emittedTextItems.add(itemId);
    sendJson(this.clientWs, { type: "assistant.done", text });
  }

  emitAssistantDoneTextFromResponse(response) {
    if (!response || !Array.isArray(response.output)) return;
    for (const item of response.output) {
      if (item?.type === "message") this.emitAssistantDoneText(extractTextFromItem(item), item.id);
    }
  }

  async close() {
    this.openaiWs?.close();
    await this.mcp?.close();
  }
}

function extractTextFromItem(item) {
  if (!item || !Array.isArray(item.content)) return "";
  return item.content
    .map((part) => {
      if (part?.type === "output_text" || part?.type === "text") return part.text ?? "";
      if (part?.type === "output_audio" || part?.type === "audio") return part.transcript ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractTextFromResponse(response) {
  if (!response || !Array.isArray(response.output)) return "";
  return response.output
    .map((item) => (item?.type === "message" ? extractTextFromItem(item) : ""))
    .filter(Boolean)
    .join("\n");
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/status", (req, res) => {
  res.json(publicAuthStatus(req));
});

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!verifyCredentials(username, password)) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  res.setHeader("Set-Cookie", createSessionCookie(username, { secure }));
  res.json({ authenticated: true, username });
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookie());
  res.json({ authenticated: false });
});

if (fs.existsSync(distRoot)) {
  app.use(express.static(distRoot));
}

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth/")) {
    next();
    return;
  }
  requireAuth(req, res, next);
});

app.get("/api/status", (_req, res) => {
  const mcp = loadCodexMcpConfig();
  res.json({
    model: REALTIME_MODEL,
    pricing: GPT_REALTIME_2_1_MINI_PRICING,
    openaiKey: publicKeyStatus(),
    codexConfigPath: mcp.configPath,
    mcpServers: mcp.servers,
    defaultSelectedMcpServers: DEFAULT_SELECTED_MCPS.filter((name) =>
      mcp.servers.some((server) => server.name === name && server.enabled),
    ),
    cloudTools: getCloudPublicTools(),
  });
});

app.get("/api/phone/status", (req, res) => {
  res.json(publicTwilioStatus(req));
});

app.get(["/status", `${getPhoneAgentPaths().status}`], requireAuth, (req, res) => {
  res.json(publicTwilioStatus(req));
});

app.get("/api/phone/available-numbers", async (req, res) => {
  try {
    const areaCode = typeof req.query.areaCode === "string" ? req.query.areaCode : "438";
    const limit = Math.min(20, Math.max(1, Number(req.query.limit || 8)));
    const numbers = await searchAvailableLocalNumbers({ areaCode, limit });
    res.json({ country: "CA", areaCode, numbers });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/phone/purchase-number", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
    const confirm = String(req.body?.confirm || "");
    if (!phoneNumber) {
      res.status(400).json({ error: "phoneNumber is required." });
      return;
    }
    if (confirm !== `BUY ${phoneNumber}`) {
      res.status(400).json({ error: `Set confirm to "BUY ${phoneNumber}" to purchase this Twilio number.` });
      return;
    }

    const paths = getPhoneAgentPaths();
    const voiceUrl = buildExternalUrl(req, paths.voice);
    const purchased = await purchasePhoneNumber({ phoneNumber, voiceUrl });
    res.json({
      sid: purchased.sid,
      phoneNumber: purchased.phoneNumber,
      friendlyName: purchased.friendlyName,
      voiceUrl: purchased.voiceUrl,
      voiceMethod: purchased.voiceMethod,
      capabilities: purchased.capabilities,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function sendTwiml(res, response) {
  res.type("text/xml").send(response.toString());
}

function unavailableTwiml(res, message) {
  const response = new twilio.twiml.VoiceResponse();
  response.say({ voice: "alice" }, message);
  response.hangup();
  sendTwiml(res, response);
}

function rejectTwiml(res) {
  const response = new twilio.twiml.VoiceResponse();
  response.reject({ reason: "rejected" });
  sendTwiml(res, response);
}

app.post(["/voice", "/twilio/voice", `${getPhoneAgentPaths().voice}`], (req, res) => {
  const config = loadTwilioConfig();
  if (!config.accountSid || !config.authToken) {
    unavailableTwiml(res, "The phone agent is not configured.");
    return;
  }

  if (!validateTwilioWebhook(req)) {
    res.status(403).send("Invalid Twilio signature");
    return;
  }

  const from = normalizePhoneNumber(req.body?.From);
  const to = normalizePhoneNumber(req.body?.To);
  const callSid = String(req.body?.CallSid || "");
  if (from !== config.allowedFrom || !callSid) {
    console.warn(`[phone-agent] rejected inbound call from ${from || "(unknown)"}`);
    rejectTwiml(res);
    return;
  }

  const paths = getPhoneAgentPaths();
  const mediaUrl = toWebSocketUrl(buildExternalUrl(req, paths.media));
  if (!mediaUrl.startsWith("wss://")) {
    unavailableTwiml(res, "The phone agent public websocket URL is not configured.");
    return;
  }

  const sessionToken = registerAllowedPhoneCall({ callSid, from, to });
  const response = new twilio.twiml.VoiceResponse();
  response.say({ voice: "alice" }, "Connecting your Codex agent.");
  const connect = response.connect();
  const stream = connect.stream({ url: mediaUrl });
  stream.parameter({ name: "callSid", value: callSid });
  stream.parameter({ name: "sessionToken", value: sessionToken });
  sendTwiml(res, response);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const phoneWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const phoneMediaPath = getPhoneAgentPaths().media;

  if (pathname === "/media" || pathname === "/twilio/media" || pathname === phoneMediaPath) {
    phoneWss.handleUpgrade(request, socket, head, (ws) => {
      phoneWss.emit("connection", ws, request);
    });
    return;
  }

  if (!pathname.startsWith("/realtime")) {
    rejectUpgrade(socket, 404, "Not Found");
    return;
  }

  if (!readSession(request)) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  const bridge = new RealtimeBridge(ws);

  ws.on("message", (data) => {
    const message = parseJson(data);
    if (!message) {
      sendJson(ws, { type: "error", message: "Invalid JSON message." });
      return;
    }

    switch (message.type) {
      case "session.start":
        void bridge.start(message);
        break;
      case "message.send":
        bridge.sendText(message.text);
        break;
      case "audio.append":
        bridge.appendAudio(message.audio);
        break;
      case "audio.commit":
        bridge.commitAudio();
        break;
      case "response.cancel":
        bridge.cancelResponse();
        break;
      case "approval.resolve":
        void bridge.resolveApproval(message.id, Boolean(message.approved));
        break;
      default:
        sendJson(ws, { type: "error", message: `Unknown client message: ${message.type}` });
    }
  });

  ws.on("close", () => {
    void bridge.close();
  });
});

phoneWss.on("connection", (ws) => {
  const bridge = new PhoneRealtimeBridge(ws);

  ws.on("message", (data) => {
    bridge.handleTwilioMessage(data);
  });

  ws.on("close", () => {
    void bridge.close();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Realtime MCP app API listening on http://${HOST}:${PORT}`);
});
