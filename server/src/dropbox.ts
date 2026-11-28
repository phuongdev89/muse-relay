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

export function validateDropboxPath(raw: unknown): string | null {
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

export interface DropboxTempLinkResult {
  link: string;
  name: string;
  size: number | null;
  path: string;
}

export class DropboxApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Exchanges a validated Dropbox path for a short-lived temporary download link.
 */
export async function fetchDropboxTempLink(
  rawPath: string,
): Promise<DropboxTempLinkResult> {
  const pathValue = validateDropboxPath(rawPath);
  if (!pathValue) {
    throw new DropboxApiError(400, "invalid_path");
  }
  if (!isDropboxConfigured()) {
    throw new DropboxApiError(503, "dropbox_not_configured");
  }

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
    throw new DropboxApiError(status, summary);
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
    throw new DropboxApiError(502, "dropbox_invalid_response");
  }

  return {
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
  };
}

/**
 * Downloads a Dropbox file into memory up to `maxBytes`. Throws `DropboxApiError`
 * if the file exceeds `maxBytes`, cannot be found, or Dropbox fails.
 */
export async function downloadDropboxBuffer(
  rawPath: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; name: string; size: number }> {
  const pathValue = validateDropboxPath(rawPath);
  if (!pathValue) {
    throw new DropboxApiError(400, "invalid_path");
  }
  if (!isDropboxConfigured()) {
    throw new DropboxApiError(503, "dropbox_not_configured");
  }

  const dbxRes = await callDropboxWithRetry((token) =>
    fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": dropboxApiArgHeader({ path: pathValue }),
      },
      signal: AbortSignal.timeout(30_000),
    }),
  );

  if (!dbxRes.ok) {
    const summary = parseDropboxErrorSummary(await dbxRes.text());
    const status = summary.includes("not_found") ? 404 : 502;
    throw new DropboxApiError(status, summary);
  }

  const declaredLength = Number(dbxRes.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await dbxRes.body?.cancel();
    throw new DropboxApiError(413, "file_too_large");
  }

  let fileName = pathValue.split("/").pop() ?? "file";
  const apiResultHeader = dbxRes.headers.get("dropbox-api-result");
  if (apiResultHeader) {
    try {
      const meta = JSON.parse(apiResultHeader) as { name?: unknown; size?: unknown };
      if (typeof meta.name === "string" && meta.name) {
        fileName = meta.name;
      }
      if (typeof meta.size === "number" && meta.size > maxBytes) {
        await dbxRes.body?.cancel();
        throw new DropboxApiError(413, "file_too_large");
      }
    } catch (err) {
      if (err instanceof DropboxApiError) throw err;
    }
  }

  const buffer = Buffer.from(await dbxRes.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new DropboxApiError(413, "file_too_large");
  }

  return { buffer, name: fileName, size: buffer.length };
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
    const result = await fetchDropboxTempLink(pathValue);
    res.json(result);
  } catch (err) {
    if (err instanceof DropboxApiError) {
      res.status(err.statusCode).json({ error: err.code });
      return;
    }
    const code =
      err instanceof Error && err.message === "dropbox_not_configured"
        ? "dropbox_not_configured"
        : "dropbox_temp_link_failed";
    res.status(code === "dropbox_not_configured" ? 503 : 502).json({ error: code });
  }
}

/**
 * `POST /api/dropbox/thumb`
 * Returns a small Dropbox-generated JPEG preview for blur-up placeholders.
 * Relay paths are unique (timestamped names), so thumbnails are cached
 * in-memory and marked immutable for the browser.
 */
const THUMB_CACHE_MAX = 500;
const thumbCache = new Map<string, Buffer>();

export async function handleDropboxThumb(
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

  const cached = thumbCache.get(pathValue);
  if (cached) {
    // Refresh LRU position.
    thumbCache.delete(pathValue);
    thumbCache.set(pathValue, cached);
    res
      .type("image/jpeg")
      .set("Cache-Control", "private, max-age=604800, immutable")
      .send(cached);
    return;
  }

  try {
    const dbxRes = await callDropboxWithRetry((token) =>
      fetch("https://content.dropboxapi.com/2/files/get_thumbnail_v2", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": dropboxApiArgHeader({
            resource: { ".tag": "path", path: pathValue },
            format: "jpeg",
            size: "w128h128",
            mode: "strict",
          }),
        },
        signal: AbortSignal.timeout(20_000),
      }),
    );

    if (!dbxRes.ok) {
      const summary = parseDropboxErrorSummary(await dbxRes.text());
      // Unsupported types (docs, audio...) legitimately have no thumbnail.
      const status = summary.includes("not_found") || summary.includes("unsupported")
        ? 404
        : 502;
      res.status(status).json({ error: summary || "dropbox_thumb_failed" });
      return;
    }

    const buf = Buffer.from(await dbxRes.arrayBuffer());
    if (buf.length === 0) {
      res.status(502).json({ error: "dropbox_invalid_response" });
      return;
    }
    if (thumbCache.size >= THUMB_CACHE_MAX) {
      const oldest = thumbCache.keys().next().value;
      if (oldest !== undefined) thumbCache.delete(oldest);
    }
    thumbCache.set(pathValue, buf);

    res
      .type("image/jpeg")
      .set("Cache-Control", "private, max-age=604800, immutable")
      .send(buf);
  } catch (err) {
    const code =
      err instanceof Error && err.message === "dropbox_not_configured"
        ? "dropbox_not_configured"
        : "dropbox_thumb_failed";
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
  const isOwnerRecipient = recipient.toLowerCase() === "owner";
  if (!isOwnerRecipient && !UUID_RE.test(recipient)) {
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

  let rawRoot: string;
  if (isOwnerRecipient) {
    rawRoot = env.ownerDropboxRoot;
  } else {
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
    rawRoot = museRes.data.dropbox_root.trim();
  }
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

/**
 * `POST /api/dropbox/distribute`
 * Copies 1-4 owner-uploaded Dropbox files into each target Muse's Dropbox root
 * under `<targetRoot>/<folder>/<basename>` and returns `paths_by_recipient`.
 */
export async function handleDropboxDistribute(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isDropboxConfigured()) {
    res.status(503).json({ error: "dropbox_not_configured" });
    return;
  }

  const body = req.body as {
    thread_id?: unknown;
    source_paths?: unknown;
    target_recipients?: unknown;
  } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  let folder = "uploads";
  if (body.thread_id !== undefined && body.thread_id !== null) {
    if (typeof body.thread_id !== "string" || !THREAD_ID_RE.test(body.thread_id)) {
      res.status(400).json({ error: "invalid_thread_id" });
      return;
    }
    folder = body.thread_id;
  }

  if (
    !Array.isArray(body.source_paths) ||
    body.source_paths.length < 1 ||
    body.source_paths.length > 4
  ) {
    res.status(400).json({ error: "invalid_source_paths" });
    return;
  }
  const sourcePaths: string[] = [];
  for (const rawPath of body.source_paths) {
    const valid = validateDropboxPath(rawPath);
    if (!valid) {
      res.status(400).json({ error: "invalid_source_paths" });
      return;
    }
    const base = valid.slice(valid.lastIndexOf("/") + 1);
    if (!base || base === "." || base === "..") {
      res.status(400).json({ error: "invalid_source_paths" });
      return;
    }
    sourcePaths.push(valid);
  }

  if (
    !Array.isArray(body.target_recipients) ||
    body.target_recipients.length < 1 ||
    body.target_recipients.length > 16
  ) {
    res.status(400).json({ error: "invalid_target_recipients" });
    return;
  }
  const targetRecipients: string[] = [];
  const seenRecipients = new Set<string>();
  for (const rawRec of body.target_recipients) {
    if (typeof rawRec !== "string" || !UUID_RE.test(rawRec.trim())) {
      res.status(400).json({ error: "invalid_target_recipients" });
      return;
    }
    const normalized = rawRec.trim().toLowerCase();
    if (!seenRecipients.has(normalized)) {
      seenRecipients.add(normalized);
      targetRecipients.push(normalized);
    }
  }

  const auth = getOwnerAuth(req);
  const rootByRecipient = new Map<string, string>();
  for (const recipient of targetRecipients) {
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
      res.status(404).json({ error: "muse_not_found", recipient });
      return;
    }
    const rawRoot = museRes.data.dropbox_root.trim();
    if (!rawRoot.startsWith("/") || rawRoot.includes("..")) {
      res.status(400).json({ error: "invalid_muse_dropbox_root", recipient });
      return;
    }
    rootByRecipient.set(recipient, rawRoot.replace(/\/+$/, ""));
  }

  const pathsByRecipient: Record<string, string[]> = {};
  try {
    for (const recipient of targetRecipients) {
      const normalizedRoot = rootByRecipient.get(recipient) ?? "";
      const copiedList: string[] = [];
      for (const sourcePath of sourcePaths) {
        const base = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
        const toPath = `${normalizedRoot}/${folder}/${base}`;
        if (toPath.length > 512 || toPath.includes("..")) {
          res.status(400).json({ error: "destination_path_too_long" });
          return;
        }
        const dbxRes = await callDropboxWithRetry((token) =>
          fetch("https://api.dropboxapi.com/2/files/copy_v2", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from_path: sourcePath,
              to_path: toPath,
              autorename: true,
            }),
            signal: AbortSignal.timeout(30_000),
          }),
        );
        const rawText = await dbxRes.text();
        if (!dbxRes.ok) {
          const summary = parseDropboxErrorSummary(rawText);
          const status = summary.includes("not_found") ? 404 : 502;
          res.status(status).json({ error: summary });
          return;
        }
        const parsed = JSON.parse(rawText) as {
          metadata?: { path_display?: unknown; path_lower?: unknown };
        };
        const copiedPath =
          typeof parsed.metadata?.path_display === "string"
            ? parsed.metadata.path_display
            : typeof parsed.metadata?.path_lower === "string"
              ? parsed.metadata.path_lower
              : toPath;
        copiedList.push(copiedPath);
      }
      pathsByRecipient[recipient] = copiedList;
    }
    res.json({ paths_by_recipient: pathsByRecipient });
  } catch (err) {
    const code =
      err instanceof Error && err.message === "dropbox_not_configured"
        ? "dropbox_not_configured"
        : "dropbox_distribute_failed";
    res.status(code === "dropbox_not_configured" ? 503 : 502).json({ error: code });
  }
}
