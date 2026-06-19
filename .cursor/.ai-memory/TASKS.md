# Tasks — memory board

Synced with [NEXT_ACTIONS.md](NEXT_ACTIONS.md) and root [`../TASKS.md`](../TASKS.md).

**Branch:** `feature/phase1-latest-stash-land` @ `c78fbb8`

## P0 — Scanner / return remediation

- [ ] BULK-RETURN-ITEMS-PROVENANCE-READONLY
- [ ] BULK-RETURN-ITEMS-QUARANTINE-APPROVAL-AND-EXECUTE
- [ ] CLAIM-RETURNS-WORK-QUEUE-PHYSICAL-ANCHOR-GATE

## P0 — Product sheet (after scanner P0)

- [ ] PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION
- [ ] PRODUCT-SHEET-IMPORT-MAX-25-SAMPLE-WAVE

## P1 — Claim pilot filing (active)

- [x] PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1 `20260618T220000Z` (governed write to `workspace_settings.module_configs.claims.amount_basis_policy`; removal families = cogs_recovery; pilot 10/10 flipped `needs_policy_confirmation → safe_to_file`; total SC $100.72 / confirmed $0.00 / open gap $100.72; weak 152 + separate 31 unchanged; no claim mutation; SAFE_CLAIM_AMOUNT_POLICY_CONFIRMED=yes)
- [x] PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1 `20260618T233000Z` (preview-only: 152 cross-family suggestions → 72 de-dup per-family previews across 6 families, 10 writeable; 0 written — write approval absent; removal pilot unchanged $100.72; generator contract + API + approval-gated write + UI; SAFE_SEPARATE_FAMILY_GENERATORS_READY=yes, SAFE_TO_PROMOTE_NEW_FAMILY_CANDIDATES=no)
- [x] PHASE-CLAIM-FAMILY-SEPARATION-UI-CLEANUP-V1 `20260618T240000Z` (Ready-to-File drawer rebuilt into 4 clean sections: current evidence / recovery gap / excluded cross-family (collapsed) / separate opportunities; `buildReferenceBlockText` removal-focused — Seller Central copy no longer leaks cross-family reimbursement/settlement/ledger refs; table family-aware + new cols/badges; safe_to_file 10, $100.72 open, seller_central_copy_excludes_cross_family=yes; no DB/claim/Amazon/scanner change; SAFE_FAMILY_SEPARATION_UI_CLEAR=yes)
- [x] PHASE-CLAIM-AMOUNT-BASIS-LATEST-SALE-NET-POLICY-FIX-V1 `20260618T250000Z` (governed write flips removal families `cogs_recovery → latest_sale_net`; Seller Central expected = (latest_sold_price − amazon_fees) × qty; COGS/settlement internal only; open = expected − confirmed; unloaded sale price → expected/open UNKNOWN, no COGS fallback. Drawer "Financial Breakdown" 2 cards + basis badge; table Expected reimb/Confirmed/Open claim/Internal COGS/Profit-loss cols. Live: old_cogs $100.72 → expected ≈$59–61 (7/10 lack sale price → UNKNOWN), confirmed $0, internal COGS $100.72, safe_to_file 10, basis=latest_sale_net & SC≠COGS, weak 152/separate 31 unchanged, no claim mutation; SAFE_AMOUNT_BASIS_LATEST_SALE_NET_CONFIRMED=yes, SAFE_READY_TO_FILE_FINANCIAL_UI_CLEAR=yes, SAFE_TO_FILE_APPROVED_REMOVAL_FAMILIES=yes)
- [ ] PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1 (import Transaction View / settlement `Order` rows or SP-API settlement report for the 7 SKUs with no loaded sale at/before the removal event, then re-run the latest-sale-net backfill to lift coverage above 3/10)
- [ ] PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-EXECUTE-V1 (approve + materialize writeable previews into real per-family claim_candidates)
- [ ] PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 (operator files in Seller Central via `/claim-center/ready-to-file`, records real Amazon Case IDs; governed write)

## Done

- [x] PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1 `20260619T210000Z` (read-only UI clarity; zero-import `computeRemovalOriginReason` + `RemovalOriginInputs` on `ReadyToFileRow`; SELECT-only `claim-removal-origin-basis-v1.ts` loader; table +8 origin columns; drawer "Why this claim exists" section + badges; live verify all 10 valid_missing, ages 33–84, received 0/10, threshold 14; ui_origin_reason_verified=yes; no DB/claim/Amazon/scanner/math change; SAFE_REMOVAL_ORIGIN_REASON_UI_READY=yes, SAFE_TO_IMPORT_MISSING_SALE_PRICE_SOURCES=yes)
- [x] PHASE-CLAIM-REMOVAL-MISSING-BASIS-AUDIT-V1 `20260619T200000Z` (read-only origin + missing-threshold audit; threshold 14 governed; all 10 valid missing candidates; ui_origin_reason_verified=no → next phase)
- [x] PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1 `20260619T193000Z` (deterministic resolver + drift fix + governed cache write; coverage 3/10; total expected/open $57.10; drift_fixed yes)
- [x] PHASE-CLAIM-FAMILY-AWARE-RECOVERY-MATCHING-V2 `20260618T140000Z` (family classifier + `CLAIM_AMOUNT_POLICY_MATRIX` + `computeFamilyAwareRecovery`; cross-family credits excluded; 3 amount bases; pilot 10/10 needs_policy_confirmation; 31 separate-claim suggestions; drawer "Recovery Gap / Claim Amount Policy" + separate-opportunities)
- [x] PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE-AND-CLAIM-FAMILY-MAP-V1 `20260618T053000Z` (17-source coverage matrix + claim-family map + `/claim-center/data-coverage`; RecoveryGap files_checked/missing_files_or_api)
- [x] PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1 `20260617T233450Z` (page `/claim-center/ready-to-file`; 10/10 ready; 11 audit gates; Seller Central copy + guarded Case ID recording)
- [x] PHASE-CLAIM-SELLER-CENTRAL-FILING-PACKET-V1 `20260617T212340Z` (10/10 packets, 0 blocked)
- [x] Architecture correction memory sync `20260531T120000Z`
- [x] Wave2 rollback PASS documented

## Forbidden

[`FORBIDDEN_ACTIONS.md`](FORBIDDEN_ACTIONS.md)
