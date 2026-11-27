import {
  adminClient,
  allowedOwnerId,
  corsHeaders,
  fanoutGroupMessage,
  jsonResponse,
  resolveRecipientRoot,
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
      | { recipient?: unknown; action?: unknown; params?: unknown; group_id?: unknown; owner_name?: unknown }
      | null;
    if (!body) return jsonResponse({ error: "invalid_json" }, 400);

    // ---- v6 group path: body.group_id addresses an owner-initiated group.
    // The utterance fans out as one ordinary pending `chat` row per member —
    // muses see the exact same claim shape as any other request. When
    // group_id is absent, the legacy single-recipient path below runs
    // unchanged.
    if (body.group_id !== undefined) {
      if (typeof body.group_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.group_id)) {
        return jsonResponse({ error: "group_id must be a UUID" }, 400);
      }
      if (body.action !== "chat") {
        return jsonResponse({ error: "group messages must use action 'chat'" }, 400);
      }
      const { data: group, error: groupError } = await adminClient()
        .from("relay_groups")
        .select("id")
        .eq("id", body.group_id)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (groupError) throw groupError;
      if (!group) return jsonResponse({ error: "group_not_found" }, 404);

      let ownerName = "Owner";
      if (body.owner_name !== undefined) {
        if (typeof body.owner_name !== "string" || body.owner_name.trim().length < 1 || body.owner_name.trim().length > 64) {
          return jsonResponse({ error: "owner_name must be a string of 1-64 characters" }, 400);
        }
        ownerName = body.owner_name.trim();
      }

      const validated = validateParams("chat", body.params, user.id);
      const { data: members, error: membersError } = await adminClient()
        .from("relay_group_members")
        .select("muse_recipient, name")
        .eq("group_id", body.group_id);
      if (membersError) throw membersError;
      const targets = (members ?? []).map((m) => ({
        recipient: String(m.muse_recipient).toLowerCase(),
        name: String(m.name),
      }));
      if (targets.length < 1) {
        return jsonResponse({ error: "group_has_no_members" }, 400);
      }

      const fanout = await fanoutGroupMessage(adminClient(), {
        groupId: String(group.id),
        ownerId: user.id,
        fromKind: "owner",
        fromName: ownerName,
        turn: 1,
        utterance: String(validated.params.prompt),
        targets,
      });
      return new Response(
        JSON.stringify({
          group_id: String(group.id),
          message_ids: fanout.messageIds,
          status: "pending",
          expires_at: fanout.expiresAt,
        }),
        { status: 201, headers: { ...corsHeaders, "content-type": "application/json" } },
      );
    }

    // Every request must address its recipient explicitly — there is no
    // default muse. Unregistered recipients and registry lookup failures are
    // rejected (fail-closed).
    if (typeof body.recipient !== "string" || body.recipient.trim().length < 1) {
      return jsonResponse({ error: "recipient is required" }, 400);
    }
    const recipient = body.recipient.trim().toLowerCase();
    const dropboxRoot = await resolveRecipientRoot(adminClient(), recipient);
    if (!dropboxRoot) {
      return jsonResponse({ error: "recipient_mismatch" }, 403);
    }

    const validated = validateParams(body.action, body.params, user.id);
    const refDropboxPaths = validated.params["reference_dropbox_paths"];
    if (Array.isArray(refDropboxPaths)) {
      for (const p of refDropboxPaths) {
        if (typeof p !== "string" || !p.startsWith(dropboxRoot)) {
          throw new Error(`reference_dropbox_paths must stay under ${dropboxRoot}`);
        }
      }
    }
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
