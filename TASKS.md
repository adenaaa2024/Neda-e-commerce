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
- [ ] **PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1** — surface per-claim missing-basis + configured threshold + origin matrix in the Ready-to-File drawer/table (read-only display) (NEXT)
- [ ] **PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1** — import Transaction View / settlement `Order` rows (or SP-API settlement report) for the 7 SKUs (`I6-VR35-FSXQ`×5, `WD-VY8Z-CZ3F`, `2H-7ZAX-Z2IP`) with no loaded sale; then re-run backfill to lift coverage above 3/10
- [ ] **PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-EXECUTE-V1** — approve + materialize writeable previews into real per-family claim_candidates (NEXT)
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
