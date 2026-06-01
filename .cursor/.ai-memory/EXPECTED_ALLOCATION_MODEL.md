# Expected allocation model

**Last updated:** 2026-06-14 (`architecture-correction-history-memory-sync` `20260614T120000Z`)  
**Related:** [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md) · [SCANNER_STATE.md](SCANNER_STATE.md) · [UNDO_AUDIT_ARCHITECTURE.md](UNDO_AUDIT_ARCHITECTURE.md)

## CORRECTED — two-grain model (canonical)

| Layer | Table | Grain |
|-------|-------|-------|
| Physical scan | **`return_items`** | 1 row = 1 **physical** scanned unit only |
| Expected forecast | **`expected_packages`** (root) | Group — `expected_scan_quantity`, API/removal/import |
| Allocation unit | **`expected_packages`** (`build_source = 'receive_allocated'`) | 1 child = 1 allocated unit |

**Link:** `return_items.expected_item_id` → allocated EP child — set **after** physical insert via RPC.

**FORBIDDEN:** bulk-insert `return_items` from expected/API/removal data; treat `return_items` as expected read model.

## Allocation RPCs (staging applied)

`allocate_expected_item_unit` · `allocate_expected_items_for_return_item_ids` · `release_expected_item_unit` · `move_expected_item_unit`

Migrations: `20260829120000_expected_receive_split.sql` · `20260830120000_expected_receive_split_item_level.sql`

## Delete/void (corrected)

Operator + returns delete paths **do** call `release_expected_item_unit` via `softVoidReturnItemWithExpectedRelease` and `voidOperatorIntakeBoxPackageAction`.

**Remaining gap:** cascade/undo audit migration `20260901120000_delete_cascade_undo_audit_foundation.sql` — draft/not applied.

## Staging data note (CORRECTED 2026-06-14)

**5333** bulk/orphan `return_items` **hard-deleted** on staging. Active RI **33**; `bulk_orphan` **0**; proven physical scans (`package_id`) **3**. Spine unchanged.

## Next

1. **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION**
2. **DELETE-CASCADE-UNDO-MIGRATION-APPLY-STAGING** (after approval)
