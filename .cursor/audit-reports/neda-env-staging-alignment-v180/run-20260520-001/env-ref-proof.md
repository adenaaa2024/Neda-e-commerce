# Env ref proof (safe)

**Required staging ref:** `eiqfaapyumhixxoeltgu` (substring only — no secrets logged)

| Variable | Classification |
|----------|----------------|
| NEXT_PUBLIC_SUPABASE_URL | STAGING_REF |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | OTHER |
| SUPABASE_SERVICE_ROLE_KEY | OTHER |
| DIRECT_POSTGRES_URL | STAGING_REF |
| STAGING_SUPABASE_URL | STAGING_REF |
| STAGING_DIRECT_POSTGRES_URL | STAGING_REF |
| STAGING_PROJECT_REF | STAGING_REF |
| ORIGINAL_DIRECT_POSTGRES_URL | OTHER |

**PRODUCTION_***: none defined

## Runtime wiring

Next.js / `lib/supabase-server.ts` use **`NEXT_PUBLIC_SUPABASE_URL`** + service role — not `STAGING_SUPABASE_URL` unless you copy staging values into the NEXT_PUBLIC_* pair.
