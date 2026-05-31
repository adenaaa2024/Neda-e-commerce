# History pointers — authoritative

## Canonical master

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Latest append | `20260614T120000Z` — **ARCHITECTURE-CORRECTION-HISTORY-MEMORY-SYNC** |
| Prior | `20260613T120000Z` — PRODUCT-CORE-PROTECTION-HISTORY-MEMORY-UPDATE |

## Scanner / Return / Claims (corrected + repaired)

| Doc | Topic |
|-----|-------|
| [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md) | Authoritative architecture; bulk/orphan hard-delete complete |
| [EXPECTED_ALLOCATION_MODEL.md](EXPECTED_ALLOCATION_MODEL.md) | Two-grain allocation model |
| [SCANNER_STATE.md](SCANNER_STATE.md) | Operator-mobile staging state |
| [CLAIM_ARCHITECTURE.md](CLAIM_ARCHITECTURE.md) | Claims layers + queue safety |

## Product Core (protected)

| Doc | Topic |
|-----|-------|
| [PRODUCT_CORE_ARCHITECTURE.md](PRODUCT_CORE_ARCHITECTURE.md) | Protected backbone; change gate; completion estimates |
| [FORBIDDEN_ACTIONS.md](FORBIDDEN_ACTIONS.md) | Product Core + scanner/return forbidden actions |
| [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) | PC Phase 01 under Product Core |

## Git refs

| Ref | SHA |
|-----|-----|
| `main` | `4402064` |
| `feature/phase1-latest-stash-land` | `9a5cda8` (not merged) |

## Exact next prompt

```text
INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION
```

**Memory sync:** `architecture-correction-history-memory-sync/20260614T120000Z/`

## Paired-update law

Append-only history + `.cursor/.ai-memory` updated together.
