# CLAIMS-RETURNS-FIRST-CONFIGURE-STAGING — operator approval

**Target:** staging only (`eiqfaapyumhixxoeltgu`)  
**Scope:** `organization_settings.claim_policy` for returns-first manual draft testing (Sam org — physical return_items volume).

## Approval flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_CLAIMS_RETURNS_FIRST_CONFIGURE_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Operator-approved policy values (required)

| Field | Value |
|-------|--------|
| `organization_id` | `00000000-0000-0000-0000-000000000001` (Sam Distribution) |
| `scan_go_live_date` | `2026-01-15` |
| `claim_start_date` | `2026-01-15` |
| `claim_eligibility_window_days` | `90` |
| `claim_grouping_policy` | `single_item` |
| `claim_hold_policy` | `hold_until_package_closed` |
| `enabled_claim_domains.returns` | `true` |
| All other `enabled_claim_domains.*` | `false` |

## Allowed writes

| Table | Column | Org |
|-------|--------|-----|
| `public.organization_settings` | `claim_policy` | Sam org only |

## Forbidden

- Do not enable `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED`
- Do not run `claim-return-line-backfill-execute`
- No marketplace submit
- Do not touch original (`kxsvedvpjldygtdbylsy`)

## Rollback

```sql
UPDATE public.organization_settings
SET claim_policy = '{}'::jsonb
WHERE organization_id = '00000000-0000-0000-0000-000000000001';
```

## Sign-off

```
Approved by: Maysam Ebrahimi
UTC date: 2026-06-01
```
