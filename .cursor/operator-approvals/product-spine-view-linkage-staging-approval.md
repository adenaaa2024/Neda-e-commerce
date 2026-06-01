# Product Spine View Linkage — Staging (expected_package_id)

**Default:** not approved until operator sets flags below.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v3` |
| Execute plan | `product-spine-linkage-execute-plan-readonly/20260530T150000Z/view-ddl-plan.md` |
| App hydration (prerequisite) | `product-spine-app-hydration-patch/20260530T160000Z/` |

## SQL file to run

`.cursor/audit-reports/product-spine-view-linkage-staging-execute/<run_id>/001_staging_inventory_views_expected_package_id.sql`

## Objects touched

| Object | Operation |
|--------|-----------|
| `public.v_inventory_item_status` | CREATE OR REPLACE VIEW — add `expected_package_id`, `product_display_name`; `product_name` only via `products.id = resolved_product_id` |
| `public.v_inventory_status` | CREATE OR REPLACE VIEW — propagate `expected_package_id`, `product_display_name` |

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
- Name/OCR/title-based product linking in view SQL

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_SPINE_VIEW_LINKAGE_STAGING=true
APPROVED_EXPECTED_PACKAGE_ID_VIEW_DDL_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Sign-off

```
Approved by: Main/user
UTC date: 20260530
Notes: PRODUCT-SPINE-VIEW-LINKAGE-STAGING-EXECUTE prompt authorization
```
