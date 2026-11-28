import type { Request, Response } from "express";
import { getOwnerAuth } from "./auth.js";
import { supabaseRestSelectSingle } from "./supabase.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

interface OpenAIAgentRow {
  base_url?: unknown;
  model?: unknown;
  api_key?: unknown;
  system_prompt?: unknown;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

/**
 * `POST /api/openai/chat`
 * Proxies a non-streaming chat completion for a registered `relay_agents_openai`
 * agent, prepending its configured `system_prompt` server-side.
 */
export async function handleOpenAIChat(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    agent_id?: unknown;
    messages?: unknown;
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
  const systemPrompt = nonEmptyString(lookup.row.system_prompt);

  if (!baseUrl || !model || !apiKey) {
    res.status(400).json({ error: "incomplete_agent_config" });
    return;
  }

  const targetUrl = normalizeChatCompletionsUrl(baseUrl);
  if (!targetUrl) {
    res.status(400).json({ error: "invalid_base_url" });
    return;
  }

  const finalMessages: ChatMessage[] = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...messages]
    : messages;

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
