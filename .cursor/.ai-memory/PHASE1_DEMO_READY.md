# Phase1 demo readiness — authoritative checkpoint

**Branch:** `feature/phase1-latest-stash-land` @ `999f765`  
**Last updated:** 2026-06-17 (`phase1-demo-ready-history-memory-sync` `20260617T120000Z`)  
**Main:** `4402064` — **no merge**

## Demo-ready surfaces (COMPLETE)

| Surface | Status |
|---------|--------|
| Automation API Center | **COMPLETE** — single API automation/config per company/store |
| Data Management → Imports | **COMPLETE** — file-import only; UniversalImporter + history remain |
| Product Core auto-create | **ENFORCED** — governed seed approvals only; no resolver redesign |
| Vendor 1883 staging cleanup | **COMPLETE** — `1883` → `1883 Maison Routin`; remaining exact `vendor_name` **0** |
| Product Hub vendor warnings | **Generic/data-driven architecture** — effective vendor label (`vendor_id` / `vendors.name` / cache); not a one-off 1883 hack |
| Scanner / `return_items` | **Physical scans only**; product linkage preserved |
| `expected_packages` | **Forecast/API/removal** — not bulk RI |
| Product sheet sample wave | **0 product creates** |

## Scanner backend — delete / move / void parity

| Path | Staging | Detail |
|------|---------|--------|
| Delete item | **COMPLETE** | `operatorDeleteReturnItem` → `release_expected_item_unit` → soft void |
| Void box | **COMPLETE** | `voidOperatorIntakeBoxPackageAction` → release all RIs → soft void package |
| Move box | **COMPLETE** | `moveOperatorIntakeBoxToPalletAction` → `move_expected_item_unit` per RI |
| Allocation/release RPCs | **COMPLETE** | Item-level split migrations applied staging |

### Remaining blockers (not demo-blocking for core scanner ops)

| Blocker | Scope | Blocks demo? |
|---------|-------|--------------|
| Delete/void → **restore RPC** wiring to `undo_snapshots` | Staging enhancement | **No** — undo foundation applied; restore wiring optional for demo |
| `DELETE-CASCADE-UNDO` migration apply on **original** | Original DB | **No** — separate approval required |
| **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION** | View read models | **Partial** — counts may drift until migration |
| **CLAIMS-RETURNS-FIRST-DRAFT-E2E** | Claims draft path | **Yes** for claims demo slice |

## Claims returns-first

| Item | Status |
|------|--------|
| Policy on staging | **CONFIGURED** |
| Returns lane | **Enabled** per policy |
| `expected_group` grain | **BLOCKED** for returns-first queue |
| `import_source` grain | **BLOCKED** for returns-first queue |
| Draft E2E | **BLOCKED** — closed package + evidence/note |

## Neda merge contract (when approved)

Merge with Neda **must preserve**:

1. **Scanner UX** — operator-mobile flows unchanged in intent  
2. **Phase1 governed allocation/release rules** — `allocate_expected_items_for_return_item_ids`, `release_expected_item_unit`, `move_expected_item_unit`; no bulk RI; no EP→RI copy without physical scan  

**No original DB DDL** without separate operator approval.

## Readiness summary

| Dimension | Status |
|-----------|--------|
| **Demo readiness** | **READY** for Automation · Imports · Product Hub · scanner receive/delete/move/void (staging) |
| **Merge readiness** | **NOT READY** — QA gate + claims draft E2E + explicit operator approval |
| **Original DB DDL** | **BLOCKED** — separate approval |

Related: [AUTOMATION_API_CENTER.md](AUTOMATION_API_CENTER.md) · [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md) · [NEDA_HANDOFF.md](NEDA_HANDOFF.md) · [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md)

## Exact next prompts

```text
PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE
CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE
```
