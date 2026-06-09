# Phase 8B — backup/audit table grant revoke (original)

**Default:** approved via operator execute prompt `PHASE-8B-ORIGINAL-BACKUP-REVOKE-GRANTS-EXECUTE`.

| Field | Value |
|-------|--------|
| Original ref | `kxsvedvpjldygtdbylsy` |
| Prerequisite | `phase8b-original-backup-tables-rls-cleanup-audit/20260604T220000Z` |
| Scope | REVOKE ALL on 18 `_backup_*` / `_audit_*` tables from anon, authenticated, public |
| Excludes | DROP, MOVE, DELETE |

```text
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_PHASE8B_BACKUP_REVOKE_GRANTS=true
TARGET_SUPABASE_REF=kxsvedvpjldygtdbylsy
```

## Sign-off

```
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_PHASE8B_BACKUP_REVOKE_GRANTS=true
TARGET_SUPABASE_REF=kxsvedvpjldygtdbylsy
Approved by: Main/user via PHASE-8B-ORIGINAL-BACKUP-REVOKE-GRANTS-EXECUTE
UTC date: 20260604
Prerequisite run_id: 20260604T220000Z
```
