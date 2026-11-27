import { env } from "./env.js";

export interface SupabaseSingleResult<T> {
  data: T | null;
  status: number;
  error?: string;
}

/**
 * Queries a single row from Supabase PostgREST using the owner's JWT and
 * publishable key so Postgres RLS enforces row ownership directly.
 */
export async function supabaseRestSelectSingle<T>(
  pathWithQuery: string,
  jwt: string,
): Promise<SupabaseSingleResult<T>> {
  const url = `${env.supabaseUrl}/rest/v1/${pathWithQuery}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        apikey: env.supabasePublishableKey,
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return {
        data: null,
        status: res.status,
        error: `supabase_http_${res.status}`,
      };
    }

    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { data: null, status: 404 };
    }
    return { data: rows[0] as T, status: 200 };
  } catch {
    return {
      data: null,
      status: 502,
      error: "supabase_upstream_error",
    };
  }
}
