# Data parity plan

## Do not bulk-clone staging → original

| Surface | Staging | Original | Action |
|---------|--------:|---------:|--------|
| amazon_removals (Sam) | — | — | SP-API fetch + sync (Wave C) |
| amazon_removal_shipments (Sam) | — | — | SP-API fetch (Wave C) |
| derived expected_packages | — | — | rebuild after domain (Wave C) |
| EP resolved_product_id | — | — | resolver backfill (Wave C) |
| EP allocation_group_key | — | — | rebuild with grouped migration (Wave C) |
| product_identifier_map | — | — | governed replay (Wave B) |
| spreadsheet packaging profiles | — | — | re-verify parity |

## Staging-only executes to replay on original

- Removal SP-API fetch + allocation fix + rebuild
- Resolver backfill dry-run/execute
- Item-level receive repair (schema only in Wave A; data is operational smoke in Wave D)
