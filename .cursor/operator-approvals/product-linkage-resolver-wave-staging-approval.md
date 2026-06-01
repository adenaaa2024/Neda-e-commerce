# PRODUCT-LINKAGE-RESOLVER-WAVE — staging approval

Supabase project ref: eiqfaapyumhixxoeltgu
Environment: staging only
Approved by: operator (governed wave execute prompt)
Approved at UTC: 2026-06-01T06:00:00.000Z

APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_LINKAGE_RESOLVER_WAVE=true
APPROVED_PRODUCT_CREATE=false
APPROVED_MAP_INSERT=false

## Scope

- `expected_packages.resolved_product_id` via map/products tiers (exact match only)
- `return_items` via `resolveScannerProductIdentifiers` + EP→RI copy when EP already resolved
- Max 250 updates per wave unless `--continue-all` after wave verify PASS

## Exclusions

- No product creation
- No bulk `product_identifier_map` INSERT
- No fuzzy/title/OCR matching
- No writes to rows without identifiers
- No bulk-orphan return_items (expected_item_id only, no package_id)
