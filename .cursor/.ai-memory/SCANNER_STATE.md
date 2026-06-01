# Scanner state — Neda / operator-mobile

**Branch:** `feature/phase1-latest-stash-land` @ `999f765`  
**Staging:** `eiqfaapyumhixxoeltgu`  
**Last updated:** 2026-06-17 (`phase1-demo-ready-history-memory-sync` `20260617T120000Z`)

Contract reference: [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md) · [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md) · [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md)

## CORRECTED — return_items rule

**`return_items` = physical scanned units only.** Forecast belongs in **`expected_packages`**. Product linkage preserved on physical scan path.

| Staging metric | Value |
|----------------|------:|
| Active `return_items` | **33** |
| Proven physical scans (`package_id`) | **3** |
| `bulk_orphan` | **0** |
| `v_scanned_sum` | **3** |

## Item-level receive (canonical path)

1 RI per scan → `operatorReceiveItem` / `insertReturn` (qty=1) → `allocate_expected_items_for_return_item_ids` → `expected_item_id`.

## Delete / move / void — backend parity (COMPLETE staging)

| Action | Path | Status |
|--------|------|--------|
| Delete item | `operatorDeleteReturnItem` → `release_expected_item_unit` → soft void | **COMPLETE** |
| Void box | `voidOperatorIntakeBoxPackageAction` → release all RIs → soft void package | **COMPLETE** |
| Move box | `moveOperatorIntakeBoxToPalletAction` → `move_expected_item_unit` per RI | **COMPLETE** |

**Remaining (non-demo-blocking):** restore-RPC wiring to `undo_snapshots`; original DB undo migration apply — separate approval.

## Neda merge contract

Merge **must preserve** scanner UX + Phase1 governed allocation/release rules. See [NEDA_HANDOFF.md](NEDA_HANDOFF.md).

## P0 next

**PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE**
