# Phase 8C — RLS views security_invoker (staging)

**Default:** approved via operator execute prompt `PHASE-8C-RLS-VIEWS-SECURITY-INVOKER-STAGING`.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Scope | Recreate 10 views WITH (security_invoker = true) |
| Excludes | production/original apply, DROP without recreate |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PHASE8C_VIEWS_SECURITY_INVOKER=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_PHASE8C_VIEWS_SECURITY_INVOKER=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
Approved by: Main/user via PHASE-8C-RLS-VIEWS-SECURITY-INVOKER-STAGING
UTC date: 20260604
```
