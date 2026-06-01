# History pointers — authoritative

## Canonical master

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Latest append | `20260617T120000Z` — **PHASE1-DEMO-READY-HISTORY-MEMORY-SYNC** |
| Prior | `20260616T120000Z` — PHASE1-PRE-NEDA-MERGE-HISTORY-MEMORY-SYNC |

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

```text
PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE
```

**Memory sync:** `phase1-demo-ready-history-memory-sync/20260617T120000Z/`

## Paired-update law

Append-only history + `.cursor/.ai-memory` updated together.
