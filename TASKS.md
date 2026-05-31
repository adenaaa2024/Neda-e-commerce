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
