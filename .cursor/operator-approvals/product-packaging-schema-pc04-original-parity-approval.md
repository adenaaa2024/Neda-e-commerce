# Product packaging schema — PC04 original/current parity approval

**Default:** not approved until staging proof (PC04A) is signed off.

| Field | Value |
|-------|--------|
| Original/current ref | `kxsvedvpjldygtdbylsy` |
| Staging ref (forbidden target) | `eiqfaapyumhixxoeltgu` |
| DDL source | `original-parity-ddl.sql` (built from live pre-apply captures + PC04A ddl-used) |
| Staging proof | `.cursor/audit-reports/pc04a-product-packaging-schema-staging-apply/20260523T030000Z/` |
| Allowed write | `CREATE TABLE`, indexes, triggers, functions, RLS for packaging tables only |
| Data backfill / products legacy columns | **forbidden** |
| `package_items` / legacy `returns` | forbidden |

```text
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL_ORIGINAL=true
```

## Sign-off

```
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL_ORIGINAL=true
Approved by: Main/user (PC04B original parity after PC04A staging proof)
UTC date: 2026-05-23
Staging proof run_id: 20260523T030000Z
```
