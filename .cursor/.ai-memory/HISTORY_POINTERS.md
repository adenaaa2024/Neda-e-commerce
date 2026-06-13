# History pointers — authoritative

## Canonical master

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Latest append | `20260613T030000Z` — **PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V2-GAP-EXPANSION** |
| Prior | `20260613T030638Z` — **PHASE-AMAZON-REMOVAL-SYNTHETIC-UPLOAD-PROMOTION-FIX-V1** |
| Prior | `20260613T025053Z` — **PHASE-AMAZON-SPAPI-PHASE0-FRESHNESS-VERIFY-NO-RECONNECT-V1** |
| Prior | `20260613T014104Z` — **PHASE-AMAZON-FEE-AND-REIMBURSEMENT-ESTIMATE-MODEL-V1** |
| Prior | `20260612T230000Z` — **PHASE-SCANNER-SHIPMENT-LINE-AGGREGATION-FIX-387003587-X004LKS4VD-V1** |
| Prior | `20260612T205500Z` — **PHASE-AMAZON-ORBIT-FRA-SOURCE-CONNECTOR-READMODEL-IMPLEMENT-V1** |
| Prior | `20260612T203117Z` — **PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-DATA-INGEST-V1** |
| Prior | `20260612T193528Z` — **PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-PILOT-V1** |
| Prior | `20260612T200000Z` — **PHASE-PRODUCT-FINANCIAL-SPINE-APPROVAL-QUESTIONS-V1** |
| Prior | `20260612T024000Z` — **PHASE-CLAIM-PHYSICAL-RETURN-MVP-SLICE-CONTRACT-V1** |
| Prior | `20260612T185018Z` — **PHASE-PRODUCT-DIMENSIONS-SHIPMENT-FEE-CLAIM-AUDIT-V1** |
| Prior | `20260612T030045Z` — **PHASE-TASK-CENTER-FRONTEND-SHELL-NEDA-V1** |
| Prior | `20260612T021500Z` — **PHASE-CLAIM-INTAKE-POLICY-READ-MODEL-IMPLEMENT-V1** |
| Prior | `20260612T020500Z` — **PHASE-CLAIM-CENTER-QUEUE-SEMANTICS-AND-MONEY-DISPLAY-POLISH-V1** |
| Prior | `20260612T023000Z` — **PHASE-CLAIM-LIFECYCLE-SOURCE-TO-CANDIDATE-API-CONTRACT-V1** |
| Prior | `20260612T021500Z` — **PHASE-CLAIM-INTAKE-POLICY-SETTINGS-AUDIT-V1** |
| Prior | `20260612T013747Z` — **PHASE-CLAIM-CENTER-COMMAND-HOME-FLOW-CARDS-V2** |
| Prior | `20260612T012927Z` — **PHASE-CLAIM-MONEY-RECOVERY-DATA-CONTRACT-AUDIT** |
| Prior | `20260612T012800Z` — **PHASE-CLAIM-CENTER-V2-STAGING-UX-VERIFY-AND-MEMORY-APPEND** |
| Prior | `20260612T011841Z` — **PHASE-CLAIM-CENTER-MOBILE-FLOW-POLISH-V1** |
| Prior | `20260612T011500Z` — **PHASE-CLAIM-CENTER-FLOW-NAVIGATION-IMPLEMENT-V1** |
| Prior | `20260612T010000Z` — **PHASE-CLAIM-CENTER-FLOW-NAVIGATION-REDESIGN-CONTRACT** |
| Prior | `20260612T005700Z` — **PHASE-CLAIM-CENTER-DATA-SOURCE-BANNERS-AND-COMMAND-HOME-V2** |
| Prior | `20260612T005100Z` — **PHASE-CLAIM-CENTER-V2-SHELL-INDEPENDENT-APP-IMPLEMENT** |
| Prior | `20260612T004437Z` — **PHASE-CLAIM-INTAKE-OPERATIONAL-POOL-STAGING-EMIT** |
| Prior | `20260612T005500Z` — **PHASE-CLAIM-CENTER-V2-INDEPENDENT-APP-CONTRACT-FINAL** |
| Prior | `20260612T004200Z` — **PHASE-CLAIM-CENTER-REAL-DATA-CONTRACT-AND-STAGING-READINESS** |
| Prior | `20260612T002821Z` — **PHASE-CLAIM-CENTER-LEGACY-BOUNDARY-CLEANUP-V1** |
| Prior | `20260612T012000Z` — **PHASE-CLAIM-CENTER-PRODUCT-UX-CONTRACT-V2-INDEPENDENT-APP** |
| Prior | `20260612T010000Z` — **PHASE-NEXT-SPRINT-ROADMAP-LOCK-V1** + **PHASE-CLAIM-CENTER-UX-FAILURE-AND-LEGACY-LINK-AUDIT** |
| Prior | `20260612T000431Z` — **PHASE-CLAIM-CENTER-UX-REDESIGN-DETAIL-STORY-SIX-BLOCK-V1** |
| Prior | `20260611T235247Z` — **PHASE-CLAIM-CENTER-UX-REDESIGN-IMPLEMENT-SHELL-V1-C1** |
| Prior | `20260611T234910Z` — **PHASE-CLAIM-CENTER-POLICY-OWNERSHIP-CORRECTION** |
| Prior | `20260611T230000Z` — **PHASE-ROADMAP-RECONCILIATION-AND-CRITICAL-PATH-LOCK** |
| Prior | `20260611T220000Z` — PHASE-AMAZON-PRODUCT-SYNC-RECOVERY-STAGING-SCALE (batch 2 @400) |
| Prior | `20260611T220210Z` — PHASE-CLAIM-CENTER-V1-DATA-UX-FIX-PACK-BEFORE-WRITE-ACTIONS |

## Phase1 demo + merge

| Doc | Topic |
|-----|-------|
| [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md) | Demo readiness · merge contract · remaining blockers |
| [AUTOMATION_API_CENTER.md](AUTOMATION_API_CENTER.md) | Automation complete |
| [NEDA_HANDOFF.md](NEDA_HANDOFF.md) | Neda merge must preserve scanner UX + allocation rules |

## Git refs

| Ref | SHA |
|-----|-----|
| `main` | `75f8482` (scanner review stabilization; Claim Center UX WIP uncommitted) |
| `feature/phase1-latest-stash-land` | `999f765` (historical — superseded by main scanner merges) |

## Sprint lock (V1)

**Audit:** `phase-next-sprint-roadmap-lock-v1/20260612T010000Z/`  
**SAFE_TO_CONTINUE:** **yes**  
**Locked order:** read UX push → bridge scaffold → linkage wave 2 → RLS import guard → Maysam approvals → sync @640 → QA gate

## Roadmap checkpoint

**Reconciliation audit:** `phase-roadmap-reconciliation-and-critical-path-lock/20260611T230000Z/`  
**Program rollup:** ~**58%** · **SAFE_TO_CONTINUE:** `conditional_yes`  
**Critical path locked:** bridge readonly scaffold → linkage wave 2 → RLS import guard → QA gate → Maysam schema queue

## Exact next prompt

**Product lifecycle quantity read-model (post-contract):**

```text
PHASE-PRODUCT-AMAZON-LIFECYCLE-QUANTITY-READMODEL-IMPLEMENT-V1
Mode: staging read-model implement (SELECT only).
Build lib/product-lifecycle-quantity-readmodel.ts + GET /api/products/[productId]/lifecycle-quantities.
Use lifecycle_quantity_contract from phase-product-amazon-lifecycle-quantity-readmodel-contract-v1/20260612T234909Z/.
No new tables; no claim_candidates writes; exclude disputed EP (build_status=shipment_overflow_conflict) from primary totals.
Wire Claim Center product drill-down chips; defer fee/stranded until imports populated.
```

**Physical return linkage seed (post ingest plan):**

```text
PHASE-CLAIM-PHYSICAL-RETURN-LINKAGE-FIXTURE-PRODUCT-SEED-APPROVAL-V1
Mode: operator approval only.
Create .cursor/operator-approvals/physical-return-linkage-seed-v1-approval.md with APPROVED_PHYSICAL_RETURN_LINKAGE_SEED=true and explicit seed_product_id=<uuid>.
Then re-run: npx tsx scripts/phase-claim-physical-return-product-linkage-data-ingest-v1.ts --apply
Alternative: re-scan physical return MVP with a real FNSKU that exists in product_identifier_map for fixture org.
```

**PC04 dimensions history + evidence (post-contract):**

```text
PHASE-PC04-DIMENSIONS-HISTORY-EVIDENCE-IMPLEMENT-V1
Mode: read-only design + optional additive migration draft only (no apply without Maysam approval).
Scope: (1) measured_by view mapping source_type; (2) evidence backfill plan evidence_summary→product_packaging_evidence; (3) packaging_version_immutability trigger blocking measurement UPDATE on active versions; (4) v_product_packaging_dim_weight read view; (5) Product Story API contract stub packaging_current/history/evidence; (6) claim filing packaging_snapshot embed rules.
Staging ref: eiqfaapyumhixxoeltgu; max 25-row evidence backfill pilot dry-run only.
```

**Physical return MVP linkage (post dry-run):**

```text
PHASE-PRODUCT-LINKAGE-PHYSICAL-RETURN-MVP-IDENTIFIER-REPAIR-V1
Mode: read-only identifier repair plan (no apply).
Blockers: 0 conflict(s); 4 missing identifier row(s); 0 deterministic match(es) found.
Scope: enrich return_items / claim_candidates identifiers from scanner capture or EP copy; resolve PIM disputes; then re-run dry-run.
Evidence: .cursor/audit-reports/phase-product-linkage-physical-return-mvp-dryrun-v1/20260612T194815Z/
```

**Financial spine (post-approval pack):**

```text
PHASE-PRODUCT-FINANCIAL-SPINE-SCHEMA-DESIGN-V1
Mode: read-only design + migration draft only (no apply).
Prerequisites: Maysam sign-off on .cursor/operator-approvals/phase-product-financial-spine-v1-approval.md
Scope: product_cost_snapshots + product_price_history DDL/RLS; product_prices latest-cache narrowing; three-lane read-model join; PC04 extension for fee dims; claim_candidates immutability; defer fee + claim_money snapshots.
Staging ref: eiqfaapyumhixxoeltgu; max 25-row pilot dry-run only.
```

**Dimensions / fee claims (post-audit):**

```text
PHASE-PRODUCT-DIMENSIONS-FEE-CLAIM-SCHEMA-DESIGN-V1
Mode: read-only design + migration draft only (no apply).
Prerequisites: operator approval after this audit.
Scope: (1) additive resolved_product_id on amazon_fee_preview + amazon_monthly_storage_fees via map backfill plan; (2) product_packaging_evidence link rules for SP-API amazon measured dims; (3) computed dim_weight view on dimensions_current; (4) TRID discovery rules for fee_preview + storage_fee rows; (5) claim eligibility policy rows for FBA fee overcharge + storage overcharge families.
Staging ref: eiqfaapyumhixxoeltgu; max 25-row pilot backfill dry-run only.
```

**Critical path #1 (locked):**

```text
PHASE-CLAIM-CANDIDATE-CASE-SUBMISSION-BRIDGE-01-READONLY-SCAFFOLD
```

**Claim Center UX (after Maysam approval):**

```text
PHASE-CLAIM-CENTER-UX-REDESIGN-IMPLEMENT-SHELL-V1
```

Implement approved contract: single nav, full-width shell, screen shells only (no write bridge).

Prior: PHASE-CLAIM-CENTER-UX-REDESIGN-CONTRACT (complete — approval required)

**Nav Phase 2 (optional):**

```text
PHASE-NAV-CLEANUP-PHASE-2-SUMMARY-ONLY-SURFACES
```

Center queue pages link-only to Claim Engine; imports bookmark consolidation.

Prior: PHASE-NAV-CLEANUP-PHASE-1-LINK-AND-OWNERSHIP (complete)

**Claims track:**

```text
PHASE-CLAIM-CANDIDATE-CASE-SUBMISSION-BRIDGE-01-READONLY-SCAFFOLD
```

Prior: PHASE-CLAIM-CENTER-V1-DATA-UX-FIX-PACK (complete) · read UX **conditional_yes** · write bridge **not built**

**Settings track (optional follow-up):**

```text
PHASE-PWA-MANIFEST-DYNAMIC-WIRE-STAGING
```

Wire proposed `platform_settings.pwa_manifest` keys + dynamic manifest generation (staging only).

**RLS track (parallel):**

```text
PHASE-8R-RLS-IMPORT-ROUTE-ORG-GUARD-STAGING
```

**RLS parity audit:** `phase-rls-original-staging-parity-audit/20260605T120000Z/` — SAFE_TO_APPLY_RLS_FIX_STAGING **no** · SAFE_TO_APPLY_RLS_FIX_ORIGINAL **no**

**Memory sync:** `phase-next-sprint-roadmap-lock-v1/20260612T010000Z/`

## Paired-update law

Append-only history + `.cursor/.ai-memory` updated together.
