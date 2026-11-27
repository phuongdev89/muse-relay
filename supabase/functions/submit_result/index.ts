import {
  adminClient,
  jsonResponse,
  resolveMuse,
  validateResultBody,
} from "../_shared/relay.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const muse = await resolveMuse(req);
  if (!muse) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  try {
    const body = await req.json().catch(() => null);
    const result = validateResultBody(body, muse.dropboxRoot);
    const supabase = adminClient();

    const { data: message, error: selectError } = await supabase
      .from("relay_messages")
      .select("id, owner_id, recipient, action, status, claim_id, claim_expires_at")
      .eq("id", result.message_id)
      .maybeSingle();
    if (selectError) throw selectError;
    if (!message) return jsonResponse({ error: "message_not_found" }, 404);
    if (message.recipient !== muse.recipient) {
      return jsonResponse({ error: "recipient_mismatch" }, 403);
    }
    if (message.status !== "processing" || message.claim_id !== result.claim_id) {
      return jsonResponse({ error: "claim_mismatch" }, 409);
    }
    if (
      message.claim_expires_at &&
      new Date(message.claim_expires_at).getTime() < Date.now()
    ) {
      return jsonResponse({ error: "claim_expired" }, 409);
    }
    if (result.status === "done" && message.action === "chat") {
      const text = result.output["text"];
      if (typeof text !== "string" || text.trim().length < 1) {
        return jsonResponse({ error: "chat result text is required" }, 400);
      }
    }
    if (
      result.status === "done" &&
      (message.action === "image" || message.action === "video")
    ) {
      const paths = result.output["dropbox_paths"];
      if (!Array.isArray(paths) || paths.length < 1) {
        return jsonResponse({ error: "media result dropbox_paths is required" }, 400);
      }
    }

    const { error: insertError } = await supabase.from("relay_results").insert({
      message_id: result.message_id,
      owner_id: message.owner_id,
      status: result.status,
      output: result.output,
      error: result.error,
    });
    if (insertError) {
      if (insertError.code === "23505") {
        return jsonResponse({ error: "result_already_exists" }, 409);
      }
      throw insertError;
    }

    const { error: updateError } = await supabase
      .from("relay_messages")
      .update({
        status: result.status,
        completed_at: new Date().toISOString(),
        claim_expires_at: null,
      })
      .eq("id", result.message_id)
      .eq("claim_id", result.claim_id)
      .eq("status", "processing");
    if (updateError) throw updateError;

    return jsonResponse({ ok: true, message_id: result.message_id, status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    const status = message.includes("must be") || message.includes("must stay") ||
        message.includes("is required") || message.startsWith("Unknown param")
      ? 400
      : 500;
    return jsonResponse({ error: message }, status);
  }
});
