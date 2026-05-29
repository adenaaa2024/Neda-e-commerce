# Removal API intake — architecture checkpoint

**Branch:** `feature/product-canonicalization-v2`  
**Last updated:** 2026-05-29 (`removal-api-product-linkage-checkpoint` `20260529T120000Z`)  
**Operational state:** [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md) (fetch PASS, allocation fix PASS, view grain, Neda fix)  
**Migration anchor:** `supabase/migrations/20260631_expected_packages_derived_rebuild.sql` (superseded by `20260632` detail-driven rebuild per validation script)

## Terminology map (business ↔ Amazon ↔ repo)

| Business term | Amazon SP-API report | Sync kind | Table | Grain |
|---------------|---------------------|-----------|-------|-------|
| **Removal Shipment Detail** | `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` | `REMOVAL_ORDER` | `amazon_removals` | Line-level demand: sku, fnsku, disposition, qty |
| **Removal Shipment** | `GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA` | `REMOVAL_SHIPMENT` | `amazon_removal_shipments` | Shipment line + tracking, carrier, shipment_date |

## Intake layer

| Rule | Detail |
|------|--------|
| Operational intake | **`expected_packages`** only |
| **`accepted_packages`** | **Does not exist** |
| Rebuild function | **`rebuild_expected_packages_from_removals(org_id, store_id?)`** |

## Quantity allocation contract (verified PASS)

**Run:** `removal-quantity-allocation-validation/20260528T210000Z`

| Metric | Value |
|--------|------:|
| Detail lines simulated | **1,629** |
| Invariant failures | **0** (all PASS) |
| Overflow conflicts (intentional flag) | **1** |
| Orphan shipment lines | **0** |
| Live EP vs simulation mismatches | **498** (staleness/drift — **not** logic failure) |

### Quantity rules

| Symbol | Meaning |
|--------|---------|
| **D** | `amazon_removals.shipped_quantity` |
| **S** | Sum of matched shipment line `shipped_quantity` |

| Row type | Rule |
|----------|------|
| `detail_shipment` | `expected_scan_quantity` = **shipment line** `shipped_quantity` (not prorated) |
| `detail_remainder` | `GREATEST(D − S, 0)` when `S < D` or no shipments |
| Overflow | `S > D` → `shipment_overflow_conflict`; no remainder row |

**Not** one row per unit. **Not** SKU-only join.

### Join key (NULL-safe)

```text
organization_id + store_id + order_id + order_type + order_date + sku + fnsku + disposition
```

Tracking / carrier / `shipment_date` attach only after valid line match (fill-only).

## SP-API fetch worker plan (execution order)

| Step | Action |
|------|--------|
| 1 | Fetch **order detail** report first → synthetic `raw_report_uploads` |
| 2 | Fetch **shipment detail** report second → synthetic upload |
| 3 | **`runPipeline: false`** at fetch — stop at `synthetic_upload_ready` |
| 4 | Import/sync under **separate** approval (`runPipeline: true` or manual pipeline) |

**Plan script:** `scripts/sp-api-removal-reports-fetch-worker-plan.ts`  
**Approval:** `sp-api-removal-shipment-fetch-approval.md`

## Resolver plan

| Phase | Scope |
|-------|--------|
| Rebuild | Quantity + tracking only; **`product_id` not set** |
| Post-rebuild | Resolver backfill on `expected_packages` |
| Forbidden | Product creation during fetch, rebuild, or resolver backfill |

## Product creation contract

No product create on fetch/rebuild/resolver — governed promotion with Amazon evidence only.

## Next active work

1. **SP-API-REMOVAL-REPORTS-FETCH-EXECUTE** — order then shipment; `runPipeline:false`  
2. **REMOVAL-INTAKE-REBUILD-EXECUTE** — clear **498** live EP drift after sync (approval-gated)  
3. **REMOVAL-PRODUCT-RESOLVER-WIRE** — post-rebuild backfill  

## Evidence

`removal-quantity-allocation-validation/20260528T210000Z/` · `scripts/sp-api-removal-reports-fetch-worker-plan.ts` · `scripts/sp-api-removal-shipment-detail-api-plan.ts`
