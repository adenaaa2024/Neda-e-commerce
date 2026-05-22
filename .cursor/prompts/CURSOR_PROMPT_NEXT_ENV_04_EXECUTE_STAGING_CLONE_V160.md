# NEXT-ENV-04 — EXECUTE STAGING CLONE (V160)

## Owner
Main/user

## Mode
Agent

## Prerequisites (operator — before run)

1. Ensure `.cursor/operator-approvals/staging-clone-01-approval.md` contains:

```
APPROVED_TO_PREPARE_STAGING_CLONE=true
APPROVED_TO_EXECUTE_STAGING_CLONE=true
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
STAGING_PROJECT_REF=eiqfaapyumhixxoeltgu
I_UNDERSTAND_THIS_CLONES_ORIGINAL_TO_STAGING=true
```

2. ENV-03B preflight **READY** (latest `next-env-03b` audit).
3. `.env.local`:
   - `ORIGINAL_DIRECT_POSTGRES_URL` → `kxsvedvpjldygtdbylsy`
   - `STAGING_DIRECT_POSTGRES_URL` → `eiqfaapyumhixxoeltgu`
   - all `PRODUCTION_*` **blank**
4. Operator backup of original (dashboard PITR + optional `pg_dump -Fc`).
5. `pg_dump`, `pg_restore`, `psql` on PATH.

## Hard constraints

- Do **not** label staging as production
- Do **not** run production-readiness probes
- Do **not** switch `NEXT_PUBLIC_SUPABASE_URL` / Vercel (ENV-05+)
- Do **not** create `package_items`
- Primary path: **pg_dump / pg_restore** — not `supabase db push` of 199 migrations on empty staging
- No `pg_restore --clean` without explicit operator approval

## Phases

1. Pre-clone safety check (abort if any fail)
2. `pg_dump` original `public` + `auth` schemas
3. `pg_restore` into staging
4. Read-only count verification on staging
5. Emit audit pack — **no secrets in logs**

## Output
`.cursor/audit-reports/next-env-04/<run_id>/`

Required: `manifest.json`, `pre-clone-safety-check.md`, `restore-result.md`, `staging-verification-counts.md`, `no-app-cutover-proof.md`, `blockers.md`

## On completion
Append history using `CURSOR_PROMPT_GENERATE_HISTORY_V162.md` (or HISTORY-V160 status prompt if specified).
