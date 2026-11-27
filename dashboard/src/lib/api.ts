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
  ThreadItem,
} from "../types";
import { MAX_UPLOAD_BYTES } from "./dropbox";
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
): Promise<{ id?: string; error: string | null }> {
  const auth = await requireUserId();
  if (!auth.userId) return { error: auth.error };
  // RLS requires owner_id = auth.uid() on the row itself.
  const { data: g, error: ge } = await db
    .from("relay_groups")
    .insert({ name, owner_id: auth.userId })
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

  // Clear direct-channel history without deleting messages scoped to Project Conversations.
  const [{ data: convs, error: convErr }, { data: msgs, error: msgErr }] = await Promise.all([
    db.from("relay_conversations").select("id"),
    db.from("relay_messages").select("id,params").eq("recipient", recipient),
  ]);
  if (convErr) return convErr.message;
  if (msgErr) return msgErr.message;

  const convIds = new Set((convs ?? []).map((c) => String(c.id)));
  const directIds = (msgs ?? [])
    .filter((m) => {
      const tid = (m.params as { thread_id?: unknown } | null)?.thread_id;
      return typeof tid !== "string" || !convIds.has(tid);
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
}): Promise<{ error: string | null }> {
  const { error } = await db.functions.invoke("submit_message", {
    body: {
      group_id: input.groupId,
      action: "chat",
      params: { prompt: input.prompt },
      owner_name: input.ownerName,
    },
  });
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

export async function fetchFleetActivity(limit = 80): Promise<{
  items: FleetActivityItem[];
  error: string | null;
}> {
  const msgs = await db
    .from("relay_messages")
    .select("id,recipient,action,params,status,attempts,created_at,expires_at,claim_expires_at")
    .order("created_at", { ascending: false })
    .limit(limit);
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
      message: m,
      result: byMessage.get(m.id) ?? null,
    })),
    error: null,
  };
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

export async function fetchGroupThread(groupId: string): Promise<{
  bubbles: GroupBubble[];
  error: string | null;
}> {
  const posts = await db
    .from("relay_group_posts")
    .select("message_id,from_kind,from_name,turn,batch_id,created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: true })
    .limit(400);
  if (posts.error) return { bubbles: [], error: posts.error.message };
  const postRows = (posts.data ?? []) as GroupPost[];
  if (postRows.length === 0) return { bubbles: [], error: null };

  const ids = [...new Set(postRows.map((p) => p.message_id))];
  const [{ data: msgs, error: me }, { data: results, error: re }] = await Promise.all([
    db.from("relay_messages").select("id,recipient,status,params,created_at").in("id", ids),
    db.from("relay_results").select("message_id,status,output,error,created_at").in("message_id", ids),
  ]);
  if (me) return { bubbles: [], error: me.message };
  if (re) return { bubbles: [], error: re.message };

  // Group bubbles only need a narrow slice of each message row.
  type MsgRow = { id: string; status: string; params: { prompt?: string } };
  const msgMap = new Map<string, MsgRow>((msgs ?? []).map((m) => [m.id, m as MsgRow]));
  const resMap = new Map<string, RelayResult>((results ?? []).map((r) => [r.message_id, r as RelayResult]));

  const seen = new Set<string>();
  const bubbles: GroupBubble[] = [];
  for (const p of postRows) {
    if (seen.has(p.batch_id)) continue;
    seen.add(p.batch_id);
    const rows = postRows
      .filter((q) => q.batch_id === p.batch_id)
      .map((q) => msgMap.get(q.message_id))
      .filter((m): m is RelayMessage => Boolean(m));
    const first = rows[0];
    const result = first ? resMap.get(first.id) ?? null : null;

    let text = "";
    let paths: string[] = [];
    let notes: string | null = null;
    let error: string | null = null;
    let state: GroupBubble["state"];

    if (p.from_kind === "owner") {
      text = (first?.params?.prompt ?? "").replace(/^\[[^\]]+\]:\s*/, "");
      const b = batchState(rows, resMap);
      state = b.state;
      error = b.state === "failed" ? b.error : null;
    } else {
      const st = first?.status ?? "pending";
      state = st === "failed" ? "failed" : st === "processing" ? "processing" : st === "pending" ? "pending" : "done";
      if (state === "done" && result?.output?.text) text = result.output.text;
      if (state === "failed") error = result?.error ?? tNow("api.failed");
      notes = result?.output?.notes ?? null;
      paths = result?.output?.dropbox_paths ?? [];
    }
    bubbles.push({
      batchId: p.batch_id,
      kind: p.from_kind,
      name: p.from_name,
      time: p.created_at,
      state,
      text,
      paths,
      notes,
      error,
    });
  }
  return { bubbles, error: null };
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
    case "timeout_20s":
      return tNow("api.timeout20");
    case "timeout_60s":
      return tNow("api.timeout60");
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
  const timeout = setTimeout(() => controller.abort(), 25000);
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
      return { ok: false, latencyMs, error: tNow("api.timeout20") };
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

export async function callOpenAIChatCompletion(
  agent: Pick<OpenAIAgent, "id">,
  history: OpenAIChatHistoryTurn[],
  prompt: string,
  signal?: AbortSignal,
): Promise<{ content?: string; error?: string }> {
  const jwt = await getOwnerJwt();
  if (!jwt) {
    return { error: tNow("api.sessionExpired") };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75000);
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
      return { error: tNow("api.timeout60") };
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
    created_at: String(row.created_at),
  };
}

export async function listConversations(): Promise<{
  data: Conversation[];
  error: string | null;
}> {
  const { data, error } = await db
    .from("relay_conversations")
    .select("id,project_id,title,mode,group_id,participants,created_at")
    .order("created_at", { ascending: true });
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

  const { data, error } = await db
    .from("relay_conversations")
    .insert({
      project_id: input.project_id,
      owner_id: auth.userId,
      title: input.title,
      mode: input.mode,
      group_id: input.group_id,
      participants: input.participants,
    })
    .select("id,project_id,title,mode,group_id,participants,created_at")
    .single();
  if (error || !data) return { error: error?.message ?? tNow("api.createConvFailed") };
  return { data: normalizeConversation(data as Record<string, unknown>), error: null };
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

export async function fetchOpenAIMessages(conversationId: string): Promise<{
  data: OpenAIMessage[];
  error: string | null;
}> {
  const { data, error } = await db
    .from("relay_openai_messages")
    .select("id,conversation_id,role,agent_ref,agent_name,content,status,error,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(300);
  return { data: (data ?? []) as OpenAIMessage[], error: error?.message ?? null };
}

export async function insertOpenAIMessage(input: {
  conversation_id: string;
  role: "owner" | "agent";
  agent_ref: string | null;
  agent_name: string;
  content: string;
  status?: "done" | "failed";
  error?: string | null;
}): Promise<{ data?: OpenAIMessage; error: string | null }> {
  const auth = await requireUserId();
  if (!auth.userId) return { error: auth.error };

  const { data, error } = await db
    .from("relay_openai_messages")
    .insert({
      conversation_id: input.conversation_id,
      owner_id: auth.userId,
      role: input.role,
      agent_ref: input.agent_ref,
      agent_name: input.agent_name,
      content: input.content,
      status: input.status ?? "done",
      error: input.error ?? null,
    })
    .select("id,conversation_id,role,agent_ref,agent_name,content,status,error,created_at")
    .single();
  return { data: data as OpenAIMessage | undefined, error: error?.message ?? null };
}
