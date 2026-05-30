# Product Spine View Linkage — Original (expected_package_id + product_display_name)

**Default:** not approved until operator sets all flags below to `true`.

| Field | Value |
|-------|--------|
| Target ref | `kxsvedvpjldygtdbylsy` |
| Environment | Original / production-linked DB |
| Branch | `feature/product-canonicalization-v3` |
| Staging evidence (PASS) | `.cursor/audit-reports/product-spine-view-linkage-staging-execute/20260530T171500Z/` |
| Original plan (this wave) | `.cursor/audit-reports/product-spine-view-linkage-original-plan-approval/20260530T210000Z/` |

## SQL file to run (after approval)

`.cursor/audit-reports/product-spine-view-linkage-original-plan-approval/20260530T210000Z/001_original_inventory_views_expected_package_id.sql`

## Rollback (pre-image from live snapshot)

`.cursor/audit-reports/product-spine-view-linkage-original-plan-approval/20260530T210000Z/rollback-original.sql`

## Objects touched

| Object | Operation |
|--------|-----------|
| `public.v_inventory_item_status` | `DROP` + `CREATE VIEW` — add `expected_package_id`, `product_display_name`; `product_name` only when `products.id = resolved_product_id` |
| `public.v_inventory_status` | `DROP` + `CREATE VIEW` — propagate `expected_package_id`, `product_display_name` |
| `public.v_scanned_items_counted` | **No change** (not required for parity; unchanged on staging PASS) |

## Allowed

- View DDL only (2 views)
- Read-only verification queries on original after apply
- PostgREST schema reload (`NOTIFY pgrst, 'reload schema'`)

## Forbidden

- Copy staging → original **data** (rows, resolver results, products)
- `INSERT` / `UPDATE` on `products`, `product_identifier_map`, `expected_packages`, `return_items`
- Resolver or map backfill execute
- Product auto-create from title, OCR, or name matching in view SQL
- `catalog_products` join for display name in inventory views
- `package_items` table or references
- Blind apply of staging connection URL on original ref

## Prerequisites (operator checklist)

1. Staging true-link proof **PASS** — `product-spine-view-linkage-staging-execute/20260530T171500Z/`
2. App hydration patch merged or deployed if gate reads `product_display_name` / `expected_package_id` (see `product-spine-app-hydration-patch/20260530T160000Z/`)
3. DB parity linkage columns already on original (`db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/`) — `resolved_product_id`, `product_name` via `products` join
4. Maintenance window acceptable for brief view replace on production-linked DB

## Required operator flags

```text
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_PRODUCT_SPINE_VIEW_LINKAGE_ORIGINAL=true
APPROVED_EXPECTED_PACKAGE_ID_VIEW_DDL_ORIGINAL=true
TARGET_SUPABASE_REF=kxsvedvpjldygtdbylsy
```

## Sign-off

```
Approved by: Main/user
UTC date: 20260530
Notes: PRODUCT-SPINE-VIEW-LINKAGE-ORIGINAL-EXECUTE prompt authorization
```
