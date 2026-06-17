# Claims & TRID state — phase1 delivery

**Main:** `4402064` · **Stash land:** `feature/phase1-latest-stash-land` @ `999f765`  
**Last updated:** 2026-06-16 (`phase1-pre-neda-merge-history-memory-sync` `20260616T120000Z`)

Related: [CLAIMS_ENGINE_STATE.md](CLAIMS_ENGINE_STATE.md) · [TRID_CLAIM_STATUS.md](TRID_CLAIM_STATUS.md) · [CLAIM_ARCHITECTURE.md](CLAIM_ARCHITECTURE.md)

## Claims returns-first (CORRECTED 2026-06-16)

| Item | Status |
|------|--------|
| Policy direction | **returns-first** |
| Logic | **Built** |
| Staging policy config | **CONFIGURED** — `enabled_claim_domains.returns`, `scan_go_live_date`, `claim_start_date`, claim window, evidence/hold policy |
| **`expected_group` grain** | **BLOCKED** for returns-first queue |
| **`import_source` grain** | **BLOCKED** for returns-first queue |
| Draft E2E | **BLOCKED** — closed package + evidence/note |
| Auto-promote | **off** |
| Manual grouping UI | Per policy; validate in draft E2E |

**SUPERSEDES (2026-06-12):** cutoff dates "unconfigured" — now **configured on staging**; draft E2E remains gate.

## Returns config keys (staging — locked)

- `enabled_claim_domains.returns`
- `scan_go_live_date`
- `claim_start_date`
- claim window
- evidence / hold policy

## Next (returns-first — ordered)

1. **CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE** — prove draft path with closed package + evidence/note  
2. **PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE** — include claims E2E in QA checklist  
3. Original schema parity (explicit approval only)

## Delivery status summary

| Track | Dry-run | Applied | Next |
|-------|---------|---------|------|
| Claim lines schema | **PASS** | **NO** | Schema apply staging |
| Claim lines backfill | **PASS** | **NO** | After schema apply |
| TRID foundation | **PASS_WITH_BLOCKERS** | **NO** | After `claim_lines` |
| Returns-first policy | **CONFIGURED** (staging) | staging | Draft E2E |

## Claim line grain (locked)

| Lane | Grain |
|------|-------|
| Scanner / receive | **1 claim_line ↔ 1 return_items** |
| Expected short/overage | **group-grain** on root EP |
| Import candidates | **import-grain** until TRID grouping |

## Priority (June 2026 — append)

Aligns with [ROADMAP.md](ROADMAP.md): Phase1 QA gate → Claims draft E2E → TRID

**Next prompt:** `CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE`


## TRID / Product Story edge dry-run V1 (append 2026-06-12)

- **Run:** `20260612T021800Z` — `.cursor/audit-reports/phase-trid-product-story-edge-materialization-dryrun-v1/20260612T021800Z/`
- Read-only dry-run over unified pool (9,055 candidates, all legacy_seed — labeled, never truth).
- Edge graph already materialized by 7H + discovery engine: **44,515** candidate edges; dry-run proposals net-new = **4** (dedupe holds).
- Missing product links: **4889**; missing reference links: **1352** (incl. 1348 removal pointer orphans).
- Product Story read model proven on top-10 product sample (identity / scans / removals / ledger / reimb / FRR / TRID edges + gap flags).
- new_tables_needed=no, new_columns_needed=no. SAFE_TO_APPLY_TRID_EDGES_STAGING=yes; approval required from Maysam before any apply.
- Next if approved: `PHASE-TRID-PRODUCT-STORY-EDGE-MATERIALIZATION-APPLY-V1

Mode: staging apply.
Approved by: Maysam.
Run: APPROVED_TRID_DISCOVERY_STAGING_APPLY=true npx tsx scripts/phase-trid-discovery-engine-staging.ts --apply
Then: add source_report edges (candidate -> raw_report_uploads via upload_id) as a new discovery rule, re-run dry-run, verify net-new + dedupe, npm run build, append memory.`

## TRID / Product Story source mining contract V2 (append 2026-06-12)

- **Run:** `20260612T030000Z` — `.cursor/audit-reports/phase-trid-product-story-source-mining-contract-v2/20260612T030000Z/`
- **Scope:** Maps every trusted Amazon/ORBIT/scanner/PIM source → TRID edges, Product Story blocks, Claim Center APIs.
- **Product Story today:** No unified `/story` API — PIM detail (`GET /api/dashboard/products/[id]`) + Claim Center 6-block detail + `product_story_href` deep link only.
- **TRID today:** Discovery engine rules materialize `claim_reference_edges` (candidate anchor); dry-run V1 net-new **4** edges; **44,515** already materialized on staging legacy pool.
- **Price/cost lanes locked:** sale context = `product_prices` / `catalog_products`; actual cost = SellerSnap (NOT WIRED) + `claim_candidates.cogs_unit`; observed reimb = FRR + `amazon_reimbursements`. ORBIT must NOT use `unit_sale_price` as COGS.
- **Blockers:** linkage **49.1%**, SAFE_FOR_PRODUCT_STORY **no**; **4889** candidates missing product link; **1352** missing reference link; FBA returns not in ORBIT sweep; source_report edges not in discovery rules yet.
- migration_needed=**partial_yes**; new_tables/columns=**yes_with_maysam_approval** (SellerSnap COGS, amazon_returns enrichment, cogs_source_code).
- SAFE_TO_DRYRUN_TRID_PRODUCT_STORY_EDGES=**yes**; full Product Story API=**no** until linkage wave 2 + COGS fix.
- Next: `PHASE-TRID-PRODUCT-STORY-READ-MODEL-DRYRUN-V2`


## Physical return MVP dry-run V1 (append 2026-06-12)

- **Run:** `20260612T191500Z` — `.cursor/audit-reports/phase-claim-physical-return-mvp-dryrun-v1/20260612T191500Z/`
- Selected 0 MVP candidate(s) from smoke org (trusted scanner candidates preferred; product-blocked + evidence-missing examples included where present).
- TRID 5-edge MVP set proposed per candidate (return_item / package / product / evidence / order-tracking) with confidence + missing reasons — **no inserts**.
- Money read model: fallback chain cogs_unit -> products cost -> product_prices; zero_unpriced flag drives "Find Money" copy.
- schema_needed=no, rls_table_needed=no, can_ship_read_only_first=yes. SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_MVP_READMODEL=no.
- Next: `PHASE-CLAIM-PHYSICAL-RETURN-MVP-READMODEL-IMPLEMENT-V1`


## Physical return MVP dry-run V1 (append 2026-06-12)

- **Run:** `20260612T192500Z` — `.cursor/audit-reports/phase-claim-physical-return-mvp-dryrun-v1/20260612T192500Z/`
- Selected 3 MVP candidate(s) from smoke org (trusted scanner candidates preferred; product-blocked + evidence-missing examples included where present).
- TRID 5-edge MVP set proposed per candidate (return_item / package / product / evidence / order-tracking) with confidence + missing reasons — **no inserts**.
- Money read model: fallback chain cogs_unit -> products cost -> product_prices; zero_unpriced flag drives "Find Money" copy.
- schema_needed=no, rls_table_needed=no, can_ship_read_only_first=yes. SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_MVP_READMODEL=yes.
- Next: `PHASE-CLAIM-PHYSICAL-RETURN-MVP-READMODEL-IMPLEMENT-V1`


## Physical return TRID edge rules dry-run V1 (append 2026-06-12)

- **Run:** `20260612T194500Z` — `.cursor/audit-reports/phase-claim-physical-return-trid-edge-rules-dryrun-v1/20260612T194500Z/`
- 4 physical candidates checked; 24 edge proposals (6 rules each): **20 would insert**, 4 blocked, 0 duplicates. **No edges inserted** (read-only).
- **Generator gap confirmed:** orbit_fra return_items candidates drop return_item_id/package_id — exact fix: `lib/claims/intake/claim-orbit-fra-generator.ts` makeDraft extra_metadata (~line 835); registry mapping already supports it. NOT fixed this phase. source_row_id fallback recovers linkage meanwhile.
- Product edge gap: identifier X006OFFM01 unresolved (PIM review). Evidence gap: no photos/claim_evidence; notes only (0.5 confidence source_note).
- schema_needed=no. SAFE_TO_APPLY_PHYSICAL_RETURN_TRID_EDGES_STAGING=yes.
- Next: `PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1`


## Physical return TRID edges APPLY V1 (append 2026-06-12)

- **Run:** `20260612T204500Z-dryrun` — `.cursor/audit-reports/phase-claim-physical-return-trid-edges-apply-v1/20260612T204500Z-dryrun/`
- Edges: 44515 -> 44515 candidate edges (+0; physical rules +0); duplicates after: 0.
- orbit_fra generator metadata fix APPLIED (code only — return_item_id/package_id/pallet_id for return_items categories; effective next generator run).
- Product edges stay blocked for 4 physical candidates (FNSKU unresolved — PIM lane).
- Composer smoke: see report. Build: PASS. No candidate mutation; no scanner changes; no cases/submissions.
- SAFE_TO_PUSH=no. Next: `PHASE-CLAIM-PHYSICAL-RETURN-MVP-CLAIM-CENTER-WIRE-V1`


## Physical return TRID edges APPLY V1 (append 2026-06-12)

- **Run:** `20260612T210000Z` — `.cursor/audit-reports/phase-claim-physical-return-trid-edges-apply-v1/20260612T210000Z/`
- Edges: 44515 -> 44531 candidate edges (+16; physical rules +12); duplicates after: 0.
- orbit_fra generator metadata fix APPLIED (code only — return_item_id/package_id/pallet_id for return_items categories; effective next generator run).
- Product edges stay blocked for 4 physical candidates (FNSKU unresolved — PIM lane).
- Composer smoke: PASS — references/evidence read materialized edges. Build: PASS. No candidate mutation; no scanner changes; no cases/submissions.
- SAFE_TO_PUSH=yes. Next: `PHASE-CLAIM-PHYSICAL-RETURN-MVP-CLAIM-CENTER-WIRE-V1`


## TRID edge requirements contract V1 (append 2026-06-13)

- **Run:** `20260613T060000Z` — `.cursor/audit-reports/phase-claim-trid-edge-requirements-contract-v1/20260613T060000Z/`
- **Contract:** `lib/claims/contracts/trid-edge-requirements-contract-v1.ts` — read-only TRID/source lineage for all **41** V3 claim families.
- **Edge catalog:** 21 canonical edge kinds (product_link, source_report_row, order_id, shipment/removal ids, tracking, package, return_item, ledger, reimbursement, settlement, finances, SAFE-T, fee preview, storage fee, PC04 dimensions, scanner evidence, observed_reimbursement, FRR lanes).
- **Rules locked:** no title-only product edge; no auto-create; disputed rows → review_signal only; observed reimbursement separate from expected recovery; Product Story money requires product_link + money source edge.
- **Duplicate key:** `uq_claim_reference_edges_candidate_natural` (org, candidate_id, edge_type, to_source_table, to_source_row_id, reference_kind, reference_value).
- **orbit_fra return_item gap:** generator fix in code (not regenerated); discovery uses source_row_id fallback.
- **SAFE_TO_IMPLEMENT_TRID_EDGE_READMODEL:** yes. No DB writes this phase.
- **Next:** `PHASE-CLAIM-TRID-EDGE-READMODEL-IMPLEMENT-V1`


## TRID reference graph reverify + submission unblock V1 (append 2026-06-16)

- **Run:** `20260616T220000Z` — `.cursor/audit-reports/phase-claim-trid-reference-graph-reverify-and-submission-unblock-v1/20260616T220000Z/`
- **Target:** original `kxsvedvpjldygtdbylsy` · pilot `pilot-20260615T190000Z` · intake `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`
- **Active cases:** **10** (6 removal_shipment_missing + 4 removal_order_discrepancy); **10** closed excluded
- **Prerequisite SAFE_REFERENCE_EDGES_MATERIALIZED:** **no** (7H execute `20260616T200000Z` blocked — 0 edges materialized)
- **Materialized `claim_reference_edges`:** **0/10** pilot cases (org total **51** draft-era unchanged)
- **TRID:** **0/10** (`missing_trid_warning` **10** — non-blocking per policy)
- **Source anchors:** **10/10** expected_packages; tracking **6/6** shipment families
- **Export regen:** **skipped** (`7h_prerequisite_not_met`)
- **Migrations:** `20260917130000` candidate_id **no**; `20260918120000` claim_submissions.claim_case_id **no**
- **Approvals:** `APPROVED_CLAIM_SUBMISSION_RECORD_PILOT_V1=no`; `APPROVED_CLAIM_SUBMISSIONS_SCHEMA_MIGRATION_V1=no`
- **No DB writes:** PASS (cases/lines/candidates/submissions/edges unchanged)
- **SAFE_TRID_REFERENCE_GRAPH_VERIFIED:** **no**
- **SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY:** **no**
- **SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT:** **no**
- **SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT:** **no**
- **Next:** `PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE` — Maysam approval + schema migration + `--execute` first; then re-run this phase


## TRID reference graph reverify + export regen after 7H V1 (append 2026-06-16)

- **Run:** `20260616T230000Z` — `.cursor/audit-reports/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1/20260616T230000Z/`
- **Target:** original `kxsvedvpjldygtdbylsy` · pilot `pilot-20260615T190000Z` · intake `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`
- **Active cases:** **10** (6+4); **10** closed excluded; **no DB writes** PASS
- **Prerequisite SAFE_REFERENCE_EDGES_MATERIALIZED:** **no** (7H execute `20260616T210000Z` still blocked — approval + migration missing)
- **Materialized edges:** **0/10** (`claim_reference_edges` org total **51** unchanged)
- **Removal order/shipment refs:** **0/4** order · **0/6** shipment (not safely resolvable without materialization)
- **TRID:** **0/10** (`missing_trid_warning` only — non-blocking)
- **Export regen:** **skipped** (`7h_prerequisite_not_met`) — no HTML/JSON/TXT/PDF regenerated
- **claim_submissions.claim_case_id:** **no** · migration `20260918120000` **not applied**
- **Submission approvals:** `APPROVED_CLAIM_SUBMISSION_RECORD_PILOT_V1=no` · `APPROVED_CLAIM_SUBMISSIONS_SCHEMA_MIGRATION_V1=no`
- **SAFE_TRID_REFERENCE_GRAPH_VERIFIED:** **no** · **SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT:** **no**
- **Next:** `PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE` — approval + migration `20260917130000` + `--execute` first


## Phase 7H pilot reference edge materialization original EXECUTE (append 2026-06-16)

- **Run:** `20260616T230000Z` — `.cursor/audit-reports/phase7h-claim-reference-edge-materialization-pilot-original-execute-v1/20260616T230000Z/`
- **Target:** original `kxsvedvpjldygtdbylsy` · pilot `pilot-20260615T190000Z` · intake `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`
- **Migration:** `20260917130000` applied (`claim_reference_edges.candidate_id`)
- **Edges:** planned **112** · created **96** · reused **16** · org total **51→147** · pilot candidate edges **0→96**
- **Coverage:** EP **10/10** · tracking **10/10** · removal order **10/10** · removal shipment **6/6**
- **TRID edges:** **10/10** via explicit EP-id anchor (no invented product TRID)
- **Unchanged:** claim_cases **22** · claim_lines **22** · claim_candidates **9155** · claim_submissions **3**
- **SAFE_REFERENCE_EDGES_MATERIALIZED:** **yes**
- **Next:** `PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AND-EXPORT-REGEN-AFTER-7H-V1`


## TRID reference graph reverify + export regen after 7H V1 PASS (append 2026-06-17)

- **Run:** `20260617T000000Z` — `.cursor/audit-reports/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1/20260617T000000Z/`
- **Prerequisite SAFE_REFERENCE_EDGES_MATERIALIZED:** **yes** (7H `20260616T230000Z`)
- **Active cases:** **10** (6+4); reference edge coverage **10/10**; blocked **0**; mismatch **0**
- **Coverage:** EP **10/10** · tracking **10/10** · removal order **10/10** · removal shipment **6/6**
- **TRID:** **10/10** (EP-id anchor); export regen **PASS** — HTML/JSON/TXT/PDF for all 10 (`20260617T000000Z-export`)
- **Draft labels:** DRAFT ONLY / NOT SUBMITTED TO AMAZON / INTERNAL REVIEW PACKET — **pass**
- **No DB writes:** PASS (edges **147** unchanged)
- **claim_submissions.claim_case_id:** **no** · submission approvals **no**
- **SAFE_TRID_REFERENCE_GRAPH_VERIFIED:** **yes**
- **SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY:** **yes**
- **SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT:** **yes**
- **SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT:** **no** (needs migration `20260918120000` + Maysam submission approvals)
- **Next:** Apply `20260918120000` + submission approvals → `PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1`


## TRID reverify + export regen after 7H V1 (append 2026-06-17, run 010000Z)

- **Run:** `20260617T010000Z` — `.cursor/audit-reports/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1/20260617T010000Z/`
- **Post-7H:** materialized edges **10/10**; export regen **10/10**; graph_pass **yes**
- **SAFE_TRID_REFERENCE_GRAPH_VERIFIED:** **yes** · **SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY:** **yes**
- **SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT:** **no** (submission approvals pending)


## Claim submission record pilot EXECUTE V1 (append 2026-06-17)

- **Run:** `20260617T010500Z` — `.cursor/audit-reports/phase-claim-submission-record-pilot-execute-v1/20260617T010500Z/`
- **Blockers:** pilot + schema approvals **no**; migration `claim_case_id` **not applied**
- **Planned:** **10** inserts · **Actual:** **0** · legacy **3** untouched
- **SAFE_CLAIM_SUBMISSION_RECORD_PILOT:** **no**
- **Next:** Maysam sets both approval tokens **yes** then re-run `--execute`


## Claim submission record pilot EXECUTE V1 PASS (append 2026-06-17)

- **Run:** `20260617T030200Z` — `.cursor/audit-reports/phase-claim-submission-record-pilot-execute-v1/20260617T030200Z/`
- **Migration:** `20260918120000` applied · **10** pilot `claim_submissions` inserted (`draft`, manual_filing)
- **Legacy:** **3** untouched · org total **3→13**
- **SAFE_CLAIM_SUBMISSION_RECORD_PILOT:** **yes** · **SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_PREVIEW:** **yes**
- **Next:** `PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1`
