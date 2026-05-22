-- NEXT-PRODUCT-ID-02 — Read-only: expected product-link columns vs information_schema.
-- Run in Supabase SQL editor. SELECT only.
--
-- Rows: one per (table, expected_column). `present` false means column missing on that table.

WITH tbl(name) AS (
  VALUES
    ('products'),
    ('catalog_products'),
    ('product_identifier_map'),
    ('product_identity_staging_rows'),
    ('amazon_amazon_fulfilled_inventory'),
    ('amazon_manage_fba_inventory'),
    ('amazon_fba_inventory'),
    ('amazon_inventory_ledger'),
    ('amazon_all_orders'),
    ('amazon_returns'),
    ('amazon_reimbursements'),
    ('amazon_removals'),
    ('amazon_removal_shipments'),
    ('amazon_reports_repository'),
    ('claim_candidates')
),
wanted(name) AS (
  VALUES
    ('product_id'),
    ('resolved_product_id'),
    ('resolved_catalog_product_id'),
    ('catalog_product_id'),
    ('organization_id'),
    ('store_id'),
    ('upload_id'),
    ('source_upload_id'),
    ('source_file_sha256'),
    ('source_physical_row_number'),
    ('source_table'),
    ('source_row_id'),
    ('identifier_resolution_status'),
    ('identifier_resolution_confidence')
)
SELECT
  t.name AS table_name,
  w.name AS expected_column,
  (tb.table_name IS NOT NULL) AS table_exists,
  (c.column_name IS NOT NULL) AS column_present,
  c.data_type
FROM tbl AS t
CROSS JOIN wanted AS w
LEFT JOIN information_schema.tables AS tb
  ON tb.table_schema = 'public'
 AND tb.table_name = t.name
LEFT JOIN information_schema.columns AS c
  ON c.table_schema = 'public'
 AND c.table_name = t.name
 AND c.column_name = w.name
ORDER BY t.name, w.name;
