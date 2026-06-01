# Superadmin Automation Settings — Phase 1 (Staging)

**Default:** not approved until operator sets flags below.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v3` |
| Architecture audit | `superadmin-automation-settings-architecture-audit/20260529T203914Z` |
| Implement plan | `superadmin-automation-settings-phase1-implement-plan/20260529T205936Z` |

## SQL file to run (DDL only)

`.cursor/audit-reports/superadmin-automation-settings-phase1-implement-plan/20260529T205936Z/ddl-staging-draft.sql`

## Objects touched

| Object | Operation |
|--------|-----------|
| `public.platform_settings` | ADD COLUMN `automation_policy` JSONB NOT NULL DEFAULT `{}` |
| `public.platform_settings` | ADD COLUMN `automation_runtime` JSONB NOT NULL DEFAULT `{}` |
| CHECK constraints | `automation_policy` and `automation_runtime` must be JSON objects |

## Allowed (after app deploy + config)

- Superadmin configures schedules at `/platform/automation`
- Hourly scheduler tick on staging (dry-run removal default)
- `product_enrichment` background job enqueues when schedule due
- Removal orchestrator reads rolling_days / schedule from DB

## Forbidden

- Production / original (`kxsvedvpjldygtdbylsy`) DDL or deploy
- Bypass removal apply gates (approval files + `REMOVAL_AUTOMATION_APPLY_ENABLED` secret)
- Tenant admin access to automation settings
- Storing Amazon credentials or API secrets in `automation_policy` JSONB
- Disabling removal dry-run default without explicit operator sign-off

## Prerequisites

| Prerequisite | Status |
|--------------|--------|
| `background_jobs` phase 1 applied | Required (`APPROVED_ASYNC_JOB_ORCHESTRATION_PHASE1`) |
| `async-job-orchestration-phase1-approval.md` | Must remain approved |

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_SUPERADMIN_AUTOMATION_SETTINGS_PHASE1_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

Applied for staging verify: `SUPERADMIN-AUTOMATION-SETTINGS-STAGING-APPLY-VERIFY` (migration `20260903120000_platform_automation_settings.sql`).

## Deploy order

1. Apply DDL on staging (this approval)
2. Implement wave A: types + server actions + `/platform/automation` UI (read/write policy)
3. Implement wave B: `product_enrichment` worker + job status API
4. Implement wave C: platform scheduler tick + GHA hourly workflow
5. Implement wave D: removal orchestrator DB config + runtime cursor migration
6. Configure policy in UI; verify with staging smoke prompt
7. Only then consider removal `mode=apply` (existing removal approval chain unchanged)

## Verification

`.cursor/audit-reports/superadmin-automation-settings-phase1-implement-plan/20260529T205936Z/verification-staging.sql`

## Rollback

```sql
ALTER TABLE public.platform_settings
  DROP CONSTRAINT IF EXISTS platform_settings_automation_policy_is_object,
  DROP CONSTRAINT IF EXISTS platform_settings_automation_runtime_is_object,
  DROP COLUMN IF EXISTS automation_policy,
  DROP COLUMN IF EXISTS automation_runtime;
```

## Sign-off

```
Approved by:
UTC date:
Product enrichment first run window (local times + timezone):
Removal sync mode at go-live (dry_run | apply):
Notes:
```
