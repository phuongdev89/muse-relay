import {
  adminClient,
  allowedOwnerId,
  buildGroupRules,
  corsHeaders,
  fanoutGroupMessage,
  jsonResponse,
  parseMentionTargets,
  type ReplyToMeta,
  resolveRecipientRoot,
  signMessage,
  truncateUtterance,
  userClient,
  validateParams,
} from "../_shared/relay.ts";

const CLAIM_WINDOW_SECONDS = 30 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDropboxPath(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length >= 2 &&
    raw.length <= 512 &&
    raw.startsWith("/") &&
    !raw.includes("..") &&
    !raw.includes("\\") &&
    !raw.includes("\0") &&
    !raw.includes("\r") &&
    !raw.includes("\n")
  );
}

function parseReferenceDropboxPathsByRecipient(
  raw: unknown,
): Record<string, string[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("reference_dropbox_paths_by_recipient must be an object");
  }
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!UUID_RE.test(key)) {
      throw new Error("reference_dropbox_paths_by_recipient keys must be UUIDs");
    }
    if (!Array.isArray(value) || value.length > 4) {
      throw new Error("reference_dropbox_paths_by_recipient values must be arrays of at most 4 paths");
    }
    const paths: string[] = [];
    for (const item of value) {
      if (!isValidDropboxPath(item)) {
        throw new Error("reference_dropbox_paths_by_recipient items must be valid Dropbox paths");
      }
      paths.push(item);
    }
    out[key.toLowerCase()] = paths;
  }
  return out;
}

function prependReplyQuote(prompt: string, replyTo: ReplyToMeta | undefined): string {
  if (!replyTo) return prompt;
  return `[Replying to ${replyTo.sender}: "${replyTo.excerpt}"]\n${prompt}`;
}

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
      | {
        recipient?: unknown;
        action?: unknown;
        params?: unknown;
        group_id?: unknown;
        owner_name?: unknown;
        reference_dropbox_paths_by_recipient?: unknown;
      }
      | null;
    if (!body) return jsonResponse({ error: "invalid_json" }, 400);

    // ---- v6 group path: body.group_id addresses an owner-initiated group.
    // v8 mention routing: the utterance reaches exactly the members it
    // mentions (@Name / @all). With no valid mention the utterance is still
    // recorded in the group timeline but wakes NO muse: one `done` row
    // addressed to the owner itself (claim_message only returns pending rows
    // matching a muse recipient). When group_id is absent, the legacy
    // single-recipient path below runs unchanged.
    if (body.group_id !== undefined) {
      if (typeof body.group_id !== "string" || !UUID_RE.test(body.group_id)) {
        return jsonResponse({ error: "group_id must be a UUID" }, 400);
      }
      if (body.action !== "chat") {
        return jsonResponse({ error: "group messages must use action 'chat'" }, 400);
      }
      const { data: group, error: groupError } = await adminClient()
        .from("relay_groups")
        .select("id, name, rules")
        .eq("id", body.group_id)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (groupError) throw groupError;
      if (!group) return jsonResponse({ error: "group_not_found" }, 404);
      const groupId = String(group.id);

      let ownerName = "Owner";
      if (body.owner_name !== undefined) {
        if (typeof body.owner_name !== "string" || body.owner_name.trim().length < 1 || body.owner_name.trim().length > 64) {
          return jsonResponse({ error: "owner_name must be a string of 1-64 characters" }, 400);
        }
        ownerName = body.owner_name.trim();
      }

      const validated = validateParams("chat", body.params, user.id);
      const byRecipientMap = parseReferenceDropboxPathsByRecipient(
        body.reference_dropbox_paths_by_recipient,
      );
      const rawUtterance = String(validated.params.prompt);
      const { data: members, error: membersError } = await adminClient()
        .from("relay_group_members")
        .select("muse_recipient, name")
        .eq("group_id", groupId);
      if (membersError) throw membersError;
      if ((members ?? []).length < 1) {
        return jsonResponse({ error: "group_has_no_members" }, 400);
      }

      // v9 group regulation (system prompt): generated once at the group's
      // first send and stored on relay_groups.rules. `rules is null` keeps the
      // write idempotent under concurrent first messages; pre-existing groups
      // get their rules on the first send after this deploy. Best-effort:
      // claim-side context tolerates a missing rules text, so a storage
      // failure must not block the utterance.
      if (typeof group.rules !== "string" || group.rules.length < 1) {
        try {
          const { data: convRow } = await adminClient()
            .from("relay_conversations")
            .select("participants")
            .eq("group_id", groupId)
            .maybeSingle();
          const rawParticipants = Array.isArray(convRow?.participants)
            ? convRow.participants
            : [];
          const externalAgents = rawParticipants
            .filter(
              (p): p is { kind?: unknown; name?: unknown } =>
                typeof p === "object" && p !== null &&
                (p as { kind?: unknown }).kind === "openai" &&
                typeof (p as { name?: unknown }).name === "string" &&
                (p as { name: string }).name.trim().length > 0,
            )
            .map((p) => ({ name: String(p.name).trim() }));
          const rules = buildGroupRules(
            String(group.name),
            members ?? [],
            externalAgents,
          );
          const updateQuery = adminClient()
            .from("relay_groups")
            .update({ rules })
            .eq("id", groupId);
          const { error: rulesError } = group.rules == null
            ? await updateQuery.is("rules", null)
            : await updateQuery.eq("rules", "");
          if (rulesError) throw rulesError;
        } catch (rulesError) {
          console.error("group rules generation failed:", rulesError);
        }
      }

      // Mention routing runs ONLY on rawUtterance so a @Name inside reply_to
      // excerpt or sender never wakes an unintended agent.
      const targets = parseMentionTargets(rawUtterance, members ?? [], null);
      const replyTo = validated.params.reply_to as ReplyToMeta | undefined;
      const formattedUtterance = prependReplyQuote(rawUtterance, replyTo);

      if (targets.length > 0) {
        const globalRefs = Array.isArray(validated.params.reference_dropbox_paths)
          ? (validated.params.reference_dropbox_paths as string[])
          : undefined;
        const resolvedByRecipient: Record<string, string[]> = {};
        for (const target of targets) {
          const recLower = target.recipient.toLowerCase();
          const pathsForTarget = byRecipientMap?.[recLower] ??
            (byRecipientMap === undefined && targets.length === 1 ? globalRefs : undefined);
          if (pathsForTarget && pathsForTarget.length > 0) {
            const targetRoot = await resolveRecipientRoot(adminClient(), recLower);
            if (!targetRoot) {
              throw new Error(`reference_dropbox_paths must stay under a valid recipient root for ${recLower}`);
            }
            const normalizedRoot = targetRoot.endsWith("/") ? targetRoot : `${targetRoot}/`;
            for (const p of pathsForTarget) {
              if (!p.startsWith(normalizedRoot)) {
                throw new Error(`reference_dropbox_paths must stay under ${normalizedRoot}`);
              }
            }
            resolvedByRecipient[recLower] = pathsForTarget;
          }
        }

        const fanout = await fanoutGroupMessage(adminClient(), {
          groupId,
          ownerId: user.id,
          fromKind: "owner",
          fromName: ownerName,
          turn: 1,
          utterance: truncateUtterance(formattedUtterance),
          targets,
          command: typeof validated.params.command === "string"
            ? validated.params.command
            : undefined,
          ...(Object.keys(resolvedByRecipient).length > 0
            ? { referenceDropboxPathsByRecipient: resolvedByRecipient }
            : {}),
          ...(replyTo ? { replyTo } : {}),
        });
        return new Response(
          JSON.stringify({
            group_id: groupId,
            message_ids: fanout.messageIds,
            status: "pending",
            expires_at: fanout.expiresAt,
          }),
          { status: 201, headers: { ...corsHeaders, "content-type": "application/json" } },
        );
      }

      // No valid mention: record-only utterance. A `done` row whose recipient
      // is the owner's own UUID can never be claimed (no muse resolves to it
      // and claim_message only picks pending rows), yet it carries the group
      // post so the timeline renders it like any owner utterance.
      const id = crypto.randomUUID();
      const nonce = crypto.randomUUID();
      const expiresAtUnix = Math.floor(Date.now() / 1000) + CLAIM_WINDOW_SECONDS;
      const expiresAt = new Date(expiresAtUnix * 1000).toISOString();
      const recordRefs = Array.isArray(validated.params.reference_dropbox_paths)
        ? (validated.params.reference_dropbox_paths as string[])
        : [];
      const params: Record<string, unknown> = {
        prompt: `[${ownerName}]: ${truncateUtterance(formattedUtterance)}`,
        thread_id: groupId,
        ...(recordRefs.length > 0 ? { reference_dropbox_paths: recordRefs } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      };
      const signature = await signMessage({
        id,
        owner_id: user.id,
        recipient: user.id,
        action: "chat",
        params,
        nonce,
        expires_at_unix: expiresAtUnix,
      });
      const { error: insertError } = await adminClient()
        .from("relay_messages")
        .insert({
          id,
          owner_id: user.id,
          recipient: user.id,
          action: "chat",
          params,
          status: "done",
          completed_at: new Date().toISOString(),
          nonce,
          expires_at: expiresAt,
          expires_at_unix: expiresAtUnix,
          signature,
        });
      if (insertError) throw insertError;
      const { error: postError } = await adminClient()
        .from("relay_group_posts")
        .insert({
          message_id: id,
          group_id: groupId,
          owner_id: user.id,
          from_kind: "owner",
          from_name: ownerName,
          turn: 1,
          batch_id: crypto.randomUUID(),
        });
      if (postError) throw postError;

      return new Response(
        JSON.stringify({
          group_id: groupId,
          message_ids: [id],
          status: "done",
          expires_at: expiresAt,
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
      const normalizedRoot = dropboxRoot.endsWith("/") ? dropboxRoot : `${dropboxRoot}/`;
      for (const p of refDropboxPaths) {
        if (typeof p !== "string" || !p.startsWith(normalizedRoot)) {
          throw new Error(`reference_dropbox_paths must stay under ${dropboxRoot}`);
        }
      }
    }
    const singleReplyTo = validated.params["reply_to"] as ReplyToMeta | undefined;
    if (singleReplyTo) {
      const quoted = prependReplyQuote(String(validated.params["prompt"]), singleReplyTo);
      validated.params["prompt"] = quoted.length > 4000 ? `${quoted.slice(0, 3999)}…` : quoted;
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
