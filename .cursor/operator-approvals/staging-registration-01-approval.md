# Staging Registration 01 — Candidate staging ref

**Purpose:** Register the new empty Supabase project as **candidate STAGING** (not production).

**Policy:** [dual-project-staging-registration.md](../environment-policy/dual-project-staging-registration.md)

## Registration (authorized)

```
APPROVED_TO_REGISTER_STAGING_REF=true
STAGING_PROJECT_REF=eiqfaapyumhixxoeltgu
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
PRODUCTION_PROJECT_EXISTS=false
APPROVED_TO_RUN_PRODUCTION_READ_ONLY_PROBE=false
```

## Does NOT authorize

- DDL, DML, migration apply, or `pg_restore` on staging
- Storage object copy
- Switching `NEXT_PUBLIC_SUPABASE_URL` to staging
- Production-readiness probe
- Calling staging "production"

## Signoff

**Status: REGISTERED** — NEXT-ENV-02B (docs/policy only; no DB connection).

```
Environment: CANDIDATE STAGING
Staging project ref: eiqfaapyumhixxoeltgu
Original project ref: kxsvedvpjldygtdbylsy
Staging DB expected empty: yes
Production project exists: false
Approved by: Main/user
Approved at UTC: 2026-05-21
Notes: Registration artifacts only. Clone gated by staging-clone-01-approval.md.
```
