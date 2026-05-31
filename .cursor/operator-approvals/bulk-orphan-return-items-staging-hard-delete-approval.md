# Bulk Orphan Return Items — Staging Hard Delete Approval

**Default:** not approved until operator sets flags below.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Target | Hard-delete **5,333** soft-deleted bulk orphan `return_items` |
| Predicate | `deleted_at IS NOT NULL AND expected_item_id IS NOT NULL AND package_id IS NULL AND pallet_id IS NULL` |
| Preserve | 33 active rows (3 with `package_id`); all `expected_packages`; `products`; `product_identifier_map` |
| Production/original | forbidden |
| Active row delete | forbidden |
| Expected_packages mutation | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_BULK_ORPHAN_RETURN_ITEMS_STAGING_HARD_DELETE=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Signoff

```
Environment: STAGING ONLY (eiqfaapyumhixxoeltgu)
Status: APPROVED
Approved by: Main/user
UTC date: 2026-05-31
Rows to hard-delete: 5333 (already soft-deleted synthetic bulk orphans)
Method: DELETE FROM return_items (target predicate only)
```
