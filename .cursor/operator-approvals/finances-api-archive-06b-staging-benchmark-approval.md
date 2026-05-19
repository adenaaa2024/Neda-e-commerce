# Finances API Archive 06B — Staging Flatten Benchmark Approval

Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: staging
Approved by: operator
Approved at UTC: 2026-05-17T20:00:00Z

APPROVED_TO_RUN_FINANCES_API_ARCHIVE_06B_STAGING_BENCHMARK=true

Scope:
- Replay flatten from existing `amazon_finances_api_pages` only (no live Amazon window)
- Staging `amazon_finances_events` idempotent re-insert benchmark
- Read-only FRR count verification
- No production, no FRR writes, no claims/products/scanner mutation
