import crypto from "node:crypto";
import { Buffer } from "node:buffer";

const SESSION_COOKIE = "lanart_agent_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function configuredUsername() {
  return String(process.env.APP_AUTH_USERNAME || "james").trim();
}

function configuredPassword() {
  return String(process.env.APP_AUTH_PASSWORD || "").trim();
}

function sessionSecret() {
  return String(process.env.APP_SESSION_SECRET || "").trim();
}

function authConfigured() {
  return Boolean(configuredUsername() && configuredPassword() && sessionSecret());
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function unbase64url(input) {
  return Buffer.from(String(input), "base64url").toString("utf8");
}

function hmac(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function publicAuthStatus(req) {
  const session = readSession(req);
  return {
    configured: authConfigured(),
    authenticated: Boolean(session),
    username: session?.sub ?? null,
  };
}

export function verifyCredentials(username, password) {
  if (!authConfigured()) return false;
  return timingSafeStringEqual(username, configuredUsername()) && timingSafeStringEqual(password, configuredPassword());
}

export function createSessionCookie(username, { secure = true } = {}) {
  const payload = base64url(
    JSON.stringify({
      sub: username,
      iat: Date.now(),
      exp: Date.now() + SESSION_TTL_MS,
    }),
  );
  const token = `${payload}.${hmac(payload)}`;
  const cookie = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) cookie.push("Secure");
  return cookie.join("; ");
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies.set(key, value);
  }
  return cookies;
}

export function readSession(req) {
  if (!authConfigured()) return null;
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !timingSafeStringEqual(signature, hmac(payload))) return null;

  try {
    const session = JSON.parse(unbase64url(payload));
    if (session.exp <= Date.now()) return null;
    if (session.sub !== configuredUsername()) return null;
    return session;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  if (!authConfigured()) {
    res.status(503).json({ error: "App authentication is not configured." });
    return;
  }
  if (!readSession(req)) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  next();
}
