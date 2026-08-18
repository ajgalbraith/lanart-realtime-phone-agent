import crypto from "node:crypto";
import os from "node:os";
import WebSocket from "ws";
import { loadCodexMcpConfig } from "./codexConfig.js";
import { callCloudTool, getCloudPublicTools, getCloudRealtimeTools, getCloudTool } from "./cloudTools.js";
import { loadOpenAIKey } from "./keyLoader.js";
import { MCP_CALL_ANY_TOOL_FUNCTION, MCP_LIST_AVAILABLE_TOOLS_FUNCTION, McpManager } from "./mcpManager.js";
import { estimateRealtimeCost, estimateTranscriptionCost, REALTIME_MODEL } from "./pricing.js";
import { loadTwilioConfig } from "./twilioConfig.js";

const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
const CALL_TOKEN_TTL_MS = 5 * 60 * 1000;
const AUDIO_BUFFER_LIMIT = 500;
const DEBUG_PHONE = process.env.DEBUG_PHONE_AGENT === "1";

const pendingCalls = new Map();

const DEFAULT_PHONE_SYSTEM_INSTRUCTIONS = `You are James Galbraith's private phone-call Codex agent.

You are speaking on a Twilio phone call. Keep spoken responses concise, natural, and action-oriented. Use MCP tools for live lookups when useful, but keep tool use narrow.

Security and safety:
- This phone bridge only accepts calls from James's allowed caller ID.
- Calls from the allowed number may use MCP tools, including tools that the dashboard labels approval-required.
- If a needed MCP tool is not available as a direct function, use ${MCP_LIST_AVAILABLE_TOOLS_FUNCTION} to find it and ${MCP_CALL_ANY_TOOL_FUNCTION} to call it.
- Cloud Gmail and Meta Ads tools are available even if local MCP commands are not available in production.
- For irreversible or high-impact actions, first summarize the exact action and ask James to confirm before calling the tool. This includes purchases, refunds, deletions, account changes, outbound emails or messages, and ad budget or spend changes.
- For Meta Ads budget changes, read the current campaign/ad/ad set data first, state the current spend or budget and the proposed new value, then wait for James's clear confirmation before making the change.
- Never guess service domains. Verify official domains before using websites.

Company details:
James Galbraith
Vice President, Lanart Rug Inc
300 Rue Saint-Louis, Saint-Jean-sur-Richelieu, QC J3B 1Y4, Canada
Phone: +1-438-787-0109
Email: james@lanartrug.com`;

function phoneSystemInstructions() {
  const taskInstructions = String(process.env.PHONE_AGENT_INSTRUCTIONS || "").trim();
  return taskInstructions || DEFAULT_PHONE_SYSTEM_INSTRUCTIONS;
}

function safetyIdentifier() {
  const raw = `${os.userInfo().username}:${os.hostname()}:lanart-realtime-phone-agent`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function sendJson(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function parseJson(data) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
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

function debugPhone(...args) {
  if (DEBUG_PHONE) console.log("[phone-agent]", ...args);
}

function cleanupPendingCalls() {
  const now = Date.now();
  for (const [callSid, entry] of pendingCalls) {
    if (entry.expiresAt <= now) pendingCalls.delete(callSid);
  }
}

export function registerAllowedPhoneCall({ callSid, from, to, instructions = "" }) {
  cleanupPendingCalls();
  const token = crypto.randomBytes(24).toString("hex");
  pendingCalls.set(callSid, {
    token,
    from,
    to,
    instructions: String(instructions || "").trim(),
    expiresAt: Date.now() + CALL_TOKEN_TTL_MS,
  });
  return token;
}

function verifyAllowedPhoneCall({ callSid, token }) {
  cleanupPendingCalls();
  const entry = pendingCalls.get(callSid);
  return entry && entry.token === token ? entry : null;
}

function forgetAllowedPhoneCall(callSid) {
  if (callSid) pendingCalls.delete(callSid);
}

export class PhoneRealtimeBridge {
  constructor(twilioWs) {
    this.twilioWs = twilioWs;
    this.openaiWs = null;
    this.mcp = null;
    this.streamSid = null;
    this.callSid = null;
    this.verified = false;
    this.openaiReady = false;
    this.mcpReady = false;
    this.audioBuffer = [];
    this.handledCalls = new Set();
    this.markCounter = 0;
    this.costTotal = 0;
    this.responseActive = false;
    this.queuedResponse = null;
    this.taskInstructions = "";
  }

  handleTwilioMessage(data) {
    const event = parseJson(data);
    if (!event) return;

    switch (event.event) {
      case "connected":
        debugPhone("twilio connected");
        break;
      case "start":
        void this.handleStart(event);
        break;
      case "media":
        this.handleMedia(event);
        break;
      case "mark":
        break;
      case "stop":
        debugPhone("twilio stop", event.stop?.callSid);
        void this.close();
        break;
      default:
        debugPhone("unhandled twilio event", event.event);
        break;
    }
  }

  async handleStart(event) {
    const start = event.start ?? {};
    const params = start.customParameters ?? {};
    const callSid = start.callSid || params.callSid;
    const token = params.sessionToken;

    const allowedCall = callSid ? verifyAllowedPhoneCall({ callSid, token }) : null;
    if (!allowedCall) {
      console.warn("[phone-agent] rejecting media stream with invalid call token");
      this.twilioWs.close(1008, "Unauthorized media stream");
      return;
    }

    this.verified = true;
    this.taskInstructions = allowedCall.instructions;
    this.streamSid = start.streamSid || event.streamSid;
    this.callSid = callSid;
    console.log(`[phone-agent] task-specific instructions: ${this.taskInstructions ? "yes" : "no"}`);
    debugPhone("twilio stream started", this.callSid, this.streamSid);
    await this.startOpenAI();
  }

  handleMedia(event) {
    if (!this.verified || event.media?.track === "outbound") return;
    const payload = event.media?.payload;
    if (!payload) return;

    if (this.openaiReady) {
      this.sendOpenAI({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (this.audioBuffer.length >= AUDIO_BUFFER_LIMIT) this.audioBuffer.shift();
    this.audioBuffer.push(payload);
  }

  async startOpenAI() {
    const key = loadOpenAIKey();
    if (!key.apiKey) {
      this.twilioWs.close(1011, "OpenAI key unavailable");
      return;
    }

    this.openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "OpenAI-Safety-Identifier": safetyIdentifier(),
      },
    });

    this.openaiWs.on("open", () => {
      const config = loadTwilioConfig();
      this.sendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: this.taskInstructions || phoneSystemInstructions(),
          output_modalities: ["audio"],
          max_output_tokens: 2048,
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
              },
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 650,
                create_response: false,
                interrupt_response: true,
              },
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: config.voice,
            },
          },
          tools: [],
          tool_choice: "auto",
          tracing: "auto",
          truncation: {
            type: "retention_ratio",
            retention_ratio: 0.85,
          },
        },
      });
      void this.connectMcpTools();
    });

    this.openaiWs.on("message", (data) => {
      const event = parseJson(data);
      if (event) void this.handleOpenAIEvent(event);
    });

    this.openaiWs.on("close", () => {
      this.openaiReady = false;
    });

    this.openaiWs.on("error", (error) => {
      console.warn("[phone-agent] OpenAI websocket error", error instanceof Error ? error.message : String(error));
    });
  }

  async connectMcpTools() {
    const { rawServers } = loadCodexMcpConfig();
    const config = loadTwilioConfig();
    const selected = config.phoneMcpServers.filter((name) => rawServers[name]);
    this.mcp = new McpManager(rawServers);
    const states = await this.mcp.connectSelected(selected, { includeDisabled: true });
    const ready = states.filter((state) => state.status === "ready");
    this.mcpReady = true;
    console.log(`[phone-agent] MCP ready: ${ready.length}/${selected.length} servers, ${this.mcp.getPublicTools().length} tools`);

    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.sendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          tools: [...this.mcp.getRealtimeTools({ includeGeneric: true }), ...getCloudRealtimeTools()],
          tool_choice: "auto",
        },
      });
    }
  }

  async handleOpenAIEvent(event) {
    switch (event.type) {
      case "session.updated":
        this.openaiReady = true;
        this.flushAudioBuffer();
        debugPhone("openai session updated", event.session?.tools?.length ?? 0);
        break;
      case "response.created":
        this.responseActive = true;
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.sendTwilioMedia(event.delta);
        break;
      case "input_audio_buffer.speech_started":
        this.clearTwilioAudio();
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = String(event.transcript || "").trim();
        if (transcript) console.log(`[call-transcript][Caller] ${transcript}`);
        const usage = event.usage;
        const cost = estimateTranscriptionCost(usage);
        this.costTotal += cost.usd;
        if (cost.usd > 0) {
          console.log(
            `[phone-agent] ${this.callSid ?? "call"} transcription cost $${cost.usd.toFixed(6)} total $${this.costTotal.toFixed(6)}`,
          );
        }
        if (transcript) {
          const normalized = transcript.toLowerCase();
          if (/^(ok|okay)[.!]?$/i.test(transcript) ||
              /thank you for (your )?patience|please (continue to )?hold|all (of )?our agents|hold music|your call is important/.test(normalized)) {
            break;
          }
          const intentPrompt =
            /few words|why (are )?you calling|reason for (your )?call|how can i help/.test(normalized);
          this.createResponse(
            intentPrompt
              ? 'Reply with exactly this sentence and nothing else: "Add a pet to an existing reservation."'
              : "Respond concisely to only the last IVR or human question. During hold music, announcements that ask no question, or noise-only audio, remain completely silent.",
          );
        }
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        console.log(`[call-transcript][Assistant] ${String(event.transcript || "").trim()}`);
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
        }
        break;
      case "response.done": {
        const usage = event.response?.usage;
        const cost = estimateRealtimeCost(usage);
        this.costTotal += cost.usd;
        if (cost.usd > 0) {
          console.log(
            `[phone-agent] ${this.callSid ?? "call"} turn cost $${cost.usd.toFixed(6)} total $${this.costTotal.toFixed(6)}`,
          );
        }
        this.responseActive = false;
        if (this.queuedResponse) {
          const queued = this.queuedResponse;
          this.queuedResponse = null;
          this.createResponse(queued.instructions);
        }
        break;
      }
      case "error":
        console.warn("[phone-agent] OpenAI error", event.error?.message ?? "Realtime API error");
        break;
      default:
        break;
    }
  }

  flushAudioBuffer() {
    if (!this.openaiReady || !this.audioBuffer.length) return;
    const buffered = this.audioBuffer.splice(0);
    for (const payload of buffered) {
      this.sendOpenAI({ type: "input_audio_buffer.append", audio: payload });
    }
  }

  sendTwilioMedia(payload) {
    if (!payload || !this.streamSid) return;
    sendJson(this.twilioWs, {
      event: "media",
      streamSid: this.streamSid,
      media: { payload },
    });
    sendJson(this.twilioWs, {
      event: "mark",
      streamSid: this.streamSid,
      mark: { name: `openai-${++this.markCounter}` },
    });
  }

  clearTwilioAudio() {
    if (!this.streamSid) return;
    sendJson(this.twilioWs, { event: "clear", streamSid: this.streamSid });
  }

  sendOpenAI(event) {
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify(event));
    }
  }

  createResponse(instructions) {
    if (this.responseActive) {
      this.queuedResponse = { instructions };
      return;
    }
    this.responseActive = true;
    const baseInstructions = this.taskInstructions || phoneSystemInstructions();
    const responseInstructions = instructions
      ? `${baseInstructions}\n\nImmediate turn instruction:\n${instructions}`
      : baseInstructions;
    this.sendOpenAI({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: responseInstructions,
        audio: {
          output: {
            format: { type: "audio/pcmu" },
            voice: loadTwilioConfig().voice,
          },
        },
      },
    });
  }

  async handleFunctionCall({ callId, functionName, argumentsRaw }) {
    if (!callId || !functionName || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);

    const args = parseArguments(argumentsRaw);

    if (functionName === MCP_LIST_AVAILABLE_TOOLS_FUNCTION) {
      const cloudTools = getCloudPublicTools();
      const mcpTools = this.mcp?.getAllPublicTools(args) ?? { totalConnectedTools: 0, matchedTools: 0, returnedTools: 0, tools: [] };
      this.sendToolOutput(
        callId,
        JSON.stringify({
          ...mcpTools,
          cloudTools,
          totalCloudTools: cloudTools.length,
        }),
      );
      this.createResponse();
      return;
    }

    if (functionName === MCP_CALL_ANY_TOOL_FUNCTION) {
      try {
        const output = await this.mcp.callOriginalTool(args.serverName, args.toolName, args.arguments ?? {});
        this.sendToolOutput(callId, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sendToolOutput(callId, JSON.stringify({ error: message }));
      }
      this.createResponse();
      return;
    }

    const cloudTool = getCloudTool(functionName);
    if (cloudTool) {
      try {
        console.log(
          `[phone-agent] ${this.callSid ?? "call"} tool cloud/${cloudTool.name} approval=${cloudTool.requiresApproval ? "required" : "not-required"}`,
        );
        const output = await callCloudTool(functionName, args);
        this.sendToolOutput(callId, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sendToolOutput(callId, JSON.stringify({ error: message }));
      }
      this.createResponse();
      return;
    }

    const tool = this.mcp?.getTool(functionName);
    if (!tool || !this.mcpReady) {
      this.sendToolOutput(callId, JSON.stringify({ error: `Tool is not available: ${functionName}` }));
      this.createResponse();
      return;
    }

    try {
      console.log(
        `[phone-agent] ${this.callSid ?? "call"} tool ${tool.serverName}/${tool.originalName} approval=${tool.requiresApproval ? "required" : "not-required"}`,
      );
      const output = await this.mcp.callTool(functionName, args);
      this.sendToolOutput(callId, output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendToolOutput(callId, JSON.stringify({ error: message }));
    }
    this.createResponse();
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

  async close() {
    forgetAllowedPhoneCall(this.callSid);
    this.openaiWs?.close();
    await this.mcp?.close();
  }
}
