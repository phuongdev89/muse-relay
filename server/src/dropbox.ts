import type { Request, Response } from "express";
import { getOwnerAuth } from "./auth.js";
import { env } from "./env.js";
import { supabaseRestSelectSingle } from "./supabase.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const BANGKOK_PARTS_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface CachedDropboxToken {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: CachedDropboxToken | null = null;
let inflightRefresh: Promise<string> | null = null;

function hasRefreshConfig(): boolean {
  return Boolean(
    env.dropboxRefreshToken && env.dropboxAppKey && env.dropboxAppSecret,
  );
}

/** Returns true when either OAuth refresh credentials or a static token exist. */
export function isDropboxConfigured(): boolean {
  return hasRefreshConfig() || Boolean(env.dropboxAccessToken);
}

async function refreshDropboxAccessToken(): Promise<string> {
  if (
    !env.dropboxRefreshToken ||
    !env.dropboxAppKey ||
    !env.dropboxAppSecret
  ) {
    throw new Error("dropbox_not_configured");
  }

  const basic = Buffer.from(
    `${env.dropboxAppKey}:${env.dropboxAppSecret}`,
    "utf8",
  ).toString("base64");

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.dropboxRefreshToken,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`dropbox_token_refresh_failed_${res.status}`);
  }

  const payload = (await res.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("dropbox_token_refresh_invalid_response");
  }

  const expiresInSec =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 14_400;
  // Refresh 2 minutes early to avoid racing expiry mid-request.
  const ttlMs = Math.max(60_000, (expiresInSec - 120) * 1000);
  cachedToken = {
    accessToken: payload.access_token,
    expiresAtMs: Date.now() + ttlMs,
  };
  return cachedToken.accessToken;
}

async function getDropboxAccessToken(forceRefresh = false): Promise<string> {
  if (hasRefreshConfig()) {
    if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAtMs) {
      return cachedToken.accessToken;
    }
    if (forceRefresh) {
      cachedToken = null;
    }
    if (!inflightRefresh) {
      inflightRefresh = refreshDropboxAccessToken().finally(() => {
        inflightRefresh = null;
      });
    }
    return inflightRefresh;
  }

  if (env.dropboxAccessToken) {
    return env.dropboxAccessToken;
  }

  throw new Error("dropbox_not_configured");
}

async function callDropboxWithRetry(
  requestFn: (bearerToken: string) => Promise<globalThis.Response>,
): Promise<globalThis.Response> {
  const token = await getDropboxAccessToken(false);
  const firstRes = await requestFn(token);
  if (firstRes.status === 401 && hasRefreshConfig()) {
    const freshToken = await getDropboxAccessToken(true);
    return requestFn(freshToken);
  }
  return firstRes;
}

function validateDropboxPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length < 2 || raw.length > 512) return null;
  if (!raw.startsWith("/")) return null;
  if (
    raw.includes("..") ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    raw.includes("\r") ||
    raw.includes("\n")
  ) {
    return null;
  }
  return raw;
}

function formatBangkokTimestamp(now = new Date()): string {
  const parts = BANGKOK_PARTS_FORMATTER.formatToParts(now);
  const byType = new Map<string, string>();
  for (const part of parts) {
    byType.set(part.type, part.value);
  }
  const y = byType.get("year") ?? "1970";
  const m = byType.get("month") ?? "01";
  const d = byType.get("day") ?? "01";
  const hh = byType.get("hour") ?? "00";
  const mm = byType.get("minute") ?? "00";
  const ss = byType.get("second") ?? "00";
  return `${y}-${m}-${d}_${hh}-${mm}-${ss}`;
}

function sanitizeFileName(rawName: string): string {
  const baseName = rawName.split(/[/\\]/).pop() ?? "";
  const cleaned = baseName
    .replace(/\.{2,}/g, ".")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");

  if (!cleaned) return "file";
  if (cleaned.length <= 120) return cleaned;

  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && cleaned.length - dot <= 16) {
    const ext = cleaned.slice(dot);
    const stem = cleaned.slice(0, 120 - ext.length).replace(/[._]+$/g, "");
    return `${stem || "file"}${ext}`;
  }
  return cleaned.slice(0, 120);
}

function dropboxApiArgHeader(arg: Record<string, unknown>): string {
  return JSON.stringify(arg).replace(/[\u007f-\uffff]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function readSingleHeader(req: Request, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val[0];
  return undefined;
}

function parseDropboxErrorSummary(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as { error_summary?: unknown };
    if (typeof parsed.error_summary === "string" && parsed.error_summary) {
      return parsed.error_summary;
    }
  } catch {
    // ignore non-JSON body
  }
  return "dropbox_request_failed";
}

/**
 * `POST /api/dropbox/temp-link`
 * Exchanges a validated Dropbox path for a short-lived temporary download link.
 */
export async function handleDropboxTempLink(
  req: Request,
  res: Response,
): Promise<void> {
  const pathValue = validateDropboxPath(
    (req.body as { path?: unknown } | undefined)?.path,
  );
  if (!pathValue) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  if (!isDropboxConfigured()) {
    res.status(503).json({ error: "dropbox_not_configured" });
    return;
  }

  try {
    const dbxRes = await callDropboxWithRetry((token) =>
      fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: pathValue }),
        signal: AbortSignal.timeout(20_000),
      }),
    );

    const rawText = await dbxRes.text();
    if (!dbxRes.ok) {
      const summary = parseDropboxErrorSummary(rawText);
      const status = summary.includes("not_found") ? 404 : 502;
      res.status(status).json({ error: summary });
      return;
    }

    const data = JSON.parse(rawText) as {
      link?: unknown;
      metadata?: {
        name?: unknown;
        size?: unknown;
        path_display?: unknown;
        path_lower?: unknown;
      };
    };

    if (typeof data.link !== "string" || !data.link) {
      res.status(502).json({ error: "dropbox_invalid_response" });
      return;
    }

    res.json({
      link: data.link,
      name:
        typeof data.metadata?.name === "string"
          ? data.metadata.name
          : pathValue.split("/").pop() ?? "file",
      size: typeof data.metadata?.size === "number" ? data.metadata.size : null,
      path:
        typeof data.metadata?.path_display === "string"
          ? data.metadata.path_display
          : typeof data.metadata?.path_lower === "string"
            ? data.metadata.path_lower
            : pathValue,
    });
  } catch (err) {
    const code =
      err instanceof Error && err.message === "dropbox_not_configured"
        ? "dropbox_not_configured"
        : "dropbox_temp_link_failed";
    res.status(code === "dropbox_not_configured" ? 503 : 502).json({ error: code });
  }
}

/**
 * `POST /api/dropbox/upload`
 * Streams a raw `application/octet-stream` body into the Muse's Dropbox root.
 */
export async function handleDropboxUpload(
  req: Request,
  res: Response,
): Promise<void> {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "empty_or_invalid_body" });
    return;
  }

  if (!isDropboxConfigured()) {
    res.status(503).json({ error: "dropbox_not_configured" });
    return;
  }

  const recipient = readSingleHeader(req, "x-recipient")?.trim() ?? "";
  if (!UUID_RE.test(recipient)) {
    res.status(400).json({ error: "invalid_recipient" });
    return;
  }

  const rawEncodedFileName = readSingleHeader(req, "x-file-name");
  if (!rawEncodedFileName) {
    res.status(400).json({ error: "missing_file_name" });
    return;
  }

  let decodedFileName: string;
  try {
    decodedFileName = decodeURIComponent(rawEncodedFileName).trim();
  } catch {
    res.status(400).json({ error: "invalid_file_name" });
    return;
  }
  if (!decodedFileName) {
    res.status(400).json({ error: "invalid_file_name" });
    return;
  }

  const rawThreadId = readSingleHeader(req, "x-thread-id")?.trim();
  if (rawThreadId && !THREAD_ID_RE.test(rawThreadId)) {
    res.status(400).json({ error: "invalid_thread_id" });
    return;
  }
  const folder = rawThreadId || "uploads";

  const auth = getOwnerAuth(req);
  const museQuery = `relay_muses?select=dropbox_root&recipient=eq.${encodeURIComponent(recipient)}`;
  const museRes = await supabaseRestSelectSingle<{ dropbox_root?: unknown }>(
    museQuery,
    auth.jwt,
  );

  if (museRes.error) {
    res.status(502).json({ error: "supabase_lookup_failed" });
    return;
  }
  if (!museRes.data || typeof museRes.data.dropbox_root !== "string") {
    res.status(404).json({ error: "muse_not_found" });
    return;
  }

  const rawRoot = museRes.data.dropbox_root.trim();
  if (!rawRoot.startsWith("/") || rawRoot.includes("..")) {
    res.status(400).json({ error: "invalid_muse_dropbox_root" });
    return;
  }
  const normalizedRoot = rawRoot.replace(/\/+$/, "");
  const safeFileName = sanitizeFileName(decodedFileName);
  const bangkokStamp = formatBangkokTimestamp();
  const destinationPath = `${normalizedRoot}/${folder}/${bangkokStamp}_${safeFileName}`;

  const rawBuffer = req.body;
  try {
    const dbxRes = await callDropboxWithRetry((token) =>
      fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": dropboxApiArgHeader({
            path: destinationPath,
            mode: "add",
            autorename: true,
            mute: false,
          }),
        },
        body: new Uint8Array(rawBuffer),
        signal: AbortSignal.timeout(60_000),
      }),
    );

    const rawText = await dbxRes.text();
    if (!dbxRes.ok) {
      res.status(502).json({ error: parseDropboxErrorSummary(rawText) });
      return;
    }

    const uploaded = JSON.parse(rawText) as {
      path_display?: unknown;
      path_lower?: unknown;
      name?: unknown;
      size?: unknown;
    };

    res.json({
      dropbox_path:
        typeof uploaded.path_display === "string"
          ? uploaded.path_display
          : typeof uploaded.path_lower === "string"
            ? uploaded.path_lower
            : destinationPath,
      name: typeof uploaded.name === "string" ? uploaded.name : safeFileName,
      size:
        typeof uploaded.size === "number" ? uploaded.size : rawBuffer.length,
    });
  } catch (err) {
    const code =
      err instanceof Error && err.message === "dropbox_not_configured"
        ? "dropbox_not_configured"
        : "dropbox_upload_failed";
    res.status(code === "dropbox_not_configured" ? 503 : 502).json({ error: code });
  }
}
