import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
import { JWT } from "google-auth-library";

const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1";
const META_GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_MAILBOX = "james@lanartrug.com";
const DEFAULT_FROM = "James Galbraith <james@lanartrug.com>";

const CLOUD_TOOLS = [
  {
    name: "cloud_search_recent_emails",
    description:
      "Search James's Gmail mailbox from the cloud deployment. Use Gmail query syntax, for example newer_than:7d, from:someone, subject:invoice.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query. Default: newer_than:7d" },
        mailbox: { type: "string", description: "Mailbox to search. Default: james@lanartrug.com" },
        maxResults: { type: "integer", minimum: 1, maximum: 20, description: "Maximum messages to return. Default 5." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cloud_get_email_message",
    description: "Fetch a Gmail message body by mailbox and message id returned by cloud_search_recent_emails.",
    requiresApproval: false,
    parameters: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string", description: "Gmail message id." },
        mailbox: { type: "string", description: "Mailbox. Default: james@lanartrug.com" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cloud_send_summary_email",
    description:
      "Send a plain-text summary email from James's Gmail account. Only use after James clearly asks to send or confirms the exact message.",
    requiresApproval: true,
    parameters: {
      type: "object",
      required: ["to", "subject", "body"],
      properties: {
        to: { type: "string", description: "Recipient email address or comma-separated addresses." },
        cc: { type: "string", description: "Optional cc recipients." },
        subject: { type: "string" },
        body: { type: "string" },
        mailbox: { type: "string", description: "Sender mailbox. Default: james@lanartrug.com" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cloud_list_top_meta_ads",
    description:
      "List top Meta ads by purchase performance and spend for the configured ad account. Use for top-performing ads and spend questions.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        datePreset: {
          type: "string",
          description: "Meta date preset such as today, yesterday, last_7d, last_14d, or this_month. Default: today.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum ads to return. Default 5." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cloud_get_meta_adset_budget",
    description: "Get the current daily or lifetime budget for a Meta ad set.",
    requiresApproval: false,
    parameters: {
      type: "object",
      required: ["adsetId"],
      properties: {
        adsetId: { type: "string", description: "Meta ad set id." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cloud_double_meta_adset_daily_budget",
    description:
      "Double a Meta ad set daily budget. This mutates ad spend and requires confirm exactly equal to DOUBLE <adsetId>.",
    requiresApproval: true,
    parameters: {
      type: "object",
      required: ["adsetId", "confirm"],
      properties: {
        adsetId: { type: "string", description: "Meta ad set id." },
        confirm: { type: "string", description: "Must exactly equal DOUBLE <adsetId>." },
      },
      additionalProperties: false,
    },
  },
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function optionalEnv(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return "";
}

function safeLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

function getMailbox(value) {
  return String(value || optionalEnv("GOOGLE_IMPERSONATE_EMAIL", "GMAIL_IMPERSONATE_EMAIL") || DEFAULT_MAILBOX).trim();
}

function getGoogleCredentials() {
  const raw = optionalEnv("GOOGLE_SERVICE_ACCOUNT_KEY_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_KEY_JSON.");
  const credentials = JSON.parse(raw);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google service account JSON must include client_email and private_key.");
  }
  return credentials;
}

function createGmailAuth(mailbox, scopes) {
  const credentials = getGoogleCredentials();
  return new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    subject: mailbox,
    scopes,
  });
}

async function googleRequest(auth, pathname, { method = "GET", body } = {}) {
  const headers = await auth.getRequestHeaders();
  const response = await fetch(`${GMAIL_BASE_URL}${pathname}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
  }
  if (!response.ok) {
    throw new Error(parsed?.error?.message || parsed?.text || `Google API returned ${response.status}`);
  }
  return parsed;
}

function headerValue(message, name) {
  const headers = message?.payload?.headers ?? [];
  const found = headers.find((header) => String(header.name).toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

function decodeBase64Url(value) {
  if (!value) return "";
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function extractMessageText(part) {
  if (!part) return "";
  const mimeType = part.mimeType || "";
  if (mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  if (mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return (part.parts ?? []).map(extractMessageText).filter(Boolean).join("\n\n");
}

function summarizeMessage(mailbox, message) {
  return {
    mailbox,
    id: message.id,
    threadId: message.threadId,
    date: headerValue(message, "Date"),
    from: headerValue(message, "From"),
    to: headerValue(message, "To"),
    subject: headerValue(message, "Subject"),
    snippet: message.snippet ?? "",
  };
}

async function searchRecentEmails(args = {}) {
  const mailbox = getMailbox(args.mailbox);
  const auth = createGmailAuth(mailbox, ["https://www.googleapis.com/auth/gmail.readonly"]);
  const query = String(args.query || "newer_than:7d").trim();
  const maxResults = safeLimit(args.maxResults, 5, 20);
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const listing = await googleRequest(auth, `/users/${encodeURIComponent(mailbox)}/messages?${params.toString()}`);
  const messages = [];

  for (const message of listing.messages ?? []) {
    const detailParams = new URLSearchParams({ format: "metadata" });
    for (const header of ["Subject", "From", "To", "Cc", "Date", "Message-ID"]) {
      detailParams.append("metadataHeaders", header);
    }
    const detail = await googleRequest(
      auth,
      `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(message.id)}?${detailParams.toString()}`,
    );
    messages.push(summarizeMessage(mailbox, detail));
  }

  return {
    query,
    mailbox,
    resultSizeEstimate: listing.resultSizeEstimate ?? 0,
    returned: messages.length,
    messages,
  };
}

async function getEmailMessage(args = {}) {
  const mailbox = getMailbox(args.mailbox);
  const messageId = String(args.messageId || "").trim();
  if (!messageId) throw new Error("messageId is required.");
  const auth = createGmailAuth(mailbox, ["https://www.googleapis.com/auth/gmail.readonly"]);
  const params = new URLSearchParams({ format: "full" });
  const message = await googleRequest(
    auth,
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?${params.toString()}`,
  );
  const text = extractMessageText(message.payload);
  return {
    ...summarizeMessage(mailbox, message),
    bodyPreview: text.length > 12_000 ? `${text.slice(0, 12_000)}\n\n[truncated ${text.length - 12_000} chars]` : text,
  };
}

function normalizeAddressList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function foldBase64(value) {
  const encoded = Buffer.from(String(value ?? ""), "utf8").toString("base64");
  const chunks = [];
  for (let index = 0; index < encoded.length; index += 76) chunks.push(encoded.slice(index, index + 76));
  return chunks.join("\r\n");
}

function buildRawEmail({ from, to, cc, subject, body }) {
  const toList = normalizeAddressList(to);
  if (!toList.length) throw new Error("At least one recipient is required.");
  const headers = [
    `From: ${String(from || DEFAULT_FROM).replace(/[\r\n]+/g, " ")}`,
    `To: ${toList.join(", ")}`,
    `Subject: ${String(subject || "(no subject)").replace(/[\r\n]+/g, " ")}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@lanartrug.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: base64",
  ];
  const ccList = normalizeAddressList(cc);
  if (ccList.length) headers.splice(2, 0, `Cc: ${ccList.join(", ")}`);
  return Buffer.from([...headers, "", foldBase64(body), ""].join("\r\n"), "utf8").toString("base64url");
}

async function sendSummaryEmail(args = {}) {
  const mailbox = getMailbox(args.mailbox);
  const auth = createGmailAuth(mailbox, ["https://www.googleapis.com/auth/gmail.send"]);
  const raw = buildRawEmail({
    from: DEFAULT_FROM,
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    body: args.body,
  });
  const sent = await googleRequest(auth, `/users/${encodeURIComponent(mailbox)}/messages/send`, {
    method: "POST",
    body: { raw },
  });
  return { sent: true, mailbox, id: sent.id, threadId: sent.threadId, to: normalizeAddressList(args.to), subject: args.subject };
}

function getMetaConfig() {
  const token = requireEnv("META_ACCESS_TOKEN");
  const rawAccountId = requireEnv("META_AD_ACCOUNT_ID");
  const accountId = rawAccountId.startsWith("act_") ? rawAccountId : `act_${rawAccountId}`;
  const apiVersion = optionalEnv("META_API_VERSION") || "v23.0";
  return { token, accountId, apiVersion };
}

async function metaRequest(pathname, params = {}, { method = "GET" } = {}) {
  const { token, apiVersion } = getMetaConfig();
  const url = new URL(`${META_GRAPH_BASE_URL}/${apiVersion}/${pathname.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("access_token", token);
  const response = await fetch(url, { method });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
  }
  if (!response.ok) {
    throw new Error(parsed?.error?.message || parsed?.text || `Meta API returned ${response.status}`);
  }
  return parsed;
}

function actionValue(actions = [], matcher) {
  return actions
    .filter((action) => matcher(String(action.action_type || "")))
    .reduce((sum, action) => sum + Number(action.value || 0), 0);
}

function normalizeInsight(row) {
  const purchases = actionValue(row.actions, (type) => type.includes("purchase"));
  const leads = actionValue(row.actions, (type) => type.includes("lead"));
  const spend = Number(row.spend || 0);
  return {
    adId: row.ad_id,
    adName: row.ad_name,
    adsetId: row.adset_id,
    adsetName: row.adset_name,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    spend,
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    ctr: Number(row.ctr || 0),
    purchases,
    leads,
    costPerPurchase: purchases > 0 ? spend / purchases : null,
  };
}

async function listTopMetaAds(args = {}) {
  const { accountId } = getMetaConfig();
  const limit = safeLimit(args.limit, 5, 20);
  const datePreset = String(args.datePreset || "today").trim();
  const fields = [
    "ad_id",
    "ad_name",
    "adset_id",
    "adset_name",
    "campaign_id",
    "campaign_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "actions",
  ].join(",");
  const data = await metaRequest(`/${accountId}/insights`, {
    fields,
    level: "ad",
    date_preset: datePreset,
    limit: 200,
  });
  const ads = (data.data ?? [])
    .map(normalizeInsight)
    .filter((ad) => ad.spend > 0 || ad.purchases > 0 || ad.clicks > 0)
    .sort((a, b) => {
      if (b.purchases !== a.purchases) return b.purchases - a.purchases;
      if (a.costPerPurchase != null && b.costPerPurchase != null) return a.costPerPurchase - b.costPerPurchase;
      if (a.costPerPurchase != null) return -1;
      if (b.costPerPurchase != null) return 1;
      return b.spend - a.spend;
    })
    .slice(0, limit);
  return {
    accountId,
    datePreset,
    currency: optionalEnv("META_AD_ACCOUNT_CURRENCY") || "CAD",
    returned: ads.length,
    ads,
  };
}

async function getMetaAdsetBudget(args = {}) {
  const adsetId = String(args.adsetId || "").trim();
  if (!adsetId) throw new Error("adsetId is required.");
  const data = await metaRequest(`/${adsetId}`, {
    fields: "id,name,daily_budget,lifetime_budget,budget_remaining,status,effective_status,account_id",
  });
  return {
    id: data.id,
    name: data.name,
    accountId: data.account_id,
    status: data.status,
    effectiveStatus: data.effective_status,
    dailyBudgetMinor: data.daily_budget ? Number(data.daily_budget) : null,
    dailyBudget: data.daily_budget ? Number(data.daily_budget) / 100 : null,
    lifetimeBudgetMinor: data.lifetime_budget ? Number(data.lifetime_budget) : null,
    lifetimeBudget: data.lifetime_budget ? Number(data.lifetime_budget) / 100 : null,
    budgetRemainingMinor: data.budget_remaining ? Number(data.budget_remaining) : null,
    currency: optionalEnv("META_AD_ACCOUNT_CURRENCY") || "CAD",
  };
}

async function doubleMetaAdsetDailyBudget(args = {}) {
  const adsetId = String(args.adsetId || "").trim();
  if (!adsetId) throw new Error("adsetId is required.");
  if (String(args.confirm || "") !== `DOUBLE ${adsetId}`) {
    return {
      updated: false,
      requiresConfirmation: true,
      confirmationRequired: `DOUBLE ${adsetId}`,
      message: "Ask James to confirm the exact budget change before calling this tool again.",
    };
  }

  const current = await getMetaAdsetBudget({ adsetId });
  if (!current.dailyBudgetMinor) throw new Error("This ad set does not have a daily budget to double.");
  const nextBudgetMinor = current.dailyBudgetMinor * 2;
  const data = await metaRequest(`/${adsetId}`, { daily_budget: nextBudgetMinor }, { method: "POST" });
  const updated = await getMetaAdsetBudget({ adsetId });
  return {
    updated: Boolean(data.success),
    before: current,
    after: updated,
    changedDailyBudgetMinor: nextBudgetMinor,
    changedDailyBudget: nextBudgetMinor / 100,
  };
}

export function getCloudRealtimeTools() {
  return CLOUD_TOOLS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function getCloudPublicTools() {
  return CLOUD_TOOLS.map(({ name, description, requiresApproval }) => ({
    functionName: name,
    originalName: name,
    serverName: "cloud",
    description,
    requiresApproval,
    readOnlyHint: !requiresApproval,
  }));
}

export function getCloudTool(functionName) {
  return CLOUD_TOOLS.find((tool) => tool.name === functionName) ?? null;
}

export async function callCloudTool(functionName, args) {
  switch (functionName) {
    case "cloud_search_recent_emails":
      return JSON.stringify(await searchRecentEmails(args), null, 2);
    case "cloud_get_email_message":
      return JSON.stringify(await getEmailMessage(args), null, 2);
    case "cloud_send_summary_email":
      return JSON.stringify(await sendSummaryEmail(args), null, 2);
    case "cloud_list_top_meta_ads":
      return JSON.stringify(await listTopMetaAds(args), null, 2);
    case "cloud_get_meta_adset_budget":
      return JSON.stringify(await getMetaAdsetBudget(args), null, 2);
    case "cloud_double_meta_adset_daily_budget":
      return JSON.stringify(await doubleMetaAdsetDailyBudget(args), null, 2);
    default:
      throw new Error(`Unknown cloud tool: ${functionName}`);
  }
}
