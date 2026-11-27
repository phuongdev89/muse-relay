import { createClient } from "npm:@supabase/supabase-js@2";

export function recipientId(): string {
  const value = Deno.env.get("RELAY_RECIPIENT_ID")?.trim().toLowerCase();
  if (!value) return "nyx";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(value)
  ) {
    throw new Error("RELAY_RECIPIENT_ID must be a UUID");
  }
  return value;
}

export const INPUT_BUCKET = "relay-inputs";
export const DROPBOX_OUTPUT_PREFIX = "/nolanthomas825cxoz@lappies.net/";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function keyFromJsonEnv(name: string): string | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed["default"] ?? null;
  } catch {
    return null;
  }
}

function publishableKey(): string {
  const key = keyFromJsonEnv("SUPABASE_PUBLISHABLE_KEYS") ??
    Deno.env.get("SUPABASE_ANON_KEY");
  if (!key) throw new Error("Missing publishable key environment variable");
  return key;
}

function secretKey(): string {
  const key = keyFromJsonEnv("SUPABASE_SECRET_KEYS") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Missing secret key environment variable");
  return key;
}

export function adminClient() {
  return createClient(requiredEnv("SUPABASE_URL"), secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function userClient(authHeader: string) {
  return createClient(requiredEnv("SUPABASE_URL"), publishableKey(), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function allowedOwnerId(): string | null {
  return Deno.env.get("RELAY_OWNER_ID") ?? null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export interface SignedMessageFields {
  id: string;
  owner_id: string;
  recipient: string;
  action: string;
  params: Record<string, unknown>;
  nonce: string;
  expires_at_unix: number;
}

function signedPayload(fields: SignedMessageFields): string {
  return stableStringify({
    action: fields.action,
    expires_at_unix: fields.expires_at_unix,
    id: fields.id,
    nonce: fields.nonce,
    owner_id: fields.owner_id,
    params: fields.params,
    recipient: fields.recipient,
  });
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [aHash, bHash] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < aHash.length; i++) diff |= aHash[i] ^ bHash[i];
  return diff === 0;
}

export async function signMessage(fields: SignedMessageFields): Promise<string> {
  return hmacHex(requiredEnv("RELAY_SIGNING_SECRET"), signedPayload(fields));
}

export async function verifyMessageSignature(
  fields: SignedMessageFields,
  signature: string,
): Promise<boolean> {
  const expected = await signMessage(fields);
  return timingSafeEqual(expected, signature);
}

export async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await sha256Bytes(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface ResolvedMuse {
  recipient: string;
  name: string;
  dropboxRoot: string;
  legacy: boolean;
}

// Resolve the presented x-relay-token to exactly one muse. Muses created
// through the dashboard wizard are looked up in the relay_muses registry by
// token hash (service role bypasses RLS); the legacy env pair keeps Nyx's
// existing daemon working without touching its vault. A registry lookup
// failure must NEVER take the legacy path down with it — Nyx's live daemon
// depends on that path, so lookup errors fall through to the env pair.
export async function resolveMuse(req: Request): Promise<ResolvedMuse | null> {
  const presented = req.headers.get("x-relay-token");
  if (!presented) return null;

  const tokenHash = await sha256Hex(presented);
  const { data: row, error: lookupError } = await adminClient()
    .from("relay_muses")
    .select("recipient, name, dropbox_root")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!lookupError && row) {
    return {
      recipient: String(row.recipient).toLowerCase(),
      name: String(row.name),
      dropboxRoot: String(row.dropbox_root),
      legacy: false,
    };
  }

  const legacyToken = Deno.env.get("RELAY_TOKEN");
  if (legacyToken && (await timingSafeEqual(presented, legacyToken))) {
    return {
      recipient: recipientId(),
      name: "Nyx",
      dropboxRoot: DROPBOX_OUTPUT_PREFIX,
      legacy: true,
    };
  }
  return null;
}

// True when submit_message may address this recipient: the legacy env recipient
// (checked first, no registry dependency) or a registered muse row. Registry
// lookup failures reject only the NEW recipient — they must never break
// submissions addressed to the legacy recipient.
export async function recipientIsKnown(
  supabase: ReturnType<typeof adminClient>,
  recipient: string,
): Promise<boolean> {
  if (recipient === recipientId()) return true;
  const { data, error } = await supabase
    .from("relay_muses")
    .select("recipient")
    .eq("recipient", recipient)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  params: Record<string, unknown>,
  allowed: string[],
): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new Error(`Unknown param: ${key}`);
  }
}

function readPrompt(params: Record<string, unknown>): string {
  const prompt = params["prompt"];
  if (typeof prompt !== "string") throw new Error("prompt must be a string");
  const trimmed = prompt.trim();
  if (trimmed.length < 1 || trimmed.length > 4000) {
    throw new Error("prompt must be 1-4000 characters");
  }
  return trimmed;
}

function readAspectRatio(
  params: Record<string, unknown>,
  allowed: string[],
  fallback: string,
): string {
  const value = params["aspect_ratio"] ?? fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`aspect_ratio must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function readIntInRange(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = params[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer ${min}-${max}`);
  }
  return value;
}

function readMediaType(params: Record<string, unknown>): string {
  const value = params["media_type"] ?? "auto";
  if (
    typeof value !== "string" ||
    !["auto", "none", "image", "video"].includes(value)
  ) {
    throw new Error("media_type must be one of: auto, none, image, video");
  }
  return value;
}

function readResourceType(params: Record<string, unknown>): string {
  const value = params["resource_type"] ?? readMediaType(params);
  if (
    typeof value !== "string" ||
    !["auto", "none", "image", "video", "document", "archive"].includes(value)
  ) {
    throw new Error(
      "resource_type must be one of: auto, none, image, video, document, archive",
    );
  }
  return value;
}

function readOutputFormat(params: Record<string, unknown>): string {
  const value = params["output_format"] ?? "auto";
  if (
    typeof value !== "string" ||
    !["auto", "md", "txt", "csv", "docx", "xlsx", "zip"].includes(value)
  ) {
    throw new Error(
      "output_format must be one of: auto, md, txt, csv, docx, xlsx, zip",
    );
  }
  return value;
}

function readThreadId(params: Record<string, unknown>): string | null {
  const value = params["thread_id"] ?? null;
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error("thread_id must be 1-64 letters, digits, hyphens or underscores");
  }
  return value;
}

function readReferencePaths(
  params: Record<string, unknown>,
  ownerId: string,
  maxItems: number,
): string[] {
  const value = params["reference_storage_paths"] ?? [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`reference_storage_paths must be an array of at most ${maxItems} paths`);
  }
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("reference_storage_paths items must be strings");
    }
    if (!item.startsWith(`${ownerId}/`) || item.includes("..") || item.length > 512) {
      throw new Error("reference_storage_paths must stay inside the owner's folder");
    }
    paths.push(item);
  }
  return paths;
}

export function validateParams(
  action: unknown,
  params: unknown,
  ownerId: string,
): { action: "chat" | "image" | "video"; params: Record<string, unknown> } {
  if (!isRecord(params)) throw new Error("params must be an object");

  if (action === "chat") {
    rejectUnknownKeys(params, [
      "prompt",
      "thread_id",
      "media_type",
      "resource_type",
      "output_format",
      "aspect_ratio",
      "count",
      "duration_seconds",
      "reference_storage_paths",
    ]);
    const resourceType = readResourceType(params);
    return {
      action,
      params: {
        prompt: readPrompt(params),
        thread_id: readThreadId(params),
        media_type: ["auto", "none", "image", "video"].includes(resourceType)
          ? resourceType
          : "auto",
        resource_type: resourceType,
        output_format: readOutputFormat(params),
        aspect_ratio: readAspectRatio(
          params,
          ["9:16", "16:9", "1:1", "4:5", "3:4"],
          "9:16",
        ),
        count: readIntInRange(params, "count", 1, 1, 4),
        duration_seconds: readIntInRange(params, "duration_seconds", 8, 5, 10),
        reference_storage_paths: readReferencePaths(params, ownerId, 4),
      },
    };
  }

  if (action === "image") {
    rejectUnknownKeys(params, [
      "prompt",
      "aspect_ratio",
      "count",
      "reference_storage_paths",
      "thread_id",
    ]);
    return {
      action,
      params: {
        prompt: readPrompt(params),
        thread_id: readThreadId(params),
        aspect_ratio: readAspectRatio(
          params,
          ["9:16", "16:9", "1:1", "4:5", "3:4"],
          "9:16",
        ),
        count: readIntInRange(params, "count", 1, 1, 4),
        reference_storage_paths: readReferencePaths(params, ownerId, 4),
      },
    };
  }

  if (action === "video") {
    rejectUnknownKeys(params, [
      "prompt",
      "aspect_ratio",
      "duration_seconds",
      "reference_storage_paths",
      "thread_id",
    ]);
    return {
      action,
      params: {
        prompt: readPrompt(params),
        thread_id: readThreadId(params),
        aspect_ratio: readAspectRatio(params, ["9:16", "16:9"], "9:16"),
        duration_seconds: readIntInRange(params, "duration_seconds", 8, 5, 10),
        reference_storage_paths: readReferencePaths(params, ownerId, 2),
      },
    };
  }

  throw new Error("action must be 'chat', 'image' or 'video'");
}

export function validateResultBody(
  body: unknown,
  dropboxRoot: string,
): {
  message_id: string;
  claim_id: string;
  status: "done" | "failed";
  output: Record<string, unknown>;
  error: string | null;
} {
  if (!isRecord(body)) throw new Error("body must be an object");
  // `error_code` is accepted alongside `error` — the muse-side contract uses
  // either spelling (e.g. error_code: "out_of_scope").
  rejectUnknownKeys(body, [
    "message_id",
    "claim_id",
    "status",
    "output",
    "error",
    "error_code",
  ]);

  const messageId = body["message_id"];
  const claimId = body["claim_id"];
  const status = body["status"];
  if (typeof messageId !== "string" || messageId.length < 1) {
    throw new Error("message_id is required");
  }
  if (typeof claimId !== "string" || claimId.length < 1) {
    throw new Error("claim_id is required");
  }
  if (status !== "done" && status !== "failed") {
    throw new Error("status must be 'done' or 'failed'");
  }

  const rawOutput = body["output"] ?? {};
  if (!isRecord(rawOutput)) throw new Error("output must be an object");
  rejectUnknownKeys(rawOutput, ["dropbox_paths", "notes", "text"]);
  const rawPaths = rawOutput["dropbox_paths"] ?? [];
  if (!Array.isArray(rawPaths) || rawPaths.length > 8) {
    throw new Error("output.dropbox_paths must be an array of at most 8 paths");
  }
  const dropboxPaths: string[] = [];
  for (const item of rawPaths) {
    if (
      typeof item !== "string" ||
      !item.startsWith(dropboxRoot) ||
      item.includes("..") ||
      item.length > 512
    ) {
      throw new Error(`output.dropbox_paths must stay under ${dropboxRoot}`);
    }
    dropboxPaths.push(item);
  }
  const notes = rawOutput["notes"] ?? null;
  if (notes !== null && (typeof notes !== "string" || notes.length > 2000)) {
    throw new Error("output.notes must be a string of at most 2000 characters");
  }
  const text = rawOutput["text"] ?? null;
  if (text !== null && (typeof text !== "string" || text.length > 8000)) {
    throw new Error("output.text must be a string of at most 8000 characters");
  }

  const rawError = body["error"];
  if (
    rawError !== undefined &&
    rawError !== null &&
    (typeof rawError !== "string" || rawError.length > 2000)
  ) {
    throw new Error("error must be a string of at most 2000 characters");
  }
  const rawErrorCode = body["error_code"];
  if (
    rawErrorCode !== undefined &&
    rawErrorCode !== null &&
    (typeof rawErrorCode !== "string" || rawErrorCode.length > 2000)
  ) {
    throw new Error("error_code must be a string of at most 2000 characters");
  }
  const error = (typeof rawError === "string" && rawError.length > 0)
    ? rawError
    : (typeof rawErrorCode === "string" && rawErrorCode.length > 0)
    ? rawErrorCode
    : null;
  if (status === "failed" && !error) {
    throw new Error("error is required when status is 'failed'");
  }

  return {
    message_id: messageId,
    claim_id: claimId,
    status,
    output: { dropbox_paths: dropboxPaths, notes, text },
    error,
  };
}
