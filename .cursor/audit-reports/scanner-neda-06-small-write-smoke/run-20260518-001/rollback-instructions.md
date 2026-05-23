# Rollback / delete instructions

## Smoke row to remove

| Field | Value |
|-------|-------|
| `return_items.id` | `ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663` |
| `package_id` | `9528d923-3d27-4aed-a773-095b5028743d` |

## Option A — soft delete (preferred if audit trail expects tombstones)

```sql
UPDATE return_items
SET deleted_at = now()
WHERE id = 'ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663';
```

## Option B — hard delete

```sql
DELETE FROM return_items
WHERE id = 'ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663';
```

## Verify after rollback

```sql
SELECT id, package_id, fnsku, sku, deleted_at
FROM return_items
WHERE id = 'ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663';
```

```sql
SELECT actual_item_count
FROM packages
WHERE id = '9528d923-3d27-4aed-a773-095b5028743d';
```

Expect: no active row (or `deleted_at` set); package count may decrement if DB trigger maintains `actual_item_count`.

## Automated rollback (script)

```powershell
cd c:\Users\Christian\ecommerce-os
$env:SCANNER_NEDA_06_DELETE_AFTER = "true"
# Re-run only if you need to delete a *new* probe row; for this run, delete the id above manually
# or run hard_delete SQL in Supabase SQL editor.
```

**Note:** `SCANNER_NEDA_06_DELETE_AFTER=true` deletes the row inserted in the **same** script execution; it does not retro-delete `ccffe8b3-…` unless you re-insert first.

## Do not

- Drop or recreate `package_items`
- Run migrations
- Delete unrelated `return_items` on the fixture package (2 pre-existing rows may be legitimate)
