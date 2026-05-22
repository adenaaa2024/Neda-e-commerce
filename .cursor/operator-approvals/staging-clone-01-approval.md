# Staging Clone 01 — Execute clone (original → staging)

**Purpose:** Authorize **prepare** and **execute** of Postgres + storage clone from original to candidate staging.

**Prerequisites:**

- [staging-registration-01-approval.md](staging-registration-01-approval.md) — `APPROVED_TO_REGISTER_STAGING_REF=true`
- NEXT-ENV-03B preflight **PASS**
- Operator backup of original project
- `PRODUCTION_*` blank in `.env.local`
- PostgreSQL client tools on PATH (`pg_dump`, `pg_restore`, `psql`)

## Approval flags (template — not authorized)

```

APPROVED_TO_PREPARE_STAGING_CLONE=true
APPROVED_TO_EXECUTE_STAGING_CLONE=true
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
STAGING_PROJECT_REF=eiqfaapyumhixxoeltgu
I_UNDERSTAND_THIS_CLONES_ORIGINAL_TO_STAGING=true


```

## Does NOT authorize

- Labeling staging as production
- `next-production-readiness-02-probe.ts`
- App/Vercel cutover (NEXT-ENV-05)
- Creating `package_items` table
- Scanner merge branch changes

## Signoff

**Status: EXECUTED** — ENV-04R Postgres clone PASS (`20260525T200000Z`).

```
Environment: STAGING CLONE
Status: EXECUTED
Approved by: operator
Approved at UTC: 2026-05-25T20:00:00Z
Notes: App/Vercel cutover deferred to ENV-05E+ (local cutover executed separately).
```
