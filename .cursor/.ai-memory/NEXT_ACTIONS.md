# Next actions — canonical

**Branch:** `feature/phase1-latest-stash-land` @ `999f765` · **main** `4402064` (not merged)  
**Last updated:** 2026-06-18 (`phase-claim-family-aware-recovery-matching-v2` `20260618T140000Z` **PASS — family-aware recovery + amount-basis policy (read-only)** — zero-import contract additions `CLAIM_AMOUNT_POLICY_MATRIX` (17 families; physical-loss default COGS but need operator confirmation; fee/reversal/refund resolved), `classifyFamilyByReason`/`classifyCandidateFamily`, `computeFamilyAwareRecovery` (excludes cross-family counted credits from confirmed, classifies weak candidates, 3 amounts COGS/sale-net/business-loss, `misclassified_candidates`, `separate_claim_suggestions`, policy-gated `filing_status`), `summarizeFamilyAwareRecovery`. Drawer renamed "Recovery Gap / Claim Amount Policy" + 3 amount rows + SC-amount-selected + policy-needs-confirmation badge + separate-opportunities section. Live: pilot **10/10 → needs_policy_confirmation**, total_cogs $100.72 / sale_net_est $78.48 / business_loss $100.72 / confirmed $0.00, weak candidates 152 all excluded cross-family, 31 separate-claim suggestions; tsc/lint/smoke/next build PASS; no mutation; SAFE_FAMILY_AWARE_RECOVERY_MATCHING_READY=yes, SAFE_TO_FILE_APPROVED_FAMILIES=no (basis pending), SAFE_TO_BUILD_SEPARATE_CLAIM_CANDIDATE_GENERATORS=yes.)
Prior: 2026-06-18 (`phase-amazon-report-source-api-coverage-and-claim-family-map-v1` `20260618T053000Z` **PASS — source/API coverage audit + claim-family data map + Data Coverage UI (read-only)** — zero-import `claim-source-coverage-ui-contract.ts` + server composer `claim-source-coverage-v1.ts` probing **17 sources** joined to report registry + V3 family matrix → `source_coverage_matrix` / `claim_family_map` / `live_sync_plan`; read APIs `GET /api/claims/center/source-coverage` + `/claim-family-map`; new page `/claim-center/data-coverage`; RecoveryGap gained `files_checked[]` + `missing_files_or_api[]` (drawer shows files checked + missing SP-API). Live: coverage 17 (live_loaded 16), family map 10 (2 pilot complete, fba_fee_overcharge missing), pilot $100.72 expected / $0 confirmed / $100.72 open / unknown_unmatched 10; tsc/lint/smoke/next build PASS; no mutation; SAFE_SOURCE_COVERAGE_AUDIT_COMPLETE=yes, SAFE_TO_BUILD_CLAIM_DATA_COVERAGE_UI=yes (built), SAFE_TO_BUILD_LIVE_AMAZON_REPORT_SYNC_LAYER=yes (plan), SAFE_TO_IMPROVE_RECOVERY_GAP_MATCHING_ENGINE=yes.)
Prior: 2026-06-18 (`phase-claim-recovery-gap-and-reimbursement-matching-v1` `20260618T040000Z` **PASS — deterministic recovery-gap + reimbursement-matching engine + UI (read-only)** — pure `computeRecoveryGap(row)` + `summarizeRecoveryGap(rows)`; only STRONG order-linked reimbursement/credit rows count, fees ("FBA Inventory Fee") excluded, weak FNSKU/date-window candidates surfaced but never reduce the open gap; no confirmed → unknown_unmatched (never "$0 paid"). UI: recovery summary cards + table cols (Reimbursed/Open gap/Reimb. status/Match conf.) + filters + drawer "Reimbursement / Recovery Gap" section. Live: 10 claims, expected **$100.72**, confirmed **$0.00**, open gap **$100.72**, all **unknown_unmatched**; 13 FBA-fee settlement rows excluded per /x5UTzvZZK claim; tsc/lint/smoke/next build PASS; no mutation; SAFE_RECOVERY_GAP_ENGINE_READY=yes, SAFE_TO_FILE_UNREIMBURSED_CLAIMS=yes.)
Prior: 2026-06-18 (`phase-claim-filing-decision-matrix-v1` `20260618T030000Z` **PASS — deterministic filing decision + UI (read-only)** — pure `computeFilingDecision(row)` (safe_to_file / needs_reference_review / do_not_file) keyed on strong removal/shipment/tracking ref + identity + qty + COGS recovery; weak FNSKU/date-window candidates excluded from proof; UI "Decision" badge column + "Filing Decision" drawer section. Live: 10/10 **safe_to_file**, 0 needs_review, 0 do_not_file; seller_central excludes internal UUIDs + weak refs, uses COGS recovery; tsc/lint/smoke/next build PASS; no mutation; SAFE_FILING_DECISION_MATRIX_READY=yes, SAFE_TO_MANUALLY_FILE_APPROVED_CLAIMS=yes.)
Prior: 2026-06-18 (`phase-claim-deep-amazon-reference-ledger-v1` `20260618T020000Z` **PASS — deep multi-source Amazon reference ledger + UI (read-only)** — deepened the Event Reference Ledger to a per-source-group search across removal/shipment/inventory_ledger/transaction/settlement/reimbursement/customer_return/report_metadata with a source census + bounded ±45-day FNSKU/SKU event-date window pass (advisory candidates), `filing_sufficiency` per claim, and a UI rebuild (per-source cards + status badges + coverage badge + Not-found list). Live: 10 claims (4 complete / 6 filing_sufficient / 0 needs_review); `/x5UTzvZZK`-linked claims now resolve 13 settlement IDs + report rows; totals external 88 / transaction 52 / report_metadata 16; ledger+reimbursement order-linked 0 (shown as window candidates); NO UUID/"TRID" in Seller Central; tsc/lint/smoke/next build all PASS; no DB/claim/edge/Amazon/scanner mutation; SAFE_DEEP_REFERENCE_LEDGER_READY=yes, SAFE_TO_FILE_CLAIMS_IN_SELLER_CENTRAL=yes.)
Prior: 2026-06-17 (`phase-claim-ready-to-file-queue-ui-v1` `20260617T233450Z` **PASS — operational UI + read-only audit** — new page `/claim-center/ready-to-file`; 10/10 ready, 0 blocked, $100.72, 11 audit gates; Seller Central copy + guarded Case ID recording; SAFE_READY_TO_FILE_UI_READY=yes.)

**NEXT (the one real gate — operator action):** `PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1` — operator opens a packet in `/claim-center/ready-to-file`, files each packet (or one grouped removal-order case) in Seller Central, captures the **real Amazon Case IDs**, fills the manual-filing operator input, sets `APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes`, then run the governed filing-status write to unblock the reimbursement matcher.

~~Ready-to-File operator queue UI~~ — **DONE** `20260617T233450Z` (`/claim-center/ready-to-file`; 10/10 ready, 0 blocked; 11 audit gates; Seller Central copy + guarded Case ID recording).
~~Seller Central filing packets~~ — **DONE** `20260617T212340Z` (10/10 packets ready, 0 blocked; 3 grouped removal-order cases; record-back placeholders empty).
~~Pre-filing final verify~~ — **DONE** `20260617T211458Z` (re-verify 100%, 16/16, post reference-materialization-execute).
~~Reference materialization execute~~ — **DONE** `20260619T083000Z` (governed write executed; idempotent; SAFE_REFERENCE_MATERIALIZATION_COMPLETE=yes).

**Parallel (ready now):** `PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1` — set `APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes` + fill operator input with **real Amazon Case IDs**, then record filing status (governed write) to unblock the reimbursement matcher.

**Coverage follow-ups (from source-coverage audit `20260618T053000Z`):**
- `PHASE-CLAIM-RECOVERY-GAP-SERVER-API-AND-REIMBURSEMENT-MATCH-AUTHORITY-V1` — move recovery-gap server-side (`GET /api/claims/center/recovery-gap` + `/reimbursement-matches`) and add **order-linked `amazon_reimbursements` auto-match** to turn the 10 pilot claims Unknown → confirmed not/partially/fully reimbursed. (Also recommended: `/source-events`, `/report-sync-status`.)
- P1 **Inventory Ledger Detail View ingest worker** (unlocks warehouse_lost/damaged + disposed families). P2 **FBA Customer Returns sync** (amazon_returns) for customer_return_not_reimbursed / refund_without_return. P2 **Fee Preview / Product Fees API** for fba_fee_overcharge (currently `missing`).
- View the map any time at **`/claim-center/data-coverage`** (Filing & recovery → Data Coverage).

**Family-aware follow-ups (from `20260618T140000Z`):**
- `PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1` — present `CLAIM_AMOUNT_POLICY_MATRIX` to Maysam, capture chosen basis (COGS vs latest-sale-net vs business loss) per family into a governed `module_configs` policy record, then re-run the family-aware engine so confirmed families flip `needs_policy_confirmation → safe_to_file`. **All 10 pilot claims are currently `needs_policy_confirmation` until this is done.**
- `PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1` — convert the **31** separate-claim suggestions (Damaged_Warehouse / Lost_Warehouse / Lost_Outbound / Reimbursement_Reversal / CustomerReturn reimbursement candidates wrongly surfaced under removal claims) into real per-family claim candidates (`SAFE_TO_BUILD_SEPARATE_CLAIM_CANDIDATE_GENERATORS=yes`).

---

## P1 — AI-assisted Claim Center (plan complete)

~~**PHASE-CLAIM-AI-ASSISTED-OPERATIONS-PLAN-V1**~~ — **PASS** `20260619T040000Z` — advisory-only; no model calls in plan phase

Evidence: `.cursor/audit-reports/phase-claim-ai-assisted-operations-plan-v1/20260619T040000Z/`

**NEXT:** `PHASE-CLAIM-CENTER-AI-OPTIONAL-OVERLAY-SHELL-V1` → `PHASE-CLAIM-AI-EVIDENCE-SUMMARY-ASSISTANT-V1` (dry-run UI first)

## P1 — Live reference API layer (IMPLEMENTED — read-only/dry-run)

~~**PHASE-LIVE-REFERENCE-API-COMPLETION-V1**~~ — **PASS** `20260619T060000Z` — 4 read-only/dry-run endpoints (trid-resolver, refresh-preview, coverage, reimbursement-match/refresh-preview) + Reference Health drawer section; TRID 10/10; reimb match blocked 10/10; no writes/no Amazon; `SAFE_TO_BUILD_REFERENCE_MATERIALIZATION_EXECUTE: yes`; `SAFE_TO_BUILD_POST_FILING_REIMBURSEMENT_MATCHER: yes`

Evidence: `.cursor/audit-reports/phase-live-reference-api-completion-v1/20260619T060000Z/`

~~**PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-AUDIT-V1**~~ — **PASS** `20260619T030000Z` — TRID 10/10; reimb/case ID 0/10

**NEXT:** `PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1` — governed `claim_reference_edges` refresh write (operator-approved + rollback.sql). Live SP-API sync still gated (`LIVE_SP_API_SYNC_ENABLED=false`). Parallel: operator supplies real Amazon Case IDs to unblock the dry-run reimbursement matcher.

**Parallel (production):** Operator COGS + Case IDs → execute chain → `PHASE-CLAIM-PILOT-FINAL-VERIFY-V1`

~~**PHASE-CLAIM-PILOT-FINAL-SIMULATION-VERIFY-V1**~~ — **PASS** `20260619T001500Z`

~~**PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1**~~ — **PASS** `20260618T235000Z` — full demo path without DB writes; UI `?simulation=1`

Evidence: `.cursor/audit-reports/phase-claim-pilot-simulated-completion-v1/20260618T235000Z/`

## P1 — TRID/reference trace (VISIBLE) → next: manual filing status entry execute

~~**PHASE-TRID-REFERENCE-TRACE-MATRIX-V1**~~ — **PASS read-only** `20260619T075000Z` — per-submission TRID/reference trace. trid 10/10, 96 candidate-linked edges (avg 9.6), 0 ambiguous, 0 missing. Key findings: single primary TRID anchor = expected_package_id (real product link = resolved_product_id); event date/time NOT used as a match filter; VRET≠TRID (none present); 4 removal_order_discrepancy carry 2 removal_order_id each. `SAFE_TRID_TRACE_VISIBLE=yes`, `SAFE_TO_EXECUTE_REFERENCE_MATERIALIZATION=yes`. New lib `trid-reference-trace-matrix-v1.ts` + phase + smoke. Evidence `phase-trid-reference-trace-matrix-v1/<run>/`.

**NEXT (ready now):** `PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1` — set `APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes` + fill operator input with **real Amazon Case IDs** (prior execute blocked by empty `amazon_case_id`), then record filing status (governed write) to unblock the reimbursement matcher.

## P1 — Money lane after COGS (VERIFIED)

~~**PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V2**~~ — **PASS read-only** `20260619T074000Z` — cogs/recovery/sold/fee/settlement all **10/10**; total_recovery **$100.72**; observed reimbursement Unknown 0/10 (never $0); recovery = clean_qty × approved_cogs_unit; no writes/no Amazon/no scanner; `SAFE_MONEY_LANE_PREVIEW_READY=yes`, `SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY=yes`, `SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY=yes`. Evidence `phase-claim-money-lane-preview-after-cogs-v1/20260617T193719Z/`.

**NEXT (ready now):** `PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1` — set `APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes` + fill operator input with **real Amazon Case IDs** (the prior execute was blocked by empty `amazon_case_id`), then record filing status (governed write). This also unblocks the dry-run reimbursement matcher (observed reimbursement currently Unknown 0/10).

## P1 — COGS execute (COMPLETE — production write done + persistence fix formalized)

~~**PHASE-PRODUCT-COGS-WRITE-PERSISTENCE-FIX-V1**~~ — **PASS** `20260619T073000Z` — formalized the write-persistence fix: shared resolver `resolveCanonicalWorkspaceSettingsRowForOrg` (org-first, singleton fallback, target by `id`); `attemptGuardedCogsWriteV1` verifies rows-affected + re-reads by id per FNSKU; execute lib emits aggregate `persistence_verification` (resolver=**singleton**, row `5ad12e20…`, `reread_by_id_confirmed=true`, `all_expected_keys_present=true`). accepted 6/6, cogs_overrides 6/6, recovery 10/10. `SAFE_PRODUCT_COGS_WRITE_COMPLETE=yes`.

**NEXT (ready now):** `PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1` — re-run money lane preview with COGS coverage 6/6 and surface recovery values (10/10) in the Reimbursement Tracking UI. Then operator real Amazon Case IDs (manual filing status entry execute) to unblock the reimbursement matcher.

~~**PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V2**~~ — **PASS, production write COMPLETE** `20260619T070000Z` — accepted 6/6, `cogs_overrides` **6/6** persisted, recovery **10/10**. Root-cause fix: COGS read/write (+ money-lane discovery) were filtering `workspace_settings` by `.eq(org)`, but the app keeps a single canonical row with `organization_id=NULL` (singleton). Bare `.update().eq()` matched 0 rows and falsely reported success. Fixed all COGS paths to resolve the canonical row (org-first, singleton fallback, update-by-`id` with `.select()` rows-affected verification). `SAFE_PRODUCT_COGS_WRITE_COMPLETE=yes`; `SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS=yes`.

**NEXT (ready now):** `PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1` — re-run money lane preview with COGS coverage 6/6 and surface recovery values (10/10) in the Reimbursement Tracking UI. Then proceed to operator real Amazon Case IDs (manual filing status entry execute) to unblock the reimbursement matcher.

---

## P1 — COGS execute (prior history — operator added 6 sourceNotes)

~~**PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1**~~ — **PASS read-only** `20260619T051500Z` — Maysam's `unitCost` values **6/6 present** in operator JSON (4.00/3.25/4.36/5.50/4.75/7.25); `sourceNote` **0/6** → all 6 fail dry-run `source_note:required`; values NOT yet in `cogs_overrides` (0/6). Approval tokens both yes. `execute_prompt_needed: no` — only sourceNote fix needed.

Evidence: `.cursor/audit-reports/phase-product-cogs-ui-input-reconciliation-v1/20260619T051500Z/`

~~**PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 execute**~~ — **BLOCKED (validation)** `20260617T075103Z` — approvals yes; 6/6 rejected — superseded by reconciliation above (unitCosts now filled).

~~**PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1 (re-verify)**~~ — **PASS** `20260619T064000Z` — sourceNote **6/6** fixed; **`SAFE_TO_EXECUTE_COGS_WITH_EXISTING_INPUT=yes`**; cogs_overrides still 0/6 (pre-execute). Input is execute-ready.

**NEXT (ready now):** `PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V2` — gate satisfied, approvals yes. Run `npx tsx scripts/phase-product-cogs-manual-entry-execute-v1.ts --execute` → expect accepted 6/6, cogs_overrides 6/6 → then rebuild money lane preview with COGS (recovery 10/10).

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
