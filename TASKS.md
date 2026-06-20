# Tasks — active board

Synced with [`.ai-memory/NEXT_ACTIONS.md`](.ai-memory/NEXT_ACTIONS.md) · [`.ai-memory/SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md`](.ai-memory/SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md).

**Branch:** `feature/phase1-latest-stash-land` @ `c78fbb8` — **no merge**

## P0 — Scanner / return remediation

- [ ] **BULK-RETURN-ITEMS-PROVENANCE-READONLY** — ~5,333 orphan RIs; trace bulk load; no deletes
- [ ] **BULK-RETURN-ITEMS-QUARANTINE-APPROVAL-AND-EXECUTE** — soft-delete orphans + release allocation
- [ ] **CLAIM-RETURNS-WORK-QUEUE-PHYSICAL-ANCHOR-GATE** — require `package_id` in queue + promote

## P0 — Product sheet (after scanner P0)

- [ ] **PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION** — 3399 conflicts
- [ ] **PRODUCT-SHEET-IMPORT-MAX-25-SAMPLE-WAVE** — max 25 rows

## P1 — Claim pilot filing (active)

- [x] **PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1** `20260618T220000Z` — governed write to `workspace_settings.module_configs.claims.amount_basis_policy` (`removal_shipment_missing`+`removal_order_discrepancy`=cogs_recovery); pilot **10/10 flipped `needs_policy_confirmation → safe_to_file`**, total SC $100.72 / confirmed $0.00 / open gap $100.72; weak 152 + separate 31 unchanged; no claim mutation
- [x] **PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1** `20260618T233000Z` — preview-only: 152 cross-family suggestions → **72** de-dup per-family previews (6 families, 10 writeable); **0** written (write approval absent); removal pilot unchanged ($100.72); generator contract + API + approval-gated write + UI on opportunities/data-coverage
- [x] **PHASE-CLAIM-FAMILY-SEPARATION-UI-CLEANUP-V1** `20260618T240000Z` — Ready-to-File drawer rebuilt into 4 clean sections (current evidence / recovery gap / excluded cross-family collapsed / separate opportunities); `buildReferenceBlockText` removal-focused so Seller Central copy no longer leaks cross-family reimbursement/settlement/ledger refs; table family-aware + new cols/badges; safe_to_file 10, $100.72 open, seller_central_copy_excludes_cross_family=yes; no DB/claim/Amazon/scanner change
- [x] **PHASE-CLAIM-AMOUNT-BASIS-LATEST-SALE-NET-POLICY-FIX-V1** `20260618T250000Z` — governed write to `workspace_settings.module_configs.claims.amount_basis_policy`; removal families basis `cogs_recovery → latest_sale_net` (expected = (latest_sold_price − amazon_fees) × qty); financial UI cleanup; unloaded sale price → expected/open UNKNOWN, no COGS fallback
- [x] **PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1** `20260619T193000Z` — fixed run-to-run drift (deterministic `latest-sale-net-resolver-v1.ts`: Order rows, `product_sales>0`, `<=EOD(event_date)`, `date DESC,id DESC`, fees same-row; no settlement-net/COGS/scanner fallback) + governed cache write to `workspace_settings.module_configs.claims.latest_sale_net_cache` + provenance UI (Sale source col, drawer source/date/conf). **3/10** SKUs priced ($57.10 total), 7/10 UNKNOWN (only `$0` Adjustment rows loaded); drift_fixed yes; no claim/candidate mutation; tsc/smoke/next build PASS
- [x] **PHASE-CLAIM-REMOVAL-MISSING-BASIS-AUDIT-V1** `20260619T200000Z` — read-only origin + missing-threshold audit of the 10 pilot removal claims. Threshold `delayed_not_received_days=14` governed at `workspace_settings.module_configs.claim_intake` (not hardcoded). All 10 = legitimate missing candidates (no scan/no receipt, age 33–84d > 14d, `build_status=matched`); valid 10 / waiting 0 / wrong_family 0 / manual_review 0. `ui_origin_reason_verified=no`. No DB/claim/Amazon/scanner change; tsc/smoke/next build PASS
- [x] **PHASE-AMAZON-SPAPI-LIVE-SOURCE-INTEGRATION-AND-CLAIM-GATE-AUDIT-V1** `20260619T234601Z` — read-only live-integration audit + connector build gate. `amazon_connection_status=configured_but_disabled` (claim Reports/Finances SYNC lane; creds complete on 1/4 `marketplaces` rows; catalog/pricing lane enabled but SYNC workers off + CRON_SECRET absent). 17 sources live_loaded 16, **all** `live_sp_api_exists=false`. **CORE:** corrected gate demotes **all 10** pilot rows READY -> `waiting_physical_receiving` (no receiving/scan ever performed + no live removal-delivery proof); fileable 0 / demoted 10 / missing_sale_price 7 / needing_live_reimbursement_check 10. `ui_ready_to_file_gate_correction_needed=yes`. No DB/claim/Amazon/scanner change; build+smoke PASS; SAFE_SPAPI_LIVE_SOURCE_FOUNDATION_READY=yes, SAFE_TO_BUILD_LIVE_REPORT_SYNC_WORKERS=yes, SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES=yes
- [ ] **PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1** — wire `computeRemovalOriginReason` + new `waiting_physical_receiving` state + live removal-delivery proof check into the `ready_to_file` gate (enforce `scan_go_live_date` for removal/delayed_not_received); demote the 10 pilot rows to Claim Opportunities / Needs Data until a live source confirms delivery + reimbursement + sale net (NEXT)
- [x] **PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1** `20260620T004544Z` — built 4 new SP-API pull workers (FBA returns / inventory ledger / fee preview / inbound performance) + 8 routes + extended flags + platform automation types + new `/api/settings/imports/reports-api/sync-foundation` endpoint. `all_workers_built=yes`, `pipeline_verified=yes`; worker flags all disabled (env keys needed); `live_sp_api_exists` all false; `SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY=yes`. Missing env keys: ENABLE_AMAZON_REPORTS_API_WORKER + 8 sub-flags + ENABLE_AMAZON_FINANCES_API_WORKER/INGEST + CRON_SECRET + ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON
- [x] **PHASE-PRODUCT-TRID-STORY-LINKAGE-AUDIT-AND-LAYER-V1** `20260620T010427Z` — read-only product identity + TRID/reference graph audit + product-story build plan (11 source tables; `product_linkage_status=healthy`; 16-ref TRID model; 10-step deterministic SP-API mapping rule; reuse existing spine, no new tables); SAFE_PRODUCT_TRID_STORY_LAYER_READY=yes, SAFE_TO_BUILD_FAMILY_CLAIM_GENERATORS=yes
- [x] **PHASE-CLAIM-TRID-EDGE-READMODEL-IMPLEMENT-V1** `20260620T020000Z` — NEW `lib/claims/readmodel/trid-edge-readmodel-v1.ts` exposes TRID_EDGE_KIND_CATALOG + per-candidate materialized edges as a read model (`resolveEdgeKindId`, `buildTridEdgeReadModel` with claim_ready/money/product_story coverage + gating, `tridEdgeKindCatalog()`); family-aware gating in discovery engine (`findFamilyEdgeRequirement` + `gateDiscoveredEdge`: disputed→review_signal, product_link+unresolved→defer, signal/lifecycle→review_signal); wired `getCenterReferencesPayload` candidate branch + `TridReferenceGraphPanel` (Product Story Reference block + References tab). No new tables, no `claim_*` mutation; smoke 21/21 PASS, next build exit 0, ReadLints 0; SAFE_TRID_EDGE_READMODEL_READY=yes
- [x] **PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1** `20260619T210000Z` — surfaced per-claim missing-basis + threshold + origin matrix in Ready-to-File drawer/table (read-only display)
- [ ] **PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1** — import Transaction View / settlement `Order` rows (or SP-API settlement report) for the 7 SKUs (`I6-VR35-FSXQ`×5, `WD-VY8Z-CZ3F`, `2H-7ZAX-Z2IP`) with no loaded sale; then re-run backfill to lift coverage above 3/10
- [x] **PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1** `20260620T040000Z` — read-only dry-run across all **17** families (reuses queue+hardened gate / `composeSeparateFamilyCandidateGeneratorsV1` / `composeClaimSourceCoverageV1`; no new tables/contracts). total_dry_run **82**, valid **20**, ready_for_review **20**, **ready_to_file 0**: removal pilot 6+4=10 (all valid, 0 fileable); reimbursement_reversal 11 (10 valid, $83.05); lost_warehouse 39 / damaged_warehouse 6 / fulfillment_fee_overcharge 13 / customer_return_not_received 2 / lost_outbound 1 (all blocked); damaged_outbound/disposed/refund_without_return/storage_fee/inbound = 0; 4 unsupported families (missing_reimbursement, partial_reimbursement, wrong_item_returned, empty_box_return) need generators. No DB/claim/Amazon/scanner change [9155/22/22/13/147 unchanged]; tsc/smoke/next build PASS; SAFE_FAMILY_CLAIM_GENERATORS_DRY_RUN_COMPLETE=yes, SAFE_TO_BUILD_CLAIM_OPPORTUNITIES_UI=yes
- [x] **PHASE-CLAIM_CENTER_UNIFIED_OPPORTUNITIES_UI_V1** `20260620T050000Z` — read-only Claim Center UI/UX organization. Unified **9-section primary nav** (`claim-center-primary-nav.ts` + `ClaimCenterWorkflowBar` rewrite; flow steps + smoke markers preserved; mobile More sheet "Claim Center" sections group). **Needs Data page** (NEW `/claim-center/needs-data`) groups ready-to-file blocked_rows by 7-group taxonomy (`claim-needs-data-contract.ts`) with unblock hints + color tiles. **Opportunities** regrouped into 8 family groups (`claim-family-group-contract.ts`); clickable cards → clean `SeparateFamilyCandidateDrawer` (7-block Summary/Why/Financial/Evidence/Blockers/Product-Story/Next-action); raw counts collapsed under Developer details. **Reimbursement transparent-drawer bug FIXED** (theme-independent base bg + Tailwind bg on generic drawer classes; root cause = `html.light` ancestor dependency). Color system blue=opportunity/yellow=needs-data/green=ready/red=blocker/gray=debug. Ready-to-File verified clean (unchanged). tsc 0/ReadLints 0/smoke PASS/next build exit 0 (`/claim-center/needs-data` registered); UI-only, no claim mutation; **SAFE_CLAIM_CENTER_UI_ORGANIZED=yes**
- [ ] **PHASE-CLAIM-CENTER-UI-LIVE-VERIFY-AND-COUNT-WIRE-V1** — with the Claim Recovery module enabled in the running env, live-verify the 9-section nav + Needs Data grouping + Opportunities family buckets + candidate/reimbursement drawers; wire real per-section badge counts into the workflow bar; add focused smoke for the primary-nav contract + needs-data taxonomy (NEXT)
- [ ] **PHASE-CLAIM-OPPORTUNITIES-PROMOTE-WRITE-V1** — gate promote-to-candidate from Opportunities behind `APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1` (governed write)
- [ ] **PHASE-CLAIM-MISSING-FAMILY-GENERATORS-V1** — build generators for `missing_reimbursement` / `partial_reimbursement` / `wrong_item_returned` / `empty_box_return` once GET_FBA_REIMBURSEMENTS_DATA + FBA customer returns live sync land
- [ ] **PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-EXECUTE-V1** — approve + materialize writeable previews into real per-family claim_candidates
- [ ] **PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1** — operator files in Seller Central via `/claim-center/ready-to-file`, records real Amazon Case IDs (governed write)
- [x] **PHASE-CLAIM-FAMILY-AWARE-RECOVERY-MATCHING-V2** `20260618T140000Z` — family classifier + amount-basis policy matrix + cross-family credit exclusion (read-only)

## P0 — Policy

- [ ] Staging quartet → `eiqfaapyumhixxoeltgu`
- [ ] No `package_items`; no legacy `returns`; no bulk RI from forecast
- [ ] No merge / deploy / original apply until scanner remediation complete
- [ ] Architecture audit + approval before scanner/return/claims DB writes
- [ ] `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED` — **off**

## Done

- [x] Full scanner/expected/returns/claims architecture recovery — `20260531T084101Z`
- [x] Wave2 `resolved_product_id` rollback — **PASS** (active RI 5,366; resolved 57)
- [x] Architecture correction history/memory update — `20260531T120000Z`

## Forbidden

[`.ai-memory/FORBIDDEN_ACTIONS.md`](.ai-memory/FORBIDDEN_ACTIONS.md)
