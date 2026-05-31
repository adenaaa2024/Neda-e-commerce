# Current state — canonical system memory

**Last updated:** 2026-06-14 (`architecture-correction-history-memory-sync` `20260614T120000Z`)  
**Branch:** `feature/phase1-latest-stash-land` @ `9a5cda8` · **main** `4402064` — **no merge**

## CORRECTED — Scanner / Expected / Return / Claims

**Full doc:** [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md)

| Rule | Status |
|------|--------|
| `return_items` = physical scanned units only | **LOCKED** |
| Forecast/API/removal in `expected_packages` — not bulk `return_items` | **LOCKED** |
| No EP→RI `resolved_product_id` bulk copy without proven physical scan | **LOCKED** |
| Bulk/orphan RI hard-delete (staging) | **COMPLETE** — **5333** removed |
| Active `return_items` | **33** (total **33**, `bulk_orphan` **0**, `active_with_package` **3**) |
| `v_scanned_sum` | **3** |
| Spine tables | **unchanged** — `products` **17033**, `expected_packages` **9459** (**9139** resolved), `product_identifier_map` **16811** |
| Returns claims work queue | **UNSAFE** until physical-anchor gate patched |
| Auto-promote | **off** |
| Merge / deploy / original apply | **NO** |

**Product Core:** protected backbone — see [PRODUCT_CORE_ARCHITECTURE.md](PRODUCT_CORE_ARCHITECTURE.md).

## Execution policy (mandatory)

```
census -> classify -> sample dry-run -> approval -> sample apply -> verify -> next wave
```

| Gate | Rule |
|------|------|
| Broad product import | **FORBIDDEN** |
| Product Core rewrite | **FORBIDDEN** without change gate |
| Merge to main | **NO** |
| Cron apply | **off** |
| Original DB changes | **explicit approval only** |
| Bulk RI from expected/API/removal | **FORBIDDEN** |

## P0 next

1. **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION**
2. **PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION** — **3399** conflicts

## Product sheet import dry-run (read-only)

| Bucket | Count |
|--------|------:|
| Total rows | **4479** |
| Needs-review / conflicts | **3399** |

## Product enrichment

Browser-loop update button — needs backend job in **waves**.

## Claims (returns-first)

Cutoff dates **unconfigured** · returns work queue **unsafe until physical-anchor gate** · auto-promote **off** · manual grouping UI **not built**.

## Removal

Non-overflow mismatch **0** · duplicate EP **0** · cron **off**

Detail: [NEXT_ACTIONS.md](NEXT_ACTIONS.md) · [ROADMAP.md](ROADMAP.md) · [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md)

**Last memory sync:** `architecture-correction-history-memory-sync/20260614T120000Z/`
