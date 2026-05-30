# Current state — canonical system memory

**Last updated:** 2026-06-09 (`history-memory-align-after-phase1-census` `20260609T140000Z`)  
**Branch:** `feature/product-canonicalization-v3` @ `4402064`

## Product spine true linkage — PASS (staging)

| Check | Status |
|-------|--------|
| Staging true-link execute | **PASS** — `product-spine-view-linkage-staging-execute/20260530T171500Z/` |
| Browser smoke tracking `1552698729` | **PASS** |
| Browser smoke FNSKU `X003S8RCBH` | **PASS** |
| True chain | `view.expected_package_id` → `expected_packages.id` → `expected_packages.resolved_product_id` → `products.id` |

Display: `product_display_name` = `Bobs Red Mill GF Baking Soda 4/16 Oz` (tracking smoke).

## DB parity — slip/view linkage

| Surface | Status | Evidence |
|---------|--------|----------|
| Staging | **PASS** | `db-parity-view-linkage-slip-columns-staging-execute/20260529T231120Z/` |
| Original slip/view | **PASS** | `db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/` |

**CORRECTED:** Prior memory (`20260608T120000Z`) said original parity **BLOCKED** — **SUPERSEDED**. Original slip/view parity is **PASS**.

## Original — still pending (product spine view DDL)

Original needs **`expected_package_id` + `product_display_name`** on inventory views — approval/apply pending (`product-spine-view-linkage-original-approval.md`). Prerequisite slip/view parity **PASS** (`234437Z`).

## Expected allocation census (complete)

| Finding | Status |
|---------|--------|
| Allocation mostly in DB | **yes** — RPCs/migrations applied |
| Item-level receive | **good** |
| Delete/void → `release_expected_item_unit` | **not wired** (census gap — next work) |
| Cascade/undo draft | **not applied** — `20260901120000_delete_cascade_undo_audit_foundation.sql` |

## Removal pipeline

Verify gate **aligned**; burn-in retry **PASS**; resolver **+6 EP** on staging.

## Platform refs

| Role | Ref |
|------|-----|
| Staging | `eiqfaapyumhixxoeltgu` |
| Original | `kxsvedvpjldygtdbylsy` |
| Production | `NOT_CREATED_YET` |

Detail: [NEXT_ACTIONS.md](NEXT_ACTIONS.md) · [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) · [EXPECTED_ALLOCATION_MODEL.md](EXPECTED_ALLOCATION_MODEL.md)

**Last memory sync:** `history-memory-align-after-phase1-census/20260609T140000Z/`
