import "server-only";
import { Buffer } from "node:buffer";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Next.js may cache `fetch` by default; PostgREST calls must stay fresh (roles, permissions, reports).
 */
function noStoreFetch(input: RequestInfo | URL, init?: RequestInit): ReturnType<typeof fetch> {
  return fetch(input, { ...init, cache: "no-store" });
}

/** Supabase secrets are JWTs; payload `role` must be `service_role` for RLS bypass. */
function readJwtRoleFromSupabaseSecret(secret: string): string | undefined {
  const parts = secret.trim().split(".");
  if (parts.length !== 3) return undefined;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = Buffer.from(b64, "base64").toString("utf8");
    const payload = JSON.parse(json) as { role?: string };
    return typeof payload.role === "string" ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

function warnIfServiceRoleKeyMisconfigured(serviceRoleKey: string): void {
  const trimmed = serviceRoleKey.trim();
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (anon && anon === trimmed) {
    console.error(
      "[supabase-server] CRITICAL: SUPABASE_SERVICE_ROLE_KEY is identical to NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Use the service_role secret from Supabase → Project Settings → API (never the anon key).",
    );
    return;
  }
  const role = readJwtRoleFromSupabaseSecret(trimmed);
  if (role === "anon") {
    console.error(
      "[supabase-server] CRITICAL: SUPABASE_SERVICE_ROLE_KEY decodes as JWT role=anon. " +
        "That is the publishable key — RLS will apply. Replace with the service_role key from Supabase → API.",
    );
  } else if (role != null && role !== "service_role") {
    console.warn(
      `[supabase-server] SUPABASE_SERVICE_ROLE_KEY JWT role is "${role}" (expected service_role). Verify env.`,
    );
  }
}

/**
 * Server-only Supabase client using the service role key.
 * Use this for operations that require bypassing RLS or accessing sensitive data
 * (e.g. lwa_client_secret). Never import this file in client components.
 *
 * PostgREST runs as the `service_role` JWT: **RLS policies are bypassed** (unlike the anon key).
 * If `SUPABASE_SERVICE_ROLE_KEY` were mistakenly set to the anon key, tenant-scoped queries would
 * see only rows allowed by RLS (e.g. super admins would not see another org’s `stores`).
 *
 * Typed rows live in `@/types/database.types` — wire `createClient<Database>` after
 * `supabase gen types` (full schema) so `.select()` column names stay in sync.
 */
function getServerSupabase(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  warnIfServiceRoleKeyMisconfigured(serviceRoleKey);

  // Second argument is the JWT secret role key only — no `getSession()`, cookies, or user access token are merged.
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: { fetch: noStoreFetch },
  });
}

export const supabaseServer = getServerSupabase();

/**
 * True when the server client was constructed with a non-empty service role key.
 * Callers can surface this in debug responses to confirm we are not using the anon key (RLS-bound).
 */
export function isSupabaseServiceRoleConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}
