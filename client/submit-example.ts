import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://<project-ref>.supabase.co",
  "<publishable-key>",
);

// The user must be signed in first (supabase.auth.signInWithPassword,
// signInWithOtp, OAuth, ...). submit_message reads the user id from the
// verified JWT, never from the request body.

const RECIPIENT_ID = "<recipient-uuid>";

export async function requestChat(prompt: string, threadId?: string) {
  const { data, error } = await supabase.functions.invoke("submit_message", {
    body: {
      recipient: RECIPIENT_ID,
      action: "chat",
      params: {
        prompt,
        thread_id: threadId ?? null,
        resource_type: "auto",
        output_format: "auto",
        aspect_ratio: "9:16",
        count: 1,
        duration_seconds: 8,
        reference_storage_paths: [],
      },
    },
  });
  if (error) throw error;
  return data as { message_id: string; status: string; expires_at: string };
}

export async function requestImage(prompt: string, threadId?: string) {
  const { data, error } = await supabase.functions.invoke("submit_message", {
    body: {
      recipient: RECIPIENT_ID,
      action: "image",
      params: {
        prompt,
        aspect_ratio: "9:16",
        count: 1,
        reference_storage_paths: [],
        thread_id: threadId ?? null,
      },
    },
  });
  if (error) throw error;
  return data as { message_id: string; status: string; expires_at: string };
}

export async function requestVideo(prompt: string, threadId?: string) {
  const { data, error } = await supabase.functions.invoke("submit_message", {
    body: {
      recipient: RECIPIENT_ID,
      action: "video",
      params: {
        prompt,
        aspect_ratio: "9:16",
        duration_seconds: 8,
        reference_storage_paths: [],
        thread_id: threadId ?? null,
      },
    },
  });
  if (error) throw error;
  return data as { message_id: string; status: string; expires_at: string };
}

// Reference images: upload to the private "relay-inputs" bucket under
// "<your-auth-user-id>/..." first, then pass the storage paths in
// reference_storage_paths. Example:
// const userId = (await supabase.auth.getUser()).data.user!.id;
// await supabase.storage.from("relay-inputs").upload(`${userId}/ref-1.png`, file);
