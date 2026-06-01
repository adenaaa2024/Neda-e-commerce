# Claim Cutoff Policy — Phase 1 (Staging)

**Default:** not approved until operator sets flags below.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v3` |
| Plan run | `claim-cutoff-policy-phase1-plan/20260529T200000Z` |
| Prerequisite audit | `claim-scan-cutoff-settings-architecture-audit/20260529T194500Z` |

## SQL file to run (DDL only)

`.cursor/audit-reports/claim-cutoff-policy-phase1-plan/20260529T200000Z/ddl-staging-draft.sql`

## Objects touched

| Object | Operation |
|--------|-----------|
| `public.organization_settings` | ADD COLUMN `claim_policy` JSONB NOT NULL DEFAULT `{}` |

## Allowed

- Idempotent column add + object-type CHECK
- Operator seed of `claim_policy` JSON via Settings UI or one-off UPDATE after app deploy

## Forbidden

- Data backfill that creates claim_lines / claim_candidates / claim_submissions
- Changing `expected_packages` or removal import pipelines
- Enabling `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED` before policy dates configured
- Staging→original data copy

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_CLAIM_CUTOFF_POLICY_PHASE1_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Verification

`.cursor/audit-reports/claim-cutoff-policy-phase1-plan/20260529T200000Z/verification-staging.sql`

## App deploy order

1. Apply DDL on staging
2. Deploy app patch (separate implement prompt)
3. Configure dates in Settings → Claim Engine → Claim cutoff policy
4. Only then consider `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED=true` on staging

## Rollback

```sql
ALTER TABLE public.organization_settings DROP COLUMN IF EXISTS claim_policy;
-- drops CHECK constraint organization_settings_claim_policy_is_object with column
```

## Sign-off

```
Approved by:
UTC date:
scan_go_live_date to configure after deploy:
claim_start_date to configure after deploy:
Notes:
```
