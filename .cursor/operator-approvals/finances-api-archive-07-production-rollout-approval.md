# Finances API Archive — Production Rollout Approval (template)

**Do not enable flags or run ingest until all checklist items in ARCHIVE-07 signoff are PASS.**

## Environment (fill before production work)

| Field | Value |
|-------|-------|
| Supabase project ref/name | `<FILL_PRODUCTION_PROJECT_REF>` |
| Environment | **production** (must differ from dev/staging `kxsvedvpjldygtdbylsy`) |
| Approved by | |
| Approved at UTC | |

## Approval flags (exact lines)

```
APPROVED_TO_APPLY_FINANCES_API_ARCHIVE_MIGRATION_PRODUCTION=false
APPROVED_TO_ENABLE_FINANCES_API_ARCHIVE_PRODUCTION=false
APPROVED_TO_RUN_FINANCES_API_ARCHIVE_FIRST_PRODUCTION_WINDOW=false
```

Set each to `true` only after the corresponding gate in:
`.cursor/audit-reports/next-finances-api-archive-07/<run_id>/signoff-checklist.md`

## Scope when enabled

- Apply only: `supabase/migrations/20260819120000_amazon_finances_api_archive.sql` (and any additive ARCHIVE-06 follow-up already merged to main)
- Writes only: `amazon_finances_source_runs`, `amazon_finances_api_pages`, `amazon_finances_event_groups`, `amazon_finances_events`
- One organization / store / bounded window for first production window unless explicitly expanded in runbook

## Out of scope (always)

- `financial_reference_resolver` writes (no FRR promotion)
- Claim filing / `claim_submissions` mutation
- Product / scanner mutation
- Live Amazon calls from audit/CI scripts without separate SP-API approval
- OpenAI / AI

## Rollback authority

Operator may halt ingest by setting both flags false and following `rollback-halt-rules.md` in the ARCHIVE-07 pack.
