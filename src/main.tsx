import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  Check,
  CircleDollarSign,
  Gauge,
  Headphones,
  Mic,
  Pause,
  Plug,
  Power,
  Send,
  ShieldCheck,
  Square,
  TerminalSquare,
  Volume2,
  X,
} from "lucide-react";
import "./styles.css";
import { createAudioCapture, PcmPlayer, type AudioCapture } from "./realtimeAudio";

type McpServer = {
  name: string;
  enabled: boolean;
  transport: string;
  label: string | null;
  hasConfiguredEnv: boolean;
  hasSecretHeaders: boolean;
  approvalTools: string[];
};

type McpState = {
  name: string;
  status: "connecting" | "ready" | "failed";
  toolCount: number;
  error: string | null;
};

type McpTool = {
  serverName: string;
  originalName: string;
  functionName: string;
  description?: string;
  requiresApproval: boolean;
  readOnlyHint: boolean;
};

type StatusPayload = {
  model: string;
  openaiKey: {
    available: boolean;
    sourceKind: string;
    sourcePath: string | null;
  };
  mcpServers: McpServer[];
  defaultSelectedMcpServers: string[];
};

type PhoneStatusPayload = {
  available: boolean;
  allowedFrom: string;
  fromNumber: string | null;
  agentNumber: string | null;
  voiceWebhookUrl: string;
  mediaStreamUrl: string;
  phoneMcpServers: string[];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

type ToolEvent = {
  id: string;
  tone: "neutral" | "good" | "warn" | "bad";
  title: string;
  detail?: string;
};

type Approval = {
  id: string;
  request: {
    serverName: string;
    toolName: string;
    args: unknown;
  };
};

const voices = ["marin", "cedar", "verse", "coral", "sage", "alloy"];

function money(value: number) {
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(3)}`;
}

function shortPath(value: string | null) {
  if (!value) return "Not found";
  return value.replace(/^\/Users\/jamesgalbraith\//, "~/");
}

function nowId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const [status, setStatus] = React.useState<StatusPayload | null>(null);
  const [phoneStatus, setPhoneStatus] = React.useState<PhoneStatusPayload | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [mcpStates, setMcpStates] = React.useState<McpState[]>([]);
  const [mcpTools, setMcpTools] = React.useState<McpTool[]>([]);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [toolEvents, setToolEvents] = React.useState<ToolEvent[]>([]);
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [connection, setConnection] = React.useState<"idle" | "connecting" | "connected" | "disconnected">(
    "idle",
  );
  const [input, setInput] = React.useState("");
  const [voice, setVoice] = React.useState("marin");
  const [conversationMode, setConversationMode] = React.useState(false);
  const [voiceState, setVoiceState] = React.useState<"idle" | "listening" | "speaking" | "thinking" | "assistant">(
    "idle",
  );
  const [instructions, setInstructions] = React.useState("");
  const [cost, setCost] = React.useState(0);
  const [lastCost, setLastCost] = React.useState(0);
  const [tokens, setTokens] = React.useState({
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    output_audio_tokens: 0,
  });
  const [recording, setRecording] = React.useState(false);

  const wsRef = React.useRef<WebSocket | null>(null);
  const assistantIdRef = React.useRef<string | null>(null);
  const userTranscriptIdsRef = React.useRef<Map<string, string>>(new Map());
  const playerRef = React.useRef<PcmPlayer | null>(null);
  const captureRef = React.useRef<AudioCapture | null>(null);
  const messagesEndRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    fetch("/api/status")
      .then((res) => res.json())
      .then((payload: StatusPayload) => {
        setStatus(payload);
        setSelected(new Set(payload.defaultSelectedMcpServers));
      })
      .catch((error) => {
        addToolEvent("bad", "Status failed", error instanceof Error ? error.message : String(error));
      });

    fetch("/api/phone/status")
      .then((res) => res.json())
      .then((payload: PhoneStatusPayload) => {
        setPhoneStatus(payload);
      })
      .catch((error) => {
        addToolEvent("bad", "Phone status failed", error instanceof Error ? error.message : String(error));
      });
  }, []);

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function addToolEvent(tone: ToolEvent["tone"], title: string, detail?: string) {
    setToolEvents((events) => [{ id: nowId("tool"), tone, title, detail }, ...events].slice(0, 80));
  }

  function selectedArray() {
    return Array.from(selected);
  }

  function connect() {
    if (connection === "connected" || connection === "connecting") return;
    setConnection("connecting");
    setMessages([]);
    setToolEvents([]);
    setApprovals([]);
    setCost(0);
    setLastCost(0);
    setTokens({ input_tokens: 0, output_tokens: 0, cached_tokens: 0, output_audio_tokens: 0 });
    assistantIdRef.current = null;
    userTranscriptIdsRef.current.clear();
    setVoiceState("idle");

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${window.location.host}/realtime`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "session.start",
          serverNames: selectedArray(),
          responseMode: conversationMode ? "audio" : "text",
          voiceMode: conversationMode,
          voice,
          instructions,
        }),
      );
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      handleServerMessage(message);
    };

    ws.onclose = () => {
      setConnection("disconnected");
      setRecording(false);
      setVoiceState("idle");
      void stopCapture(false);
    };

    ws.onerror = () => {
      addToolEvent("bad", "Socket error");
      setConnection("disconnected");
    };
  }

  function disconnect() {
    playerRef.current?.close();
    playerRef.current = null;
    wsRef.current?.close();
    setConnection("disconnected");
    setVoiceState("idle");
  }

  function handleServerMessage(message: Record<string, unknown>) {
    switch (message.type) {
      case "session.state":
        setConnection(message.state === "connected" ? "connected" : "disconnected");
        addToolEvent(
          message.state === "connected" ? "good" : "neutral",
          `Session ${String(message.state)}`,
          typeof message.model === "string" ? message.model : undefined,
        );
        if (message.state === "connected" && conversationMode) {
          void startVoiceConversation(true);
        }
        break;
      case "session.updated":
        addToolEvent("good", "Realtime ready", `${((message.session as { tools?: number })?.tools ?? 0)} tools loaded`);
        break;
      case "mcp.status":
        setMcpStates((message.servers as McpState[]) ?? []);
        setMcpTools((message.tools as McpTool[]) ?? []);
        addToolEvent("neutral", "MCP scan complete", `${((message.tools as McpTool[]) ?? []).length} tools available`);
        break;
      case "assistant.delta":
        appendAssistant(typeof message.text === "string" ? message.text : "");
        break;
      case "assistant.done":
        if (typeof message.text === "string" && message.text.trim() && !assistantIdRef.current) {
          appendAssistant(message.text);
        }
        assistantIdRef.current = null;
        break;
      case "audio.delta":
        if (!playerRef.current) playerRef.current = new PcmPlayer();
        if (typeof message.audio === "string") playerRef.current.enqueue(message.audio);
        setVoiceState("assistant");
        break;
      case "user.transcript.delta":
        appendUserTranscript(String(message.itemId ?? "live"), typeof message.text === "string" ? message.text : "");
        break;
      case "user.transcript.done":
        upsertUserTranscript(
          String(message.itemId ?? nowId("voice-user")),
          typeof message.text === "string" ? message.text : "",
          true,
        );
        break;
      case "voice.event":
        handleVoiceEvent(message);
        break;
      case "usage.update":
        setCost(typeof message.totalCost === "number" ? message.totalCost : 0);
        setLastCost(((message.cost as { usd?: number })?.usd) ?? 0);
        setTokens((message.totals as typeof tokens) ?? tokens);
        break;
      case "turn.done":
        assistantIdRef.current = null;
        break;
      case "turn.status":
        addToolEvent("warn", `Turn ${String(message.status)}`, JSON.stringify(message.statusDetails ?? {}));
        break;
      case "approval.required":
        setApprovals((items) => [...items, { id: String(message.id), request: message.request as Approval["request"] }]);
        addToolEvent(
          "warn",
          "Approval needed",
          `${(message.request as Approval["request"]).serverName}/${(message.request as Approval["request"]).toolName}`,
        );
        break;
      case "tool.started":
        addToolEvent(
          "neutral",
          "Tool started",
          `${(message.request as Approval["request"]).serverName}/${(message.request as Approval["request"]).toolName}`,
        );
        break;
      case "tool.done":
        addToolEvent(
          "good",
          "Tool completed",
          `${(message.request as Approval["request"]).serverName}/${(message.request as Approval["request"]).toolName}`,
        );
        break;
      case "tool.error":
        addToolEvent("bad", "Tool failed", typeof message.message === "string" ? message.message : undefined);
        break;
      case "tool.rejected":
        addToolEvent(
          "warn",
          "Tool rejected",
          `${(message.request as Approval["request"]).serverName}/${(message.request as Approval["request"]).toolName}`,
        );
        break;
      case "error":
      case "fatal":
        addToolEvent("bad", typeof message.message === "string" ? message.message : "Error");
        break;
      default:
        break;
    }
  }

  function appendAssistant(text: string) {
    if (!text) return;
    const existingId = assistantIdRef.current;
    if (existingId) {
      setMessages((items) =>
        items.map((item) => (item.id === existingId ? { ...item, text: item.text + text } : item)),
      );
      return;
    }

    const nextId = nowId("assistant");
    assistantIdRef.current = nextId;
    setMessages((items) => [...items, { id: nextId, role: "assistant", text }]);
  }

  function appendUserTranscript(itemId: string, text: string) {
    if (!text) return;
    upsertUserTranscript(itemId, text, false);
  }

  function upsertUserTranscript(itemId: string, text: string, replace: boolean) {
    if (!text.trim()) return;
    const existingId = userTranscriptIdsRef.current.get(itemId);
    if (existingId) {
      setMessages((items) =>
        items.map((item) =>
          item.id === existingId ? { ...item, text: replace ? text.trim() : item.text + text } : item,
        ),
      );
      return;
    }

    const id = nowId("voice-user");
    userTranscriptIdsRef.current.set(itemId, id);
    setMessages((items) => [...items, { id, role: "user", text: text.trim() }]);
  }

  function handleVoiceEvent(message: Record<string, unknown>) {
    switch (message.state) {
      case "user_speaking":
        setVoiceState("speaking");
        playerRef.current?.reset();
        break;
      case "thinking":
      case "committed":
        setVoiceState("thinking");
        break;
      case "assistant_done":
        setVoiceState(recording ? "listening" : "idle");
        break;
      case "transcription_failed":
        setVoiceState(recording ? "listening" : "idle");
        addToolEvent("warn", "Transcription failed", typeof message.message === "string" ? message.message : undefined);
        break;
      default:
        break;
    }
  }

  function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || connection !== "connected") return;
    assistantIdRef.current = null;
    setMessages((items) => [...items, { id: nowId("user"), role: "user", text }]);
    wsRef.current?.send(JSON.stringify({ type: "message.send", text }));
    setInput("");
  }

  function toggleServer(name: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function resolveApproval(id: string, approved: boolean) {
    wsRef.current?.send(JSON.stringify({ type: "approval.resolve", id, approved }));
    setApprovals((items) => items.filter((item) => item.id !== id));
  }

  async function startCapture(force = false) {
    if (recording || (!force && connection !== "connected")) return;
    playerRef.current ??= new PcmPlayer();
    captureRef.current = await createAudioCapture((audio) => {
      wsRef.current?.send(JSON.stringify({ type: "audio.append", audio }));
    });
    setRecording(true);
    setVoiceState("listening");
  }

  async function stopCapture(commit = true) {
    captureRef.current?.stop();
    captureRef.current = null;
    if (recording && commit && !conversationMode) {
      assistantIdRef.current = null;
      wsRef.current?.send(JSON.stringify({ type: "audio.commit" }));
    }
    setRecording(false);
    setVoiceState("idle");
  }

  async function startVoiceConversation(force = false) {
    if (!conversationMode || recording || (!force && connection !== "connected")) return;
    try {
      await startCapture(force);
    } catch (error) {
      addToolEvent("bad", "Mic failed", error instanceof Error ? error.message : String(error));
    }
  }

  function toggleVoiceConversation() {
    if (!conversationMode) return;
    if (recording) void stopCapture(false);
    else void startVoiceConversation();
  }

  const readyTools = mcpTools.length;
  const readyServers = mcpStates.filter((item) => item.status === "ready").length;
  const failedServers = mcpStates.filter((item) => item.status === "failed").length;

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand">
          <TerminalSquare size={22} />
          <div>
            <h1>Lanart Realtime Lab</h1>
            <span>{status?.model ?? "gpt-realtime-2"}</span>
          </div>
        </div>
        <div className="top-actions">
          <div className={`status-pill ${connection}`}>
            <Activity size={16} />
            {connection}
          </div>
          <button className="icon-button" onClick={connection === "connected" ? disconnect : connect}>
            {connection === "connected" ? <Square size={18} /> : <Power size={18} />}
            <span>{connection === "connected" ? "Stop" : "Start"}</span>
          </button>
        </div>
      </section>

      <section className="dashboard-grid">
        <aside className="side-panel">
          <div className="metric-row">
            <Metric icon={<CircleDollarSign size={18} />} label="Cost" value={money(cost)} sub={`last ${money(lastCost)}`} />
            <Metric icon={<Gauge size={18} />} label="Tokens" value={String(tokens.input_tokens + tokens.output_tokens)} sub={`${tokens.cached_tokens} cached`} />
          </div>

          <div className="phone-status">
            <div>
              <Headphones size={17} />
              <strong>{phoneStatus?.agentNumber ?? "Phone agent"}</strong>
              <span>{phoneStatus?.available ? "ready" : "not ready"}</span>
            </div>
            <small>Allowed caller {phoneStatus?.allowedFrom ?? "unknown"}</small>
            <small>{phoneStatus?.phoneMcpServers.length ?? 0} phone MCPs enabled</small>
          </div>

          <div className="section-title">
            <Plug size={17} />
            <span>MCPs</span>
            <strong>{readyServers}/{selected.size || 0}</strong>
          </div>
          <div className="mcp-list">
            {(status?.mcpServers ?? []).map((server) => {
              const state = mcpStates.find((item) => item.name === server.name);
              const checked = selected.has(server.name);
              return (
                <label key={server.name} className={`mcp-row ${checked ? "selected" : ""} ${server.enabled ? "" : "disabled"}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!server.enabled || connection === "connected" || connection === "connecting"}
                    onChange={() => toggleServer(server.name)}
                  />
                  <span className="mcp-main">
                    <span>{server.name}</span>
                    <small>{server.transport} · {server.label ?? "configured"}</small>
                  </span>
                  <McpBadge state={state} approvalCount={server.approvalTools.length} />
                </label>
              );
            })}
          </div>

          <div className="settings">
            <div className="mode-switch" aria-label="Mode">
              <button
                type="button"
                className={!conversationMode ? "active" : ""}
                disabled={connection === "connected" || connection === "connecting"}
                onClick={() => setConversationMode(false)}
              >
                <TerminalSquare size={16} />
                Chat
              </button>
              <button
                type="button"
                className={conversationMode ? "active" : ""}
                disabled={connection === "connected" || connection === "connecting"}
                onClick={() => setConversationMode(true)}
              >
                <Headphones size={16} />
                Voice
              </button>
            </div>
            <label>
              <span>Voice</span>
              <select value={voice} onChange={(event) => setVoice(event.target.value)} disabled={connection !== "idle" && connection !== "disconnected"}>
                {voices.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Instruction</span>
              <textarea
                value={instructions}
                disabled={connection !== "idle" && connection !== "disconnected"}
                onChange={(event) => setInstructions(event.target.value)}
                rows={4}
              />
            </label>
          </div>
        </aside>

        <section className="chat-panel">
          <div className="chat-strip">
            <div className="strip-item">
              <ShieldCheck size={16} />
              <span>{status?.openaiKey.available ? shortPath(status.openaiKey.sourcePath) : "No key"}</span>
            </div>
            <div className="strip-item">
              <Check size={16} />
              <span>{readyTools} tools</span>
            </div>
            {conversationMode && (
              <div className={`strip-item voice ${voiceState}`}>
                <Volume2 size={16} />
                <span>{voiceState}</span>
              </div>
            )}
            {failedServers > 0 && (
              <div className="strip-item warn">
                <AlertTriangle size={16} />
                <span>{failedServers} failed</span>
              </div>
            )}
          </div>

          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-state">
                <h2>Ask for a live lookup, a draft, or a quick local check.</h2>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span>{message.role}</span>
                  <p>{message.text}</p>
                </article>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="composer" onSubmit={submitMessage}>
            {conversationMode ? (
              <button
                type="button"
                className={`mic-button ${recording ? "recording" : ""}`}
                disabled={connection !== "connected"}
                onClick={toggleVoiceConversation}
                title={recording ? "Stop listening" : "Start listening"}
              >
                {recording ? <Pause size={19} /> : <Mic size={19} />}
              </button>
            ) : (
              <button
                type="button"
                className={`mic-button ${recording ? "recording" : ""}`}
                disabled={connection !== "connected"}
                onMouseDown={() => void startCapture()}
                onMouseUp={() => void stopCapture(true)}
                onMouseLeave={() => recording && void stopCapture(true)}
                onTouchStart={() => void startCapture()}
                onTouchEnd={() => void stopCapture(true)}
                title="Hold to talk"
              >
                {recording ? <Pause size={19} /> : <Mic size={19} />}
              </button>
            )}
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={connection !== "connected"}
              placeholder={connection === "connected" ? (conversationMode ? "Optional text" : "Message") : "Start session"}
            />
            <button type="submit" className="send-button" disabled={connection !== "connected" || !input.trim()}>
              <Send size={18} />
            </button>
          </form>
        </section>

        <aside className="activity-panel">
          <div className="section-title">
            <ShieldCheck size={17} />
            <span>Approvals</span>
            <strong>{approvals.length}</strong>
          </div>
          <div className="approval-list">
            {approvals.length === 0 ? (
              <div className="quiet">None pending</div>
            ) : (
              approvals.map((item) => (
                <div className="approval-card" key={item.id}>
                  <strong>{item.request.serverName}/{item.request.toolName}</strong>
                  <pre>{JSON.stringify(item.request.args, null, 2)}</pre>
                  <div>
                    <button onClick={() => resolveApproval(item.id, true)}>
                      <Check size={16} />
                      Approve
                    </button>
                    <button onClick={() => resolveApproval(item.id, false)}>
                      <X size={16} />
                      Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="section-title">
            <Activity size={17} />
            <span>Activity</span>
          </div>
          <div className="event-list">
            {toolEvents.map((event) => (
              <div key={event.id} className={`event-row ${event.tone}`}>
                <strong>{event.title}</strong>
                {event.detail && <span>{event.detail}</span>}
              </div>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

function Metric({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="metric">
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}

function McpBadge({ state, approvalCount }: { state?: McpState; approvalCount: number }) {
  if (!state) {
    return approvalCount > 0 ? <span className="badge approve">{approvalCount}</span> : <span className="badge">idle</span>;
  }
  if (state.status === "ready") return <span className="badge ready">{state.toolCount}</span>;
  if (state.status === "failed") return <span className="badge failed">fail</span>;
  return <span className="badge">...</span>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
