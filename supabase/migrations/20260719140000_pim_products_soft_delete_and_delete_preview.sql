-- PIM products: soft-delete column, catalog RPCs respect active rows, bulk delete preview + safe deletes.
-- Soft delete = default (deleted_at). Hard delete = single product only; requires zero dependencies OR p_confirm_hard.

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.products.deleted_at IS
  'Soft-delete: when set, product is hidden from PIM catalog RPCs; child map/price rows may remain until hard delete.';

CREATE INDEX IF NOT EXISTS idx_products_org_store_active
  ON public.products (organization_id, store_id)
  WHERE deleted_at IS NULL;

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
  'True when text looks like a spreadsheet error, placeholder, or bare identifier — not a normal vendor/category label.';

CREATE OR REPLACE FUNCTION public.pim_catalog_identifier_groups(
  p_organization_id uuid,
  p_store_id uuid,
  p_mode text,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_lim integer;
  v_off integer;
  v_mode text;
  v_total bigint;
  v_rows jsonb;
BEGIN
  v_mode := lower(trim(coalesce(p_mode, '')));
  IF v_mode NOT IN ('seller_sku', 'asin', 'fnsku', 'upc_code') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'p_mode must be seller_sku, asin, fnsku, or upc_code',
      'total', 0,
      'page', greatest(coalesce(p_page, 1), 1),
      'page_size', 50,
      'rows', '[]'::jsonb
    );
  END IF;

  v_lim := CASE
    WHEN coalesce(p_page_size, 50) IN (25, 50, 100) THEN coalesce(p_page_size, 50)
    ELSE 50
  END;
  v_off := (greatest(coalesce(p_page, 1), 1) - 1) * v_lim;

  WITH keyed AS (
    SELECT
      CASE v_mode
        WHEN 'seller_sku' THEN nullif(btrim(m.seller_sku), '')
        WHEN 'asin' THEN nullif(btrim(m.asin), '')
        WHEN 'fnsku' THEN nullif(btrim(m.fnsku), '')
        WHEN 'upc_code' THEN nullif(btrim(m.upc_code), '')
      END AS k,
      m.product_id
    FROM public.product_identifier_map m
    INNER JOIN public.products p
      ON p.id = m.product_id
      AND p.organization_id = m.organization_id
      AND p.store_id = m.store_id
    WHERE m.organization_id = p_organization_id
      AND m.store_id = p_store_id
      AND m.product_id IS NOT NULL
      AND p.deleted_at IS NULL
  ),
  filtered AS (
    SELECT k, product_id
    FROM keyed
    WHERE k IS NOT NULL
      AND NOT public.pim_ui_label_invalid(k)
  ),
  agg AS (
    SELECT k AS group_key, count(DISTINCT product_id)::bigint AS product_count
    FROM filtered
    GROUP BY k
  ),
  ranked AS (
    SELECT
      group_key,
      product_count,
      row_number() OVER (ORDER BY product_count DESC, group_key ASC) AS rn
    FROM agg
  )
  SELECT count(*)::bigint INTO v_total FROM agg;

  SELECT coalesce(
    (
      SELECT jsonb_agg(jsonb_build_object('group_key', r.group_key, 'product_count', r.product_count) ORDER BY r.rn)
      FROM ranked r
      WHERE r.rn > v_off AND r.rn <= v_off + v_lim
    ),
    '[]'::jsonb
  )
  INTO v_rows;

  RETURN jsonb_build_object(
    'ok', true,
    'mode', v_mode,
    'total', coalesce(v_total, 0),
    'page', greatest(coalesce(p_page, 1), 1),
    'page_size', v_lim,
    'rows', coalesce(v_rows, '[]'::jsonb)
  );
END;
$fn$;

COMMENT ON FUNCTION public.pim_catalog_identifier_groups(uuid, uuid, text, integer, integer) IS
  'PIM Hub: paginated identifier groups from product_identifier_map; product_count uses DISTINCT product_id; excludes soft-deleted products.';

GRANT EXECUTE ON FUNCTION public.pim_catalog_identifier_groups(uuid, uuid, text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.pim_catalog_products_page(
  p_organization_id uuid,
  p_store_id uuid,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 25,
  p_q text DEFAULT NULL,
  p_vendor_id uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_brand text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_match_source text DEFAULT NULL,
  p_source_report_type text DEFAULT NULL,
  p_missing_image boolean DEFAULT FALSE,
  p_missing_asin boolean DEFAULT FALSE,
  p_missing_fnsku boolean DEFAULT FALSE,
  p_sort_column text DEFAULT 'updated_at',
  p_sort_dir text DEFAULT 'desc'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_off integer;
  v_lim integer;
  v_dir text;
  v_q text;
  v_rows jsonb;
  v_order text;
  v_sql text;
  v_q_pred text;
  v_pat text;
BEGIN
  v_lim := CASE
    WHEN p_page_size IN (25, 50, 100) THEN p_page_size
    ELSE 25
  END;
  v_off := (GREATEST(COALESCE(p_page, 1), 1) - 1) * v_lim;
  v_dir := CASE WHEN lower(trim(COALESCE(p_sort_dir, 'desc'))) = 'asc' THEN 'ASC' ELSE 'DESC' END;
  v_q := NULLIF(trim(COALESCE(p_q, '')), '');

  v_order := CASE lower(trim(COALESCE(p_sort_column, 'updated_at')))
    WHEN 'product_name' THEN 'fp.product_name'
    WHEN 'sku' THEN 'fp.sku'
    WHEN 'asin' THEN 'fp.asin'
    WHEN 'fnsku' THEN 'fp.fnsku'
    WHEN 'upc' THEN 'COALESCE(NULLIF(btrim(fp.upc_code), ''''), NULLIF(btrim(fp.map_upc), ''''))'
    WHEN 'brand' THEN 'fp.brand'
    WHEN 'status' THEN 'fp.status'
    WHEN 'last_seen_at' THEN 'fp.last_seen_at'
    WHEN 'updated_at' THEN 'fp.updated_at'
    WHEN 'vendor' THEN 'fp.vendor_name_sort'
    WHEN 'category' THEN 'fp.category_name_sort'
    WHEN 'latest_price' THEN 'fp.latest_price_amount'
    ELSE 'fp.updated_at'
  END;

  IF v_q IS NULL THEN
    v_q_pred := 'true';
  ELSE
    v_pat := '%' || replace(replace(replace(v_q, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
    v_q_pred := format(
      $e$(
        p.product_name ILIKE %L ESCAPE E'\\'
        OR p.sku ILIKE %L ESCAPE E'\\'
        OR p.asin ILIKE %L ESCAPE E'\\'
        OR p.fnsku ILIKE %L ESCAPE E'\\'
        OR p.upc_code ILIKE %L ESCAPE E'\\'
        OR p.brand ILIKE %L ESCAPE E'\\'
        OR p.vendor_name ILIKE %L ESCAPE E'\\'
        OR v.name ILIKE %L ESCAPE E'\\'
        OR c.name ILIKE %L ESCAPE E'\\'
        OR pim.seller_sku ILIKE %L ESCAPE E'\\'
        OR pim.pim_asin ILIKE %L ESCAPE E'\\'
        OR pim.pim_fnsku ILIKE %L ESCAPE E'\\'
        OR pim.pim_upc ILIKE %L ESCAPE E'\\'
      )$e$,
      v_pat, v_pat, v_pat, v_pat, v_pat, v_pat, v_pat, v_pat, v_pat,
      v_pat, v_pat, v_pat, v_pat
    );
  END IF;

  v_sql := format(
    $q$
    WITH pim_primary AS (
      SELECT DISTINCT ON (m.product_id)
        m.product_id,
        m.id AS pim_id,
        m.seller_sku,
        m.asin AS pim_asin,
        m.fnsku AS pim_fnsku,
        m.upc_code AS pim_upc,
        m.match_source,
        m.source_report_type,
        m.source_upload_id
      FROM public.product_identifier_map m
      WHERE m.organization_id = %L::uuid
        AND m.store_id = %L::uuid
        AND m.product_id IS NOT NULL
      ORDER BY
        m.product_id,
        m.is_primary DESC NULLS LAST,
        m.last_seen_at DESC NULLS LAST,
        m.id
    ),
    price_latest AS (
      SELECT DISTINCT ON (pp.product_id)
        pp.product_id,
        pp.amount AS latest_price_amount,
        pp.currency AS latest_price_currency,
        pp.observed_at AS latest_price_observed_at
      FROM public.product_prices pp
      WHERE pp.organization_id = %L::uuid
        AND pp.store_id = %L::uuid
      ORDER BY pp.product_id, pp.observed_at DESC NULLS LAST, pp.id DESC
    ),
    fp AS (
      SELECT
        p.id,
        p.organization_id,
        p.store_id,
        p.product_name,
        p.sku,
        p.asin,
        p.fnsku,
        p.upc_code,
        p.brand,
        p.status,
        p.vendor_id,
        COALESCE(NULLIF(btrim(p.vendor_name), ''), v.name) AS vendor_name,
        COALESCE(v.name, '') AS vendor_name_sort,
        p.category_id,
        c.name AS category_name,
        COALESCE(c.name, '') AS category_name_sort,
        p.main_image_url,
        p.amazon_raw,
        p.metadata,
        p.mfg_part_number,
        p.condition,
        p.last_seen_at,
        p.updated_at,
        pim.seller_sku AS map_seller_sku,
        pim.pim_asin AS map_asin,
        pim.pim_fnsku AS map_fnsku,
        pim.pim_upc AS map_upc,
        pim.match_source,
        pim.source_report_type,
        pim.source_upload_id,
        pl.latest_price_amount,
        pl.latest_price_currency,
        pl.latest_price_observed_at,
        COALESCE(
          NULLIF(btrim(p.main_image_url), ''),
          NULLIF(btrim(p.amazon_raw ->> 'main_image_url'), ''),
          NULLIF(btrim(p.amazon_raw #>> '{main_image_url}'), '')
        ) AS display_image_url
      FROM public.products p
      LEFT JOIN public.vendors v ON v.id = p.vendor_id
      LEFT JOIN public.product_categories c ON c.id = p.category_id
      LEFT JOIN pim_primary pim ON pim.product_id = p.id
      LEFT JOIN price_latest pl ON pl.product_id = p.id
      WHERE p.organization_id = %L::uuid
        AND p.store_id = %L::uuid
        AND p.deleted_at IS NULL
        AND (%L::uuid IS NULL OR p.vendor_id = %L::uuid)
        AND (%L::uuid IS NULL OR p.category_id = %L::uuid)
        AND (%L::text IS NULL OR trim(%L::text) = '' OR p.brand ILIKE ('%%' || trim(%L::text) || '%%'))
        AND (%L::text IS NULL OR trim(%L::text) = '' OR p.status IS NOT DISTINCT FROM trim(%L::text))
        AND (%L::text IS NULL OR trim(%L::text) = '' OR pim.match_source IS NOT DISTINCT FROM trim(%L::text))
        AND (%L::text IS NULL OR trim(%L::text) = '' OR pim.source_report_type IS NOT DISTINCT FROM trim(%L::text))
        AND (
          NOT COALESCE(%L::boolean, FALSE)
          OR (
            (p.main_image_url IS NULL OR btrim(p.main_image_url) = '')
            AND (
              p.amazon_raw IS NULL
              OR (
                COALESCE(btrim(p.amazon_raw ->> 'main_image_url'), '') = ''
                AND COALESCE(btrim(p.amazon_raw #>> '{main_image_url}'), '') = ''
              )
            )
          )
        )
        AND (
          NOT COALESCE(%L::boolean, FALSE)
          OR (
            COALESCE(btrim(p.asin), '') = ''
            AND COALESCE(btrim(pim.pim_asin), '') = ''
          )
        )
        AND (
          NOT COALESCE(%L::boolean, FALSE)
          OR (
            COALESCE(btrim(p.fnsku), '') = ''
            AND COALESCE(btrim(pim.pim_fnsku), '') = ''
          )
        )
        AND (%s)
    ),
    counted AS (SELECT COUNT(*)::bigint AS c FROM fp)
    SELECT jsonb_build_object(
      'total', (SELECT c FROM counted),
      'rows', COALESCE((
        SELECT jsonb_agg((to_jsonb(s) - '_ord') ORDER BY s._ord)
        FROM (
          SELECT fp.*, row_number() OVER (ORDER BY %s %s, fp.id) AS _ord
          FROM fp
        ) s
        WHERE s._ord > %s AND s._ord <= %s
      ), '[]'::jsonb),
      'page', %s::int,
      'page_size', %s::int
    )
    $q$,
    p_organization_id,
    p_store_id,
    p_organization_id,
    p_store_id,
    p_organization_id,
    p_store_id,
    p_vendor_id,
    p_vendor_id,
    p_category_id,
    p_category_id,
    p_brand,
    p_brand,
    p_brand,
    p_status,
    p_status,
    p_status,
    p_match_source,
    p_match_source,
    p_match_source,
    p_source_report_type,
    p_source_report_type,
    p_source_report_type,
    p_missing_image,
    p_missing_asin,
    p_missing_fnsku,
    v_q_pred,
    v_order,
    v_dir,
    v_off,
    v_off + v_lim,
    GREATEST(COALESCE(p_page, 1), 1),
    v_lim
  );

  EXECUTE v_sql INTO v_rows;
  RETURN COALESCE(v_rows, '{"total":0,"rows":[],"page":1,"page_size":25}'::jsonb);
END;
$fn$;

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
        AND p.deleted_at IS NULL
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
        AND p.deleted_at IS NULL
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
     AND p.deleted_at IS NULL
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
     AND p.deleted_at IS NULL
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
    INNER JOIN public.products p
      ON p.id = m.product_id
      AND p.organization_id = m.organization_id
      AND p.store_id = m.store_id
    WHERE m.organization_id = p_organization_id
      AND m.store_id = p_store_id
      AND m.product_id IS NOT NULL
      AND p.deleted_at IS NULL
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

COMMENT ON FUNCTION public.pim_catalog_products_page(
  uuid, uuid, integer, integer, text, uuid, uuid, text, text, text, text, boolean, boolean, boolean, text, text
) IS
  'PIM catalog grid: org+store scoped active (non-soft-deleted) products with primary map row, latest price, vendor/category names.';

COMMENT ON FUNCTION public.pim_catalog_hub_facets(uuid, uuid) IS
  'PIM Hub: facet strings + vendor/category counts from active products only; map facets unchanged.';

COMMENT ON FUNCTION public.pim_catalog_identifier_group_stats(uuid, uuid) IS
  'Identifier group summary stats for active (non-soft-deleted) products only.';

-- Preview: dependency row counts per product + aggregates (bulk-safe planning).
CREATE OR REPLACE FUNCTION public.pim_catalog_product_bulk_delete_preview(
  p_organization_id uuid,
  p_store_id uuid,
  p_product_ids uuid[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $prev$
  WITH ids AS (
    SELECT DISTINCT x AS id
    FROM unnest(coalesce(p_product_ids, '{}'::uuid[])) AS t(x)
  ),
  scoped AS (
    SELECT
      p.id,
      p.sku,
      p.product_name,
      p.deleted_at
    FROM public.products p
    INNER JOIN ids i ON i.id = p.id
    WHERE p.organization_id = p_organization_id
      AND p.store_id = p_store_id
  ),
  missing AS (
    SELECT coalesce(array_agg(i.id ORDER BY i.id), '{}'::uuid[]) AS arr
    FROM ids i
    WHERE NOT EXISTS (
      SELECT 1 FROM scoped s WHERE s.id = i.id
    )
  ),
  pim_c AS (
    SELECT m.product_id, count(*)::bigint AS c
    FROM public.product_identifier_map m
    INNER JOIN scoped s ON s.id = m.product_id
    WHERE m.organization_id = p_organization_id
      AND m.store_id = p_store_id
    GROUP BY m.product_id
  ),
  price_c AS (
    SELECT pp.product_id, count(*)::bigint AS c
    FROM public.product_prices pp
    INNER JOIN scoped s ON s.id = pp.product_id
    WHERE pp.organization_id = p_organization_id
      AND pp.store_id = p_store_id
    GROUP BY pp.product_id
  ),
  per AS (
    SELECT
      s.id,
      s.sku,
      s.product_name,
      s.deleted_at,
      coalesce(pc.c, 0)::bigint AS product_prices_rows,
      coalesce(pm.c, 0)::bigint AS product_identifier_map_rows,
      (coalesce(pc.c, 0) + coalesce(pm.c, 0))::bigint AS dependency_total,
      ((coalesce(pc.c, 0) + coalesce(pm.c, 0)) > 0) AS hard_delete_needs_confirm
    FROM scoped s
    LEFT JOIN pim_c pm ON pm.product_id = s.id
    LEFT JOIN price_c pc ON pc.product_id = s.id
  ),
  agg AS (
    SELECT
      coalesce(sum(product_prices_rows), 0)::bigint AS product_prices_rows,
      coalesce(sum(product_identifier_map_rows), 0)::bigint AS product_identifier_map_rows,
      coalesce(sum(dependency_total), 0)::bigint AS dependency_total
    FROM per
  )
  SELECT jsonb_build_object(
    'ok', true,
    'requested', (SELECT count(*)::bigint FROM ids),
    'resolved_in_scope', (SELECT count(*)::bigint FROM scoped),
    'unknown_or_out_of_scope_ids', (SELECT arr FROM missing),
    'already_soft_deleted', (SELECT count(*)::bigint FROM scoped WHERE deleted_at IS NOT NULL),
    'aggregate', (SELECT jsonb_build_object(
      'product_prices_rows', product_prices_rows,
      'product_identifier_map_rows', product_identifier_map_rows,
      'dependency_total', dependency_total
    ) FROM agg),
    'per_product', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', id,
          'sku', sku,
          'product_name', product_name,
          'deleted_at', deleted_at,
          'product_prices_rows', product_prices_rows,
          'product_identifier_map_rows', product_identifier_map_rows,
          'dependency_total', dependency_total,
          'hard_delete_needs_confirm', hard_delete_needs_confirm
        )
        ORDER BY lower(coalesce(sku, '')), id
      )
      FROM per
    ), '[]'::jsonb)
  );
$prev$;

COMMENT ON FUNCTION public.pim_catalog_product_bulk_delete_preview(uuid, uuid, uuid[]) IS
  'Bulk delete planning: row counts on product_prices and product_identifier_map per product; hard_delete_needs_confirm when dependency_total > 0.';

GRANT EXECUTE ON FUNCTION public.pim_catalog_product_bulk_delete_preview(uuid, uuid, uuid[]) TO service_role;

-- Soft-delete (default): hide from PIM without removing child rows.
CREATE OR REPLACE FUNCTION public.pim_catalog_products_soft_delete(
  p_organization_id uuid,
  p_store_id uuid,
  p_product_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $sd$
DECLARE
  v_n integer;
BEGIN
  IF coalesce(cardinality(p_product_ids), 0) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'soft_deleted_count', 0);
  END IF;

  UPDATE public.products p
  SET
    deleted_at = now(),
    updated_at = now()
  FROM unnest(p_product_ids) AS u(id)
  WHERE p.id = u.id
    AND p.organization_id = p_organization_id
    AND p.store_id = p_store_id
    AND p.deleted_at IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'soft_deleted_count', v_n);
END;
$sd$;

COMMENT ON FUNCTION public.pim_catalog_products_soft_delete(uuid, uuid, uuid[]) IS
  'Sets deleted_at on org+store scoped products (idempotent for already soft-deleted rows).';

GRANT EXECUTE ON FUNCTION public.pim_catalog_products_soft_delete(uuid, uuid, uuid[]) TO service_role;

-- Hard-delete one product: allowed when no dependent rows OR p_confirm_hard.
CREATE OR REPLACE FUNCTION public.pim_catalog_product_hard_delete(
  p_organization_id uuid,
  p_store_id uuid,
  p_product_id uuid,
  p_confirm_hard boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $hd$
DECLARE
  v_exists boolean;
  v_pim bigint;
  v_price bigint;
  v_total bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.products p
    WHERE p.id = p_product_id
      AND p.organization_id = p_organization_id
      AND p.store_id = p_store_id
  )
  INTO v_exists;

  IF NOT v_exists THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Product not found for this organization and store.'
    );
  END IF;

  SELECT count(*) INTO v_pim
  FROM public.product_identifier_map m
  WHERE m.organization_id = p_organization_id
    AND m.store_id = p_store_id
    AND m.product_id = p_product_id;

  SELECT count(*) INTO v_price
  FROM public.product_prices pp
  WHERE pp.organization_id = p_organization_id
    AND pp.store_id = p_store_id
    AND pp.product_id = p_product_id;

  v_total := v_pim + v_price;

  IF v_total > 0 AND NOT coalesce(p_confirm_hard, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'confirm_hard_required',
      'message', 'Hard delete would remove dependent rows; pass p_confirm_hard true after operator review.',
      'dependencies', jsonb_build_object(
        'product_identifier_map_rows', v_pim,
        'product_prices_rows', v_price,
        'dependency_total', v_total
      )
    );
  END IF;

  DELETE FROM public.product_identifier_map m
  WHERE m.organization_id = p_organization_id
    AND m.store_id = p_store_id
    AND m.product_id = p_product_id;

  DELETE FROM public.products p
  WHERE p.id = p_product_id
    AND p.organization_id = p_organization_id
    AND p.store_id = p_store_id;

  RETURN jsonb_build_object(
    'ok', true,
    'hard_deleted', true,
    'removed_product_identifier_map_rows', v_pim,
    'removed_product_prices_rows', v_price
  );
END;
$hd$;

COMMENT ON FUNCTION public.pim_catalog_product_hard_delete(uuid, uuid, uuid, boolean) IS
  'Physically removes one product when dependency_total is zero, or when p_confirm_hard is true (cascade drops product_prices via FK).';

GRANT EXECUTE ON FUNCTION public.pim_catalog_product_hard_delete(uuid, uuid, uuid, boolean) TO service_role;

GRANT EXECUTE ON FUNCTION public.pim_catalog_products_page(
  uuid, uuid, integer, integer, text, uuid, uuid, text, text, text, text, boolean, boolean, boolean, text, text
) TO service_role;

GRANT EXECUTE ON FUNCTION public.pim_catalog_hub_facets(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pim_catalog_identifier_group_stats(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
