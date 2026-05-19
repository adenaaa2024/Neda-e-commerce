# Staging Storage Clone 01 — Inventory + copy (original → staging)

**Purpose:** Authorize read-only inventory and optional object copy for Supabase Storage buckets.

**Prerequisites:**

- NEXT-ENV-04R Postgres clone **PASS** (`.cursor/audit-reports/next-env-04r/20260525T200000Z/manifest.json`)
- `PRODUCTION_*` blank in `.env.local`
- Service role keys for **original** and **staging** in `.env.local` (see NEXT-ENV-04B `missing-credentials.md`)

## Approval flags

```
APPROVED_TO_PREPARE_STAGING_STORAGE_CLONE=true
APPROVED_TO_EXECUTE_STAGING_STORAGE_CLONE=true
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
STAGING_PROJECT_REF=eiqfaapyumhixxoeltgu
```

## Does NOT authorize

- Production project access
- App/Vercel cutover (NEXT-ENV-05)
- DB schema changes or migrations
- `package_items` table creation

## Signoff

**Status: PARTIAL EXECUTED** — 136/144 objects copied (`20260527T120000Z`); 8 large `raw-reports` pending 04B-R2.

```
Environment: STAGING STORAGE CLONE
Status: PARTIAL
Approved by: operator
Approved at UTC: 2026-05-27T12:00:00Z
```
