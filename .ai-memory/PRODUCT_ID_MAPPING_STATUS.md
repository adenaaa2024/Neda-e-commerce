# Product ID mapping status — V178

**Staging:** `eiqfaapyumhixxoeltgu`  
**Status:** **Partial but operational** — safe to build UI against contract; do not treat partial tables as 100%.

## Spine (100% — operational)

| Table | Coverage | Audit |
|-------|----------|-------|
| `products` (~17,001) | 100% | `product-id-mapping-materialization-v174/20260519T231000Z` |
| `product_identifier_map` (~12,605) | 100% | same |

## Wave-2 V176 — applied (partial operational tables)

| Table | Coverage | Notes |
|-------|----------|-------|
| `amazon_amazon_fulfilled_inventory` | **56.2%** | Tier-4 ASIN wave |
| `amazon_returns` | **82.2%** | |
| `amazon_manage_fba_inventory` | **73.6%** | |
| `slip_contents` | **0%** | No exact-match keys |
| `amazon_transactions` | **0%** | No SKU+ASIN pairs |

**Skipped:** `amazon_settlements` (blind bulk forbidden), `amazon_inventory_ledger` (later wave), `return_items` (6 test rows), `package_items` (absent).

**Folder:** `.cursor/audit-reports/product-id-mapping-wave-2-v176/`

## Claims linkage (live — separate from mapping SQL)

| Table | % | Unresolved |
|-------|---|------------|
| `claim_candidates` | **72.7%** | 2,474 |
| `claim_candidate_drafts` | **51.5%** | 4,427 |

Neda UI must show **unresolved/ambiguous** rows safely — mapping % does not mean all inbox rows are resolved.

## Policy

- Governed waves only; no auto-create from UI/OCR.
- Next: wave-3 / ledger when operator approves.

## UI contract

All linkage display: **`ProductLinkageDisplayContract`** + V178 `ProductLinkageDisplayBlock`.

## Update rule

After mapping audit → this file + `CURRENT_STATE.md` + paired history append.
