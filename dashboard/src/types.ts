// Shared domain types for the dashboard. These mirror the live Supabase
// schema — relay_messages / relay_results are production-frozen (Nyx), so
// treat every field here as read-only contract.

export type ActionMode = "chat" | "image" | "video";
export type MessageStatus = "pending" | "processing" | "done" | "failed";

export interface Muse {
  recipient: string;
  name: string;
  dropbox_root: string;
  created_at: string;
}

export interface MessageParams {
  prompt?: string;
  thread_id?: string | null;
  aspect_ratio?: string;
  count?: number;
  duration_seconds?: number;
  resource_type?: string;
  output_format?: string;
  reference_storage_paths?: string[];
}

export interface RelayMessage {
  id: string;
  recipient?: string;
  action: ActionMode;
  params: MessageParams;
  status: MessageStatus;
  attempts: number;
  created_at: string;
  expires_at: string | null;
  claim_expires_at: string | null;
}

export interface ResultOutput {
  dropbox_paths?: string[];
  notes?: string | null;
  text?: string | null;
}

export interface RelayResult {
  message_id: string;
  status: "done" | "failed";
  output: ResultOutput;
  error: string | null;
  created_at: string;
}

/** One owner request + its muse response (if any) — the chat thread unit. */
export interface ThreadItem {
  message: RelayMessage;
  result: RelayResult | null;
}

/** Fleet-wide activity entry used by Overview & Sidebar live statuses. */
export interface FleetActivityItem {
  recipient: string;
  message: RelayMessage;
  result: RelayResult | null;
}

export interface Group {
  id: string;
  name: string;
  created_at: string;
}

export interface GroupMember {
  group_id: string;
  muse_recipient: string;
  name: string;
}

export interface GroupPost {
  message_id: string;
  group_id: string;
  from_kind: "owner" | "muse";
  from_name: string;
  turn: number;
  batch_id: string;
  created_at: string;
}

export type BatchState = "pending" | "processing" | "done" | "failed";

/** One rendered group utterance (a whole fan-out batch), not one DB row. */
export interface GroupBubble {
  batchId: string;
  kind: "owner" | "muse";
  name: string;
  time: string;
  state: BatchState;
  /** owner utterance (prefix stripped) or muse reply text */
  text: string;
  paths: string[];
  notes: string | null;
  error: string | null;
}

export type ActiveRoom =
  | { kind: "overview" }
  | { kind: "muse"; recipient: string }
  | { kind: "group"; id: string }
  | null;
