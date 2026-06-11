# Current state — canonical system memory

**Last updated:** 2026-06-11 (`phase-menorix-claim-center-shell` `20260611T210000Z`)  
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

## Claims (returns-first + unified pool)

| Item | Status |
|------|--------|
| Policy on staging | **CONFIGURED** |
| `expected_group` / `import_source` | **BLOCKED** for returns-first queue |
| Draft E2E | **BLOCKED** — closed package + evidence/note |
| **Claim Discovery Engine** | **COMPLETE** — writes `claim_candidates` only; 9 sources; `discovery_index` watermarks |
| **Claim Center V1** | **READ SHELL + MENORIX PATTERN** — `/claim-center` (12 sections) on `MenorixModuleAppShell`; 12 reusable `components/menorix/*`; read APIs incl. `ai-access` + `automation-health`; zero writes; build PASS; smoke `phase-claim-center-v1-read-staging-smoke` PASS |
| Candidate → case → submission bridge | **NOT BUILT** — audit `phase-claim-legacy-submission-pdf-agent-bridge-audit/20260611T190000Z/` · SAFE_TO_BUILD **yes_with_conditions** · reuse legacy PDF + claim_submissions |
| **ORBIT-FRA integration** | **AUDITED** — generator exists (`orbit_fra`); spreadsheet import = hybrid staged → `claim_candidates`; **import apply blocked** until dry-run |

## RLS / tenant isolation (2026-06-05 audit)

| Item | Status |
|------|--------|
| Priority tables RLS enabled (original + staging) | **YES** (core spine) |
| Phase 8C view security_invoker (10 views) | **APPLIED** both envs |
| Import route org guard | **GAP** — 12 routes service_role without session org assert |
| Amazon ingest `Allow All` policies | **OPEN** — cross-tenant risk if authenticated granted |
| Storage public SELECT | **OPEN** — all buckets in Public Access policy |
| SAFE_TO_APPLY_RLS_FIX_STAGING | **no** |
| SAFE_TO_APPLY_RLS_FIX_ORIGINAL | **no** |

Evidence: `.cursor/audit-reports/phase-rls-original-staging-parity-audit/20260605T120000Z/`

## Readiness

| Dimension | Status |
|-----------|--------|
| **Demo** | **READY** (Automation · Imports · scanner ops · Product Hub) |
| **Neda merge** | **NOT READY** — QA gate + claims E2E + operator approval |
| **Original DB DDL** | **Separate approval required** |

## Neda merge contract

Preserve **scanner UX** + **Phase1 governed allocation/release rules** (`release_expected_item_unit`, `move_expected_item_unit`, no bulk RI).

## Product linkage (2026-06-11)

| Metric | Staging |
|--------|--------:|
| Overall linkage | **49.1%** |
| Critical paths | **67.7%** |
| Unresolved operational rows | **24,482** |
| Identifier conflict groups | **2,583** |
| SAFE_FOR_PRODUCT_STORY | **no** |

Hardening: `lib/product-linkage-*` + `GET /api/dashboard/products/linkage-health`.  
**Wave 1 (RI scanner resolver) EXECUTED** `20260521T210500Z`: governance **PASS**, **0 rows updated** (26 candidates; 0/25 resolver hits — fixture FNSKUs + test SKUs; real scans already linked).  
Evidence: `.cursor/audit-reports/product-linkage-resolver-wave-staging-execute/20260521T210500Z/`

## Product image + Amazon sync (2026-05-21 plan)

| Metric | Staging |
|--------|--------:|
| Missing `main_image_url` | **4,046** |
| Suspicious main images | **13,010** |
| Stale products (post 2026-06-01 cancel) | **15,717** |
| 1883 placeholder cluster (blocked) | **113 ASINs** — `41gCLv9NY9L` in `KNOWN_BAD_IMAGE_SUBSTRINGS` |
| Amazon SP-API connectivity | **OK** |
| Enrichment schedule | **disabled** |
| SAFE_TO_RUN_IMAGE_QA_SMOKE_STAGING | **yes** |
| SAFE_TO_RUN_NEXT_IMAGE_SAMPLE | **yes** |
| SAFE_TO_SCALE_IMAGE_REPAIR | **yes_with_conditions** |
| SAFE_TO_ENABLE_DAILY_PRODUCT_SYNC | **yes_with_conditions** |

Plan: `.cursor/audit-reports/phase-product-image-qa-and-amazon-sync-recovery-plan/20260521T223000Z/`

**5E sample apply `20260611T184755Z`:** **1 staging write** — `B0923C5KVS` SL75→SL500 catalog upgrade; provenance + `pim_image_candidates` verified; rollback at `phase5e-product-image-qa-staging-sample/20260611T184755Z/`. 1883 cluster **not touched**.

**Smoke apply `20260521T231500Z`:** enrich batch **PASS** (80 rows, 7 images, 0 trusted overwrites); worker smoke **PASS**; promote **0** (FBA-only `B07X13VS51` outside candidate scan window — fix needed). Scheduler **still disabled**.

## P0 next

1. **PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE**
2. **CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE**
3. **PHASE-PRODUCT-LINKAGE-COMPLETION-WAVE-2-SLIP-CONTENTS-SCANNER-RESOLVER-STAGING** (or spine/map tracks — see wave1 summary)

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

