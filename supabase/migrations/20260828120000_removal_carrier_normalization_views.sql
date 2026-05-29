-- Carrier operational normalization + inventory views (no allocation/qty changes).

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_removal_carrier_operational(p_raw text)
RETURNS TABLE (
  operational text,
  status      text,
  token_count int
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $carr$
DECLARE
  v_work   text;
  v_part   text;
  v_tokens text[] := ARRAY[]::text[];
  v_dist   text[] := ARRAY[]::text[];
  v_lower  text;
  i        int;
  j        int;
  v_found  boolean;
BEGIN
  IF p_raw IS NULL OR btrim(p_raw) = '' THEN
    RETURN QUERY SELECT NULL::text, 'empty'::text, 0;
    RETURN;
  END IF;

  v_work := btrim(p_raw);
  FOR i IN 1..3 LOOP
    IF v_work ~ '^[\[\(\{<"''`]+.+\]\)\}>"''`]+$' THEN
      v_work := btrim(regexp_replace(v_work, '^[\[\(\{<"''`]+(.+)[\]\)\}>"''`]+$', '\1'));
    ELSE
      EXIT;
    END IF;
  END LOOP;

  FOREACH v_part IN ARRAY regexp_split_to_array(v_work, '[,;]+') LOOP
    v_part := btrim(v_part);
    IF v_part <> '' THEN
      v_tokens := array_append(v_tokens, v_part);
      v_lower := lower(v_part);
      v_found := false;
      IF coalesce(array_length(v_dist, 1), 0) > 0 THEN
        FOR j IN 1..coalesce(array_length(v_dist, 1), 0) LOOP
          IF lower(v_dist[j]) = v_lower THEN
            v_found := true;
            EXIT;
          END IF;
        END LOOP;
      END IF;
      IF NOT v_found THEN
        v_dist := array_append(v_dist, v_part);
      END IF;
    END IF;
  END LOOP;

  IF coalesce(array_length(v_tokens, 1), 0) = 0 THEN
    RETURN QUERY SELECT NULL::text, 'empty'::text, 0;
    RETURN;
  ELSIF coalesce(array_length(v_dist, 1), 0) > 1 THEN
    RETURN QUERY SELECT NULL::text, 'multi_conflict'::text, coalesce(array_length(v_dist, 1), 0);
    RETURN;
  ELSIF coalesce(array_length(v_tokens, 1), 0) > 1 THEN
    RETURN QUERY SELECT v_dist[1], 'deduped_repeated'::text, coalesce(array_length(v_tokens, 1), 0);
    RETURN;
  ELSE
    RETURN QUERY SELECT v_dist[1], 'single'::text, 1;
    RETURN;
  END IF;
END;
$carr$;

COMMENT ON FUNCTION public.normalize_removal_carrier_operational(text) IS
  'Operational carrier token for removal domain/expected/view rows. Case-insensitive dedupe; multi_conflict => NULL.';

DROP VIEW IF EXISTS public.v_inventory_status CASCADE;
DROP VIEW IF EXISTS public.v_inventory_item_status CASCADE;
DROP VIEW IF EXISTS public.v_scanned_items_counted CASCADE;

-- v_scanned_items_counted: normalized tracking + carrier (no split_part comma hack)
CREATE VIEW public.v_scanned_items_counted AS
WITH scanned_grouped AS (
  SELECT
    r.organization_id,
    r.store_id,
    tn.operational AS tracking_number,
    p.id_slip_contents AS slip_code,
    r.sku,
    r.fnsku,
    r.asin,
    car.operational AS carrier,
    max(COALESCE(p.created_at, r.created_at)) AS package_date,
    max(pl.order_id) AS order_id,
    count(*) AS total_scanned
  FROM public.return_items r
  LEFT JOIN public.packages p ON r.package_id = p.id
  LEFT JOIN public.pallets pl ON COALESCE(r.pallet_id, p.pallet_id) = pl.id
  LEFT JOIN LATERAL public.normalize_removal_tracking_operational(
    COALESCE(p.tracking_number, pl.tracking_number)
  ) tn ON TRUE
  LEFT JOIN LATERAL public.normalize_removal_carrier_operational(p.carrier_name) car ON TRUE
  GROUP BY
    r.organization_id,
    r.store_id,
    tn.operational,
    p.id_slip_contents,
    r.sku,
    r.fnsku,
    r.asin,
    car.operational
),
with_package_count AS (
  SELECT
    scanned_grouped.organization_id,
    scanned_grouped.store_id,
    scanned_grouped.tracking_number,
    scanned_grouped.slip_code,
    scanned_grouped.sku,
    scanned_grouped.fnsku,
    scanned_grouped.asin,
    scanned_grouped.carrier,
    scanned_grouped.package_date,
    scanned_grouped.order_id,
    scanned_grouped.total_scanned,
    CASE
      WHEN NULLIF(TRIM(BOTH FROM COALESCE(scanned_grouped.slip_code, ''::text)), ''::text) IS NULL THEN 0::bigint
      ELSE count(*) OVER (
        PARTITION BY
          scanned_grouped.organization_id,
          scanned_grouped.store_id,
          scanned_grouped.tracking_number,
          scanned_grouped.slip_code
      )
    END AS package_count
  FROM scanned_grouped
)
SELECT
  organization_id,
  store_id,
  tracking_number,
  slip_code,
  sku,
  fnsku,
  asin,
  carrier,
  package_date,
  order_id,
  total_scanned,
  package_count
FROM with_package_count;

CREATE VIEW public.v_inventory_item_status AS
WITH expected_totals AS (
  SELECT
    ep.organization_id,
    ep.store_id,
    tn.operational AS tracking_number,
    ep.id_slip_contents AS slip_code,
    ep.sku,
    ep.fnsku,
    NULL::text AS asin,
    NULL::text AS upc,
    NULL::text AS product_name,
    car.operational AS carrier,
    max(COALESCE(ep.shipment_date::timestamptz, ep.created_at)) AS package_date,
    max(ep.order_id) AS order_id,
    sum(ep.expected_scan_quantity)::numeric AS total_expected,
    0::numeric AS total_scanned
  FROM public.expected_packages ep
  LEFT JOIN LATERAL public.normalize_removal_tracking_operational(ep.tracking_number) tn ON TRUE
  LEFT JOIN LATERAL public.normalize_removal_carrier_operational(ep.carrier) car ON TRUE
  GROUP BY
    ep.organization_id,
    ep.store_id,
    tn.operational,
    ep.id_slip_contents,
    ep.sku,
    ep.fnsku,
    car.operational
),
scanned_totals AS (
  SELECT
    s.organization_id,
    s.store_id,
    s.tracking_number,
    s.slip_code,
    s.sku,
    s.fnsku,
    s.asin,
    NULL::text AS upc,
    NULL::text AS product_name,
    s.carrier,
    s.package_date,
    s.order_id,
    0::numeric AS total_expected,
    s.total_scanned::numeric AS total_scanned
  FROM public.v_scanned_items_counted s
),
combined_totals AS (
  SELECT * FROM expected_totals
  UNION ALL
  SELECT * FROM scanned_totals
),
item_grouped AS (
  SELECT
    combined_totals.organization_id,
    combined_totals.store_id,
    combined_totals.tracking_number,
    combined_totals.slip_code,
    max(combined_totals.order_id) AS order_id,
    combined_totals.sku,
    combined_totals.fnsku,
    max(combined_totals.asin) AS asin,
    max(combined_totals.upc) AS upc,
    max(combined_totals.product_name) AS product_name,
    max(combined_totals.carrier) AS carrier,
    max(combined_totals.package_date) AS package_date,
    sum(combined_totals.total_expected) AS total_expected,
    sum(combined_totals.total_scanned) AS total_scanned,
    CASE
      WHEN sum(combined_totals.total_expected) = 0::numeric AND sum(combined_totals.total_scanned) = 0::numeric THEN 'not_registered'::text
      WHEN sum(combined_totals.total_expected) = 0::numeric AND sum(combined_totals.total_scanned) > 0::numeric THEN 'in_progress_not'::text
      WHEN sum(combined_totals.total_expected) > 0::numeric AND sum(combined_totals.total_scanned) = 0::numeric THEN 'expected'::text
      WHEN sum(combined_totals.total_expected) > 0::numeric AND sum(combined_totals.total_scanned) < sum(combined_totals.total_expected) THEN 'in_progress'::text
      WHEN sum(combined_totals.total_expected) > 0::numeric AND sum(combined_totals.total_scanned) = sum(combined_totals.total_expected) THEN 'complete'::text
      WHEN sum(combined_totals.total_expected) > 0::numeric AND sum(combined_totals.total_scanned) > sum(combined_totals.total_expected) THEN 'unexpected'::text
      ELSE 'not_registered'::text
    END AS status
  FROM combined_totals
  GROUP BY
    combined_totals.organization_id,
    combined_totals.store_id,
    combined_totals.tracking_number,
    combined_totals.slip_code,
    combined_totals.sku,
    combined_totals.fnsku
),
with_package_count AS (
  SELECT
    item_grouped.*,
    CASE
      WHEN NULLIF(TRIM(BOTH FROM COALESCE(item_grouped.slip_code, ''::text)), ''::text) IS NULL THEN 0::bigint
      ELSE count(*) OVER (
        PARTITION BY
          item_grouped.organization_id,
          item_grouped.store_id,
          item_grouped.tracking_number,
          item_grouped.slip_code
      )
    END AS package_count
  FROM item_grouped
)
SELECT
  organization_id,
  store_id,
  tracking_number,
  slip_code,
  order_id,
  sku,
  fnsku,
  asin,
  upc,
  product_name,
  carrier,
  package_date,
  total_expected,
  total_scanned,
  status,
  package_count
FROM with_package_count;

CREATE VIEW public.v_inventory_status AS
SELECT
  organization_id,
  store_id,
  tracking_number,
  slip_code,
  max(order_id) AS order_id,
  max(package_date) AS package_date,
  max(carrier) AS carrier,
  sum(total_expected) AS total_expected,
  sum(total_scanned) AS total_scanned,
  CASE
    WHEN sum(total_expected) = 0::numeric AND sum(total_scanned) = 0::numeric THEN 'not_registered'::text
    WHEN sum(total_expected) = 0::numeric AND sum(total_scanned) > 0::numeric THEN 'in_progress_not'::text
    WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) = 0::numeric THEN 'expected'::text
    WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) < sum(total_expected) THEN 'in_progress'::text
    WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) = sum(total_expected) THEN 'complete'::text
    WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) > sum(total_expected) THEN 'unexpected'::text
    ELSE 'not_registered'::text
  END AS status
FROM public.v_inventory_item_status
GROUP BY organization_id, store_id, tracking_number, slip_code;

COMMENT ON VIEW public.v_scanned_items_counted IS
  'Neda inventory: scanned return_items; operational tracking/carrier via normalize_removal_* helpers.';
COMMENT ON VIEW public.v_inventory_item_status IS
  'Neda inventory: expected_packages ∪ scanned; operational tracking/carrier normalized at read time.';
COMMENT ON VIEW public.v_inventory_status IS
  'Neda inventory: package-level status rollup (V180 shape; carrier/tracking normalized).';

NOTIFY pgrst, 'reload schema';

COMMIT;
