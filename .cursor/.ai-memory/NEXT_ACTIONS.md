# Next actions — canonical

**Branch:** `feature/phase1-latest-stash-land` @ `999f765` · **main** `4402064` (not merged)  
**Last updated:** 2026-06-15 (`phase-claim-evidence-packet-ui-v1` `20260615T100500Z`)

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

1. **PHASE-CLAIM-CASE-CREATION-CONTRACT-V1** — plan read-only case creation contract from evidence packet readiness (no writes until approval)

Evidence: `.cursor/audit-reports/phase-claim-evidence-packet-ui-v1/20260615T100500Z/`

~~**PHASE-CLAIM-EVIDENCE-PACKET-UI-V1**~~ — **PASS** `20260615T100500Z` — pilot drawer evidence packet section; readiness badges; `SAFE_TO_REVIEW_EVIDENCE_PACKET_UI: yes`

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
