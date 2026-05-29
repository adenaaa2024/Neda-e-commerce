# Removal Automation Cron — Implementation Approval

**Default:** not approved. Required before deploying scheduled removal pipeline automation (any environment).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden until separate approval |
| Scheduler | as specified in audit `removal-automation-cron-plan` |
| Product auto-create | forbidden in automation path |
| `package_items` | forbidden |

```text
APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON=true
```

## Scope if approved

- Orchestrator script or workflow chaining: fetch → sync → rebuild → verify → resolver reconcile
- Secured trigger (GitHub Actions schedule and/or internal cron route that starts CLI only)
- Audit folder per run under `.cursor/audit-reports/removal-automation-run/`
- Alert on blockers (log + optional webhook env)

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| `sp-api-removal-shipment-fetch-approval.md` flags true for scheduled fetch | |
| `sp-api-removal-reports-domain-sync-approval.md` flags true | |
| Allocation verify PASS / allocation fix applied | |
| Resolver backfill policy signed | |
| SP-API credentials valid on runner | |
| Staging-only guard in orchestrator | |

## Sign-off

```text
APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON=true
Approved by: Maysam Ebrahimi
UTC date: 05282026
Schedule timezone (default America/Los_Angeles):
Max wall clock per run (minutes, default 90):
Alert webhook URL configured (optional):
Notes:
```
