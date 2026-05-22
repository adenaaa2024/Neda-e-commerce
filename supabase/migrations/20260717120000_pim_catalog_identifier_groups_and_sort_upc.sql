-- PIM UI: identifier groups from product_identifier_map + UPC column sort on catalog page.
-- Runs after 20260710120000_pim_catalog_products_page.

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
    WHERE m.organization_id = p_organization_id
      AND m.store_id = p_store_id
      AND m.product_id IS NOT NULL
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
  'PIM Hub: paginated identifier groups from product_identifier_map; product_count uses DISTINCT product_id.';

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

NOTIFY pgrst, 'reload schema';

COMMIT;
