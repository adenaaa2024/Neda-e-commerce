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

- [ ] **PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1** — capture per-family amount basis (COGS vs latest-sale-net vs business loss) into governed `module_configs`; flips 10 pilot claims `needs_policy_confirmation → safe_to_file`
- [ ] **PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1** — convert the 31 separate-claim suggestions into real per-family claim candidates
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
