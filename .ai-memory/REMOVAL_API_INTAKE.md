# Removal API intake — architecture checkpoint

**Branch:** `feature/product-canonicalization-v2`  
**Last updated:** 2026-05-28 (`removal-api-product-resolution-checkpoint` `20260528T180000Z`)  
**Migration anchor:** `supabase/migrations/20260631_expected_packages_derived_rebuild.sql`

## Terminology map (business ↔ Amazon ↔ repo)

| Business term | Amazon SP-API report | Sync kind | Table | Grain |
|---------------|---------------------|-----------|-------|-------|
| **Removal Shipment Detail** | `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` | `REMOVAL_ORDER` | `amazon_removals` | Line-level demand: sku, fnsku, disposition, qty |
| **Removal Shipment** | `GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA` | `REMOVAL_SHIPMENT` | `amazon_removal_shipments` | Shipment line + tracking, carrier, shipment_date |

Do not swap Amazon report names: both end in `…DETAIL_DATA`; **order detail = item truth**, **shipment detail = container/tracking truth**.

## Intake layer

| Rule | Detail |
|------|--------|
| Operational intake | **`expected_packages`** only |
| **`accepted_packages`** | **Does not exist** — forbidden to introduce without charter |
| Rebuild function | **`rebuild_expected_packages_from_removals(org_id, store_id?)`** — current, idempotent |

## Row grain (`expected_packages`)

| `build_source` | Grain | `source_shipment_row_id` |
|----------------|-------|--------------------------|
| `detail_shipment` | One row per **detail × shipment** match | `amazon_removal_shipments.id` |
| `detail_remainder` | Unmatched detail qty (remainder) | **NULL** |
| `legacy` | Pre-rebuild canonical rows | n/a |

- **`expected_scan_quantity`** on matched rows — **not** one `expected_packages` row per physical unit.
- Remainder when sum(shipment qty) &lt; detail `shipped_quantity`.
- **`shipment_overflow_conflict`** when sum(shipment qty) &gt; detail `shipped_quantity`.

## Join contract (NULL-safe)

```text
organization_id + store_id + order_id + order_type + order_date + sku + fnsku + disposition
```

| Allowed | Forbidden |
|---------|-----------|
| Full 7-tuple join (NULL-safe `IS NOT DISTINCT FROM`) | **SKU-only** join |
| | **FNSKU-only** join |

**Tracking / carrier / `shipment_date`:** attach to `amazon_removals` only **after** valid line match (fill-only enrichment — not join identity).

## Product creation contract

| Rule | Detail |
|------|--------|
| Removal fetch / rebuild | **No** product creation |
| Product promotion | Governed only, with **real Amazon evidence** |
| Forbidden | Title-only / product-name-only creation |

Resolver-on-save and V192 contract apply to operator UI paths separately.

## SP-API track (planned)

| Step | Status |
|------|--------|
| Reports API fetch worker (order + shipment reports) | **Planned** — `scripts/sp-api-removal-reports-fetch-worker-plan.ts` |
| Reuse existing Phase 3/4 sync after synthetic upload | Design |
| Live SP-API removal pull | **Not wired** — approval-gated |

**Approvals:** `sp-api-removal-shipment-fetch-approval.md` · `removal-shipment-normalized-import-staging-approval.md`

## Next active work (ordered)

1. **REMOVAL-QUANTITY-ALLOCATION-VALIDATION** — read-only census vs rebuild contract  
2. **SP-API-REMOVAL-REPORTS-FETCH-WORKER** — implement + approval (after plan review)  
3. **REMOVAL-PRODUCT-RESOLVER-WIRE** — map `expected_packages` lines to `products` without auto-create  
4. **`rebuild_expected_packages_from_removals` EXECUTE** — after sync + validation PASS  

## Evidence / plans

`scripts/sp-api-removal-shipment-detail-api-plan.ts` · `scripts/sp-api-removal-reports-fetch-worker-plan.ts` · `scripts/removal-quantity-allocation-validation.ts` · `lib/import-sync-mappers.ts`
