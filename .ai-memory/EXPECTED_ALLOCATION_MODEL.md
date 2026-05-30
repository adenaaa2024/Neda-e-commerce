# Expected allocation model

**Last updated:** 2026-06-09 (`history-memory-align-after-phase1-census` `20260609T140000Z`)  
**Related:** [SCANNER_STATE.md](SCANNER_STATE.md) · [UNDO_AUDIT_ARCHITECTURE.md](UNDO_AUDIT_ARCHITECTURE.md)

## Phase 1 allocation census — COMPLETE

| Finding | Status |
|---------|--------|
| Allocation mostly in DB | **yes** — `allocate_expected_items_for_return_item_ids`, `release_expected_item_unit`, item-level migrations |
| Item-level receive | **good** — 1 RI → 1 EP unit via `expected_item_id` |
| Delete/void release wiring | **gap** — delete/void does **not** fully wire `release_expected_item_unit` |
| Cascade/undo | **draft not applied** — `20260901120000_delete_cascade_undo_audit_foundation.sql` |

## Two-grain model (canonical)

| Layer | Table | Grain |
|-------|-------|-------|
| Physical scan | **`return_items`** | Item-level — 1 row = 1 item |
| Expected allocation | **`expected_packages`** | Group-level — `expected_scan_quantity`, `receive_allocated` |

**Link:** `return_items.expected_item_id` → `expected_packages.id`

## Migrations

`20260829120000_expected_receive_split.sql` · `20260830120000_expected_receive_split_item_level.sql` · commit `51bc597`

## Next

1. **DELETE-RELEASE-WIRING**
2. **DELETE-UNDO-RETENTION-ARCHITECTURE**
