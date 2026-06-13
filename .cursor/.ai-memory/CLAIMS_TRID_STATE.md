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
