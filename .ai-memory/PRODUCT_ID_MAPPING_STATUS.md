# Product ID mapping status — V183+

**Staging:** `eiqfaapyumhixxoeltgu`  
**Overall:** **Partial but operational**

## Spine (100%)

| Table | Coverage |
|-------|----------|
| `products` (~17,001) | 100% |
| `product_identifier_map` (~12,605) | 100% schema |

## UPC/GTIN gap (execute blocker)

| Item | Status |
|------|--------|
| `upc_code` on map | Present on staging |
| `lib/product-identifier-match.ts` | **Does not consume UPC/GTIN** |
| V182/V183 policy | Tier 4 **disabled** |
| Optional fix | `PRODUCT-IDENTIFIER-MATCH-UPC-GTIN-V182` |

## return_items FBM (V182 / V183)

| Item | Status |
|------|--------|
| V182 audit score | **72/100** |
| Dry-run | **Ready** — `20260521T140000Z` **PASS** |
| V183 dry-run | **0** `set_resolved` |
| Execute | **BLOCKED** |
| Data | **~7** rows — **fake/test** — not KPI truth |
| Unresolved at dry-run | **5** — thin FNSKU/SKU map; V185 **0** enrichable |

## expected_packages (V179)

Read-time linkage **PASS** — `fetchExpectedPackagesNedaRead`; no blind backfill.

## Inventory views (V179)

Per-row read enrich — not global mapping %.

## Wave-2 V176 (reference)

Bulk Amazon partial; no blind settlements; governed scope only.

## Claims (live)

**72.7%** candidates · **51.5%** drafts

## UI contract

`ProductLinkageDisplayContract` + safe unresolved/ambiguous labels.

## Post-V183 note

V186–V189 closed the staging **test cohort** separately — see `history-v189/`; V183 counts above are the **audit baseline**, not necessarily current row totals.

## Update rule

After mapping or FBM re-run → this file + `CURRENT_STATE.md` + history append (V182 base chain).
