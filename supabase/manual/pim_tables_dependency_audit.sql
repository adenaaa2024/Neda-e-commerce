-- PIM table dependency audit — run manually in SQL editor or psql (not executed by CI).
-- Targets: catalog_identity_unresolved_backlog, catalog_products, product_categories,
--           product_identifier_map, product_identity_staging_rows, raw_report_uploads,
--           import_report_registry

-- ============================================================================
-- 1) Foreign keys referencing each listed table (referenced = parent)
-- ============================================================================
SELECT
  tc.table_schema AS referencing_schema,
  tc.table_name AS referencing_table,
  kcu.column_name AS referencing_column,
  ccu.table_schema AS referenced_schema,
  ccu.table_name AS referenced_table,
  ccu.column_name AS referenced_column,
  tc.constraint_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
  AND tc.table_catalog = kcu.table_catalog
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
  AND ccu.table_catalog = tc.table_catalog
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_schema = 'public'
  AND ccu.table_name IN (
    'catalog_identity_unresolved_backlog',
    'catalog_products',
    'product_categories',
    'product_identifier_map',
    'product_identity_staging_rows',
    'raw_report_uploads',
    'import_report_registry'
  )
ORDER BY ccu.table_name, tc.table_name, kcu.column_name;

-- ============================================================================
-- 2) Views / materialized views whose definition mentions a table name
--    (one row per view per matched keyword)
-- ============================================================================
WITH needles(tbl, needle) AS (
  VALUES
    ('catalog_identity_unresolved_backlog', 'catalog_identity_unresolved_backlog'),
    ('catalog_products', 'catalog_products'),
    ('product_categories', 'product_categories'),
    ('product_identifier_map', 'product_identifier_map'),
    ('product_identity_staging_rows', 'product_identity_staging_rows'),
    ('raw_report_uploads', 'raw_report_uploads'),
    ('import_report_registry', 'import_report_registry')
),
views AS (
  SELECT c.oid, c.relkind, n.nspname AS schema_name, c.relname AS object_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v', 'm')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
)
SELECT
  n.tbl AS for_table,
  v.relkind,
  v.schema_name,
  v.object_name,
  CASE v.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE v.relkind::text END AS kind
FROM views v
CROSS JOIN needles n
WHERE pg_get_viewdef(v.oid, true) ILIKE ('%' || n.needle || '%')
ORDER BY n.tbl, v.schema_name, v.object_name;

-- ============================================================================
-- 3) Functions whose definition text mentions a table name (heuristic)
-- ============================================================================
WITH needles(tbl, needle) AS (
  VALUES
    ('catalog_identity_unresolved_backlog', 'catalog_identity_unresolved_backlog'),
    ('catalog_products', 'catalog_products'),
    ('product_categories', 'product_categories'),
    ('product_identifier_map', 'product_identifier_map'),
    ('product_identity_staging_rows', 'product_identity_staging_rows'),
    ('raw_report_uploads', 'raw_report_uploads'),
    ('import_report_registry', 'import_report_registry')
)
SELECT
  n.tbl AS for_table,
  ns.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace ns ON ns.oid = p.pronamespace
CROSS JOIN needles n
WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
  AND pg_get_functiondef(p.oid) ILIKE ('%' || n.needle || '%')
ORDER BY n.tbl, ns.nspname, p.proname;

-- ============================================================================
-- 4) Triggers on each table
-- ============================================================================
SELECT
  event_object_schema,
  event_object_table,
  trigger_name,
  action_timing,
  string_agg(DISTINCT event_manipulation, ', ' ORDER BY event_manipulation) AS events
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table IN (
    'catalog_identity_unresolved_backlog',
    'catalog_products',
    'product_categories',
    'product_identifier_map',
    'product_identity_staging_rows',
    'raw_report_uploads',
    'import_report_registry'
  )
GROUP BY event_object_schema, event_object_table, trigger_name, action_timing
ORDER BY event_object_table, trigger_name;

-- ============================================================================
-- 5) Row counts by organization_id (and store_id when column exists)
--    + last created_at / updated_at
-- ============================================================================
-- catalog_identity_unresolved_backlog
SELECT
  'catalog_identity_unresolved_backlog'::text AS tbl,
  organization_id,
  NULL::uuid AS store_id,
  COUNT(*)::bigint AS row_count,
  MAX(created_at) AS max_created_at,
  MAX(updated_at) AS max_updated_at
FROM public.catalog_identity_unresolved_backlog
GROUP BY organization_id
ORDER BY row_count DESC NULLS LAST;

-- catalog_products
SELECT
  'catalog_products'::text AS tbl,
  organization_id,
  store_id,
  COUNT(*)::bigint AS row_count,
  MAX(created_at) AS max_created_at,
  MAX(updated_at) AS max_updated_at
FROM public.catalog_products
GROUP BY organization_id, store_id
ORDER BY row_count DESC NULLS LAST;

-- product_categories
SELECT
  'product_categories'::text AS tbl,
  organization_id,
  NULL::uuid AS store_id,
  COUNT(*)::bigint AS row_count,
  MAX(created_at) AS max_created_at,
  MAX(updated_at) AS max_updated_at
FROM public.product_categories
GROUP BY organization_id
ORDER BY row_count DESC NULLS LAST;

-- product_identifier_map
SELECT
  'product_identifier_map'::text AS tbl,
  organization_id,
  store_id,
  COUNT(*)::bigint AS row_count,
  MAX(created_at) AS max_created_at,
  MAX(updated_at) AS max_updated_at
FROM public.product_identifier_map
GROUP BY organization_id, store_id
ORDER BY row_count DESC NULLS LAST;

-- product_identity_staging_rows
SELECT
  'product_identity_staging_rows'::text AS tbl,
  organization_id,
  NULL::uuid AS store_id,
  COUNT(*)::bigint AS row_count,
  MAX(created_at) AS max_created_at,
  MAX(updated_at) AS max_updated_at
FROM public.product_identity_staging_rows
GROUP BY organization_id
ORDER BY row_count DESC NULLS LAST;

-- raw_report_uploads
SELECT
  'raw_report_uploads'::text AS tbl,
  organization_id,
  store_id,
  COUNT(*)::bigint AS row_count,
  MAX(created_at) AS max_created_at,
  MAX(updated_at) AS max_updated_at
FROM public.raw_report_uploads
GROUP BY organization_id, store_id
ORDER BY row_count DESC NULLS LAST;

-- import_report_registry — uncomment only when `public.import_report_registry` exists.
-- SELECT
--   'import_report_registry'::text AS tbl,
--   organization_id,
--   store_id,
--   COUNT(*)::bigint AS row_count,
--   MAX(created_at) AS max_created_at,
--   MAX(updated_at) AS max_updated_at
-- FROM public.import_report_registry
-- GROUP BY organization_id, store_id
-- ORDER BY row_count DESC NULLS LAST;
