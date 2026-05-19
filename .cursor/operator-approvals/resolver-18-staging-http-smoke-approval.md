# Resolver 18 — Staging HTTP Generic REMOVAL_SHIPMENT Smoke Approval

Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-16T14:00:00.000Z

APPROVED_TO_RUN_RESOLVER_18_STAGING_HTTP_SMOKE=true

Scope:
- Staging only (`eiqfaapyumhixxoeltgu`)
- Original source / rollback: `kxsvedvpjldygtdbylsy`
- One POST `/api/settings/imports/generic` for `REMOVAL_SHIPMENT` (or in-process route handler if middleware blocks unauthenticated HTTP)
- One `upload_id` / org+store cohort per smoke-dataset requirements
- No production
- No broad uploads or multi-store sweeps
- No Amazon API, AI, product/scanner/claim generation
