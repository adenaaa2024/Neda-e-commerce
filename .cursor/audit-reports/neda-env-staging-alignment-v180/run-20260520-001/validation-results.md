# NEDA-ENV-STAGING-ALIGNMENT-V180 — validation

**Run:** run-20260520-001  
**Overall:** **FAIL** (env misalignment)

| Gate | Result |
|------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` → staging ref `eiqfaapyumhixxoeltgu` | **FAIL** (OTHER — likely original project) |
| `DIRECT_POSTGRES_URL` / `STAGING_DIRECT_POSTGRES_URL` → staging | **PASS** |
| `PRODUCTION_*` blank | **PASS** (no keys) |
| Neda read/UI code (aliases) | **PASS** |
| Stale forbidden refs (scanner) | **PASS** (all 0) |
| `npm run build` | **PASS** |
| `npx tsc --noEmit` | **PASS** |
| Smoke npm scripts | **SKIP** (not in package.json) |

## Fix before Neda staging work

Copy **staging** values into the trio Next actually reads:

- `NEXT_PUBLIC_SUPABASE_URL` → must contain `eiqfaapyumhixxoeltgu`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` → from `STAGING_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` → from `STAGING_SERVICE_ROLE_KEY`

Restart `next dev` after editing `.env.local`.
