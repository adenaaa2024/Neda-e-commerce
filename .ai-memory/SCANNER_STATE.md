# Scanner state — Neda / operator-mobile

**Branch:** `feature/product-canonicalization-v3` @ `4402064`  
**Staging:** `eiqfaapyumhixxoeltgu`  
**Last updated:** 2026-06-09 (`history-memory-align-after-phase1-census` `20260609T140000Z`)

Contract reference: [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md)

## Product spine true linkage — staging PASS

| Check | Result |
|-------|--------|
| Execute | **PASS** — `product-spine-view-linkage-staging-execute/20260530T171500Z/` |
| Browser smoke tracking `1552698729` | **PASS** → `product_display_name` = `Bobs Red Mill GF Baking Soda 4/16 Oz` |
| Browser smoke FNSKU `X003S8RCBH` | **PASS** |
| True chain | `view.expected_package_id` → `expected_packages.id` → `expected_packages.resolved_product_id` → `products.id` |

## DB parity — slip/view linkage

| Surface | Status |
|---------|--------|
| Staging | **PASS** — `20260529T231120Z` |
| Original | **PASS** — `db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/` |

**CORRECTED:** Original was **BLOCKED** in `20260608T120000Z` memory — **SUPERSEDED**.

## Original — product spine view DDL pending

`expected_package_id` + `product_display_name` on inventory views — `product-spine-view-linkage-original-approval.md` not yet applied.

## Item-level receive (census: good)

1 RI row per scan → `expected_item_id` allocation via DB RPCs. Allocation mostly implemented in DB.

## Delete/void gap (census)

Delete/void paths **do not fully wire** `release_expected_item_unit` — **DELETE-RELEASE-WIRING** is next.

## Neda linkage branch

Build/guard **PASS**; merge **WAIT** until original product spine view DDL + smoke.

## Evidence

`product-spine-scanner-browser-smoke-1552698729/` · `product-spine-view-linkage-staging-execute/20260530T171500Z/` · `db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/`
