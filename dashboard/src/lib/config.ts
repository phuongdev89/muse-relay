export interface RuntimeConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  ownerDisplayName: string;
  dropboxConfigured: boolean;
}

let runtimeConfig: RuntimeConfig | null = null;

/**
 * Fetches runtime configuration from `/api/config` (`no-store`) and validates
 * required Supabase connection fields before booting the client.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const res = await fetch("/api/config", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error("Invalid JSON from /api/config");
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid payload from /api/config");
  }

  const data = raw as Record<string, unknown>;
  const supabaseUrl =
    typeof data.supabaseUrl === "string" ? data.supabaseUrl.trim() : "";
  const supabasePublishableKey =
    typeof data.supabasePublishableKey === "string"
      ? data.supabasePublishableKey.trim()
      : "";

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("Missing supabaseUrl or supabasePublishableKey in /api/config");
  }

  const ownerDisplayName =
    typeof data.ownerDisplayName === "string" && data.ownerDisplayName.trim()
      ? data.ownerDisplayName.trim()
      : "Owner";

  runtimeConfig = {
    supabaseUrl,
    supabasePublishableKey,
    ownerDisplayName,
    dropboxConfigured: Boolean(data.dropboxConfigured),
  };

  return runtimeConfig;
}

/** Returns loaded runtime configuration; throws if called before `loadRuntimeConfig()`. */
export function getConfig(): RuntimeConfig {
  if (!runtimeConfig) {
    throw new Error("Runtime config has not been loaded. Call loadRuntimeConfig() first.");
  }
  return runtimeConfig;
}
