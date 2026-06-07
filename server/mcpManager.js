import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOOL_LIMIT = 120;
const CONNECT_TIMEOUT_MS = 12_000;
const CALL_TIMEOUT_MS = 60_000;
export const MCP_LIST_AVAILABLE_TOOLS_FUNCTION = "mcp_list_available_tools";
export const MCP_CALL_ANY_TOOL_FUNCTION = "mcp_call_any_tool";
const GENERIC_MCP_REALTIME_TOOLS = [
  {
    type: "function",
    name: MCP_LIST_AVAILABLE_TOOLS_FUNCTION,
    description:
      "List every MCP tool connected to this session, including tools not exposed as direct Realtime functions. Use this when you need a tool by category or server.",
    parameters: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "Optional MCP server name to filter by." },
        search: { type: "string", description: "Optional text to match against tool name or description." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum tools to return. Default 40." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: MCP_CALL_ANY_TOOL_FUNCTION,
    description:
      "Call any connected MCP tool by server name and original tool name. For irreversible actions, confirm the exact action with James before using this.",
    parameters: {
      type: "object",
      required: ["serverName", "toolName"],
      properties: {
        serverName: { type: "string", description: "The MCP server name, for example meta_ads_mcp." },
        toolName: { type: "string", description: "The original MCP tool name on that server." },
        arguments: { type: "object", description: "Arguments to pass to the MCP tool." },
      },
      additionalProperties: false,
    },
  },
];
const SERVER_TOOL_PRIORITIES = {
  meta_ads_mcp: [
    "meta_auth_status",
    "get_ad_accounts",
    "getAvailableAdAccounts",
    "health_check",
    "get_capabilities",
    "list_ads",
    "getAds",
    "getAccountAds",
    "getAd",
    "get_insights",
    "get_campaign_performance",
    "list_ad_sets",
    "getAdSets",
    "getAdSet",
    "updateAdSet",
    "update_ad_set",
    "updateAd",
    "update_campaign",
    "updateCampaign",
    "list_campaigns",
    "getCampaigns",
  ],
};

function sanitizeToolPart(value) {
  const sanitized = String(value).replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.replace(/^_+|_+$/g, "") || "tool";
}

function stableToolName(serverName, toolName) {
  const base = `mcp_${sanitizeToolPart(serverName)}__${sanitizeToolPart(toolName)}`;
  if (base.length <= 64) return base;
  const digest = crypto.createHash("sha1").update(`${serverName}:${toolName}`).digest("hex").slice(0, 8);
  return `${base.slice(0, 55)}_${digest}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function headersForDefinition(definition) {
  const headers = { ...(definition.http_headers ?? {}) };
  if (definition.bearer_token_env_var && process.env[definition.bearer_token_env_var]) {
    headers.Authorization = `Bearer ${process.env[definition.bearer_token_env_var]}`;
  }
  return headers;
}

function shouldRequireApproval(serverDefinition, tool) {
  const configured = serverDefinition.tools?.[tool.name]?.approval_mode === "approve";
  const annotations = tool.annotations ?? {};
  const destructive = annotations.destructiveHint === true || annotations.readOnlyHint === false;
  const normalizedToolName = String(tool.name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  const riskyName =
    /\b(send|create|update|delete|remove|draft|write|mutate|execute|call|activate|purchase|refund|charge|sms|email|pause|resume|publish|upload|exchange|refresh|generate)\b/i.test(
      normalizedToolName,
    );
  return configured || destructive || riskyName;
}

function prioritizeTools(serverName, tools) {
  const priorities = SERVER_TOOL_PRIORITIES[serverName];
  if (!priorities?.length) return tools;

  const ranks = new Map(priorities.map((toolName, index) => [toolName, index]));
  return [...tools].sort((a, b) => {
    const rankA = ranks.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const rankB = ranks.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });
}

function compactToolResult(result) {
  const parts = [];

  if (result?.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item.type === "text") {
        parts.push(item.text ?? "");
      } else if (item.type === "resource") {
        if (item.resource?.text) parts.push(item.resource.text);
        else parts.push(`[resource ${item.resource?.uri ?? "unknown"} omitted]`);
      } else if (item.type === "image") {
        parts.push(`[image ${item.mimeType ?? "unknown"} omitted]`);
      } else if (item.type === "audio") {
        parts.push(`[audio ${item.mimeType ?? "unknown"} omitted]`);
      } else if (item.type === "resource_link") {
        parts.push(`[resource link ${item.uri ?? item.name ?? "unknown"}]`);
      }
    }
  }

  if (!parts.length) {
    parts.push(JSON.stringify(result ?? null, null, 2));
  }

  const output = parts.filter(Boolean).join("\n\n");
  if (output.length <= 24_000) return output;
  return `${output.slice(0, 24_000)}\n\n[truncated ${output.length - 24_000} chars]`;
}

export class McpManager {
  constructor(rawServers) {
    this.rawServers = rawServers;
    this.connections = new Map();
    this.toolMap = new Map();
    this.availableTools = [];
    this.serverStates = [];
  }

  async connectSelected(serverNames, { includeDisabled = false } = {}) {
    const names = Array.from(new Set(serverNames)).filter((name) => {
      const definition = this.rawServers[name];
      if (!definition) return false;
      return includeDisabled || definition.enabled !== false;
    });
    const states = [];
    const serverTools = [];

    for (const name of names) {
      const definition = this.rawServers[name];
      if (!definition) continue;

      const state = {
        name,
        status: "connecting",
        toolCount: 0,
        error: null,
      };
      states.push(state);

      try {
        const { client, transport } = await withTimeout(
          this.connectOne(name, definition),
          CONNECT_TIMEOUT_MS,
          `MCP ${name}`,
        );
        const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `MCP ${name} tool list`);
        const tools = prioritizeTools(name, listed.tools ?? []);

        this.connections.set(name, { client, transport, definition });
        serverTools.push({ name, definition, tools });

        state.status = "ready";
        state.toolCount = tools.length;
      } catch (error) {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
      }
    }

    this.installBalancedTools(serverTools);
    this.serverStates = states;
    return states;
  }

  installBalancedTools(serverTools) {
    this.toolMap.clear();
    const mappedServerTools = serverTools.map((entry) => ({
      ...entry,
      mappedTools: entry.tools.map((tool) => ({
        serverName: entry.name,
        originalName: tool.name,
        functionName: stableToolName(entry.name, tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
        requiresApproval: shouldRequireApproval(entry.definition, tool),
        readOnlyHint: tool.annotations?.readOnlyHint === true,
      })),
    }));
    this.availableTools = mappedServerTools.flatMap((entry) => entry.mappedTools);
    let added = 0;
    let index = 0;

    while (added < TOOL_LIMIT) {
      let progressed = false;

      for (const entry of mappedServerTools) {
        const tool = entry.mappedTools[index];
        if (!tool) continue;

        this.toolMap.set(tool.functionName, tool);

        added += 1;
        progressed = true;
        if (added >= TOOL_LIMIT) break;
      }

      if (!progressed) break;
      index += 1;
    }
  }

  async connectOne(name, definition) {
    const client = new Client({ name: `lanart-realtime-${name}`, version: "0.1.0" });
    let transport;

    if (definition.url) {
      transport = new StreamableHTTPClientTransport(new URL(definition.url), {
        requestInit: { headers: headersForDefinition(definition) },
      });
    } else if (definition.command) {
      transport = new StdioClientTransport({
        command: definition.command,
        args: Array.isArray(definition.args) ? definition.args : [],
        env: {
          ...process.env,
          ...(definition.env ?? {}),
        },
        stderr: "pipe",
      });
    } else {
      throw new Error("MCP server has no url or command");
    }

    await client.connect(transport);
    return { client, transport };
  }

  getRealtimeTools({ includeGeneric = false } = {}) {
    const directLimit = includeGeneric ? Math.max(0, TOOL_LIMIT - GENERIC_MCP_REALTIME_TOOLS.length) : TOOL_LIMIT;
    const directTools = Array.from(this.toolMap.values()).slice(0, directLimit).map((tool) => ({
      type: "function",
      name: tool.functionName,
      description: `[${tool.serverName}/${tool.originalName}] ${tool.description ?? "MCP tool"}`,
      parameters: tool.inputSchema && tool.inputSchema.type === "object" ? tool.inputSchema : { type: "object" },
    }));
    return includeGeneric ? [...GENERIC_MCP_REALTIME_TOOLS, ...directTools] : directTools;
  }

  getPublicTools() {
    return Array.from(this.toolMap.values()).map((tool) => ({
      serverName: tool.serverName,
      originalName: tool.originalName,
      functionName: tool.functionName,
      description: tool.description,
      requiresApproval: tool.requiresApproval,
      readOnlyHint: tool.readOnlyHint,
    }));
  }

  getAllPublicTools({ serverName, search, limit = 40 } = {}) {
    const query = String(search || "").trim().toLowerCase();
    const requestedLimit = Number(limit);
    const safeLimit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 40, 100));
    let tools = this.availableTools;

    if (serverName) tools = tools.filter((tool) => tool.serverName === serverName);
    if (query) {
      tools = tools.filter((tool) =>
        [tool.serverName, tool.originalName, tool.description].some((value) => String(value || "").toLowerCase().includes(query)),
      );
    }

    return {
      totalConnectedTools: this.availableTools.length,
      matchedTools: tools.length,
      returnedTools: Math.min(tools.length, safeLimit),
      tools: tools.slice(0, safeLimit).map((tool) => ({
        serverName: tool.serverName,
        originalName: tool.originalName,
        directFunctionName: this.toolMap.has(tool.functionName) ? tool.functionName : null,
        description: tool.description,
        requiresApproval: tool.requiresApproval,
        readOnlyHint: tool.readOnlyHint,
      })),
    };
  }

  getTool(functionName) {
    return this.toolMap.get(functionName);
  }

  async callTool(functionName, args) {
    const tool = this.toolMap.get(functionName);
    if (!tool) throw new Error(`Unknown MCP function tool: ${functionName}`);

    return this.callOriginalTool(tool.serverName, tool.originalName, args);
  }

  async callOriginalTool(serverName, toolName, args) {
    if (!serverName || !toolName) throw new Error("MCP serverName and toolName are required.");
    const connection = this.connections.get(serverName);
    if (!connection) throw new Error(`MCP server is not connected: ${serverName}`);
    const available = this.availableTools.find((tool) => tool.serverName === serverName && tool.originalName === toolName);
    if (!available) throw new Error(`MCP tool is not available: ${serverName}/${toolName}`);

    const result = await withTimeout(
      connection.client.callTool({ name: toolName, arguments: args ?? {} }),
      CALL_TIMEOUT_MS,
      `${serverName}/${toolName}`,
    );
    return compactToolResult(result);
  }

  async close() {
    const closers = [];
    for (const { transport, client } of this.connections.values()) {
      closers.push(client.close?.().catch(() => null));
      closers.push(transport.close?.().catch(() => null));
    }
    await Promise.allSettled(closers);
    this.connections.clear();
    this.toolMap.clear();
    this.availableTools = [];
  }
}
