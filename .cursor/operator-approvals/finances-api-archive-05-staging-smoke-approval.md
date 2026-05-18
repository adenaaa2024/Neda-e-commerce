# Finances API Archive 05 — Staging smoke approval


Supabase project ref/name: kxsvedvpjldygtdbylsy
Environment: dev/staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-17T01:30:00Z


APPROVED_TO_RUN_FINANCES_API_ARCHIVE_05_STAGING_SMOKE=true

Scope:
- One controlled Finances API archive ingest on staging `kxsvedvpjldygtdbylsy`
- Short date window only (≤ 7 calendar days recommended)
- Flags: `ENABLE_AMAZON_FINANCES_API_WORKER=true`, `ENABLE_AMAZON_FINANCES_API_INGEST=true`
- Writes only to `amazon_finances_*` tables
- No FRR writes, no claims/products/scanner mutations
- No broad windows, no credential logging

Operator: set `APPROVED_TO_RUN_FINANCES_API_ARCHIVE_05_STAGING_SMOKE=true` and fill approved by/at before running `npm run smoke:finances-api-archive-05`.
