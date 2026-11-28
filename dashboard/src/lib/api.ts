import type {
  ActionMode,
  AgentKind,
  Conversation,
  ConversationMode,
  ConversationParticipant,
  FleetActivityItem,
  GroupBubble,
  GroupPost,
  MessageParams,
  Muse,
  OpenAIAgent,
  OpenAIMessage,
  Project,
  ProjectAgent,
  RelayMessage,
  RelayResult,
  ReplyToMeta,
  ThreadItem,
} from "../types";
import { MAX_UPLOAD_BYTES, stripReplyPrefix } from "./dropbox";
import { tNow } from "./i18n";
import { db } from "./supabase";

// ---- crypto helpers (wizard + token rotation) -----------------------------

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function requireUserId(): Promise<{ userId?: string; error: string | null }> {
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: tNow("api.sessionExpired") };
  return { userId: user.id, error: null };
}

async function getOwnerJwt(): Promise<string | null> {
  return (await db.auth.getSession()).data.session?.access_token ?? null;
}

// ---- muse registry ---------------------------------------------------------
// relay_muses is RLS owner-only: every call below runs as the signed-in owner,
// so the server independently scopes reads/writes to their own rows.

export async function listMuses(): Promise<{ data: Muse[]; error: string | null }> {
  const { data, error } = await db
    .from("relay_muses")
    .select(
      "recipient,name,dropbox_root,email_owner,cap_chat,cap_image,cap_video,setup_done,first_connected_at,last_claim_at,last_result_at,token_rotated_at,created_at",
    )
    .order("created_at", { ascending: true });
  return { data: (data ?? []) as Muse[], error: error?.message ?? null };
}

export async function createMuse(row: {
  owner_id: string;
  recipient: string;
  name: string;
  token_hash: string;
  dropbox_root: string;
  email_owner?: string;
  cap_chat?: boolean;
  cap_image?: boolean;
  cap_video?: boolean;
}): Promise<string | null> {
  const { error } = await db.from("relay_muses").insert(row);
  return error?.message ?? null;
}

export async function updateMuse(
  recipient: string,
  patch: {
    name?: string;
    email_owner?: string | null;
    dropbox_root?: string;
    cap_chat?: boolean;
    cap_image?: boolean;
    cap_video?: boolean;
  },
): Promise<string | null> {
  if (Object.keys(patch).length === 0) return null;
  const { error } = await db
    .from("relay_muses")
    .update(patch)
    .eq("recipient", recipient);
  if (error) return error.message;
  // Best-effort sync of cached display name in relay_project_agents
  if (patch.name) {
    await db
      .from("relay_project_agents")
      .update({ agent_name: patch.name })
      .eq("agent_kind", "muse")
      .eq("agent_ref", recipient);
  }
  return null;
}

export async function rotateMuseToken(
  recipient: string,
  tokenHash: string,
): Promise<string | null> {
  const { error } = await db
    .from("relay_muses")
    .update({
      token_hash: tokenHash,
      token_rotated_at: new Date().toISOString(),
    })
    .eq("recipient", recipient);
  return error?.message ?? null;
}

async function deleteProjectAgentByRef(
  agentKind: AgentKind,
  agentRef: string,
): Promise<string | null> {
  const { error } = await db
    .from("relay_project_agents")
    .delete()
    .eq("agent_kind", agentKind)
    .eq("agent_ref", agentRef);
  return error?.message ?? null;
}

export async function deleteMuse(recipient: string): Promise<string | null> {
  // Group & project memberships first so no group/project keeps a dangling
  // member, then the registry row — deleting it revokes claim rights immediately.
  const { error: me } = await db
    .from("relay_group_members")
    .delete()
    .eq("muse_recipient", recipient);
  if (me) return me.message;

  const paErr = await deleteProjectAgentByRef("muse", recipient);
  if (paErr) return paErr;

  const { error } = await db
    .from("relay_muses")
    .delete()
    .eq("recipient", recipient);
  return error?.message ?? null;
}

// ---- groups ----------------------------------------------------------------

export async function createGroup(
  name: string,
  members: { muse_recipient: string; name: string }[],
  rules?: string,
): Promise<{ id?: string; error: string | null }> {
  const auth = await requireUserId();
  if (!auth.userId) return { error: auth.error };
  const trimmedRules = rules?.trim() ?? "";
  // RLS requires owner_id = auth.uid() on the row itself.
  const { data: g, error: ge } = await db
    .from("relay_groups")
    .insert({
      name,
      owner_id: auth.userId,
      rules: trimmedRules.length > 0 ? trimmedRules : null,
    })
    .select("id")
    .single();
  if (ge) return { error: ge.message };
  const { error: me } = await db
    .from("relay_group_members")
    .insert(members.map((m) => ({ ...m, group_id: g.id })));
  if (me) {
    await db.from("relay_groups").delete().eq("id", g.id);
    return { error: me.message };
  }
  return { id: g.id, error: null };
}

export async function deleteGroup(id: string): Promise<string | null> {
  const { error } = await db.from("relay_groups").delete().eq("id", id);
  return error?.message ?? null;
}

export async function updateGroupRules(
  groupId: string,
  rules: string | null,
): Promise<string | null> {
  const trimmed = rules?.trim() ?? "";
  const { error } = await db
    .from("relay_groups")
    .update({ rules: trimmed.length > 0 ? trimmed : null })
    .eq("id", groupId);
  return error?.message ?? null;
}

export async function clearMuseThread(
  recipient: string,
  threadId?: string,
): Promise<string | null> {
  if (threadId) {
    const { error } = await db
      .from("relay_messages")
      .delete()
      .eq("recipient", recipient)
      .eq("params->>thread_id", threadId);
    return error?.message ?? null;
  }

  // Clear direct-channel history without deleting messages scoped to Project
  // Conversations or Relay groups (group fan-out rows carry thread_id = group_id).
  const [
    { data: convs, error: convErr },
    { data: groups, error: groupErr },
    { data: msgs, error: msgErr },
  ] = await Promise.all([
    db.from("relay_conversations").select("id"),
    db.from("relay_groups").select("id"),
    db.from("relay_messages").select("id,params").eq("recipient", recipient),
  ]);
  if (convErr) return convErr.message;
  if (groupErr) return groupErr.message;
  if (msgErr) return msgErr.message;

  const scopedIds = new Set([
    ...(convs ?? []).map((c) => String(c.id)),
    ...(groups ?? []).map((g) => String(g.id)),
  ]);
  const directIds = (msgs ?? [])
    .filter((m) => {
      const tid = (m.params as { thread_id?: unknown } | null)?.thread_id;
      return typeof tid !== "string" || !scopedIds.has(tid);
    })
    .map((m) => String(m.id));
  if (directIds.length === 0) return null;

  const { error } = await db.from("relay_messages").delete().in("id", directIds);
  return error?.message ?? null;
}

// ---- sending ---------------------------------------------------------------

async function extractFunctionError(
  error: unknown,
): Promise<{ code: string; message: string }> {
  if (error && typeof error === "object" && "context" in error) {
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      try {
        const body = (await ctx.clone().json()) as { error?: unknown } | null;
        if (body && typeof body.error === "string" && body.error.trim()) {
          const msg = body.error.trim();
          return { code: msg, message: msg };
        }
      } catch {
        // ignore JSON parse failure on error body
      }
    }
  }
  const msg =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "").trim()
      : String(error ?? "").trim();
  return { code: msg, message: msg || tNow("api.failed") };
}

export async function sendMessage(input: {
  recipient: string;
  action: ActionMode;
  params: MessageParams;
}): Promise<{ data: { message_id: string; expires_at: string } | null; error: string | null }> {
  const { data, error } = await db.functions.invoke("submit_message", {
    body: { recipient: input.recipient, action: input.action, params: input.params },
  });
  if (error) {
    const parsed = await extractFunctionError(error);
    return { data: null, error: parsed.message };
  }
  return { data: (data as never) ?? null, error: null };
}

export async function sendGroupMessage(input: {
  groupId: string;
  prompt: string;
  ownerName: string;
  referenceDropboxPaths?: string[];
  referenceDropboxPathsByRecipient?: Record<string, string[]>;
  replyTo?: ReplyToMeta;
}): Promise<{ error: string | null }> {
  const params: Record<string, unknown> = { prompt: input.prompt };
  if (input.referenceDropboxPaths && input.referenceDropboxPaths.length > 0) {
    params.reference_dropbox_paths = input.referenceDropboxPaths;
  }
  if (input.replyTo) {
    params.reply_to = input.replyTo;
  }
  const body: Record<string, unknown> = {
    group_id: input.groupId,
    action: "chat",
    params,
    owner_name: input.ownerName,
  };
  if (
    input.referenceDropboxPathsByRecipient &&
    Object.keys(input.referenceDropboxPathsByRecipient).length > 0
  ) {
    body.reference_dropbox_paths_by_recipient = input.referenceDropboxPathsByRecipient;
  }
  const { error } = await db.functions.invoke("submit_message", { body });
  if (error) {
    const parsed = await extractFunctionError(error);
    return { error: parsed.message };
  }
  return { error: null };
}

// ---- dropbox_proxy (temp_link cache + upload) ------------------------------

export interface DropboxTempLinkResult {
  link: string | null;
  name?: string;
  size?: number | null;
  path?: string;
  notConfigured?: boolean;
  error?: string;
}

const TEMP_LINK_TTL_MS = 30 * 60 * 1000;
const NOT_CONFIGURED_TTL_MS = 30 * 1000;

const tempLinkCache = new Map<string, { res: DropboxTempLinkResult; expiresAt: number }>();
const inflightTempLinks = new Map<string, Promise<DropboxTempLinkResult>>();

// ---- dropbox thumbs (blur-up placeholders) ---------------------------------

const thumbCache = new Map<string, { url: string | null; expiresAt: number }>();
const THUMB_TTL_MS = 60 * 60 * 1000;
const THUMB_MISS_TTL_MS = 5 * 60 * 1000;

/** Tiny JPEG preview (server-cached, immutable paths). Null = no thumbnail
 * exists for this path (docs/audio) — cached briefly so cards stop retrying. */
export async function getDropboxThumb(path: string): Promise<string | null> {
  const key = path.trim();
  const cached = thumbCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.url;
  try {
    const jwt = await getOwnerJwt();
    if (!jwt) return null;
    const response = await fetch("/api/dropbox/thumb", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: key }),
    });
    if (!response.ok) {
      thumbCache.set(key, { url: null, expiresAt: Date.now() + THUMB_MISS_TTL_MS });
      return null;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    thumbCache.set(key, { url, expiresAt: Date.now() + THUMB_TTL_MS });
    return url;
  } catch {
    return null;
  }
}

async function readJsonPayload(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await res.json()) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function getDropboxTempLink(path: string): Promise<DropboxTempLinkResult> {
  const key = path.trim();
  const cached = tempLinkCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return Promise.resolve(cached.res);
  }
  const existing = inflightTempLinks.get(key);
  if (existing) return existing;

  const task = (async (): Promise<DropboxTempLinkResult> => {
    try {
      const jwt = await getOwnerJwt();
      if (!jwt) {
        return { link: null, error: tNow("api.sessionExpired") };
      }

      const response = await fetch("/api/dropbox/temp-link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: key }),
      });

      const payload = await readJsonPayload(response);
      const errCode = typeof payload?.error === "string" ? payload.error : "";

      if (response.status === 503 || errCode === "dropbox_not_configured") {
        const res: DropboxTempLinkResult = { link: null, notConfigured: true };
        tempLinkCache.set(key, { res, expiresAt: Date.now() + NOT_CONFIGURED_TTL_MS });
        return res;
      }

      if (!response.ok) {
        return { link: null, error: errCode || `HTTP ${response.status}` };
      }

      if (!payload || typeof payload.link !== "string" || !payload.link) {
        return {
          link: null,
          error: errCode || tNow("api.failed"),
        };
      }

      const res: DropboxTempLinkResult = {
        link: payload.link,
        name: typeof payload.name === "string" ? payload.name : undefined,
        size: typeof payload.size === "number" ? payload.size : null,
        path: typeof payload.path === "string" ? payload.path : key,
      };
      tempLinkCache.set(key, { res, expiresAt: Date.now() + TEMP_LINK_TTL_MS });
      return res;
    } catch (err) {
      return { link: null, error: err instanceof Error ? err.message : String(err) };
    } finally {
      inflightTempLinks.delete(key);
    }
  })();

  inflightTempLinks.set(key, task);
  return task;
}

export async function uploadFileToMuseDropbox(input: {
  recipient: string;
  threadId?: string | null;
  file: File;
}): Promise<{ dropbox_path: string | null; name?: string; size?: number; error: string | null }> {
  if (input.file.size <= 0 || input.file.size > MAX_UPLOAD_BYTES) {
    return {
      dropbox_path: null,
      error: tNow("composer.fileSizeErr", { name: input.file.name }),
    };
  }
  try {
    const jwt = await getOwnerJwt();
    if (!jwt) {
      return { dropbox_path: null, error: tNow("api.sessionExpired") };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/octet-stream",
      "x-recipient": input.recipient,
      "x-file-name": encodeURIComponent(input.file.name),
    };
    const trimmedThread = input.threadId?.trim();
    if (trimmedThread) {
      headers["x-thread-id"] = trimmedThread;
    }

    const response = await fetch("/api/dropbox/upload", {
      method: "POST",
      headers,
      body: input.file,
    });

    const payload = await readJsonPayload(response);
    const errCode = typeof payload?.error === "string" ? payload.error : "";

    if (response.status === 503 || errCode === "dropbox_not_configured") {
      return { dropbox_path: null, error: tNow("dropbox.notConfiguredErr") };
    }

    if (!response.ok) {
      return { dropbox_path: null, error: errCode || `HTTP ${response.status}` };
    }

    if (!payload || typeof payload.dropbox_path !== "string" || !payload.dropbox_path) {
      return {
        dropbox_path: null,
        error: errCode || tNow("api.failed"),
      };
    }

    return {
      dropbox_path: payload.dropbox_path,
      name: typeof payload.name === "string" ? payload.name : input.file.name,
      size: typeof payload.size === "number" ? payload.size : input.file.size,
      error: null,
    };
  } catch (err) {
    return {
      dropbox_path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const uploadFileToDropbox = uploadFileToMuseDropbox;

export async function distributeDropboxFiles(input: {
  threadId?: string | null;
  sourcePaths: string[];
  targetRecipients: string[];
}): Promise<{ paths_by_recipient: Record<string, string[]>; error: string | null }> {
  try {
    const jwt = await getOwnerJwt();
    if (!jwt) {
      return { paths_by_recipient: {}, error: tNow("api.sessionExpired") };
    }
    const trimmedThread = input.threadId?.trim();
    const response = await fetch("/api/dropbox/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(trimmedThread ? { thread_id: trimmedThread } : {}),
        source_paths: input.sourcePaths,
        target_recipients: input.targetRecipients,
      }),
    });
    const payload = await readJsonPayload(response);
    const errCode = typeof payload?.error === "string" ? payload.error : "";

    if (response.status === 503 || errCode === "dropbox_not_configured") {
      return { paths_by_recipient: {}, error: tNow("dropbox.notConfiguredErr") };
    }
    if (!response.ok) {
      return { paths_by_recipient: {}, error: errCode || `HTTP ${response.status}` };
    }

    const rawMap = payload?.paths_by_recipient;
    const pathsByRecipient: Record<string, string[]> = {};
    if (rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)) {
      for (const [recipient, rawList] of Object.entries(rawMap as Record<string, unknown>)) {
        if (Array.isArray(rawList)) {
          pathsByRecipient[recipient] = rawList.filter(
            (p): p is string => typeof p === "string" && p.length > 0,
          );
        }
      }
    }
    return { paths_by_recipient: pathsByRecipient, error: null };
  } catch (err) {
    return {
      paths_by_recipient: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- muse thread (1:1 chat) ------------------------------------------------

export async function fetchMuseThread(
  recipient: string,
  threadId?: string,
): Promise<{
  items: ThreadItem[];
  error: string | null;
}> {
  let query = db
    .from("relay_messages")
    .select("id,recipient,action,params,status,attempts,created_at,expires_at,claim_expires_at")
    .eq("recipient", recipient);

  if (threadId) {
    query = query.eq("params->>thread_id", threadId);
  } else {
    // Direct channel: only true direct messages. Group fan-out rows carry
    // thread_id = group_id (stamped server-side) and project conversation
    // rows carry their conversation id — both must stay out of this view.
    query = query.is("params->>thread_id", null);
  }

  const msgs = await query.order("created_at", { ascending: false }).limit(50);
  if (msgs.error) return { items: [], error: msgs.error.message };
  const rows = (msgs.data ?? []) as RelayMessage[];
  const items: ThreadItem[] = [];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const res = await db
      .from("relay_results")
      .select("message_id,status,output,error,created_at")
      .in("message_id", ids);
    if (res.error) return { items: [], error: res.error.message };
    const byMessage = new Map<string, RelayResult>();
    for (const r of res.data ?? []) byMessage.set(r.message_id, r as RelayResult);
    for (const m of [...rows].reverse()) {
      items.push({ message: m, result: byMessage.get(m.id) ?? null });
    }
  }
  return { items, error: null };
}

/** Page size for the Overview "Recent activity" infinite scroll feed. */
export const FLEET_ACTIVITY_PAGE_SIZE = 30;

export async function fetchFleetActivity(
  limit: number = FLEET_ACTIVITY_PAGE_SIZE,
  offset = 0,
): Promise<{
  items: FleetActivityItem[];
  error: string | null;
}> {
  const msgs = await db
    .from("relay_messages")
    .select("id,recipient,action,params,status,attempts,created_at,expires_at,claim_expires_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (msgs.error) return { items: [], error: msgs.error.message };
  const rows = (msgs.data ?? []) as (RelayMessage & { recipient: string })[];
  if (rows.length === 0) return { items: [], error: null };

  const ids = rows.map((r) => r.id);
  const res = await db
    .from("relay_results")
    .select("message_id,status,output,error,created_at")
    .in("message_id", ids);
  if (res.error) return { items: [], error: res.error.message };

  const byMessage = new Map<string, RelayResult>();
  for (const r of res.data ?? []) byMessage.set(r.message_id, r as RelayResult);

  return {
    items: rows.map((m) => ({
      recipient: m.recipient,
      // params->>thread_id: group fan-out rows are stamped with the group_id,
      // conversation sends carry the conversation id, direct channel is null.
      threadId: readThreadParam(m.params),
      message: m,
      result: byMessage.get(m.id) ?? null,
    })),
    error: null,
  };
}

/** Extracts params.thread_id as string | null from the params JSON column. */
function readThreadParam(params: unknown): string | null {
  const tid = (params as { thread_id?: unknown } | null)?.thread_id;
  return typeof tid === "string" && tid.length > 0 ? tid : null;
}

// ---- v9: AI usage quota reports ---------------------------------------------
// Owner asks a muse for its AI account quota via params.command = "usage"
// (prompt "/usage"). The muse answers with a human summary in output.text and
// a machine JSON in output.notes (submit_result only allows
// dropbox_paths/notes/text, so the JSON rides in notes, ≤ 2000 chars).

export interface UsageReport {
  plan: string;
  weeklyUsedPercent: number;
  weeklyRemainingPercent: number;
  weeklyResetAt: string;
  additionalTokensUsedPercent: number;
  /** Kept as string ("31B") — the muse's own unit, not a plain number. */
  additionalTokensRemaining: string;
  checkedAt: string;
  /** relay_results.created_at of the row the report was parsed from. */
  resultAt: string;
}

/** Raw snake_case JSON the muse packs into notes for a usage request. */
interface UsageNotesPayload {
  command?: unknown;
  plan?: unknown;
  weekly_used_percent?: unknown;
  weekly_remaining_percent?: unknown;
  weekly_reset_at?: unknown;
  additional_tokens_used_percent?: unknown;
  additional_tokens_remaining?: unknown;
  checked_at?: unknown;
}

/** notes → JSON.parse(trim). Never throws; null on any failure. */
function parseNotesJson(raw: string): UsageNotesPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as UsageNotesPayload;
    }
  } catch {
    // fall through
  }
  return null;
}

/** text → first {...} block (task contract fallback when notes is unparseable). */
function parseTextJsonBlock(raw: string): UsageNotesPayload | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as UsageNotesPayload;
    }
  } catch {
    // fall through
  }
  return null;
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Validates the payload (numeric weekly_used_percent 0–100 required). */
function toUsageReport(payload: UsageNotesPayload, resultAt: string): UsageReport | null {
  const used = numOr(payload.weekly_used_percent, NaN);
  if (!Number.isFinite(used) || used < 0 || used > 100) return null;
  const remaining = numOr(
    payload.weekly_remaining_percent,
    Math.max(0, 100 - Math.round(used)),
  );
  return {
    plan: strOr(payload.plan, ""),
    weeklyUsedPercent: used,
    weeklyRemainingPercent: remaining,
    weeklyResetAt: strOr(payload.weekly_reset_at, ""),
    additionalTokensUsedPercent: numOr(payload.additional_tokens_used_percent, 0),
    additionalTokensRemaining: strOr(payload.additional_tokens_remaining, ""),
    checkedAt: strOr(payload.checked_at, resultAt),
    resultAt,
  };
}

export async function fetchUsageReports(): Promise<{
  reports: Map<string, UsageReport>;
  error: string | null;
}> {
  const reports = new Map<string, UsageReport>();
  try {
    const msgs = await db
      .from("relay_messages")
      .select("id,recipient,params,created_at")
      .eq("params->>command", "usage")
      .order("created_at", { ascending: false })
      .limit(100);
    if (msgs.error) return { reports, error: msgs.error.message };
    const rows = (msgs.data ?? []) as {
      id: string;
      recipient: string;
      created_at: string;
    }[];
    if (rows.length === 0) return { reports, error: null };

    const ids = rows.map((r) => r.id);
    const res = await db
      .from("relay_results")
      .select("message_id,status,output,created_at")
      .in("message_id", ids)
      .eq("status", "done");
    if (res.error) return { reports, error: res.error.message };

    const messageById = new Map(rows.map((r) => [r.id, r]));
    // Latest report per recipient: .in() results are unordered, so compare
    // result timestamps explicitly instead of relying on row order.
    for (const r of res.data ?? []) {
      if (r.status !== "done") continue;
      const msg = messageById.get(r.message_id);
      if (!msg || !msg.recipient) continue;
      const result = r as RelayResult;
      const resultAt = result.created_at || msg.created_at;
      const parsed =
        parseNotesJson(result.output?.notes ?? "") ??
        parseTextJsonBlock(result.output?.text ?? "");
      if (!parsed) continue;
      const report = toUsageReport(parsed, resultAt);
      if (!report) continue;

      const key = msg.recipient.toLowerCase();
      const prev = reports.get(key);
      const thisMs = new Date(resultAt).getTime();
      const prevMs = prev ? new Date(prev.resultAt).getTime() : NaN;
      if (!prev || (Number.isFinite(thisMs) && thisMs > prevMs)) {
        reports.set(key, report);
      }
    }
    return { reports, error: null };
  } catch (err) {
    return {
      reports,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendUsageRequest(recipient: string) {
  return sendMessage({
    recipient,
    action: "chat",
    params: { command: "usage", prompt: "/usage" },
  });
}

function parseReplyTo(raw: unknown): ReplyToMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as { message_id?: unknown; sender?: unknown; excerpt?: unknown };
  const sender = typeof obj.sender === "string" ? obj.sender.trim() : "";
  if (!sender) return null;
  const excerpt = typeof obj.excerpt === "string" ? obj.excerpt : "";
  const message_id =
    typeof obj.message_id === "string" && obj.message_id.length > 0
      ? obj.message_id
      : undefined;
  return message_id ? { message_id, sender, excerpt } : { sender, excerpt };
}

// ---- group thread ----------------------------------------------------------

function batchState(
  rows: { id: string; status: string }[],
  results: Map<string, RelayResult>,
): { state: GroupBubble["state"]; error: string | null } {
  let failedErr: string | null = null;
  let pending = false;
  let processing = false;
  for (const r of rows) {
    if (r.status === "failed") {
      failedErr = results.get(r.id)?.error ?? tNow("api.failed");
      return { state: "failed", error: failedErr };
    }
    if (r.status === "pending") pending = true;
    if (r.status === "processing") processing = true;
  }
  if (pending) return { state: "pending", error: null };
  if (processing) return { state: "processing", error: null };
  return { state: "done", error: null };
}

// v8 reply=result model: owner utterances render as one bubble per fan-out
// batch; each muse reply renders from the relay_results row recorded on the
// message that muse claimed — so a reply stays visible even when it mentions
// nobody (no fan-out rows are created for it).
// v9: also returns the group regulation text (system prompt) for the
// collapsed prepended block; null while the group has no rules yet.
export async function fetchGroupThread(groupId: string): Promise<{
  bubbles: GroupBubble[];
  rules: string | null;
  error: string | null;
}> {
  const [{ data: posts, error: pe }, { data: memberRows, error: gme }, { data: groupRows, error: ge }] =
    await Promise.all([
      db
        .from("relay_group_posts")
        .select("message_id,from_kind,from_name,turn,batch_id,created_at")
        .eq("group_id", groupId)
        .order("created_at", { ascending: true })
        .limit(400),
      db
        .from("relay_group_members")
        .select("muse_recipient,name")
        .eq("group_id", groupId),
      db
        .from("relay_groups")
        .select("rules")
        .eq("id", groupId)
        .maybeSingle(),
    ]);
  if (pe) return { bubbles: [], rules: null, error: pe.message };
  if (gme) return { bubbles: [], rules: null, error: gme.message };
  if (ge) return { bubbles: [], rules: null, error: ge.message };
  const rules = typeof groupRows?.rules === "string" && groupRows.rules.length > 0 ? groupRows.rules : null;
  const postRows = (posts ?? []) as GroupPost[];
  const nameByRecipient = new Map<string, string>();
  for (const m of memberRows ?? []) {
    nameByRecipient.set(String(m.muse_recipient).toLowerCase(), String(m.name));
  }
  if (postRows.length === 0) return { bubbles: [], rules, error: null };

  const ids = [...new Set(postRows.map((p) => p.message_id))];
  const [
    { data: msgs, error: me },
    { data: results, error: re },
    { data: museRows },
  ] = await Promise.all([
    db.from("relay_messages").select("id,recipient,status,params,created_at").in("id", ids),
    db.from("relay_results").select("message_id,status,output,error,created_at").in("message_id", ids),
    db.from("relay_muses").select("recipient,name"),
  ]);
  if (me) return { bubbles: [], rules, error: me.message };
  if (re) return { bubbles: [], rules, error: re.message };
  // Registry names fill gaps for members removed after they replied.
  for (const m of museRows ?? []) {
    const key = String(m.recipient).toLowerCase();
    if (!nameByRecipient.has(key)) nameByRecipient.set(key, String(m.name));
  }

  // Group bubbles only need a narrow slice of each message row.
  type MsgRow = {
    id: string;
    recipient: string;
    status: string;
    params: { prompt?: string; reference_dropbox_paths?: unknown; reply_to?: unknown };
  };
  const msgMap = new Map<string, MsgRow>((msgs ?? []).map((m) => [m.id, m as MsgRow]));
  const resMap = new Map<string, RelayResult>((results ?? []).map((r) => [r.message_id, r as RelayResult]));

  const bubbles: GroupBubble[] = [];

  // Bridge hand-off refs ride in fan-out row params — keep string entries only
  // (the edge already caps at 4 and validates prefix, this is just type guard).
  const readRefPaths = (params: MsgRow["params"] | undefined): string[] => {
    const raw = params?.reference_dropbox_paths;
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is string => typeof p === "string" && p.length > 0);
  };

  // Owner utterances: one bubble per fan-out batch (delivery rows share it).
  const seenBatch = new Set<string>();
  for (const p of postRows) {
    if (p.from_kind !== "owner" || seenBatch.has(p.batch_id)) continue;
    seenBatch.add(p.batch_id);
    const rows = postRows
      .filter((q) => q.batch_id === p.batch_id)
      .map((q) => msgMap.get(q.message_id))
      .filter((m): m is MsgRow => Boolean(m));
    const first = rows[0];
    if (!first) continue;
    const b = batchState(rows, resMap);
    let ownerPaths: string[] = [];
    for (const r of rows) {
      const refs = readRefPaths(r.params);
      if (refs.length > 0) {
        ownerPaths = refs;
        break;
      }
    }
    const replyTo = parseReplyTo(first.params?.reply_to);
    bubbles.push({
      batchId: p.batch_id,
      kind: "owner",
      name: p.from_name,
      time: p.created_at,
      state: b.state,
      text: stripReplyPrefix((first.params?.prompt ?? "").replace(/^\[[^\]]+\]:\s*/, "")),
      paths: ownerPaths,
      refPaths: [],
      notes: null,
      error: b.state === "failed" ? b.error : null,
      replyTo,
    });
  }

  // Muse replies: one bubble per claimed group row — every post row whose
  // message carries a result (done/failed) or is currently processing.
  // Owner record-only rows are done without a result, so they never match.
  for (const p of postRows) {
    const msg = msgMap.get(p.message_id);
    if (!msg) continue;
    const result = resMap.get(p.message_id) ?? null;
    if (!result && msg.status !== "processing") continue;
    const state: GroupBubble["state"] = result
      ? result.status === "failed"
        ? "failed"
        : "done"
      : "processing";
    bubbles.push({
      batchId: p.message_id,
      kind: "muse",
      name: nameByRecipient.get(String(msg.recipient).toLowerCase()) ?? "Muse",
      time: result?.created_at ?? p.created_at,
      state,
      text: result?.output?.text ?? "",
      paths: result?.output?.dropbox_paths ?? [],
      refPaths: readRefPaths(msg.params),
      notes: result?.output?.notes ?? null,
      error: state === "failed" ? result?.error ?? tNow("api.failed") : null,
    });
  }

  bubbles.sort((a, b) => a.time.localeCompare(b.time));
  return { bubbles, rules, error: null };
}

// ---- v7: OpenAI Compatible Agents ------------------------------------------

export async function listOpenAIAgents(): Promise<{
  data: OpenAIAgent[];
  error: string | null;
}> {
  const { data, error } = await db
    .from("relay_agents_openai")
    .select("id,name,base_url,model,api_key,system_prompt,created_at")
    .order("created_at", { ascending: true });
  return { data: (data ?? []) as OpenAIAgent[], error: error?.message ?? null };
}

export async function createOpenAIAgent(input: {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  system_prompt: string;
}): Promise<{ data?: OpenAIAgent; error: string | null }> {
  const auth = await requireUserId();
  if (!auth.userId) return { error: auth.error };

  const { data, error } = await db
    .from("relay_agents_openai")
    .insert({
      owner_id: auth.userId,
      name: input.name,
      base_url: input.base_url,
      model: input.model,
      api_key: input.api_key,
      system_prompt: input.system_prompt,
    })
    .select("id,name,base_url,model,api_key,system_prompt,created_at")
    .single();
  return { data: data as OpenAIAgent | undefined, error: error?.message ?? null };
}

export async function updateOpenAIAgent(
  id: string,
  input: {
    name: string;
    base_url: string;
    model: string;
    api_key: string;
    system_prompt: string;
  },
): Promise<string | null> {
  const { error } = await db
    .from("relay_agents_openai")
    .update({
      name: input.name,
      base_url: input.base_url,
      model: input.model,
      api_key: input.api_key,
      system_prompt: input.system_prompt,
    })
    .eq("id", id);
  if (error) return error.message;

  await db
    .from("relay_project_agents")
    .update({ agent_name: input.name })
    .eq("agent_kind", "openai")
    .eq("agent_ref", id);
  return null;
}

export async function deleteOpenAIAgent(id: string): Promise<string | null> {
  const paErr = await deleteProjectAgentByRef("openai", id);
  if (paErr) return paErr;

  const { error } = await db
    .from("relay_agents_openai")
    .delete()
    .eq("id", id);
  return error?.message ?? null;
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (clean.toLowerCase().endsWith("/chat/completions")) return clean;
  return `${clean}/chat/completions`;
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "AbortError";
}

function mapOpenAIProxyError(codeOrMsg: string): string {
  switch (codeOrMsg) {
    // timeout_20s / timeout_60s are legacy codes from the pre-45s/180s server
    // builds; kept so an older server still renders a readable message.
    case "timeout_45s":
    case "timeout_20s":
      return tNow("api.timeoutTest");
    case "timeout_180s":
    case "timeout_60s":
      return tNow("api.timeoutChat");
    case "empty_choices":
      return tNow("api.noChoices");
    case "empty_reply":
      return tNow("api.emptyReply");
    case "invalid_json_response":
      return tNow("api.invalidJson");
    default:
      return codeOrMsg;
  }
}

export async function testOpenAIAgentConnection(
  agent: Pick<OpenAIAgent, "base_url" | "model" | "api_key"> & { id?: string },
): Promise<{ ok: boolean; latencyMs: number; reply?: string; error?: string }> {
  const jwt = await getOwnerJwt();
  if (!jwt) {
    return { ok: false, latencyMs: 0, error: tNow("api.sessionExpired") };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);
  const started = performance.now();

  try {
    const res = await fetch("/api/openai/test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(agent.id ? { agent_id: agent.id } : {}),
        base_url: agent.base_url,
        model: agent.model,
        api_key: agent.api_key,
      }),
      signal: controller.signal,
    });
    const fallbackLatency = Math.round(performance.now() - started);
    const payload = await readJsonPayload(res);
    const latencyMs =
      typeof payload?.latencyMs === "number" ? payload.latencyMs : fallbackLatency;

    if (!payload) {
      return {
        ok: false,
        latencyMs,
        error: res.ok ? tNow("api.invalidJson") : `HTTP ${res.status}`,
      };
    }

    if (res.ok && payload.ok === true) {
      const reply = typeof payload.reply === "string" ? payload.reply.trim() : "";
      return { ok: true, latencyMs, reply: reply || "OK" };
    }

    const rawErr =
      typeof payload.error === "string" && payload.error
        ? payload.error
        : `HTTP ${res.status}`;
    return { ok: false, latencyMs, error: mapOpenAIProxyError(rawErr) };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    if (isAbortError(err)) {
      return { ok: false, latencyMs, error: tNow("api.timeoutTest") };
    }
    return {
      ok: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface OpenAIChatHistoryTurn {
  role: "owner" | "agent" | "user" | "assistant";
  content: string;
  status?: "done" | "failed";
}

export interface OpenAIChatOptions {
  signal?: AbortSignal;
  conversationId?: string;
  attachmentDropboxPaths?: string[];
}

export async function callOpenAIChatCompletion(
  agent: Pick<OpenAIAgent, "id">,
  history: OpenAIChatHistoryTurn[],
  prompt: string,
  options?: AbortSignal | OpenAIChatOptions,
): Promise<{ content?: string; error?: string }> {
  const opts: OpenAIChatOptions =
    options && options instanceof AbortSignal ? { signal: options } : (options ?? {});
  const signal = opts.signal;

  const jwt = await getOwnerJwt();
  if (!jwt) {
    return { error: tNow("api.sessionExpired") };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 190000);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort);

  const messages = [
    ...history
      .filter((m) => (m.status ?? "done") === "done" && m.content.trim().length > 0)
      .slice(-16)
      .map((m) => ({
        role: (m.role === "owner" || m.role === "user" ? "user" : "assistant") as
          | "user"
          | "assistant",
        content: m.content,
      })),
    { role: "user" as const, content: prompt },
  ];

  try {
    const res = await fetch("/api/openai/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agent.id,
        messages,
        ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
        ...(opts.attachmentDropboxPaths && opts.attachmentDropboxPaths.length > 0
          ? { attachment_dropbox_paths: opts.attachmentDropboxPaths }
          : {}),
      }),
      signal: controller.signal,
    });

    const payload = await readJsonPayload(res);
    if (!payload) {
      return { error: res.ok ? tNow("api.invalidJson") : `HTTP ${res.status}` };
    }

    const rawErr = typeof payload.error === "string" && payload.error ? payload.error : "";
    if (!res.ok || rawErr) {
      return { error: mapOpenAIProxyError(rawErr || `HTTP ${res.status}`) };
    }

    const content = typeof payload.content === "string" ? payload.content : "";
    if (!content.trim()) {
      return { error: tNow("api.emptyReply") };
    }
    return { content };
  } catch (err) {
    if (isAbortError(err)) {
      return { error: tNow("api.timeoutChat") };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---- v7: Projects & Project Agents -----------------------------------------

export async function listProjects(): Promise<{
  data: Project[];
  error: string | null;
}> {
  const { data, error } = await db
    .from("relay_projects")
    .select("id,name,description,created_at")
    .order("created_at", { ascending: true });
  return { data: (data ?? []) as Project[], error: error?.message ?? null };
}

export async function createProject(input: {
  name: string;
  description: string;
}): Promise<{ data?: Project; error: string | null }> {
  const auth = await requireUserId();
  if (!auth.userId) return { error: auth.error };

  const { data, error } = await db
    .from("relay_projects")
    .insert({
      owner_id: auth.userId,
      name: input.name,
      description: input.description,
    })
    .select("id,name,description,created_at")
    .single();
  return { data: data as Project | undefined, error: error?.message ?? null };
}

export async function updateProject(
  id: string,
  input: { name: string; description: string },
): Promise<string | null> {
  const { error } = await db
    .from("relay_projects")
    .update({ name: input.name, description: input.description })
    .eq("id", id);
  return error?.message ?? null;
}

export async function deleteProject(id: string): Promise<string | null> {
  // Clean up any relay_groups linked by this project's conversations
  const { data: convs } = await db
    .from("relay_conversations")
    .select("group_id")
    .eq("project_id", id)
    .not("group_id", "is", null);

  const { error } = await db.from("relay_projects").delete().eq("id", id);
  if (error) return error.message;

  const groupIds = (convs ?? [])
    .map((c) => (c as { group_id: string | null }).group_id)
    .filter((gid): gid is string => Boolean(gid));
  if (groupIds.length > 0) {
    await db.from("relay_groups").delete().in("id", groupIds);
  }
  return null;
}

export async function listProjectAgents(): Promise<{
  data: ProjectAgent[];
  error: string | null;
}> {
  const { data, error } = await db
    .from("relay_project_agents")
    .select("id,project_id,agent_kind,agent_ref,agent_name,created_at")
    .order("created_at", { ascending: true });
  return { data: (data ?? []) as ProjectAgent[], error: error?.message ?? null };
}

export async function syncProjectAgents(
  projectId: string,
  desired: { agent_kind: AgentKind; agent_ref: string; agent_name: string }[],
): Promise<string | null> {
  const auth = await requireUserId();
  if (!auth.userId) return auth.error;

  const { data: existingRows, error: fetchErr } = await db
    .from("relay_project_agents")
    .select("id,agent_kind,agent_ref,agent_name")
    .eq("project_id", projectId);
  if (fetchErr) return fetchErr.message;

  const existing = (existingRows ?? []) as {
    id: string;
    agent_kind: AgentKind;
    agent_ref: string;
    agent_name: string;
  }[];

  const keyOf = (k: AgentKind, ref: string) => `${k}:${ref}`;
  const desiredMap = new Map(desired.map((d) => [keyOf(d.agent_kind, d.agent_ref), d]));
  const existingMap = new Map(existing.map((e) => [keyOf(e.agent_kind, e.agent_ref), e]));

  const toDeleteIds = existing
    .filter((e) => !desiredMap.has(keyOf(e.agent_kind, e.agent_ref)))
    .map((e) => e.id);

  if (toDeleteIds.length > 0) {
    const { error: delErr } = await db
      .from("relay_project_agents")
      .delete()
      .in("id", toDeleteIds);
    if (delErr) return delErr.message;
  }

  const toInsert = desired
    .filter((d) => !existingMap.has(keyOf(d.agent_kind, d.agent_ref)))
    .map((d) => ({
      project_id: projectId,
      owner_id: auth.userId,
      agent_kind: d.agent_kind,
      agent_ref: d.agent_ref,
      agent_name: d.agent_name,
    }));

  if (toInsert.length > 0) {
    const { error: insErr } = await db.from("relay_project_agents").insert(toInsert);
    if (insErr) return insErr.message;
  }

  const toRename = existing.filter((e) => {
    const target = desiredMap.get(keyOf(e.agent_kind, e.agent_ref));
    return target && target.agent_name !== e.agent_name;
  });
  for (const e of toRename) {
    const target = desiredMap.get(keyOf(e.agent_kind, e.agent_ref));
    if (!target) continue;
    await db
      .from("relay_project_agents")
      .update({ agent_name: target.agent_name })
      .eq("id", e.id);
  }

  return null;
}

export async function removeProjectAgent(
  projectId: string,
  agentKind: AgentKind,
  agentRef: string,
): Promise<string | null> {
  const { error } = await db
    .from("relay_project_agents")
    .delete()
    .eq("project_id", projectId)
    .eq("agent_kind", agentKind)
    .eq("agent_ref", agentRef);
  return error?.message ?? null;
}

// ---- v7: Conversations & OpenAI Messages -----------------------------------

function normalizeConversation(row: Record<string, unknown>): Conversation {
  const rawParts = row.participants;
  const participants: ConversationParticipant[] = Array.isArray(rawParts)
    ? rawParts
        .filter(
          (p): p is ConversationParticipant =>
            Boolean(p) &&
            typeof p === "object" &&
            "kind" in p &&
            "ref" in p &&
            "name" in p,
        )
        .map((p) => ({
          kind: p.kind === "openai" ? "openai" : "muse",
          ref: String(p.ref),
          name: String(p.name),
        }))
    : [];

  return {
    id: String(row.id),
    project_id: String(row.project_id),
    title: String(row.title),
    mode: row.mode as ConversationMode,
    group_id: row.group_id ? String(row.group_id) : null,
    participants,
    system_prompt:
      typeof row.system_prompt === "string" && row.system_prompt.length > 0
        ? row.system_prompt
        : null,
    created_at: String(row.created_at),
  };
}

function isMissingSchemaColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? "";
  const msg = (err.message ?? "").toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache")
  );
}

export async function listConversations(): Promise<{
  data: Conversation[];
  error: string | null;
}> {
  let { data, error } = await db
    .from("relay_conversations")
    .select("id,project_id,title,mode,group_id,participants,system_prompt,created_at")
    .order("created_at", { ascending: true });
  if (isMissingSchemaColumnError(error)) {
    const legacy = await db
      .from("relay_conversations")
      .select("id,project_id,title,mode,group_id,participants,created_at")
      .order("created_at", { ascending: true });
    data = legacy.data as typeof data;
    error = legacy.error;
  }
  return {
    data: (data ?? []).map((r) => normalizeConversation(r as Record<string, unknown>)),
    error: error?.message ?? null,
  };
}

export async function createConversation(input: {
  project_id: string;
  title: string;
  mode: ConversationMode;
  group_id: string | null;
  participants: ConversationParticipant[];
}): Promise<{ data?: Conversation; error: string | null }> {
  const auth = await requireUserId();
  if (!auth.userId) return { error: auth.error };

  const payload = {
    project_id: input.project_id,
    owner_id: auth.userId,
    title: input.title,
    mode: input.mode,
    group_id: input.group_id,
    participants: input.participants,
  };
  let { data, error } = await db
    .from("relay_conversations")
    .insert(payload)
    .select("id,project_id,title,mode,group_id,participants,system_prompt,created_at")
    .single();
  if (isMissingSchemaColumnError(error)) {
    const legacy = await db
      .from("relay_conversations")
      .insert(payload)
      .select("id,project_id,title,mode,group_id,participants,created_at")
      .single();
    data = legacy.data as typeof data;
    error = legacy.error;
  }
  if (error || !data) return { error: error?.message ?? tNow("api.createConvFailed") };
  return { data: normalizeConversation(data as Record<string, unknown>), error: null };
}

export async function updateConversationSystemPrompt(
  conversationId: string,
  systemPrompt: string | null,
): Promise<string | null> {
  const trimmed = systemPrompt?.trim() ?? "";
  const { error } = await db
    .from("relay_conversations")
    .update({ system_prompt: trimmed.length > 0 ? trimmed : null })
    .eq("id", conversationId);
  return error?.message ?? null;
}

export async function deleteConversation(
  id: string,
  groupId?: string | null,
): Promise<string | null> {
  const { error } = await db.from("relay_conversations").delete().eq("id", id);
  if (error) return error.message;
  if (groupId) {
    await db.from("relay_groups").delete().eq("id", groupId);
  }
  await db.from("relay_messages").delete().eq("params->>thread_id", id);
  return null;
}

function normalizeOpenAIMessage(row: Record<string, unknown>): OpenAIMessage {
  const rawPaths = row.dropbox_paths;
  const dropbox_paths = Array.isArray(rawPaths)
    ? rawPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    role: row.role === "owner" ? "owner" : "agent",
    agent_ref: row.agent_ref ? String(row.agent_ref) : null,
    agent_name: String(row.agent_name ?? ""),
    content: String(row.content ?? ""),
    dropbox_paths,
    reply_to: parseReplyTo(row.reply_to),
    status: row.status === "failed" ? "failed" : "done",
    error: typeof row.error === "string" ? row.error : null,
    created_at: String(row.created_at),
  };
}

export async function fetchOpenAIMessages(conversationId: string): Promise<{
  data: OpenAIMessage[];
  error: string | null;
}> {
  let { data, error } = await db
    .from("relay_openai_messages")
    .select(
      "id,conversation_id,role,agent_ref,agent_name,content,dropbox_paths,reply_to,status,error,created_at",
    )
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(300);
  if (isMissingSchemaColumnError(error)) {
    const legacy = await db
      .from("relay_openai_messages")
      .select("id,conversation_id,role,agent_ref,agent_name,content,status,error,created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(300);
    data = legacy.data as typeof data;
    error = legacy.error;
  }
  return {
    data: (data ?? []).map((r) => normalizeOpenAIMessage(r as Record<string, unknown>)),
    error: error?.message ?? null,
  };
}

export async function insertOpenAIMessage(input: {
  conversation_id: string;
  role: "owner" | "agent";
  agent_ref: string | null;
  agent_name: string;
  content: string;
  dropbox_paths?: string[];
  reply_to?: ReplyToMeta | null;
  status?: "done" | "failed";
  error?: string | null;
}): Promise<{ data?: OpenAIMessage; error: string | null }> {
  const auth = await requireUserId();
  if (!auth.userId) return { error: auth.error };

  const baseRow = {
    conversation_id: input.conversation_id,
    owner_id: auth.userId,
    role: input.role,
    agent_ref: input.agent_ref,
    agent_name: input.agent_name,
    content: input.content,
    status: input.status ?? "done",
    error: input.error ?? null,
  };

  let { data, error } = await db
    .from("relay_openai_messages")
    .insert({
      ...baseRow,
      ...(input.dropbox_paths !== undefined ? { dropbox_paths: input.dropbox_paths } : {}),
      ...(input.reply_to !== undefined ? { reply_to: input.reply_to } : {}),
    })
    .select(
      "id,conversation_id,role,agent_ref,agent_name,content,dropbox_paths,reply_to,status,error,created_at",
    )
    .single();
  if (isMissingSchemaColumnError(error)) {
    const legacy = await db
      .from("relay_openai_messages")
      .insert(baseRow)
      .select("id,conversation_id,role,agent_ref,agent_name,content,status,error,created_at")
      .single();
    data = legacy.data as typeof data;
    error = legacy.error;
  }
  return {
    data: data ? normalizeOpenAIMessage(data as Record<string, unknown>) : undefined,
    error: error?.message ?? null,
  };
}
