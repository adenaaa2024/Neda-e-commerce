# Next actions — canonical

**Branch:** `feature/phase1-latest-stash-land` @ `999f765` · **main** `4402064` (not merged)  
**Last updated:** 2026-06-19 (`phase-claim-ai-assisted-operations-plan-v1` `20260619T040000Z` PASS)

---

## P1 — AI-assisted Claim Center (plan complete)

~~**PHASE-CLAIM-AI-ASSISTED-OPERATIONS-PLAN-V1**~~ — **PASS** `20260619T040000Z` — advisory-only; no model calls in plan phase

Evidence: `.cursor/audit-reports/phase-claim-ai-assisted-operations-plan-v1/20260619T040000Z/`

**NEXT:** `PHASE-CLAIM-CENTER-AI-OPTIONAL-OVERLAY-SHELL-V1` → `PHASE-CLAIM-AI-EVIDENCE-SUMMARY-ASSISTANT-V1` (dry-run UI first)

## P1 — Live reference API layer (audit complete)

~~**PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-AUDIT-V1**~~ — **PASS** `20260619T030000Z` — TRID 10/10; reimb/case ID 0/10; `SAFE_TO_BUILD_LIVE_REFERENCE_API_LAYER: yes`

Evidence: `.cursor/audit-reports/phase-claim-live-reference-api-completion-audit-v1/20260619T030000Z/`

**NEXT:** `PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-IMPLEMENT-V1` — governed live sync + reference refresh (no claim submit)

**Parallel (production):** Operator COGS + Case IDs → execute chain → `PHASE-CLAIM-PILOT-FINAL-VERIFY-V1`

~~**PHASE-CLAIM-PILOT-FINAL-SIMULATION-VERIFY-V1**~~ — **PASS** `20260619T001500Z`

~~**PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1**~~ — **PASS** `20260618T235000Z` — full demo path without DB writes; UI `?simulation=1`

Evidence: `.cursor/audit-reports/phase-claim-pilot-simulated-completion-v1/20260618T235000Z/`

## P1 — COGS execute (operator must supply 6 real unit costs)

~~**PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 execute**~~ — **BLOCKED (validation)** `20260617T075103Z` — approvals yes; 6/6 rejected (null unitCost + empty sourceNote); no cost data in live product metadata

Evidence: `.cursor/audit-reports/phase-product-cogs-manual-entry-execute-v1/20260617T075103Z/`

1. **Maysam:** Fill 6 real `unitCost` + non-empty `sourceNote` in `.cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json` (do **not** use `latest_sold_price`) → `npx tsx scripts/phase-product-cogs-manual-entry-execute-v1.ts --execute` → re-run after-COGS money preview

~~**PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 execute**~~ — **BLOCKED (validation)** `20260618T230000Z` — approval yes; 0/10 updated — fill real Seller Central `amazon_case_id` per submission

Evidence: `.cursor/audit-reports/phase-claim-manual-filing-status-entry-execute-v1/20260618T230000Z/`

1. **Operator:** After filing each claim in Seller Central, fill `amazon_case_id` (+ optional URL) for all 10 entries in `.cursor/operator-approvals/manual-filing-status-entry-execute-v1-input.json` → re-run `npx tsx scripts/phase-claim-manual-filing-status-entry-execute-v1.ts --execute`

~~**PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1**~~ — **PASS** `20260618T050000Z`

~~**PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1**~~ — **PASS** `20260618T040000Z`

## P1 — COGS execute then re-run after-COGS money preview

~~**PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V1 re-run**~~ — **BLOCKED** `20260618T220000Z` — COGS 0/6 in DB; recovery 0/10

Evidence: `.cursor/audit-reports/phase-claim-money-lane-preview-after-cogs-v1/20260618T220000Z/`

1. **Fill 6 unitCost + sourceNote** in `.cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json` (approvals already yes) → `npx tsx scripts/phase-product-cogs-manual-entry-execute-v1.ts --execute` → re-run after-COGS preview

1. **Fill 6 approved unit costs** in `.cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json` (approvals already **yes**; last execute `20260617T072008Z` rejected 6/6 — missing unitCost + sourceNote) → re-run `npx tsx scripts/phase-product-cogs-manual-entry-execute-v1.ts --execute`

Evidence: `.cursor/audit-reports/phase-product-cogs-manual-entry-execute-v1/20260617T072008Z/`

~~**PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 approvals**~~ — **SET** `APPROVED_PRODUCT_COGS_WRITE_V1=yes` + `APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1=yes`

~~**PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1**~~ — **PASS** `20260618T040000Z` — 10/10 sold/fees/settlement; COGS 0/10 Unknown; table + drawer Money tab; formula tooltips; build+smoke PASS; `SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY: yes`

Evidence: `.cursor/audit-reports/phase-claim-money-lane-preview-and-ui-integration-v1/20260618T040000Z/`

~~**PHASE-CLAIM-MONEY-LANE-PREVIEW-V2-PROFIT-LOSS-ANALYSIS**~~ — **PASS** `20260618T010000Z` — sale/fees/settlement 10/10; profit_loss complete 0/10 (COGS gap); `SAFE_MONEY_LANE_PROFIT_LOSS_PREVIEW_READY: yes`

Evidence: `.cursor/audit-reports/phase-claim-money-lane-preview-v2-profit-loss-v1/20260618T010000Z/`

~~**PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1**~~ — **PASS** `20260617T002855Z` — dry-run COGS Entry UI; 6/6 pilot products; per-submission recovery preview; build+smoke PASS; `SAFE_COGS_MANUAL_ENTRY_UI_READY: yes`

Evidence: `.cursor/audit-reports/phase-product-cogs-manual-entry-ui-v1/20260617T002855Z/`

~~**PHASE-CLAIM-MONEY-LANE-PREVIEW-V1**~~ — **PASS** `20260617T230000Z` — sold/fees/settlement 10/10; COGS/recovery 0/10; `SAFE_MONEY_LANE_PREVIEW_READY: yes`

Evidence: `.cursor/audit-reports/phase-claim-money-lane-preview-v1/20260617T230000Z/`

---

## P1 — Manual filing status entry execute (next)

1. **PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1** — gated UPDATE to `claim_submissions` after Maysam approval (UI dry-run ready)

~~**PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-V1**~~ — **PASS (re-verified)** `20260618T030000Z` — drawer section G + modal + dry-run API; Save disabled; build+smoke PASS; `SAFE_MANUAL_FILING_STATUS_ENTRY_UI_READY: yes`

Evidence: `scripts/smoke-claim-manual-filing-status-entry-ui-v1.ts`

~~**PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-AFTER-COGS-V1**~~ — **PASS** `20260618T120000Z` — post-COGS money lane UI; `SAFE_MONEY_LANE_PROFIT_LOSS_UI_READY: yes`

Evidence: `scripts/smoke-claim-money-lane-profit-loss-ui-after-cogs-v1.ts`

~~**PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-V1**~~ — **PASS** `20260618T020100Z` — superseded by after-COGS V1

~~**PHASE-CLAIM-MONEY-LANE-PREVIEW-V2-PROFIT-LOSS-ANALYSIS**~~ — **PASS** `20260618T010000Z`

Evidence: `.cursor/audit-reports/phase-claim-money-lane-preview-v2-profit-loss-v1/20260618T010000Z/`

---

## P1 — Product COGS manual entry UI

~~**PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1**~~ — **PASS** `20260616T235630Z` — dry-run only; no DB writes

Evidence: `.cursor/audit-reports/phase-product-cogs-manual-entry-ui-v1/20260616T235630Z/`

~~**PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1**~~ — **PASS** `20260616T233012Z`

---

## P1 — Product COGS manual entry or import plan

~~**PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1**~~ — **PASS** `20260616T233012Z`

~~**PHASE-PRODUCT-COGS-AUDIT-V1**~~ — **PASS** `20260616T231548Z`

~~**PHASE-CLAIM-REIMBURSEMENT-TRACKING-NAV-DEDUP-UX-POLISH-V1**~~ — **PASS** `20260617T210000Z` — single More menu entry under Filing & recovery; build+smoke PASS

Evidence: `.cursor/audit-reports/phase-claim-reimbursement-tracking-nav-dedup-ux-polish-v1/20260617T210000Z/`

---

## P0 — PIM Start Apply UI wire

1. **PHASE-PIM-PRODUCT-DATA-UPDATE-START-APPLY-UI-WIRE-V1** — wire Start Apply to proven backend job path; keep preview separate

Evidence: `.cursor/audit-reports/phase-pim-product-data-update-start-preview-ui-wire-v1/20260614T100632Z/`

~~**PHASE-PIM-PRODUCT-DATA-UPDATE-START-PREVIEW-UI-WIRE-V1**~~ — **DONE** `20260614T100632Z`

---

## P0 — PIM product data update operator start guide

1. **PHASE-PIM-PRODUCT-DATA-UPDATE-OPERATOR-START-GUIDE-V1** — document safe Start Apply flow; page verified clean post-cancel

Evidence: `.cursor/audit-reports/phase-pim-product-update-after-cancel-ui-verify-v1/20260614T073235Z/`

~~**PHASE-PIM-PRODUCT-UPDATE-AFTER-CANCEL-UI-VERIFY-V1**~~ — **PASS** `20260614T073235Z`

---

~~**PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1**~~ — **DONE** `20260614T170000Z`

Evidence: `.cursor/audit-reports/phase-claim-effective-date-gate-v1/20260614T170000Z/`

~~**PHASE-CLAIM-CANDIDATE-EMIT-STAGING-WAVE2-V1**~~ — **DONE** `20260614T180000Z` — 50× `removal_shipment_missing` @ `1e29a52c`; `SAFE_STAGING_EMIT_WAVE2: yes`

Evidence: `.cursor/audit-reports/phase-claim-candidate-emit-staging-wave2-v1/20260614T180000Z/`

~~**PHASE-CLAIM-CANDIDATE-EMIT-STAGING-ROLLBACK-DRILL-V1**~~ — **PASS** `20260614T190000Z` — wave2 `1e29a52c` quarantined 50/50; wave1 `6870dbd1` unchanged; `SAFE_ROLLBACK_DRILL_PASSED: yes`

Evidence: `.cursor/audit-reports/phase-claim-candidate-emit-staging-rollback-drill-v1/20260614T190000Z/`

~~**PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-VERIFY**~~ — **PASS** `20260615T140000Z` — post FIX-BUILD; 50/50; `SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED: yes`

Evidence: `.cursor/audit-reports/phase-claim-evidence-packet-preview-v1-verify/20260615T140000Z/`

~~**PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-FIX-BUILD**~~ — **PASS** `20260615T131500Z` — `SAFE_EVIDENCE_PACKET_PREVIEW_READY: yes`

~~**PHASE-CLAIM-CASE-REVIEW-UI-V1**~~ — **VERIFIED** `20260615T231500Z` — read-only `/claim-center/case-review`; 20 pilot cases; build+smoke PASS; `SAFE_TO_REVIEW_CASES_IN_UI: yes`

Evidence: `.cursor/audit-reports/phase-claim-case-review-ui-v1/20260615T231500Z/`

~~**PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE**~~ — **PASS** `20260616T230000Z` — migration applied; **96** edges created; `SAFE_REFERENCE_EDGES_MATERIALIZED: yes`

Evidence: `.cursor/audit-reports/phase7h-claim-reference-edge-materialization-pilot-original-execute-v1/20260616T230000Z/`

~~**PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AND-EXPORT-REGEN-AFTER-7H-V1**~~ — **PASS** `20260617T010000Z` — graph+export regen 10/10; `SAFE_TRID_REFERENCE_GRAPH_VERIFIED: yes`

Evidence: `.cursor/audit-reports/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1/20260617T010000Z/`

~~**PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1 — RE-RUN**~~ — **PASS** `20260617T030200Z` — 10 inserts; `SAFE_CLAIM_SUBMISSION_RECORD_PILOT: yes`

Evidence: `.cursor/audit-reports/phase-claim-submission-record-pilot-execute-v1/20260617T030200Z/`

~~**PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1 — RE-RUN**~~ — **PASS** `20260617T040100Z` — read-only 10/10; reimbursement match 0/10; `SAFE_REIMBURSEMENT_TRACKING_PREVIEW_READY: yes`

Evidence: `.cursor/audit-reports/phase-claim-reimbursement-tracking-preview-v1/20260617T040100Z/`

~~**PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1**~~ — **VERIFIED PASS** `20260617T140000Z` — read-only `/claim-center/reimbursement-tracking`; build+smoke PASS; `SAFE_REIMBURSEMENT_TRACKING_UI_READY: yes`

Evidence: `.cursor/audit-reports/phase-claim-reimbursement-tracking-ui-v1/20260617T140000Z/`

~~**PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MAIN-REPAIR-V1**~~ — **PASS** `20260617T160000Z` — nav discoverability repaired (home tile + Filing & recovery group + workflow link); build+smoke PASS; `SAFE_REIMBURSEMENT_TRACKING_UI_VISIBLE_ON_MAIN: yes`

~~**PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MERGE-TO-MAIN-V1**~~ — **DONE** `20260617T180000Z` — committed `d2f7faa` on main (40 files)

~~**PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MAIN-VISIBILITY-REPAIR-V2**~~ — **PASS** `20260617T180000Z` — tracked on main; More → Filing & recovery; 10/10 pilot rows

Evidence: `.cursor/audit-reports/phase-claim-reimbursement-tracking-ui-main-visibility-repair-v2/20260617T180000Z/`

~~**PHASE-CLAIM-MONEY-LANE-SOURCE-DISCOVERY-V1**~~ — **PASS** `20260617T190000Z` — sold price/fees/settlement 10/10; COGS 0/10; reimb 0/10

Evidence: `.cursor/audit-reports/phase-claim-money-lane-source-discovery-v1/20260617T190000Z/`

~~**PHASE-PRODUCT-COGS-AUDIT-V1**~~ — **PASS** `20260616T231548Z` — 0/10 approved COGS; `product_cost_snapshots` not on original

Evidence: `.cursor/audit-reports/phase-product-cogs-audit-v1/20260616T231548Z/`

~~**PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-PLAN-V1**~~ — **LOCKED (re-verified)** `20260617T000136Z`

~~**PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-V1**~~ — **PASS** `20260618T030000Z` — drawer modal + dry-run preview; Save disabled; build+smoke PASS; `SAFE_MANUAL_FILING_STATUS_ENTRY_UI_READY: yes`

1. **PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1** — approved UPDATE claim_submissions only (status=submitted, submission_id, source_payload filing fields + audit)

~~**PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 — EXECUTE**~~ — superseded by **PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1**

Evidence: `.cursor/audit-reports/phase-claim-submission-record-pilot-v1/20260616T130000Z/`

~~**PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1**~~ — **DRY-RUN READY** `20260616T130000Z` — 10 planned inserts; execute blocked

~~**PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1**~~ — **PASS** `20260616T090000Z` — local HTML/JSON/TXT/PDF 10/10; `SAFE_PDF_EXPORT_PREVIEW_READY: yes`

~~**PHASE-CLAIM-FILING-PACKET-UI-V1**~~ — **PASS** `20260616T070000Z` — Case Review drawer filing packet section; `SAFE_TO_REVIEW_FILING_PACKET_UI: yes`

~~**PHASE-CLAIM-FILING-PACKET-PREVIEW-V1**~~ — **PASS** `20260616T060000Z` — read-only preview API; **10/10**; `SAFE_FILING_PACKET_PREVIEW_READY: yes`

~~**PHASE-CLAIM-FILING-PACKET-PLAN-V1**~~ — **PLAN READY** `20260616T050000Z` — 10/10 eligible; `SAFE_TO_BUILD_FILING_PACKET_PREVIEW: yes`

~~**PHASE-CLAIM-CASE-REVIEW-UI-REVERIFY-AFTER-REMEDIATION-V1**~~ — **PASS** `20260616T040000Z`

~~**PHASE-CLAIM-CASE-CREATION-PREVIEW-UI-V1**~~ — **PASS** `20260615T180000Z` — case preview UI; `SAFE_TO_BUILD_CASE_CREATION_PILOT: yes`

~~**PHASE-CLAIM-CASE-CREATION-PREVIEW-V1**~~ — **PASS** `20260615T170000Z` — 50/50 preview; `SAFE_CASE_CREATION_PREVIEW_READY: yes`

~~**PHASE-CLAIM-CASE-CREATION-CONTRACT-V1**~~ — **PASS** `20260615T160000Z` — contract locked; `SAFE_TO_BUILD_CASE_CREATION_PREVIEW: yes`

~~**PHASE-CLAIM-EVIDENCE-PACKET-UI-V1**~~ — **PASS** `20260615T150000Z` — post VERIFY 140000Z; `SAFE_TO_REVIEW_EVIDENCE_PACKET_UI: yes`

~~**PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1**~~ — **PASS** `20260615T091500Z` — V1 composer + API; original pilot **50/50**; `SAFE_EVIDENCE_PACKET_PREVIEW_READY: yes`

~~**PHASE-CLAIM-EVIDENCE-PACKET-V1-PLAN**~~ — **DONE** `20260615T080000Z` — reuse 7G composer; V1 schema + API/UI plan; `SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW: yes`

~~**PHASE-CLAIM-CANDIDATE-REVIEW-UI-ORIGINAL-PILOT-V1**~~ — **PASS** `20260615T070000Z` — `/claim-center/pilot-review`; 50/50; `SAFE_TO_REVIEW_ORIGINAL_PILOT_CANDIDATES_IN_UI: yes`

~~**PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-RESTORE-FOR-REVIEW-V1**~~ — **PASS** `20260615T060000Z` — 50/50 restored @ `a8a892fe`; `SAFE_ORIGINAL_PILOT_RESTORED_FOR_REVIEW: yes`

~~**PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-ROLLBACK-DRILL-V1**~~ — **PASS** `20260615T050000Z` — 50/50 quarantined @ `a8a892fe`; `SAFE_ORIGINAL_ROLLBACK_DRILL_PASSED: yes`

~~**PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-POST-VERIFY-V1**~~ — **PASS** `20260615T040000Z` — 50/50 trusted; `SAFE_ORIGINAL_PILOT_ROWS_TRUSTED: yes`

~~**PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1**~~ — **DONE** `20260614T233000Z` — 50 inserted @ `a8a892fe`; `SAFE_ORIGINAL_EMIT_PILOT: yes`

~~**PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1**~~ — **DONE** `20260614T200000Z` — `SAFE_TO_RUN_ORIGINAL_EMIT_PILOT: yes`

---

## P0 — Claim effective date gates (preview/grouping — remaining)

~~**PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1**~~ — **DONE** `20260614T210000Z` — `/claim-center/preview-generators`; `SAFE_TO_REVIEW_PREVIEW_UI: yes`

Evidence: `.cursor/audit-reports/phase-claim-first-generator-preview-ui-v1/20260614T210000Z/`

~~**PHASE-CLAIM-GROUPING-FILTERS-UI-V1**~~ — **DONE** `20260614T120000Z`

~~**PHASE-CLAIM-GROUPING-FILTERS-UI-VERIFY-V1**~~ — **PASS** `20260614T152000Z` — `SAFE_GROUPING_UI_REVIEW_READY: yes`

Evidence: `.cursor/audit-reports/phase-claim-grouping-filters-ui-verify-v1/20260614T152000Z/`

---

## P0 — Original runtime + browser verify

1. **PHASE-ORIGINAL-RUNTIME-ENV-SWAP-AND-RESTART-V1** — `.env.local` still staging; dev on 3000/3001 must restart after swap  
2. **PHASE-SHIPMENT-ENTRY-LINKAGE-UI-BROWSER-SMOKE-V1** — after env swap + deploy parity fix  
3. ~~**PHASE-SHIPMENT-ENTRY-PRODUCT-LINKAGE-ALL-PATHS-ORIGINAL-VERIFY-V1**~~ — **DONE** `20260613T062152Z` — original readmodel PASS; runtime mismatch blocks UI claim path  
4. **PHASE-SHIPMENT25-UNMAPPED-IDENTIFIER-GOVERNED-MAP-PLAN-V1** — ZZQDPD4GHB / ZZQCP25AW3 governed map (no auto-create)

Evidence: `.cursor/audit-reports/phase-shipment-entry-product-linkage-all-paths-original-verify-v1/20260613T062152Z/`

---

## P0 — Shipment Entry linkage parity (deploy verify)

1. ~~**PHASE-SHIPMENT-ENTRY-PRODUCT-LINKAGE-ALL-PATHS-PARITY-FIX-V1**~~ — **DONE** `20260613T061122Z`  

Evidence: `.cursor/audit-reports/phase-shipment-entry-product-linkage-all-paths-parity-fix-v1/20260613T061122Z/`

---

## P1 — Original runtime env (other samples)

1. **PHASE-ORIGINAL-RUNTIME-ENV-SWAP-AND-RESTART-V1** — for linked-sample regression only  
2. ~~**PHASE-ORIGINAL-RUNTIME-ENV-BIND-VERIFY-V1**~~ — **DONE** `20260613T054315Z`

---

## P1 — Wave 1 operational linkage backfill (blocked)

1. ~~**PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-DRYRUN-V1**~~ — **DONE** `20260613T052709Z` — 9831 resolvable / 0 ambiguous; preimage+rollback ready  
2. **PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-STAGING-WRITE-V1** — **BLOCKED** until P0 original No Link resolved; staging write with preimage export; tables wave1 only; **no claim_candidates**; Maysam approval required  
3. Original write: **blocked** until staging write verified

Evidence: `.cursor/audit-reports/phase-product-linkage-operational-rows-backfill-dryrun-v1/20260613T052709Z/`

---

1. **PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE**  
2. **CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE** — `expected_group` + `import_source` remain **blocked**  
3. ~~**PHASE-PRODUCT-LINKAGE-COMPLETION-WAVE-1-RI-SCANNER-RESOLVER-STAGING**~~ — **DONE** `20260521T210500Z`: 0 applies; governance PASS; linkage unchanged  
4. **PHASE-PRODUCT-LINKAGE-COMPLETION-WAVE-2-SLIP-CONTENTS-SCANNER-RESOLVER-STAGING** — max 5 rows; 2 ambiguous blocked; no product create; no map insert

### Product image + Amazon sync recovery (2026-05-21)

| Item | Status |
|------|--------|
| Image QA plan | **COMPLETE** — `20260521T223000Z` |
| Missing images (staging) | 4,046 |
| Stale products | 15,717 |
| 1883 cluster blocked | 113 products — manual_review only |
| Amazon API | **OK** · scheduler **disabled** |
| Smoke V1 | **DONE** `20260521T231500Z` — enrich OK; promote 0 (scan bug) |
| Scale batch 2 | **DONE** `20260611T220000Z` — 240 rows @400–639; cursor **640** |
| Next scale | **PHASE-AMAZON-PRODUCT-SYNC-RECOVERY-STAGING-SCALE** — `--enrich-batches=3 --start-index=640 --promote-limit=0` |

### Dimensions + fee claim schema (2026-06-12)

| Item | Status |
|------|--------|
| Dimensions/fee/shipment audit V1 | **DONE** `20260612T185018Z` — read-only |
| Canonical dims | `product_packaging_dimensions_current` (571 / 17,059 products) |
| Fee report gap | `amazon_fee_preview` + `amazon_monthly_storage_fees` **empty on staging** |
| **SAFE_TO_DESIGN_DIMENSION_FEE_SCHEMA** | **yes** |
| Next | **PHASE-PRODUCT-DIMENSIONS-FEE-CLAIM-SCHEMA-DESIGN-V1** — migration draft only; Maysam approval before apply |

Evidence: `.cursor/audit-reports/phase-product-dimensions-shipment-fee-claim-audit-v1/20260612T185018Z/`

### Physical return MVP product linkage (2026-06-12)

| Item | Status |
|------|--------|
| Linkage dry-run V1 | **DONE** `20260612T194815Z` — 4 candidates; 0 deterministic matches |
| Root cause | QA FNSKU `X006OFFM01` not in `product_identifier_map` |
| **SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT** | **no** |
| Next | **PHASE-PRODUCT-LINKAGE-PHYSICAL-RETURN-MVP-IDENTIFIER-REPAIR-V1** |

Evidence: `.cursor/audit-reports/phase-product-linkage-physical-return-mvp-dryrun-v1/20260612T194815Z/`

### PC04 dimensions history + evidence contract (2026-06-12)

| Item | Status |
|------|--------|
| PC04 history/evidence contract V1 | **DONE** `20260612T195458Z` |
| Evidence table | **0 rows** — use `evidence_summary` on versions today |
| **new_table_needed** | **no** |
| **migration_needed** | **conditional_yes** |
| **SAFE_TO_USE_PC04_FOR_CLAIM_DIMENSIONS** | **yes** |
| Next | **PHASE-PC04-DIMENSIONS-HISTORY-EVIDENCE-IMPLEMENT-V1** |

Evidence: `.cursor/audit-reports/phase-pc04-dimensions-history-evidence-contract-v1/20260612T195458Z/`

### Physical return linkage data ingest (2026-06-12)

| Item | Status |
|------|--------|
| Data ingest V1 | **DONE** `20260612T203117Z` — plan only; 0 rows ingested |
| Fixture org spine | **empty** (0 products/map) |
| Amazon import | **blocked** for `X006OFFM01` |
| **SAFE_TO_RUN_PRODUCT_LINKAGE_APPLY_V1** | **no** |
| Next | **PHASE-CLAIM-PHYSICAL-RETURN-LINKAGE-FIXTURE-PRODUCT-SEED-APPROVAL-V1** |

Evidence: `.cursor/audit-reports/phase-claim-physical-return-product-linkage-data-ingest-v1/20260612T203117Z/`

### Product lifecycle quantity read-model contract (2026-06-12)

| Item | Status |
|------|--------|
| Lifecycle qty contract V1 | **DONE** `20260612T234909Z` — 18 states; source census; X004LKS4VD trace |
| SAFE-T / fee preview / storage fees | **empty** on staging — show unavailable not zero |
| **SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL** | **yes** (SELECT read-model only) |
| Next | **PHASE-PRODUCT-AMAZON-LIFECYCLE-QUANTITY-READMODEL-IMPLEMENT-V1** |

Evidence: `.cursor/audit-reports/phase-product-amazon-lifecycle-quantity-readmodel-contract-v1/20260612T234909Z/`

### Product linkage health + claim blocker gate (2026-06-13)

| Item | Status |
|------|--------|
| Linkage + blocker audit V1 | **DONE** `20260613T044257Z` — read-only |
| Operational linkage | **45.3%** · grade **critical** |
| Spine map coverage | **97.9%** · 352 products missing map |
| Conflict groups | **2,584** |
| **SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN** | **yes** (executed `20260613T100000Z`) |
| **SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW** | **yes** |
| Next | **PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1** — wire Claim Center panel to `GET /api/claims/center/claim-preview`; no apply |

Evidence: `.cursor/audit-reports/phase-product-linkage-health-and-claim-blocker-readmodel-v1/20260613T044257Z/`

### Operational linkage resolution plan (2026-06-13)

| Item | Status |
|------|--------|
| Resolution plan V1 | **DONE** `20260613T045948Z` — dry-run proposals only |
| Resolvable by exact identifier | **791,083** rows |
| Ambiguous (block auto-map) | **12,892** (ledger 12,877) |
| Wave 1 (zero ambiguous) | `amazon_removals`, `amazon_removal_shipments`, `expected_packages` |
| **SAFE_TO_IMPLEMENT_OPERATIONAL_LINKAGE_BACKFILL** | **conditional** |
| Next | **PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-DRYRUN-V1** |

Evidence: `.cursor/audit-reports/phase-product-linkage-operational-rows-resolution-plan-v1/20260613T045948Z/`

### Product linkage completion V3 (2026-06-11)

| Item | Staging | Original |
|------|---------|----------|
| Health run | `20260611T175121Z` | phase5f `20260611T175343Z` |
| Overall linkage | 49.1% critical | ecosystem 79.7% |
| EP unresolved | 240 (97.5%) | 431 (96.4%) |
| claim_candidates resolved | 4,170 / 9,055 | **0 / 9,055** |
| Wave 1 RI resolver | **EXECUTED** — 0/25 resolver hits; 26 candidates were attempt-eligible not resolvable | — |
| Next safe wave | **slip_contents** scanner resolver (5 rows, 2 ambiguous) | — |
| product_creation_allowed_now | **no** | — |

Evidence: `.cursor/audit-reports/phase-product-linkage-hardening/20260611T175121Z/` · `.cursor/audit-reports/phase5f-latest-run.json`

**Merge to main / Neda:** **NO** until P0 #1 + operator approval

### Product linkage completion (2026-06-11)

| Item | Status |
|------|--------|
| Linkage hardening modules | **COMPLETE** |
| Health report `20260611T044758Z` | **PASS** (49.1% overall · 24,482 unresolved · SAFE_FOR_PRODUCT_STORY **no**) |
| Wave 1 RI scanner resolver | **COMPLETE** `20260521T210500Z` — 0 rows updated · preimage empty · SAFE_TO_CONTINUE yes |
| FNSKU duplicate cleanup (`X003UR3W83`) | **BLOCKED** before map expansion |
| Claim pool bulk linkage | **BLOCKED** until claim-product-linkage dry-run |
| Amazon sync catch-up | **IN PROGRESS** (separate track — spine gaps block EP/ARS) |

---

## P1 — Claims unified pool (post-discovery)

1. **PHASE-CLAIM-CENTER-V1-UI-SHELL-READONLY** — new `/claim-center` app (12 sections); do NOT patch `/claim-engine`; redirects only; read-only
2. **PHASE-ORBIT-FRA-SPREADSHEET-IMPORT-DRY-RUN** — parse Fight List XLSX, 0 DB writes (blocked until spreadsheet in repo)
3. **PHASE-CLAIM-CENTER-V1-BRIDGE** — candidate → case → submission (separate approval; not V1 read)

Evidence: `.cursor/audit-reports/phase-orbit-fra-claim-trid-integration/20260611T070000Z/` · `.cursor/audit-reports/phase-claim-center-v1-read-model/20260611T060000Z/`

---

## P2 — Non-demo-blocking

3. **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION**  
4. **DELETE-CASCADE-UNDO-ORIGINAL-APPLY** — separate approval; staging PASS  
5. **DELETE-VOID-RESTORE-RPC-WIRING** — optional staging enhancement  
6. **PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION** — full cohort; sample wave done  

---

## Done — Phase1 demo-ready

- [x] Automation API Center **COMPLETE**  
- [x] Imports file-only **COMPLETE**  
- [x] Product Core no auto-create **ENFORCED**  
- [x] Vendor 1883 cleanup + generic warning architecture  
- [x] Scanner physical-only RI + product linkage preserved  
- [x] Delete / move / void backend parity **COMPLETE** (staging)  
- [x] Claims returns-first policy configured; non-returns grains blocked  
- [x] Product sheet sample wave — **0 creates**  

---

## Hard policy

| Rule | Value |
|------|-------|
| Neda merge | Preserve scanner UX + allocation/release rules |
| Original DB DDL | **Separate approval** |
| Product Core resolver rewrite | **FORBIDDEN** |
| Auto-create products | **Governed seed only** |
| Bulk RI from expected/API | **FORBIDDEN** |
