# History pointers — authoritative

## Canonical master

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Latest append | `20260611T210000Z` — **PHASE-MENORIX-CLAIM-CENTER-SHELL** |
| Prior | `20260611T193000Z` — PHASE-CLAIM-CENTER-V1-READ-IMPL-PROFESSIONAL-UX |

## Phase1 demo + merge

| Doc | Topic |
|-----|-------|
| [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md) | Demo readiness · merge contract · remaining blockers |
| [AUTOMATION_API_CENTER.md](AUTOMATION_API_CENTER.md) | Automation complete |
| [NEDA_HANDOFF.md](NEDA_HANDOFF.md) | Neda merge must preserve scanner UX + allocation rules |

## Git refs

| Ref | SHA |
|-----|-----|
| `main` | `4402064` |
| `feature/phase1-latest-stash-land` | `999f765` (not merged) |

## Exact next prompt

**Claims track:**

```text
PHASE-CLAIM-CENTER-V1-WRITE-ACTIONS-GATED
```

Prior: PHASE-MENORIX-CLAIM-CENTER-SHELL (complete)

**RLS track (parallel):**

```text
PHASE-8R-RLS-IMPORT-ROUTE-ORG-GUARD-STAGING
```

**RLS parity audit:** `phase-rls-original-staging-parity-audit/20260605T120000Z/` — SAFE_TO_APPLY_RLS_FIX_STAGING **no** · SAFE_TO_APPLY_RLS_FIX_ORIGINAL **no**

**Memory sync:** `phase1-demo-ready-history-memory-sync/20260617T120000Z/`

## Paired-update law

Append-only history + `.cursor/.ai-memory` updated together.
