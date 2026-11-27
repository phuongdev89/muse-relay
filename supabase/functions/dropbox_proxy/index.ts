import {
  adminClient,
  allowedOwnerId,
  corsHeaders,
  jsonResponse,
  userClient,
} from "../_shared/relay.ts";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB per file via Edge Function

let cachedToken: { value: string; expiresAtMs: number } | null = null;

async function getDropboxToken(): Promise<{ token: string | null; error?: string }> {
  const refreshToken = Deno.env.get("DROPBOX_REFRESH_TOKEN")?.trim();
  const appKey = Deno.env.get("DROPBOX_APP_KEY")?.trim();
  const appSecret = Deno.env.get("DROPBOX_APP_SECRET")?.trim();

  if (refreshToken && appKey && appSecret) {
    if (cachedToken && Date.now() < cachedToken.expiresAtMs - 60_000) {
      return { token: cachedToken.value };
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await res.json().catch(() => null) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    } | null;
    if (!res.ok || !data?.access_token) {
      return {
        token: null,
        error: data?.error_description || data?.error || `dropbox_oauth_${res.status}`,
      };
    }
    const ttlMs = (typeof data.expires_in === "number" ? data.expires_in : 14400) * 1000;
    cachedToken = { value: data.access_token, expiresAtMs: Date.now() + ttlMs };
    return { token: data.access_token };
  }

  const staticToken = Deno.env.get("DROPBOX_ACCESS_TOKEN")?.trim();
  if (staticToken) {
    return { token: staticToken };
  }

  return { token: null, error: "dropbox_not_configured" };
}

function bangkokStamp(): string {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
}

function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop()?.trim() || "file";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : "";
  const safeStem = stem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "file";
  return `${safeStem}${ext.slice(0, 16)}`;
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "inputs";
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "unauthorized" }, 401);

  try {
    const supabase = userClient(authHeader);
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(jwt);
    if (userError || !user) return jsonResponse({ error: "unauthorized" }, 401);

    const ownerAllowlist = allowedOwnerId();
    if (ownerAllowlist && user.id !== ownerAllowlist) {
      return jsonResponse({ error: "forbidden" }, 403);
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return jsonResponse({ error: "invalid_json" }, 400);

    const tokenRes = await getDropboxToken();
    if (!tokenRes.token) {
      return jsonResponse({ error: tokenRes.error ?? "dropbox_not_configured" }, 503);
    }
    const dbxToken = tokenRes.token;

    if (body.action === "temp_link") {
      const path = typeof body.path === "string" ? body.path.trim() : "";
      if (!path.startsWith("/") || path.includes("..") || path.length > 512) {
        return jsonResponse({ error: "invalid_dropbox_path" }, 400);
      }

      const dbxRes = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${dbxToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path }),
      });
      const dbxData = await dbxRes.json().catch(() => null) as {
        link?: string;
        metadata?: { name?: string; size?: number; path_display?: string };
        error_summary?: string;
      } | null;
      if (!dbxRes.ok || !dbxData?.link) {
        return jsonResponse(
          { error: dbxData?.error_summary ?? `dropbox_temp_link_${dbxRes.status}` },
          dbxRes.status >= 400 && dbxRes.status < 500 ? 400 : 502,
        );
      }
      return jsonResponse({
        link: dbxData.link,
        name: dbxData.metadata?.name ?? path.split("/").pop() ?? "file",
        size: dbxData.metadata?.size ?? null,
        path: dbxData.metadata?.path_display ?? path,
      });
    }

    if (body.action === "upload") {
      const recipient = typeof body.recipient === "string" ? body.recipient.trim().toLowerCase() : "";
      const fileName = typeof body.file_name === "string" ? body.file_name : "file";
      const contentB64 = typeof body.content_base64 === "string" ? body.content_base64 : "";
      const rawThread = typeof body.thread_id === "string" ? body.thread_id.trim() : "";

      if (!recipient) return jsonResponse({ error: "recipient is required" }, 400);
      if (!contentB64) return jsonResponse({ error: "content_base64 is required" }, 400);

      const bytes = decodeBase64(contentB64);
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOAD_BYTES) {
        return jsonResponse({ error: "file_size_out_of_range" }, 400);
      }

      const { data: muse, error: museErr } = await adminClient()
        .from("relay_muses")
        .select("dropbox_root")
        .eq("recipient", recipient)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (museErr) throw museErr;
      if (!muse?.dropbox_root) return jsonResponse({ error: "muse_not_found" }, 404);

      const folder = rawThread ? sanitizeSegment(rawThread) : "inputs";
      const safeName = `${bangkokStamp()}_${sanitizeFileName(fileName)}`;
      const root = String(muse.dropbox_root).replace(/\/+$/, "");
      const destPath = `${root}/${folder}/${safeName}`;

      const dbxRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${dbxToken}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: destPath,
            mode: "add",
            autorename: true,
            mute: true,
          }),
        },
        body: bytes,
      });

      const dbxData = await dbxRes.json().catch(() => null) as {
        path_display?: string;
        name?: string;
        size?: number;
        error_summary?: string;
      } | null;

      if (!dbxRes.ok || !dbxData?.path_display) {
        return jsonResponse(
          { error: dbxData?.error_summary ?? `dropbox_upload_${dbxRes.status}` },
          dbxRes.status >= 400 && dbxRes.status < 500 ? 400 : 502,
        );
      }

      return jsonResponse({
        dropbox_path: dbxData.path_display,
        name: dbxData.name ?? safeName,
        size: dbxData.size ?? bytes.byteLength,
      });
    }

    return jsonResponse({ error: "unsupported_action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, 500);
  }
});
