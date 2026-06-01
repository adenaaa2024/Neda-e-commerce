# Return Items Bulk Orphan Final Cleanup (587) — Staging Approval

**Default:** not approved until operator sets flags below.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Target | Soft-delete remaining synthetic bulk orphan `return_items` (~587 live census) |
| Predicate | `deleted_at IS NULL AND expected_item_id IS NOT NULL AND package_id IS NULL AND pallet_id IS NULL` |
| Forbidden | Original DB, hard delete, EP rebuild, product/map changes, API sync |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_RETURN_ITEMS_BULK_ORPHAN_FINAL_CLEANUP_587=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Signoff

```
APPROVED_TO_RUN_STAGING=true
APPROVED_RETURN_ITEMS_BULK_ORPHAN_FINAL_CLEANUP_587=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
Approved by: operator
UTC date: 20260521
```
