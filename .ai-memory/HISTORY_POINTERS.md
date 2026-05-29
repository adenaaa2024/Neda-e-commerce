# History pointers — authoritative

## Canonical master

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Latest append | `20260528T220000Z` — **ORIGINAL DATA WAVE RESOLVER FINISH VERIFY** |
| Prior | `20260601T120000Z` — PHASE1 DELIVERY STATUS UPDATE |

## Phase1 delivery modules

| Doc | Topic |
|-----|-------|
| [SCANNER_STATE.md](SCANNER_STATE.md) | Item-level RI; Neda smoke PASS; PR pending |
| [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md) | Staging 6175 EP / 6099 resolved |
| [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) | Schema wave 4/4 PASS; data wave pending |
| [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) | claim_lines + TRID dryruns PASS; not applied |

## Key audit evidence

| Run | Path |
|-----|------|
| Commit push 51bc597 | `commit-push-item-level-repair-and-phase1/20260528T191934Z/` |
| PR phase1 / Neda smoke | `pr-phase1-item-level-repair/20260531T150000Z/` |
| Original schema 4/4 | `original-parity-phase1-wave-schema-execute/20260530T180000Z/` |
| Original data execute | `original-parity-phase1-wave-data-execute/20260528T201200Z/` |
| Resolver finish verify | `original-parity-wave-data-resolver-finish-verify/20260528T220000Z/` |
| Original data plan | `original-parity-phase1-wave-data-plan/20260530T190000Z/` |
| EP resolver 6099/6175 | `main-product-linkage-expected-packages-resolver-execute/20260528T181500Z/` |
| Claim lines dry-run | `claim-return-line-foundation-schema-dryrun/20260528T140000Z/` |
| Claim backfill dry-run | `claim-return-line-backfill-dryrun/20260528T160000Z/` |
| TRID migration dry-run | `trid-foundation-migration-dryrun/20260530T200000Z/` |

## Migrations (drafted / committed)

| Artifact | Path | Applied |
|----------|------|---------|
| Item-level split | `supabase/migrations/20260830120000_expected_receive_split_item_level.sql` | staging + original schema wave |
| Claim lines (draft) | `supabase/migrations/20260831120000_claim_lines_foundation.sql` | **NO** |
| TRID foundation (draft) | `supabase/migrations/20260832120000_trid_foundation.sql` | **NO** — needs claim_lines |

## Paired-update law

Append-only history + `.ai-memory` updated together.
