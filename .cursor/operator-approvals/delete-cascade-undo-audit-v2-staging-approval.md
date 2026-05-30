# Operator approval — DELETE CASCADE UNDO v2 (staging only)

| Field | Value |
|-------|-------|
| **Approval ID** | `delete-cascade-undo-audit-v2-staging` |
| **Environment** | Staging `eiqfaapyumhixxoeltgu` |
| **Branch** | `feature/product-canonicalization-v3` |
| **DDL packet** | `supabase/migrations/20260903120000_delete_cascade_undo_audit_foundation_v2.sql` |
| **Dry-run** | `delete-cascade-undo-v2-staging-dryrun/20260521T120000Z` — PASS |
| **Prerequisite** | `20260830120000_expected_receive_split_item_level` on staging |
| **v1 draft** | `20260901120000_delete_cascade_undo_audit_foundation.sql` — NOT applied on staging |

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_DELETE_CASCADE_UNDO_AUDIT_V2_MIGRATION=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Sign-off

```
Approved by: Main/user
UTC date: 2026-05-21
Execute prompt: DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE
Notes: v2 packet; timestamp 20260903120000 (20260902120000 slot used by async_job draft)
```
