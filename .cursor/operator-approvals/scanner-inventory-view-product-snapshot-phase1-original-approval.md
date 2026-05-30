# Scanner Inventory View Product Snapshot — Phase 1 (Original)

**Default:** not approved until operator sets flags below.

| Field | Value |
|-------|--------|
| Target ref | `kxsvedvpjldygtdbylsy` |
| Branch | `feature/product-canonicalization-v3` |
| Plan run | `scanner-inventory-view-product-snapshot-phase1-plan/20260529T190000Z` |
| Prerequisite | Staging apply + verification PASSED |

## SQL file to run

`.cursor/audit-reports/scanner-inventory-view-product-snapshot-phase1-plan/20260529T190000Z/ddl-original-draft.sql`

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
- Product auto-create from title/OCR/name matching

## Required operator flags

```text
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_SCANNER_INVENTORY_VIEW_SNAPSHOT_PHASE1_ORIGINAL=true
TARGET_SUPABASE_REF=kxsvedvpjldygtdbylsy
```

## Verification

`.cursor/audit-reports/scanner-inventory-view-product-snapshot-phase1-plan/20260529T190000Z/verification-original.sql`

## Rollback

`.cursor/audit-reports/scanner-inventory-view-product-snapshot-phase1-plan/20260529T190000Z/rollback-original.sql`

## Sign-off

```
Approved by:
UTC date:
Notes:
```
