import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "./config";

export let db: SupabaseClient;

/** Initializes the Supabase client from runtime config loaded during boot. */
export function initSupabase(): SupabaseClient {
  const { supabaseUrl, supabasePublishableKey } = getConfig();
  db = createClient(supabaseUrl, supabasePublishableKey);
  return db;
}
