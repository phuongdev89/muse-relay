import {
  adminClient,
  allowedOwnerId,
  INPUT_BUCKET,
  jsonResponse,
  resolveMuse,
  verifyMessageSignature,
} from "../_shared/relay.ts";

const CLAIM_LEASE_SECONDS = 30 * 60;
const CANDIDATE_LIMIT = 5;

interface RelayMessageRow {
  id: string;
  owner_id: string;
  recipient: string;
  action: string;
  params: Record<string, unknown>;
  nonce: string;
  expires_at_unix: number;
  signature: string;
  attempts: number;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const muse = await resolveMuse(req);
  if (!muse) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  try {
    const supabase = adminClient();
    const nowUnix = Math.floor(Date.now() / 1000);
    const ownerAllowlist = allowedOwnerId();

    let query = supabase
      .from("relay_messages")
      .select(
        "id, owner_id, recipient, action, params, nonce, expires_at_unix, signature, attempts",
      )
      .eq("recipient", muse.recipient)
      .eq("status", "pending")
      .gt("expires_at_unix", nowUnix)
      .order("created_at", { ascending: true })
      .limit(CANDIDATE_LIMIT);
    if (ownerAllowlist) query = query.eq("owner_id", ownerAllowlist);

    const { data: candidates, error: selectError } = await query;
    if (selectError) throw selectError;

    for (const candidate of (candidates ?? []) as RelayMessageRow[]) {
      const signatureOk = await verifyMessageSignature(
        {
          id: candidate.id,
          owner_id: candidate.owner_id,
          recipient: candidate.recipient,
          action: candidate.action,
          params: candidate.params,
          nonce: candidate.nonce,
          expires_at_unix: candidate.expires_at_unix,
        },
        candidate.signature,
      );

      if (!signatureOk) {
        await supabase
          .from("relay_messages")
          .update({ status: "failed", completed_at: new Date().toISOString() })
          .eq("id", candidate.id)
          .eq("status", "pending");
        await supabase.from("relay_results").insert({
          message_id: candidate.id,
          owner_id: candidate.owner_id,
          status: "failed",
          output: { dropbox_paths: [], notes: null, text: null },
          error: "invalid_signature",
        });
        continue;
      }

      const claimId = crypto.randomUUID();
      const claimExpiresAt = new Date(
        (nowUnix + CLAIM_LEASE_SECONDS) * 1000,
      ).toISOString();
      const { data: claimed, error: claimError } = await supabase
        .from("relay_messages")
        .update({
          status: "processing",
          claim_id: claimId,
          claim_expires_at: claimExpiresAt,
          claimed_at: new Date().toISOString(),
          attempts: candidate.attempts + 1,
        })
        .eq("id", candidate.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) continue;

      const referencePaths = Array.isArray(candidate.params["reference_storage_paths"])
        ? candidate.params["reference_storage_paths"] as string[]
        : [];
      let referenceSignedUrls: { path: string; signed_url: string }[] = [];
      if (referencePaths.length > 0) {
        const { data: signed, error: signError } = await supabase.storage
          .from(INPUT_BUCKET)
          .createSignedUrls(referencePaths, 60 * 60);
        if (signError) throw signError;
        referenceSignedUrls = (signed ?? [])
          .filter((item) => item.signedUrl)
          .map((item) => ({ path: item.path ?? "", signed_url: item.signedUrl }));
      }

      return jsonResponse({
        message: {
          id: candidate.id,
          claim_id: claimId,
          recipient: candidate.recipient,
          action: candidate.action,
          params: candidate.params,
          reference_signed_urls: referenceSignedUrls,
          claim_expires_at: claimExpiresAt,
        },
      });
    }

    return jsonResponse({ message: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, 500);
  }
});
