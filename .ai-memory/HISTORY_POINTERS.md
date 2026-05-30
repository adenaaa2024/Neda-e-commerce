# History pointers — authoritative

## Canonical master

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Latest append | `20260609T140000Z` — **HISTORY-MEMORY-ALIGN-AFTER-PHASE1-CENSUS** |
| Prior | `20260608T120000Z` — **SUPERSEDED** for original parity BLOCKED claim |

## Product spine + DB parity

| Run | Path | Status |
|-----|------|--------|
| Staging true linkage | `product-spine-view-linkage-staging-execute/20260530T171500Z/` | **PASS** |
| Browser smoke | `product-spine-scanner-browser-smoke-1552698729/` | **PASS** (`1552698729`, `X003S8RCBH`) |
| Staging slip/view | `db-parity-view-linkage-slip-columns-staging-execute/20260529T231120Z/` | **PASS** |
| Original slip/view | `db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/` | **PASS** |
| Original product spine view DDL | `product-spine-view-linkage-original-approval.md` | **PENDING** |

**CORRECTED:** Original slip/view was **BLOCKED** in `20260608T120000Z` — now **PASS** `234437Z`.

## Phase 1 census modules

| Doc | Topic |
|-----|-------|
| [EXPECTED_ALLOCATION_MODEL.md](EXPECTED_ALLOCATION_MODEL.md) | Allocation census complete; delete release gap |
| [UNDO_AUDIT_ARCHITECTURE.md](UNDO_AUDIT_ARCHITECTURE.md) | Cascade/undo draft not applied |
| [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md) | Verify gate align; burn-in PASS; +6 EP |
| [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) | Parity + pending original view DDL |
| [SCANNER_STATE.md](SCANNER_STATE.md) | True linkage + browser smoke PASS |

## Key evidence

| Run | Path |
|-----|------|
| Original parity execute | `db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/` |
| Staging true linkage | `product-spine-view-linkage-staging-execute/20260530T171500Z/` |
| EP backfill dry-run | `original-product-map-expected-packages-backfill-dryrun/<run_id>/` |
| Verify gate align | `removal-automation-verify-gate-align/` |

**Memory sync:** `history-memory-align-after-phase1-census/20260609T140000Z/`

## Paired-update law

Append-only history + `.ai-memory` updated together.
