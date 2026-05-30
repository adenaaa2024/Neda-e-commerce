# DB Parity — View Linkage + Slip Parsed Columns (Original)

**Default:** not approved until operator sets flags below.

| Field | Value |
|-------|--------|
| Target ref | `kxsvedvpjldygtdbylsy` |
| Allowed | Same view/slip DDL as staging; `CREATE INDEX CONCURRENTLY` on expected_packages (original only) |
| Forbidden | Copy staging rows; product auto-create; map insert; claims |

```text
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_VIEW_LINKAGE_SLIP_DDL_ORIGINAL=true
APPROVED_ORIGINAL_EP_INDEXES_CONCURRENTLY=true
```

## Apply order (original)

1. `001_staging_inventory_views_product_linkage.sql` (reconcile; same DDL as staging PASS)
2. `002_staging_slip_identifier_columns.sql`
3. `003_original_expected_packages_indexes.sql` (each statement standalone, not in BEGIN/COMMIT)

## Sign-off

```
Approved by: Maysam Ebrahimi
UTC date: 20260530
Notes: Original parity — views + slip columns + EP indexes; staging PASS evidence 20260529T231120Z
```
