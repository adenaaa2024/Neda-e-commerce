# Expected Linkage Return Items Backfill Scale Wave2 Approval

**Default:** not approved until operator flags are set.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Sample evidence | EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-SAMPLE-EXECUTE PASS |
| Orphan pool (post-sample) | ~5,283 rows (EP resolved, return_items.resolved_product_id null) |

## Allowed

- UPDATE `return_items.resolved_product_id` from linked `expected_packages.resolved_product_id`
- Same guards as sample: EP resolved, return unresolved, no legacy `product_id` conflict
- Batched apply max **500** rows per batch with per-batch verification

## Forbidden

- Product create / Class C seed
- `product_identifier_map` insert
- Original / production writes
- Unrelated `return_items` changes
- Hard deletes

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_RETURN_ITEMS_EP_COPY_SCALE=true
APPROVED_RETURN_ITEMS_SCALE_MAX_BATCH=500
APPROVED_PRODUCT_CREATE=false
APPROVED_MAP_INSERT=false
APPROVED_CLASS_C_SEED=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Sign-off

```
Approved by: Main/user (EXPECTED-LINKAGE-RETURN-ITEMS-BACKFILL-SCALE-WAVE2)
UTC date: 2026-05-21
Notes: Scale Plan B after sample PASS. Staging only. Batch 500. Stop on mismatch.
```
