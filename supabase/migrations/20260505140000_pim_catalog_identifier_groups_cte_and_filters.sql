-- Fix pim_catalog_identifier_groups: WITH scope (ranked) + UPC groups must not use pim_ui_label_invalid on digits.
-- Extend pim_catalog_products_page: page sizes 10/25/50/100, tri-state field filters (replace missing_* booleans).
-- Fix pim_catalog_identifier_group_stats UPC counts (same UPC logic).

BEGIN;

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
    WHEN coalesce(p_page_size, 50) IN (10, 25, 50, 100) THEN coalesce(p_page_size, 50)
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
      AND (
        (v_mode = 'upc_code' AND length(k) BETWEEN 8 AND 14 AND k ~ '^[0-9]+$')
        OR (v_mode <> 'upc_code' AND NOT public.pim_ui_label_invalid(k))
      )
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
  ),
  summary AS (
    SELECT
      (SELECT count(*)::bigint FROM agg) AS total,
      (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object('group_key', r.group_key, 'product_count', r.product_count)
            ORDER BY r.rn
          ),
          '[]'::jsonb
        )
        FROM ranked r
        WHERE r.rn > v_off AND r.rn <= v_off + v_lim
      ) AS rows_json
  )
  SELECT s.total, s.rows_json INTO v_total, v_rows FROM summary s;

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
  'PIM Hub: paginated identifier groups from product_identifier_map; DISTINCT product_id; soft-delete excluded; UPC uses digit GTIN filter (not pim_ui_label_invalid).';

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
        WHERE upc IS NOT NULL
          AND length(upc) BETWEEN 8 AND 14
          AND upc ~ '^[0-9]+$'
      )::bigint,
      count(DISTINCT product_id) FILTER (
        WHERE upc IS NOT NULL
          AND length(upc) BETWEEN 8 AND 14
          AND upc ~ '^[0-9]+$'
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
  p_image_filter text DEFAULT 'any',
  p_sku_filter text DEFAULT 'any',
  p_asin_filter text DEFAULT 'any',
  p_fnsku_filter text DEFAULT 'any',
  p_upc_filter text DEFAULT 'any',
  p_vendor_presence text DEFAULT 'any',
  p_category_presence text DEFAULT 'any',
  p_brand_field_filter text DEFAULT 'any',
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
  v_img text;
  v_sku text;
  v_asin text;
  v_fn text;
  v_upc text;
  v_vpres text;
  v_cpres text;
  v_bpres text;
BEGIN
  v_lim := CASE
    WHEN p_page_size IN (10, 25, 50, 100) THEN p_page_size
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

  v_img := CASE lower(nullif(trim(p_image_filter), ''))
    WHEN 'missing' THEN $e$(
      (p.main_image_url IS NULL OR btrim(p.main_image_url) = '')
      AND (
        p.amazon_raw IS NULL
        OR (
          COALESCE(btrim(p.amazon_raw ->> 'main_image_url'), '') = ''
          AND COALESCE(btrim(p.amazon_raw #>> '{main_image_url}'), '') = ''
        )
      )
    )$e$
    WHEN 'has' THEN $e$NOT (
      (p.main_image_url IS NULL OR btrim(p.main_image_url) = '')
      AND (
        p.amazon_raw IS NULL
        OR (
          COALESCE(btrim(p.amazon_raw ->> 'main_image_url'), '') = ''
          AND COALESCE(btrim(p.amazon_raw #>> '{main_image_url}'), '') = ''
        )
      )
    )$e$
    ELSE 'true'
  END;

  v_sku := CASE lower(nullif(trim(p_sku_filter), ''))
    WHEN 'missing' THEN $e$(COALESCE(btrim(p.sku), '') = '' AND COALESCE(btrim(pim.seller_sku), '') = '')$e$
    WHEN 'has' THEN $e$(COALESCE(btrim(p.sku), '') <> '' OR COALESCE(btrim(pim.seller_sku), '') <> '')$e$
    ELSE 'true'
  END;

  v_asin := CASE lower(nullif(trim(p_asin_filter), ''))
    WHEN 'missing' THEN $e$(COALESCE(btrim(p.asin), '') = '' AND COALESCE(btrim(pim.pim_asin), '') = '')$e$
    WHEN 'has' THEN $e$(COALESCE(btrim(p.asin), '') <> '' OR COALESCE(btrim(pim.pim_asin), '') <> '')$e$
    ELSE 'true'
  END;

  v_fn := CASE lower(nullif(trim(p_fnsku_filter), ''))
    WHEN 'missing' THEN $e$(COALESCE(btrim(p.fnsku), '') = '' AND COALESCE(btrim(pim.pim_fnsku), '') = '')$e$
    WHEN 'has' THEN $e$(COALESCE(btrim(p.fnsku), '') <> '' OR COALESCE(btrim(pim.pim_fnsku), '') <> '')$e$
    ELSE 'true'
  END;

  v_upc := CASE lower(nullif(trim(p_upc_filter), ''))
    WHEN 'missing' THEN $e$(
      COALESCE(btrim(p.upc_code), '') = ''
      AND COALESCE(btrim(pim.pim_upc), '') = ''
    )$e$
    WHEN 'has' THEN $e$(
      COALESCE(btrim(p.upc_code), '') <> ''
      OR COALESCE(btrim(pim.pim_upc), '') <> ''
    )$e$
    ELSE 'true'
  END;

  v_vpres := CASE lower(nullif(trim(p_vendor_presence), ''))
    WHEN 'missing' THEN $e$(p.vendor_id IS NULL)$e$
    WHEN 'has' THEN $e$(p.vendor_id IS NOT NULL)$e$
    ELSE 'true'
  END;

  v_cpres := CASE lower(nullif(trim(p_category_presence), ''))
    WHEN 'missing' THEN $e$(p.category_id IS NULL)$e$
    WHEN 'has' THEN $e$(p.category_id IS NOT NULL)$e$
    ELSE 'true'
  END;

  v_bpres := CASE lower(nullif(trim(p_brand_field_filter), ''))
    WHEN 'missing' THEN $e$(p.brand IS NULL OR btrim(p.brand) = '')$e$
    WHEN 'has' THEN $e$(p.brand IS NOT NULL AND btrim(p.brand) <> '')$e$
    ELSE 'true'
  END;

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
        AND (%s)
        AND (%s)
        AND (%s)
        AND (%s)
        AND (%s)
        AND (%s)
        AND (%s)
        AND (%s)
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
    v_img,
    v_sku,
    v_asin,
    v_fn,
    v_upc,
    v_vpres,
    v_cpres,
    v_bpres,
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

NOTIFY pgrst, 'reload schema';

COMMIT;
