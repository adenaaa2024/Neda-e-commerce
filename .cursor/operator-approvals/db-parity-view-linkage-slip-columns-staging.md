# DB Parity — View Linkage + Slip Identifier Columns (Staging)

**Default:** not approved until operator sets flags below.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v3` |
| Reconcile run | `db-parity-view-linkage-column-naming-reconcile/20260530T153000Z` |

## SQL files to run (in order)

1. `.cursor/audit-reports/db-parity-view-linkage-column-naming-reconcile/20260530T153000Z/001_staging_inventory_views_product_linkage.sql`
2. `.cursor/audit-reports/db-parity-view-linkage-column-naming-reconcile/20260530T153000Z/002_staging_slip_identifier_columns.sql`

## Objects touched

| Object | Operation |
|--------|-----------|
| `public.v_scanned_items_counted` | CREATE OR REPLACE VIEW |
| `public.v_inventory_item_status` | CREATE OR REPLACE VIEW |
| `public.v_inventory_status` | CREATE OR REPLACE VIEW |
| `public.slip_contents` | ADD COLUMN IF NOT EXISTS (upc, fnsku, parsed_*, resolver cols) |

## Allowed

- View DDL only (3 views)
- Idempotent slip_contents column adds per reconciled naming matrix

## Forbidden

- Copy staging→original data
- INSERT/UPDATE products
- INSERT/UPDATE product_identifier_map
- Resolver/backfill data mutations
- Claims tables
- `package_items`
- Product auto-create from title/OCR

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_VIEW_LINKAGE_SLIP_DDL_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Rollback

`.cursor/audit-reports/db-parity-view-linkage-column-naming-reconcile/20260530T153000Z/rollback-staging.sql`

## Verification

`.cursor/audit-reports/db-parity-view-linkage-column-naming-reconcile/20260530T153000Z/verification-staging.sql`

## Sign-off

```
Approved by: Maysam Ebrahimi
UTC date: 05292026
Notes:
```
