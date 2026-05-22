# Dual Project — Staging Registration Policy

**Policy ID:** `DUAL-PROJECT-STAGING-01`  
**Effective:** 2026-05-21  
**Status:** ACTIVE — production **BLOCKED**; ENV-04R clone **PASS**; ENV-05E **local app on staging**

## Project roles

| Role | Constant | Project ref | App default (local) | Clone state |
|------|----------|-------------|---------------------|-------------|
| **Original (source / rollback)** | `ORIGINAL_PROJECT_REF` | `kxsvedvpjldygtdbylsy` | Aliases in `.env.local` (`ORIGINAL_*`) | Live source |
| **Staging (clone / test)** | `STAGING_PROJECT_REF` | `eiqfaapyumhixxoeltgu` | **Yes** — `NEXT_PUBLIC_SUPABASE_URL` after ENV-05E | Postgres clone PASS; storage **PARTIAL** (136/144) |
| **Production** | `PRODUCTION_PROJECT_REF` | `NOT_CREATED_YET` | No | **BLOCKED** |

Do **not** label `eiqfaapyumhixxoeltgu` as production.  
Do **not** label `kxsvedvpjldygtdbylsy` as production-only.

## Supersedes

This policy supersedes [single-supabase-project-policy.md](single-supabase-project-policy.md) for environment labeling. **Local** app targets staging per [staging-local-cutover-01-approval.md](../operator-approvals/staging-local-cutover-01-approval.md). Vercel Production remains on original until a separate Preview/production cutover.

## Registration approval

Source of truth: [staging-registration-01-approval.md](../operator-approvals/staging-registration-01-approval.md)

```
APPROVED_TO_REGISTER_STAGING_REF=true
STAGING_PROJECT_REF=eiqfaapyumhixxoeltgu
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
```

## Clone gate (executed)

[staging-clone-01-approval.md](../operator-approvals/staging-clone-01-approval.md):

```
APPROVED_TO_PREPARE_STAGING_CLONE=true
APPROVED_TO_EXECUTE_STAGING_CLONE=true
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
STAGING_PROJECT_REF=eiqfaapyumhixxoeltgu
```

Audit: `.cursor/audit-reports/next-env-04r/20260525T200000Z/` — **PASS**

## Production-readiness gate

| Gate | Status |
|------|--------|
| Production ref registration | **BLOCKED** |
| Production read-only probe | **BLOCKED** |
| `PRODUCTION_*` env vars in `.env.local` | Must remain **blank** |

Approval: [production-readiness-01-approval.md](../operator-approvals/production-readiness-01-approval.md)

```
APPROVED_TO_REGISTER_PRODUCTION_REF=false
APPROVED_TO_RUN_PRODUCTION_READ_ONLY_PROBE=false
```

## Hard prohibitions

- No `supabase db push` / migration apply on staging until ENV-04 with clone approval.
- No `pg_dump` / `pg_restore` in registration-only prompts (ENV-02B).
- No production probe (`next-production-readiness-02-probe.ts`).
- No `package_items` table creation.
- No scanner merge branch changes under ENV-02B.

## Env variable layout (`.env.local` — gitignored)

| Prefix | Purpose |
|--------|---------|
| `ORIGINAL_*` | Clone source (`kxsvedvpjldygtdbylsy`) |
| `STAGING_*` | Clone target (`eiqfaapyumhixxoeltgu`) |
| `PRODUCTION_*` | Future production only — **must be empty** |
| `NEXT_PUBLIC_SUPABASE_*` | App — **staging** locally after ENV-05E; use `ORIGINAL_*` to rollback |

Secrets: operator vault only; never commit.

## Related artifacts

- Plan: [next-env-02-staging-registration-and-clone-plan.md](../plans/next-env-02-staging-registration-and-clone-plan.md)
- Audit ENV-02: `.cursor/audit-reports/next-env-02/`
- Audit ENV-02B: `.cursor/audit-reports/next-env-02b/`
- Preflight: `.cursor/audit-reports/next-env-03/`
