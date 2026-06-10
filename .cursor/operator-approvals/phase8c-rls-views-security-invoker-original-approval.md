# Phase 8C — RLS views security_invoker (original/production)

**Default:** approved via operator execute prompt `PHASE-8C-RLS-VIEWS-SECURITY-INVOKER-ORIGINAL-EXECUTE`.

| Field | Value |
|-------|--------|
| Original ref | `kxsvedvpjldygtdbylsy` |
| Prerequisite | `phase8c-rls-views-security-invoker-staging/20260604T240000Z` PASS |
| Scope | Recreate 10 views WITH (security_invoker = true) on original |

```text
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_PHASE8C_VIEWS_SECURITY_INVOKER_ORIGINAL=true
TARGET_SUPABASE_REF=kxsvedvpjldygtdbylsy
```

## Sign-off

```
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_PHASE8C_VIEWS_SECURITY_INVOKER_ORIGINAL=true
TARGET_SUPABASE_REF=kxsvedvpjldygtdbylsy
Approved by: Main/user via PHASE-8C-RLS-VIEWS-SECURITY-INVOKER-ORIGINAL-EXECUTE
UTC date: 20260604
Prerequisite run_id: 20260604T240000Z
```
