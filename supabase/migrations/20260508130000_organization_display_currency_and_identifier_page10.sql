-- Catalog UI: org-level default display currency for prices; fix identifier groups page_size=10 handling.

BEGIN;

ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS display_currency_code text NOT NULL DEFAULT 'USD';

COMMENT ON COLUMN public.organization_settings.display_currency_code IS
  'ISO 4217 code used when formatting catalog prices if the row has no currency (Settings → General).';

-- pim_catalog_identifier_groups: API allows page_size 10 but function mapped unknown sizes to 50 only for 25/50/100.
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
  SELECT
    (SELECT count(*)::bigint FROM agg),
    coalesce(
      (
        SELECT jsonb_agg(jsonb_build_object('group_key', r.group_key, 'product_count', r.product_count) ORDER BY r.rn)
        FROM ranked r
        WHERE r.rn > v_off AND r.rn <= v_off + v_lim
      ),
      '[]'::jsonb
    )
  INTO v_total, v_rows;

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

COMMIT;
