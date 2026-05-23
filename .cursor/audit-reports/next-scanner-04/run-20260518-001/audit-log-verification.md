# Audit log verification (NEXT-SCANNER-04)

## Live verification

**Skipped** — manual override E2E not run.

## Expected behavior (code)

On successful manual override, `return_audit_log` insert:

| Field | Value |
|-------|-------|
| `organization_id` | From return line |
| `return_id` | `return_item_id` (line PK) |
| `action` | `updated` |
| `field` | `scanner_product_manual_override` |
| `old_value` | Previous `resolved_product_id` or null |
| `new_value` | Chosen `resolved_product_id` |
| `actor` | Operator label (default `operator`) |

## Post-gate check

After SCANNER-02C + `--write-test`:

```sql
SELECT id, field, old_value, new_value, actor, created_at
FROM return_audit_log
WHERE field = 'scanner_product_manual_override'
ORDER BY created_at DESC
LIMIT 5;
```

## Verdict

**Not verified live** — blocked on migration + environment gate.
