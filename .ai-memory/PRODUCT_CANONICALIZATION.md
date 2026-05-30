# Product canonicalization — PC Phase 01

**Branch:** `feature/product-canonicalization-v3` @ `4402064`  
**Last updated:** 2026-06-09 (`history-memory-align-after-phase1-census` `20260609T140000Z`)

## DB parity + product spine

| Surface | Status |
|---------|--------|
| Staging view + slip cols | **PASS** — `20260529T231120Z` |
| Original view + slip cols | **PASS** — `20260529T234437Z` (**CORRECTED** — was BLOCKED) |
| Staging true linkage + browser smoke | **PASS** — `20260530T171500Z`; `1552698729`, `X003S8RCBH` |
| Original product spine view DDL | **PENDING** — `expected_package_id`, `product_display_name` |

## Original EP backfill dry-run (read-only)

**Script:** `scripts/original-product-map-expected-packages-backfill-dryrun.ts`

| Class | Meaning | Count |
|-------|---------|------:|
| A | Existing `product_identifier_map` hit → EP update only | **0** |
| B | Unique `products.id` → map insert + EP update | **0** |
| C | Needs product seed (`needs_product_seed`) | **447** |
| D | Ambiguous multi-product | **0** |
| E | Missing identifiers | **0** |

**Execute:** **NOT READY** — wave 1 allows Class A/B only; Class C explicitly excluded per approval doc.

**SUPERSEDED for sequencing:** Exploratory dry-run completed read-only before product spine view DDL on original. **Re-run after** `PRODUCT-SPINE-VIEW-LINKAGE-ORIGINAL-EXECUTE`.

## Removal product linkage (checkpoint — unchanged)

SP-API fetch / domain sync / rebuild: **no product create**. Canonical path: `resolved_product_id` via map.

## Spine

~17,033 `products` · V192 contract locked · `npm run check:product-resolution-contract-v192`
