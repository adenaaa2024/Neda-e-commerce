# Scanner 02F — Staging product linkage smoke approval


Supabase project ref/name: kxsvedvpjldygtdbylsy
Environment: dev/staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-17T01:30:00Z

APPROVED_TO_RUN_SCANNER_02F_STAGING_SMOKE=true

Scope:
- Verify SCANNER-02E UI badges (linked / unresolved / ambiguous) on staging app
- Save return_items with mapped SKU/FNSKU/ASIN from `product_identifier_map` (no OCR product creation)
- Save package with manifest → confirm `slip_contents` resolver patch
- No production, no ambiguous auto-merge, no Amazon API, no AI

Operator: set `APPROVED_TO_RUN_SCANNER_02F_STAGING_SMOKE=true` before manual UI smoke.
