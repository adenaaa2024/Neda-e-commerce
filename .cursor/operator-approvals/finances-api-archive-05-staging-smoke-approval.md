# Finances API Archive 05 — Staging smoke approval


Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: dev/staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-17T01:30:00Z


APPROVED_TO_RUN_FINANCES_API_ARCHIVE_05_STAGING_SMOKE=true

Scope:
- One controlled Finances API archive ingest on staging `eiqfaapyumhixxoeltgu` (active local target)
- Original source / rollback: `kxsvedvpjldygtdbylsy`
- Preflight scripts URL-guard `STAGING_PROJECT_REF` (`eiqfaapyumhixxoeltgu`) via ENV-05B helper
- Short date window only (≤ 7 calendar days recommended)
- Flags: `ENABLE_AMAZON_FINANCES_API_WORKER=true`, `ENABLE_AMAZON_FINANCES_API_INGEST=true`
- Writes only to `amazon_finances_*` tables
- No FRR writes, no claims/products/scanner mutations
- No broad windows, no credential logging

Operator: set `APPROVED_TO_RUN_FINANCES_API_ARCHIVE_05_STAGING_SMOKE=true` and fill approved by/at before running `npm run smoke:finances-api-archive-05`.
