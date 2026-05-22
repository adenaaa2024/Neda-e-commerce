---
name: Live schema audit SQL
overview: SELECT-only SQL bundle for the NEXT-14A live schema audit. One query per report (A-J), each pre-scoped to the full 31-table audit list, plus suggested CSV filenames and a recommended execution order. No code, no migration, no mutation.
todos:
  - id: no-op
    content: NEXT-14B is a SQL bundle deliverable. Operator runs the queries in Supabase, exports the CSVs by suggested name, and returns them. No code or DB mutation.
    status: pending
isProject: false
---

## NEXT-14B — Live schema audit SQL bundle

Plan only. The deliverable is the SQL itself. SELECT / `information_schema` / `pg_catalog` only — no UPDATE / INSERT / DELETE / ALTER / CREATE / DROP, and no code or migration changes.

### Conventions

- All queries are pre-scoped to the audit table list via a `tbl(name)` CTE so the operator only ever changes that one list if a table is added or removed.
- Schema = `public`. Adjust if any table actually lives elsewhere (none expected).
- Each numbered block is independent and can be run in any order, but a recommended order is at the bottom.
- Each block has a suggested CSV filename in its `-- =====` header line so result tabs stay labelled when exported.
- "Output target: Download CSV" is the standard step in Supabase SQL editor.

---

### Shared `tbl` CTE used by every query

Embedded inline at the top of each query block. Edit this list once if the table inventory changes.

```sql
WITH tbl(name) AS (VALUES
  ('products'),
  ('catalog_products'),
  ('product_identifier_map'),
  ('product_identity_staging_rows'),
  ('product_prices'),
  ('product_categories'),
  ('pim_conflict_audit_log'),
  ('pim_duplicate_groups'),
  ('raw_report_uploads'),
  ('file_processing_status'),
  ('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),
  ('amazon_inventory_ledger'),
  ('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),
  ('amazon_all_orders'),
  ('amazon_settlements'),
  ('amazon_transactions'),
  ('amazon_reports_repository'),
  ('amazon_reimbursements'),
  ('amazon_returns'),
  ('amazon_removals'),
  ('amazon_removal_shipments'),
  ('expected_returns'),
  ('expected_packages'),
  ('expected_removals'),
  ('expected_pallets'),
  ('pallets'),
  ('packages'),
  ('financial_reference_resolver')
)
```

---

### A) Columns report (one row per column)

```sql
-- ===== A) columns / csv: 14b_a_columns.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale,
  c.is_generated,
  c.generation_expression,
  c.is_identity
FROM information_schema.columns c
JOIN tbl t ON t.name = c.table_name
WHERE c.table_schema = 'public'
ORDER BY c.table_name, c.ordinal_position;
```

---

### B) Resolver / store / upload column presence (one row per table)

```sql
-- ===== B) resolver-store-upload presence / csv: 14b_b_presence.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
), cols AS (
  SELECT c.table_name, c.column_name, c.data_type, c.udt_name
  FROM information_schema.columns c
  JOIN tbl t ON t.name = c.table_name
  WHERE c.table_schema = 'public'
)
SELECT
  t.name AS table_name,

  bool_or(cols.column_name = 'organization_id')                  AS has_organization_id,
  bool_or(cols.column_name = 'store_id')                          AS has_store_id,

  bool_or(cols.column_name = 'upload_id')                         AS has_upload_id,
  max(CASE WHEN cols.column_name = 'upload_id' THEN cols.data_type END)        AS upload_id_type,

  bool_or(cols.column_name = 'source_upload_id')                  AS has_source_upload_id,
  max(CASE WHEN cols.column_name = 'source_upload_id' THEN cols.data_type END) AS source_upload_id_type,

  bool_or(cols.column_name = 'product_id')                        AS has_product_id,
  max(CASE WHEN cols.column_name = 'product_id' THEN cols.data_type END)       AS product_id_type,

  bool_or(cols.column_name = 'catalog_product_id')                AS has_catalog_product_id,
  max(CASE WHEN cols.column_name = 'catalog_product_id' THEN cols.data_type END) AS catalog_product_id_type,

  bool_or(cols.column_name = 'resolved_product_id')               AS has_resolved_product_id,
  bool_or(cols.column_name = 'resolved_catalog_product_id')       AS has_resolved_catalog_product_id,

  bool_or(cols.column_name = 'identifier_resolution_status')      AS has_identifier_resolution_status,
  bool_or(cols.column_name = 'identifier_resolution_confidence')  AS has_identifier_resolution_confidence,

  bool_or(cols.column_name = 'product_match_method')              AS has_product_match_method,
  bool_or(cols.column_name = 'product_match_confidence')          AS has_product_match_confidence,
  bool_or(cols.column_name = 'product_matched_at')                AS has_product_matched_at,

  bool_or(cols.column_name = 'raw_data')                          AS has_raw_data,
  bool_or(cols.column_name = 'raw_row')                           AS has_raw_row,
  bool_or(cols.column_name = 'sku')                               AS has_sku,
  bool_or(cols.column_name = 'asin')                              AS has_asin,
  bool_or(cols.column_name = 'fnsku')                             AS has_fnsku,
  bool_or(cols.column_name = 'upc' OR cols.column_name = 'upc_code') AS has_upc,

  -- Convention classifier (1=product_id,2=resolved_product_id,3=none,4=mixed)
  CASE
    WHEN bool_or(cols.column_name = 'resolved_product_id')
         AND bool_or(cols.column_name = 'product_match_method')                 THEN 4
    WHEN bool_or(cols.column_name = 'product_match_method')                     THEN 1
    WHEN bool_or(cols.column_name = 'resolved_product_id')                      THEN 2
    ELSE 3
  END                                                              AS resolver_convention,

  -- table presence sentinel
  bool_or(true)                                                    AS table_exists
FROM tbl t
LEFT JOIN cols ON cols.table_name = t.name
GROUP BY t.name
ORDER BY t.name;
```

A row with `table_exists = NULL` means the table does not exist in the live `public` schema. Treat that as a finding (not an error).

---

### C) Constraints (PK / unique / FK / check)

```sql
-- ===== C) constraints / csv: 14b_c_constraints.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  t.relname                                  AS table_name,
  con.conname                                AS constraint_name,
  con.contype                                AS contype,                     -- p=PK, u=unique, f=FK, c=check, x=exclusion
  pg_get_constraintdef(con.oid, true)        AS definition
FROM pg_constraint con
JOIN pg_class      t  ON t.oid  = con.conrelid
JOIN pg_namespace  n  ON n.oid  = t.relnamespace
JOIN tbl           tt ON tt.name = t.relname
WHERE n.nspname = 'public'
ORDER BY t.relname, con.contype, con.conname;
```

---

### D) Indexes (incl. partial predicates)

```sql
-- ===== D) indexes / csv: 14b_d_indexes.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  i.tablename                                AS table_name,
  i.indexname,
  ix.indisunique                             AS is_unique,
  ix.indisprimary                            AS is_primary,
  i.indexdef                                 AS definition
FROM pg_indexes i
JOIN pg_class       c  ON c.relname = i.indexname
JOIN pg_namespace   nc ON nc.oid    = c.relnamespace AND nc.nspname = i.schemaname
JOIN pg_index       ix ON ix.indexrelid = c.oid
JOIN tbl            t  ON t.name = i.tablename
WHERE i.schemaname = 'public'
ORDER BY i.tablename, i.indexname;
```

---

### E) Foreign-key detail (source/target columns + behavior)

```sql
-- ===== E) foreign keys / csv: 14b_e_fks.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  src_t.relname        AS source_table,
  src_a.attname        AS source_column,
  ref_t.relname        AS referenced_table,
  ref_a.attname        AS referenced_column,
  con.conname          AS constraint_name,
  CASE con.confupdtype
    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'  WHEN 'd' THEN 'SET DEFAULT' END                          AS on_update,
  CASE con.confdeltype
    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'  WHEN 'd' THEN 'SET DEFAULT' END                          AS on_delete,
  CASE con.confmatchtype
    WHEN 'f' THEN 'FULL' WHEN 'p' THEN 'PARTIAL' WHEN 's' THEN 'SIMPLE' END             AS match_type
FROM pg_constraint con
JOIN pg_class      src_t ON src_t.oid = con.conrelid
JOIN pg_namespace  src_n ON src_n.oid = src_t.relnamespace
JOIN pg_class      ref_t ON ref_t.oid = con.confrelid
JOIN pg_namespace  ref_n ON ref_n.oid = ref_t.relnamespace
JOIN tbl           tt    ON tt.name   = src_t.relname
-- expand each (conkey, confkey) pair to one row
JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS sk(attnum, ord)  ON true
JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord)  ON sk.ord = rk.ord
JOIN pg_attribute  src_a ON src_a.attrelid = src_t.oid AND src_a.attnum = sk.attnum
JOIN pg_attribute  ref_a ON ref_a.attrelid = ref_t.oid AND ref_a.attnum = rk.attnum
WHERE con.contype = 'f'
  AND src_n.nspname = 'public'
ORDER BY source_table, constraint_name, source_column;
```

---

### F) RLS (enabled/forced) + policies

```sql
-- ===== F1) RLS enabled flags / csv: 14b_f1_rls_flags.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  c.relname              AS table_name,
  c.relrowsecurity       AS rls_enabled,
  c.relforcerowsecurity  AS rls_forced,
  c.relkind              AS rel_kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN tbl t ON t.name = c.relname
WHERE n.nspname = 'public'
ORDER BY c.relname;
```

```sql
-- ===== F2) RLS policies / csv: 14b_f2_rls_policies.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  p.tablename            AS table_name,
  p.policyname,
  p.permissive,
  p.roles,
  p.cmd                  AS command,
  p.qual                 AS using_expression,
  p.with_check           AS with_check_expression
FROM pg_policies p
JOIN tbl t ON t.name = p.tablename
WHERE p.schemaname = 'public'
ORDER BY p.tablename, p.policyname;
```

---

### G) Triggers

```sql
-- ===== G) triggers / csv: 14b_g_triggers.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  c.relname                                                                    AS table_name,
  tg.tgname                                                                    AS trigger_name,
  CASE WHEN tg.tgenabled = 'D' THEN 'disabled' ELSE 'enabled' END               AS status,
  pg_get_triggerdef(tg.oid, true)                                              AS definition,
  np.nspname || '.' || pf.proname                                              AS function_qualified
FROM pg_trigger    tg
JOIN pg_class      c  ON c.oid  = tg.tgrelid
JOIN pg_namespace  n  ON n.oid  = c.relnamespace
JOIN pg_proc       pf ON pf.oid = tg.tgfoid
JOIN pg_namespace  np ON np.oid = pf.pronamespace
JOIN tbl           t  ON t.name = c.relname
WHERE n.nspname = 'public'
  AND NOT tg.tgisinternal
ORDER BY c.relname, tg.tgname;
```

---

### H) Views and matviews depending on these tables

```sql
-- ===== H1) dependent views (names) / csv: 14b_h1_dependent_views.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT DISTINCT
  tc.relname                AS table_referenced,
  vn.nspname                AS view_schema,
  vc.relname                AS view_name,
  vc.relkind                AS kind                          -- 'v' or 'm'
FROM pg_depend    d
JOIN pg_rewrite   r  ON r.oid     = d.objid
JOIN pg_class     vc ON vc.oid    = r.ev_class
JOIN pg_namespace vn ON vn.oid    = vc.relnamespace
JOIN pg_class     tc ON tc.oid    = d.refobjid
JOIN pg_namespace tn ON tn.oid    = tc.relnamespace
JOIN tbl          t  ON t.name    = tc.relname
WHERE tn.nspname = 'public'
  AND vc.relkind IN ('v','m')
  AND vc.oid <> tc.oid
ORDER BY table_referenced, view_schema, view_name;
```

```sql
-- ===== H2) dependent view definitions / csv: 14b_h2_view_defs.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT DISTINCT
  vn.nspname                AS view_schema,
  vc.relname                AS view_name,
  vc.relkind                AS kind,
  pg_get_viewdef(vc.oid, true) AS definition
FROM pg_depend    d
JOIN pg_rewrite   r  ON r.oid     = d.objid
JOIN pg_class     vc ON vc.oid    = r.ev_class
JOIN pg_namespace vn ON vn.oid    = vc.relnamespace
JOIN pg_class     tc ON tc.oid    = d.refobjid
JOIN pg_namespace tn ON tn.oid    = tc.relnamespace
JOIN tbl          t  ON t.name    = tc.relname
WHERE tn.nspname = 'public'
  AND vc.relkind IN ('v','m')
  AND vc.oid <> tc.oid
ORDER BY view_schema, view_name;
```

---

### I) Functions / RPCs mentioning these tables (textual scan)

This block searches `pg_proc.prosrc` for any of the table names. False positives are possible (e.g. a function whose comment mentions a table name); the operator should use the `match_examples` column to filter.

```sql
-- ===== I) functions mentioning audited tables / csv: 14b_i_functions.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  n.nspname                                            AS function_schema,
  p.proname                                            AS function_name,
  pg_get_function_identity_arguments(p.oid)            AS arg_signature,
  array_agg(DISTINCT t.name ORDER BY t.name)
    FILTER (WHERE position(t.name IN p.prosrc) > 0)    AS tables_referenced,
  l.lanname                                            AS language,
  -- short snippet: first 240 chars of body
  left(p.prosrc, 240)                                   AS body_preview
FROM pg_proc      p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language  l ON l.oid = p.prolang
CROSS JOIN tbl    t
WHERE n.nspname = 'public'
  AND p.prosrc ~ ('\m' || t.name || '\M')              -- whole-word match against function source
GROUP BY n.nspname, p.proname, p.oid, l.lanname
ORDER BY function_schema, function_name;
```

For full bodies of any specific function flagged above, run on demand:

```sql
-- ===== I-aux) full body of one named function (operator runs ad-hoc) =====
SELECT pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = '<FUNCTION_NAME>'
LIMIT 5;
```

---

### J) Type mismatch risk report

This is the focused report the prompt explicitly calls out. Every block below is read-only.

```sql
-- ===== J1) all upload_id / source_upload_id columns and their types / csv: 14b_j1_upload_types.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  CASE
    WHEN c.column_name IN ('upload_id','source_upload_id') AND c.udt_name = 'uuid' THEN 'OK uuid'
    WHEN c.column_name IN ('upload_id','source_upload_id') AND c.udt_name <> 'uuid' THEN 'TYPE MISMATCH'
    ELSE 'n/a'
  END                                                    AS verdict
FROM information_schema.columns c
JOIN tbl t ON t.name = c.table_name
WHERE c.table_schema = 'public'
  AND c.column_name IN ('upload_id','source_upload_id')
ORDER BY verdict DESC, c.table_name, c.column_name;
```

```sql
-- ===== J2) tables that have BOTH upload_id and source_upload_id / csv: 14b_j2_dual_upload.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  c.table_name,
  bool_or(c.column_name = 'upload_id')        AS has_upload_id,
  bool_or(c.column_name = 'source_upload_id') AS has_source_upload_id
FROM information_schema.columns c
JOIN tbl t ON t.name = c.table_name
WHERE c.table_schema = 'public'
  AND c.column_name IN ('upload_id','source_upload_id')
GROUP BY c.table_name
HAVING bool_or(c.column_name = 'upload_id')
   AND bool_or(c.column_name = 'source_upload_id')
ORDER BY c.table_name;
```

```sql
-- ===== J3) amazon_fba_inventory live resolver columns / csv: 14b_j3_fba_resolver.csv =====
SELECT column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'amazon_fba_inventory'
  AND column_name IN (
    'product_id','catalog_product_id','product_match_method','product_match_confidence','product_matched_at',
    'resolved_product_id','resolved_catalog_product_id','identifier_resolution_status','identifier_resolution_confidence'
  )
ORDER BY column_name;
```

```sql
-- ===== J4) amazon_reports_repository.upload_id live type / csv: 14b_j4_reports_repo_upload_id.csv =====
SELECT column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'amazon_reports_repository'
  AND column_name  = 'upload_id';
```

```sql
-- ===== J5) expected_packages live schema / csv: 14b_j5_expected_packages_schema.csv =====
-- Settles which of the two in-repo CREATEs is live.
SELECT
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name   = 'expected_packages'
ORDER BY c.ordinal_position;
```

```sql
-- ===== J6) any FK in audit set whose source/target type differs / csv: 14b_j6_fk_type_mismatch.csv =====
WITH tbl(name) AS (VALUES
  ('products'),('catalog_products'),('product_identifier_map'),('product_identity_staging_rows'),
  ('product_prices'),('product_categories'),('pim_conflict_audit_log'),('pim_duplicate_groups'),
  ('raw_report_uploads'),('file_processing_status'),('amazon_staging'),
  ('amazon_amazon_fulfilled_inventory'),('amazon_inventory_ledger'),('amazon_manage_fba_inventory'),
  ('amazon_fba_inventory'),('amazon_all_orders'),('amazon_settlements'),('amazon_transactions'),
  ('amazon_reports_repository'),('amazon_reimbursements'),('amazon_returns'),('amazon_removals'),
  ('amazon_removal_shipments'),('expected_returns'),('expected_packages'),('expected_removals'),
  ('expected_pallets'),('pallets'),('packages'),('financial_reference_resolver')
)
SELECT
  src_t.relname     AS source_table,
  src_a.attname     AS source_column,
  format_type(src_a.atttypid, src_a.atttypmod) AS source_type,
  ref_t.relname     AS referenced_table,
  ref_a.attname     AS referenced_column,
  format_type(ref_a.atttypid, ref_a.atttypmod) AS referenced_type,
  CASE WHEN src_a.atttypid = ref_a.atttypid THEN 'OK' ELSE 'MISMATCH' END AS verdict
FROM pg_constraint con
JOIN pg_class      src_t ON src_t.oid = con.conrelid
JOIN pg_namespace  src_n ON src_n.oid = src_t.relnamespace
JOIN pg_class      ref_t ON ref_t.oid = con.confrelid
JOIN tbl           tt    ON tt.name   = src_t.relname
JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS sk(attnum, ord) ON true
JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord) ON sk.ord = rk.ord
JOIN pg_attribute  src_a ON src_a.attrelid = src_t.oid AND src_a.attnum = sk.attnum
JOIN pg_attribute  ref_a ON ref_a.attrelid = ref_t.oid AND ref_a.attnum = rk.attnum
WHERE con.contype = 'f'
  AND src_n.nspname = 'public'
ORDER BY verdict DESC, source_table, source_column;
```

---

### CSV export list

One CSV per labelled block. Suggested filenames (already embedded in each header):

- `14b_a_columns.csv` — A
- `14b_b_presence.csv` — B
- `14b_c_constraints.csv` — C
- `14b_d_indexes.csv` — D
- `14b_e_fks.csv` — E
- `14b_f1_rls_flags.csv` — F1
- `14b_f2_rls_policies.csv` — F2
- `14b_g_triggers.csv` — G
- `14b_h1_dependent_views.csv` — H1
- `14b_h2_view_defs.csv` — H2
- `14b_i_functions.csv` — I
- `14b_j1_upload_types.csv` — J1
- `14b_j2_dual_upload.csv` — J2
- `14b_j3_fba_resolver.csv` — J3
- `14b_j4_reports_repo_upload_id.csv` — J4
- `14b_j5_expected_packages_schema.csv` — J5
- `14b_j6_fk_type_mismatch.csv` — J6

If any table in the audit list does not exist in the live `public` schema, that absence will be visible in B (the row's `table_exists` will be NULL because the LEFT JOIN to columns finds nothing). Report any such row explicitly.

### Recommended execution order

1. **B first.** Tells you which audit tables actually exist and which conventions each follows. Cheapest, smallest output, smokes-out any missing tables.
2. **A.** Full column inventory — anchors every other report.
3. **J1 + J2 + J3 + J4 + J5.** Targeted type-mismatch verdicts (the explicit unknowns from NEXT-14A).
4. **C + E + J6.** Constraints and FK-type mismatches (J6 builds on E).
5. **D.** Indexes (often the largest output among the structural reports).
6. **F1 + F2 + G.** RLS / triggers (small).
7. **H1 then H2.** First the names, then full definitions only for the rows that surfaced in H1.
8. **I.** Functions referencing the tables (largest scan, deferred to last).

### Hard rules (re-iterated)

- Every query is `SELECT` only.
- No UPDATE / INSERT / DELETE / ALTER / CREATE / DROP anywhere.
- No code edits.
- No migrations.
- No data mutation.
- The `tbl(name)` list is the only edit point if the audit inventory changes.
- Any query that returns "column does not exist" or "relation does not exist" is itself a finding — capture the error text alongside the missing object name and continue.

Plan only. No edits.