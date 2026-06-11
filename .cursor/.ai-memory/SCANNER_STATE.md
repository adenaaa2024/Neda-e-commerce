# Scanner state — Neda / operator-mobile

**Branch:** `feature/phase1-latest-stash-land` @ `999f765`  
**Staging:** `eiqfaapyumhixxoeltgu`  
**Last updated:** 2026-06-11 (`phase-scanner-final-qa-neda-handoff` `20260611T045500Z`)

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

**PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE** · **PHASE-SCANNER-FINAL-QA-AND-NEDA-HANDOFF** (2026-06-11)

## Scanner QA handoff (2026-06-11)

| Item | Status |
|------|--------|
| Phase 6D pallet close/reopen | **VERIFY PASS** (code) |
| Phase 6E shipment close/reopen | **VERIFY PASS** (code; build gate skipped) |
| Phase 6D unified review engine | **VERIFY PASS** |
| Box close review regression | **PASS** — SAFE_FOR_NEDA_PULL yes |
| Backend receive path | **~90–95%** — Neda UI polish lane |
| Move item (operator-mobile) | **NOT WIRED** — delete + move box only |
| Runtime staging smoke | **Operator `--execute`** — not re-run this session |

**Neda:** polish UI only on modals + scan page; do not touch server actions, resolver, migrations.

Evidence: `phase6d-pallet-close-reopen-verify` · `phase6e-shipment-close-reopen-verify` · `scanner-box-close-review-regression`
