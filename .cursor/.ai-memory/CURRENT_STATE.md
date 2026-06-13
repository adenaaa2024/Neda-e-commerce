# Current state — canonical system memory

**Last updated:** 2026-06-13 (`phase-shipment25-no-link-screenshot-specific-audit-v1` `20260613T055446Z`)  
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
| Shipment line aggregation audit `387003587` / `X004LKS4VD` | **GATED** `20260613T000000Z` — Shipment Entry **1** grouped card: **Expected clean 52** + **Needs reconciliation 1** (not 53 gate total); `shipment_overflow_conflict` disputed; claim-ready EP filter excludes disputed; raw EP rows unchanged in DB |
| `v_inventory_item_status` clean/disputed SQL gating V1 | **ORIGINAL APPLIED + VERIFIED** `20260613T033358Z` — `387003587`/`X004LKS4VD`: expected **52**, disputed **1**; stuck removal uploads **0**; claim-ready excludes disputed qty |
| Removal domain sync → EP rebuild orchestrator V1 | **STAGING IMPLEMENTED** `20260613T040235Z` — auto `rebuild_expected_packages_from_removals` after REMOVAL_* pipeline complete (`reports-api-pipeline-handoff`); idempotent per upload metadata; fetch-only skips; claim_candidates delta **0**; build+smoke PASS; `SAFE_TO_APPLY_ORIGINAL: yes_pending_maysam`; evidence `phase-removal-sync-expected-packages-rebuild-orchestrator-v1/20260613T040235Z/` |
| **Predeploy original no-regression verify V1** | **PASS** `20260613T041615Z` — original removals **3520**, shipments **11517**, stuck uploads **0**, EP fresh, view **52/1** PASS; committed HEAD includes scanner clean/disputed display; uncommitted orchestrator hook only; `SAFE_TO_PUSH_WITHOUT_ORIGINAL_API_BREAK: conditional_no`; evidence `phase-predeploy-original-api-expected-packages-no-regression-v1/20260613T041615Z/` |
| **Post-push original snapshot V1** | **PASS** `20260613T042826Z` — read-only verify matches known-good baseline (3520/11517/0/12109/52+1/9055); RLS reimbursements 2 policies each; `SAFE_TO_CONTINUE_TO_CLAIM_DRYRUN: yes`; evidence `phase-deploy-original-verify-post-push-snapshot-v1/20260613T042826Z/` |
| Overflow conflict origin `387003587` / `X004LKS4VD` | **AUDITED** `20260521T200000Z` — qty-1 EP from **second** `amazon_removals` line (shipped=1, May 28 upload); per-detail `shipment_overflow_conflict` when shipment 52 > detail 1; not slip/OCR; `is_builder_bug: no`; fix = read-model gating + status label/copy |

## Claims (returns-first + unified pool)

| Item | Status |
|------|--------|
| Policy on staging | **CONFIGURED** |
| `expected_group` / `import_source` | **BLOCKED** for returns-first queue |
| Draft E2E | **BLOCKED** — closed package + evidence/note |
| **Claim Discovery Engine** | **COMPLETE** — writes `claim_candidates` only; 9 sources; `discovery_index` watermarks |
| **Claim Center V2 shell** | **IMPLEMENTED** `20260612T005100Z` — read-only independent app: 8-page rail, mobile More, 4 home tiles, Sources route, legacy overflow only |
| **Claim Center data UX V2** | **DONE** `20260612T005700Z` — data readiness banner, pool-empty vs queue-clear templates, page explanation model, plain-language KPIs, human source cards, practical detail next-step; build+smoke PASS |
| **Claim Center flow nav contract** | **LOCKED** `20260612T010000Z` — Lifecycle Command Bar + Command Home |
| **Claim Center flow nav V1** | **IMPLEMENTED** `20260612T011500Z` — workflow bar, you-are-here header, hideRail shell, mobile Home/Review/Proof/More; build+smoke PASS |
| **Claim Center mobile polish V1** | **IMPLEMENTED** `20260612T011841Z` — lifecycle header chips, rich cards, More sheet purpose lines, sticky detail summary, pool/queue empty states; build+smoke PASS; `SAFE_TO_PUSH: yes` |
| **Claim Center V2 staging UX verify** | **DONE** `20260612T012800Z` — nav/mobile/legacy PASS; flow score 7/10; Find Money empty while Review has 4 (blocked filter); money $0/null; no FRR edges; `SAFE_TO_CONTINUE_UI_POLISH: yes` |
| **Claim money/recovery data contract** | **AUDITED** `20260612T012927Z` — canonical field `recovery_value`; never sum nulls; observed via reimbursements/FRR; ORBIT COGS formula documented; `SAFE_TO_IMPLEMENT_MONEY_UI: no` |
| **Claim Center command home V2** | **IMPLEMENTED** `20260612T013747Z` — lifecycle command board, money/review/proof/blocker/recovery tiles, attention list dedupe, money contract wired; build+smoke PASS |
| **Claim intake policy settings audit** | **DONE** `20260612T021500Z` — 13 settings sources inventoried; unified `intake_policy` contract proposed; 14d closing_soon hardcoded; store-tier intake UI-only; `SAFE_TO_IMPLEMENT_POLICY_READ_MODEL: yes`; Maysam approval for status vocab + store tier + FRR |
| **Claim lifecycle source→API contract** | **LOCKED** `20260612T023000Z` — 12 generators + live emitters → enrichment pipeline → 8 Claim Center queues; dedupe/twin-row/FRR-edge rules; `SAFE_TO_IMPLEMENT_LIFECYCLE_API_FIXES: yes` |
| **Claim Center queue semantics + money polish V1** | **DONE** `20260612T020500Z` — money projection, queue filters aligned, twin grouping, `/evidence` API, recovery observed-only, references materialized empty state; build+smoke PASS; `SAFE_TO_PUSH: yes` |
| **Claim intake policy read-model V1** | **DONE** `20260612T021500Z` — `claim-intake-policy-contract`, `deriveClaimLifecycleStatus`, policy-driven windows, per-row `lifecycle_status` + `policy_warnings`, `/sources` API; build+smoke PASS; `SAFE_TO_PUSH: yes` |
| **Claim money/price/cost/loss contract V1** | **AUDITED** `20260612T023000Z` — three-lane money contract (sale context / actual cost / observed reimbursement); SellerSnap not wired; ORBIT COGS anti-pattern flagged; `SAFE_TO_IMPLEMENT_MONEY_PRICE_COST_READ_MODEL: conditional_no`; Maysam approval required |
| **Physical return MVP slice contract V1** | **LOCKED** `20260612T024000Z` — scanner-origin first; families `physical_return_off_manifest` + `physical_return_issue`; Claim Center queue mapping; staging 4→2 grouped rows; `SAFE_TO_DRYRUN_PHYSICAL_RETURN_MVP: yes` |
| **Physical return MVP read-model V1** | **DONE** `20260612T193200Z` — grouped twin cards, operational money copy, detail story blocks, MVP scope filter; zero writes; build+smoke PASS; `SAFE_TO_PUSH: yes` |
| **Physical return product linkage dry-run V1** | **DONE** `20260612T194815Z` — formal exact-identifier dry-run; 4 MVP candidates; FNSKU `X006OFFM01` no map hit; 0 deterministic matches; `SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT: no`; prior pilot audit `20260612T193528Z` aligned |
| **Product financial spine approval V1** | **PACK READY** `20260612T200000Z` — approval questions for cost/price history tables; PC04 reuse for dims; fee/claim_money snapshots deferred; `SAFE_TO_PROCEED_PHYSICAL_RETURN_CLAIM_MVP: yes`; `SAFE_TO_IMPLEMENT_FINANCIAL_SCHEMA: no` until Maysam sign-off |
| **Claim Center data contract** | **AUDITED** `20260612T004200Z` — smoke org now **4** active candidates post emit; legacy_seed quarantined rows hidden |
| **Claim Center V2 final contract** | **LOCKED** `20260612T005500Z` — implemented read-only shell; Maysam approval still gates write bridge |
| **Claim pool staging emit** | **DONE** `20260612T004437Z` — smoke org **4** active candidates; ISO `event_date` window fix applied in V2 implement |
| **PWA settings** | **SEPARATED** — dedicated `/platform/settings/pwa` (policy writable via `platform_settings.pwa_settings`; manifest/icons read-only from `public/manifest.json`); removed from Platform Branding page; sidebar leaf **PWA / Installable app**; access/RBAC untouched |
| **Nav/settings audit** | **20260611T200000Z** — duplicate-surface inventory complete; Phase 1 cleanup = link-only + remove duplicate claim intake policy from `/settings?tab=claim_engine`; Claim Center not in sidebar; `/inventory` + `/settlements` sidebar dead links |
| **Nav cleanup Phase 1** | **DONE** `20260611T212600Z` — Claim Center sidebar leaf; settings dedupe; hub nav removed from settings; broken leaves hidden; WMS scan → operator mobile; dashboard + Claim Center settings deep links; smoke PASS |
| **Claim Center UX contract** | **V2** `20260611T223000Z` — four-zone IA, single-nav, full-width, 12 ops screens + external automation/reports; detail 6-block story; **awaiting Maysam approval** |
| Candidate → case → submission bridge | **NOT BUILT** — audit `phase-claim-legacy-submission-pdf-agent-bridge-audit/20260611T190000Z/` · SAFE_TO_BUILD **yes_with_conditions** · reuse legacy PDF + claim_submissions |
| **ORBIT-FRA integration** | **AUDITED** — generator exists (`orbit_fra`); spreadsheet import = hybrid staged → `claim_candidates`; **import apply blocked** until dry-run |
| **TRID / Product Story source mining V2** | **AUDITED** `20260612T030000Z` — source→TRID→Product Story→Claim API contract locked; dry-run edges **yes**; full story API **no** (linkage 49.1%); SellerSnap/COGS + FBA returns gaps; Maysam approval for new columns/tables |
| **Source connector readiness V1** | **AUDITED** `20260612T200431Z` — 17-source matrix; ORBIT generator live / XLSX blocked; SellerSnap COGS not wired; SAFE-T empty; `SAFE_TO_IMPLEMENT_SOURCE_CONNECTOR_READMODEL=yes`; evidence `phase-amazon-orbit-fra-source-connector-readiness-v1/20260612T200431Z/` |
| **Source connector read-model V1** | **IMPLEMENTED** `20260612T205500Z` — `GET /api/claims/center/sources` + `connector_readiness`; Claim Center Sources page; read-only SELECT/count; build+smoke PASS; **`SAFE_TO_PUSH: yes`** |
| **Claim source acquisition checklist V1** | **AUDITED** `20260612T235331Z` — 20 sources × 16 families; SAFE-T **empty**; 5 stale; Maysam download list; `SAFE_TO_USE_CURRENT_DATA_FOR_CLAIM_DISPLAY=no`; evidence `phase-amazon-claim-source-acquisition-checklist-v1/20260612T235331Z/` |
| **Removal source supersession read-model V1** | **IMPLEMENTED** `20260613T001200Z` — `lib/claims/removal/removal-source-supersession-readmodel.ts`; staging **176** duplicate scope groups / **239** affected partial rows; X004LKS4VD trace (production): older partial `7f5a0285` superseded by `4e8e4492`; clean **52** / disputed **1** EP; `removal_source_supersession` on sources payload; build+smoke PASS; **`SAFE_TO_PUSH: yes`** |
| **Amazon item lifecycle claim coverage V1** | **AUDITED** `20260612T232310Z` — 19 lifecycle states; **7** full claim-path support; **FBA customer returns** import-only (no generator); lifecycle qty dashboard missing; `SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL: yes`; evidence `phase-amazon-item-lifecycle-claim-coverage-audit-v1/20260612T232310Z/` |
| **Product lifecycle quantity read-model contract V1** | **LOCKED** `20260612T234909Z` — 18 per-product qty states; source→state mapping; confidence/disputed rules; X004LKS4VD trace; API `GET /api/products/[id]/lifecycle-quantities`; SAFE-T/fee tables empty; `SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL: yes`; evidence `phase-product-amazon-lifecycle-quantity-readmodel-contract-v1/20260612T234909Z/` |
| **Product lifecycle quantity read-model IMPLEMENT V1** | **IMPLEMENTED** `20260613T002000Z` — `lib/product-lifecycle-quantity-readmodel.ts`; GET `/api/dashboard/products/[id]/lifecycle-quantities` + alias `/api/products/[id]/lifecycle-quantities`; 18 states; disputed EP/superseded removal excluded; SAFE-T/stranded unavailable; build+smoke PASS; **`SAFE_TO_PUSH: yes`** |
| **Raw Amazon table naming + claim_reimbursements audit V1** | **EXECUTED** `20260613T042120Z` — 27 source-like tables on original (`kxsvedvpjldygtdbylsy`); **23** `amazon_*` raw domain + **3** import ledger + **1** claim-layer (`claim_reimbursements`); `amazon_reimbursements` **12,711** rows = raw SP-API domain (generators/readmodels use for observed reimbursement); `claim_reimbursements` **0** rows = claim-layer outcome (FK→`claim_candidates`, `source_table`/`source_row_id` pointer); **not** in app/lib generators; low duplicate risk; `SAFE_TO_KEEP_CLAIM_REIMBURSEMENTS: yes`; evidence `phase-raw-amazon-table-naming-claim-reimbursements-audit-v1/20260613T042120Z/` |
| **Live table RLS + org scope audit V1** | **AUDITED** `20260613T040815Z` — **63** tables on original; scanner/claims/PIM spine **PASS**; gaps: `amazon_reimbursements` RLS on **0 policies** (12,711 rows), `claim_reimbursements` RLS **off** (0 rows); Task Center not on original; `SAFE_FOR_LIVE_SECURITY: no`; evidence `phase-live-table-rls-org-scope-audit-v1/20260613T040815Z/` |
| **RLS policy batch claim + amazon reimbursements V1** | **STAGING APPLIED** `20260613T041935Z` — migration `20260614120000`; 2 policies each; RLS tests PASS; `SAFE_TO_APPLY_ORIGINAL: yes_pending_maysam` |
| **RLS policy batch original apply V1** | **ORIGINAL APPLIED + VERIFIED** `20260613T042656Z` — Maysam approved; amazon_reimbursements **12711** rows / 2 policies; claim_reimbursements RLS on / 0 rows; no data mutation; access PASS; `SAFE_ORIGINAL_RLS_FIXED: yes`; evidence `phase-rls-policy-batch-claim-amazon-reimbursements-v1-original-apply/20260613T042656Z/` |
| **Maysam sample zip source coverage audit V1** | **AUDITED** `20260613T003412Z` — 25 files in `test.zip`; 21 map to live importers/tables; 4 unsupported (inbound placement detail, returns processing fee, low-inventory fee, reports repo preamble scan); SAFE-T header-only (0 rows); Inventory Ledger = Daily Summary not Detail View; `SAFE_TO_STOP_RANDOM_FILE_REQUESTS: partial`; evidence `phase-amazon-sample-zip-source-coverage-audit-v1/20260613T003412Z/` |
| **SP-API Reports API-first sync roadmap V1** | **PLANNED** `20260613T003921Z` — 37 sources × API-first matrix; 4 live Reports API workers (reimbursements, settlements, removal order/shipment); Finances API archive-only; Phase 0 enable+backfill safe; ledger+FBA returns Phase 1; file fallback for SAFE-T/COGS/third-party; `SAFE_TO_IMPLEMENT_FIRST_API_SYNC_PHASE: yes`; evidence `phase-amazon-spapi-reports-api-first-sync-roadmap-v1/20260613T003921Z/` |
| **SP-API Phase 0 staging backfill V1** | **EXECUTED** `20260613T011840Z` — script `phase-amazon-spapi-sync-phase0-runnow-backfill-v1-readonly.ts`; reimbursements **8/8 chunks PASS** (+23,154 domain rows → 35,865); settlements **FAIL** `list_reports_failed HTTP 400` on 7mo window (upload stub only); removals **16/16 chunks FAIL/stuck** `synthetic_upload_ready`/`failed` (uploads +8 each, domain rows unchanged); env flags **off in .env.local** (in-process override for execute); AWS keys in marketplace blob (`aws_access_key`/`aws_secret_key`); Claim Center sources: reimbursements **fresh**, settlements upload fresh/domain stale May 18, removals upload fresh/domain stale Jun 1; claim_candidates delta **0**; build PASS; `SAFE_TO_PUSH: conditional_yes`; evidence `phase-amazon-spapi-sync-phase0-runnow-backfill-v1/20260613T005905Z/` |
| **SP-API next workers design V1** | **LOCKED** `20260613T012050Z` — read-only design for 7 source groups; **reuse** amazon_returns, amazon_inventory_ledger, amazon_monthly_storage_fees, amazon_manage_fba_inventory, amazon_reserved_inventory; **new table** amazon_stranded_inventory + cost spine (Maysam approval); priority **1A Ledger Detail** → **1B FBA Returns** → SellerSnap file → storage/snapshots → stranded → catalog; Detail View ingest gate required; `SAFE_TO_IMPLEMENT_NEXT_WORKER_PHASE: yes_with_conditions`; evidence `phase-amazon-spapi-next-workers-design-v1/20260613T012050Z/` |
| **Claim family quantity/money formula contract V2** | **LOCKED** `20260613T020000Z` — 27 families × exact claim_quantity/actual_loss/estimated_amazon_reimbursement/observed_reimbursement/reimbursement_gap/fee gaps; join keys + source priority + TRID; live **10** / partial **8** / gap **9**; first 5: customer_return_not_reimbursed, physical_return_scanner, removal_order_discrepancy, missing_reimbursement, orbit_fra; `SAFE_TO_IMPLEMENT_CLAIM_CALCULATION_READMODEL: yes`; evidence `phase-claim-family-quantity-money-formula-contract-v2/20260613T020000Z/` |
| **Claim family algorithm matrix V2 gap expansion** | **LOCKED** `20260613T030000Z` — superseded for official coverage by V3; 34 families |
| **Claim family algorithm matrix V3 official Amazon coverage** | **LOCKED** `20260613T050000Z` — **41** families; registry + SP-API crosswalk + normalized tables; **+7** V3 (finances mismatch, shipment/refund mismatch, removal fee mismatch, long-term storage, storage utilization, overage aged fee, recommended removal action); 9 missing source mappings; fee-adjusted payout rules per family; `SAFE_TO_IMPLEMENT_V3_CLAIM_READMODEL: yes`; evidence `phase-claim-family-algorithm-matrix-v3-official-amazon-coverage/20260613T050000Z/` |
| **Claim family algorithm matrix V1** | **LOCKED** `20260613T010000Z` — superseded for calc detail by V2; 23-family overview retained |
| **Claim family algorithm read-model V1** | **IMPLEMENTED** `20260613T025316Z` — `GET /api/claims/center/algorithm-matrix`; `lib/claims/center/claim-family-algorithm-readmodel.ts`; 23 families; status live **9** / partial **8** / gap **6**; hard rules + priority order; no DB writes; build+smoke PASS; `SAFE_TO_PUSH: yes`; evidence `phase-claim-family-algorithm-readmodel-implement-v1/20260613T025316Z/` |
| **Amazon fee/reimbursement estimate model V1** | **LOCKED** `20260613T014104Z` — superseded for payout/COGS separation by fee-adjusted V1; 5 money lanes overview retained |
| **Amazon fee-adjusted reimbursement estimate model V1** | **LOCKED** `20260613T040000Z` — contract + `computeFeeAdjustedMoneyOutput` |
| **Amazon fee-adjusted reimbursement readmodel V1** | **IMPLEMENTED** `20260613T060000Z` — `lib/fees/fee-adjusted-estimate-readmodel.ts`; GET `/api/products/[id]/fee-adjusted-estimate` + dashboard alias; three lanes separated; X004LKS4VD: sale $19.99, observed $194.92, payout NULL (no fee_preview); B0000B11UX: sale $8.19, COGS NULL; build+smoke PASS; `SAFE_TO_PUSH: yes`; evidence `smoke-fee-adjusted-estimate-readmodel-v1/20260613T060000Z/` |
| **Claim family algorithm matrix V3 readmodel + AI optional contract V1** | **IMPLEMENTED** `20260613T071000Z` — `GET /api/claims/center/algorithm-matrix-v3`; 41 families (32 claim-capable: 23 claim_family + 9 claim_when_source_available; 7 review signals; 2 lifecycle); AI optional overlay contract (6 capabilities / 7 not-required guards); Menorix `ai_assistant` flag checked but not required for core readmodel; no DB writes; build+smoke PASS; `SAFE_TO_PUSH: yes`; evidence `smoke-claim-family-algorithm-v3-readmodel-v1/20260613T072000Z/` |
| **Product cost manual input placeholder contract V1** | **LOCKED** `20260613T080000Z` — `lib/products/contracts/product-cost-manual-input-placeholder-contract-v1.ts`; precedence purchase > landed > SellerSnap > manual > upload > NULL; interim `cogs_overrides`; CSV + manual UI fields + audit rules; fee-adjusted + claim money integration documented; no schema/UI; `SAFE_TO_IMPLEMENT_COST_INPUT_UI_LATER: yes_with_conditions`; evidence `phase-product-cost-manual-input-placeholder-contract-v1/20260613T080000Z/` |
| **Claim readmodel staging dry-run V1** | **EXECUTED** `20260613T090400Z` — 7 priority V3 families; generator previews: physical_return **16**, removal **400**, missing_reimbursement **176**; disputed EP excluded **1294**; fee_preview **0**; linkage **0%** on drafts; `SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW: yes`; evidence `phase-claim-readmodel-staging-dryrun-v1/20260613T090400Z/` |
| **Claim V3 readmodel dry-run clean data V1** | **SUPERSEDED** for gating detail by source-and-linkage-gated V1 below; retained as prior pass |
| **Claim V3 dry-run source-and-linkage-gated V1** | **EXECUTED** `20260613T050302Z` — all **41** V3 families read-only on staging; classifications: claim_ready_preview **4**, review_only **7**, blocked_missing_source **10**, blocked_missing_linkage **18**, blocked_missing_fee **0**, blocked_missing_cost **0**, lifecycle_only **2**; claim_ready: physical_return (23 clean / 20 preview), removal_order + removal_shipment (78685 clean / 1294 disputed excluded / 400 preview each), partial_incorrect_reimbursement (321 preview); priority blocked: customer_return, missing_reimbursement, warehouse_lost/damaged, settlement_refund, orbit_fra — linkage; fee families blocked_missing_source (fee_preview/storage empty); linkage grade **critical** 45.3%; claim_candidates delta **0**; smoke PASS; original compare **FAIL** (`quarantined_at` column missing on original); `SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW: yes`; evidence `phase-claim-v3-dryrun-source-and-linkage-gated-v1/20260613T050302Z/` |
| **First claim preview readmodel MVP V1** | **IMPLEMENTED + VERIFIED** `20260613T120000Z` — `GET /api/claims/center/claim-preview`; 5 families (removal_order, removal_shipment_missing, physical_return, missing_reimbursement, settlement_refund); per-item `status` (claim_ready_preview / needs_review / blocked); staging **59** items / **28** claim_ready_preview; disputed EP excluded **249** on removal families; fee payout NULL; linkage blocks missing_reimb + settlement; claim_candidates delta **0**; build+smoke PASS; `SAFE_TO_PUSH: yes`; evidence `smoke-claim-preview-readmodel-mvp-v1/20260613T120000Z/` |
| **Original product link No Link regression audit V1** | **AUDITED** `20260613T051948Z` — original spine intact (17,058 products / 16,849 map / 29,571 prices); samples B0000B11UX, X004LKS4VD, X003VSWH37 resolve **Linked** on original when readmodel simulated; root cause **runtime_env_mismatch** (NEXT_PUBLIC→staging, ORIGINAL_* separate); contributing missing `store_id` → unresolved; not data deletion / not RLS service-role; label **"No product link yet"**; `SAFE_TO_FIX_NO_LINK: no` until env bind verified; evidence `phase-original-product-link-no-link-regression-audit-v1/20260613T051948Z/` |
| **Original product link No Link minimal fix V1** | **IMPLEMENTED** `20260613T052400Z` — readmodel-only: spine-aware `mapRowToProductLinkageDisplayContract`, enrich hydrates from `product_identifier_map` when operational `resolved_product_id` null, UI label prefers `is_resolved`; samples pass on original; unlinked control X000NOMAP99 still No Link; build+smoke PASS; **`SAFE_TO_PUSH: yes`**; evidence `phase-original-product-link-no-link-minimal-fix-v1/20260613T052400Z/` |
| **Operational rows backfill dry-run V1 (Wave 1)** | **EXECUTED** `20260613T052709Z` — staging dry-run only; wave1 tables `amazon_removals`/`amazon_removal_shipments`/`expected_packages`; **9831** resolvable exact-identifier rows; **0** ambiguous; **1500** sample proposals (500/table); preimage+rollback SQL; projected wave1 linkage **97.2%**; original compare read-only (EP mostly linked already); no writes; **`SAFE_TO_IMPLEMENT_WAVE1_BACKFILL_STAGING_WRITE: yes`**; **BLOCKED** until original No Link resolved; evidence `phase-product-linkage-operational-rows-backfill-dryrun-v1/20260613T052709Z/` |
| **Original product No Link emergency diagnose V1** | **EXECUTED** `20260613T053153Z` — read-only; original spine **intact** for B0000B11UX, X004LKS4VD, X003VSWH37 (map=1 each, store_match); staging mirror identical; product detail API sim **Linked** on original+staging when org/store correct; wrong store → 404/empty map; root cause **runtime_env_mismatch** + **deploy/cache** (readmodel fix may not be on original bundle); RLS does not block service-role; **`SAFE_TO_FIX_WITH_CODE_ONLY: yes`**; **`NO_DATA_MUTATION_VERIFICATION: PASS`**; evidence `phase-original-product-no-link-emergency-readonly-diagnose-v1/20260613T053153Z/` |
| **Original runtime env bind verify V1** | **EXECUTED** `20260613T054315Z` — runtime ref **eiqfaapyumhixxoeltgu** (staging) ≠ original **kxsvedvpjldygtdbylsy**; URL+service_role keys do not match ORIGINAL_*; **2 dev servers** on 3000/3001 active; fix files on **412d767** main; Shipment Entry inventory path X004LKS4VD/X003VSWH37 → **Linked** on both binds; ZQCPD4GHB/ZZQCP25AW3 no view rows; **`SAFE_TO_CONTINUE_TO_UI_SMOKE: no`** until env swap+restart; evidence `phase-original-runtime-env-bind-verify-v1/20260613T054315Z/` |
| **Shipment #25 No Link screenshot audit V1** | **EXECUTED** `20260613T055446Z` — items **ZZQDPD4GHB** / **ZZQCP25AW3** on original: **0** `product_identifier_map` hits; source **slip_contents** with OCR **description** (names visible) but `resolved_product_id` null; resolver unresolved with store; UI **correctly** shows No Link; **NOT** mapper regression for these rows; **`SAFE_TO_FIX_WITH_CODE_ONLY: no`**; evidence `phase-shipment25-no-link-screenshot-specific-audit-v1/20260613T055446Z/` |
| **Reports API sample pull + mapping V1** | **EXECUTED** `20260613T022213Z` — 7-day staging sample; script `phase-amazon-reports-api-sample-pull-and-mapping-v1.ts`; **PASS** reimbursements 819, settlement 19,246, FBA returns 118, ledger detail 33,690 domain rows; **STUCK** removal order/shipment `synthetic_upload_ready`; **FAIL** storage fees + fee preview import; **HEADER-ONLY** stranded 59 rows (asin/sku/fnsku mapped, no table); no permission errors; claim_candidates delta **0**; build PASS; smoke preflight blocked (flags not in `.env.local`); `SAFE_TO_IMPLEMENT_API_BACKFILL_PHASE: conditional_no`; evidence `phase-amazon-reports-api-sample-pull-and-mapping-v1/20260613T014517Z/` |
| **SP-API Phase 0 freshness verify (no reconnect) V1** | **EXECUTED** `20260613T025053Z` — removals stuck `synthetic_upload_ready`; **fixed** by promotion phase `20260613T030638Z` |
| **Removal synthetic upload promotion fix V1** | **FIXED** `20260613T030638Z` — `resolveRemovalReportsRunPipeline`: resume with uploadId auto-promotes; 4 stuck uploads → **complete**; domain removals 2719→**2993**, shipments 9316→**10699**; stuck count **0**; EP dup groups **0**; supersession active; claim_candidates delta **0**; build+smoke PASS; `SAFE_TO_PUSH: yes`; evidence `phase-amazon-removal-synthetic-upload-promotion-fix-v1/20260613T030405Z/` |

## Task Center (Menorix)

| Item | Status |
|------|--------|
| **Schema V3 approval** | **APPROVED** — Maysam sign-off on task-org-schema-v3 pack |
| **Phase 7A staging apply** | **APPLIED** `20260612T024718Z` @ `eiqfaapyumhixxoeltgu` — `task_items`, `task_comments`, `task_watchers`, `task_activity_log`; `groups.group_type` + `parent_group_id` |
| **RLS hard gate** | **PASS** — service_role ALL; authenticated SELECT only; child EXISTS join; cross-org test PASS |
| **Seeded tasks** | **0** — no demo/fake tasks |
| **Scanner task bridge** | **DEFERRED** — no scanner code touched |
| **UI scaffold** | **READY** — `SAFE_FOR_NEDA_UI_START: yes` |
| **UI/API contract V1** | **LOCKED** `20260612T025009Z` — `lib/task-center/*`, `docs/menorix/task-center-ui-api-contract-v1.md`; read routes proposed; writes Phase 7B |
| **UI shell V1 (Neda)** | **IMPLEMENTED** `20260612T030045Z` — `/task-center` home/my/queues/sources/org/[id]; read API routes; Menorix shell; empty states; build+smoke PASS |
| **Nav independent module V1** | **DONE** `20260612T230103Z` — `TASK_CENTER_NAV_LEAF` top-level (after Dashboard); removed from Finance & Claims; copy **Operations tasks**; RBAC unchanged (`operations.task_center`); build+smoke PASS; `SAFE_TO_PUSH: yes` |
| **Write phase** | **NOT BUILT** — server/service_role only when Phase 7B approved |

Evidence: `.cursor/audit-reports/phase7a-task-center-schema-staging-verify/20260612T024718Z/` · nav fix `.cursor/audit-reports/phase-task-center-navigation-fix-v1/20260612T230103Z/`

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

## Product linkage (2026-06-13 audit)

| Metric | Staging |
|--------|--------:|
| Operational linkage | **45.3%** (grade **critical**) |
| Spine map coverage | **97.9%** (352 products missing map) |
| Critical paths | **64.7%** |
| Unresolved operational rows | **28,567** |
| Identifier conflict groups | **2,584** (170 ASIN · 2,413 UPC · 1 FNSKU) |
| SAFE_FOR_PRODUCT_STORY | **no** |
| **SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN** | **done** `20260613T050302Z` — gated dry-run PASS; trusted money still blocked until linkage wave |

**Audit:** `phase-product-linkage-health-and-claim-blocker-readmodel-v1/20260613T044257Z/` · script locks linkage as first gate before claim money.

**Operational resolution plan V1:** `phase-product-linkage-operational-rows-resolution-plan-v1/20260613T045948Z/` — **791,083** rows resolvable by exact identifier; **12,892** ambiguous (ledger-heavy); wave 1: removals/shipments/EP; **SAFE_TO_IMPLEMENT_OPERATIONAL_LINKAGE_BACKFILL: conditional**

Hardening: `lib/product-linkage-*` + `GET /api/dashboard/products/linkage-health`.  
**Wave 1 (RI scanner resolver) EXECUTED** `20260521T210500Z`: governance **PASS**, **0 rows updated**.  
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

**Smoke apply `20260521T231500Z`:** enrich batch PASS (80 rows); promote **0** (scan window bug).

**Scale batch 1 `20260521T250000Z`:** indexes 160–399; cursor **400**.  
**Scale batch 2 `20260611T220000Z`:** indexes 400–639; **240 rows**; **15** images; cursor **640**; **0** overwrites; scheduler **disabled**. Evidence: `.cursor/audit-reports/phase-amazon-product-sync-recovery-staging-scale/20260611T220000Z/`

## Product dimensions + shipment/fee claim sources (AUDITED 2026-06-12)

**Run:** `phase-product-dimensions-shipment-fee-claim-audit-v1/20260612T185018Z/` · **read-only** · **no DB writes**

| Item | Finding |
|------|---------|
| **Maysam dimensions table** | **Confirmed:** PC04 stack — `product_packaging_profiles` → `product_packaging_profile_versions` → **`product_packaging_dimensions_current`** (+ `product_packaging_evidence`) |
| Staging `dimensions_current` | **571** rows (**3.3%** of 17,059 products) — 191 `amazon_report` / 380 `import`; 80 rows with full L×W×H |
| Legacy `products` dim cols | **0 populated** — `amazon_raw` on **13,206** products (Catalog API payload; dims embedded not normalized) |
| Fee preview / storage reports | **0 rows** on staging — design must not assume report tables populated |
| Settlements | **585,637** rows — fee amounts in `amount_total`, `fba_fees`, `selling_fees`; **527,938** with SKU |
| FRR | **573,533** rows — all have `trid_key`; **548,289** with amount |
| Removal / EP | **9,316** removal shipments (**4,714** RPID); **9,738** EP (**8,946** tracking; `removal_fee` on EP) |
| **SAFE_TO_DESIGN_DIMENSION_FEE_SCHEMA** | **yes** |
| Next | **PHASE-PRODUCT-DIMENSIONS-FEE-CLAIM-SCHEMA-DESIGN-V1** (design-only; no apply) |

Detail: [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md) · evidence JSON keys in audit folder

## PC04 dimensions history + evidence contract (2026-06-12)

**Run:** `phase-pc04-dimensions-history-evidence-contract-v1/20260612T195458Z/` · **read-only contract**

| Item | Finding |
|------|---------|
| History model | **profile_versions** = append-only history; **dimensions_current** = latest read model only |
| Staging | **571** profiles / versions / current; **0** `product_packaging_evidence` rows |
| Provenance | **571** versions have `evidence_summary` jsonb; evidence table unused |
| Multi-version | **0** profiles with >1 version — supersede path untested |
| **new_table_needed** | **no** — extend PC04; no `product_dimensions_snapshots` fork |
| **migration_needed** | **conditional_yes** — measured_by view, evidence backfill, immutability guard, dim_weight view |
| **SAFE_TO_USE_PC04_FOR_CLAIM_DIMENSIONS** | **yes** |
| Next | **PHASE-PC04-DIMENSIONS-HISTORY-EVIDENCE-IMPLEMENT-V1** |

## Physical return MVP — product linkage dry-run (2026-06-12)

**Run:** `phase-product-linkage-physical-return-mvp-dryrun-v1/20260612T194815Z/` · **read-only**

| Item | Finding |
|------|---------|
| Smoke org | `7397edff-7994-4731-8501-55d258d507d2` (4 MVP candidates) |
| Candidates | **4** — 2 physical `return_items` × twin rows (`scanner_physical_review` + `orbit_fra`) |
| Already resolved | **0 / 4** |
| Deterministic map matches | **0** — FNSKU `X006OFFM01` (QA off-manifest test) has **no** `product_identifier_map` hit |
| Conflicts | **0** |
| Safe pilot rows | **0** |
| **SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT** | **no** |
| Blocker | Identifier present but **not in spine** — needs real FNSKU/ASIN/SKU capture or governed map seed, not resolver apply |
| Next | **PHASE-PRODUCT-LINKAGE-PHYSICAL-RETURN-MVP-IDENTIFIER-REPAIR-V1** (read-only repair plan) |

## Physical return linkage data ingest (2026-06-12)

**Run:** `phase-claim-physical-return-product-linkage-data-ingest-v1/20260612T203117Z/` · **plan only** (0 rows ingested)

| Item | Finding |
|------|---------|
| Fixture org spine | **0** products / catalog / map / prices (`7397edff-…`) |
| FNSKU `X006OFFM01` | Zebra QA fixture — **0** global hits in map, products, catalog, Amazon inventory |
| Amazon import path | **blocked** — nothing to ingest |
| Rows ingested | **0** |
| Deterministic match after | **no** |
| **SAFE_TO_RUN_PRODUCT_LINKAGE_APPLY_V1** | **no** |
| Unblock options | (1) Maysam-approved governed map seed to explicit `product_id`; (2) re-scan with real FNSKU in main-org spine |

Evidence: `.cursor/audit-reports/phase-claim-physical-return-product-linkage-data-ingest-v1/20260612T203117Z/`

## Physical return real FNSKU smoke target (2026-06-12)

**Run:** `phase-claim-physical-return-real-fnsku-smoke-target-v1/20260612T211257Z/` · **read-only**

| Item | Finding |
|------|---------|
| Fixture org spine | **0** products / catalog / map / prices |
| Main org spine | **17059** products · **16850** PIM · **29589** prices |
| Real FNSKU candidates | **30** (no ambiguity) in main org |
| Fixture-aligned targets | **0** |
| Best target | **B0000B11UX** → `8beddd08-…`, ASIN+MSKU `X0036MJ5ZB`, price **$8.19**, store `509ee1f6-…` |
| **SAFE_TO_USE_REAL_FNSKU_FOR_PHYSICAL_RETURN_MVP** | **yes** (main-org operator re-scan; no cross-org mapping) |
| Next | **PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-RESCAN-SMOKE-V1** |

## Physical return real FNSKU linkage dry-run (2026-06-12)

**Run:** `phase-claim-physical-return-real-fnsku-linkage-dryrun-v1/20260612T211536Z/` · **read-only**

| Item | Finding |
|------|---------|
| Target | **B0000B11UX** → `8beddd08-…` @ main org |
| Combined identifiers | **resolved** deterministic |
| FNSKU-only path | **unresolved** (ASIN/SKU resolve — scan should include full bundle) |
| Product Story | **safe** |
| TRID product_link | **would materialize** |
| Money | **Cost unknown**; sale **$8.19** context only |
| **SAFE_TO_APPLY_REAL_FNSKU_PHYSICAL_RETURN_LINKAGE** | **yes** |

## Physical return real FNSKU controlled seed (2026-06-12)

**Run:** `phase-claim-physical-return-real-fnsku-controlled-seed-v1/20260612T231544Z/` · **staging seed + verify**

| Item | Finding |
|------|---------|
| Target | **B0000B11UX** → `8beddd08-…` @ main org store `509ee1f6-…` |
| Seeded | package `8a3eb3f9-…` + return_item `1960ee2a-…` (off-manifest notes + `raw_return_data.test_seed`) |
| Candidate | `8e8dc9bd-…` via `emitBoxCloseCandidates` (`scanner_physical_review`) |
| Linkage | **resolved** (bundle ASIN+SKU); FNSKU-only still unresolved |
| Money | **Cost unknown**; no sale-as-COGS |
| TRID preview | product_link + source_evidence + shipment_scope **ready** |
| PIM/products | **unchanged**; no claim cases/submissions |
| Build + rescan smoke | **PASS** |
| **SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_TRID_EDGES** | **yes** |
| Rollback | `.cursor/audit-reports/phase-claim-physical-return-real-fnsku-controlled-seed-v1/20260612T231544Z/rollback.sql` |
| Next | **PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1** (Maysam approval) |

## Physical return real FNSKU rescan smoke (2026-06-12)

**Run:** `phase-claim-physical-return-real-fnsku-rescan-smoke-v1/20260612T221221Z/` · superseded by controlled seed `20260612T231544Z` re-smoke **PASS**

| Item | Finding |
|------|---------|
| Operator scan | **controlled seed** (no physical device) |
| Build | **PASS** |
| Claim Center smoke | **PASS** |
| PIM / fixture seed | **unchanged** (16850 main-org PIM; 0 fixture `X006OFFM01` map rows) |
| Product auto-create | **0** in last 2h |
| Scanner code | **unchanged** (`app/scanner/operator-mobile/**`) |
| **SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_TRID_EDGES** | **no** (operator scan required first) |
| Next | **OPERATOR-ACTION:** scan **B0000B11UX** off-manifest unit via scanner mobile in main org, then re-run rescan smoke |

Evidence: `.cursor/audit-reports/phase-claim-physical-return-real-fnsku-rescan-smoke-v1/20260612T221221Z/`

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

