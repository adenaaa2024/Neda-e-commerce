# EXPECTED-PACKAGES-RESOLVER-BACKFILL-V180 — Staging DDL + tiered backfill approval

Supabase project ref/name: eiqfaapyumhixxoeltgu  
Environment: staging  
Approved by: Maysam Ebrahimi  
Approved at UTC: 2026-05-20T20:00:00Z

APPROVED_TO_RUN_EXPECTED_PACKAGES_RESOLVER_BACKFILL_V180_STAGING=true

Scope:
- Staging only (`eiqfaapyumhixxoeltgu`)
- Idempotent DDL: nullable resolver quad on `public.expected_packages` + partial index
- Tiered exact backfill via `product_identifier_map`: FNSKU → SKU+ASIN → SKU → ASIN (ASIN from `amazon_removals` when `source_detail_row_id` set)
- No production
- No `package_items`
- No title/OCR/fuzzy; no product auto-create
- No `return_items` / legacy `returns` mutations

Rollback:
- Resolver columns are nullable; clear with audited UPDATE if needed (no DROP)
