# Scanner state — Neda / operator-mobile

**Branch:** `feature/phase1-latest-stash-land` @ `9a5cda8`  
**Staging:** `eiqfaapyumhixxoeltgu`  
**Last updated:** 2026-06-14 (`architecture-correction-history-memory-sync` `20260614T120000Z`)

Contract reference: [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md) · [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md)

## CORRECTED — return_items rule

**`return_items` = physical scanned units only.** Forecast belongs in **`expected_packages`**.

| Staging metric | Value |
|----------------|------:|
| `return_items` total / active | **33** / **33** |
| Proven physical scans (`package_id` set) | **3** |
| `bulk_orphan` | **0** (**5333** hard-deleted 2026-06-14) |
| `v_scanned_sum` | **3** |
| `products` | **17,033** (unchanged) |
| `expected_packages` | **9,459** (**9,139** resolved; unchanged) |
| `product_identifier_map` | **16,811** (unchanged) |

Wave2 EP→RI `resolved_product_id` copy **reverted (PASS)**. Bulk/orphan remediation **COMPLETE**.

## Item-level receive (canonical path)

1 RI per scan → `operatorReceiveItem` / `insertReturn` (qty=1) → `allocate_expected_items_for_return_item_ids` → `expected_item_id`.

## Neda delete / move / void (implemented)

| Action | Path |
|--------|------|
| Delete item | `operatorDeleteReturnItem` → `release_expected_item_unit` → soft void |
| Void box | `voidOperatorIntakeBoxPackageAction` → release all RIs → soft void package |
| Move box | `moveOperatorIntakeBoxToPalletAction` → reparent package → `move_expected_item_unit` per RI |

## Product spine true linkage — staging PASS

Execute: `product-spine-view-linkage-staging-execute/20260530T171500Z/` — linkage on **expected_packages** spine, not bulk RI fill.

## DB parity — slip/view linkage

Staging **PASS** `20260529T231120Z` · Original **PASS** `20260529T234437Z`

## Deploy gate

Merge **WAIT** — no merge to main; safe action is feature-branch commit/push only.

## P0 next

**INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION**

## Evidence

`architecture-correction-history-memory-sync/20260614T120000Z/` · `full-scanner-expected-returns-claims-architecture-readonly/20260531T084101Z/`
