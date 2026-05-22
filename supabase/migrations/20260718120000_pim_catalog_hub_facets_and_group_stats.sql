-- Section C: PIM catalog filter facets + identifier group summary stats (RPC only).
-- Non-destructive: functions + grants only.
-- Depends on: public.products, public.vendors, public.product_categories,
--              public.product_identifier_map (same as pim_catalog_products_page).
-- Idempotent: (re)defines pim_ui_label_invalid so this file can apply without 20260717120000.

BEGIN;

CREATE OR REPLACE FUNCTION public.pim_ui_label_invalid(p_raw text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $f$
  SELECT
    CASE
      WHEN nullif(btrim(p_raw), '') IS NULL THEN true
      WHEN lower(btrim(p_raw)) IN (
        'unknown', 'n/a', 'na', '-', '--', 'none', 'null', 'tbd', 'pending',
        'misc', 'other', 'sku', 'asin', 'upc', 'fnsku'
      ) THEN true
      WHEN btrim(p_raw) ~* '^(#\s*value!\s*|#\s*n/?a\s*|#\s*ref!\s*|#\s*num!\s*|#\s*div/0!\s*)$' THEN true
      WHEN btrim(p_raw) ~ '^[0-9]+$' THEN true
      WHEN btrim(p_raw) ~ '^[0-9]{8,14}$' THEN true
      WHEN btrim(p_raw) ~* '^B0[A-Z0-9]{8}$' THEN true
      WHEN length(btrim(p_raw)) = 10 AND btrim(p_raw) ~ '^[A-Z0-9]{10}$' THEN true
      WHEN btrim(p_raw) ~* '^X[A-Z0-9]{9,}$' THEN true
      ELSE false
    END;
$f$;

COMMENT ON FUNCTION public.pim_ui_label_invalid(text) IS
  'Heuristic: spreadsheet-error / placeholder / bare-id text (vendors, categories, or bad identifier cells).';

-- One round-trip for PIM Hub filter dropdowns + invalid-label audit rows (server-side split).
CREATE OR REPLACE FUNCTION public.pim_catalog_hub_facets(
  p_organization_id uuid,
  p_store_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH
  brands AS (
    SELECT coalesce(jsonb_agg(to_jsonb(b.b) ORDER BY b.b), '[]'::jsonb) AS j
    FROM (
      SELECT DISTINCT trim(both from p.brand) AS b
      FROM public.products p
      WHERE p.organization_id = p_organization_id
        AND p.store_id = p_store_id
        AND p.brand IS NOT NULL
        AND trim(both from p.brand) <> ''
    ) b
  ),
  statuses AS (
    SELECT coalesce(jsonb_agg(to_jsonb(s.s) ORDER BY s.s), '[]'::jsonb) AS j
    FROM (
      SELECT DISTINCT trim(both from p.status) AS s
      FROM public.products p
      WHERE p.organization_id = p_organization_id
        AND p.store_id = p_store_id
        AND p.status IS NOT NULL
        AND trim(both from p.status) <> ''
    ) s
  ),
  match_sources AS (
    SELECT coalesce(jsonb_agg(to_jsonb(x.m) ORDER BY x.m), '[]'::jsonb) AS j
    FROM (
      SELECT DISTINCT trim(both from m.match_source) AS m
      FROM public.product_identifier_map m
      WHERE m.organization_id = p_organization_id
        AND m.store_id = p_store_id
        AND m.match_source IS NOT NULL
        AND trim(both from m.match_source) <> ''
    ) x
  ),
  source_report_types AS (
    SELECT coalesce(jsonb_agg(to_jsonb(x.r) ORDER BY x.r), '[]'::jsonb) AS j
    FROM (
      SELECT DISTINCT trim(both from m.source_report_type) AS r
      FROM public.product_identifier_map m
      WHERE m.organization_id = p_organization_id
        AND m.store_id = p_store_id
        AND m.source_report_type IS NOT NULL
        AND trim(both from m.source_report_type) <> ''
    ) x
  ),
  vendor_counts AS (
    SELECT
      v.id,
      v.name,
      count(p.id) FILTER (
        WHERE p.id IS NOT NULL
      )::bigint AS product_count
    FROM public.vendors v
    LEFT JOIN public.products p
      ON p.vendor_id = v.id
     AND p.organization_id = p_organization_id
     AND p.store_id = p_store_id
    WHERE v.organization_id = p_organization_id
    GROUP BY v.id, v.name
  ),
  vendors_valid AS (
    SELECT coalesce(jsonb_agg(to_jsonb(vc) ORDER BY lower(vc.name)), '[]'::jsonb) AS j
    FROM (
      SELECT id, name, product_count
      FROM vendor_counts
      WHERE NOT public.pim_ui_label_invalid(name)
    ) vc
  ),
  vendors_invalid AS (
    SELECT coalesce(jsonb_agg(to_jsonb(vc) ORDER BY lower(vc.name)), '[]'::jsonb) AS j
    FROM (
      SELECT id, name, product_count
      FROM vendor_counts
      WHERE public.pim_ui_label_invalid(name)
    ) vc
  ),
  category_counts AS (
    SELECT
      c.id,
      c.name,
      count(p.id) FILTER (
        WHERE p.id IS NOT NULL
      )::bigint AS product_count
    FROM public.product_categories c
    LEFT JOIN public.products p
      ON p.category_id = c.id
     AND p.organization_id = p_organization_id
     AND p.store_id = p_store_id
    WHERE c.organization_id = p_organization_id
    GROUP BY c.id, c.name
  ),
  categories_valid AS (
    SELECT coalesce(jsonb_agg(to_jsonb(cc) ORDER BY lower(cc.name)), '[]'::jsonb) AS j
    FROM (
      SELECT id, name, product_count
      FROM category_counts
      WHERE NOT public.pim_ui_label_invalid(name)
    ) cc
  ),
  categories_invalid AS (
    SELECT coalesce(jsonb_agg(to_jsonb(cc) ORDER BY lower(cc.name)), '[]'::jsonb) AS j
    FROM (
      SELECT id, name, product_count
      FROM category_counts
      WHERE public.pim_ui_label_invalid(name)
    ) cc
  )
  SELECT jsonb_build_object(
    'brands', (SELECT j FROM brands),
    'statuses', (SELECT j FROM statuses),
    'match_sources', (SELECT j FROM match_sources),
    'source_report_types', (SELECT j FROM source_report_types),
    'vendors_for_filters', (SELECT j FROM vendors_valid),
    'vendors_invalid_audit', (SELECT j FROM vendors_invalid),
    'categories_for_filters', (SELECT j FROM categories_valid),
    'categories_invalid_audit', (SELECT j FROM categories_invalid)
  );
$fn$;

COMMENT ON FUNCTION public.pim_catalog_hub_facets(uuid, uuid) IS
  'PIM Hub: distinct facet strings + vendor/category rows with store-scoped product_count, split for filters vs invalid-label audit.';

GRANT EXECUTE ON FUNCTION public.pim_catalog_hub_facets(uuid, uuid) TO service_role;

-- Aggregate stats for identifier groups (all modes) from product_identifier_map; distinct product_id per mode.
CREATE OR REPLACE FUNCTION public.pim_catalog_identifier_group_stats(
  p_organization_id uuid,
  p_store_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH m AS (
    SELECT
      m.product_id,
      nullif(btrim(m.seller_sku), '') AS sk,
      nullif(btrim(m.asin), '') AS asin,
      nullif(btrim(m.fnsku), '') AS fn,
      nullif(btrim(m.upc_code), '') AS upc
    FROM public.product_identifier_map m
    WHERE m.organization_id = p_organization_id
      AND m.store_id = p_store_id
      AND m.product_id IS NOT NULL
  ),
  per_mode AS (
    SELECT
      'seller_sku'::text AS mode,
      count(DISTINCT sk) FILTER (
        WHERE sk IS NOT NULL AND NOT public.pim_ui_label_invalid(sk)
      )::bigint AS group_count,
      count(DISTINCT product_id) FILTER (
        WHERE sk IS NOT NULL AND NOT public.pim_ui_label_invalid(sk)
      )::bigint AS distinct_product_count
    FROM m
    UNION ALL
    SELECT
      'asin'::text,
      count(DISTINCT asin) FILTER (
        WHERE asin IS NOT NULL AND NOT public.pim_ui_label_invalid(asin)
      )::bigint,
      count(DISTINCT product_id) FILTER (
        WHERE asin IS NOT NULL AND NOT public.pim_ui_label_invalid(asin)
      )::bigint
    FROM m
    UNION ALL
    SELECT
      'fnsku'::text,
      count(DISTINCT fn) FILTER (
        WHERE fn IS NOT NULL AND NOT public.pim_ui_label_invalid(fn)
      )::bigint,
      count(DISTINCT product_id) FILTER (
        WHERE fn IS NOT NULL AND NOT public.pim_ui_label_invalid(fn)
      )::bigint
    FROM m
    UNION ALL
    SELECT
      'upc_code'::text,
      count(DISTINCT upc) FILTER (
        WHERE upc IS NOT NULL AND NOT public.pim_ui_label_invalid(upc)
      )::bigint,
      count(DISTINCT product_id) FILTER (
        WHERE upc IS NOT NULL AND NOT public.pim_ui_label_invalid(upc)
      )::bigint
    FROM m
  )
  SELECT coalesce(
    jsonb_object_agg(
      mode,
      jsonb_build_object(
        'group_count', group_count,
        'distinct_product_count', distinct_product_count
      )
    ),
    '{}'::jsonb
  )
  FROM per_mode;
$fn$;

COMMENT ON FUNCTION public.pim_catalog_identifier_group_stats(uuid, uuid) IS
  'Per identifier column on product_identifier_map: number of distinct non-junk group keys and distinct product_id touching those keys.';

GRANT EXECUTE ON FUNCTION public.pim_catalog_identifier_group_stats(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
