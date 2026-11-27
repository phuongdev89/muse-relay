import type {
  ActionMode,
  Group,
  GroupBubble,
  GroupMember,
  GroupPost,
  MessageParams,
  Muse,
  RelayMessage,
  RelayResult,
  ThreadItem,
} from "../types";
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

// ---- muse registry ---------------------------------------------------------
// relay_muses is RLS owner-only: every call below runs as the signed-in owner,
// so the server independently scopes reads/writes to their own rows.

export async function listMuses(): Promise<{ data: Muse[]; error: string | null }> {
  const { data, error } = await db
    .from("relay_muses")
    .select("recipient,name,created_at")
    .order("created_at", { ascending: true });
  return { data: data ?? [], error: error?.message ?? null };
}

export async function createMuse(row: {
  owner_id: string;
  recipient: string;
  name: string;
  token_hash: string;
  dropbox_root: string;
}): Promise<string | null> {
  const { error } = await db.from("relay_muses").insert(row);
  return error?.message ?? null;
}

export async function renameMuse(
  recipient: string,
  name: string,
): Promise<string | null> {
  const { error } = await db
    .from("relay_muses")
    .update({ name })
    .eq("recipient", recipient);
  return error?.message ?? null;
}

export async function rotateMuseToken(
  recipient: string,
  tokenHash: string,
): Promise<string | null> {
  const { error } = await db
    .from("relay_muses")
    .update({ token_hash: tokenHash })
    .eq("recipient", recipient);
  return error?.message ?? null;
}

export async function deleteMuse(recipient: string): Promise<string | null> {
  // Group memberships first so no group keeps a dangling member, then the
  // registry row — deleting it revokes claim rights immediately (fail-closed).
  const { error: me } = await db
    .from("relay_group_members")
    .delete()
    .eq("muse_recipient", recipient);
  if (me) return me.message;
  const { error } = await db
    .from("relay_muses")
    .delete()
    .eq("recipient", recipient);
  return error?.message ?? null;
}

// ---- groups ----------------------------------------------------------------

export async function listGroups(): Promise<{
  groups: Group[];
  members: GroupMember[];
  error: string | null;
}> {
  const [{ data: gs, error: ge }, { data: ms, error: me }] = await Promise.all([
    db.from("relay_groups").select("id,name,created_at").order("created_at", { ascending: true }),
    db.from("relay_group_members").select("group_id,muse_recipient,name"),
  ]);
  const error = ge?.message ?? me?.message ?? null;
  return { groups: gs ?? [], members: ms ?? [], error };
}

export async function createGroup(
  name: string,
  members: { muse_recipient: string; name: string }[],
): Promise<{ id?: string; error: string | null }> {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { error: "phiên hết hạn — đăng nhập lại" };
  // RLS requires owner_id = auth.uid() on the row itself.
  const { data: g, error: ge } = await db
    .from("relay_groups")
    .insert({ name, owner_id: user.id })
    .select("id")
    .single();
  if (ge) return { error: ge.message };
  const { error: me } = await db
    .from("relay_group_members")
    .insert(members.map((m) => ({ ...m, group_id: g.id })));
  return me ? { error: me.message } : { id: g.id, error: null };
}

// ---- sending ---------------------------------------------------------------

export async function sendMessage(input: {
  recipient: string;
  action: ActionMode;
  params: MessageParams;
}): Promise<{ data: { message_id: string; expires_at: string } | null; error: string | null }> {
  const { data, error } = await db.functions.invoke("submit_message", {
    body: { recipient: input.recipient, action: input.action, params: input.params },
  });
  return { data: (data as never) ?? null, error: error?.message ?? null };
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
  return { error: error?.message ?? null };
}

// ---- muse thread (1:1 chat) ------------------------------------------------

export async function fetchMuseThread(recipient: string): Promise<{
  items: ThreadItem[];
  error: string | null;
}> {
  const msgs = await db
    .from("relay_messages")
    .select("id,action,params,status,attempts,created_at,expires_at,claim_expires_at")
    .eq("recipient", recipient)
    .order("created_at", { ascending: false })
    .limit(50);
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
      failedErr = results.get(r.id)?.error ?? "thất bại";
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
      if (state === "failed") error = result?.error ?? "thất bại";
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
