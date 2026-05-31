# Async job architecture

**Last updated:** 2026-06-06 (append)

## Problem

In-flight import ticks lost on browser refresh; progress in ad-hoc blobs; no durable cancel/resume.

## Control plane

```text
UI → /api/jobs → orchestrator → background_jobs + job_steps + job_events
→ Cron/GHA drain → claim_next + bounded tick
```

## Principles

Postgres-durable jobs · bounded `budget_ms` ticks · idempotency key · lease/reclaim · cooperative cancel · step cursor resume · append-only `job_events`

## Migrations

| File | Status |
|------|--------|
| `20260529120000_async_job_orchestration_phase1.sql` | Applied staging |
| `20260902120000_async_job_orchestration_phase2_draft.sql` | **DRAFT** — `claim_next_background_job` |

## Related automation

`.github/workflows/removal-automation-staging.yml` — **dry-run default**; apply needs approval + secret

Evidence: `async-import-job-orchestration-foundation/` · `scripts/async-import-job-orchestration-foundation-dryrun.ts`
