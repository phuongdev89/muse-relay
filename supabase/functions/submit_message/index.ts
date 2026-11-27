import {
  adminClient,
  allowedOwnerId,
  corsHeaders,
  jsonResponse,
  recipientId,
  recipientIsKnown,
  signMessage,
  userClient,
  validateParams,
} from "../_shared/relay.ts";

const CLAIM_WINDOW_SECONDS = 30 * 60;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "unauthorized" }, 401);

  try {
    const supabase = userClient(authHeader);
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return jsonResponse({ error: "unauthorized" }, 401);

    const ownerAllowlist = allowedOwnerId();
    if (ownerAllowlist && user.id !== ownerAllowlist) {
      return jsonResponse({ error: "forbidden" }, 403);
    }

    const body = await req.json().catch(() => null) as
      | { recipient?: unknown; action?: unknown; params?: unknown }
      | null;
    if (!body) return jsonResponse({ error: "invalid_json" }, 400);

    const legacyRecipient = recipientId();
    let recipient = legacyRecipient;
    if (body.recipient !== undefined) {
      if (typeof body.recipient !== "string") {
        return jsonResponse({ error: "recipient_mismatch" }, 403);
      }
      recipient = body.recipient.trim().toLowerCase();
    }
    if (!(await recipientIsKnown(adminClient(), recipient))) {
      return jsonResponse({ error: "recipient_mismatch" }, 403);
    }

    const validated = validateParams(body.action, body.params, user.id);
    const id = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const expiresAtUnix = Math.floor(Date.now() / 1000) + CLAIM_WINDOW_SECONDS;
    const expiresAt = new Date(expiresAtUnix * 1000).toISOString();

    const signature = await signMessage({
      id,
      owner_id: user.id,
      recipient,
      action: validated.action,
      params: validated.params,
      nonce,
      expires_at_unix: expiresAtUnix,
    });

    const { error: insertError } = await adminClient()
      .from("relay_messages")
      .insert({
        id,
        owner_id: user.id,
        recipient,
        action: validated.action,
        params: validated.params,
        status: "pending",
        nonce,
        expires_at: expiresAt,
        expires_at_unix: expiresAtUnix,
        signature,
      });
    if (insertError) throw insertError;

    return new Response(
      JSON.stringify({ message_id: id, status: "pending", expires_at: expiresAt }),
      { status: 201, headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    const status = message.startsWith("Unknown param") ||
        message.includes("must be") ||
        message.includes("must stay")
      ? 400
      : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
