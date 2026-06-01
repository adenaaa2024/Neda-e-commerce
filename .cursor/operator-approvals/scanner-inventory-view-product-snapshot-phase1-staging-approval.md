# Scanner Inventory View Product Snapshot — Phase 1 (Staging)

**Default:** not approved until operator sets flags below.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v3` |
| Plan run | `scanner-inventory-view-product-snapshot-phase1-plan/20260529T190000Z` |

## SQL file to run

`.cursor/audit-reports/scanner-inventory-view-product-snapshot-phase1-plan/20260529T190000Z/ddl-staging-draft.sql`

## Objects touched

| Object | Operation |
|--------|-----------|
| `public.v_inventory_item_status` | CREATE OR REPLACE VIEW — add `expected_package_id`, `product_display_name` |
| `public.v_inventory_status` | CREATE OR REPLACE VIEW — propagate new columns |

## Allowed

- View DDL only (2 views)
- Read-only verification queries

## Forbidden

- Copy staging→original data
- INSERT/UPDATE `products`
- INSERT/UPDATE `product_identifier_map`
- INSERT/UPDATE `expected_packages`
- Resolver/backfill data mutations
- Product auto-create from title/OCR/name matching

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_SCANNER_INVENTORY_VIEW_SNAPSHOT_PHASE1_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Verification

`.cursor/audit-reports/scanner-inventory-view-product-snapshot-phase1-plan/20260529T190000Z/verification-staging.sql`

Tracking smoke: `1552698729` → `product_display_name` = `Bobs Red Mill GF Baking Soda 4/16 Oz`, `expected_package_id` not null.

## Rollback

`.cursor/audit-reports/scanner-inventory-view-product-snapshot-phase1-plan/20260529T190000Z/rollback-staging.sql`

## Follow-on (separate approval)

App code changes per `report.md` in the same plan folder — deploy after DDL verify.

## Sign-off

```
Approved by:
UTC date:
Notes:
```
