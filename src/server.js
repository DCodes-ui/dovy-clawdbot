import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Migrate deprecated CLAWDBOT_* env vars → OPENCLAW_* so existing Railway deployments
// keep working. Users should update their Railway Variables to use the new names.
for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const oldKey = `CLAWDBOT_${suffix}`;
  const newKey = `OPENCLAW_${suffix}`;
  if (process.env[oldKey] && !process.env[newKey]) {
    process.env[newKey] = process.env[oldKey];
    // Best-effort compatibility shim for old Railway templates.
    // Intentionally no warning: Railway templates can still set legacy keys and warnings are noisy.
  }
  // Avoid forwarding legacy variables into OpenClaw subprocesses.
  // OpenClaw logs a warning when deprecated CLAWDBOT_* variables are present.
  delete process.env[oldKey];
}

// Railway injects PORT at runtime and routes traffic to that port.
// Do not force a different public port in the container image, or the service may
// boot but the Railway domain will be routed to a different port.
//
// OPENCLAW_PUBLIC_PORT is kept as an escape hatch for non-Railway deployments.
const PORT = Number.parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

// State/workspace
// OpenClaw defaults to ~/.openclaw.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Optional Telegram webhook secret. If set, Telegram must send it in
// the X-Telegram-Bot-Api-Secret-Token header.
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim();
const GROQ_MODEL = process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile";
const GROQ_MODELS = Array.from(
  new Set(
    (process.env.GROQ_MODELS?.trim() || GROQ_MODEL)
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
  ),
);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim();
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim();
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI?.trim() ||
  "https://dovy-clawdbot-production.up.railway.app/google/oauth/callback";
const GOOGLE_CALENDAR_SCOPES =
  process.env.GOOGLE_CALENDAR_SCOPES?.trim() ||
  "https://www.googleapis.com/auth/calendar";
const GOOGLE_CALENDAR_TIME_ZONE = process.env.GOOGLE_CALENDAR_TIME_ZONE?.trim() || "Europe/Berlin";

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
const GOOGLE_OAUTH_STATE_SECRET =
  process.env.GOOGLE_OAUTH_STATE_SECRET?.trim() ||
  TELEGRAM_WEBHOOK_SECRET ||
  OPENCLAW_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];

  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath() {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Default to canonical even if it doesn't exist yet.
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    return resolveConfigCandidates().some((candidate) => fs.existsSync(candidate));
  } catch {
    return false;
  }
}

// One-time migration: rename legacy config files to openclaw.json so existing
// deployments that still have the old filename on their volume keep working.
(function migrateLegacyConfigFile() {
  // If the operator explicitly chose a config path, do not rename files in STATE_DIR.
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return;

  const canonical = path.join(STATE_DIR, "openclaw.json");
  if (fs.existsSync(canonical)) return;

  for (const legacy of ["clawdbot.json", "moltbot.json"]) {
    const legacyPath = path.join(STATE_DIR, legacy);
    try {
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, canonical);
        console.log(`[migration] Renamed ${legacy} → openclaw.json`);
        return;
      }
    } catch (err) {
      console.warn(`[migration] Failed to rename ${legacy}: ${err}`);
    }
  }
})();

let gatewayProc = null;
let gatewayStarting = null;

// Debug breadcrumbs for common Railway failures (502 / "Application failed to respond").
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to root.
      const paths = ["/openclaw", "/"];
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          // Any HTTP response means the port is open.
          if (res) return true;
        } catch {
          // try next
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    console.error(msg);
    lastGatewayExit = { code, signal, at: new Date().toISOString() };
    gatewayProc = null;
  });
}

async function runDoctorBestEffort() {
  // Avoid spamming `openclaw doctor` in a crash loop.
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;

  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) {
          throw new Error("Gateway did not become ready in time");
        }
      } catch (err) {
        const msg = `[gateway] start failure: ${String(err)}`;
        lastGatewayError = msg;
        // Collect extra diagnostics to help users file issues.
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

async function probeGateway() {
  // Don't assume HTTP — the gateway primarily speaks WebSocket.
  // A simple TCP connect check is enough for "is it up".
  const net = await import("node:net");

  return await new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });

    const done = (ok) => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

// Public health endpoint (no auth) so Railway can probe without /setup.
// Keep this free of secrets.
app.get("/healthz", async (_req, res) => {
  let gatewayReachable = false;
  if (isConfigured()) {
    try {
      gatewayReachable = await probeGateway();
    } catch {
      gatewayReachable = false;
    }
  }

  res.json({
    ok: true,
    wrapper: {
      configured: isConfigured(),
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
    },
    gateway: {
      target: GATEWAY_TARGET,
      reachable: gatewayReachable,
      lastError: lastGatewayError,
      lastExit: lastGatewayExit,
      lastDoctorAt,
    },
  });
});

app.get("/telegram/webhook", (_req, res) => {
  res.json({ ok: true, webhook: "telegram" });
});

app.get("/google/oauth/callback", async (req, res) => {
  const state = readGoogleOAuthState(req.query.state);
  const code = typeof req.query.code === "string" ? req.query.code : "";

  if (!state?.chatId || !code) {
    return res.status(400).type("text/plain").send("Ungültiger Google OAuth Callback.\n");
  }

  try {
    const tokens = await exchangeGoogleCode(code);
    saveGoogleTokens(state.chatId, tokens);

    try {
      await sendTelegramMessage(state.chatId, "Google Kalender ist verbunden. Du kannst jetzt /calendar_today, /calendar_next oder /calendar_create nutzen.");
    } catch (err) {
      console.warn(`[google] failed to notify Telegram chat: ${String(err)}`);
    }

    return res.type("html").send(`<!doctype html>
<html>
<body style="font-family: system-ui, sans-serif; margin: 2rem;">
  <h1>Google Kalender verbunden</h1>
  <p>Du kannst dieses Fenster schließen und zum Telegram-Bot zurückkehren.</p>
</body>
</html>`);
  } catch (err) {
    console.error(`[google] oauth callback failed: ${String(err)}`);
    return res.status(500).type("text/plain").send("Google Kalender konnte nicht verbunden werden. Bitte prüfe die Railway Logs.\n");
  }
});

function appendWorkspaceJsonl(filename, record) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.appendFileSync(
    path.join(WORKSPACE_DIR, filename),
    `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`,
  );
}

function readWorkspaceJsonl(filename) {
  try {
    const raw = fs.readFileSync(path.join(WORKSPACE_DIR, filename), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readChatModels() {
  try {
    return JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIR, "telegram-chat-models.json"), "utf8"));
  } catch {
    return {};
  }
}

function writeChatModels(models) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_DIR, "telegram-chat-models.json"), JSON.stringify(models, null, 2));
}

function googleTokensDir() {
  return path.join(WORKSPACE_DIR, "google-tokens");
}

function googleTokenPath(chatId) {
  return path.join(googleTokensDir(), `${String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function createGoogleOAuthState(chatId) {
  const payload = Buffer.from(JSON.stringify({ chatId, nonce: crypto.randomBytes(8).toString("hex") })).toString("base64url");
  const sig = crypto
    .createHmac("sha256", GOOGLE_OAUTH_STATE_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function readGoogleOAuthState(state) {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) return null;

  const expected = crypto
    .createHmac("sha256", GOOGLE_OAUTH_STATE_SECRET)
    .update(payload)
    .digest("base64url");
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function googleConnectUrl(chatId) {
  if (!GOOGLE_CLIENT_ID) return null;

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: createGoogleOAuthState(chatId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function saveGoogleTokens(chatId, tokens) {
  fs.mkdirSync(googleTokensDir(), { recursive: true });
  fs.writeFileSync(googleTokenPath(chatId), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function loadGoogleTokens(chatId) {
  try {
    return JSON.parse(fs.readFileSync(googleTokenPath(chatId), "utf8"));
  } catch {
    return null;
  }
}

async function exchangeGoogleCode(code) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    tokenType: data.token_type,
    expiresAt: Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000,
  };
}

async function refreshGoogleTokens(chatId, tokens) {
  if (!tokens?.refreshToken) {
    throw new Error("Google refresh token is missing. Please reconnect Google Calendar.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const refreshed = {
    ...tokens,
    accessToken: data.access_token,
    scope: data.scope || tokens.scope,
    tokenType: data.token_type || tokens.tokenType,
    expiresAt: Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000,
  };
  saveGoogleTokens(chatId, refreshed);
  return refreshed;
}

async function getGoogleAccessToken(chatId) {
  const tokens = loadGoogleTokens(chatId);
  if (!tokens?.accessToken) {
    throw new Error("Google Calendar ist noch nicht verbunden. Nutze /connect_google.");
  }
  if (tokens.expiresAt && Date.now() < tokens.expiresAt) return tokens.accessToken;
  return (await refreshGoogleTokens(chatId, tokens)).accessToken;
}

async function googleCalendarRequest(chatId, calendarPath, options = {}) {
  const accessToken = await getGoogleAccessToken(chatId);
  const response = await fetch(`https://www.googleapis.com/calendar/v3${calendarPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google Calendar request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function formatCalendarEvent(event) {
  const start = event.start?.dateTime || event.start?.date || "";
  const when = start ? new Date(start).toLocaleString("de-DE", { timeZone: GOOGLE_CALENDAR_TIME_ZONE }) : "ohne Zeit";
  return `${when} - ${event.summary || "(ohne Titel)"}`;
}

async function listCalendarEvents(chatId, maxResults = 5, hoursAhead = 24 * 14) {
  const now = new Date();
  const until = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxResults),
    timeZone: GOOGLE_CALENDAR_TIME_ZONE,
  });

  const data = await googleCalendarRequest(chatId, `/calendars/primary/events?${params.toString()}`);
  return Array.isArray(data.items) ? data.items : [];
}

function addMinutesToLocalDateTime(date, time, minutesToAdd) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute + minutesToAdd, 0));
  const pad = (value) => String(value).padStart(2, "0");
  return {
    date: `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`,
    time: `${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}`,
  };
}

async function createCalendarEvent(chatId, { date, time, durationMinutes = 60, summary }) {
  if (!date || !time || !summary) {
    throw new Error("date, time and summary are required");
  }

  const end = addMinutesToLocalDateTime(date, time, durationMinutes);
  return await googleCalendarRequest(chatId, "/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      summary,
      start: {
        dateTime: `${date}T${time}:00`,
        timeZone: GOOGLE_CALENDAR_TIME_ZONE,
      },
      end: {
        dateTime: `${end.date}T${end.time}:00`,
        timeZone: GOOGLE_CALENDAR_TIME_ZONE,
      },
    }),
  });
}

async function createCalendarEventFromCommand(chatId, arg) {
  const match = arg.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s+(\d+))?\s+(.+)$/);
  if (!match) {
    return {
      ok: false,
      message: [
        "Format:",
        "/calendar_create YYYY-MM-DD HH:mm DauerMin Titel",
        "",
        "Beispiel:",
        "/calendar_create 2026-05-03 15:00 60 Zahnarzt",
      ].join("\n"),
    };
  }

  const [, date, time, durationRaw, summary] = match;
  const durationMinutes = Number.parseInt(durationRaw || "60", 10);
  const event = await createCalendarEvent(chatId, { date, time, durationMinutes, summary });

  return {
    ok: true,
    message: `Termin erstellt:\n${formatCalendarEvent(event)}`,
  };
}

function getChatModel(chatId) {
  const models = readChatModels();
  return models[String(chatId)] || GROQ_MODEL;
}

function setChatModel(chatId, model) {
  const models = readChatModels();
  models[String(chatId)] = model;
  writeChatModels(models);
}

function saveTaskEvent(event) {
  try {
    appendWorkspaceJsonl("telegram-tasks.jsonl", event);
  } catch (err) {
    console.warn(`[telegram] failed to save task: ${String(err)}`);
  }
}

function loadTasksForChat(chatId) {
  const latestByTask = new Map();
  for (const event of readWorkspaceJsonl("telegram-tasks.jsonl")) {
    if (String(event.chatId) !== String(chatId) || !event.taskId) continue;
    latestByTask.set(event.taskId, { ...latestByTask.get(event.taskId), ...event });
  }

  return Array.from(latestByTask.values()).sort((a, b) =>
    String(b.updatedAt || b.at || "").localeCompare(String(a.updatedAt || a.at || "")),
  );
}

function formatTaskLine(task) {
  const status = task.status || "unknown";
  const text = String(task.userText || "").replace(/\s+/g, " ").slice(0, 80);
  return `${task.taskId.slice(0, 8)} | ${status} | ${text || "(ohne Text)"}`;
}

function formatHelpMessage() {
  return [
    "Verfügbare Befehle:",
    "/help - Hilfe anzeigen",
    "/gc - Google-Kalender-Menü öffnen",
    "/tasks - letzte Aufgaben anzeigen",
    "/last - letztes Ergebnis anzeigen",
    "/model - aktuelles Modell anzeigen",
    "/model list - verfügbare Modelle anzeigen",
    "/model <modell> - Modell für diesen Chat setzen",
    "/connect_google - Google Kalender verbinden",
    "/disconnect_google - Google Kalender trennen",
    "/calendar_next - nächste Termine anzeigen",
    "/calendar_today - Termine der nächsten 24 Stunden anzeigen",
    "/calendar_create YYYY-MM-DD HH:mm DauerMin Titel - Termin erstellen",
    "",
    "Sende sonst einfach eine Aufgabe als normale Nachricht.",
  ].join("\n");
}

async function answerTelegramCallback(callbackQueryId, text = "") {
  if (!TELEGRAM_BOT_TOKEN || !callbackQueryId) return;

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram answerCallbackQuery failed: ${response.status} ${body}`);
  }
}

async function sendGoogleCalendarMenu(chatId) {
  await sendTelegramMessage(chatId, "Google Kalender: Was möchtest du tun?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Heute", callback_data: "gc:today" },
          { text: "Nächste Termine", callback_data: "gc:next" },
        ],
        [
          { text: "Verbinden", callback_data: "gc:connect" },
          { text: "Trennen", callback_data: "gc:disconnect" },
        ],
        [
          { text: "Termin erstellen: Format anzeigen", callback_data: "gc:create_help" },
        ],
      ],
    },
  });
}

async function handleGoogleCalendarAction(chatId, action) {
  if (action === "connect") {
    const url = googleConnectUrl(chatId);
    await sendTelegramMessage(
      chatId,
      url
        ? `Google Kalender verbinden:\n${url}`
        : "Google OAuth ist noch nicht konfiguriert. Bitte setze GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET und GOOGLE_REDIRECT_URI in Railway.",
    );
    return;
  }

  if (action === "disconnect") {
    fs.rmSync(googleTokenPath(chatId), { force: true });
    await sendTelegramMessage(chatId, "Google Kalender wurde getrennt.");
    return;
  }

  if (action === "today") {
    const events = await listCalendarEvents(chatId, 10, 24);
    await sendTelegramMessage(
      chatId,
      events.length
        ? `Termine der nächsten 24 Stunden:\n${events.map(formatCalendarEvent).join("\n")}`
        : "Keine Termine in den nächsten 24 Stunden gefunden.",
    );
    return;
  }

  if (action === "next") {
    const events = await listCalendarEvents(chatId, 5, 24 * 14);
    await sendTelegramMessage(
      chatId,
      events.length
        ? `Nächste Termine:\n${events.map(formatCalendarEvent).join("\n")}`
        : "Keine anstehenden Termine gefunden.",
    );
    return;
  }

  if (action === "create_help") {
    await sendTelegramMessage(
      chatId,
      [
        "Termin erstellen:",
        "/calendar_create YYYY-MM-DD HH:mm DauerMin Titel",
        "",
        "Beispiel:",
        "/calendar_create 2026-05-03 15:00 60 Zahnarzt",
      ].join("\n"),
    );
  }
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  if (!chatId) {
    throw new Error("Telegram chat id is missing");
  }

  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) {
    chunks.push(text.slice(i, i + 3900));
  }

  for (const chunk of chunks.length ? chunks : [""]) {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        ...extra,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
    }

    console.log(`[telegram] sent message chat=${chatId} chars=${chunk.length}`);
  }
}

async function callGroq(prompt, model = GROQ_MODEL) {
  if (!GROQ_API_KEY) {
    return "Groq ist noch nicht konfiguriert. Bitte setze GROQ_API_KEY in Railway und redeploye den Service.";
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "Du bist ein hilfreicher Aufgaben-Assistent. Antworte kurz, konkret und auf Deutsch, sofern der Nutzer nichts anderes verlangt.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Groq request failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || "Ich habe keine Antwort von Groq erhalten.";
}

function getZonedNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: GOOGLE_CALENDAR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
    weekday: value("weekday"),
    timeZone: GOOGLE_CALENDAR_TIME_ZONE,
  };
}

function extractJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function detectCalendarIntent(text) {
  if (!GROQ_API_KEY) return { action: "none" };

  const now = getZonedNowParts();
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "Du bist ein Parser fuer Google-Kalender-Wuensche.",
            "Antworte ausschliesslich als JSON-Objekt ohne Markdown.",
            "Erlaubte actions: create_calendar_event, list_calendar_events, none.",
            "Nutze action none, wenn Datum oder Uhrzeit fuer einen neuen Termin unklar sind.",
            "Fuer create_calendar_event nutze Felder: action, summary, date, time, durationMinutes.",
            "date muss YYYY-MM-DD sein, time muss HH:mm sein, durationMinutes default 60.",
            "Fuer list_calendar_events nutze Felder: action, rangeHours, maxResults.",
            `Heute ist ${now.weekday}, ${now.date}, ${now.time} (${now.timeZone}).`,
          ].join("\n"),
        },
        { role: "user", content: text },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Groq calendar intent failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return extractJsonObject(data?.choices?.[0]?.message?.content) || { action: "none" };
}

async function handleNaturalCalendarIntent(chatId, text) {
  const intent = await detectCalendarIntent(text);

  if (intent?.action === "create_calendar_event") {
    const durationMinutes = Math.min(Math.max(Number.parseInt(String(intent.durationMinutes || "60"), 10) || 60, 1), 24 * 60);
    const event = await createCalendarEvent(chatId, {
      date: intent.date,
      time: intent.time,
      durationMinutes,
      summary: intent.summary,
    });
    return `Termin erstellt:\n${formatCalendarEvent(event)}`;
  }

  if (intent?.action === "list_calendar_events") {
    const rangeHours = Math.min(Math.max(Number.parseInt(String(intent.rangeHours || "336"), 10) || 336, 1), 24 * 60);
    const maxResults = Math.min(Math.max(Number.parseInt(String(intent.maxResults || "5"), 10) || 5, 1), 10);
    const events = await listCalendarEvents(chatId, maxResults, rangeHours);
    return events.length
      ? `Gefundene Termine:\n${events.map(formatCalendarEvent).join("\n")}`
      : "Keine passenden Termine gefunden.";
  }

  return null;
}

function saveTelegramConversation(record) {
  try {
    appendWorkspaceJsonl("telegram-conversations.jsonl", record);
  } catch (err) {
    console.warn(`[telegram] failed to save conversation: ${String(err)}`);
  }
}

async function handleTelegramCommand({ chatId, text }) {
  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const arg = args.join(" ").trim();

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(chatId, formatHelpMessage());
    return true;
  }

  if (command === "/gc") {
    await sendGoogleCalendarMenu(chatId);
    return true;
  }

  if (command === "/tasks") {
    const tasks = loadTasksForChat(chatId).slice(0, 10);
    await sendTelegramMessage(
      chatId,
      tasks.length
        ? `Letzte Aufgaben:\n${tasks.map(formatTaskLine).join("\n")}`
        : "Noch keine Aufgaben gespeichert.",
    );
    return true;
  }

  if (command === "/last") {
    const last = loadTasksForChat(chatId)[0];
    if (!last) {
      await sendTelegramMessage(chatId, "Noch keine Aufgaben gespeichert.");
      return true;
    }

    const answer = last.assistantText ? `\n\nAntwort:\n${last.assistantText}` : "";
    await sendTelegramMessage(chatId, `${formatTaskLine(last)}${answer}`);
    return true;
  }

  if (command === "/model") {
    if (!arg) {
      await sendTelegramMessage(chatId, `Aktuelles Modell:\n${getChatModel(chatId)}`);
      return true;
    }

    if (arg.toLowerCase() === "list") {
      await sendTelegramMessage(
        chatId,
        `Verfügbare Modelle:\n${GROQ_MODELS.map((model, index) => `${index + 1}. ${model}`).join("\n")}`,
      );
      return true;
    }

    const selected = /^\d+$/.test(arg) ? GROQ_MODELS[Number.parseInt(arg, 10) - 1] : arg;
    if (!selected) {
      await sendTelegramMessage(chatId, "Dieses Modell kenne ich nicht. Nutze /model list.");
      return true;
    }

    setChatModel(chatId, selected);
    await sendTelegramMessage(chatId, `Modell gesetzt auf:\n${selected}`);
    return true;
  }

  if (command === "/connect_google") {
    const url = googleConnectUrl(chatId);
    if (!url) {
      await sendTelegramMessage(
        chatId,
        "Google OAuth ist noch nicht konfiguriert. Bitte setze GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET und GOOGLE_REDIRECT_URI in Railway.",
      );
      return true;
    }

    await sendTelegramMessage(chatId, `Google Kalender verbinden:\n${url}`);
    return true;
  }

  if (command === "/disconnect_google") {
    try {
      fs.rmSync(googleTokenPath(chatId), { force: true });
      await sendTelegramMessage(chatId, "Google Kalender wurde getrennt.");
    } catch (err) {
      await sendTelegramMessage(chatId, `Google Kalender konnte nicht getrennt werden: ${String(err)}`);
    }
    return true;
  }

  if (command === "/calendar_next") {
    try {
      const maxResults = Math.min(Math.max(Number.parseInt(arg || "5", 10) || 5, 1), 10);
      const events = await listCalendarEvents(chatId, maxResults, 24 * 14);
      await sendTelegramMessage(
        chatId,
        events.length
          ? `Nächste Termine:\n${events.map(formatCalendarEvent).join("\n")}`
          : "Keine anstehenden Termine gefunden.",
      );
    } catch (err) {
      await sendTelegramMessage(chatId, `Kalender konnte nicht gelesen werden: ${String(err)}`);
    }
    return true;
  }

  if (command === "/calendar_today") {
    try {
      const events = await listCalendarEvents(chatId, 10, 24);
      await sendTelegramMessage(
        chatId,
        events.length
          ? `Termine der nächsten 24 Stunden:\n${events.map(formatCalendarEvent).join("\n")}`
          : "Keine Termine in den nächsten 24 Stunden gefunden.",
      );
    } catch (err) {
      await sendTelegramMessage(chatId, `Kalender konnte nicht gelesen werden: ${String(err)}`);
    }
    return true;
  }

  if (command === "/calendar_create") {
    try {
      const result = await createCalendarEventFromCommand(chatId, arg);
      await sendTelegramMessage(chatId, result.message);
    } catch (err) {
      await sendTelegramMessage(chatId, `Termin konnte nicht erstellt werden: ${String(err)}`);
    }
    return true;
  }

  return false;
}

async function handleTelegramMessage({ chatId, text, updateId }) {
  if (!chatId) return;

  if (!text.trim()) {
    try {
      await sendTelegramMessage(chatId, "Bitte sende mir eine Textnachricht.");
    } catch (err) {
      console.error(`[telegram] failed to send non-text notice: ${String(err)}`);
    }
    return;
  }

  if (text.trim().startsWith("/") && await handleTelegramCommand({ chatId, text })) {
    return;
  }

  const taskId = `${Date.now().toString(36)}-${updateId ?? crypto.randomBytes(3).toString("hex")}`;
  const model = getChatModel(chatId);
  const startedAt = new Date().toISOString();
  saveTaskEvent({ taskId, updateId, chatId, status: "running", userText: text, model, createdAt: startedAt, updatedAt: startedAt });

  try {
    await sendTelegramMessage(chatId, "Ich bearbeite deine Anfrage...");
    const calendarAnswer = await handleNaturalCalendarIntent(chatId, text);
    const answer = calendarAnswer || await callGroq(text, model);
    const finishedAt = new Date().toISOString();
    saveTaskEvent({ taskId, updateId, chatId, status: "done", userText: text, assistantText: answer, model, createdAt: startedAt, updatedAt: finishedAt });
    saveTelegramConversation({ updateId, chatId, taskId, userText: text, assistantText: answer, model });
    await sendTelegramMessage(chatId, answer);
  } catch (err) {
    console.error(`[telegram] failed to handle message: ${String(err)}`);
    saveTaskEvent({ taskId, updateId, chatId, status: "failed", userText: text, error: String(err), model, createdAt: startedAt, updatedAt: new Date().toISOString() });
    try {
      const message = String(err).includes("Google Calendar ist noch nicht verbunden")
        ? "Google Kalender ist noch nicht verbunden. Nutze /connect_google oder /gc."
        : "Beim Bearbeiten ist ein Fehler aufgetreten. Bitte prüfe die Railway Logs.";
      await sendTelegramMessage(chatId, message);
    } catch (sendErr) {
      console.error(`[telegram] failed to send error message: ${String(sendErr)}`);
    }
  }
}

async function handleTelegramCallback(callbackQuery) {
  const callbackId = callbackQuery?.id;
  const chatId = callbackQuery?.message?.chat?.id;
  const data = callbackQuery?.data || "";

  try {
    await answerTelegramCallback(callbackId);
  } catch (err) {
    console.warn(`[telegram] failed to answer callback: ${String(err)}`);
  }

  if (!chatId || !data.startsWith("gc:")) return;

  try {
    await handleGoogleCalendarAction(chatId, data.slice(3));
  } catch (err) {
    console.error(`[telegram] failed to handle callback: ${String(err)}`);
    await sendTelegramMessage(chatId, `Google Kalender Aktion fehlgeschlagen: ${String(err)}`);
  }
}

app.post("/telegram/webhook", (req, res) => {
  if (
    TELEGRAM_WEBHOOK_SECRET &&
    req.get("X-Telegram-Bot-Api-Secret-Token") !== TELEGRAM_WEBHOOK_SECRET
  ) {
    console.warn("[telegram] webhook secret mismatch");
    return res.sendStatus(403);
  }

  const update = req.body ?? {};
  const callbackQuery = update.callback_query;
  const message = update.message ?? update.edited_message ?? update.channel_post;
  const chat = message?.chat;
  const text = typeof message?.text === "string" ? message.text : "";

  console.log(
    `[telegram] incoming update id=${update.update_id ?? "(unknown)"} chat=${chat?.id ?? callbackQuery?.message?.chat?.id ?? "(unknown)"} type=${chat?.type ?? callbackQuery?.message?.chat?.type ?? "unknown"} text=${text ? JSON.stringify(text.slice(0, 120)) : callbackQuery ? `(callback ${callbackQuery.data})` : "(non-text)"}`,
  );

  res.sendStatus(200);

  if (callbackQuery) {
    void handleTelegramCallback(callbackQuery);
  } else {
    void handleTelegramMessage({
      chatId: chat?.id,
      text,
      updateId: update.update_id,
    });
  }
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>OpenClaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="gateway.restart">gateway.restart (wrapper-managed)</option>
        <option value="gateway.stop">gateway.stop (wrapper-managed)</option>
        <option value="gateway.start">gateway.start (wrapper-managed)</option>
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.version">openclaw --version</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port)" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup">
      <option>Loading providers…</option>
    </select>

    <label>Auth method</label>
    <select id="authChoice">
      <option>Loading methods…</option>
    </select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside OpenClaw, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>2b) Advanced: Custom OpenAI-compatible provider (optional)</h2>
    <p class="muted">Use this to configure an OpenAI-compatible API that requires a custom base URL (e.g. Ollama, vLLM, LM Studio, hosted proxies). You usually set the API key as a Railway variable and reference it here.</p>

    <label>Provider id (e.g. ollama, deepseek, myproxy)</label>
    <input id="customProviderId" placeholder="ollama" />

    <label>Base URL (must include /v1, e.g. http://host:11434/v1)</label>
    <input id="customProviderBaseUrl" placeholder="http://127.0.0.1:11434/v1" />

    <label>API (openai-completions or openai-responses)</label>
    <select id="customProviderApi">
      <option value="openai-completions">openai-completions</option>
      <option value="openai-responses">openai-responses</option>
    </select>

    <label>API key env var name (optional, e.g. OLLAMA_API_KEY). Leave blank for no key.</label>
    <input id="customProviderApiKeyEnv" placeholder="OLLAMA_API_KEY" />

    <label>Optional model id to register (e.g. llama3.1:8b)</label>
    <input id="customProviderModelId" placeholder="" />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the OpenClaw config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>

    <details style="margin-top: 0.75rem">
      <summary><strong>Pairing helper</strong> (for “disconnected (1008): pairing required”)</summary>
      <p class="muted">This lists pending device requests and lets you approve them without SSH.</p>
      <button id="devicesRefresh" style="background:#0f172a">Refresh pending devices</button>
      <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
    </details>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

const AUTH_GROUPS = [
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
    { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
    { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
    { value: "openai-api-key", label: "OpenAI API key" }
  ]},
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
    { value: "token", label: "Anthropic token (paste setup-token)" },
    { value: "apiKey", label: "Anthropic API key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
    { value: "gemini-api-key", label: "Google Gemini API key" },
    { value: "google-antigravity", label: "Google Antigravity OAuth" },
    { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key" }
  ]},
  { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
    { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
  ]},
  { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
    { value: "moonshot-api-key", label: "Moonshot AI API key" },
    { value: "kimi-code-api-key", label: "Kimi Code API key" }
  ]},
  { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
    { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
  ]},
  { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
    { value: "minimax-api", label: "MiniMax M2.1" },
    { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
  ]},
  { value: "qwen", label: "Qwen", hint: "OAuth", options: [
    { value: "qwen-portal", label: "Qwen OAuth" }
  ]},
  { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
    { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
    { value: "copilot-proxy", label: "Copilot Proxy (local)" }
  ]},
  { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
    { value: "synthetic-api-key", label: "Synthetic API key" }
  ]},
  { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
    { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
  ]}
];

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
});

app.get("/setup/api/auth-groups", requireSetupAuth, (_req, res) => {
  res.json({ ok: true, authGroups: AUTH_GROUPS });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };

    const flag = map[payload.authChoice];

    // If the user picked an API-key auth choice but didn't provide a secret, fail fast.
    // Otherwise OpenClaw may fall back to its default auth choice, which looks like the
    // wizard "reverted" their selection.
    if (flag && !secret) {
      throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    }

    if (flag) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token") {
      // This is the Anthropic setup-token flow.
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;

    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    let killTimer;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2_000);
      out += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;
      resolve({ code: 124, output: out });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const respondJson = (status, body) => {
      if (res.writableEnded || res.headersSent) return;
      res.status(status).json(body);
    };
    if (isConfigured()) {
      await ensureGatewayRunning();
      return respondJson(200, {
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    let onboardArgs;
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return respondJson(400, { ok: false, output: `Setup input error: ${String(err)}` });
    }

    const prefix = "[setup] running openclaw onboard...\n";
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional setup (only after successful onboarding).
  if (ok) {
    // Ensure gateway token is written into config so the browser UI can authenticate reliably.
    // (We also enforce loopback bind since the wrapper proxies externally.)
    // IMPORTANT: Set both gateway.auth.token (server-side) and gateway.remote.token (client-side)
    // to the same value so the Control UI can connect without "token mismatch" errors.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    // Railway runs behind a reverse proxy. Trust loopback as a proxy hop so local client detection
    // remains correct when X-Forwarded-* headers are present.
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "gateway.trustedProxies", JSON.stringify(["127.0.0.1"]) ]),
    );

    // Optional: configure a custom OpenAI-compatible provider (base URL) for advanced users.
    if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
      const providerId = payload.customProviderId.trim();
      const baseUrl = payload.customProviderBaseUrl.trim();
      const api = (payload.customProviderApi || "openai-completions").trim();
      const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
      const modelId = (payload.customProviderModelId || "").trim();

      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
        extra += `\n[custom provider] skipped: invalid provider id (use letters/numbers/_/-)`;
      } else if (!/^https?:\/\//.test(baseUrl)) {
        extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
      } else if (api !== "openai-completions" && api !== "openai-responses") {
        extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
      } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        extra += `\n[custom provider] skipped: invalid api key env var name`;
      } else {
        const providerCfg = {
          baseUrl,
          api,
          apiKey: apiKeyEnv ? "${" + apiKeyEnv + "}" : undefined,
          models: modelId ? [{ id: modelId, name: modelId }] : undefined,
        };

        // Ensure we merge in this provider rather than replacing other providers.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]),
        );
        extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
      }
    }

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));

        // Best-effort: enable the telegram plugin explicitly (some builds require this even when configured).
        const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));

        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        extra += `\n[telegram plugin enable] exit=${plug.code} (output ${plug.output.length} chars)\n${plug.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();

    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent".
    const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
    extra += `\n[doctor --fix] exit=${fix.code} (output ${fix.output.length} chars)\n${fix.output || "(no output)"}`;

    // Doctor may require a restart depending on changes.
    await restartGateway();
  }

  return respondJson(ok ? 200 : 500, {
    ok,
    output: `${prefix}${onboard.output}${extra}`,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return respondJson(500, { ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  // Channel config checks (redact secrets before returning to client)
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
  const dc = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  const tgOut = redactSecrets(tg.output || "");
  const dcOut = redactSecrets(dc.output || "");

  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(),
      configPathResolved: configPath(),
      configPathCandidates: typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : null,
      internalGatewayHost: INTERNAL_GATEWAY_HOST,
      internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET,
      gatewayRunning: Boolean(gatewayProc),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      lastGatewayError,
      lastGatewayExit,
      lastDoctorAt,
      lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
      channels: {
        telegram: {
          exit: tg.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(tg.output || "") || /enabled\s*[:=]\s*true/.test(tg.output || ""),
          botTokenPresent: /(\d{5,}:[A-Za-z0-9_-]{10,})/.test(tg.output || ""),
          output: tgOut,
        },
        discord: {
          exit: dc.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(dc.output || "") || /enabled\s*[:=]\s*true/.test(dc.output || ""),
          tokenPresent: /"token"\s*:\s*"?\S+"?/.test(dc.output || "") || /token\s*[:=]\s*\S+/.test(dc.output || ""),
          output: dcOut,
        },
      },
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Very small best-effort redaction. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    // Telegram bot tokens look like: 123456:ABCDEF...
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

function extractDeviceRequestIds(text) {
  const s = String(text || "");
  const out = new Set();

  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);

  return Array.from(out);
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",

  // Device management (for fixing "disconnected (1008): pairing required")
  "openclaw.devices.list",
  "openclaw.devices.approve",

  // Plugin management
  "openclaw.plugins.list",
  "openclaw.plugins.enable",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Device management commands (for fixing "disconnected (1008): pairing required")
    if (cmd === "openclaw.devices.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.approve") {
      const requestId = String(arg || "").trim();
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "Missing device request ID" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        return res.status(400).json({ ok: false, error: "Invalid device request ID" });
      }
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Plugin management commands
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      const name = String(arg || "").trim();
      if (!name) return res.status(400).json({ ok: false, error: "Missing plugin name" });
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", name]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

// Device pairing helper (list + approve) to avoid needing SSH.
app.get("/setup/api/devices/pending", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, requestIds, output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String((req.body && req.body.requestId) || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, error: "Missing device request ID" });
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return res.status(400).json({ ok: false, error: "Invalid device request ID" });
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Reset: stop gateway (frees memory) + delete config file(s) so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    // Stop gateway to avoid running gateway + onboard concurrently on small Railway instances.
    try {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
    } catch {
      // ignore
    }

    const candidates = typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : [configPath()];
    for (const p of candidates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }

    res.type("text/plain").send("OK - stopped gateway and deleted config file(s). You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  try {
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway unavailable\n");
    }
  } catch {
    // ignore
  }
});

// --- Dashboard password protection ---
// Require the same SETUP_PASSWORD for the entire Control UI dashboard,
// not just the /setup routes.  Healthcheck is excluded so Railway probes work.
function requireDashboardAuth(req, res, next) {
  if (req.path === "/healthz" || req.path === "/setup/healthz") return next();
  if (req.path.startsWith("/hooks")) return next(); // allow OpenClaw webhook endpoints to bypass dashboard auth
  if (!SETUP_PASSWORD) return next(); // no password configured → open
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Dashboard"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Dashboard"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

// --- Gateway token injection ---
// The gateway is only reachable from this container. The Control UI in the browser
// cannot set custom Authorization headers for WebSocket connections, so we inject
// the token into proxied requests at the wrapper level.
function attachGatewayAuthHeader(req) {
  if (!req?.headers?.authorization && OPENCLAW_GATEWAY_TOKEN) {
    req.headers.authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
  }
}

proxy.on("proxyReqWs", (_proxyReq, req) => {
  attachGatewayAuthHeader(req);
});

app.use(requireDashboardAuth, async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      const hint = [
        "Gateway not ready.",
        String(err),
        lastGatewayError ? `\n${lastGatewayError}` : "",
        "\nTroubleshooting:",
        "- Visit /setup and check the Debug Console",
        "- Visit /setup/api/debug for config + gateway diagnostics",
      ].join("\n");
      return res.status(503).type("text/plain").send(hint);
    }
  }

  attachGatewayAuthHeader(req);
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

  // Harden state dir for OpenClaw and avoid missing credentials dir on fresh volumes.
  try {
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  } catch {}
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }

  // Optional operator hook to install/persist extra tools under /data.
  // This is intentionally best-effort and should be used to set up persistent
  // prefixes (npm/pnpm/python venv), not to mutate the base image.
  const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
  if (fs.existsSync(bootstrapPath)) {
    console.log(`[wrapper] running bootstrap: ${bootstrapPath}`);
    try {
      await runCmd("bash", [bootstrapPath], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 10 * 60 * 1000,
      });
      console.log("[wrapper] bootstrap complete");
    } catch (err) {
      console.warn(`[wrapper] bootstrap failed (continuing): ${String(err)}`);
    }
  }

  // Sync gateway tokens in config with the current env var on every startup.
  // This prevents "gateway token mismatch" when OPENCLAW_GATEWAY_TOKEN changes
  // (e.g. Railway variable update) but the config file still has the old value.
  if (isConfigured() && OPENCLAW_GATEWAY_TOKEN) {
    console.log("[wrapper] syncing gateway tokens in config...");
    try {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      console.log("[wrapper] gateway tokens synced");
    } catch (err) {
      console.warn(`[wrapper] failed to sync gateway tokens: ${String(err)}`);
    }
  }

  // Auto-start the gateway if already configured so polling channels (Telegram/Discord/etc.)
  // work even if nobody visits the web UI.
  if (isConfigured()) {
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
    } catch (err) {
      console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  // Note: browsers cannot attach arbitrary HTTP headers (including Authorization: Basic)
  // in WebSocket handshakes. Do not enforce dashboard Basic auth at the upgrade layer.
  // The gateway authenticates at the protocol layer and we inject the gateway token below.

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  attachGatewayAuthHeader(req);
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }

  // Stop accepting new connections; allow in-flight requests to complete briefly.
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }

  setTimeout(() => process.exit(0), 5_000).unref?.();
});
