# Import API 09 — Settlement Reports API staging smoke approval


Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: dev/staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-17T01:30:00Z

APPROVED_TO_RUN_IMPORT_API_09_SETTLEMENT_STAGING_SMOKE=true

Scope:
- One controlled Settlement Reports API pull on staging `eiqfaapyumhixxoeltgu` (active local target)
- Original source / rollback: `kxsvedvpjldygtdbylsy`
- Preflight scripts URL-guard `STAGING_PROJECT_REF` (`eiqfaapyumhixxoeltgu`) via ENV-05B helper
- Report type: `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` only
- Short date window only (≤ 7 calendar days recommended)
- Flags: `ENABLE_AMAZON_REPORTS_API_WORKER=true`, `ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true`
- Writes: `raw_report_uploads` (synthetic upload + archive), settlement import handoff to `amazon_settlements` via existing pipeline
- No production, no broad historical windows, no AI/OpenAI, no scanner changes
- No direct claim mutation; no credential logging in UI or logs

Operator: set `APPROVED_TO_RUN_IMPORT_API_09_SETTLEMENT_STAGING_SMOKE=true` and fill approved by/at before running `npm run smoke:import-api-09-settlement-preflight` then execute via staging Imports UI or `POST /api/settings/imports/reports-api/settlement/run`.
