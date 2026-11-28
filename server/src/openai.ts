import type { Request, Response } from "express";
import { getOwnerAuth } from "./auth.js";
import {
  downloadDropboxBuffer,
  fetchDropboxTempLink,
  isDropboxConfigured,
  validateDropboxPath,
} from "./dropbox.js";
import { env } from "./env.js";
import { supabaseRestSelectSingle } from "./supabase.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS_PER_FILE = 24_000;
const MAX_TEXT_CHARS_TOTAL = 60_000;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".ts",
  ".tsx",
  ".js",
  ".py",
  ".sql",
  ".log",
]);

interface OpenAIAgentRow {
  base_url?: unknown;
  model?: unknown;
  api_key?: unknown;
  system_prompt?: unknown;
}

interface ConversationRow {
  id?: unknown;
  title?: unknown;
  mode?: unknown;
  group_id?: unknown;
  participants?: unknown;
  system_prompt?: unknown;
}

interface GroupRow {
  name?: unknown;
  rules?: unknown;
}

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

function normalizeChatCompletionsUrl(baseUrl: string): string | null {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (!clean) return null;
  const target = clean.toLowerCase().endsWith("/chat/completions")
    ? clean
    : `${clean}/chat/completions`;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractCompletionContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const msg = (choices[0] as { message?: { content?: unknown } } | undefined)
    ?.message;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

function hasValidChoices(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const choices = (payload as { choices?: unknown }).choices;
  return Array.isArray(choices) && choices.length > 0;
}

function formatOpenAIHttpError(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const msg =
      typeof parsed?.error?.message === "string"
        ? parsed.error.message
        : typeof parsed?.message === "string"
          ? parsed.message
          : "";
    if (msg) return `HTTP ${status}: ${msg}`;
  } catch {
    // ignore non-JSON upstream error body
  }
  const snippet = bodyText.trim().slice(0, 180);
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Parses a chat-completions response body tolerantly. Some OpenAI-compatible
 * backends append SSE terminators (`data: [DONE]`) or PHP notices AFTER an
 * otherwise-valid JSON object, which breaks plain JSON.parse — so fall back to
 * extracting the first balanced `{...}` object from the raw text.
 */
function parseCompletionPayload(
  rawText: string,
): { ok: true; value: unknown } | { ok: false } {
  const cleaned = rawText.replace(/^\uFEFF/, "").trim();
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    // fall through to first-object extraction
  }
  const start = cleaned.indexOf("{");
  if (start === -1) return { ok: false };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(cleaned.slice(start, i + 1)) };
        } catch {
          return { ok: false };
        }
      }
    }
  }
  return { ok: false };
}

async function fetchOpenAIAgentById(
  agentId: string,
  jwt: string,
): Promise<{ row: OpenAIAgentRow | null; status: number; error?: string }> {
  const query =
    `relay_agents_openai?select=base_url,model,api_key,system_prompt` +
    `&id=eq.${encodeURIComponent(agentId)}`;
  const res = await supabaseRestSelectSingle<OpenAIAgentRow>(query, jwt);
  return { row: res.data, status: res.status, error: res.error };
}

/**
 * `POST /api/openai/test`
 * Tests connectivity to an OpenAI-compatible `/chat/completions` endpoint from
 * the backend server (avoiding browser CORS limits and never exposing API keys).
 */
export async function handleOpenAITest(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    agent_id?: unknown;
    base_url?: unknown;
    model?: unknown;
    api_key?: unknown;
  };

  const agentId = nonEmptyString(body.agent_id);
  let baseUrl = nonEmptyString(body.base_url);
  let model = nonEmptyString(body.model);
  let apiKey = nonEmptyString(body.api_key);

  if (agentId && (!baseUrl || !apiKey || !model)) {
    if (!UUID_RE.test(agentId)) {
      res.status(400).json({ ok: false, latencyMs: 0, error: "invalid_agent_id" });
      return;
    }
    const auth = getOwnerAuth(req);
    const lookup = await fetchOpenAIAgentById(agentId, auth.jwt);
    if (lookup.error) {
      res
        .status(502)
        .json({ ok: false, latencyMs: 0, error: "supabase_lookup_failed" });
      return;
    }
    if (!lookup.row) {
      res.status(404).json({ ok: false, latencyMs: 0, error: "agent_not_found" });
      return;
    }
    baseUrl ??= nonEmptyString(lookup.row.base_url);
    model ??= nonEmptyString(lookup.row.model);
    apiKey ??= nonEmptyString(lookup.row.api_key);
  }

  if (!baseUrl || !model || !apiKey) {
    res
      .status(400)
      .json({ ok: false, latencyMs: 0, error: "missing_agent_config" });
    return;
  }

  const targetUrl = normalizeChatCompletionsUrl(baseUrl);
  if (!targetUrl) {
    res.status(400).json({ ok: false, latencyMs: 0, error: "invalid_base_url" });
    return;
  }

  const started = performance.now();
  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 16,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const latencyMs = Math.round(performance.now() - started);
    const rawText = await upstream.text();
    if (!upstream.ok) {
      res.json({
        ok: false,
        latencyMs,
        error: formatOpenAIHttpError(upstream.status, rawText),
      });
      return;
    }

    const parsedResult = parseCompletionPayload(rawText);
    if (!parsedResult.ok) {
      const snippet = rawText.trim().slice(0, 120);
      res.json({
        ok: false,
        latencyMs,
        error: snippet
          ? `invalid_json_response: ${snippet}`
          : "invalid_json_response",
      });
      return;
    }
    const parsed = parsedResult.value;

    if (!hasValidChoices(parsed)) {
      res.json({ ok: false, latencyMs, error: "empty_choices" });
      return;
    }

    const reply = extractCompletionContent(parsed).trim() || "OK";
    res.json({ ok: true, latencyMs, reply, error: null });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    if (isTimeout) {
      console.error(
        `openai test timeout after 45s: host=${new URL(targetUrl).host} model=${model}`,
      );
    }
    res.json({
      ok: false,
      latencyMs,
      error: isTimeout
        ? "timeout_45s"
        : err instanceof Error
          ? err.message
          : "upstream_request_failed",
    });
  }
}

function parseChatMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) return null;
    if (typeof content !== "string") return null;
    out.push({
      role: role as ChatMessage["role"],
      content,
    });
  }
  return out;
}

function parseAttachmentDropboxPaths(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) return null;
  const out: string[] = [];
  for (const item of raw) {
    const valid = validateDropboxPath(item);
    if (!valid) return null;
    out.push(valid);
  }
  return out;
}

function getLowerExtension(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function decodeUtf8TextIfNonBinary(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(buffer);
  } catch {
    return null;
  }
}

async function formatTempLinkNote(
  dbxPath: string,
  fallbackName: string,
): Promise<string> {
  try {
    const meta = await fetchDropboxTempLink(dbxPath);
    const sizeLabel = meta.size !== null ? ` (${meta.size} bytes)` : "";
    return `[Attachment: ${meta.name}${sizeLabel} — download link: ${meta.link}]`;
  } catch {
    return `[Attachment: ${fallbackName} (Dropbox path: ${dbxPath}; temporary link unavailable)]`;
  }
}

async function hydrateAttachmentsIntoLastUserMessage(
  messages: ChatMessage[],
  attachmentPaths: string[],
): Promise<ChatMessage[]> {
  if (attachmentPaths.length === 0 || !isDropboxConfigured()) {
    return messages;
  }

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;

  const textNotes: string[] = [];
  const imageParts: ChatContentPart[] = [];
  let remainingTextBudget = MAX_TEXT_CHARS_TOTAL;

  for (const dbxPath of attachmentPaths) {
    const ext = getLowerExtension(dbxPath);
    const fallbackName = dbxPath.split("/").pop() ?? dbxPath;
    const imageMime = IMAGE_MIME_BY_EXT[ext];

    if (imageMime) {
      try {
        const dl = await downloadDropboxBuffer(dbxPath, MAX_IMAGE_BYTES);
        const dataUri = `data:${imageMime};base64,${dl.buffer.toString("base64")}`;
        imageParts.push({ type: "image_url", image_url: { url: dataUri } });
      } catch {
        textNotes.push(await formatTempLinkNote(dbxPath, fallbackName));
      }
      continue;
    }

    if (TEXT_EXTS.has(ext)) {
      let handledAsText = false;
      try {
        const dl = await downloadDropboxBuffer(dbxPath, MAX_TEXT_BYTES);
        const decoded = decodeUtf8TextIfNonBinary(dl.buffer);
        if (decoded !== null && remainingTextBudget > 0) {
          const maxForFile = Math.min(MAX_TEXT_CHARS_PER_FILE, remainingTextBudget);
          const snippet =
            decoded.length > maxForFile
              ? `${decoded.slice(0, maxForFile)}\n... [truncated, ${decoded.length} total chars]`
              : decoded;
          remainingTextBudget -= Math.min(decoded.length, maxForFile);
          textNotes.push(
            `[File: ${dl.name} (${dl.size} bytes)]\n\`\`\`\n${snippet}\n\`\`\``,
          );
          handledAsText = true;
        }
      } catch {
        // Fall through to temp link fallback when oversized or download fails.
      }
      if (!handledAsText) {
        textNotes.push(await formatTempLinkNote(dbxPath, fallbackName));
      }
      continue;
    }

    textNotes.push(await formatTempLinkNote(dbxPath, fallbackName));
  }

  if (textNotes.length === 0 && imageParts.length === 0) {
    return messages;
  }

  const nextMessages = [...messages];
  const target = nextMessages[lastUserIdx];
  if (!target) return messages;
  const origText = typeof target.content === "string" ? target.content : "";
  const combinedText =
    textNotes.length > 0
      ? origText
        ? `${origText}\n\n${textNotes.join("\n\n")}`
        : textNotes.join("\n\n")
      : origText;

  nextMessages[lastUserIdx] =
    imageParts.length > 0
      ? {
          role: "user",
          content: [{ type: "text", text: combinedText }, ...imageParts],
        }
      : { role: "user", content: combinedText };

  return nextMessages;
}

function buildRosterNote(
  conv: ConversationRow,
  group: GroupRow | null,
): string | undefined {
  const parts: string[] = [];
  const label = nonEmptyString(group?.name) ?? nonEmptyString(conv.title);
  const mode = nonEmptyString(conv.mode);
  if (label) {
    parts.push(`Conversation "${label}"${mode ? ` (mode: ${mode})` : ""}.`);
  }

  const rawParticipants = Array.isArray(conv.participants)
    ? conv.participants
    : [];
  const participantLabels = rawParticipants
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const p = entry as { kind?: unknown; name?: unknown };
      const name = nonEmptyString(p.name);
      if (!name) return null;
      const kind =
        p.kind === "muse"
          ? "Muse"
          : p.kind === "openai"
            ? "Direct API"
            : "Agent";
      return `${name} (${kind})`;
    })
    .filter((item): item is string => item !== null);

  if (participantLabels.length > 0) {
    parts.push(
      `Participants alongside ${env.ownerDisplayName}: ${participantLabels.join(", ")}.`,
    );
  }

  const groupRules = nonEmptyString(group?.rules);
  if (groupRules) {
    parts.push(
      `Group system prompt:\n${groupRules}\nNote: You are a Direct API collaborator in this conversation; do not prepend "[Name]:" or rely on "@Name" tags to trigger Muse agents.`,
    );
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * `POST /api/openai/chat`
 * Proxies a non-streaming chat completion for a registered `relay_agents_openai`
 * agent, combining its `system_prompt` with optional conversation context and
 * hydrated Dropbox attachments.
 */
export async function handleOpenAIChat(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    agent_id?: unknown;
    messages?: unknown;
    conversation_id?: unknown;
    attachment_dropbox_paths?: unknown;
  };

  const agentId = nonEmptyString(body.agent_id);
  if (!agentId || !UUID_RE.test(agentId)) {
    res.status(400).json({ error: "invalid_agent_id" });
    return;
  }

  const messages = parseChatMessages(body.messages);
  if (!messages) {
    res.status(400).json({ error: "invalid_messages" });
    return;
  }

  let conversationId: string | undefined;
  if (body.conversation_id !== undefined && body.conversation_id !== null) {
    const rawConvId = nonEmptyString(body.conversation_id);
    if (!rawConvId || !UUID_RE.test(rawConvId)) {
      res.status(400).json({ error: "invalid_conversation_id" });
      return;
    }
    conversationId = rawConvId;
  }

  const attachmentPaths = parseAttachmentDropboxPaths(
    body.attachment_dropbox_paths,
  );
  if (attachmentPaths === null) {
    res.status(400).json({ error: "invalid_attachment_dropbox_paths" });
    return;
  }

  const auth = getOwnerAuth(req);
  const lookup = await fetchOpenAIAgentById(agentId, auth.jwt);
  if (lookup.error) {
    res.status(502).json({ error: "supabase_lookup_failed" });
    return;
  }
  if (!lookup.row) {
    res.status(404).json({ error: "agent_not_found" });
    return;
  }

  const baseUrl = nonEmptyString(lookup.row.base_url);
  const model = nonEmptyString(lookup.row.model);
  const apiKey = nonEmptyString(lookup.row.api_key);
  const agentSystemPrompt = nonEmptyString(lookup.row.system_prompt);

  if (!baseUrl || !model || !apiKey) {
    res.status(400).json({ error: "incomplete_agent_config" });
    return;
  }

  const targetUrl = normalizeChatCompletionsUrl(baseUrl);
  if (!targetUrl) {
    res.status(400).json({ error: "invalid_base_url" });
    return;
  }

  let sharedConvPrompt: string | undefined;
  let rosterNote: string | undefined;
  if (conversationId) {
    const convQuery =
      `relay_conversations?select=id,title,mode,group_id,participants,system_prompt` +
      `&id=eq.${encodeURIComponent(conversationId)}`;
    let convRes = await supabaseRestSelectSingle<ConversationRow>(
      convQuery,
      auth.jwt,
    );
    if (convRes.error && convRes.status === 400) {
      const legacyQuery =
        `relay_conversations?select=id,title,mode,group_id,participants` +
        `&id=eq.${encodeURIComponent(conversationId)}`;
      convRes = await supabaseRestSelectSingle<ConversationRow>(
        legacyQuery,
        auth.jwt,
      );
    }
    if (convRes.error) {
      res.status(502).json({ error: "supabase_lookup_failed" });
      return;
    }
    if (!convRes.data) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }
    sharedConvPrompt = nonEmptyString(convRes.data.system_prompt);

    let groupRow: GroupRow | null = null;
    const groupId = nonEmptyString(convRes.data.group_id);
    if (groupId && UUID_RE.test(groupId)) {
      const groupQuery =
        `relay_groups?select=name,rules&id=eq.${encodeURIComponent(groupId)}`;
      const groupRes = await supabaseRestSelectSingle<GroupRow>(
        groupQuery,
        auth.jwt,
      );
      if (!groupRes.error && groupRes.data) {
        groupRow = groupRes.data;
      }
    }
    rosterNote = buildRosterNote(convRes.data, groupRow);
  }

  const combinedSystemPrompt = [
    agentSystemPrompt,
    sharedConvPrompt,
    rosterNote,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const hydratedMessages = await hydrateAttachmentsIntoLastUserMessage(
    messages,
    attachmentPaths,
  );

  const finalMessages: ChatMessage[] = combinedSystemPrompt
    ? [{ role: "system", content: combinedSystemPrompt }, ...hydratedMessages]
    : hydratedMessages;

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: finalMessages,
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });

    const rawText = await upstream.text();
    if (!upstream.ok) {
      res.status(502).json({
        content: null,
        error: formatOpenAIHttpError(upstream.status, rawText),
      });
      return;
    }

    const parsedResult = parseCompletionPayload(rawText);
    if (!parsedResult.ok) {
      const snippet = rawText.trim().slice(0, 120);
      res.status(502).json({
        content: null,
        error: snippet
          ? `invalid_json_response: ${snippet}`
          : "invalid_json_response",
      });
      return;
    }
    const parsed = parsedResult.value;

    const content = extractCompletionContent(parsed);
    if (!content.trim()) {
      res.status(502).json({ content: null, error: "empty_reply" });
      return;
    }

    res.json({ content, error: null });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    if (isTimeout) {
      console.error(
        `openai chat timeout after 180s: host=${new URL(targetUrl).host} model=${model}`,
      );
    }
    res.status(502).json({
      content: null,
      error: isTimeout
        ? "timeout_180s"
        : err instanceof Error
          ? err.message
          : "upstream_request_failed",
    });
  }
}
