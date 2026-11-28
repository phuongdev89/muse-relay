// Shared domain types for the dashboard. These mirror the live Supabase
// schema — relay_messages / relay_results are production-frozen (Nyx), so
// treat every field here as read-only contract.

export type ActionMode = "chat" | "image" | "video";
export type MessageStatus = "pending" | "processing" | "done" | "failed";

export interface Muse {
  recipient: string;
  name: string;
  dropbox_root: string;
  email_owner?: string | null;
  /** direct-channel routing gates (UI-only; see relay_muses cap_* columns) */
  cap_chat: boolean;
  cap_image: boolean;
  cap_video: boolean;
  setup_done: boolean;
  first_connected_at: string | null;
  last_claim_at: string | null;
  last_result_at: string | null;
  token_rotated_at: string | null;
  created_at: string;
}

export interface MessageParams {
  prompt?: string;
  /** v9 control commands ride in params (e.g. "usage" → /usage quota check). */
  command?: string;
  thread_id?: string | null;
  aspect_ratio?: string;
  count?: number;
  duration_seconds?: number;
  resource_type?: string;
  output_format?: string;
  reference_storage_paths?: string[];
  reference_dropbox_paths?: string[];
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
  /** Muse→Muse copy bridge: copies delivered into the recipient muse's root
   * (fan-out row params.reference_dropbox_paths), visible/downloadable by the
   * owner through the shared-folder hub. Empty for owner utterances. */
  refPaths: string[];
  notes: string | null;
  error: string | null;
}

// ---- v7: OpenAI Compatible Agents, Projects & Conversations ----------------

export type AgentKind = "muse" | "openai";

export interface OpenAIAgent {
  id: string;
  owner_id?: string;
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  system_prompt: string;
  created_at: string;
}

export interface Project {
  id: string;
  owner_id?: string;
  name: string;
  description: string;
  created_at: string;
}

export interface ProjectAgent {
  id: string;
  project_id: string;
  owner_id?: string;
  agent_kind: AgentKind;
  agent_ref: string;
  agent_name: string;
  created_at: string;
}

export type ConversationMode = "muse_single" | "muse_group" | "openai" | "mixed";

export interface ConversationParticipant {
  kind: AgentKind;
  ref: string;
  name: string;
}

export interface Conversation {
  id: string;
  project_id: string;
  owner_id?: string;
  title: string;
  mode: ConversationMode;
  group_id: string | null;
  participants: ConversationParticipant[];
  created_at: string;
}

export interface OpenAIMessage {
  id: string;
  conversation_id: string;
  owner_id?: string;
  role: "owner" | "agent";
  agent_ref: string | null;
  agent_name: string;
  content: string;
  status: "done" | "failed";
  error: string | null;
  created_at: string;
}

export type ActiveRoom =
  | { kind: "overview" }
  | { kind: "agents" }
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; projectId: string; conversationId: string }
  | { kind: "muse"; recipient: string }
  | null;
