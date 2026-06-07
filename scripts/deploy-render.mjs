#!/usr/bin/env node
import fs from "node:fs";
import { URLSearchParams } from "node:url";
import dotenv from "dotenv";
import { loadTwilioConfig } from "../server/twilioConfig.js";

const API_BASE = "https://api.render.com/v1";
const OWNER_ID = "tea-d6gg5f14tr6s73b7s140";
const SERVICE_NAME = "lanart-realtime-phone-agent";
const SERVICE_URL = `https://${SERVICE_NAME}.onrender.com`;
const REPO_URL = "https://github.com/ajgalbraith/lanart-realtime-phone-agent";
const RENDER_KEY_PATHS = ["/Users/jamesgalbraith/code/label-printer/.env.prod", "/Users/jamesgalbraith/.render.env"];
const EMAIL_ENV_PATH = "/Users/jamesgalbraith/code/lanart-mcp/google-workspace-email-mcp/.env";
const META_ENV_PATH = "/Users/jamesgalbraith/.codex/mcp/meta-ads-mcp/.env";

function readEnvValue(raw, key) {
  const line = raw
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

function loadRenderApiKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  for (const filePath of RENDER_KEY_PATHS) {
    if (!fs.existsSync(filePath)) continue;
    const key = readEnvValue(fs.readFileSync(filePath, "utf8"), "RENDER_API_KEY");
    if (key) return key;
  }
  throw new Error("No Render API key found.");
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing env file: ${filePath}`);
  return dotenv.parse(fs.readFileSync(filePath, "utf8"));
}

function required(source, key) {
  const value = source[key] || process.env[key];
  if (!value) throw new Error(`Missing required value ${key}.`);
  return value;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${loadRenderApiKey()}`,
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
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function listServices() {
  const services = [];
  let cursor = "";
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await request(`/services?${query.toString()}`);
    services.push(...page);
    cursor = page.length === 100 ? page[page.length - 1]?.cursor : "";
  } while (cursor);
  return services.map((entry) => entry.service);
}

function buildMcpConfig() {
  return JSON.stringify({
    render: {
      url: "https://mcp.render.com/mcp",
      bearer_token_env_var: "RENDER_API_KEY",
    },
    retell: {
      url: "https://retell.stlmcp.com",
      bearer_token_env_var: "RETELL_API_KEY",
      tools: {
        execute: { approval_mode: "approve" },
      },
    },
  });
}

function buildEnvVars() {
  const twilio = loadTwilioConfig({ refresh: true });
  const emailEnv = parseEnvFile(EMAIL_ENV_PATH);
  const metaEnv = parseEnvFile(META_ENV_PATH);
  const googleKeyFile = required(emailEnv, "GOOGLE_SERVICE_ACCOUNT_KEY_FILE");
  const googleKeyJson = JSON.stringify(JSON.parse(fs.readFileSync(googleKeyFile, "utf8")));
  const values = {
    NODE_ENV: "production",
    NODE_VERSION: "22",
    HOST: "0.0.0.0",
    OPENAI_API_KEY: required(process.env, "OPENAI_API_KEY"),
    TWILIO_ACCOUNT_SID: twilio.accountSid,
    TWILIO_AUTH_TOKEN: twilio.authToken,
    TWILIO_FROM_NUMBER: twilio.fromNumber,
    PHONE_AGENT_NUMBER: "+14388120333",
    PHONE_AGENT_ALLOWED_FROM: "+14387870109",
    PHONE_AGENT_PUBLIC_BASE_URL: SERVICE_URL,
    PHONE_AGENT_MCP_SERVERS: "render,retell",
    CODEX_MCP_CONFIG_JSON: buildMcpConfig(),
    RENDER_API_KEY: loadRenderApiKey(),
    RETELL_API_KEY: required(process.env, "RETELL_API_KEY"),
    GOOGLE_SERVICE_ACCOUNT_KEY_JSON: googleKeyJson,
    GOOGLE_DELEGATED_ADMIN_EMAIL: required(emailEnv, "GOOGLE_DELEGATED_ADMIN_EMAIL"),
    GOOGLE_IMPERSONATE_EMAIL: "james@lanartrug.com",
    GOOGLE_WORKSPACE_CUSTOMER_ID: emailEnv.GOOGLE_WORKSPACE_CUSTOMER_ID || "my_customer",
    META_ACCESS_TOKEN: required(metaEnv, "META_ACCESS_TOKEN"),
    META_AD_ACCOUNT_ID: required(metaEnv, "META_AD_ACCOUNT_ID"),
    META_API_VERSION: metaEnv.META_API_VERSION || "v23.0",
    META_AD_ACCOUNT_CURRENCY: "CAD",
  };

  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({ key, value: String(value) }));
}

async function createService() {
  return request("/services", {
    method: "POST",
    body: JSON.stringify({
      type: "web_service",
      name: SERVICE_NAME,
      ownerId: OWNER_ID,
      repo: REPO_URL,
      branch: "main",
      autoDeploy: "yes",
      serviceDetails: {
        runtime: "node",
        region: "ohio",
        plan: "starter",
        healthCheckPath: "/phone-agent/twilio/status",
        envSpecificDetails: {
          buildCommand: "npm ci && npm run build",
          startCommand: "npm run start:prod",
        },
      },
    }),
  });
}

async function updateService(serviceId) {
  return request(`/services/${serviceId}`, {
    method: "PATCH",
    body: JSON.stringify({
      autoDeploy: "yes",
      branch: "main",
      repo: REPO_URL,
      serviceDetails: {
        runtime: "node",
        healthCheckPath: "/phone-agent/twilio/status",
        plan: "starter",
        envSpecificDetails: {
          buildCommand: "npm ci && npm run build",
          startCommand: "npm run start:prod",
        },
      },
    }),
  });
}

async function replaceEnvVars(serviceId, envVars) {
  return request(`/services/${serviceId}/env-vars`, {
    method: "PUT",
    body: JSON.stringify(envVars),
  });
}

async function triggerDeploy(serviceId) {
  return request(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: JSON.stringify({ clearCache: "clear" }),
  });
}

const envVars = buildEnvVars();
const services = await listServices();
let service = services.find((entry) => entry.name === SERVICE_NAME);
let created = false;

if (!service) {
  const response = await createService();
  service = response.service;
  created = true;
} else {
  service = await updateService(service.id);
}

await replaceEnvVars(service.id, envVars);
const deploy = await triggerDeploy(service.id);

console.log(
  JSON.stringify(
    {
      serviceId: service.id,
      name: service.name,
      url: service.serviceDetails?.url || SERVICE_URL,
      dashboardUrl: service.dashboardUrl,
      created,
      deployId: deploy?.deploy?.id ?? service.deployId ?? null,
      envVarCount: envVars.length,
    },
    null,
    2,
  ),
);
