# Removal carrier normalization + view safe fix (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` (workspace-linked) |
| Production / original | forbidden unless separate approval |
| Prerequisite | Tracking normalization execute PASS |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_CARRIER_NORMALIZATION_FIX=true
```

## Scope (when approved)

1. **`normalizeRemovalCarrierOperational`** (TS) + **`normalize_removal_carrier_operational`** (SQL).
2. **Ingest:** `mapRowToAmazonRemovalShipment`, `mapRowToAmazonRemoval` operational `carrier`.
3. **Staging cleanup:** `amazon_removal_shipments.carrier`, `expected_packages.carrier`, `amazon_removals.carrier`, `packages.carrier_name` (deduped-repeated only).
4. **Views:** `v_scanned_items_counted`, `v_inventory_item_status` use SQL normalizers (no `split_part` comma hack for carrier/tracking).
5. **No** `rebuild_expected_packages_from_removals` / allocation qty changes in this pass.

## Explicit exclusions

- No production / original writes
- No Amazon API
- No silent pick of first token on **multi_conflict** carriers
- Do not modify `raw_row` / `raw_data`

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_CARRIER_NORMALIZATION_FIX=true
Approved by: Maysam Ebrahimi
UTC date: 05282026
```
