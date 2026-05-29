# Async Job Orchestration Phase 1 — Staging Approval

**Default:** not approved until operator sets flags below.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed writes | Additive DDL (`background_jobs`, `job_steps`, `job_locks`, `job_events`) + bridge columns on `raw_report_uploads` / `file_processing_status` |
| API scope | `POST /api/jobs/{enqueue,tick,cancel,retry}` — staging only |
| Production/original | forbidden |
| Amazon API in workers | forbidden (phase 1 skeleton only) |
| Destructive DDL | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_ASYNC_JOB_ORCHESTRATION_PHASE1=true
```

## Signoff

```
Environment: STAGING ONLY (eiqfaapyumhixxoeltgu)
Status: APPROVED
Approved by: Maysam Ebrahimi
UTC date: 2026-05-29T12:00:00Z
Notes: Phase 1 schema + API + smoke worker only
```
