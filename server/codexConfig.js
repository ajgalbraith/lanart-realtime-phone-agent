import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "smol-toml";

const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || DEFAULT_CODEX_CONFIG_PATH;

function redactUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function describeTransport(definition) {
  if (definition.url) return "http";
  if (definition.command) return "stdio";
  return "unknown";
}

function commandLabel(definition) {
  if (!definition.command) return null;
  const command = String(definition.command);
  const args = Array.isArray(definition.args) ? definition.args : [];
  return [path.basename(command), ...args.slice(0, 2)].join(" ");
}

export function loadCodexMcpConfig() {
  if (process.env.CODEX_MCP_CONFIG_JSON) {
    const parsed = JSON.parse(process.env.CODEX_MCP_CONFIG_JSON);
    return describeMcpConfig("process.env.CODEX_MCP_CONFIG_JSON", parsed.mcp_servers ?? parsed);
  }

  if (process.env.CODEX_MCP_CONFIG_TOML) {
    const parsed = parse(process.env.CODEX_MCP_CONFIG_TOML);
    return describeMcpConfig("process.env.CODEX_MCP_CONFIG_TOML", parsed.mcp_servers ?? {});
  }

  if (!fs.existsSync(CODEX_CONFIG_PATH)) {
    return { configPath: CODEX_CONFIG_PATH, servers: [], rawServers: {} };
  }

  const raw = fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
  const parsed = parse(raw);
  return describeMcpConfig(CODEX_CONFIG_PATH, parsed.mcp_servers ?? {});
}

function describeMcpConfig(configPath, rawServers) {
  const servers = Object.entries(rawServers).map(([name, definition]) => {
    const tools = definition.tools && typeof definition.tools === "object" ? definition.tools : {};
    const approvalTools = Object.entries(tools)
      .filter(([, toolDef]) => toolDef?.approval_mode === "approve")
      .map(([toolName]) => toolName);

    return {
      name,
      enabled: definition.enabled !== false,
      transport: describeTransport(definition),
      label: definition.url ? redactUrl(definition.url) : commandLabel(definition),
      hasConfiguredEnv: Boolean(definition.env),
      hasSecretHeaders: Boolean(definition.http_headers || definition.bearer_token_env_var),
      approvalTools,
    };
  });

  return { configPath, servers, rawServers };
}
