# Next actions — canonical

**Branch:** `feature/phase1-latest-stash-land` @ `999f765` · **main** `4402064` (not merged)  
**Last updated:** 2026-06-24 (`phase-amazon-live-source-sync-resume-and-complete-v1` **RESUME-AGAIN cycle 3 / CONVERGED** `20260624T030733Z` **LIVE @ `kxsvedvpjldygtdbylsy`, guarded** — re-ran the existing idempotent orchestrator after ~45 min more back-off; **0 net new rows on every source → resume loop CONVERGED.** inventory_ledger DATA COMPLETE (371,391, fresh through 2026-06-21; re-download yields 0 net; run-state non-terminal but data done — stop re-running). reimbursements/removal_order/removal_shipment/fba_returns already_complete. Still blocked (out-of-scope): fee_preview (`amazon_fee_preview` schema), inbound_performance (createReport 400), finances_archive (`run_failed` mid-pagination, 20,221 → cron). settlement read-only (677,098). no_claim_mutation [9155/22/22/13]; tsc 0, smoke 32/32, `next build` exit 0. **SAFE_LIVE_SOURCE_SYNC_RESUME_COMPLETE=no (partial/converged), SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN=yes.** NEXT: stop blind resumes → `PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1`; cron for finances; gated fixes for fee_preview schema + inbound_performance params. Report `.cursor/audit-reports/phase-amazon-live-source-sync-resume-and-complete-v1/20260624T030733Z/`.)
Prior: 2026-06-24 (`phase-amazon-live-source-sync-resume-and-complete-v1` **RESUME-AGAIN** `20260624T022259Z` (+`20260624T020858Z`) **LIVE @ `kxsvedvpjldygtdbylsy`, guarded** — re-ran the existing idempotent orchestrator 2 more cycles (resume-by-`uploadId`, all 9 source_run_ids REUSED, no dup reports). **inventory_ledger imported +89,039 rows** (282,352→**371,391**, fresh through 2026-06-21; then `QuotaExceeded` throttle → backed off, still needs_resume). reimbursements/removal_order/removal_shipment/fba_returns already_complete (0 re-imported, idempotent). Blocked (out-of-scope): fee_preview (`amazon_fee_preview` schema incomplete), inbound_performance (createReport 400), finances_archive (`max_attempts` mid-pagination, cron-resumable). settlement read-only (677,098 unchanged). no_claim_mutation [9155/22/22/13]; tsc 0, smoke 32/32, `next build` exit 0 (after removing an untracked broken `backend-python/venv` that escaped the project root + broke Turbopack; gitignored). **SAFE_LIVE_SOURCE_SYNC_RESUME_COMPLETE=no (partial), SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN=yes.** Files: orchestrator (re-run) + `.gitignore` (additive) + quartet. Reports `.cursor/audit-reports/phase-amazon-live-source-sync-resume-and-complete-v1/{20260624T020858Z,20260624T022259Z}/`.)
Prior: 2026-06-24 (`phase-amazon-live-source-sync-resume-and-complete-v1` `20260624T012511Z` **LIVE RESUME @ LIVE `kxsvedvpjldygtdbylsy`; guarded** — NO claim submit / NO Amazon case·Feeds API / NO browser / NO claim-candidate generation / NO `claim_*` mutation / NO scanner change / NO AI / NO secrets. Both gates pass. NEW resume orchestrator `scripts/phase-amazon-live-source-sync-resume-and-complete-v1.ts` resumes each EXISTING upload **by `uploadId`** (polls existing `report_id`, never a new createReport → no duplicate reports despite UTC-day rollover); all 9 source_run_ids REUSED. **4 complete, +1,807 rows:** reimbursements +1,063 (→18,609), removal_order +93 (→3,819), removal_shipment +167 (→11,692), fba_returns +484 (→3,058). **Generating (retry safe):** inventory_ledger (throttled→new report 2048175020628 generating), finances_archive (pagination 2/53). **Failed (out-of-scope blockers):** fee_preview (import `assess pipeline: domain count failed` = `amazon_fee_preview` schema incomplete), inbound_performance (createReport HTTP 400). settlement_replayed_idempotently=no (skipped; 677,098 unchanged). no_claim_mutation [9155/22/22/13]; tsc 0, smoke 32/32, build 0 (115 pages), next build 0. **SAFE_LIVE_SOURCE_SYNC_RESUME_COMPLETE=no (partial), SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN=yes.** NEXT: RESUME-AGAIN inventory_ledger+finances after back-off then `PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1`. Files: `scripts/phase-amazon-live-source-sync-resume-and-complete-v1.ts` (new) + memory quartet. Report `.cursor/audit-reports/phase-amazon-live-source-sync-resume-and-complete-v1/20260624T012511Z/`.)
Prior: 2026-06-22 (`phase-product-trid-story-live-refresh-after-sync-v1` `20260622T222917Z` **PASS — read-model refresh + verification only @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO claim submit / NO Amazon case API / NO browser / NO claim-candidate creation / NO `claim_*` mutation / NO new tables / NO scanner change / NO AI. Re-ran the existing read-only orchestrator `scripts/phase-product-trid-story-live-refresh-v1.ts` against the freshly synced data (settlement +20,072 from `20260622T220000Z`); compose/SELECT only; **14/14 checks PASS**. **product_linkage_status=healthy**; trid_edge smoke pass (21/21). **coverage_by_area:** pilot_removal 10/10, needs_data 10/10, opportunities 72/72, reimbursement_tracking 10/10. **identity (pilot):** SKU 10/10·FNSKU 10/10·ASIN 0/10·product_id 10/10 (UPC at link time). **freshness (from Hub composer):** amazon_settlements **677,098** (+20,072; latest unknown — no typed date col), removals/removal_shipments 06-17, reimbursements 06-05, inventory_ledger 04-24, transactions 04-14, customer_returns 04-15, reports_repo 05-03, identifier_map 06-01 stale; return_items/EP/claim_* fresh; 16 live_loaded / fresh 5 / stale 9. **reference_graph (96 pilot edges):** removal_order(14)/removal_shipment(6)/tracking(10) PRESENT; expected_package/settlement/reimbursement/inventory_ledger/customer_returns/fee_preview/inbound **absent** — new settlement rows + the 8 still-resuming source reports not yet order-linked to pilot candidates. **proof:** seller_central_block_uuid_count 0, true_proof_uuid_leak 0, surrogate_removal_id_proof_edges 10 (ledger→real Amazon IDs; SC block clean), internal_kind/weak-as-proof 0. orphans settlements 57,771 (grew with import) / transactions 600 / reports_repo 3,438; ambiguous amazon_returns 38; stale_links amazon_returns 483. no_new_table/no_claim_candidate_generation/no_claim_mutation [9155/22/22/13/147]/no_amazon_submission/no_scanner_change verified; tsc 0, smoke 32/32 (+trid-edge 21/21), build exit 0 (115 pages), next build exit 0. **SAFE_PRODUCT_TRID_STORY_LIVE_REFRESHED=yes, SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN=yes.** NEXT: `PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1`; RESUME the 8 in-progress source pulls so the absent reference-graph categories populate. Files: none new (re-ran existing read-only orchestrator) + memory quartet. Report `.cursor/audit-reports/phase-product-trid-story-live-refresh-v1/20260622T222917Z/`.)
Prior: 2026-06-22 (`phase-amazon-initial-live-source-sync-execute-v1` `20260622T220000Z` **LIVE EXECUTE — FIRST REAL SP-API PULL @ LIVE `kxsvedvpjldygtdbylsy`** — guarded initial live source sync, both gates pass. **NO claim submission / NO Amazon case/Feeds API / NO browser / NO claim-candidate generation / NO `claim_*` mutation / NO scanner change / NO AI / NO secrets.** NEW run orchestrator `scripts/phase-amazon-initial-live-source-sync-run-v1.ts` (companion to the gate+probe executor) drives the existing guarded pull workers for a 30-day UTC-floored window (store `509ee1f6…`); run via `node --conditions=react-server --import tsx` (worker modules `import "server-only"`; named exports under CJS default); per-source hard timeout so a stalled socket can't hang the run. **settlement imported 20,072 rows** (amazon_settlements 657,026→677,098). 8 other sources created resumable `source_run_id`s (reimbursements/removal_order/removal_shipment/fba_returns/fee_preview also have Amazon report_ids generating; inventory_ledger sp_api_throttled; inbound_performance create_report_failed; finances polling) — all needs_resume (async report generation finishes via cron/resume). missing_permissions=[]; data_sources_hub_updated=yes; settlement Order rows for the 3 missing SKUs still 0/0/0 in this window. no_claim_mutation [9155/22/22/13]/no_amazon_submission/no_scanner_change verified; tsc 0, smoke data-sources-hub 32/32, build exit 0 (115 pages), next build exit 0. **SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE=yes, SAFE_TO_RUN_PRODUCT_TRID_STORY_LIVE_REFRESH=yes, SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN=yes.** NEXT: `PHASE-PRODUCT-TRID-STORY-LIVE-REFRESH-V1` then `PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1`; RESUME the 8 in-progress sources by re-running the orchestrator (idempotent within the UTC day) or via cron/resume routes. Files: `scripts/phase-amazon-initial-live-source-sync-run-v1.ts` (new) + memory quartet. Report `.cursor/audit-reports/phase-amazon-initial-live-source-sync-execute-v1/20260622T220108Z/`.)
Prior: 2026-06-22 (`phase-amazon-live-sync-final-readiness-verify-v1` `20260622T210000Z` **PASS — final readiness verification only @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO Amazon call / NO live sync / NO claim submit / NO case API / NO browser / NO claim-candidate generation / NO `claim_*` mutation / NO scanner change / NO secrets / NO AI. **MAJOR STATE CHANGE — operator completed activation; live sync now READY.** runtime=ORIGINAL/LIVE `kxsvedvpjldygtdbylsy` (SUPABASE_URL + NEXT_PUBLIC_SUPABASE_URL both); staging inactive (rollback-only), production blank/ignored. **All 12 env keys present+true** (`AMAZON_SP_API_ENABLED` + master + 8 reports sub-flags + finances worker + ingest) + `CRON_SECRET` present + `APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes` (Maysam 2026-06-22); missing_env_keys=[], missing_approval_items=[]. Hub probe (read-only): worker_master_enabled=true, cron_secret_present=true, credentials present, **safe_to_run_initial_live_source_sync=true**, disabled 0 / needs_env 0. **Did NOT run the executor** (gates pass → would trigger sync). no_amazon_call/no_live_sync/no_claim_mutation [9155/22/22/13]/no_scanner_change verified; tsc 0, smoke 32/32, build exit 0 (115 pages). **SAFE_LIVE_SYNC_FINAL_READINESS_VERIFIED=yes, SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC=yes** (local/runtime + approval; Vercel deployment env must carry the same keys if it runs the sync). NEXT: `PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1` (`--execute`, confirm operator intent first). Files: none (verification only) + memory quartet.)
Prior: 2026-06-22 (`phase-amazon-live-sync-env-flag-readiness-fix-v2` `20260622T200000Z` **PASS — live-sync readiness/config fix only @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO Amazon call / NO live sync / NO claim submit / NO case API / NO browser / NO claim-candidate generation / NO `claim_*` mutation / NO scanner change / NO secrets / NO AI. Confirmed **two-gate** logic (approval token + `ENABLE_AMAZON_REPORTS_API_WORKER` master + per-source/finances flags + `CRON_SECRET`; prod cron also `ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON`). **missing_env_keys (12):** REPORTS_API ×9 + FINANCES ×2 + `CRON_SECRET`; worker master DISABLED; cron_secret ABSENT. **SP-API credential presence (read-only probe, booleans only):** lwa_client_id/lwa_client_secret/refresh_token/aws_access_key/aws_secret_key/marketplace_id/region = **all yes** (2 marketplaces, 1 complete LWA) → credentials NOT a blocker. **Docs:** `.env.example` + approval template already present/correct (approval_file=**found**, token=no); **NEW** `docs/amazon/initial-live-source-sync-operator-setup.md`. **UI readiness:** added **"Initial live-sync readiness" banner** (READY/BLOCKED + worker flag + CRON_SECRET + credentials + operator-approval requirement) to `DataSourcesHubControlPlaneClient.tsx` → data_sources_ui_readiness_visible=yes, settings_ui_readiness_visible=yes. no_amazon_call/no_live_sync/no_claim_mutation [9155/22/22/13]/no_scanner_change verified; tsc 0, smoke data-sources-hub 32/32, build exit 0 (115 pages), next build exit 0. **SAFE_LIVE_SYNC_ENV_FLAGS_READY=no** (config/docs/UI ready; LIVE env still 0/12 + approval=no), **SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC=no.** NEXT: OPERATOR set 11 flags + `CRON_SECRET` + approval=yes → `PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1`; meanwhile read-only/build track. Files: `docs/amazon/initial-live-source-sync-operator-setup.md` (new), `DataSourcesHubControlPlaneClient.tsx` (readiness banner) + memory quartet.)
Prior: 2026-06-22 (`phase-build-and-evidence-reconcile-v1` `20260622T190000Z` **PASS — build/evidence/git-state reconciliation only @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO DB write / NO `claim_*` mutation / NO Amazon call / NO live sync / NO submission / NO browser / NO scanner change / NO new tables / NO AI (no code changed). Follows `20260622T184000Z` + `20260622T185000Z` (env-flag readiness, created `.env.example`). **Git:** `main` @ `95b288d`; 17 modified tracked (completed phases) + 11 untracked. **files_to_keep = ALL untracked** (`.env.example`, `app/api/platform/`, `app/platform/settings/data-sources/`, `lib/data-sources/`, `product-cost-landed-cost-hub-v1.ts`, 3 phase scripts, 3 smokes); **files_to_discard = none**. **Evidence:** found 2 amazon phase folders; **created 6 read-only `RECONCILED_FROM_MASTER_HISTORY.md`** (provenance-marked, no invented pass). **Build:** `tsc --noEmit` 0; lint 899 problems (199 err/700 warn) all pre-existing repo-wide, none in phase files, not build-breaking; **`npm run build` exit 0** (115 pages) → prior COGS-UI/node:fs FAIL **NOT present now** (`cogs_ui_build_issue_found=no`). **Smokes all PASS:** data-sources-hub 32, claim-center-nav 175, product-cost-hub 21, ready-to-file-queue static, trid-edge-readmodel 21. data_sources_hub_files_verified=yes; product_cost_files_verified=yes (no schema/migration). **Live sync still blocked:** approval=no + 12 env keys missing (9 reports + 2 finances + `CRON_SECRET`) + `CRON_SECRET` missing + flags off; `AMAZON_SP_API_ENABLED` set (catalog lane only). no_db_write / no_claim_mutation [9155/22/22/13] / no_amazon_call / no_live_sync / no_scanner_change **verified**. **SAFE_BUILD_AND_EVIDENCE_RECONCILED=yes, SAFE_TO_FIX_LIVE_SYNC_ENV_FLAGS=yes, SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC=no.** NEXT: OPERATOR commit kept files + set env/approval → `PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1`; meanwhile read-only/build track (`PHASE-PRODUCT-LANDED-COST-HUB-SCHEMA-AND-UI-BUILD-V1`). Files: 6 evidence reports + memory quartet (no source change).)
Prior: 2026-06-22 (`phase-product-cost-landed-cost-hub-audit-and-ui-v1` (re-verify) `20260620T130000Z` **PASS — read-only cost architecture + UI/import plan re-run @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO DB write / NO new tables / NO `claim_*` mutation / NO Amazon / NO scanner / NO AI (audit SELECT/HEAD only; proposed migration documented, NOT executed). Re-ran the `20260620T070000Z` audit; architecture/contract unchanged, fresh green re-verification (no code changed). Cost storage still ABSENT (product_cost_snapshots gated draft + all product_cost_*/supplier/purchase tables PGRST205); reusable = products.vendor_id/vendor_name + vendors (117) + product_identifier_map (16,849); ungoverned cost in products.metadata.product_attributes.{case_cost 197/selling_unit_cost 196/*_without_freight 88}; product_prices (29,571) = SALE cache NOT cost; cogs_unit 0/9155; cogs_overrides 0. Contract `lib/products/contracts/product-cost-landed-cost-hub-v1.ts` — 7 components → landed_cost_unit=SUM(approved) (null=UNKNOWN) + effective_from/to + source_type + confidence + approved_by. reuse=partial; additive_migration_needed=yes; new_table_needed=yes_gated; approval_required=yes (`APPROVED_PRODUCT_LANDED_COST_HUB_SCHEMA_V1=yes`) — extend unapplied product_cost_snapshots draft; interim `cost_overrides`. Hub `/claim-center/financial/product-costs`; Ready-to-File 3-row card; Product Story cost timeline; Needs Data missing-cost = internal-P&L blocker only. 13-col CSV (required purchase_cost_unit+effective_from). no_claim_mutation [9155/22/22/13]; tsc 0 / ReadLints 0 / smoke 21/21 / audit PASS / next build exit 0 (115 pages). **SAFE_PRODUCT_COST_HUB_ARCHITECTURE_READY=yes**, **SAFE_TO_IMPLEMENT_PRODUCT_COST_HUB=conditional_yes**. NEXT: `PHASE-PRODUCT-LANDED-COST-HUB-SCHEMA-AND-UI-BUILD-V1`. Files (unchanged, re-verified): `lib/products/contracts/product-cost-landed-cost-hub-v1.ts`, `scripts/phase-product-cost-landed-cost-hub-audit-and-ui-v1.ts`, `scripts/smoke-product-cost-landed-cost-hub-v1.ts`.)
Prior: 2026-06-22 (`phase-data-sources-hub-and-claim-center-nav-unification-v1` `20260620T120000Z` **PASS — architecture + UI unification + source-of-truth cleanup @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO DB write / NO `claim_*` mutation / NO Amazon submission / NO browser / NO new tables / NO scanner / NO AI (read-only composer + UI wiring). **Single composer** NEW `composeDataSourcesHubStatusV1` (`lib/data-sources/data-sources-hub-v1.ts`) + zero-import contract `data-sources-hub-contract.ts` (`DataSourceHubRow` 19 fields + `deriveDataSourceBadge` 8 states Live/Local only/Disabled/Needs env/Needs initial sync/Missing permission/Stale/Healthy + `filterDataSourcesForView` control_plane/claim/product + `missingSourceReasonsForFamily`); 11 sources (8 Reports workers + Finances + product_identity + scanner_returns); probes domain tables + worker flags + `raw_report_uploads` + SP-API credential presence; permission/next_run not fabricated. **Routes** NEW `GET /api/platform/data-sources/status` + NEW page `/platform/settings/data-sources` (control plane: org+store scope, 8 badge totals, env blockers, collapsed Developer Details); orphaned `sync-foundation` **rewired to delegate** to the composer. **Claim Center reads hub:** `data_sources_hub` (claim-filtered) embedded into source-coverage / ready-to-file / reimbursement-tracking / sources payloads; `ClaimCenterSourcesView` + `ClaimDataCoverageView` render hub badges (shared `dataSourceBadgeMeta`); Product Story `?view=product` available. Audit found 4 conflicting source-status definitions + 4 newer sources invisible in settings UI. Nav = single 10-section layer (smoke 175). Flags claim_sources_view_rewired/settings_api_view_rewired/ready_to_file_source_status_rewired/reimbursement_source_status_rewired/product_story_source_ready/claim_center_navigation_cleaned/top_scope_selectors_enforced/stale_or_duplicate_ui_removed = **yes**; menoriax_admin_all_companies_scope_supported = **partial** (per-company select among all visible + all-stores; no cross-company aggregated rollup, single-org). no_claim_mutation [9155/22/22/13/147]/no_amazon_submission/no_scanner_change **verified**; tsc 0 / ReadLints 0, smoke `smoke-data-sources-hub-v1.ts` **32/32** + `smoke-claim-center-primary-nav-and-needs-data-v1.ts` **175** PASS, next build exit 0 (new routes registered). **SAFE_DATA_SOURCES_HUB_UNIFIED=yes, SAFE_CLAIM_CENTER_NAV_ARCHITECTURE_READY=yes, SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC=no** (worker flags disabled). NEXT: `PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1`. Files: `data-sources-hub-contract.ts`, `data-sources-hub-v1.ts`, `app/api/platform/data-sources/status/route.ts`, `app/platform/settings/data-sources/{page.tsx,DataSourcesHubControlPlaneClient.tsx}`, `sync-foundation/route.ts`, `claim-center-api-handlers.ts`, `source-coverage/route.ts`, `ClaimCenterSourcesView.tsx`, `ClaimDataCoverageView.tsx`, `smoke-data-sources-hub-v1.ts`.)
Prior: 2026-06-20 (`phase-claim-center-opportunities-needs-ready-ui-v1` `20260620T110000Z` **PASS — Claim Center UI organization only @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO DB write / NO `claim_*` mutation / NO claim submission / NO Amazon case submission API / NO browser / NO scanner change / NO claim-math change / NO AI. **Rebuilt primary nav 9→10 sections** (`lib/claims/center/claim-center-primary-nav.ts`): Dashboard · Opportunities · Needs Data · Ready to File · **Cases** · **Submissions** · **Reimbursement Tracking** · Product Story · **Sources** · **Rules** — split old "Filed/Tracking" into Cases+Submissions+Reimbursement Tracking; renamed Data-Sources→Sources (`/data-coverage`), Policies→Rules (`/policies`); folded `/recovery` into Reimbursement Tracking alias. Exhaustive count-key map (submissions→filed, reimbursement_tracking→recovery, sources→sources; dashboard/cases/rules→null). **Tab/More dedup** (`claim-center-nav-config.ts`): mobile sections nav mirrors 10 sections; More groups recomposed (Case tools / Detail tools / Power-user+Legacy) so no non-"sections" group holds any primary-tab href; desktop More still filters the "sections" mirror — no page is both a desktop tab and in desktop More. Inherited pages/drawers verified to spec: Opportunities (family-grouped, not-fileable), Needs Data (7-blocker + needs_review), Ready to File (gated, SC copy only for fileable, no UUID proof), candidate drawer (7 blocks, opaque), reimbursement drawer (opaque, card tabs, raw under collapsed tab). Scope: all pages under shared `MenorixModuleScopeBar` (org+store enforced everywhere); all-companies/view-as not wired (single-org, reported honestly). All output flags = **yes**. no_db_write/no_claim_mutation [9155/22/22/13/147 unchanged]/no_amazon_submission/no_scanner_change **verified**; tsc 0 / ReadLints 0, smoke `smoke-claim-center-primary-nav-and-needs-data-v1.ts` **175 checks PASS** + ready-to-file smoke PASS, next build exit 0 (all 10 claim-center routes). **SAFE_CLAIM_CENTER_UI_ORGANIZED=yes.** NEXT: `PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1`. Files: `claim-center-primary-nav.ts`, `claim-center-nav-config.ts`, `ClaimCenterWorkflowBar.tsx`, `claim-center-mobile-nav-meta.ts`, `smoke-claim-center-primary-nav-and-needs-data-v1.ts`, `phase-claim-center-ui-live-verify-and-count-wire-v1.ts`.)
Prior: 2026-06-20 (`phase-family-claim-generators-dry-run-v1` `20260620T100000Z` **PASS — read-only family-aware dry-run across all 17 supported families, re-run with expanded per-family schema @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO DB write / NO claim_candidate creation / NO `claim_candidates`/`claim_cases`/`claim_lines`/`claim_submissions` mutation / NO Amazon submission / NO browser / NO scanner / NO AI (compose/SELECT only). Re-run of `20260620T040000Z` emitting the full output schema; extended the existing generator (no new tables) with per-family `missing_source_blocker` + top-level `missing_source_blockers` block + real phase-gate run. Reuses only existing read-models (queue+hardened 9-gate / `composeSeparateFamilyCandidateGeneratorsV1` / `composeClaimSourceCoverageV1`). **families_evaluated 17**; total_dry_run **82**, valid **20**, ready_for_review **20**, **ready_to_file 0** (gate requires live removal-delivery + reimbursement proof). Removal pilot 6+4=10 (all valid, 0 fileable; blockers physical_receiving_not_started ×10 / live_reimbursement_check_missing ×10 / missing_sale_price_source ×7); reimbursement_reversal 11 (10 valid, reimbursement_reinstatement); lost_warehouse 39 / damaged_warehouse 6 / fulfillment_fee_overcharge 13 / customer_return_not_received 2 / lost_outbound 1 (all blocked); damaged_outbound/disposed/refund_without_return/storage_fee/inbound 0; 4 unsupported (missing/partial_reimbursement, wrong_item_returned, empty_box_return) 0 (`family_generator_not_built`). product/TRID linkage 100% where candidates exist; reimbursement match all weak/unknown (needs live sync). missing_source_blockers: removal_*=GET_FBA_REIMBURSEMENTS_DATA + SP-API removal-delivery + settlement Order rows for 3 SKUs; warehouse=inventory_ledger_detail; outbound/fee=amazon_settlement_transactions; reversal=order-linked reimbursements; inbound=removal_shipment_detail; 4 unsupported=generator-not-built; missing_files_or_tables [], missing_api_endpoints 6. Families never mixed; weak reimbursement never reduces another family's gap; no internal UUID as SC proof; COGS only where policy=cogs_recovery; latest_sale_net UNKNOWN never fabricated. no_db_write/no_claim_mutation [9155/22/22/13/147 unchanged]/no_amazon/no_scanner **yes**; tsc 0 / ReadLints 0, smoke `smoke-phase-claim-ready-to-file-queue-ui-v1.ts` PASS, next build exit 0 (105 routes). **SAFE_FAMILY_CLAIM_GENERATORS_DRY_RUN_COMPLETE=yes**, **SAFE_TO_BUILD_CLAIM_OPPORTUNITIES_UI=yes**. NEXT: `PHASE-CLAIM-OPPORTUNITIES-UI-V1`. Files: `scripts/phase-family-claim-generators-dry-run-v1.ts` (extended).)
Prior: 2026-06-20 (`phase-product-trid-story-live-refresh-v1` `20260620T090000Z` **PASS — read-model refresh + verification only @ LIVE `kxsvedvpjldygtdbylsy`; NO write** — NO DB write / NO new tables / NO `claim_submissions` mutation / NO claim_candidate creation / NO Amazon / NO browser / NO scanner / NO AI (compose/SELECT only). New orchestrator `scripts/phase-product-trid-story-live-refresh-v1.ts` re-ran Task-1 audit (`product_linkage_status=healthy`, pilot 6/6) + Task-2 TRID edge smoke (21/21), then refreshed coverage via existing composers + `buildTridEdgeReadModel`/`loadMaterializedCandidateEdges` + `splitProofMatrices()`. **Coverage by area** (resolved=identity+≥1 SC ref): pilot_removal 10/10, needs_data 10/10, opportunities 72/72, reimbursement_tracking 10/10. **Identity (pilot):** SKU 10/10·FNSKU 10/10·ASIN 0/10·canonical product_id 10/10 (UPC at link time). **Source freshness (16 live_loaded):** fresh = EP/return_items/claim_*; stale = removals/removal_shipments 06-17, reimbursements 06-05, inventory_ledger 04-24, transactions 04-14, customer_returns 04-15, reports_repo 05-03, identifier_map 06-01; settlements unknown-date — same staleness the blocked live source sync would refresh. **Reference graph (96 pilot edges):** removal_order(14)/removal_shipment(6)/tracking(10) PRESENT; expected_package/settlement/reimbursement/inventory_ledger/customer_returns/fee_preview/inbound absent (not order-linked pre-live-sync). orphans settlements 57729/transactions 600/reports_repo 3438; ambiguous amazon_returns 38; stale_links amazon_returns 483. **Proof discipline:** seller_central_block_uuid_count **0** (authoritative — SC block UUID-free), true_proof_uuid_leak **0**, surrogate_removal_id_proof_edges **10** (amazon_removals.id surrogate resolved by ledger→real Removal Order IDs; reported honestly, NOT whitewashed), internal_kind_as_proof 0, weak/cross-family-as-proof 0. no_claim_submission_mutation verified [9155/22/22/13/147 unchanged]; tsc 0 / smoke pass / next build pass; 14/14 checks. **SAFE_PRODUCT_TRID_STORY_LIVE_REFRESHED=yes**, **SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN=yes**. NEXT: `PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1`. Report `.cursor/audit-reports/phase-product-trid-story-live-refresh-v1/20260620T035205Z/`.)
Prior: 2026-06-20 (`phase-amazon-initial-live-source-sync-execute-v1` `20260620T080000Z` **(re-run) BLOCKED-AT-GATE — guarded initial live source sync; NO live SP-API/Reports/Finances calls, NO writes** — target `kxsvedvpjldygtdbylsy`; run id `20260620T033233Z`. Identical outcome to `20260620T020500Z`. **Both gates still fail:** approval token `APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=no` + worker master flag DISABLED + **12 env keys missing** (REPORTS_API ×9 + FINANCES ×2 + CRON_SECRET; `AMAZON_SP_API_ENABLED` present = catalog/pricing lane only). credential_presence=present (2 marketplace rows). All 9 sources `blocked_at_gate`; rows_imported 0; data_sources_hub_updated **no**; settlement Order rows for the 3 missing SKUs still 0/0/0; freshness unchanged (stale). claim counts unchanged [9155/22/22/13]; no code change. **SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE=no**, **SAFE_TO_RUN_PRODUCT_TRID_STORY_REFRESH=yes**, **SAFE_TO_RUN_CLAIM_GENERATORS_DRY_RUN=yes**. NEXT: OPERATOR-ACTION (below). Report `.cursor/audit-reports/phase-amazon-initial-live-source-sync-execute-v1/20260620T033233Z/`.)
Prior: 2026-06-20 (`phase-product-cost-landed-cost-hub-audit-and-ui-v1` `20260620T070000Z` **PASS — read-only cost architecture audit + Product Cost Hub plan; NO write** — live `kxsvedvpjldygtdbylsy`; NO DB write / NO new tables / NO `claim_*` mutation / NO Amazon / NO scanner / NO AI (audit SELECT/HEAD only; proposed migration documented, NOT executed). **Part A:** existing cost = `products.vendor_id/vendor_name` + `vendors` (117) + ungoverned `products.metadata.product_attributes.{case_cost/selling_unit_cost/*_without_freight}` (PIM, no effective date/source_type); `product_prices` (29,571, 100% product_master_import = SALE cache, NOT cost); `claim_candidates.cogs_unit` 0/9155; cogs_overrides 0. ABSENT: `product_cost_snapshots` (gated draft, not applied) + all `product_cost_*`/supplier/purchase tables → no landed-cost storage / no effective-date history / no component breakdown. manual_entry=yes_interim (single unit_cost→cogs_overrides via `/claim-center/reimbursement-tracking/cogs`); csv_import=yes_dry_run_only. **Part B:** new pure contract `lib/products/contracts/product-cost-landed-cost-hub-v1.ts` — 7 components → `landed_cost_unit=SUM(approved)` (null=UNKNOWN, never 0) + effective_from/to + source_type + confidence + approved_by; helpers computeLandedCostUnit/validateLandedCostRecord/selectCostForEventDate (21/21 smoke). **Part C:** reuse=partial; additive_migration_needed=yes; new_table_needed=yes_gated; approval_required=yes (`APPROVED_PRODUCT_LANDED_COST_HUB_SCHEMA_V1=yes`) — EXTEND the unapplied product_cost_snapshots draft into the landed-cost spine; reuse vendors for supplier_id. **Part D:** Hub `/claim-center/financial/product-costs`; Ready-to-File 3-row card (Amazon Claim Amount vs Internal/Landed Cost vs Profit/Loss); Product Story cost timeline; Needs Data missing-cost = internal-P&L blocker only. **Part E:** 13-col CSV (required purchase_cost_unit+effective_from). no_claim_mutation [9155/22/22/13]; tsc 0/ReadLints 0/smoke 21/21/audit PASS/next build exit 0. **SAFE_PRODUCT_COST_HUB_ARCHITECTURE_READY=yes**, **SAFE_TO_IMPLEMENT_PRODUCT_COST_HUB=conditional_yes**. NEXT: `PHASE-PRODUCT-LANDED-COST-HUB-SCHEMA-AND-UI-BUILD-V1`. Files: `lib/products/contracts/product-cost-landed-cost-hub-v1.ts` (new), `scripts/phase-product-cost-landed-cost-hub-audit-and-ui-v1.ts` (new), `scripts/smoke-product-cost-landed-cost-hub-v1.ts` (new).)
Prior: 2026-06-20 (`phase-claim-center-ui-live-verify-and-count-wire-v1` `20260620T060000Z` **PASS — read-only live-verify + per-section badge count wiring; NO write** — no DB/claim/Amazon/browser/scanner/AI change. `ClaimCenterFlowCounts` gained `ready_to_file`+`filed`; `flowCountsFromDashboard` surfaces them; new pure `primarySectionCountKey`/`primarySectionBadgeCount` (single source of truth) wired into `ClaimCenterWorkflowBar` so all 7 badge sections (incl. Ready to File + Filed/Tracking) show live counts. NEW pure smoke `scripts/smoke-claim-center-primary-nav-and-needs-data-v1.ts` **148 checks PASS** (9-section nav + resolver + count-key totality + Needs Data 8-group taxonomy + 17-family→8-group bucketing). NEW read-only live verify `scripts/phase-claim-center-ui-live-verify-and-count-wire-v1.ts` **23 checks PASS**: live badges Opportunities 50 / Needs Data 10 / Ready 0 / Filed 13 / Sources 16; Needs Data 10/10→physical_receiving (0 lost/0 unmapped); family buckets 82 (0 unmapped); claim counts unchanged [9155/22/22/13/147]; tsc 0/ReadLints 0/next build exit 0. **OPERATOR:** enable Claim Recovery module for org …0001 to render the new nav/pages live (logic+data already verified). **SAFE_CLAIM_CENTER_UI_LIVE_VERIFIED=yes**, **SAFE_CLAIM_CENTER_SECTION_COUNTS_WIRED=yes**. NEXT: `PHASE-CLAIM-OPPORTUNITIES-UI-V1`. Files: `scripts/smoke-claim-center-primary-nav-and-needs-data-v1.ts` (new), `scripts/phase-claim-center-ui-live-verify-and-count-wire-v1.ts` (new), `claim-center-flow-nav.ts`, `claim-center-primary-nav.ts`, `ClaimCenterWorkflowBar.tsx`, `ClaimCenterFlowCountsProvider.tsx`.)
Prior: 2026-06-20 (`phase-claim_center_unified_opportunities_ui_v1` `20260620T050000Z` **PASS — read-only Claim Center UI/UX organization; NO write** — no DB/claim/Amazon/browser/scanner/claim-math/AI change. Unified **9-section primary nav** (`claim-center-primary-nav.ts` + `ClaimCenterWorkflowBar` rewrite; flow-steps + smoke markers preserved; mobile More sheet gains a "Claim Center" sections group). **Needs Data page** (NEW route `/claim-center/needs-data`, `NeedsDataView`) groups ready-to-file blocked_rows by the 7-group taxonomy `claim-needs-data-contract.ts` with unblock hints + color tiles. **Opportunities** regrouped into 8 family groups (`claim-family-group-contract.ts`), cards open new clean `SeparateFamilyCandidateDrawer` (7-block Summary/Why/Financial/Evidence/Blockers/Product-Story/Next-action), raw counts under collapsed Developer details. **Reimbursement transparent-drawer bug FIXED** (theme-independent base bg in `claim-center-theme.css` + Tailwind bg on generic drawer classes; root cause = `html.light` ancestor dependency). Color system: nav active tones blue=opportunity/yellow=needs-data/green=ready/red=blocker/gray=debug. tsc 0/ReadLints 0/smoke PASS (shell smoke static OK; live dashboard 403 = module not enabled in env, pre-existing)/next build exit 0 (`/claim-center/needs-data` registered). **SAFE_CLAIM_CENTER_UI_ORGANIZED=yes**. NEXT: `PHASE-CLAIM-CENTER-UI-LIVE-VERIFY-AND-COUNT-WIRE-V1` (live-verify with module enabled; wire real per-section badge counts; add focused smoke for primary-nav + needs-data taxonomy). Files: `claim-center-primary-nav.ts` (new), `claim-needs-data-contract.ts` (new), `claim-family-group-contract.ts` (new), `app/claim-center/needs-data/page.tsx` (new), `NeedsDataView.tsx` (new), `SeparateFamilyCandidateDrawer.tsx` (new), `ClaimCenterWorkflowBar.tsx`, `SeparateFamilyOpportunitiesPanel.tsx`, `ClaimCenterDetailDrawer.tsx`, `ClaimCenterMoreMenu.tsx`, `claim-center-nav-config.ts`, `claim-center-ui.ts`, `claim-center-v2-page-contract.ts`, `claim-center-mobile-nav-meta.ts`, `claim-center-theme.css`.)
Prior: 2026-06-20 (`phase-family-claim-generators-dry-run-v1` `20260620T040000Z` **PASS — read-only dry-run family-aware claim generator across all 17 families; NO write**. New `scripts/phase-family-claim-generators-dry-run-v1.ts` reuses existing read-models only (queue+hardened gate / `composeSeparateFamilyCandidateGeneratorsV1` / `composeClaimSourceCoverageV1`); no new tables/contracts. families_evaluated **17**; total_dry_run **82**, valid **20**, ready_for_review **20**, **ready_to_file 0**. Removal pilot 6+4=10 (all valid, 0 fileable — gate holds physical_receiving + live_reimbursement on 10/10, sale_price on 7); generator lane reimbursement_reversal 11 (10 valid, $83.05), lost_warehouse 39 / damaged_warehouse 6 / fulfillment_fee_overcharge 13 / customer_return_not_received 2 / lost_outbound 1 (all blocked: needs_policy_confirmation / source_group_mismatch / fee_expected_value_unavailable); damaged_outbound/disposed/refund_without_return/storage_fee/inbound = 0; unsupported (missing_reimbursement, partial_reimbursement, wrong_item_returned, empty_box_return) = 0 (`family_generator_not_built`). Families never mixed; cross-family weak reimbursement never reduces removal gap; no internal UUIDs as SC proof; latest_sale_net UNKNOWN with no fallback. no_db_write/no_claim_mutation [9155/22/22/13/147]/no_amazon/no_scanner **yes**; tsc 0/smoke PASS/next build exit 0; **SAFE_FAMILY_CLAIM_GENERATORS_DRY_RUN_COMPLETE=yes**, **SAFE_TO_BUILD_CLAIM_OPPORTUNITIES_UI=yes**. NEXT: PHASE-CLAIM-OPPORTUNITIES-UI-V1 (surface per-family matrix on /claim-center/opportunities, gate promote-to-candidate behind `APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1`; build the 4 missing generators after reimbursements/returns live sync). Files: `scripts/phase-family-claim-generators-dry-run-v1.ts` (new).)
Prior: 2026-06-20 (`phase-product-story-trid-edge-ui-wire-v1` UI wire PASS; prerequisite TRID edge read model confirmed; `TridReferenceGraphPanel` gains 3-tab view Overview/Reference Timeline/Reference Story; `ProductStoryTridTimeline` component shows SKU/FNSKU/ASIN/UPC identity + all 20 event kinds with SC-proof/Internal filter; `CandidateReferenceStorySection` gives narrative why-exists/supporting-refs/missing-refs/gating verdict/exact-blocker/other-opportunities link; build + smoke PASS; **SAFE_PRODUCT_STORY_TRID_UI_READY=yes**, **SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN=yes**. NEXT: PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1 or run `SAFE_TO_RUN_CLAIM_GENERATORS_DRY_RUN`.)
Prior: 2026-06-20 (`phase-amazon-initial-live-source-sync-execute-v1` `20260620T020500Z` **BLOCKED-AT-GATE — guarded initial live source sync; NO live SP-API/Reports/Finances calls, NO writes** (SELECT-only freshness/immutability probe; no claim candidate generation, no `claim_*` mutation, no scanner/Amazon/browser/AI). Both hard gates fail so the executor refused to run + did not fake success: (1) approval file `.cursor/operator-approvals/amazon-initial-live-source-sync-v1-approval.md` ABSENT → created BLOCKED template (`APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=no`); (2) `ENABLE_AMAZON_REPORTS_API_WORKER` disabled + **12 env keys missing** (REPORTS_API ×9 + FINANCES ×2 + CRON_SECRET; `AMAZON_SP_API_ENABLED` present = catalog/pricing lane only). credential_presence=present (2 rows). All 9 sources blocked_at_gate; rows_imported 0; settlement Order rows for the 3 missing SKUs still 0/0/0; freshness unchanged (stale). claim counts unchanged [9155/22/22/13]. build/smoke/next-build exit 0; **SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE=no**, **SAFE_TO_RUN_PRODUCT_TRID_STORY_LINKAGE=yes**, **SAFE_TO_RUN_CLAIM_GENERATORS_DRY_RUN=yes**. NEXT: OPERATOR-ACTION — set approval token=yes + enable the 12 env/worker flags in LIVE env, then re-run `scripts/phase-amazon-initial-live-source-sync-execute-v1.ts --execute`. Files: `.cursor/operator-approvals/amazon-initial-live-source-sync-v1-approval.md` (new), `scripts/phase-amazon-initial-live-source-sync-execute-v1.ts` (new).)  
Prior: 2026-06-20 (`phase-claim-trid-edge-readmodel-implement-v1` `20260620T020000Z` **PASS — staging read-model implementation; NO write** — no new tables/columns, no `claim_*` mutation, no Amazon, no scanner, no Product Core resolver rewrite, no AI. NEW `lib/claims/readmodel/trid-edge-readmodel-v1.ts` (pure, client-safe): `resolveEdgeKindId` + `buildTridEdgeReadModel` (per-candidate enriched edges + claim_ready/money/product_story coverage + gating {ready\|blocked\|review_signal_only\|unknown_family, blocking_edge_kinds, product_link_deferred_unresolved, has_disputed_edges, notes}) + `tridEdgeKindCatalog()`. Family-aware gating added to discovery engine: `findFamilyEdgeRequirement` + `gateDiscoveredEdge` (disputed→review_signal; product_link+unresolved→defer; signal/lifecycle families→review_signal; product_id SQL already skips when resolved_product_id NULL) — read model reuses it. Wired `getCenterReferencesPayload` candidate branch (returns `read_model`) + `TridReferenceGraphPanel` (claim-ready banner, coverage lists, deferred/disputed notes), embedded by the Product Story Reference block. Reuses TRID_EDGE_KIND_CATALOG + FAMILY_EDGE_REQUIREMENTS + claim_reference_edges; no DB write, no claim/candidate/edge mutation. smoke 21/21 PASS, next build exit 0, ReadLints 0; **SAFE_TRID_EDGE_READMODEL_READY=yes**. NEXT: PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1. Files: `lib/claims/readmodel/trid-edge-readmodel-v1.ts` (new), `lib/claims/edges/claim-reference-discovery-engine.ts`, `lib/claims/center/claim-center-api-handlers.ts`, `components/claim-center/TridReferenceGraphPanel.tsx`, `scripts/smoke-claim-trid-edge-readmodel-implement-v1.ts` (new).)  
Prior: 2026-06-20 (`phase-product-trid-story-linkage-audit-and-layer-v1` `20260620T010427Z` **PASS — read-only product identity + TRID/reference graph audit + product-story build plan; NO write** — no DB/claim/Amazon/scanner/new-table/AI change. Product identity matrix across **11** source tables; `product_linkage_status=healthy`; pilot story coverage **6/6** resolved; `return_items` resolver-wired (11 mapped, 0 ambiguous, 0 stale), `amazon_returns` 2082 mapped / 38 ambiguous / 483 stale FK; financial-only orphans settlements 57729 / transactions 600 / reports_repository 3438 (no SKU = expected); **customer_returns absent → canonical amazon_returns**. TRID reference model **16 refs** split seller-central-proof vs internal-only (internal UUIDs product_id/package_id/expected_package_id never proof). Incoming SP-API mapping rule = 10-step deterministic (raw+normalized store, resolver UPC→SKU→FNSKU→ASIN, ambiguous/orphan flag, never invent TRID, never internal-UUID-as-proof, no AI). `recommended_reuse_existing_tables=yes`, `new_tables_needed=no`, `approval_required=no` (TRID foundation `20260832120000_trid_foundation.sql` stays gated DRAFT). build(tsc) exit 0 / smoke PASS; **SAFE_PRODUCT_TRID_STORY_LAYER_READY=yes**, **SAFE_TO_BUILD_FAMILY_CLAIM_GENERATORS=yes**. NEXT: PHASE-CLAIM-TRID-EDGE-READMODEL-IMPLEMENT-V1 (expose TRID_EDGE_KIND_CATALOG + per-candidate materialized edges as a read model; wire Product Story TRID section + References tab; family-aware edge gating; no new tables). Files: `lib/products/contracts/product-trid-story-linkage-audit-v1.ts` (new), `scripts/phase-product-trid-story-linkage-audit-and-layer-v1.ts` (new), `scripts/smoke-product-trid-story-linkage-audit-and-layer-v1.ts` (new).)  
Prior: 2026-06-20 (`phase-amazon-live-reports-finances-sync-workers-v1` `20260620T004544Z` **PASS — live SP-API Reports/Finances sync foundation built; NO live SP-API calls, NO claim mutation, NO scanner change**. 4 new workers + 8 routes + extended flags + platform automation types + new sync-foundation endpoint. `all_workers_built=yes`, flags all disabled (env keys needed); `live_sp_api_exists` all false; build exit 0; **SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY=yes**, **SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC=no** (set 13 env keys first), **SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES=yes**. NEXT: PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1.)  
Prior: 2026-06-19 (`phase-claim-ready-to-file-gate-hardening-v1` `20260619T235900Z` **PASS — strict 9-gate UI gate correction + Needs Data tab; NO write** — no DB/claim/Amazon/browser/scanner/AI change. Pure `computeHardenedReadyToFileGate` (9 gates) added to zero-import contract; server composer overrides `ready_to_file=false` + `filing_status` + named blockers after `removal_origin_inputs` loaded; ReadyToFileView gains `activeTab (ready | needs_data)`, tab bar, Needs Data banner, "Gate blockers" column. Live: all 10 pilot removal claims → `NEEDS_DATA[physical_receiving_not_started]`; ready_after=0, demoted=10; blockers {physical_receiving_not_started: 10, missing_sale_price_source: 7, live_reimbursement_check_missing: 10}; no claim/candidate mutation [cands 9155, cases 22, lines 22, subs 13, edges 147]; tsc 0 / ReadLints 0 / smoke PASS / next build exit 0; SAFE_READY_TO_FILE_GATE_HARDENED=yes, SAFE_TO_FILE_COUNT=0. NEXT: PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1 — enable SP-API removal-delivery sync workers + GET_FBA_REIMBURSEMENTS_DATA live sync to satisfy gate 4 and gate 7; until then 0/10 fileable.)  
Prior: 2026-06-19 (`phase-amazon-spapi-live-source-integration-and-claim-gate-audit-v1` `20260619T234601Z` **PASS — read-only Amazon SP-API live-source integration audit + claim-gate correction + connector build gate; NO write** — no DB/claim/Amazon-submit/browser/scanner/AI change. **Part 1** `amazon_connection_status=configured_but_disabled` (claim Reports/Finances SYNC lane): `marketplaces` 4 amazon_sp_api rows, **1 complete** creds; catalog/pricing lane enabled (`AMAZON_SP_API_ENABLED=true`) but SYNC workers all off + `CRON_SECRET` absent + 0 cron runtime; code foundation EXISTS (4 API workers + Finances v0; returns/ledger/fee-preview/inbound file-import only). **Part 2/3** 17 sources, live_loaded 16, **all** `live_sp_api_exists=false`. **Part 4 (CORE)** 10 pilot rows currently ALL READY but corrected gate **demotes ALL 10 -> waiting_physical_receiving** (no receiving/scan ever performed + no live removal-delivery proof): fileable **0**, demoted **10**, missing_sale_price **7**, needing_live_reimbursement_check **10**, cross_family_pollution **no**. **Part 5** `ui_ready_to_file_gate_correction_needed=yes`. build Compiled OK / smoke audit exit 0; **SAFE_SPAPI_LIVE_SOURCE_FOUNDATION_READY=yes**, **SAFE_TO_BUILD_LIVE_REPORT_SYNC_WORKERS=yes**, **SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES=yes**. **Corrects prior "10 valid/safe_to_file" — under the live-source+receiving rule they are NOT fileable yet.** NEXT: PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1.)  
Prior: 2026-06-19 (`phase-claim-removal-intake-settings-and-ui-finalize-v1` `20260619T230000Z` **PASS — read-only intake settings audit + Ready-to-File UI clarity/finalization; NO write** — no DB/claim/Amazon/browser/scanner/claim-math/AI change. **Part A** new `payload.settings_audit`: `delayed_not_received_days=14` @ `workspace_settings.module_configs.claim_intake.delayed_not_received_days`; `scan_availability_start_found=yes`, `value=2026-01-15` @ `organization_settings.claim_policy.scan_go_live_date`; `claim_start_date=2026-01-15`; eligibility 90d; expiry-warning 14d; EP-match-window 90d; `has_org_override=no`; `missing_settings=none` (missing reported with recommended key, never invented). Contract (zero-import) gained `ReadyToFileSettingsAudit` + `settings_audit`, pure `computeAmountStatus` (priced vs needs_sale_price_source; no COGS/settlement fallback), `scan_status_compact`. Table: settings strip + cols Why created / Scan status / Amount status / Price source status (colSpan 36→39). Drawer: plain-language "Why this claim exists" + scan-reliable-from + **C · Data Status** box; section 3 "Other possible claim opportunities for this product" badge "not part of this removal claim" (collapsed); SC copy excludes unrelated. Live verify: 10 valid, **priced 3 / unknown 7**, safe_to_file_now 3, needing-sale-price 7, ages 33–84 all>14, received 0/10; all UI flags yes; tsc 0/ReadLints 0/smoke PASS/next build OK; SAFE_REMOVAL_INTAKE_UI_AND_SETTINGS_CLEAR=yes, SAFE_TO_IMPORT_MISSING_SALE_PRICE_SOURCES=yes. NEXT: PHASE-CLAIM-SETTLEMENT-ORDER-IMPORT-EXECUTE-V1 (after approval + provided report); meanwhile operator may file the 3 priced removal claims ($57.10), the 7 UNKNOWN held with "needs sale price source import".)  
Prior: 2026-06-19 (`phase-claim-missing-sale-price-source-import-v1` `20260619T220000Z` **PASS — read-only source-import determination; NO write (import + cache BLOCKED on approval)** — no DB/claim/Amazon/scanner/AI change. The 7/10 UNKNOWN removal claims span **3 SKUs** (`I6-VR35-FSXQ`×5, `WD-VY8Z-CZ3F`, `2H-7ZAX-Z2IP`). Source discovery: `amazon_reports_repository` (412,645) + `amazon_settlements` (604,883) hold **zero `product_sales>0` rows of ANY transaction_type** for those SKUs — only `$0 Adjustment`; `amazon_transactions` (600) lacks product_sales; `amazon_all_orders` exists but **empty**; others absent. `Order`+`product_sales>0` rows exist for other SKUs → importer mapped → **data-coverage gap, not wiring**. `import_required=yes`; `required_report_or_api=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` (or Transaction View export; all_orders=price-only fallback); `report_mapped=yes`; `approval_required=yes`; approval file `claim-missing-sale-price-source-import-v1-approval.md` token=no. Coverage unchanged 3/10 price & fee; 3 priced = **$57.10**; drift_fixed=yes; no source/cache write; no claim mutation; tsc 0/smoke PASS/next build OK; SAFE_MISSING_SALE_PRICE_SOURCE_IMPORTED=no, SAFE_LATEST_SALE_NET_COVERAGE_COMPLETE=no (3/10), SAFE_TO_FILE_PRICED_REMOVAL_CLAIMS=yes. NEXT: PHASE-CLAIM-SETTLEMENT-ORDER-IMPORT-EXECUTE-V1 (after operator approval + provided settlement/Transaction-View report covering the 3 SKUs), then file the 3 priced claims + record real Amazon Case IDs.)  
Prior: 2026-06-19 (`phase-claim-removal-origin-reason-ui-surface-v1` `20260619T210000Z` **PASS — read-only UI clarity for removal-claim origin/missing basis** — no DB/claim/Amazon/scanner/claim-math/AI change. Surfaced the audit findings in the Ready-to-File UI, separate from the latest_sale_net financial lane. Zero-import contract gained `RemovalOriginInputs` + `removal_origin_inputs` on `ReadyToFileRow` + pure `computeRemovalOriginReason(row)` (received-in-full→not_missing; partial→valid_discrepancy; no-receipt+age≤thr→waiting_threshold; no-receipt+age>thr→valid_missing; disputed/no-date→needs_manual_review; missing never inferred from shipment existence alone). New SELECT-only loader `claim-removal-origin-basis-v1.ts` (batch reads EP/amazon_removals/amazon_removal_shipments/packages/return_items); composer attaches it + loads `delayed_not_received_days=14`. Table +8 origin columns (colSpan 28→36); drawer top **"Why this claim exists"** section + badges + header Waiting-threshold badge. Live verify (exercises real UI path): all 10 → valid_missing, ages 33–84 (all>14), received 0/10, threshold 14; counts valid 10/waiting 0/wrong_family 0/manual_review 0; ui_origin_reason_verified=yes, table_origin_columns_verified=yes, drawer_why_claim_exists_verified=yes; tsc 0/smoke PASS/next build OK; SAFE_REMOVAL_ORIGIN_REASON_UI_READY=yes, SAFE_TO_IMPORT_MISSING_SALE_PRICE_SOURCES=yes. NEXT: PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1 (import sale sources for the 7 SKUs to lift coverage above 3/10), then file the 10 valid removal claims + record real Amazon Case IDs.)  
Prior: 2026-06-19 (`phase-claim-removal-missing-basis-audit-v1` `20260619T200000Z` **PASS — read-only claim-origin + missing-threshold audit** — new SELECT-only `scripts/phase-claim-removal-missing-basis-audit-v1.ts`; no DB/claim/Amazon/scanner/AI change. Missing threshold FOUND + governed: `delayed_not_received_days=14` at `workspace_settings.module_configs.claim_intake.delayed_not_received_days` (not hardcoded). All 10 pilot removal claims: origin = removal-shipment-detail + removal-order-detail + EP (`build_status=matched`, 0 disputed) + scanner-receipt-absence (received 0/10) + age>threshold (33–84d, all >14d); NOT quantity-mismatch. Classification: **valid 10**, waiting 0, wrong_family 0, manual_review 0 — all legitimate missing candidates. `ui_origin_reason_verified=no` (drawer/table don't yet show missing-basis+threshold+origin). tsc 0/smoke PASS/next build OK; SAFE_REMOVAL_MISSING_BASIS_AUDITED=yes, SAFE_TO_FILE_VALID_REMOVAL_CLAIMS=yes. NEXT: PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1 (surface origin/threshold in Ready-to-File UI), then file the 10 valid claims + record real Amazon Case IDs.)  
Prior: 2026-06-19 (`phase-claim-latest-sale-net-source-coverage-backfill-v1` `20260619T193000Z` **PASS — deterministic latest-sale-net source backfill + drift fix + governed cache write** — Maysam `APPROVED_LATEST_SALE_NET_SOURCE_BACKFILL_V1=yes`; only write = `workspace_settings.module_configs.claims.latest_sale_net_cache`. Fixed run-to-run drift: old `resolveLatestSoldPrice` used `limit 8` with no SQL ORDER BY + accepted `$0` Adjustment rows + picked latest-overall. New deterministic resolver (`latest-sale-net-resolver-v1.ts`): `amazon_reports_repository`→`amazon_settlements`, `transaction_type='Order'` & `product_sales>0`, `<=EOD(event_date)`, latest by `date DESC,id DESC`, fees from same row; no settlement-net/COGS/scanner fallback; UNKNOWN+reason when none. Governed cache pins values; provenance (source/date/fee-source/confidence/unknown_reason) threaded to UI (drawer + table Sale source column, colSpan 27→28). Ground truth: only **3/10** SKUs have real Order sales (B0057→$13.48, FBA-B0FYDT88GQ→$23.86, B075XC6C69-VEN→$19.76); other 7 only `$0` Adjustments → UNKNOWN (no COGS fallback). Live execute (`kxsvedvpjldygtdbylsy`, row `5ad12e20…`): cache_written yes; coverage **3/10**; total_expected **$57.10**, total_open **$57.10**; **drift_fixed yes** (run1==run2); no claim/candidate mutation; tsc 0/smoke PASS/next build OK; SAFE_LATEST_SALE_NET_BACKFILL_COMPLETE=yes, SAFE_TO_AUDIT_REMOVAL_MISSING_BASIS=yes. NEXT: PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1 (import Transaction View / settlement Order rows or SP-API settlement report for the 7 SKUs with no loaded sale, then re-run backfill to lift coverage above 3/10).)  
Prior: 2026-06-18 (`phase-claim-amount-basis-latest-sale-net-policy-fix-v1` `20260618T250000Z` **PASS — governed amount-basis correction (removal families cogs_recovery → latest_sale_net) + financial UI cleanup** — Maysam `APPROVED_CLAIM_AMOUNT_BASIS_LATEST_SALE_NET_POLICY_FIX_V1=yes`; only write = `workspace_settings.module_configs.claims.amount_basis_policy`. Removal families Seller Central **expected reimbursement = (latest_sold_price − amazon_fees) × qty** (settlement net + sale-price-alone + COGS forbidden as the claim amount); `open_claim_amount = expected − confirmed_reimbursed_strong`; unloaded sale price → expected/open **UNKNOWN (null)**, no COGS fallback. Contract adds `expected_reimbursement_latest_sale_net`/`total_cogs`/`business_profit_loss_context`; server packet body/checklist request latest-sale-net. Drawer section 2 → **"Financial Breakdown"** (A · Amazon Claim Amount + B · Internal Cost / Profit-Loss + basis badge); table cols → Expected reimbursement / Confirmed reimbursed / Open claim amount / Internal COGS / Profit/loss context. Live execute (`kxsvedvpjldygtdbylsy`, row `5ad12e20…`): old_total_cogs **$100.72** → new latest-sale-net expected **≈$59–61** (non-deterministic; **7/10 claims lack a loaded sale price → expected UNKNOWN**); confirmed $0, open == expected, internal COGS $100.72, **safe_to_file 10**, basis=latest_sale_net & SC≠COGS; weak 152 / separate 31 unchanged; no claim mutation; tsc 0/smoke PASS/next build OK; SAFE_AMOUNT_BASIS_LATEST_SALE_NET_CONFIRMED=yes, SAFE_READY_TO_FILE_FINANCIAL_UI_CLEAR=yes, SAFE_TO_FILE_APPROVED_REMOVAL_FAMILIES=yes. NEXT: PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1 (ingest latest sold price + Amazon fees for the 7/10 claims missing it).)  
Prior: 2026-06-18 (`phase-claim-family-separation-ui-cleanup-v1` `20260618T240000Z` **PASS — Ready-to-File family separation UI cleanup + read-only verification** — no DB/claim/Amazon/scanner/math change. Drawer rebuilt into 4 sections (1 Current Claim Evidence same-family only, 2 Current Claim Recovery Gap/Amount Policy strong-same-family only, 3 Excluded Cross-Family Candidates collapsed from `misclassified_candidates`, 4 Separate Claim Opportunities grouped per family). Fixed Seller Central leak: `buildReferenceBlockText` now removal-focused (ASIN/FNSKU/SKU + removal order/shipment/tracking + qty), drops cross-family reimbursement/settlement/inventory-ledger lines. Table → family-aware gap cols + new Current family/Filing status/Policy status/Decision/Flags/Current claim open gap/Sep. opps + per-row badges. Live: safe_to_file 10 (policy already confirmed), expected/open **$100.72**, confirmed $0, weak excluded 152, seller_central_copy_excludes_cross_family=yes; tsc 0/smoke PASS/next build OK; SAFE_FAMILY_SEPARATION_UI_CLEAR=yes, SAFE_TO_RUN_AMOUNT_BASIS_POLICY_CONFIRMATION=yes (already confirmed). NEXT: PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-EXECUTE-V1.)  
Prior: 2026-06-18 (`phase-claim-separate-family-candidate-generators-v1` `20260618T233000Z` **PASS — separate-family candidate generators (preview-only)** — write approval ABSENT → 0 writes. Zero-import generator contract `separate-family-candidate-generator-contract-v1.ts` (`buildSeparateFamilyCandidatePreviews`, 13 supported families, strict source/identity/policy rules) + composer + `GET /api/claims/center/separate-family-opportunities` + approval-gated write module + UI panel on `/claim-center/opportunities` & `/claim-center/data-coverage`. Live: 152 suggestions → 72 previews → 0 written; writeable 10 (reimbursement_reversal); removal pilot unchanged ($100.72, 10 safe_to_file, weak 152 excluded); no claim mutation; SAFE_SEPARATE_FAMILY_GENERATORS_READY=yes, SAFE_TO_PROMOTE_NEW_FAMILY_CANDIDATES=no. NEXT: PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-EXECUTE-V1.)  
Prior: 2026-06-18 (`phase-claim-amount-basis-policy-operator-confirmation-v1` `20260618T220000Z` **PASS — governed amount-basis policy confirmation** — Maysam `APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1=yes`; only write = `workspace_settings.module_configs.claims.amount_basis_policy`. New `lib/claims/policy/claim-amount-basis-policy-v1.ts` (read/load + gated write-by-id+verify + approval gate); zero-import contract overlay (`AmountBasisPolicyOverlay`, `ReadyToFileRow.amount_basis_policy_overlay`); `computeFamilyAwareRecovery` honors confirmed overlay → resolved basis + `policy_confirmed`/`informational_only_bases`; composer loads+attaches overlay; drawer "Policy confirmed" badge + Selected/Informational tags. Confirmed: `removal_shipment_missing`=`removal_order_discrepancy`=`cogs_recovery` (latest_sale_net + business_loss informational). Live (`kxsvedvpjldygtdbylsy`): pilot **before {safe 0, needs_conf 10} → after {safe 10, needs_conf 0}**; total_SC=total_COGS=open_gap **$100.72**, confirmed **$0.00**, weak excluded 152, separate suggestions 31, no claim mutation; tsc/eslint/smoke/next build PASS; SAFE_CLAIM_AMOUNT_POLICY_CONFIRMED=yes, SAFE_TO_FILE_APPROVED_REMOVAL_FAMILIES=yes, SAFE_TO_BUILD_SEPARATE_CLAIM_CANDIDATE_GENERATORS=yes.)  
Prior: 2026-06-18 (`phase-claim-family-aware-recovery-matching-v2` `20260618T140000Z` **PASS — family-aware recovery + amount-basis policy (read-only)** — zero-import contract additions `CLAIM_AMOUNT_POLICY_MATRIX` (17 families; physical-loss default COGS but need operator confirmation; fee/reversal/refund resolved), `classifyFamilyByReason`/`classifyCandidateFamily`, `computeFamilyAwareRecovery` (excludes cross-family counted credits from confirmed, classifies weak candidates, 3 amounts COGS/sale-net/business-loss, `misclassified_candidates`, `separate_claim_suggestions`, policy-gated `filing_status`), `summarizeFamilyAwareRecovery`. Drawer renamed "Recovery Gap / Claim Amount Policy" + 3 amount rows + SC-amount-selected + policy-needs-confirmation badge + separate-opportunities section. Live: pilot **10/10 → needs_policy_confirmation**, total_cogs $100.72 / sale_net_est $78.48 / business_loss $100.72 / confirmed $0.00, weak candidates 152 all excluded cross-family, 31 separate-claim suggestions; tsc/lint/smoke/next build PASS; no mutation; SAFE_FAMILY_AWARE_RECOVERY_MATCHING_READY=yes, SAFE_TO_FILE_APPROVED_FAMILIES=no (basis pending), SAFE_TO_BUILD_SEPARATE_CLAIM_CANDIDATE_GENERATORS=yes.)
Prior: 2026-06-18 (`phase-amazon-report-source-api-coverage-and-claim-family-map-v1` `20260618T053000Z` **PASS — source/API coverage audit + claim-family data map + Data Coverage UI (read-only)** — zero-import `claim-source-coverage-ui-contract.ts` + server composer `claim-source-coverage-v1.ts` probing **17 sources** joined to report registry + V3 family matrix → `source_coverage_matrix` / `claim_family_map` / `live_sync_plan`; read APIs `GET /api/claims/center/source-coverage` + `/claim-family-map`; new page `/claim-center/data-coverage`; RecoveryGap gained `files_checked[]` + `missing_files_or_api[]` (drawer shows files checked + missing SP-API). Live: coverage 17 (live_loaded 16), family map 10 (2 pilot complete, fba_fee_overcharge missing), pilot $100.72 expected / $0 confirmed / $100.72 open / unknown_unmatched 10; tsc/lint/smoke/next build PASS; no mutation; SAFE_SOURCE_COVERAGE_AUDIT_COMPLETE=yes, SAFE_TO_BUILD_CLAIM_DATA_COVERAGE_UI=yes (built), SAFE_TO_BUILD_LIVE_AMAZON_REPORT_SYNC_LAYER=yes (plan), SAFE_TO_IMPROVE_RECOVERY_GAP_MATCHING_ENGINE=yes.)
Prior: 2026-06-18 (`phase-claim-recovery-gap-and-reimbursement-matching-v1` `20260618T040000Z` **PASS — deterministic recovery-gap + reimbursement-matching engine + UI (read-only)** — pure `computeRecoveryGap(row)` + `summarizeRecoveryGap(rows)`; only STRONG order-linked reimbursement/credit rows count, fees ("FBA Inventory Fee") excluded, weak FNSKU/date-window candidates surfaced but never reduce the open gap; no confirmed → unknown_unmatched (never "$0 paid"). UI: recovery summary cards + table cols (Reimbursed/Open gap/Reimb. status/Match conf.) + filters + drawer "Reimbursement / Recovery Gap" section. Live: 10 claims, expected **$100.72**, confirmed **$0.00**, open gap **$100.72**, all **unknown_unmatched**; 13 FBA-fee settlement rows excluded per /x5UTzvZZK claim; tsc/lint/smoke/next build PASS; no mutation; SAFE_RECOVERY_GAP_ENGINE_READY=yes, SAFE_TO_FILE_UNREIMBURSED_CLAIMS=yes.)
Prior: 2026-06-18 (`phase-claim-filing-decision-matrix-v1` `20260618T030000Z` **PASS — deterministic filing decision + UI (read-only)** — pure `computeFilingDecision(row)` (safe_to_file / needs_reference_review / do_not_file) keyed on strong removal/shipment/tracking ref + identity + qty + COGS recovery; weak FNSKU/date-window candidates excluded from proof; UI "Decision" badge column + "Filing Decision" drawer section. Live: 10/10 **safe_to_file**, 0 needs_review, 0 do_not_file; seller_central excludes internal UUIDs + weak refs, uses COGS recovery; tsc/lint/smoke/next build PASS; no mutation; SAFE_FILING_DECISION_MATRIX_READY=yes, SAFE_TO_MANUALLY_FILE_APPROVED_CLAIMS=yes.)
Prior: 2026-06-18 (`phase-claim-deep-amazon-reference-ledger-v1` `20260618T020000Z` **PASS — deep multi-source Amazon reference ledger + UI (read-only)** — deepened the Event Reference Ledger to a per-source-group search across removal/shipment/inventory_ledger/transaction/settlement/reimbursement/customer_return/report_metadata with a source census + bounded ±45-day FNSKU/SKU event-date window pass (advisory candidates), `filing_sufficiency` per claim, and a UI rebuild (per-source cards + status badges + coverage badge + Not-found list). Live: 10 claims (4 complete / 6 filing_sufficient / 0 needs_review); `/x5UTzvZZK`-linked claims now resolve 13 settlement IDs + report rows; totals external 88 / transaction 52 / report_metadata 16; ledger+reimbursement order-linked 0 (shown as window candidates); NO UUID/"TRID" in Seller Central; tsc/lint/smoke/next build all PASS; no DB/claim/edge/Amazon/scanner mutation; SAFE_DEEP_REFERENCE_LEDGER_READY=yes, SAFE_TO_FILE_CLAIMS_IN_SELLER_CENTRAL=yes.)
Prior: 2026-06-17 (`phase-claim-ready-to-file-queue-ui-v1` `20260617T233450Z` **PASS — operational UI + read-only audit** — new page `/claim-center/ready-to-file`; 10/10 ready, 0 blocked, $100.72, 11 audit gates; Seller Central copy + guarded Case ID recording; SAFE_READY_TO_FILE_UI_READY=yes.)

**RESUME LOOP CONVERGED (`20260624T030733Z` was a 0-net-new-rows no-op; stop re-running the resume orchestrator).** Remaining work is NOT more blind resumes: (1) `PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1` (read models now backed by settlement +20,072 + the other completed sources + inventory_ledger +89,039); (2) let cron drain `finances_archive` event-group pagination over time (bounded in-run attempts `run_failed` each pass); (3) separate gated phase to fix the `amazon_fee_preview` domain-table schema (additive migration — its `assess pipeline: domain count failed`); (4) separate gated phase to fix inbound_performance `createReport` reportOptions/params (HTTP 400). inventory_ledger DATA is complete (371,391, fresh through 2026-06-21) even though its `source_run` won't flip to a clean terminal `complete`.

**RESUME PROGRESS (resumes executed `20260624T012511Z`, then RESUME-AGAIN `20260624T020858Z` + `20260624T022259Z`, converged `20260624T030733Z`):** `PHASE-AMAZON-LIVE-SOURCE-SYNC-RESUME-AND-COMPLETE-V1` resumes the pending sources **by `uploadId`** (window-independent; reuses existing `source_run_id`s + polls existing `report_id`s — no duplicate report requests). **DONE (imported, terminal):** reimbursements (18,609), removal_order (3,819), removal_shipment (11,692), fba_returns (3,058) — re-runs are idempotent no-ops; **inventory_ledger +89,039 this session** (282,352 → **371,391**, fresh through 2026-06-21). **STILL TO FINISH — RESUME AGAIN after back-off** (re-run `node --conditions=react-server --import tsx scripts/phase-amazon-live-source-sync-resume-and-complete-v1.ts --execute`, idempotent; or let cron/resume routes finish): **inventory_ledger tail** (hit `QuotaExceeded` throttle → backed off; state still needs_resume) and **finances_archive** (`max_attempts` each run mid event-group pagination — needs several more cycles; cron-resumable, no hard blocker). **FAILED — needs a separate gated fix, NOT a blind retry:** **fee_preview** (report generated but the IMPORT pipeline errors `assess pipeline: domain count failed` → `amazon_fee_preview` domain table schema incomplete; needs an additive migration) and **inbound_performance** (`createReport` HTTP 400 for `GET_FBA_FULFILLMENT_INBOUND_PERFORMANCE_DATA` → needs `reportOptions`/params fix). **Settlement** left as-is (already imported 20,072 rows; resume skipped to avoid double-import; `amazon_settlements` 677,098). Still-open 3-SKU sale-net gap unchanged (`I6-VR35-FSXQ`/`WD-VY8Z-CZ3F`/`2H-7ZAX-Z2IP` Order rows still 0/0/0 in the 30-day window) — widen `SYNC_WINDOW_DAYS` or run `PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1` against the older settlement period. **Build-env note:** a local untracked `backend-python/venv` whose symlinks escape the project root breaks `next build` under Turbopack — keep it removed/gitignored (recreate Python venv only when needed for the backend, not in the Next build root). If the Vercel deployment runs sync/cron, the same 12 keys + `CRON_SECRET` must be set there too.

**NEXT (product cost hub — architecture READY `20260620T070000Z`):** `PHASE-PRODUCT-LANDED-COST-HUB-SCHEMA-AND-UI-BUILD-V1` — (1) write the gated additive migration EXTENDING `product_cost_snapshots` into the landed-cost spine (7 component columns + `landed_cost_unit` + `supplier_id`→vendors + `effective_from/to` + `source_type` + `confidence` + `created_by`; keep legacy `unit_cost`; org-scoped RLS; soft delete) — **DO NOT apply until `APPROVED_PRODUCT_LANDED_COST_HUB_SCHEMA_V1=yes`** in `.cursor/operator-approvals/product-landed-cost-hub-schema-v1-approval.md`; (2) build the Product Cost Hub UI at `/claim-center/financial/product-costs` (extend `ProductCogsManualEntryView` to the 7-component form + cost history + effective dates + CSV dry-run + missing-cost warnings) writing interim `cost_overrides` until the migration is approved; (3) wire `landed_cost_unit` (effective-date-matched) into the money-lane profit/loss view + Ready-to-File 3-row financial card + Product Story cost timeline, keeping the Amazon claim amount on its own policy lane. Contract + helpers already in `lib/products/contracts/product-cost-landed-cost-hub-v1.ts`.

**NEXT (the one real gate — operator action):** `PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1` — operator opens a packet in `/claim-center/ready-to-file`, files each packet (or one grouped removal-order case) in Seller Central, captures the **real Amazon Case IDs**, fills the manual-filing operator input, sets `APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes`, then run the governed filing-status write to unblock the reimbursement matcher.

~~Ready-to-File operator queue UI~~ — **DONE** `20260617T233450Z` (`/claim-center/ready-to-file`; 10/10 ready, 0 blocked; 11 audit gates; Seller Central copy + guarded Case ID recording).
~~Seller Central filing packets~~ — **DONE** `20260617T212340Z` (10/10 packets ready, 0 blocked; 3 grouped removal-order cases; record-back placeholders empty).
~~Pre-filing final verify~~ — **DONE** `20260617T211458Z` (re-verify 100%, 16/16, post reference-materialization-execute).
~~Reference materialization execute~~ — **DONE** `20260619T083000Z` (governed write executed; idempotent; SAFE_REFERENCE_MATERIALIZATION_COMPLETE=yes).

**Parallel (ready now):** `PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1` — set `APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes` + fill operator input with **real Amazon Case IDs**, then record filing status (governed write) to unblock the reimbursement matcher.

**Latest-sale-net coverage (from `20260619T193000Z`):**
- Deterministic latest-sale-net amounts + Amazon fees are now pinned in `workspace_settings.module_configs.claims.latest_sale_net_cache` (no drift). **3/10** removal claims have a real expected reimbursement (`2025JUN08-B0057FBQTC` $13.48, `FBA-B0FYDT88GQ` $23.86, `B075XC6C69-VEN` $19.76 = **$57.10** total) — these 3 are fileable now.
- ~~`PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1`~~ — **DONE (determination, read-only)** `20260619T220000Z`. Proved the 7 UNKNOWN claims (3 SKUs `I6-VR35-FSXQ`×5/`WD-VY8Z-CZ3F`/`2H-7ZAX-Z2IP`) have **no Order sale loaded in any source** (repo + settlement hold only `$0 Adjustment`; `amazon_transactions` no product_sales; `amazon_all_orders` empty) → a **data-coverage gap, not wiring** (importer maps Order sales+fees fine for other SKUs). `import_required=yes`, `approval_required=yes`; approval file `.cursor/operator-approvals/claim-missing-sale-price-source-import-v1-approval.md` (token=no). No write performed.
- **NEXT** `PHASE-CLAIM-SETTLEMENT-ORDER-IMPORT-EXECUTE-V1` — operator sets `APPROVED_MISSING_SALE_PRICE_SOURCE_IMPORT_V1=yes` and provides a `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` (or Seller Central Transaction View) export containing `Order` rows (product_sales + selling_fees + fba_fees) for the 3 SKUs covering sale dates up to each removal event; ingest via the existing mapped importer into `amazon_settlements`/`amazon_reports_repository`, then re-run `phase-claim-latest-sale-net-source-coverage-backfill-v1.ts --execute` to lift coverage above 3/10. NO COGS fallback; missing sale price stays UNKNOWN until a real sale source is imported.

**Coverage follow-ups (from source-coverage audit `20260618T053000Z`):**
- `PHASE-CLAIM-RECOVERY-GAP-SERVER-API-AND-REIMBURSEMENT-MATCH-AUTHORITY-V1` — move recovery-gap server-side (`GET /api/claims/center/recovery-gap` + `/reimbursement-matches`) and add **order-linked `amazon_reimbursements` auto-match** to turn the 10 pilot claims Unknown → confirmed not/partially/fully reimbursed. (Also recommended: `/source-events`, `/report-sync-status`.)
- P1 **Inventory Ledger Detail View ingest worker** (unlocks warehouse_lost/damaged + disposed families). P2 **FBA Customer Returns sync** (amazon_returns) for customer_return_not_reimbursed / refund_without_return. P2 **Fee Preview / Product Fees API** for fba_fee_overcharge (currently `missing`).
- View the map any time at **`/claim-center/data-coverage`** (Filing & recovery → Data Coverage).

**Family-aware follow-ups (from `20260618T140000Z`):**
- ~~`PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1`~~ — **DONE** `20260618T220000Z` (governed write to `workspace_settings.module_configs.claims.amount_basis_policy`; `removal_shipment_missing`+`removal_order_discrepancy`=`cogs_recovery`; pilot **10/10 flipped `needs_policy_confirmation → safe_to_file`**, total SC $100.72, confirmed $0.00, open gap $100.72; latest_sale_net + business_loss informational only; weak 152 / separate 31 unchanged; SAFE_CLAIM_AMOUNT_POLICY_CONFIRMED=yes).
- ~~`PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1`~~ — **DONE (preview)** `20260618T233000Z` (152 cross-family suggestions → **72** de-dup per-family previews across 6 families; **0** written, write approval absent; removal pilot unchanged $100.72; generator contract + composer + API + approval-gated write + UI on `/claim-center/opportunities` & `/claim-center/data-coverage`; `SAFE_SEPARATE_FAMILY_GENERATORS_READY=yes`, `SAFE_TO_PROMOTE_NEW_FAMILY_CANDIDATES=no`).
- **NEXT** `PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-EXECUTE-V1` — set `APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1=yes` (`.cursor/operator-approvals/separate-family-candidate-generators-write-v1-approval.md`) to materialize the writeable previews (10 reimbursement_reversal) into real per-family `claim_candidates` (idempotent by preview_id, verify other claim_* tables unchanged). In parallel: ingest Inventory Ledger Detail View (unblocks lost_warehouse/damaged_warehouse COGS basis, 45 candidates) + Fee Preview/Product Fees API (unblocks fulfillment/storage fee_delta expected value, 13 candidates).

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
