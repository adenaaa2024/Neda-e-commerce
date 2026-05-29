# Removal expected allocation fix (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` (workspace-linked) |
| Production / original | forbidden unless separate approval |
| Prerequisite plan | `.cursor/audit-reports/removal-tracking-normalization-fix-plan/20260516T131500Z/` |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_EXPECTED_ALLOCATION_FIX=true
```

## Scope (when approved)

1. **Migration** — replace `rebuild_expected_packages_from_removals` to allocate by **detail item key + normalized tracking group** (sum shipment qty per group); one `detail_remainder` per detail when `detail_qty - sum(allocations) > 0`.
2. **Index** — replace `uq_expected_packages_derived_pair` grain for `detail_shipment` rows (allocation group key, not per physical `amazon_removal_shipments.id`).
3. **Lineage** — preserve `source_shipment_row_ids` (or representative `source_shipment_row_id` + json array) per allocation group.
4. **Tracking** — canonical normalized token on `expected_packages.tracking_number` (depends on tracking normalization execute or inline SQL normalizer).
5. **Staging rebuild** — `rebuild_expected_packages_from_removals(org, store)` after migration deploy.
6. **Verify** — contract probes: EP `detail_shipment` count ≈ distinct (detail, normalized tracking) groups; per-detail `sum(expected_scan_quantity) = shipped_quantity`; no duplicate remainder per `source_detail_row_id`.

## Explicit exclusions

- No production writes without new approval
- No Amazon API in this pass
- No `products.insert` / `product_identifier_map.insert`
- Do not reset `actual_scanned_count` or `id_slip_contents` on rebuild upsert
- Do not re-enable FastAPI generate-worklist for removal without guard

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_EXPECTED_ALLOCATION_FIX=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
```
