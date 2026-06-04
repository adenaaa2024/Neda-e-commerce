# Current state — canonical system memory

**Last updated:** 2026-06-17 (`phase1-demo-ready-history-memory-sync` `20260617T120000Z`)  
**Branch:** `feature/phase1-latest-stash-land` @ `999f765` · **main** `4402064` — **no merge**

**Demo checkpoint:** [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md)

## Phase1 demo-ready (COMPLETE)

| Surface | Status |
|---------|--------|
| Automation API Center | **COMPLETE** |
| Imports (file-only) | **COMPLETE** |
| Product Core no auto-create | **ENFORCED** |
| Vendor 1883 cleanup (staging) | **COMPLETE** |
| Vendor warning architecture | **Generic/data-driven** effective label |
| Scanner physical-only RI + linkage | **PRESERVED** |
| Delete / move / void backend | **COMPLETE** (staging) |
| Product sheet sample wave | **0 product creates** |

## Scanner / Expected / Return

**Full doc:** [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md)

| Rule | Status |
|------|--------|
| `return_items` = physical scanned units only | **LOCKED** |
| `expected_packages` = API/removal/expected forecast | **LOCKED** |
| Active RI (staging) | **33** · proven physical **3** |

## Claims (returns-first)

| Item | Status |
|------|--------|
| Policy on staging | **CONFIGURED** |
| `expected_group` / `import_source` | **BLOCKED** for returns-first queue |
| Draft E2E | **BLOCKED** — closed package + evidence/note |

## Readiness

| Dimension | Status |
|-----------|--------|
| **Demo** | **READY** (Automation · Imports · scanner ops · Product Hub) |
| **Neda merge** | **NOT READY** — QA gate + claims E2E + operator approval |
| **Original DB DDL** | **Separate approval required** |

## Neda merge contract

Preserve **scanner UX** + **Phase1 governed allocation/release rules** (`release_expected_item_unit`, `move_expected_item_unit`, no bulk RI).

## P0 next

1. **PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE**
2. **CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE**

Detail: [NEXT_ACTIONS.md](NEXT_ACTIONS.md) · [NEDA_HANDOFF.md](NEDA_HANDOFF.md)

**Last memory sync:** `phase1-demo-ready-history-memory-sync/20260617T120000Z/`

## Scanner: Box Info hydration on Item Scan -> Back (FIXED 2026-06-04)

| Item | Status |
|------|--------|
| returnFromItemsPhaseToBoxInfo | **FIXED** -- hydrateBoxPackageIdRef.current = pkgId (not null) |
| Vision lines carryover prefill | **ADDED** -- itemScanSlipCarryover pre-populates before DB arrives |
| Debug flag | **ADDED** -- ITEM_TO_BOX_HYDRATE_DEBUG = false |
| tsc / build | **PASS** |
| clearBoxSlipVisionLinesState in return path | **NOT CALLED** (correct) |
| Baseline committed | **AFTER hydrate** via finalizeBoxIntakeBaselineRef in reloadBoxPackageIntake |

