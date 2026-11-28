const OAUTH_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const COPY_V2_URL = "https://api.dropboxapi.com/2/files/copy_v2";
const CACHE_KEY = "__museRelayDropboxTokenCache";

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

function getCache(): TokenCache | null {
  const cached = (globalThis as Record<string, unknown>)[CACHE_KEY];
  if (
    cached &&
    typeof cached === "object" &&
    typeof (cached as TokenCache).token === "string" &&
    typeof (cached as TokenCache).expiresAtMs === "number"
  ) {
    return cached as TokenCache;
  }
  return null;
}

function setCache(cache: TokenCache | null): void {
  (globalThis as Record<string, unknown>)[CACHE_KEY] = cache;
}

/**
 * Obtains a short-lived Dropbox OAuth access token via refresh_token and caches
 * it on globalThis per isolate. Never throws; returns null on failure.
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const cached = getCache();
    if (cached && cached.expiresAtMs > Date.now() + 60_000) {
      return cached.token;
    }

    const appKey = Deno.env.get("DROPBOX_APP_KEY");
    const appSecret = Deno.env.get("DROPBOX_APP_SECRET");
    const refreshToken = Deno.env.get("DROPBOX_REFRESH_TOKEN");
    if (!appKey || !appSecret || !refreshToken) {
      console.error("dropbox: missing DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN");
      return null;
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    });
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`dropbox oauth token failed (${res.status}): ${detail.slice(0, 200)}`);
      return null;
    }

    const json = await res.json().catch(() => null) as
      | { access_token?: unknown; expires_in?: unknown }
      | null;
    if (!json || typeof json.access_token !== "string" || json.access_token.length < 1) {
      console.error("dropbox oauth token response missing access_token");
      return null;
    }

    const expiresInSec = typeof json.expires_in === "number" && json.expires_in > 180
      ? json.expires_in
      : 14_400;
    setCache({
      token: json.access_token,
      expiresAtMs: Date.now() + (expiresInSec - 120) * 1000,
    });
    return json.access_token;
  } catch (err) {
    console.error("dropbox getAccessToken error:", err);
    return null;
  }
}

function conflictRetryPath(toPath: string): string {
  const lastSlash = toPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? toPath.slice(0, lastSlash + 1) : "/";
  const file = lastSlash >= 0 ? toPath.slice(lastSlash + 1) : toPath;
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  return `${dir}${base}.${Date.now()}${ext}`;
}

async function attemptCopy(
  token: string,
  fromPath: string,
  toPath: string,
): Promise<{ ok: true } | { ok: false; conflict: boolean; status: number; detail: string }> {
  const res = await fetch(COPY_V2_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from_path: fromPath,
      to_path: toPath,
      autorename: false,
    }),
  });
  if (res.ok) return { ok: true };

  const detail = await res.text().catch(() => "");
  let summary = "";
  let toTag = "";
  try {
    const parsed = JSON.parse(detail) as {
      error_summary?: unknown;
      error?: { to?: { ".tag"?: unknown } };
    };
    if (typeof parsed.error_summary === "string") summary = parsed.error_summary;
    if (typeof parsed.error?.to?.[".tag"] === "string") toTag = parsed.error.to[".tag"];
  } catch {
    // Non-JSON error body; keep raw detail for logging.
  }

  const conflict = res.status === 409 &&
    (summary.includes("to/conflict") || toTag === "conflict");
  return { ok: false, conflict, status: res.status, detail: detail.slice(0, 300) };
}

/**
 * Copies a file internally within Dropbox via /2/files/copy_v2.
 * Retries once with a millisecond suffix on `to/conflict`.
 * Best-effort: logs and returns null on any error, never throws.
 */
export async function copyV2(fromPath: string, toPath: string): Promise<string | null> {
  try {
    const token = await getAccessToken();
    if (!token) return null;

    const first = await attemptCopy(token, fromPath, toPath);
    if (first.ok) return toPath;

    if (first.status === 401) {
      setCache(null);
    }

    if (first.conflict) {
      const retryPath = conflictRetryPath(toPath);
      if (retryPath.length > 512) {
        console.error("dropbox copy_v2 conflict retry path exceeds 512 chars");
        return null;
      }
      const second = await attemptCopy(token, fromPath, retryPath);
      if (second.ok) return retryPath;
      console.error(`dropbox copy_v2 retry failed (${second.status}): ${second.detail}`);
      return null;
    }

    console.error(`dropbox copy_v2 failed (${first.status}): ${first.detail}`);
    return null;
  } catch (err) {
    console.error("dropbox copyV2 error:", err);
    return null;
  }
}
