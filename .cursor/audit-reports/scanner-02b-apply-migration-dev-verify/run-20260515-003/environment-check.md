# Environment check (SCANNER-02B preflight)

## Sources reviewed

- Workspace `.env.local` (keys inspected for classification only; values not recorded in this audit).
- Repository root: no `VERCEL_ENV`, `NODE_ENV`, `ENVIRONMENT`, or similar staging marker lines in `.env.local`.
- No committed `supabase/config.toml` or linked-project metadata in-repo to disambiguate Supabase project tier.

## Supabase target shape

- `NEXT_PUBLIC_SUPABASE_URL` is set to a hosted `*.supabase.co` project (not `127.0.0.1` / local stack).

## Classification (required gate)

| Criterion | Result |
|-----------|--------|
| Explicit dev/staging label in env files reviewed | **No** |
| Local Supabase / Docker dev URL | **No** (hosted URL) |
| Production explicitly confirmed | **No** |
| **Confirmed dev/staging** | **No — UNKNOWN / NOT CONFIRMED** |

## Decision

Per SCANNER-02B hard constraints, **migration application is STOPPED** until the operator confirms the linked Supabase project is **dev or staging** (for example by naming the project, adding `VERCEL_ENV=staging` or an agreed `DATABASE_ENV=staging` in a non-production env file, or using a documented staging project ref separate from production).

Do not apply `20260717120000_scanner_product_linkage_columns.sql` to production without explicit approval (unchanged from NEXT-SCANNER-02).
