# CLAIM-CUTOFF-POLICY-CONFIGURE-STAGING — operator approval

**Target:** staging only (`eiqfaapyumhixxoeltgu`)  
**Scope:** `organization_settings.claim_policy` JSON update for pilot org only — no claim lines/cases, no auto-promote enable.

## Approval flags

APPROVED_TO_RUN_STAGING = true

APPROVED_CLAIM_CUTOFF_POLICY_CONFIGURE_STAGING = true

TARGET_SUPABASE_REF = eiqfaapyumhixxoeltgu

## Allowed writes

| Table | Column | Pilot org only |
|-------|--------|----------------|
| `public.organization_settings` | `claim_policy` | `7397edff-7994-4731-8501-55d258d507d2` |

## Forbidden

- Do not enable `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED`
- Do not INSERT/UPDATE `claim_lines`, `claim_cases`, `claim_evidence`
- Do not touch original (`kxsvedvpjldygtdbylsy`)
- Do not deploy

## Rollback

```sql
UPDATE public.organization_settings
SET claim_policy = '{}'::jsonb
WHERE organization_id = '7397edff-7994-4731-8501-55d258d507d2';
```
