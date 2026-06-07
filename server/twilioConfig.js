import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import twilio from "twilio";

const home = os.homedir();
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ALLOWED_FROM = "+14387870109";
const DEFAULT_PHONE_MCP_SERVERS = [
  "workspace-mcp",
  "google-workspace-email",
  "google-workspace",
  "meta_ads_mcp",
  "whatsapp",
  "macos-contacts",
  "quickbooks_lanart",
  "shopify",
  "shipstation",
  "twilio-local",
];

const CANDIDATE_ENV_PATHS = [
  path.join(appRoot, ".env"),
  path.join(appRoot, ".env.local"),
  path.resolve(appRoot, "..", ".env"),
  path.resolve(appRoot, "..", ".env.local"),
  path.join(home, "code", "lanart-mcp", "qbo-webhook-relay", ".env"),
  path.join(home, "code", "webhooks", ".env"),
  path.join(home, "code", "lanart-mcp", "twilio-mcp", ".env"),
];

let cachedConfig = null;
let cachedAt = 0;

export function normalizePhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return `+${raw.replace(/[^\d]/g, "")}`;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTwilioEnvFiles() {
  const candidates = readEnvFiles().filter(({ parsed }) => parsed.TWILIO_ACCOUNT_SID && parsed.TWILIO_AUTH_TOKEN);

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

function readEnvFiles() {
  const candidates = [];
  for (const filePath of CANDIDATE_ENV_PATHS) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = dotenv.parse(fs.readFileSync(filePath, "utf8"));
      const stat = fs.statSync(filePath);
      candidates.push({ parsed, filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore unreadable env candidates.
    }
  }
  return candidates;
}

function valueFrom(source, key, layeredSources = []) {
  const layeredValue = layeredSources.find(({ parsed }) => parsed[key])?.parsed?.[key];
  return String(process.env[key] || layeredValue || source?.parsed?.[key] || "").trim();
}

export function getPhoneAgentPathPrefix() {
  const configured = String(process.env.PHONE_AGENT_PATH_PREFIX || "/phone-agent/twilio").trim();
  if (!configured || configured === "/") return "";
  return configured.startsWith("/") ? configured.replace(/\/+$/, "") : `/${configured.replace(/\/+$/, "")}`;
}

export function getPhoneAgentPaths() {
  const prefix = getPhoneAgentPathPrefix();
  return {
    voice: `${prefix}/voice`,
    media: `${prefix}/media`,
    status: `${prefix}/status`,
  };
}

export function loadTwilioConfig({ refresh = false } = {}) {
  if (!refresh && cachedConfig && Date.now() - cachedAt < 30_000) return cachedConfig;

  const layeredSources = readEnvFiles();
  const envSource = readTwilioEnvFiles();
  const configuredServers = splitCsv(valueFrom(envSource, "PHONE_AGENT_MCP_SERVERS", layeredSources));
  const publicBaseUrl = valueFrom(envSource, "PHONE_AGENT_PUBLIC_BASE_URL", layeredSources).replace(/\/+$/, "");
  const allowedFrom =
    normalizePhoneNumber(valueFrom(envSource, "PHONE_AGENT_ALLOWED_FROM", layeredSources)) || DEFAULT_ALLOWED_FROM;

  cachedConfig = {
    accountSid: valueFrom(envSource, "TWILIO_ACCOUNT_SID"),
    authToken: valueFrom(envSource, "TWILIO_AUTH_TOKEN"),
    fromNumber: normalizePhoneNumber(valueFrom(envSource, "TWILIO_FROM_NUMBER")),
    agentNumber: normalizePhoneNumber(valueFrom(envSource, "PHONE_AGENT_NUMBER", layeredSources)),
    allowedFrom,
    publicBaseUrl,
    voice: valueFrom(envSource, "PHONE_AGENT_VOICE", layeredSources) || "marin",
    phoneMcpServers: configuredServers.length ? configuredServers : DEFAULT_PHONE_MCP_SERVERS,
    sourceKind: envSource ? "env-file" : "environment",
    sourcePath: envSource?.filePath ?? null,
    foundAt: new Date().toISOString(),
  };
  cachedAt = Date.now();
  return cachedConfig;
}

export function publicTwilioStatus(req) {
  const config = loadTwilioConfig();
  const paths = getPhoneAgentPaths();
  const voiceWebhookUrl = buildExternalUrl(req, paths.voice);
  const mediaStreamUrl = toWebSocketUrl(buildExternalUrl(req, paths.media));
  return {
    available: Boolean(config.accountSid && config.authToken),
    accountSidSuffix: config.accountSid ? config.accountSid.slice(-6) : null,
    sourceKind: config.sourceKind,
    sourcePath: config.sourcePath,
    allowedFrom: config.allowedFrom,
    fromNumber: config.fromNumber || null,
    agentNumber: config.agentNumber || null,
    publicBaseUrl: config.publicBaseUrl || null,
    pathPrefix: getPhoneAgentPathPrefix(),
    voiceWebhookUrl,
    mediaStreamUrl,
    phoneMcpServers: config.phoneMcpServers,
  };
}

export function createTwilioClient() {
  const config = loadTwilioConfig();
  if (!config.accountSid || !config.authToken) {
    throw new Error("Twilio credentials were not found.");
  }
  return twilio(config.accountSid, config.authToken);
}

export function externalRequestUrl(req) {
  const config = loadTwilioConfig();
  if (config.publicBaseUrl) return `${config.publicBaseUrl}${publicOriginalUrl(req)}`;
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}${req.originalUrl}`;
}

function publicOriginalUrl(req) {
  const originalUrl = req.originalUrl || req.url || "/";
  const prefix = getPhoneAgentPathPrefix();
  if (!prefix) return originalUrl;
  if (originalUrl.startsWith(prefix)) return originalUrl;
  if (originalUrl === "/voice" || originalUrl.startsWith("/voice?")) return `${prefix}${originalUrl}`;
  if (originalUrl === "/status" || originalUrl.startsWith("/status?")) return `${prefix}${originalUrl}`;
  if (originalUrl === "/media" || originalUrl.startsWith("/media?")) return `${prefix}${originalUrl}`;
  return originalUrl;
}

export function buildExternalUrl(req, pathname) {
  const config = loadTwilioConfig();
  if (config.publicBaseUrl) return `${config.publicBaseUrl}${pathname}`;
  const proto = req?.get?.("x-forwarded-proto") || req?.protocol || "http";
  const host = req?.get?.("x-forwarded-host") || req?.get?.("host") || `127.0.0.1:${process.env.PORT || 8797}`;
  return `${proto}://${host}${pathname}`;
}

export function toWebSocketUrl(url) {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  return url;
}

export function validateTwilioWebhook(req) {
  const config = loadTwilioConfig();
  const signature = req.get("x-twilio-signature");
  if (!config.authToken || !signature) return false;
  return twilio.validateRequest(config.authToken, signature, externalRequestUrl(req), req.body ?? {});
}

export async function searchAvailableLocalNumbers({ country = "CA", areaCode = "438", limit = 8 } = {}) {
  const client = createTwilioClient();
  const numbers = await client.availablePhoneNumbers(country).local.list({
    areaCode: String(areaCode || "").replace(/[^\d]/g, ""),
    smsEnabled: true,
    voiceEnabled: true,
    limit,
  });

  return numbers.map((number) => ({
    phoneNumber: number.phoneNumber,
    friendlyName: number.friendlyName,
    locality: number.locality,
    region: number.region,
    isoCountry: number.isoCountry,
    addressRequirements: number.addressRequirements,
    capabilities: number.capabilities,
  }));
}

export async function purchasePhoneNumber({ phoneNumber, voiceUrl }) {
  const client = createTwilioClient();
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) throw new Error("A valid E.164 phone number is required.");
  return client.incomingPhoneNumbers.create({
    phoneNumber: normalized,
    friendlyName: "Lanart Realtime Phone Agent",
    voiceUrl,
    voiceMethod: "POST",
  });
}
