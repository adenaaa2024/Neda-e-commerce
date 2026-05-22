import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Next.js may cache `fetch` by default; PostgREST calls must stay fresh (roles, permissions, reports).
 */
function noStoreFetch(input: RequestInfo | URL, init?: RequestInit): ReturnType<typeof fetch> {
  return fetch(input, { ...init, cache: "no-store" });
}

/**
 * Server-only Supabase client using the service role key.
 * Use this for operations that require bypassing RLS or accessing sensitive data
 * (e.g. lwa_client_secret). Never import this file in client components.
 *
 * Typed rows live in `@/types/database.types` — wire `createClient<Database>` after
 * `supabase gen types` (full schema) so `.select()` column names stay in sync.
 */
function createServerSupabase(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

let cachedServerSupabase: SupabaseClient | undefined;

/** Lazy singleton — do not read env at module import (breaks `next build` on Vercel otherwise). */
export function getSupabaseServer(): SupabaseClient {
  if (!cachedServerSupabase) {
    cachedServerSupabase = createServerSupabase();
  }
  return cachedServerSupabase;
}

/** Back-compat: `supabaseServer.from(...)` delegates to lazy client. */
export const supabaseServer: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getSupabaseServer();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
