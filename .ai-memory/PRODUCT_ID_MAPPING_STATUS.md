# Product ID mapping status — V176

**Staging ref:** `eiqfaapyumhixxoeltgu`  
**Spine audit:** `product-id-mapping-materialization-v174/20260519T231000Z`  
**Latest wave:** `product-id-mapping-wave-2-v176/20260520T132000Z` (**PASS** execute)

## Spine (100%)

| Table | Rows | Coverage |
|-------|------|----------|
| `products` | 17,001 | 100% |
| `product_identifier_map` | 12,605 | 100% |

## Wave-2 results (post-execute)

| Table | Coverage | Notes |
|-------|----------|-------|
| `amazon_amazon_fulfilled_inventory` | **56.2%** (10,969 / 19,503) | +10,894 tier-4 ASIN |
| `amazon_returns` | **82.2%** (2,116 / 2,574) | +34 tier-4 |
| `amazon_manage_fba_inventory` | **73.6%** (1,257 / 1,709) | +3 tier-4 |
| `slip_contents` | **0%** (0 / 11) | No unambiguous keys |
| `amazon_transactions` | **0%** (0 / 600) | No exact SKU+ASIN pairs |
| `claim_candidates` | **72.7%** | +33 indirect via returns |
| `claim_candidate_drafts` | **51.5%** | +66 from resolver pass in wave |

**Total row updates (wave-2 SQL):** 10,931

## Skipped by policy

| Table | Reason |
|-------|--------|
| `amazon_settlements` | Blind bulk forbidden |
| `amazon_inventory_ledger` | Ambiguous / 0% — no wave |
| `return_items` | Test/fake cohort (6 rows) |
| `package_items` | Absent ✓ |

## Claims (resolver — separate from wave-2)

| Table | Coverage | Audit |
|-------|----------|-------|
| `claim_candidates` | **72.7%** | wave-2 post-count; V175 baseline 72.3% |
| `claim_candidate_drafts` | **51.5%** | V176 FK + wave-2 |

## Tooling

```bash
npm run smoke:product-id-mapping-v174
npm run smoke:product-id-mapping-wave-2-v176
```

## UI contract

All linkage display via **`ProductLinkageDisplayContract`**.

## Update procedure

After mapping audit: copy counts from audit `summary.md` / matrix JSON → this file + `CURRENT_STATE.md` + paired history append.
