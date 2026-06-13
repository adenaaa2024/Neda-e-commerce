# Next actions — canonical

**Branch:** `feature/phase1-latest-stash-land` @ `999f765` · **main** `4402064` (not merged)  
**Last updated:** 2026-06-13 (`phase-claim-v3-dryrun-source-and-linkage-gated-v1` `20260613T050302Z`)

**Demo checkpoint:** [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md)

---

## P0 — Pre-merge gates

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
