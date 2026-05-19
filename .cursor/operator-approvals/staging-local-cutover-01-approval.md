# Staging Local Cutover 01 — Point local app at cloned staging

**Purpose:** Authorize **local-only** switch of the active Supabase app quartet to `eiqfaapyumhixxoeltgu`.

**Prerequisites:**

- NEXT-ENV-04R Postgres clone **PASS**
- ENV-04B storage recommended (operator may accept partial storage for UI-only DB tests)

## Approval flags

```
APPROVED_TO_POINT_LOCAL_APP_AT_STAGING=true
STAGING_PROJECT_REF=eiqfaapyumhixxoeltgu
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
I_UNDERSTAND_THIS_IS_LOCAL_ONLY=true
I_UNDERSTAND_PRODUCTION_UNTOUCHED=true
```

## Does NOT authorize

- Vercel Production env changes
- Vercel Preview changes (separate prompt)
- Production project probes
- `package_items` table creation

## Signoff

```
Environment: LOCAL STAGING CUTOVER
Status: APPROVED
Approved by: operator (NEXT-ENV-05E)
Approved at UTC: 2026-05-27T18:00:00Z
```
