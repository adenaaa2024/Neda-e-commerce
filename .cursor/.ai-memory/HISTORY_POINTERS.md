# History pointers — authoritative

## Canonical master

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Latest append | `20260619T220000Z` — **PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1** PASS (read-only source-import determination; **NO write** — import + cache both BLOCKED on approval). 7/10 removal claims UNKNOWN across 3 SKUs (`I6-VR35-FSXQ`×5, `WD-VY8Z-CZ3F`, `2H-7ZAX-Z2IP`); `unknown_reason=NO_VALID_ORDER_SALE_AT_OR_BEFORE_EVENT`. **Source discovery:** `amazon_reports_repository` (412,645) + `amazon_settlements` (604,883) hold **zero `product_sales>0` rows of ANY transaction_type** for those 3 SKUs — only `$0 Adjustment` (settlement sku_rows 150/14/10, all Adjustment); `amazon_transactions` (600) has no product_sales col; `amazon_all_orders` exists but **0 rows**; `all_orders`/`amazon_order_items`/`amazon_orders`/`order_items`/`amazon_settlement_transactions` absent. `Order`+`product_sales>0` rows DO exist for other SKUs (e.g. OX-ITQ9-7MWI 14.99/-1.20/-5.82) → importer mapped OK → **data-coverage gap, not wiring**. `import_required=yes`; `required_report_or_api=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` (or Seller Central Transaction View export; all_orders report = price-only fallback, no fees); `report_mapped=yes`; `approval_required=yes`; `approval_file_path=.cursor/operator-approvals/claim-missing-sale-price-source-import-v1-approval.md` (`APPROVED_MISSING_SALE_PRICE_SOURCE_IMPORT_V1=no`). Coverage unchanged: sale_price 3/10 before==after, fee 3/10; the 3 priced = `B0057FBQTC` $13.48 + `B0FYDT88GQ` $23.86 + `B075XC6C69-VEN` $19.76 = **total_expected/open $57.10**; `drift_fixed=yes` ($57.10 run1==run2); `source_import_written=no`, `latest_sale_net_cache_written=no`. No claim/candidate mutation [subs 13, cases 22, lines 22, cands 9155, edges 147], no Amazon submit, no scanner change. tsc 0, ReadLints 0, smoke PASS, next build exit 0; **SAFE_MISSING_SALE_PRICE_SOURCE_IMPORTED=no**, **SAFE_LATEST_SALE_NET_COVERAGE_COMPLETE=no** (3/10), **SAFE_TO_FILE_PRICED_REMOVAL_CLAIMS=yes** ($57.10). NEXT: PHASE-CLAIM-SETTLEMENT-ORDER-IMPORT-EXECUTE-V1 (after approval + provided report). Files: `diag-missing-sale-price-source-import-v1.ts` (new), `diag-repo-order-sale-reprobe-v1.ts` (new), `diag-source-pipeline-mapped-v1.ts` (new), `phase-claim-missing-sale-price-source-import-v1.ts` (new), `claim-missing-sale-price-source-import-v1-approval.md` (new) |
| Prior | `20260619T210000Z` — **PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1** PASS (read-only UI clarity for removal-claim origin/missing basis; no DB write, no `claim_*` mutation, no Amazon, no scanner, no claim math, no AI). Surfaced the missing-basis audit findings in the Ready-to-File UI, kept separate from the latest_sale_net financial lane. **Contract** (zero-import) gained `RemovalOriginInputs` + `removal_origin_inputs` on `ReadyToFileRow` + pure `computeRemovalOriginReason(row)` deterministic classifier (received-in-full→`not_missing`; partial→`valid_discrepancy`; no-receipt+age≤thr→`waiting_threshold`; no-receipt+age>thr→`valid_missing`; disputed/no-date→`needs_manual_review`; missing NOT inferred from shipment existence alone). New SELECT-only loader `lib/claims/filing/claim-removal-origin-basis-v1.ts` (batch reads EP/amazon_removals/amazon_removal_shipments/packages/return_items); composer attaches it + loads `delayed_not_received_days` (14) via `loadClaimIntakeSettings`. **Table** added Origin/Missing basis/Age days/Threshold days/Expected qty/Received-scanned qty/Missing qty/Validity (colSpan 28→36). **Drawer** added top **"Why this claim exists"** section (source, tracking, removal order/shipment id, event date+age, configured threshold 14 + source, expected/received/missing qty, scanner status, final reason) + badges (`valid_missing`/`over_threshold`/`scanner_absent`/`full_missing`/`no_manual_review_needed`/`waiting_threshold`/`has_receipt`) + header Waiting-threshold badge. **Live verify** (`scripts/phase-claim-removal-origin-reason-ui-surface-v1.ts`, exercises real UI path): all 10 → `valid_missing`, ages 33–84 (all>14), received 0/10, missing=expected, threshold 14; counts valid **10**/waiting **0**/wrong_family **0**/manual_review **0**. `ui_origin_reason_verified=yes`, `table_origin_columns_verified=yes`, `drawer_why_claim_exists_verified=yes`. tsc 0, ReadLints 0, smoke PASS (new origin fixtures), next build exit 0; **SAFE_REMOVAL_ORIGIN_REASON_UI_READY=yes**, **SAFE_TO_IMPORT_MISSING_SALE_PRICE_SOURCES=yes**. NEXT: PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1. Files: `claim-ready-to-file-queue-ui-contract.ts`, `claim-removal-origin-basis-v1.ts` (new), `claim-ready-to-file-queue-v1.ts`, `ReadyToFileView.tsx`, `ReadyToFileDetailDrawer.tsx`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts`, `phase-claim-removal-origin-reason-ui-surface-v1.ts` (new) |
| Prior | `20260619T200000Z` — **PHASE-CLAIM-REMOVAL-MISSING-BASIS-AUDIT-V1** PASS (read-only claim-origin + missing-threshold audit; no DB write, no `claim_*` mutation, no Amazon, no scanner, no AI). New SELECT-only `scripts/phase-claim-removal-missing-basis-audit-v1.ts`. **Missing threshold:** `missing_threshold_setting_found=yes`, `missing_threshold_days=14`, `threshold_source=workspace_settings.module_configs.claim_intake.delayed_not_received_days` (governed JSONB, not hardcoded — code default 14 + override path; org-level `organization_settings.claim_policy.intake` absent). **Origin (all 10 identical):** from removal-shipment-detail + removal-order-detail + expected_packages (`build_status=matched`, none disputed) + scanner-receipt-absence (no `packages` row for tracking, 0 scanned `return_items`, EP `actual_scanned_count=0`) + age>threshold; NOT quantity-mismatch (received=0 → full-missing not partial). Removal Order IDs 1621GIL(4)/​/x5UTzvZZK(4)/​/571WdHlKl(2); event age 33–84d (all >14d); expected_qty 1–4 (EP clean), received 0/10, discrepancy=expected. **Classification:** valid **10**, waiting_threshold **0**, wrong_family **0**, needs_manual_review **0** — every claim is a legitimate `missing_candidate_age_exceeds_threshold`. `recommended_setting_changes`: none. `ui_origin_reason_verified=no` (drawer/table show family/decision/recovery+refs but NOT explicit missing-basis+threshold+origin matrix → recommended next phase). no_db_write/no_claim_mutation/no_amazon/no_scanner **PASS**; tsc 0, ReadLints 0, smoke `smoke-phase-claim-ready-to-file-queue-ui-v1.ts` PASS, next build exit 0; **SAFE_REMOVAL_MISSING_BASIS_AUDITED=yes**, **SAFE_TO_FILE_VALID_REMOVAL_CLAIMS=yes (10 valid)**. NEXT: PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1. Files: `scripts/phase-claim-removal-missing-basis-audit-v1.ts` |
| Prior | `20260619T193000Z` — **PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1** PASS (governed cache write EXECUTED; only `workspace_settings.module_configs.claims.latest_sale_net_cache`; Maysam `APPROVED_LATEST_SALE_NET_SOURCE_BACKFILL_V1=yes`). **Root drift cause fixed:** old `resolveLatestSoldPrice` fetched `limit 8` with **no SQL ORDER BY** (arbitrary Postgres subset → run-to-run drift), accepted `$0` `Adjustment` rows as sale price, and picked "latest overall" not "latest sale before the removal event". New deterministic resolver `lib/claims/submission/latest-sale-net-resolver-v1.ts` (`resolveLatestSaleNetDeterministic`): source priority `amazon_reports_repository`→`amazon_settlements`, same SKU, `transaction_type='Order'` AND `product_sales>0`, `<= EOD(source_event_date)`, **latest by date then id DESC** (one stable winner), fees `|selling_fees|+|fba_fees|+|other|` from the SAME row; no settlement-net/COGS/scanner fallback; UNKNOWN+`unknown_reason` when no valid sale. Governed cache (read `readLatestSaleNetCache`, gated write `latest-sale-net-cache-write-v1.ts`) pins per-submission price/fees/source/date/confidence so amounts can't drift; discovery prefers cache, else live deterministic. Provenance threaded discovery→preview→after-cogs matrix→queue→`ReadyToFileMoneyLane`/`FamilyAwareRecovery` (`latest_sold_price_source`/`_date`, `amazon_fees_source`, `fee_source_confidence`, `sale_match_confidence`, `latest_sale_net_deterministic`, `latest_sale_net_unknown_reason`). UI: drawer **A · Amazon Claim Amount** shows source/sale-date/match-conf + fee source/conf + **UNKNOWN — reason**; money-lane Fields gain source hints; table adds **Sale source** column + UNKNOWN badges + colSpan 27→28. **Diagnostic ground truth** (`amazon_all_orders`/`amazon_transactions` empty; ASIN null): only **3/10** SKUs have real Order sales — `2025JUN08-B0057FBQTC` $14.99/fees $8.25→exp $13.48, `FBA-B0FYDT88GQ` $22.99/$11.06→$23.86, `B075XC6C69-VEN` $9.96/$5.02→$19.76; other 7 (I6-VR35-FSXQ×5, WD-VY8Z-CZ3F, 2H-7ZAX-Z2IP) only `$0` Adjustment rows → UNKNOWN (`NO_VALID_ORDER_SALE_AT_OR_BEFORE_EVENT`, no COGS fallback). Live execute (`kxsvedvpjldygtdbylsy`, singleton row `5ad12e20…`): cache_or_config_written **yes**; sale_price coverage **3/10** before==after, fee coverage **3/10**; total_expected_reimbursement **$57.10**, total_open **$57.10**; old_drifting_total **$57.10** now pinned; **drift_fixed yes** (run1==run2 $57.10); ambiguous candidates **1** (B0057 same-day alts 14.99/15.00 → deterministic 14.99@19:14); ui_latest_sale_net_source_verified **yes**; no claim/candidate mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; no Amazon submit, no scanner change. tsc 0, smoke PASS, next build Compiled successfully; **SAFE_LATEST_SALE_NET_BACKFILL_COMPLETE=yes**, **SAFE_TO_AUDIT_REMOVAL_MISSING_BASIS=yes**. Files: `latest-sale-net-resolver-v1.ts`, `latest-sale-net-cache-write-v1.ts`, `claim-money-lane-source-discovery-v1.ts`, `claim-money-lane-preview-v1.ts`, `claim-money-lane-preview-after-cogs-v1.ts`, `claim-ready-to-file-queue-v1.ts`, `claim-ready-to-file-queue-ui-contract.ts`, `ReadyToFileDetailDrawer.tsx`, `ReadyToFileView.tsx`, `claim-latest-sale-net-source-backfill-v1-approval.md`, `phase-claim-latest-sale-net-source-coverage-backfill-v1.ts`, `diag-latest-sale-net-source-coverage-v1.ts`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts` |
| Prior | `20260618T250000Z` — **PHASE-CLAIM-AMOUNT-BASIS-LATEST-SALE-NET-POLICY-FIX-V1** PASS (governed amount-basis correction + financial UI cleanup; write only `workspace_settings.module_configs.claims.amount_basis_policy`; Maysam `APPROVED_CLAIM_AMOUNT_BASIS_LATEST_SALE_NET_POLICY_FIX_V1=yes`). Removal families `removal_shipment_missing` + `removal_order_discrepancy` basis flipped **cogs_recovery → latest_sale_net**: Seller Central **expected reimbursement = (latest_sold_price − amazon_fees) × qty** (settlement net + COGS + sale-price-alone forbidden as the claim amount); `open_claim_amount = expected − confirmed_reimbursed_strong`; when sale price unloaded → expected/open **UNKNOWN (null)**, never a COGS fallback. Contract `computeFamilyAwareRecovery` gained `expected_reimbursement_latest_sale_net` / `total_cogs` / `business_profit_loss_context` (= expected − cogs_total); latest-sale-net no longer prefers `net_settlement_amount`; open-gap COGS fallback removed. Server packet body + checklist now request latest-sale-net for removal families (COGS internal only). **Drawer** section 2 → **"Financial Breakdown"** with badge **"Seller Central amount basis: latest_sale_net"**, split **A · Amazon Claim Amount** (latest sold price/Amazon fees/expected/confirmed/open/match status) + **B · Internal Cost / Profit-Loss** (approved COGS/unit/qty/total COGS/settlement net/profit-loss context/internal-only note); copy block requested amount uses expected. **Table** replaced "Recovery" with **Expected reimbursement / Confirmed reimbursed / Open claim amount / Internal COGS / Profit/loss context** (colSpan 27). Live execute (`kxsvedvpjldygtdbylsy`, singleton row `5ad12e20…`): policy_config_written **yes**; old_total_cogs_expected **$100.72** → new latest-sale-net expected **≈$59–61** (non-deterministic latest-price lookup; **7/10 claims have no loaded sale price → expected UNKNOWN**, surfaced honestly); confirmed **$0.00**, open == expected, internal COGS **$100.72**, **safe_to_file 10**, all basis=latest_sale_net & policy=confirmed & SC requested ≠ COGS; weak excluded **152**, separate **31** unchanged; no claim mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]. tsc 0, smoke PASS, next build OK; **SAFE_AMOUNT_BASIS_LATEST_SALE_NET_CONFIRMED=yes**, **SAFE_READY_TO_FILE_FINANCIAL_UI_CLEAR=yes**, **SAFE_TO_FILE_APPROVED_REMOVAL_FAMILIES=yes**. Files: `claim-ready-to-file-queue-ui-contract.ts`, `claim-seller-central-filing-packet-v1.ts`, `ReadyToFileDetailDrawer.tsx`, `ReadyToFileView.tsx`, `claim-amount-basis-latest-sale-net-policy-fix-v1-approval.md`, `phase-claim-amount-basis-latest-sale-net-policy-fix-v1.ts`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts` |
| Prior | `20260618T240000Z` — **PHASE-CLAIM-FAMILY-SEPARATION-UI-CLEANUP-V1** PASS (UI cleanup + read-only verification; no DB/claim/Amazon/scanner/math change). Ready-to-File **drawer** rebuilt into 4 clean sections from one `computeFamilyAwareRecovery(row)`: **1 Current Claim Evidence** (same-family removal/shipment/tracking/product/qty/COGS/recovery), **2 Current Claim Recovery Gap/Amount Policy** (strong same-family only; cross-family never reduces gap), **3 Excluded Cross-Family Candidates** (collapsed `<details>`, from `misclassified_candidates`, cols event-type/family/source-table/amount/date/why/separate?), **4 Separate Claim Opportunities** (grouped per family: count/total/confidence/next-action). Fixed real leak: **`buildReferenceBlockText`** now emits a removal-focused Seller Central block (ASIN/FNSKU/SKU + Removal Order/Shipment/Tracking + Qty) and **drops** cross-family reimbursement/settlement/inventory-ledger lines. **`ReadyToFileView` table** switched gap cols to family-aware; new cols Current family / Filing status / Policy status / Decision / Flags / Current claim open gap / Sep. opps + per-row badges (current claim only / N cross-family excluded / not Amazon-submitted / policy status). Live (`kxsvedvpjldygtdbylsy`): **safe_to_file 10** (policy already confirmed), expected/open **$100.72**, confirmed **$0.00**, weak excluded **152**, separate opps by family lost_warehouse 59 / fee_overcharge 52 ($305.12) / damaged_warehouse 18 / reimbursement_reversal 11 / lost_outbound 10 / customer_return 2; **seller_central_copy_excludes_cross_family=yes** (was leaking 13 IDs/claim). tsc 0, smoke PASS, next build OK; **SAFE_FAMILY_SEPARATION_UI_CLEAR=yes**, **SAFE_TO_RUN_AMOUNT_BASIS_POLICY_CONFIRMATION=yes** (already confirmed). Files: `ReadyToFileDetailDrawer.tsx`, `ReadyToFileView.tsx`, `claim-ready-to-file-queue-ui-contract.ts`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts`, `phase-claim-family-separation-ui-cleanup-v1.ts` |
| Prior | `20260618T233000Z` — **PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1** PASS (preview-only; write approval ABSENT → 0 writes). New zero-import-safe generator contract `lib/claims/opportunities/separate-family-candidate-generator-contract-v1.ts` (`SeparateFamilyCandidatePreview`, `GENERATOR_SUPPORTED_FAMILIES` 13, `GENERATOR_SUPPORT_MATRIX`, `buildSeparateFamilyCandidatePreviews` — dedup + never-removal + product-identity-required + scanner/OCR-excluded + fee-needs-transaction + reversal-needs-pairing + policy-gating); enriched `FamilyCandidateClassification` with `kind`/`quantity`/`source_group`. Server composer `separate-family-candidate-generators-v1.ts` + handler `getCenterSeparateFamilyOpportunitiesPayload` + `GET /api/claims/center/separate-family-opportunities`. Approval-gated write module `separate-family-candidate-generators-write-v1.ts` (`APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1`; schema-agnostic insert; BLOCKED by default). UI: `SeparateFamilyOpportunitiesPanel` on `/claim-center/opportunities` (per-family cards) + `/claim-center/data-coverage` (support matrix); ready-to-file untouched. Live preview (`kxsvedvpjldygtdbylsy`): suggestions **152** → previews **72** → written **0**; family_counts {lost_warehouse 39, fulfillment_fee_overcharge 13, reimbursement_reversal 11, damaged_warehouse 6, customer_return_not_received 2, lost_outbound 1}, writeable 10; removal pilot unchanged (10 safe_to_file, open gap **$100.72**, confirmed $0, weak 152 excluded); no claim mutation [claim_candidates 9155 before==after]. tsc 0, smoke PASS, next build OK; **SAFE_SEPARATE_FAMILY_GENERATORS_READY=yes**, **SAFE_TO_PROMOTE_NEW_FAMILY_CANDIDATES=no** (approval absent) |
| Prior | `20260618T220000Z` — **PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1** PASS governed write (only `workspace_settings.module_configs.claims.amount_basis_policy`; Maysam `APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1=yes`). New governed module `lib/claims/policy/claim-amount-basis-policy-v1.ts` (`loadConfirmedAmountBasisPolicy` read / `writeConfirmedAmountBasisPolicy` gated write-by-id+verify / approval gate). Contract overlay (zero-import): `AmountBasisPolicyOverlay`/`ConfirmedFamilyAmountPolicy` + optional `amount_basis_policy_overlay` on `ReadyToFileRow`; `computeFamilyAwareRecovery` honors confirmed overlay → `policy_resolved=true` + basis set + `policy_confirmed`/`policy_confirmation`/`informational_only_bases`; confirmed removal families → `safe_to_file`. Composer loads overlay + attaches to rows. Drawer badge **"Policy confirmed"** + Selected/Informational tags. Confirmed policy: `removal_shipment_missing`=cogs_recovery, `removal_order_discrepancy`=cogs_recovery (latest_sale_net + business_loss informational only). Live execute (`kxsvedvpjldygtdbylsy`, org `…-0001`, row `5ad12e20…` singleton): pilot **before {safe 0, needs_conf 10} → after {safe 10, needs_conf 0}**; total_seller_central=total_cogs=open_gap **$100.72**, confirmed **$0.00**, business_loss **$100.72**, latest_sale_net **$101.18** (informational); weak excluded **152**, separate suggestions **31** (unchanged); no claim mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]. tsc 0, eslint 0, smoke PASS, next build Compiled successfully; **SAFE_CLAIM_AMOUNT_POLICY_CONFIRMED=yes**, **SAFE_TO_FILE_APPROVED_REMOVAL_FAMILIES=yes**, **SAFE_TO_BUILD_SEPARATE_CLAIM_CANDIDATE_GENERATORS=yes**. Files: `claim-amount-basis-policy-v1.ts`, `claim-ready-to-file-queue-ui-contract.ts`, `claim-ready-to-file-queue-v1.ts`, `ReadyToFileDetailDrawer.tsx`, `claim-amount-basis-policy-v1-approval.md`, `phase-claim-amount-basis-policy-operator-confirmation-v1.ts`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts` |
| Prior | `20260618T140000Z` — **PHASE-CLAIM-FAMILY-AWARE-RECOVERY-MATCHING-V2** PASS read-only (family-aware recovery + amount-basis policy). In the **zero-import** contract `claim-ready-to-file-queue-ui-contract.ts`: `CLAIM_AMOUNT_POLICY_MATRIX` (17 families: cogs_recovery/latest_sale_net/fee_delta/reimbursement_reinstatement/refund_amount/configurable; `policy_resolved` flag — physical-loss families default COGS but **need operator confirmation**, fee/reversal/refund resolved); `classifyFamilyByReason()`/`classifyCandidateFamily()` + `FAMILY_GROUP`; `computeFamilyAwareRecovery(row)` (excludes **cross-family** counted reimbursement/credits from confirmed, classifies all weak candidates, 3 amounts COGS/latest-sale-net/business-loss, Seller-Central basis + reason, `misclassified_candidates`, `separate_claim_suggestions`, `filing_status` policy-gated) + `summarizeFamilyAwareRecovery`. Drawer renamed **"Recovery Gap / Claim Amount Policy"** (3 amount rows, SC amount selected + why, "Policy needs confirmation" badge, family-aware weak candidates with why-not + separate-opportunity, **"Separate claim opportunities suggested"** section). Live (`kxsvedvpjldygtdbylsy`, org `…-0001`): policy matrix **17** (4 resolved/13 needs-conf); pilot **10/10 → needs_policy_confirmation**, total_cogs **$100.72**, latest_sale_net_est **$78.48**, business_loss **$100.72**, confirmed **$0.00**; weak candidates **152** all excluded (cross-family), **31** separate-claim suggestions; source coverage **17** (live_loaded 16, missing=COGS override). tsc 0, eslint 0, smoke PASS, next build Compiled successfully; no DB/claim/edge/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; **SAFE_FAMILY_AWARE_RECOVERY_MATCHING_READY=yes**, **SAFE_TO_FILE_APPROVED_FAMILIES=no** (basis pending), **SAFE_TO_BUILD_SEPARATE_CLAIM_CANDIDATE_GENERATORS=yes**. Files: `claim-ready-to-file-queue-ui-contract.ts`, `ReadyToFileDetailDrawer.tsx`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts`, `phase-claim-family-aware-recovery-matching-v2.ts` |
| Prior | `20260618T053000Z` — **PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE-AND-CLAIM-FAMILY-MAP-V1** PASS read-only (source/API coverage audit + claim-family data map + new `/claim-center/data-coverage` UI + Ready-to-File drawer enrichment). New **zero-import** client contract `claim-source-coverage-ui-contract.ts` + server composer `claim-source-coverage-v1.ts` (`composeClaimSourceCoverageV1`) probing **17 sources** (exists/count/latest via candidate-column fallback) joined to `AMAZON_REPORT_REGISTRY` + `CLAIM_FAMILY_MATRIX_V3`. New read APIs `GET /api/claims/center/source-coverage` + `/claim-family-map`; new page `/claim-center/data-coverage` (coverage cards + family map + missing warnings + live-sync plan + priority builds) under Filing & recovery; page-contract id `data_coverage`. RecoveryGap gained `files_checked[]` + `missing_files_or_api[]` (names SP-API report needed when reimbursement/settlement/ledger group weak/absent); drawer renders both. Live (`kxsvedvpjldygtdbylsy`, org `…-0001`): coverage **17** → live_loaded **16**, empty 0, missing/planned 0 (COGS override_based); counts incl. inventory_ledger 282352, settlements 604883, reimbursements 17546, removals 3554, removal_shipments 11525, returns 2574 (amazon_returns; customer_returns alias empty); family map **10** (removal_shipment_missing + removal_order_discrepancy = **complete pilot**, fba_fee_overcharge **missing**, others partial/preview); pilot **$100.72** expected / **$0.00** confirmed / **$100.72** open / **unknown_unmatched 10**, every claim records files-checked + missing-files/API; live_sync_plan 9. tsc 0, eslint 0, smoke PASS, next build Compiled successfully (3 new routes registered); no DB/claim/edge/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; **SAFE_SOURCE_COVERAGE_AUDIT_COMPLETE=yes**, **SAFE_TO_BUILD_CLAIM_DATA_COVERAGE_UI=yes (built)**, **SAFE_TO_BUILD_LIVE_AMAZON_REPORT_SYNC_LAYER=yes (plan)**, **SAFE_TO_IMPROVE_RECOVERY_GAP_MATCHING_ENGINE=yes**. Files: `claim-source-coverage-ui-contract.ts`, `claim-source-coverage-v1.ts`, `claim-center-api-handlers.ts`, `source-coverage/route.ts`, `claim-family-map/route.ts`, `data-coverage/page.tsx`, `ClaimDataCoverageView.tsx`, `claim-center-v2-page-contract.ts`, `claim-reimbursement-tracking-nav.ts`, `claim-ready-to-file-queue-ui-contract.ts`, `ReadyToFileDetailDrawer.tsx`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts`, `phase-amazon-report-source-api-coverage-and-claim-family-map-v1.ts` |
| Prior | `20260618T040000Z` — **PHASE-CLAIM-RECOVERY-GAP-AND-REIMBURSEMENT-MATCHING-V1** PASS read-only (deterministic recovery-gap + reimbursement-matching engine + UI). New pure client-safe helpers `computeRecoveryGap(row)` + `summarizeRecoveryGap(rows)` in `claim-ready-to-file-queue-ui-contract.ts` (still **zero imports**). Only STRONG matches count: order-linked `amazon_reimbursements` rows + order-linked settlement/transaction rows classified as reimbursement/credit (`amount>0`). `isReimbursementCreditType()` **excludes fees** (FBA Inventory Fee/storage/commission/advertising/subscription). Weak FNSKU/date-window candidates surfaced but **never reduce open gap**; `open_gap = confirmed>0 ? max(expected−confirmed,0) : expected`; no confirmed → **unknown_unmatched** (never "$0 paid"); SC requested amount = open_gap if confirmed>0 else expected. UI: recovery summary cards (Expected/Confirmed/Open gap/Unreimbursed/Needs review), table cols (Reimbursed/Open gap/Reimb. status/Match conf.), filters (reimbursement_status + has_weak_candidates), drawer **"Reimbursement / Recovery Gap"** section. **Probe ground truth:** pilot orders have amazon_transactions **0**, amazon_settlements **135 all "FBA Inventory Fee"**, amazon_reimbursements by order_id **0**, by FNSKU **289 (Damaged/Lost/CustomerReturn/Reversal — weak only)**. Live verify (`kxsvedvpjldygtdbylsy`, pilot-20260615T190000Z): total **10**, expected **$100.72**, confirmed **$0.00**, open gap **$100.72**, **unknown_unmatched 10**, unreimbursed 10, needs_review 10, strong_match 0, weak rows 10/10, excluded reasons 24 (13 FBA-fee rows excluded per /x5UTzvZZK claim); requested-amount logic **yes**; tsc 0, eslint 0, smoke PASS, next build Compiled successfully; no DB/claim/edge/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; **SAFE_RECOVERY_GAP_ENGINE_READY=yes**, **SAFE_TO_FILE_UNREIMBURSED_CLAIMS=yes**. Files: `claim-ready-to-file-queue-ui-contract.ts`, `ReadyToFileView.tsx`, `ReadyToFileDetailDrawer.tsx`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts`, `phase-claim-recovery-gap-and-reimbursement-matching-v1.ts`, `diag-recovery-gap-reimbursement-probe-v1.ts` |
| Prior | `20260618T030000Z` — **PHASE-CLAIM-FILING-DECISION-MATRIX-V1** PASS read-only (deterministic filing decision + UI badge). New pure client-safe helper `computeFilingDecision(row)` in `claim-ready-to-file-queue-ui-contract.ts` → `FilingDecision { decision (safe_to_file / needs_reference_review / do_not_file), reason, high_confidence_refs[], weak_refs_excluded[], internal_anchors_excluded[], human_review_checklist[] }`. Rules: **do_not_file** iff external_reference_count===0; **needs_reference_review** iff no strong removal_order/removal_shipment/tracking ref; **safe_to_file** iff strong ref + product identity + clean_quantity>0 + COGS recovery (recovery>0 ∧ approved_cogs_unit>0 ∧ ¬uses_sale_price_as_amount). Weak FNSKU/date-window ledger/reimbursement candidates surfaced as **excluded from proof**, never qualify a claim. UI: new **"Decision"** badge column in `ReadyToFileView.tsx` + top **"Filing Decision"** drawer section (decision/reason, high-confidence used vs weak excluded, internal anchors excluded, human-review checklist, external-only copy block). Live verify (`kxsvedvpjldygtdbylsy`, pilot-20260615T190000Z): total **10**, **safe_to_file 10**, needs_review 0, do_not_file 0; every claim has strong Removal Order ID (1621GIL/​/x5UTzvZZK/​/571WdHlKl) + removal shipment + tracking, /x5UTzvZZK claims add 13 order-linked settlement IDs + report rows; recovery = qty × approved COGS/unit (sale price never used); weak ledger(20)+reimbursement(9-20) candidates excluded; seller_central_text_excludes_internal_uuids=**yes**, excludes_weak_refs=**yes**, uses_cogs_recovery=**yes**; tsc 0, eslint 0, smoke PASS, next build Compiled successfully; no DB/claim/edge/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; **SAFE_FILING_DECISION_MATRIX_READY=yes**, **SAFE_TO_MANUALLY_FILE_APPROVED_CLAIMS=yes**. Files: `claim-ready-to-file-queue-ui-contract.ts`, `ReadyToFileView.tsx`, `ReadyToFileDetailDrawer.tsx`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts`, `phase-claim-filing-decision-matrix-v1.ts` |
| Prior | `20260618T020000Z` — **PHASE-CLAIM-DEEP-AMAZON-REFERENCE-LEDGER-V1** PASS read-only (deep multi-source ledger + UI enrichment). Deepened `lib/claims/reference/claim-event-reference-ledger-v1.ts` to return `{ ledgers, census }`: **source census** (per-table populated/empty/missing), exact `order_id` joins now also to **amazon_settlements** + **amazon_reports_repository**, a **bounded ±45-day event-date WINDOW pass** (FNSKU/SKU) surfacing **advisory weak/ambiguous** inventory-ledger/reimbursement/transaction candidates (NOT materialized, NOT in Seller Central block), **SKU-relevance guard** on settlement/report rows, and per-claim **`source_groups[]`** (removal/shipment_tracking/inventory_ledger/transaction_settlement/reimbursement/customer_return/report_metadata) with per-source status + `candidate_count` + note + `matched_by[]` + `filing_sufficiency` (complete/sufficient_for_manual_filing/needs_reference_review). `event_date_time_filter_used` now **true (±45d)**. UI drawer rebuilt Event/Transaction References into **per-source-group cards** with status badges + muted candidate rows + **Deep reference coverage badge** + **"Not found / not applicable"** block. Census ground truth (org `…-0001`): inventory_ledger **282352** (typed event_date), transactions **600**, settlements **604883**, reimbursements **17546**, reports_repository **412645**; **amazon_customer_returns empty**; `reports_repository` table absent (uses `amazon_reports_repository`). Live verify (`kxsvedvpjldygtdbylsy`, pilot-20260615T190000Z): claims_total **10**, complete **4**, filing_sufficient **6**, needs_review **0**; **NEW real refs** — `/x5UTzvZZK`-linked claims now resolve **13 settlement IDs + 4-5 report rows** (transaction_settlement=found, report_metadata=found → complete); `1621GIL`/`/571WdHlKl` correctly not_found pre-reimbursement; totals external **88**, transaction **52**, report_metadata **16**, removal/shipment/tracking 10 each, ledger/reimbursement order-linked 0 (surfaced as window candidates); NO UUID/NO "TRID" in any Seller Central block; tsc 0, eslint 0, smoke PASS, next build Compiled successfully; no DB/claim/edge/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; **SAFE_DEEP_REFERENCE_LEDGER_READY=yes**, **SAFE_TO_FILE_CLAIMS_IN_SELLER_CENTRAL=yes**. Files: `claim-event-reference-ledger-v1.ts`, `claim-ready-to-file-queue-v1.ts`, `claim-ready-to-file-queue-ui-contract.ts`, `ReadyToFileDetailDrawer.tsx`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts`, `phase-claim-deep-amazon-reference-ledger-v1.ts`, `diag-deep-amazon-reference-census-v1.ts` |
| Prior | `20260618T012000Z` — **PHASE-CLAIM-EVENT-REFERENCE-LEDGER-AND-TRID-CORRECTION-V1** PASS read-only (reference correctness + UI). **Root issue:** Ready-to-File "Primary TRID anchor" was an internal UUID (`expected_packages.id`) and `removal_order_discrepancy` showed the `amazon_removals.id` **UUID surrogate** as removal_order_id — neither is an Amazon filing reference. Built read-only `lib/claims/reference/claim-event-reference-ledger-v1.ts` (`composeClaimEventReferenceLedgerForTrace`): resolves surrogates → REAL external refs via batched defensive joins `expected_packages → amazon_removals (order_id)`, `amazon_removal_shipments (tracking/carrier/shipment_date)`, `amazon_reimbursements/amazon_transactions/amazon_inventory_ledger` by order_id; classifies external vs internal anchors + match_reason + confidence + needs_reference_review. Wired into ready-to-file payload + client-safe `ui-contract` (`event_reference_ledger` per row + `event_reference_ledger_summary`). Seller-central composer fixed to **prefer non-UUID removal order id** + strip internal UUIDs / "Internal expected package ref" line from the Amazon-facing body. UI drawer: "Primary TRID anchor"→**"Primary reference anchor"**, new **"Event / Transaction References"** table (Source/Reference ID/Event Type/Event Date/Qty/Amount/Source Row/Match Reason/Conf.), **"References to include in Seller Central"** external-only block, collapsed **"Internal anchors (debug)"** section, **Needs-reference-review** badge. Live verify (original `kxsvedvpjldygtdbylsy`, pilot-20260615T190000Z): **10/10** claims have real external refs (Removal Order ID `1621GIL` / `/x5UTzvZZK` / `/571WdHlKl` + tracking + removal shipment), **0** reimbursement/transaction/inventory-ledger (none order-linked pre-filing; FNSKU-broad ledger join dropped as noise), **event_datetime_filter_used=NO** (reported as recommendation), **claims_still_ready=10**, **needs_reference_review=0**; **no UUID / no "TRID"** in Seller Central block, **no "Internal expected package ref"** in message body; tsc 0, lint 0, smoke PASS (new gate `has_external_source_reference` + drawer assertions + boundary guard incl. `claim-event-reference-ledger-v1`), next build Compiled successfully; no DB/claim/edge/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; **SAFE_EVENT_REFERENCE_LEDGER_READY=yes**, **SAFE_TO_FILE_CLAIMS_IN_SELLER_CENTRAL=yes**. Files: `claim-event-reference-ledger-v1.ts`, `claim-ready-to-file-queue-v1.ts`, `claim-ready-to-file-queue-ui-contract.ts`, `claim-seller-central-filing-packet-v1.ts`, `ReadyToFileDetailDrawer.tsx`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts`, `phase-claim-event-reference-ledger-and-trid-correction-v1.ts` |
| Prior | `20260618T004100Z` — **PHASE-CLAIM-READY-TO-FILE-RUNTIME-DATA-FIX-V1** PASS (runtime data binding fix). **Root cause = runtime env mismatch** (not store scope, not filters): running app `lib/supabase-server.ts` was bound via `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` to **staging `eiqfaapyumhixxoeltgu`** (3 legacy subs, 0 pilot) while the pilot lives on **original/live `kxsvedvpjldygtdbylsy`** (13 subs, 10 ready, $100.72, 96 edges) — only scripts (`ORIGINAL_*`) reached it. Diagnostic `scripts/diag-claim-ready-to-file-runtime-data-v1.ts` (read-only) proved staging composer=0 / original composer=10. Fix: re-bound `.env.local` (gitignored, NOT committed) NEXT_PUBLIC_SUPABASE_URL+SUPABASE_URL+anon+service-role+DIRECT_POSTGRES_URL staging→original (reversible; STAGING_*/ORIGINAL_* blocks intact; no PRODUCTION_* cutover; no fake data); restarted dev; added **empty-scope amber warning** in `ReadyToFileView.tsx` (0 rows shows scope/connection warning naming org `00000000-…-0001`/store `509ee1f6-…`/`kxsvedvpjldygtdbylsy`, never the green "audit clean" on empty). Live verify after restart: `GET /api/claims/center/ready-to-file?...&store_id=509ee1f6...` **200**; ready **10**, blocked **0**, $**100.72**, families 6+4, Amazon Case ID missing **10**; api/client before=0 / after=10; tsc 0, lint 0, smoke PASS, next build Compiled successfully; no DB/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; SAFE_READY_TO_FILE_RUNTIME_DATA_FIXED=**yes**, SAFE_TO_MANUALLY_FILE_FROM_UI=**yes**. **Local dev now reads original/live `kxsvedvpjldygtdbylsy`.** Files: `.env.local`, `ReadyToFileView.tsx`, `diag-claim-ready-to-file-runtime-data-v1.ts` |
| Prior | `20260618T002700Z` — **PHASE-CLAIM-READY-TO-FILE-UI-FINALIZE-V2** PASS (UI finalize + build fix + route/nav verification). Route `/claim-center/ready-to-file` verified (page + `GET /api/claims/center/ready-to-file`); **exact nav = Claim Center → Filing & recovery → Ready to File** (`CLAIM_CENTER_FILING_RECOVERY_NAV` first item + on-page `CLAIM_CENTER_FINANCIAL_NAV` strip). Build error root cause unchanged (client graph → node:fs via queue→trid-trace→live-reference(-audit)→7h-discovery), already fixed by self-contained `claim-ready-to-file-queue-ui-contract.ts` (0 imports). UI finalize: added exact warning banner "MENORIX does not submit to Amazon. Use this page to manually file in Seller Central and copy the Amazon Case ID back."; 5th summary card relabeled **Amazon Case ID missing**; Case ID recording note → "Save/recording will be enabled by the governed manual filing status phase". Verify: next build **Compiled successfully (21.3s)**, tsc 0, eslint 0, smoke PASS (banner+card+note+boundary guard); **10 ready / 0 blocked / $100.72 / families 6+4 / scanner-only 0 / simulated case IDs 0**; per_claim ready/reference/filing matrices emitted (all 10 pass 11 gates); seller-central copy + guarded case-id sections verified; no node:fs/playwright in app bundle; no claim/edge/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; SAFE_READY_TO_FILE_UI_READY=**yes**, SAFE_TO_MANUALLY_FILE_FROM_UI=**yes**. Files: ReadyToFileView.tsx, ReadyToFileDetailDrawer.tsx, smoke-phase-claim-ready-to-file-queue-ui-v1.ts |
| Prior | `20260617T235500Z` — **PHASE-CLAIM-READY-TO-FILE-UI-CLIENT-BUNDLE-FIX-V1** PASS (UI build fix only; client/server boundary). Root cause: `/claim-center/ready-to-file` client bundle pulled **node:fs** via `ReadyToFileView → claim-ready-to-file-queue-v1 → trid-reference-trace-matrix-v1 → claim-live-reference-api-completion(-audit) → claim-7h-source-api-file-reference-discovery (node:fs)`; residual `import type` edge from the contract to seller-central + stale `.next/dev` cache. Fix: **`claim-ready-to-file-queue-ui-contract.ts` rewritten fully self-contained (zero imports — not even `import type`)**; seller-central packet/group shapes duplicated as structurally-compatible plain types; server composer keeps server-only imports + assigns by structural typing; client view/drawer import only React + ui-contract; page stays Server Component (store stays client-scoped via existing `/api/claims/center/ready-to-file`). **Static guard** added to smoke (fails if any client file/contract imports `claim-ready-to-file-queue-v1`/`trid-reference-trace-matrix-v1`/`claim-live-reference-api-completion-v1`/`-audit-v1`/`claim-7h-source-api-file-reference-discovery-v1`/`node:fs`/`playwright`; contract must import nothing). Verify: `next build` **Compiled successfully** (105 pages, route present), tsc exit 0, eslint 0, smoke PASS, **10 ready / $100.72**, no claim/edge/Amazon/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147]; SAFE_READY_TO_FILE_UI_BUILD_FIXED=**yes**, SAFE_TO_MANUALLY_FILE_FROM_UI=**yes**. Files: `claim-ready-to-file-queue-ui-contract.ts`, `smoke-phase-claim-ready-to-file-queue-ui-v1.ts` |
| Prior | `20260617T233450Z` — **PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1** PASS (operational UI build + read-only correctness audit; new page `/claim-center/ready-to-file` under Filing & Recovery; read-model `claim-ready-to-file-queue-v1.ts` + API + view + detail drawer; **10/10 ready, 0 blocked**, total recovery **$100.72**, families 6+4; **11 audit gates** all pass per ready row [family/ not-scanner-or-ocr / deterministic graph / cogs / recovery / trid anchor / family-removal-ref / evidence / no-fake-scan / no-sim-case-id / no-sale-price]; scanner_only=0, simulated_case_ids=0, fake_scan_codes=0, sale_price_as_amount=0; Seller Central copy section (subject/body/amount/qty/reference-block/attachments + Copy buttons) verified; Case ID recording section disabled-by-default + guarded + never-submits verified; route_added + nav_added all true; no claim/edge/Amazon/AI/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147 unchanged]; build+smoke PASS; SAFE_READY_TO_FILE_UI_READY=**yes**, SAFE_TO_MANUALLY_FILE_FROM_UI=**yes**) |
| Prior | `20260617T212340Z` — **PHASE-CLAIM-SELLER-CENTRAL-FILING-PACKET-V1** PASS read-only (10/10 manual filing packets generated, **0 blocked**; deterministic subjects+bodies, no AI, human_review_required; recovery_value = clean_qty × approved COGS/unit verified per packet (sale price never used); references resolved per packet [FNSKU/SKU, expected_package_id/TRID, removal_order_id, removal_shipment_id, tracking, source rows]; **grouping insight: removal_order_id shared → 3 reference-safe grouped cases (1621GIL×4, /x5UTzvZZK×4, /571WdHlKl×2) cover all 10**; record-back fields empty placeholders (no simulated case IDs); evidence packet path + attachment matrix per packet; no DB/claim/edge/Amazon/AI/scanner mutation [subs 13, cases 22, lines 22, cands 9155, edges 147 unchanged]; build+smoke PASS; SAFE_SELLER_CENTRAL_FILING_PACKETS_READY=**yes**, SAFE_TO_MANUALLY_FILE_IN_SELLER_CENTRAL=**yes**) |
| Prior | `20260617T211458Z` — **PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1** re-verify PASS read-only (post reference-materialization-execute; production pre-filing readiness **100%**, **16/16** checks; subs 10/10, families 6+4, cogs 6/6·10/10, recovery 10/10 = **$100.72** = latest verified, sold/fees/settlement 10/10, reimb Unknown 0/10 never $0, trid 10/10, **96 edges** avg 9.6 / 0 ambiguous / 0 missing, per-submission edge matrix visible 10/10/9/9/9/10/10/10/9/10, governed_execute_v1_status=**approved**, 10 filing packets, UI verified, playwright=local PDF only; no claim/Amazon/scanner mutation [subs 13/13, cases 22/22, lines 22/22, candidates 9155/9155]; build+smoke PASS; SAFE_CLAIM_PILOT_PREFILING_PRODUCTION_READY=**yes**, SAFE_TO_WAIT_FOR_REAL_AMAZON_CASE_IDS=**yes**) |
| Prior | `20260619T083000Z` — **PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1** PASS (governed write EXECUTED; `APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1=yes`; idempotent refresh: planned 112 → inserted **0** / skipped_duplicate **112**, edges 96/96 unchanged; trid 10/10, 0 ambiguous/missing, 0 dupes; no claim/Amazon/scanner mutation; build+smoke PASS; SAFE_REFERENCE_MATERIALIZATION_COMPLETE=**yes**) |
| Prior | `20260619T082000Z` — **PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1** PASS read-only (production pre-filing readiness **100%**, 14/14 checks; subs 10/10, cogs 6/6, recovery 10/10 = **$100.72**, sold/fees/settlement 10/10, reimb Unknown 0/10, trid 10/10, 96 edges, 10 filing packets, UI verified, playwright=local PDF only; no claim/Amazon/scanner mutation; build+smoke PASS; SAFE_CLAIM_PILOT_PREFILING_PRODUCTION_READY=**yes**, SAFE_TO_WAIT_FOR_REAL_AMAZON_CASE_IDS=**yes**) |
| Prior | `20260619T081000Z` — **PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1** BLOCKED-AT-GATE (executor built + read-only gate-check PASS; `APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1=no`; prereqs trid 10/10, 0 ambiguous/missing, schema anchor present; pilot edges 96/96 unchanged, 0 dupes; no claim/Amazon/scanner mutation; build+smoke PASS; SAFE_REFERENCE_MATERIALIZATION_COMPLETE=**no**) |
| Prior | `20260619T080000Z` — **PHASE-PRODUCT-COGS-WRITE-PERSISTENCE-FIX-AND-EXECUTE-V1** PASS (final audit read path closed in `claim-money-lane-recovery-audit-v1.ts`; resolver=singleton row `5ad12e20…`; reread-by-id confirmed 6/6; accepted 6/0; cogs_after 6/6; recovery 10/10; SAFE_PRODUCT_COGS_WRITE_COMPLETE=**yes**; SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS=**yes**) |
| Prior | `20260619T075000Z` — **PHASE-TRID-REFERENCE-TRACE-MATRIX-V1** PASS read-only (per-submission trace; trid 10/10, 96 edges, avg 9.6, 0 ambiguous, 0 missing; single TRID anchor=EP + many supporting edges; event date/time NOT a filter; VRET≠TRID; no writes; SAFE_TRID_TRACE_VISIBLE=**yes**) |
| Prior | `20260619T074000Z` — **PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V2** PASS read-only (cogs 10/10, recovery 10/10, total_recovery **$100.72**, reimb Unknown 0/10 never $0; no writes; SAFE_MONEY_LANE_PREVIEW_READY=**yes**) |
| Prior | `20260619T073000Z` — **PHASE-PRODUCT-COGS-WRITE-PERSISTENCE-FIX-V1** PASS (formalized fix; `resolveCanonicalWorkspaceSettingsRowForOrg`; resolver=singleton row `5ad12e20…`; re-read-by-id confirmed 6/6; recovery 10/10; SAFE_PRODUCT_COGS_WRITE_COMPLETE=**yes**) |
| Prior | `20260619T070000Z` — **PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V2** PASS (production write COMPLETE; cogs_overrides 6/6; recovery 10/10; SAFE_PRODUCT_COGS_WRITE_COMPLETE=**yes**; fixed workspace_settings `.eq(org)` singleton bug) |
| Prior | `20260619T064000Z` — **PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1** re-verify PASS (sourceNote 6/6 fixed; SAFE_TO_EXECUTE=**yes**; cogs_overrides still 0/6 pre-execute) |
| Prior | `20260619T062000Z` — **PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V2** BLOCKED-AT-GATE (SAFE_TO_EXECUTE=no; sourceNote 0/6; no execute, no writes) |
| Prior | `20260619T060000Z` — **PHASE-LIVE-REFERENCE-API-COMPLETION-V1** PASS (4 read-only/dry-run endpoints; TRID 10/10; reimb match blocked 10/10; no writes) |
| Prior | `20260619T051500Z` — **PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1** PASS read-only (unitCost 6/6, sourceNote 0/6) |
| Prior | `20260619T040000Z` — **PHASE-CLAIM-AI-ASSISTED-OPERATIONS-PLAN-V1** PASS |
| Prior | `20260619T030000Z` — **PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-AUDIT-V1** PASS |
| Prior | `20260617T065036Z` — **PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1** plan-only BLOCKED |
| Prior | `20260618T080000Z` — **PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1** plan-only BLOCKED |
| Prior | `20260618T070000Z` — **PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V1** BLOCKED (COGS 0/6) |
| Prior | `20260617T062123Z` — **PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1** plan-only PASS |
| Prior | `20260618T050000Z` — **PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1** PASS |
| Prior | `20260618T040000Z` — **PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1** PASS |
| Prior | `20260618T030000Z` — **PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-V1** guarded UI PASS (dry-run only) |
| Prior | `20260618T010000Z` — **PHASE-CLAIM-MONEY-LANE-PREVIEW-V2-PROFIT-LOSS-ANALYSIS** PASS |
| Prior | `20260617T002855Z` — **PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1** re-verify PASS (per-submission preview; tracking banner) |
| Prior | `20260617T000136Z` — **PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-PLAN-V1** re-verify PASS (8 prereqs; pilot 10/10) |
| Prior | `20260616T235630Z` — **PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1** initial PASS |
| Prior | `20260617T230000Z` — **PHASE-CLAIM-MONEY-LANE-PREVIEW-V1** PASS (sold/fees 10/10; COGS 0/10) |
| Prior | `20260617T220000Z` — **PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-PLAN-V1** LOCKED |
| Prior | `20260616T233100Z` — **PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1** PASS planning contract |
| Prior | `20260616T231600Z` — **PHASE-PRODUCT-COGS-AUDIT-V1** PASS read-only (0/10 approved COGS; spine not migrated) |
| Prior | `20260617T210000Z` — **PHASE-CLAIM-REIMBURSEMENT-TRACKING-NAV-DEDUP-UX-POLISH-V1** PASS (single More menu entry under Filing & recovery) |
| Prior | `20260617T200000Z` — **PHASE-CLAIM-VRET-SLIP-REFERENCE-MAPPING-AUDIT-V1** PASS read-only (Vendor Return ID; example not in DB) |
| Prior | `20260617T190000Z` — **PHASE-CLAIM-MONEY-LANE-SOURCE-DISCOVERY-V1** PASS (sold price/fees 10/10; COGS 0/10) |
| Prior | `20260617T180000Z` — **PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MAIN-VISIBILITY-REPAIR-V2** committed `d2f7faa` |
| Prior | `20260617T160100Z` — **PHASE-CLAIM-MONEY-LANE-RECOVERY-AUDIT-V1** PASS (COGS spine blocker) |
| Prior | `20260617T160000Z` — **PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MAIN-REPAIR-V1** nav discoverability PASS |
| Prior | `20260617T150000Z` — **PHASE-CLAIM-MAIN-BRANCH-UI-PARITY-AUDIT-V1** — UI not on committed main |
| Prior | `20260617T140000Z` — **PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1** verified PASS (local worktree) |
| Prior | `20260617T130000Z` — **PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1** re-verify PASS |
| Prior | `20260617T120000Z` — **PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1** read-only IMPLEMENTED |
| Prior | `20260617T040100Z` — **PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1** read-only PASS (10/10) |
| Prior | `20260617T030200Z` — **PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1** PASS (10 inserts) |
| Prior | `20260617T020100Z` — **PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1** read-only BLOCKED |
| Prior | `20260616T230000Z` — **PHASE-7H pilot reference edge materialization ORIGINAL EXECUTE** PASS (96 edges) |
| Prior | `20260616T210000Z` — **PHASE-7H pilot reference edge materialization ORIGINAL EXECUTE** BLOCKED (0 edges) |
| Prior | `20260616T150000Z` — **PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1** execute BLOCKED (0 inserts) |
| Prior | `20260616T140000Z` — **PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AFTER-7H-V1** read-only FAIL (7H not on original) |
| Prior | `20260616T130000Z` — **PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1** DRY-RUN READY (execute blocked) |
| Prior | `20260616T120000Z` — **PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1** UI IMPLEMENTED (TRID gate blocked) |
| Prior | `20260615T091500Z` — **PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1** |
| Prior | `20260615T080000Z` — **PHASE-CLAIM-EVIDENCE-PACKET-V1-PLAN** |
| Prior | `20260615T070000Z` — **PHASE-CLAIM-CANDIDATE-REVIEW-UI-ORIGINAL-PILOT-V1** |
| Prior | `20260614T210000Z` — **PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1** |
| Prior | `20260614T200000Z` — **PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1** |
| Prior | `20260614T190000Z` — **PHASE-CLAIM-CANDIDATE-EMIT-STAGING-ROLLBACK-DRILL-V1** |
| Prior | `20260614T180000Z` — **PHASE-CLAIM-CANDIDATE-EMIT-STAGING-WAVE2-V1** |
| Prior | `20260614T170000Z` — **PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1** |
| Prior | `20260614T160000Z` — **PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-POST-VERIFY-V1** |
| Prior | `20260614T101000Z` — **PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1** |
| Prior | `20260614T091500Z` — **PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-READMODEL-V1** (re-verify) |
| Prior | `20260614T084406Z` — **PHASE-PIM-PRODUCT-API-SMALL-APPLY-BATCH-V1** |
| Prior | `20260614T090000Z` — **PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1** (re-verify) |
| Prior | `20260614T081853Z` — **PHASE-PIM-PRODUCT-UPDATE-READINESS-SMOKE-V1** |
| Prior | `20260614T081500Z` — **PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-READMODEL-V1** (re-verify) |
| Prior | `20260614T080000Z` — **PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1** (re-verify) |
| Prior | `20260614T073235Z` — **PHASE-PIM-PRODUCT-UPDATE-AFTER-CANCEL-UI-VERIFY-V1** |
| Prior | `20260614T070500Z` — **PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1** (re-verify) |
| Prior | `20260614T070615Z` — **PHASE-PIM-CANCEL-ORPHAN-PRODUCT-ENRICHMENT-JOB-V1** |
| Prior | `20260614T014500Z` — **PHASE-PIM-PRODUCT-UPDATE-JOB-STATE-UI-UNIFY-FIX-V1** |
| Prior | `20260614T001138Z` — **PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1-ORIGINAL-APPLY** |
| Prior | `20260614T011500Z` — **PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1** (re-verify) |
| Prior | `20260613T210000Z` — **PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-CONTRACT-V1** |
| Prior | `20260613T202000Z` — **PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1** |
| Prior | `20260613T194249Z` — **PHASE-PRODUCTION-REMOVAL-SYNC-DEDUPE-REBUILD-V1** |
| Prior | `20260613T193247Z` — **PHASE-AMAZON-REIMBURSEMENTS-ORIGINAL-BACKFILL-RETRY-V1** |
| Prior | `20260613T091402Z` — **PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1-IMPLEMENT** |
| Prior | `20260613T084554Z` — **PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-FIX-V1-ORIGINAL-APPLY** |
| Prior | `20260613T140000Z` — **PHASE-CLAIM-CANDIDATE-EMIT-APPROVAL-CONTRACT-V1** |
| Prior | `20260613T071827Z` — **PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-FIX-V1** |
| Prior | `20260613T070927Z` — **PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1** (staging re-verify) |
| Prior | `20260613T131500Z` — **PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1** |
| Prior | `20260613T121500Z` — **PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1** (full 41-family re-execute) |
| Prior | `20260613T062152Z` — **PHASE-SHIPMENT-ENTRY-PRODUCT-LINKAGE-ALL-PATHS-ORIGINAL-VERIFY-V1** |
| Prior | `20260613T061122Z` — **PHASE-SHIPMENT-ENTRY-PRODUCT-LINKAGE-ALL-PATHS-PARITY-FIX-V1** |
| Prior | `20260613T054315Z` — **PHASE-ORIGINAL-RUNTIME-ENV-BIND-VERIFY-V1** |
| Prior | `20260613T053153Z` — **PHASE-ORIGINAL-PRODUCT-NO-LINK-EMERGENCY-READONLY-DIAGNOSE-V1** |
| Prior | `20260613T052709Z` — **PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-DRYRUN-V1** |
| Prior | `20260613T052400Z` — **PHASE-ORIGINAL-PRODUCT-LINK-NO-LINK-MINIMAL-FIX-V1** |
| Prior | `20260613T051948Z` — **PHASE-ORIGINAL-PRODUCT-LINK-NO-LINK-REGRESSION-AUDIT-V1** |
| Prior | `20260613T120000Z` — **PHASE-FIRST-CLAIM-PREVIEW-READMODEL-MVP-V1** (re-verify) |
| Prior | `20260613T050302Z` — **PHASE-CLAIM-V3-DRYRUN-SOURCE-AND-LINKAGE-GATED-V1** |
| Prior | `20260613T045948Z` — **PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-RESOLUTION-PLAN-V1** |
| Prior | `20260613T110000Z` — **PHASE-FIRST-CLAIM-PREVIEW-READMODEL-MVP-V1** |
| Prior | `20260613T044257Z` — **PHASE-PRODUCT-LINKAGE-HEALTH-AND-CLAIM-BLOCKER-READMODEL-V1** |
| Prior | `20260613T090400Z` — **PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1** |
| Prior | `20260613T042120Z` — **PHASE-RAW-AMAZON-TABLE-NAMING-AND-CLAIM-REIMBURSEMENTS-AUDIT-V1-EXECUTE** |
| Prior | `20260613T041935Z` — **PHASE-RLS-POLICY-BATCH-CLAIM-AND-AMAZON-REIMBURSEMENTS-V1** |
| Prior | `20260613T040815Z` — **PHASE-LIVE-TABLE-RLS-AND-ORG-SCOPE-AUDIT-V1** |
| Prior | `20260613T080000Z` — **PHASE-PRODUCT-COST-MANUAL-INPUT-PLACEHOLDER-CONTRACT-V1** |
| Prior | `20260613T040520Z` — **PHASE-RAW-AMAZON-TABLE-NAMING-AND-CLAIM-REIMBURSEMENTS-AUDIT-V1** |
| Prior | `20260613T040235Z` — **PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1** |
| Prior | `20260613T071000Z` — **PHASE-CLAIM-FAMILY-V3-READMODEL-AND-AI-OPTIONAL-CONTRACT-V1** |
| Prior | `20260613T033358Z` — **PHASE-POST-FIX-DATA-FRESHNESS-AND-EXPECTED-PACKAGES-VERIFY-V1** |
| Prior | `20260613T040000Z` — **PHASE-AMAZON-FEE-ADJUSTED-REIMBURSEMENT-ESTIMATE-MODEL-V1** |
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

**Claim V3 dryrun (post linkage gate):**

```text
PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-DRYRUN-V1
Mode: staging dry-run execute with preimage only (max 500 rows/table).
Priority wave 1 (zero ambiguous): amazon_removals, amazon_removal_shipments, expected_packages.
Priority wave 2 (exclude ambiguous): amazon_inventory_ledger, amazon_settlements.
Do NOT update claim_candidates in wave 1.
Require Maysam approval + rollback.sql per table.
Evidence: phase-product-linkage-operational-rows-resolution-plan-v1/20260613T045948Z/
```

Prior: PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1 (complete)

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
