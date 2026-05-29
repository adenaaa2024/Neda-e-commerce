-- Grouped allocation rebuild: detail_shipment rows per (detail + normalized tracking + carrier + date).
-- Prerequisite: operational tracking normalized on amazon_removal_shipments (no comma lists).

BEGIN;

-- ── 0) Collapse duplicate detail_remainder rows before remainder unique index ──
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY organization_id, source_detail_row_id
      ORDER BY rebuild_run_at DESC NULLS LAST, updated_at DESC
    ) AS rn
  FROM public.expected_packages
  WHERE build_source = 'detail_remainder'
)
DELETE FROM public.expected_packages ep
USING ranked r
WHERE ep.id = r.id AND r.rn > 1;

-- ── 1) Tracking normalizer (SQL mirror of lib/pipeline/removal-tracking-normalize.ts) ──
CREATE OR REPLACE FUNCTION public.normalize_removal_tracking_operational(p_raw text)
RETURNS TABLE (
  operational text,
  status      text,
  token_count int
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $norm$
DECLARE
  v_work   text;
  v_part   text;
  v_tokens text[] := ARRAY[]::text[];
  v_dist   text[] := ARRAY[]::text[];
  i        int;
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
      IF NOT (v_part = ANY (v_dist)) THEN
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
$norm$;

COMMENT ON FUNCTION public.normalize_removal_tracking_operational(text) IS
  'Operational tracking token for removal domain/expected rows. multi_conflict => operational NULL.';

-- ── 2) Lineage columns ───────────────────────────────────────────────────────
ALTER TABLE public.expected_packages
  ADD COLUMN IF NOT EXISTS allocation_group_key     text,
  ADD COLUMN IF NOT EXISTS source_shipment_row_ids  uuid[];

COMMENT ON COLUMN public.expected_packages.allocation_group_key IS
  'Stable key for detail_shipment grain: normalized tracking + carrier + shipment_date. NULL on detail_remainder.';
COMMENT ON COLUMN public.expected_packages.source_shipment_row_ids IS
  'All amazon_removal_shipments.id values rolled into this allocation group.';

-- ── 3) Partial unique indexes (replace per-shipment-id grain) ────────────────
DROP INDEX IF EXISTS public.uq_expected_packages_derived_pair;

CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_derived_shipment_group
  ON public.expected_packages (
    organization_id, source_detail_row_id, allocation_group_key
  )
  WHERE build_source = 'detail_shipment';

CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_derived_remainder
  ON public.expected_packages (
    organization_id, source_detail_row_id
  )
  WHERE build_source = 'detail_remainder';

-- ── 4) Grouped rebuild ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_expected_packages_from_removals(
  p_organization_id uuid,
  p_store_id uuid DEFAULT NULL
)
RETURNS TABLE (
  detail_lines_in_scope     bigint,
  matched_rows_upserted     bigint,
  remainder_rows_upserted   bigint,
  overflow_lines            bigint,
  obsolete_rows_deleted     bigint
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_run_at        timestamptz := now();
  v_detail_lines  bigint := 0;
  v_matched       bigint := 0;
  v_remainder     bigint := 0;
  v_overflow      bigint := 0;
  v_deleted       bigint := 0;
  v_rec           record;
  v_delta         integer;
BEGIN
  CREATE TEMP TABLE _rebuild_target ON COMMIT DROP AS
  WITH detail AS (
    SELECT
      d.id                                        AS detail_id,
      d.organization_id,
      d.store_id,
      d.upload_id                                 AS detail_upload_id,
      d.order_id,
      d.order_type,
      d.order_date,
      nullif(btrim(d.sku), '')                    AS sku,
      nullif(btrim(d.fnsku), '')                  AS fnsku,
      nullif(btrim(d.disposition), '')            AS disposition,
      COALESCE(d.shipped_quantity, 0)             AS detail_shipped_qty,
      d.requested_quantity,
      d.disposed_quantity,
      d.cancelled_quantity,
      d.in_process_quantity,
      d.removal_fee,
      d.currency,
      d.status                                        AS order_status
    FROM public.amazon_removals d
    WHERE d.organization_id = p_organization_id
      AND (p_store_id IS NULL OR d.store_id IS NOT DISTINCT FROM p_store_id)
      AND d.order_id IS NOT NULL
  ),
  shipment AS (
    SELECT
      s.id                                        AS shipment_id,
      s.organization_id,
      s.store_id,
      s.upload_id                                 AS shipment_upload_id,
      s.order_id,
      s.order_type,
      s.order_date,
      nullif(btrim(s.sku), '')                    AS sku,
      nullif(btrim(s.fnsku), '')                  AS fnsku,
      nullif(btrim(s.disposition), '')            AS disposition,
      COALESCE(s.shipped_quantity, 0)             AS shipment_shipped_qty,
      s.tracking_number                           AS tracking_number_raw,
      s.carrier,
      s.shipment_date
    FROM public.amazon_removal_shipments s
    WHERE s.organization_id = p_organization_id
      AND (p_store_id IS NULL OR s.store_id IS NOT DISTINCT FROM p_store_id)
  ),
  pair AS (
    SELECT
      d.detail_id,
      d.organization_id,
      d.store_id,
      d.detail_upload_id,
      d.order_id,
      d.order_type,
      d.order_date,
      d.sku,
      d.fnsku,
      d.disposition,
      d.detail_shipped_qty,
      d.requested_quantity,
      d.disposed_quantity,
      d.cancelled_quantity,
      d.in_process_quantity,
      d.removal_fee,
      d.currency,
      d.order_status,
      s.shipment_id,
      s.shipment_upload_id,
      s.shipment_shipped_qty,
      s.tracking_number_raw,
      s.carrier,
      s.shipment_date,
      n.operational                               AS tracking_operational,
      n.status                                    AS tracking_status
    FROM detail d
    LEFT JOIN shipment s
      ON s.organization_id = d.organization_id
     AND s.store_id    IS NOT DISTINCT FROM d.store_id
     AND s.order_id    IS NOT DISTINCT FROM d.order_id
     AND s.order_type  IS NOT DISTINCT FROM d.order_type
     AND s.order_date  IS NOT DISTINCT FROM d.order_date
     AND s.sku         IS NOT DISTINCT FROM d.sku
     AND s.fnsku       IS NOT DISTINCT FROM d.fnsku
     AND s.disposition IS NOT DISTINCT FROM d.disposition
    LEFT JOIN LATERAL public.normalize_removal_tracking_operational(s.tracking_number_raw) n ON TRUE
  ),
  agg AS (
    SELECT
      detail_id,
      count(*) FILTER (
        WHERE shipment_id IS NOT NULL
          AND coalesce(tracking_status, 'empty') <> 'multi_conflict'
      )                                                                AS shipment_count,
      sum(COALESCE(shipment_shipped_qty, 0)) FILTER (
        WHERE shipment_id IS NOT NULL
          AND coalesce(tracking_status, 'empty') <> 'multi_conflict'
      )                                                                AS shipment_total,
      max(detail_shipped_qty)                                          AS detail_total
    FROM pair
    GROUP BY detail_id
  ),
  matched_groups AS (
    SELECT
      p.organization_id,
      p.store_id,
      COALESCE(
        (array_agg(p.shipment_upload_id ORDER BY p.shipment_id)
          FILTER (WHERE p.shipment_upload_id IS NOT NULL))[1],
        (array_agg(p.detail_upload_id ORDER BY p.detail_id))[1]
      )                                                                AS upload_id,
      p.order_id,
      p.order_type,
      p.order_date,
      p.sku,
      p.fnsku,
      p.disposition,
      max(p.requested_quantity)                                        AS requested_quantity,
      max(p.detail_shipped_qty)                                      AS shipped_quantity,
      max(p.disposed_quantity)                                       AS disposed_quantity,
      max(p.cancelled_quantity)                                      AS cancelled_quantity,
      max(p.in_process_quantity)                                     AS in_process_quantity,
      max(p.removal_fee)                                             AS removal_fee,
      max(p.currency)                                                AS currency,
      max(p.order_status)                                            AS order_status,
      p.tracking_operational                                         AS tracking_number,
      p.carrier,
      p.shipment_date,
      p.detail_id                                                    AS source_detail_row_id,
      (array_agg(p.shipment_id ORDER BY p.shipment_id)
        FILTER (WHERE p.shipment_id IS NOT NULL))[1]                    AS source_shipment_row_id,
      array_agg(p.shipment_id ORDER BY p.shipment_id)
        FILTER (WHERE p.shipment_id IS NOT NULL)                       AS source_shipment_row_ids,
      max(p.detail_shipped_qty)                                      AS detail_shipped_quantity_total,
      sum(p.shipment_shipped_qty)::integer                           AS shipment_row_quantity,
      CASE
        WHEN max(a.shipment_total) > max(a.detail_total)
         AND max(a.shipment_total) > 0 THEN
          GREATEST(
            0,
            round(
              sum(p.shipment_shipped_qty)::numeric
              * max(a.detail_total)::numeric
              / max(a.shipment_total)::numeric
            )
          )::integer
        ELSE sum(p.shipment_shipped_qty)::integer
      END                                                            AS expected_scan_quantity,
      concat_ws('|',
        coalesce(p.tracking_operational, '__NO_TRACKING__'),
        coalesce(lower(btrim(p.carrier)), ''),
        coalesce(p.shipment_date::text, '')
      )                                                              AS allocation_group_key,
      'detail_shipment'::text                                        AS build_source,
      CASE
        WHEN max(a.shipment_total) > max(a.detail_total) THEN 'shipment_overflow_conflict'
        ELSE 'matched'
      END                                                            AS build_status,
      concat_ws('|',
        p.organization_id::text,
        COALESCE(p.store_id::text, ''),
        p.order_id,
        COALESCE(p.order_type, ''),
        COALESCE(p.order_date::text, ''),
        COALESCE(p.sku, ''),
        COALESCE(p.fnsku, ''),
        COALESCE(p.disposition, '')
      )                                                              AS detail_grouping_key
    FROM pair p
    JOIN agg a USING (detail_id)
    WHERE p.shipment_id IS NOT NULL
      AND coalesce(p.tracking_status, 'empty') <> 'multi_conflict'
    GROUP BY
      p.organization_id, p.store_id, p.order_id, p.order_type, p.order_date,
      p.sku, p.fnsku, p.disposition, p.detail_id,
      p.tracking_operational, p.carrier, p.shipment_date
  ),
  remainder_rows AS (
    SELECT DISTINCT ON (p.detail_id)
      p.organization_id,
      p.store_id,
      p.detail_upload_id                                              AS upload_id,
      p.order_id,
      p.order_type,
      p.order_date,
      p.sku,
      p.fnsku,
      p.disposition,
      p.requested_quantity,
      p.detail_shipped_qty                                            AS shipped_quantity,
      p.disposed_quantity,
      p.cancelled_quantity,
      p.in_process_quantity,
      p.removal_fee,
      p.currency,
      p.order_status,
      NULL::text                                                      AS tracking_number,
      NULL::text                                                      AS carrier,
      NULL::date                                                      AS shipment_date,
      p.detail_id                                                     AS source_detail_row_id,
      NULL::uuid                                                      AS source_shipment_row_id,
      NULL::uuid[]                                                    AS source_shipment_row_ids,
      p.detail_shipped_qty                                            AS detail_shipped_quantity_total,
      NULL::integer                                                   AS shipment_row_quantity,
      GREATEST(
        a.detail_total - COALESCE(a.shipment_total, 0),
        0
      )::integer                                                      AS expected_scan_quantity,
      NULL::text                                                      AS allocation_group_key,
      'detail_remainder'::text                                        AS build_source,
      CASE
        WHEN COALESCE(a.shipment_count, 0) = 0
         AND COALESCE(a.detail_total, 0) = 0
          THEN 'no_shipment_expected'
        ELSE 'awaiting_shipment_match'
      END                                                             AS build_status,
      concat_ws('|',
        p.organization_id::text,
        COALESCE(p.store_id::text, ''),
        p.order_id,
        COALESCE(p.order_type, ''),
        COALESCE(p.order_date::text, ''),
        COALESCE(p.sku, ''),
        COALESCE(p.fnsku, ''),
        COALESCE(p.disposition, '')
      )                                                               AS detail_grouping_key
    FROM pair p
    JOIN agg a USING (detail_id)
    WHERE COALESCE(a.shipment_count, 0) = 0
       OR a.detail_total > COALESCE(a.shipment_total, 0)
    ORDER BY p.detail_id
  )
  SELECT
    organization_id, store_id, upload_id,
    order_id, order_type, order_date, sku, fnsku, disposition,
    requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
    in_process_quantity, removal_fee, currency, order_status,
    tracking_number, carrier, shipment_date,
    source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
    detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
    allocation_group_key, build_source, build_status, detail_grouping_key
  FROM matched_groups
  UNION ALL
  SELECT
    organization_id, store_id, upload_id,
    order_id, order_type, order_date, sku, fnsku, disposition,
    requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
    in_process_quantity, removal_fee, currency, order_status,
    tracking_number, carrier, shipment_date,
    source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
    detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
    allocation_group_key, build_source, build_status, detail_grouping_key
  FROM remainder_rows;

  -- Reconcile remainder to detail_total - sum(detail_shipment groups) (fixes proportional round-down).
  UPDATE _rebuild_target r
  SET expected_scan_quantity = adj.remainder_qty
  FROM (
    SELECT
      source_detail_row_id,
      GREATEST(
        max(detail_shipped_quantity_total)
          - coalesce(sum(expected_scan_quantity) FILTER (WHERE build_source = 'detail_shipment'), 0),
        0
      )::integer AS remainder_qty
    FROM _rebuild_target
    GROUP BY source_detail_row_id
  ) adj
  WHERE r.build_source = 'detail_remainder'
    AND r.source_detail_row_id = adj.source_detail_row_id;

  DELETE FROM _rebuild_target r
  WHERE r.build_source = 'detail_remainder'
    AND COALESCE(r.expected_scan_quantity, 0) = 0
    AND EXISTS (
      SELECT 1
      FROM _rebuild_target s
      WHERE s.source_detail_row_id = r.source_detail_row_id
        AND s.build_source = 'detail_shipment'
    );

  INSERT INTO _rebuild_target (
    organization_id, store_id, upload_id,
    order_id, order_type, order_date, sku, fnsku, disposition,
    requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
    in_process_quantity, removal_fee, currency, order_status,
    tracking_number, carrier, shipment_date,
    source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
    detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
    allocation_group_key, build_source, build_status, detail_grouping_key
  )
  SELECT DISTINCT ON (gap.source_detail_row_id)
    s.organization_id, s.store_id, s.upload_id,
    s.order_id, s.order_type, s.order_date, s.sku, s.fnsku, s.disposition,
    s.requested_quantity, s.shipped_quantity, s.disposed_quantity, s.cancelled_quantity,
    s.in_process_quantity, s.removal_fee, s.currency, s.order_status,
    NULL, NULL, NULL,
    gap.source_detail_row_id, NULL::uuid, NULL::uuid[],
    s.detail_shipped_quantity_total, NULL::integer, gap.remainder_qty,
    NULL, 'detail_remainder', 'awaiting_shipment_match', s.detail_grouping_key
  FROM (
    SELECT
      source_detail_row_id,
      GREATEST(
        max(detail_shipped_quantity_total)
          - coalesce(sum(expected_scan_quantity) FILTER (WHERE build_source = 'detail_shipment'), 0),
        0
      )::integer AS remainder_qty
    FROM _rebuild_target
    GROUP BY source_detail_row_id
  ) gap
  JOIN _rebuild_target s
    ON s.source_detail_row_id = gap.source_detail_row_id
   AND s.build_source = 'detail_shipment'
  WHERE gap.remainder_qty > 0
    AND NOT EXISTS (
      SELECT 1
      FROM _rebuild_target r
      WHERE r.source_detail_row_id = gap.source_detail_row_id
        AND r.build_source = 'detail_remainder'
    )
  ORDER BY gap.source_detail_row_id, s.allocation_group_key NULLS LAST;

  -- Final per-detail reconciliation: sum(expected_scan_quantity) must equal detail shipped qty.
  FOR v_rec IN
    SELECT
      source_detail_row_id,
      max(detail_shipped_quantity_total)::integer AS target_qty,
      coalesce(sum(expected_scan_quantity), 0)::integer AS current_qty
    FROM _rebuild_target
    GROUP BY source_detail_row_id
    HAVING coalesce(sum(expected_scan_quantity), 0)
      IS DISTINCT FROM max(detail_shipped_quantity_total)
  LOOP
    v_delta := v_rec.target_qty - v_rec.current_qty;
    WHILE v_delta <> 0 LOOP
      IF v_delta > 0 THEN
        UPDATE _rebuild_target
        SET expected_scan_quantity = coalesce(expected_scan_quantity, 0) + 1
        WHERE source_detail_row_id = v_rec.source_detail_row_id
          AND build_source = 'detail_remainder';
        IF NOT FOUND THEN
          INSERT INTO _rebuild_target (
            organization_id, store_id, upload_id,
            order_id, order_type, order_date, sku, fnsku, disposition,
            requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
            in_process_quantity, removal_fee, currency, order_status,
            tracking_number, carrier, shipment_date,
            source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
            detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
            allocation_group_key, build_source, build_status, detail_grouping_key
          )
          SELECT
            t.organization_id, t.store_id, t.upload_id,
            t.order_id, t.order_type, t.order_date, t.sku, t.fnsku, t.disposition,
            t.requested_quantity, t.shipped_quantity, t.disposed_quantity, t.cancelled_quantity,
            t.in_process_quantity, t.removal_fee, t.currency, t.order_status,
            NULL, NULL, NULL,
            t.source_detail_row_id, NULL::uuid, NULL::uuid[],
            t.detail_shipped_quantity_total, NULL::integer, 1,
            NULL, 'detail_remainder', 'awaiting_shipment_match', t.detail_grouping_key
          FROM _rebuild_target t
          WHERE t.source_detail_row_id = v_rec.source_detail_row_id
          LIMIT 1;
        END IF;
        v_delta := v_delta - 1;
      ELSE
        UPDATE _rebuild_target r
        SET expected_scan_quantity = r.expected_scan_quantity - 1
        WHERE r.ctid = (
          SELECT t.ctid
          FROM _rebuild_target t
          WHERE t.source_detail_row_id = v_rec.source_detail_row_id
            AND coalesce(t.expected_scan_quantity, 0) > 0
          ORDER BY
            CASE WHEN t.build_source = 'detail_remainder' THEN 0 ELSE 1 END,
            t.expected_scan_quantity DESC,
            t.allocation_group_key NULLS LAST
          LIMIT 1
        );
        v_delta := v_delta + 1;
      END IF;
    END LOOP;
  END LOOP;

  DELETE FROM _rebuild_target r
  WHERE r.build_source = 'detail_remainder'
    AND coalesce(r.expected_scan_quantity, 0) = 0
    AND EXISTS (
      SELECT 1
      FROM _rebuild_target s
      WHERE s.source_detail_row_id = r.source_detail_row_id
        AND s.build_source = 'detail_shipment'
    );

  SELECT count(DISTINCT source_detail_row_id) INTO v_detail_lines FROM _rebuild_target;
  SELECT count(*) INTO v_matched   FROM _rebuild_target WHERE build_source = 'detail_shipment';
  SELECT count(*) INTO v_remainder FROM _rebuild_target WHERE build_source = 'detail_remainder';
  SELECT count(DISTINCT source_detail_row_id) INTO v_overflow
    FROM _rebuild_target WHERE build_status = 'shipment_overflow_conflict';

  -- detail_shipment UPSERT (preserves actual_scanned_count / id_slip_contents)
  INSERT INTO public.expected_packages AS ep (
    organization_id, store_id, upload_id,
    order_id, order_type, order_date,
    sku, fnsku, disposition,
    requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
    in_process_quantity, removal_fee, currency,
    order_status, tracking_number, carrier, shipment_date,
    source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
    detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
    allocation_group_key, build_source, build_status, detail_grouping_key, rebuild_run_at
  )
  SELECT
    organization_id, store_id, upload_id,
    order_id, order_type, order_date,
    sku, fnsku, disposition,
    requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
    in_process_quantity, removal_fee, currency,
    order_status, tracking_number, carrier, shipment_date,
    source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
    detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
    allocation_group_key, build_source, build_status, detail_grouping_key, v_run_at
  FROM _rebuild_target
  WHERE build_source = 'detail_shipment'
  ON CONFLICT (organization_id, source_detail_row_id, allocation_group_key)
    WHERE build_source = 'detail_shipment'
  DO UPDATE SET
    store_id                       = excluded.store_id,
    upload_id                      = excluded.upload_id,
    order_id                       = excluded.order_id,
    order_type                     = excluded.order_type,
    order_date                     = excluded.order_date,
    sku                            = excluded.sku,
    fnsku                          = excluded.fnsku,
    disposition                    = excluded.disposition,
    requested_quantity             = excluded.requested_quantity,
    shipped_quantity               = excluded.shipped_quantity,
    disposed_quantity              = excluded.disposed_quantity,
    cancelled_quantity             = excluded.cancelled_quantity,
    in_process_quantity            = excluded.in_process_quantity,
    removal_fee                    = excluded.removal_fee,
    currency                       = excluded.currency,
    order_status                   = COALESCE(ep.order_status, excluded.order_status),
    tracking_number                = COALESCE(ep.tracking_number, excluded.tracking_number),
    carrier                        = COALESCE(ep.carrier, excluded.carrier),
    shipment_date                  = COALESCE(ep.shipment_date, excluded.shipment_date),
    source_shipment_row_id         = excluded.source_shipment_row_id,
    source_shipment_row_ids        = excluded.source_shipment_row_ids,
    detail_shipped_quantity_total  = excluded.detail_shipped_quantity_total,
    shipment_row_quantity          = excluded.shipment_row_quantity,
    expected_scan_quantity         = excluded.expected_scan_quantity,
    build_status                   = excluded.build_status,
    detail_grouping_key            = excluded.detail_grouping_key,
    rebuild_run_at                 = excluded.rebuild_run_at,
    updated_at                     = now();

  -- detail_remainder UPSERT
  INSERT INTO public.expected_packages AS ep (
    organization_id, store_id, upload_id,
    order_id, order_type, order_date,
    sku, fnsku, disposition,
    requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
    in_process_quantity, removal_fee, currency,
    order_status, tracking_number, carrier, shipment_date,
    source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
    detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
    allocation_group_key, build_source, build_status, detail_grouping_key, rebuild_run_at
  )
  SELECT
    organization_id, store_id, upload_id,
    order_id, order_type, order_date,
    sku, fnsku, disposition,
    requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
    in_process_quantity, removal_fee, currency,
    order_status, tracking_number, carrier, shipment_date,
    source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
    detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
    allocation_group_key, build_source, build_status, detail_grouping_key, v_run_at
  FROM _rebuild_target
  WHERE build_source = 'detail_remainder'
  ON CONFLICT (organization_id, source_detail_row_id)
    WHERE build_source = 'detail_remainder'
  DO UPDATE SET
    store_id                       = excluded.store_id,
    upload_id                      = excluded.upload_id,
    order_id                       = excluded.order_id,
    order_type                     = excluded.order_type,
    order_date                     = excluded.order_date,
    sku                            = excluded.sku,
    fnsku                          = excluded.fnsku,
    disposition                    = excluded.disposition,
    requested_quantity             = excluded.requested_quantity,
    shipped_quantity               = excluded.shipped_quantity,
    disposed_quantity              = excluded.disposed_quantity,
    cancelled_quantity             = excluded.cancelled_quantity,
    in_process_quantity            = excluded.in_process_quantity,
    removal_fee                    = excluded.removal_fee,
    currency                       = excluded.currency,
    order_status                   = COALESCE(ep.order_status, excluded.order_status),
    detail_shipped_quantity_total  = excluded.detail_shipped_quantity_total,
    shipment_row_quantity          = excluded.shipment_row_quantity,
    expected_scan_quantity         = excluded.expected_scan_quantity,
    build_status                   = excluded.build_status,
    detail_grouping_key            = excluded.detail_grouping_key,
    rebuild_run_at                 = excluded.rebuild_run_at,
    updated_at                     = now();

  WITH del AS (
    DELETE FROM public.expected_packages ep
    USING (
      SELECT ep.id
      FROM public.expected_packages ep
      LEFT JOIN _rebuild_target t
        ON t.organization_id = ep.organization_id
       AND t.source_detail_row_id = ep.source_detail_row_id
       AND t.build_source = ep.build_source
       AND (
         (ep.build_source = 'detail_remainder' AND t.build_source = 'detail_remainder')
         OR (
           ep.build_source = 'detail_shipment'
           AND t.build_source = 'detail_shipment'
           AND t.allocation_group_key IS NOT DISTINCT FROM ep.allocation_group_key
         )
       )
      WHERE ep.organization_id = p_organization_id
        AND (p_store_id IS NULL OR ep.store_id IS NOT DISTINCT FROM p_store_id)
        AND ep.build_source IN ('detail_shipment', 'detail_remainder')
        AND t.organization_id IS NULL
    ) AS obs
    WHERE ep.id = obs.id
    RETURNING ep.id
  )
  SELECT count(*) INTO v_deleted FROM del;

  RETURN QUERY SELECT v_detail_lines, v_matched, v_remainder, v_overflow, v_deleted;
END;
$function$;

COMMENT ON FUNCTION public.rebuild_expected_packages_from_removals(uuid, uuid) IS
  'Detail-driven rebuild with shipment allocation grouped by normalized tracking + carrier + shipment_date. '
  'expected_scan_quantity = sum(shipment qty) per group. One detail_remainder when detail qty exceeds shipment total.';

GRANT EXECUTE ON FUNCTION public.rebuild_expected_packages_from_removals(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
