# Phase 1 physical return_item linkage — single row approval

**Default:** not approved until operator flags are set.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| return_item_id | `512cd6ce-1769-494f-a752-a743509cae94` |
| Resolution | Copy `expected_packages.resolved_product_id` (map-confirmed exact one product) |
| Product id | `15c2b80e-c3d6-4799-aeba-718a10fccbbd` |

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PHASE1_PHYSICAL_RI_LINKAGE_FIX=true
APPROVED_RETURN_ITEM_IDS=512cd6ce-1769-494f-a752-a743509cae94
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Sign-off

```
Approved by: Main/user (PHASE1-PRODUCT-LINKAGE-REMAINING-CRITICAL-FIX)
UTC date: 2026-05-21
Notes: Single physical RI; EP+map exact match; no product create; no map writes.
```
