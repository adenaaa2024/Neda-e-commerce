# Removal tracking normalization fix (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` (workspace-linked) |
| Production / original | forbidden unless separate approval |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_TRACKING_NORMALIZATION_FIX=true
```

## Scope (when approved)

1. Add shared **`normalizeRemovalTrackingOperational`** helper (TypeScript; mirror in SQL for backfill).
2. Wire **ingest** paths: `mapRowToAmazonRemovalShipment`, `mapRowToAmazonRemoval`, FastAPI `_merge_shipment_into_null_slot` / shipment archive (or deprecate duplicate path).
3. **Staging data cleanup:** normalize `amazon_removal_shipments.tracking_number` where comma-list is repeated single token (~356 rows on linked DB probe); preserve original in `raw_row`.
4. **Rebuild:** `rebuild_expected_packages_from_removals` + `rebuild_shipment_tree_from_removal_shipments` use normalized tracking.
5. **View parity:** simplify `v_inventory_item_status` to stop `split_part` when domain/expected are clean.
6. Re-run `rebuild_expected_packages_from_removals` after cleanup (pairs with allocation rebuild approval).

## Explicit exclusions

- No production writes without new approval file
- No silent pick of first token when **multiple distinct** tracking values exist (flag manual / `tracking_conflict`)
- No Amazon API calls in normalization-only execute

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_TRACKING_NORMALIZATION_FIX=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
```
