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

- [ ] PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1 (capture per-family amount basis COGS vs latest-sale-net vs business loss into governed `module_configs`; flips 10 pilot claims `needs_policy_confirmation → safe_to_file`)
- [ ] PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1 (convert the 31 separate-claim suggestions into real per-family claim candidates)
- [ ] PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 (operator files in Seller Central via `/claim-center/ready-to-file`, records real Amazon Case IDs; governed write)

## Done

- [x] PHASE-CLAIM-FAMILY-AWARE-RECOVERY-MATCHING-V2 `20260618T140000Z` (family classifier + `CLAIM_AMOUNT_POLICY_MATRIX` + `computeFamilyAwareRecovery`; cross-family credits excluded; 3 amount bases; pilot 10/10 needs_policy_confirmation; 31 separate-claim suggestions; drawer "Recovery Gap / Claim Amount Policy" + separate-opportunities)
- [x] PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE-AND-CLAIM-FAMILY-MAP-V1 `20260618T053000Z` (17-source coverage matrix + claim-family map + `/claim-center/data-coverage`; RecoveryGap files_checked/missing_files_or_api)
- [x] PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1 `20260617T233450Z` (page `/claim-center/ready-to-file`; 10/10 ready; 11 audit gates; Seller Central copy + guarded Case ID recording)
- [x] PHASE-CLAIM-SELLER-CENTRAL-FILING-PACKET-V1 `20260617T212340Z` (10/10 packets, 0 blocked)
- [x] Architecture correction memory sync `20260531T120000Z`
- [x] Wave2 rollback PASS documented

## Forbidden

[`FORBIDDEN_ACTIONS.md`](FORBIDDEN_ACTIONS.md)
