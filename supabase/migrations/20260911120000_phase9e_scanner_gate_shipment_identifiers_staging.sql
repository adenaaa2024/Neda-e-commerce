-- Phase 9E — scanner identity gate warehouse identifier priority + match_type
-- Staging first. No new tables/columns. Does not drop scanner_identity_gate_lookup.
BEGIN;

-- Warehouse identifier indexes (org + store scoped exact match)
CREATE INDEX IF NOT EXISTS idx_packages_org_store_package_code
  ON public.packages (organization_id, store_id, package_code)
  WHERE deleted_at IS NULL
    AND package_code IS NOT NULL
    AND btrim(package_code) <> '';

CREATE INDEX IF NOT EXISTS idx_ep_org_store_order_id
  ON public.expected_packages (organization_id, store_id, order_id)
  WHERE order_id IS NOT NULL
    AND btrim(order_id) <> '';

CREATE INDEX IF NOT EXISTS idx_packages_org_store_order_id
  ON public.packages (organization_id, store_id, order_id)
  WHERE deleted_at IS NULL
    AND order_id IS NOT NULL
    AND btrim(order_id) <> '';

CREATE INDEX IF NOT EXISTS idx_shipment_boxes_org_store_box_code
  ON public.shipment_boxes (organization_id, store_id, box_code)
  WHERE box_code IS NOT NULL
    AND btrim(box_code) <> '';

CREATE OR REPLACE FUNCTION public.scanner_identity_gate_lookup(
  p_organization_id uuid,
  p_store_id uuid,
  p_code text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_norm text;
  v_matched_field text;
  v_match_type text;
  v_rows jsonb := '[]'::jsonb;
  v_package_ids jsonb := '[]'::jsonb;
  v_tracking_numbers jsonb := '[]'::jsonb;
  v_fnsku_scanned integer := 0;
  v_sku_scanned integer := 0;
  v_lookup_code text;
  v_lookup_norm text;
  v_resolved_tracking text;
BEGIN
  v_code := btrim(coalesce(p_code, ''));
  IF v_code = '' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', NULL,
      'match_type', NULL,
      'rows', '[]'::jsonb,
      'package_ids', '[]'::jsonb,
      'tracking_numbers', '[]'::jsonb,
      'scrub_applied', true
    );
  END IF;

  v_norm := public._scanner_tracking_norm(v_code);
  v_lookup_code := v_code;
  v_lookup_norm := v_norm;

  -- ── tracking (priority 1) ────────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1
      FROM public.expected_packages ep
     WHERE ep.organization_id = p_organization_id
       AND ep.store_id = p_store_id
       AND (
         ep.tracking_number = v_code
         OR public._scanner_tracking_norm(ep.tracking_number) = v_norm
       )
     LIMIT 1
  ) THEN
    v_matched_field := 'tracking_number';
    v_match_type := 'tracking';

    SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(p.id::text)), '[]'::jsonb)
      INTO v_package_ids
      FROM public.packages p
     WHERE p.organization_id = p_organization_id
       AND p.store_id = p_store_id
       AND p.deleted_at IS NULL
       AND (
         p.tracking_number = v_code
         OR public._scanner_tracking_norm(p.tracking_number) = v_norm
       );

    WITH scanned AS (
      SELECT
        lower(coalesce(ri.sku, '')) AS sku_l,
        lower(coalesce(ri.fnsku, '')) AS fnsku_l,
        sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity))::integer AS qty
      FROM public.return_items ri
      JOIN public.packages p ON p.id = ri.package_id AND p.deleted_at IS NULL
     WHERE ri.organization_id = p_organization_id
       AND ri.store_id = p_store_id
       AND ri.deleted_at IS NULL
       AND ri.package_id IN (
         SELECT (jsonb_array_elements_text(v_package_ids))::uuid
       )
       AND NOT public._scanner_return_item_test_excluded(
         ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
       )
     GROUP BY 1, 2
    )
    SELECT coalesce(jsonb_agg(r ORDER BY r->>'sku', r->>'fnsku'), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT public._scanner_inventory_row_json(
          ep.id::text,
          p_organization_id,
          p_store_id,
          ep.tracking_number,
          ep.id_slip_contents,
          ep.sku,
          ep.fnsku,
          ep.order_id,
          ep.resolved_product_id,
          ep.resolved_catalog_product_id,
          ep.identifier_resolution_status,
          ep.identifier_resolution_confidence,
          coalesce(ep.expected_scan_quantity, 0)::integer,
          coalesce(s.qty, 0)
        ) AS r
          FROM public.expected_packages ep
          LEFT JOIN scanned s
            ON s.sku_l = lower(coalesce(ep.sku, ''))
           AND s.fnsku_l = lower(coalesce(ep.fnsku, ''))
         WHERE ep.organization_id = p_organization_id
           AND ep.store_id = p_store_id
           AND (
             ep.tracking_number = v_code
             OR public._scanner_tracking_norm(ep.tracking_number) = v_norm
           )
      ) sub;

    SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(ep.tracking_number)), '[]'::jsonb)
      INTO v_tracking_numbers
      FROM public.expected_packages ep
     WHERE ep.organization_id = p_organization_id
       AND ep.store_id = p_store_id
       AND (
         ep.tracking_number = v_code
         OR public._scanner_tracking_norm(ep.tracking_number) = v_norm
       )
       AND ep.tracking_number IS NOT NULL
       AND btrim(ep.tracking_number) <> '';

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', v_rows,
      'package_ids', v_package_ids,
      'tracking_numbers', v_tracking_numbers,
      'scrub_applied', true
    );
  END IF;

  -- ── package_code (priority 2) — packages.package_code only, not slip ids ────
  IF EXISTS (
    SELECT 1
      FROM public.packages p
     WHERE p.organization_id = p_organization_id
       AND p.store_id = p_store_id
       AND p.deleted_at IS NULL
       AND p.package_code = v_code
     LIMIT 1
  ) THEN
    v_matched_field := 'package_code';
    v_match_type := 'package_code';

    SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(p.id::text)), '[]'::jsonb)
      INTO v_package_ids
      FROM public.packages p
     WHERE p.organization_id = p_organization_id
       AND p.store_id = p_store_id
       AND p.deleted_at IS NULL
       AND p.package_code = v_code;

    SELECT max(p.tracking_number)
      INTO v_resolved_tracking
      FROM public.packages p
     WHERE p.organization_id = p_organization_id
       AND p.store_id = p_store_id
       AND p.deleted_at IS NULL
       AND p.package_code = v_code
       AND p.tracking_number IS NOT NULL
       AND btrim(p.tracking_number) <> '';

    IF v_resolved_tracking IS NOT NULL AND btrim(v_resolved_tracking) <> '' THEN
      v_lookup_code := v_resolved_tracking;
      v_lookup_norm := public._scanner_tracking_norm(v_lookup_code);

      WITH scanned AS (
        SELECT
          lower(coalesce(ri.sku, '')) AS sku_l,
          lower(coalesce(ri.fnsku, '')) AS fnsku_l,
          sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity))::integer AS qty
        FROM public.return_items ri
       WHERE ri.organization_id = p_organization_id
         AND ri.store_id = p_store_id
         AND ri.deleted_at IS NULL
         AND ri.package_id IN (
           SELECT (jsonb_array_elements_text(v_package_ids))::uuid
         )
         AND NOT public._scanner_return_item_test_excluded(
           ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
         )
       GROUP BY 1, 2
      )
      SELECT coalesce(jsonb_agg(r ORDER BY r->>'sku', r->>'fnsku'), '[]'::jsonb)
        INTO v_rows
        FROM (
          SELECT public._scanner_inventory_row_json(
            ep.id::text,
            p_organization_id,
            p_store_id,
            ep.tracking_number,
            ep.id_slip_contents,
            ep.sku,
            ep.fnsku,
            ep.order_id,
            ep.resolved_product_id,
            ep.resolved_catalog_product_id,
            ep.identifier_resolution_status,
            ep.identifier_resolution_confidence,
            coalesce(ep.expected_scan_quantity, 0)::integer,
            coalesce(s.qty, 0)
          ) AS r
            FROM public.expected_packages ep
            LEFT JOIN scanned s
              ON s.sku_l = lower(coalesce(ep.sku, ''))
             AND s.fnsku_l = lower(coalesce(ep.fnsku, ''))
           WHERE ep.organization_id = p_organization_id
             AND ep.store_id = p_store_id
             AND (
               ep.tracking_number = v_lookup_code
               OR public._scanner_tracking_norm(ep.tracking_number) = v_lookup_norm
             )
        ) sub;

      SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(ep.tracking_number)), '[]'::jsonb)
        INTO v_tracking_numbers
        FROM public.expected_packages ep
       WHERE ep.organization_id = p_organization_id
         AND ep.store_id = p_store_id
         AND (
           ep.tracking_number = v_lookup_code
           OR public._scanner_tracking_norm(ep.tracking_number) = v_lookup_norm
         )
         AND ep.tracking_number IS NOT NULL
         AND btrim(ep.tracking_number) <> '';
    END IF;

    IF v_rows = '[]'::jsonb OR v_rows IS NULL THEN
      WITH scanned_grouped AS (
        SELECT
          public._scanner_tracking_norm(p.tracking_number) AS tracking_norm,
          coalesce(p.id_slip_contents, '') AS slip,
          lower(coalesce(ri.sku, '')) AS sku_l,
          lower(coalesce(ri.fnsku, '')) AS fnsku_l,
          max(p.tracking_number) AS tracking_number,
          max(p.id_slip_contents) AS id_slip_contents,
          max(ri.sku) AS sku,
          max(ri.fnsku) AS fnsku,
          max(ri.resolved_product_id::text)::uuid AS resolved_product_id,
          sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity))::integer AS total_scanned
        FROM public.return_items ri
        JOIN public.packages p ON p.id = ri.package_id AND p.deleted_at IS NULL
       WHERE ri.organization_id = p_organization_id
         AND ri.store_id = p_store_id
         AND ri.deleted_at IS NULL
         AND ri.package_id IN (
           SELECT (jsonb_array_elements_text(v_package_ids))::uuid
         )
         AND NOT public._scanner_return_item_test_excluded(
           ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
         )
       GROUP BY 1, 2, 3, 4
      )
      SELECT coalesce(jsonb_agg(
        public._scanner_inventory_row_json(
          '',
          p_organization_id,
          p_store_id,
          s.tracking_number,
          s.id_slip_contents,
          s.sku,
          s.fnsku,
          NULL,
          s.resolved_product_id,
          NULL,
          NULL,
          NULL,
          0,
          s.total_scanned
        )
        ORDER BY s.sku, s.fnsku
      ), '[]'::jsonb)
        INTO v_rows
        FROM scanned_grouped s
       WHERE s.total_scanned > 0;
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', coalesce(v_rows, '[]'::jsonb),
      'package_ids', v_package_ids,
      'tracking_numbers', coalesce(v_tracking_numbers, '[]'::jsonb),
      'scrub_applied', true
    );
  END IF;

  -- ── box_code via shipment_boxes (priority 3) ────────────────────────────────
  IF EXISTS (
    SELECT 1
      FROM public.shipment_boxes sb
     WHERE sb.organization_id = p_organization_id
       AND sb.store_id = p_store_id
       AND sb.box_code = v_code
       AND sb.box_code IS NOT NULL
       AND btrim(sb.box_code) <> ''
     LIMIT 1
  ) THEN
    v_matched_field := 'package_code';
    v_match_type := 'package_code';

    SELECT max(sc.tracking_number)
      INTO v_resolved_tracking
      FROM public.shipment_boxes sb
      JOIN public.shipment_containers sc ON sc.id = sb.shipment_container_id
     WHERE sb.organization_id = p_organization_id
       AND sb.store_id = p_store_id
       AND sb.box_code = v_code
       AND sc.tracking_number IS NOT NULL
       AND btrim(sc.tracking_number) <> '';

    IF v_resolved_tracking IS NOT NULL AND btrim(v_resolved_tracking) <> '' THEN
      v_lookup_code := v_resolved_tracking;
      v_lookup_norm := public._scanner_tracking_norm(v_lookup_code);

      SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(p.id::text)), '[]'::jsonb)
        INTO v_package_ids
        FROM public.packages p
       WHERE p.organization_id = p_organization_id
         AND p.store_id = p_store_id
         AND p.deleted_at IS NULL
         AND (
           p.tracking_number = v_lookup_code
           OR public._scanner_tracking_norm(p.tracking_number) = v_lookup_norm
         );

      WITH scanned AS (
        SELECT
          lower(coalesce(ri.sku, '')) AS sku_l,
          lower(coalesce(ri.fnsku, '')) AS fnsku_l,
          sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity))::integer AS qty
        FROM public.return_items ri
        JOIN public.packages p ON p.id = ri.package_id AND p.deleted_at IS NULL
       WHERE ri.organization_id = p_organization_id
         AND ri.store_id = p_store_id
         AND ri.deleted_at IS NULL
         AND (
           p.tracking_number = v_lookup_code
           OR public._scanner_tracking_norm(p.tracking_number) = v_lookup_norm
         )
         AND NOT public._scanner_return_item_test_excluded(
           ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
         )
       GROUP BY 1, 2
      )
      SELECT coalesce(jsonb_agg(r ORDER BY r->>'sku', r->>'fnsku'), '[]'::jsonb)
        INTO v_rows
        FROM (
          SELECT public._scanner_inventory_row_json(
            ep.id::text,
            p_organization_id,
            p_store_id,
            ep.tracking_number,
            ep.id_slip_contents,
            ep.sku,
            ep.fnsku,
            ep.order_id,
            ep.resolved_product_id,
            ep.resolved_catalog_product_id,
            ep.identifier_resolution_status,
            ep.identifier_resolution_confidence,
            coalesce(ep.expected_scan_quantity, 0)::integer,
            coalesce(s.qty, 0)
          ) AS r
            FROM public.expected_packages ep
            LEFT JOIN scanned s
              ON s.sku_l = lower(coalesce(ep.sku, ''))
             AND s.fnsku_l = lower(coalesce(ep.fnsku, ''))
           WHERE ep.organization_id = p_organization_id
             AND ep.store_id = p_store_id
             AND (
               ep.tracking_number = v_lookup_code
               OR public._scanner_tracking_norm(ep.tracking_number) = v_lookup_norm
             )
        ) sub;

      SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(ep.tracking_number)), '[]'::jsonb)
        INTO v_tracking_numbers
        FROM public.expected_packages ep
       WHERE ep.organization_id = p_organization_id
         AND ep.store_id = p_store_id
         AND (
           ep.tracking_number = v_lookup_code
           OR public._scanner_tracking_norm(ep.tracking_number) = v_lookup_norm
         )
         AND ep.tracking_number IS NOT NULL
         AND btrim(ep.tracking_number) <> '';
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', coalesce(v_rows, '[]'::jsonb),
      'package_ids', coalesce(v_package_ids, '[]'::jsonb),
      'tracking_numbers', coalesce(v_tracking_numbers, '[]'::jsonb),
      'scrub_applied', true
    );
  END IF;

  -- ── slip / id_slip_contents (priority 4) ─────────────────────────────────────
  IF EXISTS (
    SELECT 1
      FROM public.expected_packages ep
     WHERE ep.organization_id = p_organization_id
       AND ep.store_id = p_store_id
       AND ep.id_slip_contents = v_code
     LIMIT 1
  ) OR EXISTS (
    SELECT 1
      FROM public.packages p
     WHERE p.organization_id = p_organization_id
       AND p.store_id = p_store_id
       AND p.id_slip_contents = v_code
       AND p.deleted_at IS NULL
     LIMIT 1
  ) THEN
    v_matched_field := 'id_slip_contents';
    v_match_type := 'slip_code';

    SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(p.id::text)), '[]'::jsonb)
      INTO v_package_ids
      FROM public.packages p
     WHERE p.organization_id = p_organization_id
       AND p.store_id = p_store_id
       AND p.id_slip_contents = v_code
       AND p.deleted_at IS NULL;

    WITH ep_grouped AS (
      SELECT
        public._scanner_tracking_norm(ep.tracking_number) AS tracking_norm,
        coalesce(ep.id_slip_contents, '') AS slip,
        lower(coalesce(ep.sku, '')) AS sku_l,
        lower(coalesce(ep.fnsku, '')) AS fnsku_l,
        max(ep.tracking_number) AS tracking_number,
        max(ep.id_slip_contents) AS id_slip_contents,
        max(ep.sku) AS sku,
        max(ep.fnsku) AS fnsku,
        max(ep.order_id) AS order_id,
        (max(ep.resolved_product_id::text))::uuid AS resolved_product_id,
        (max(ep.resolved_catalog_product_id::text))::uuid AS resolved_catalog_product_id,
        max(ep.identifier_resolution_status) AS identifier_resolution_status,
        max(ep.identifier_resolution_confidence) AS identifier_resolution_confidence,
        sum(coalesce(ep.expected_scan_quantity, 0))::integer AS total_expected,
        CASE WHEN count(DISTINCT ep.id) = 1 THEN min(ep.id::text) ELSE '' END AS expected_package_id
      FROM public.expected_packages ep
     WHERE ep.organization_id = p_organization_id
       AND ep.store_id = p_store_id
       AND ep.id_slip_contents = v_code
     GROUP BY 1, 2, 3, 4
    ),
    scanned_grouped AS (
      SELECT
        public._scanner_tracking_norm(p.tracking_number) AS tracking_norm,
        coalesce(p.id_slip_contents, v_code) AS slip,
        lower(coalesce(ri.sku, '')) AS sku_l,
        lower(coalesce(ri.fnsku, '')) AS fnsku_l,
        max(p.tracking_number) AS tracking_number,
        max(coalesce(p.id_slip_contents, v_code)) AS id_slip_contents,
        max(ri.sku) AS sku,
        max(ri.fnsku) AS fnsku,
        max(ri.resolved_product_id::text)::uuid AS resolved_product_id,
        sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity))::integer AS total_scanned
      FROM public.return_items ri
      JOIN public.packages p ON p.id = ri.package_id AND p.deleted_at IS NULL
     WHERE ri.organization_id = p_organization_id
       AND ri.store_id = p_store_id
       AND ri.deleted_at IS NULL
       AND ri.package_id IN (
         SELECT (jsonb_array_elements_text(v_package_ids))::uuid
       )
       AND NOT public._scanner_return_item_test_excluded(
         ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
       )
     GROUP BY 1, 2, 3, 4
    ),
    merged AS (
      SELECT
        coalesce(e.expected_package_id, '') AS expected_package_id,
        coalesce(e.tracking_number, s.tracking_number) AS tracking_number,
        coalesce(e.id_slip_contents, s.id_slip_contents) AS id_slip_contents,
        coalesce(e.sku, s.sku) AS sku,
        coalesce(e.fnsku, s.fnsku) AS fnsku,
        e.order_id,
        coalesce(e.resolved_product_id, s.resolved_product_id) AS resolved_product_id,
        e.resolved_catalog_product_id,
        e.identifier_resolution_status,
        e.identifier_resolution_confidence,
        coalesce(e.total_expected, 0) AS total_expected,
        coalesce(s.total_scanned, 0) AS total_scanned
      FROM ep_grouped e
      FULL OUTER JOIN scanned_grouped s
        ON e.tracking_norm = s.tracking_norm
       AND e.slip = s.slip
       AND e.sku_l = s.sku_l
       AND e.fnsku_l = s.fnsku_l
    )
    SELECT coalesce(jsonb_agg(
      public._scanner_inventory_row_json(
        m.expected_package_id,
        p_organization_id,
        p_store_id,
        m.tracking_number,
        m.id_slip_contents,
        m.sku,
        m.fnsku,
        m.order_id,
        m.resolved_product_id,
        m.resolved_catalog_product_id,
        m.identifier_resolution_status,
        m.identifier_resolution_confidence,
        m.total_expected,
        m.total_scanned
      )
      ORDER BY m.sku, m.fnsku
    ), '[]'::jsonb)
      INTO v_rows
      FROM merged m
     WHERE m.total_expected > 0 OR m.total_scanned > 0;

    SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(tn)), '[]'::jsonb)
      INTO v_tracking_numbers
      FROM (
        SELECT p.tracking_number AS tn
          FROM public.packages p
         WHERE p.organization_id = p_organization_id
           AND p.store_id = p_store_id
           AND p.id_slip_contents = v_code
           AND p.deleted_at IS NULL
           AND p.tracking_number IS NOT NULL
           AND btrim(p.tracking_number) <> ''
        UNION
        SELECT ep.tracking_number AS tn
          FROM public.expected_packages ep
         WHERE ep.organization_id = p_organization_id
           AND ep.store_id = p_store_id
           AND ep.id_slip_contents = v_code
           AND ep.tracking_number IS NOT NULL
           AND btrim(ep.tracking_number) <> ''
      ) tracking_union;

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', v_rows,
      'package_ids', v_package_ids,
      'tracking_numbers', v_tracking_numbers,
      'scrub_applied', true
    );
  END IF;

  -- ── amazon_order_id (priority 5) ───────────────────────────────────────────
  IF EXISTS (
    SELECT 1
      FROM public.amazon_all_orders ao
     WHERE ao.organization_id = p_organization_id
       AND ao.amazon_order_id = v_code
     LIMIT 1
  ) OR EXISTS (
    SELECT 1
      FROM public.expected_packages ep
     WHERE ep.organization_id = p_organization_id
       AND ep.store_id = p_store_id
       AND ep.order_id = v_code
       AND NOT EXISTS (
         SELECT 1
           FROM public.amazon_removals ar
          WHERE ar.organization_id = p_organization_id
            AND ar.store_id = p_store_id
            AND ar.order_id = v_code
       )
     LIMIT 1
  ) OR EXISTS (
    SELECT 1
      FROM public.packages p
     WHERE p.organization_id = p_organization_id
       AND p.store_id = p_store_id
       AND p.order_id = v_code
       AND p.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.amazon_removals ar
          WHERE ar.organization_id = p_organization_id
            AND ar.store_id = p_store_id
            AND ar.order_id = v_code
       )
     LIMIT 1
  ) THEN
    v_matched_field := 'order_id';
    v_match_type := 'amazon_order_id';

    SELECT coalesce(sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity)), 0)::integer
      INTO v_sku_scanned
      FROM public.return_items ri
      JOIN public.packages p ON p.id = ri.package_id AND p.deleted_at IS NULL
     WHERE ri.organization_id = p_organization_id
       AND ri.store_id = p_store_id
       AND ri.deleted_at IS NULL
       AND p.order_id = v_code
       AND NOT public._scanner_return_item_test_excluded(
         ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
       );

    SELECT coalesce(jsonb_agg(r ORDER BY r->>'sku', r->>'fnsku'), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT public._scanner_inventory_row_json(
          CASE WHEN count(DISTINCT ep.id) = 1 THEN min(ep.id::text) ELSE '' END,
          p_organization_id,
          p_store_id,
          max(ep.tracking_number),
          max(ep.id_slip_contents),
          max(ep.sku),
          max(ep.fnsku),
          max(ep.order_id),
          (max(ep.resolved_product_id::text))::uuid,
          (max(ep.resolved_catalog_product_id::text))::uuid,
          max(ep.identifier_resolution_status),
          max(ep.identifier_resolution_confidence),
          sum(coalesce(ep.expected_scan_quantity, 0))::integer,
          v_sku_scanned
        ) AS r
          FROM public.expected_packages ep
         WHERE ep.organization_id = p_organization_id
           AND ep.store_id = p_store_id
           AND ep.order_id = v_code
         GROUP BY
           public._scanner_tracking_norm(ep.tracking_number),
           coalesce(ep.id_slip_contents, ''),
           lower(coalesce(ep.sku, '')),
           lower(coalesce(ep.fnsku, ''))
         HAVING sum(coalesce(ep.expected_scan_quantity, 0)) > 0
      ) sub;

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', coalesce(v_rows, '[]'::jsonb),
      'package_ids', '[]'::jsonb,
      'tracking_numbers', '[]'::jsonb,
      'scrub_applied', true
    );
  END IF;

  -- ── removal_order_id (priority 6) ────────────────────────────────────────────
  IF EXISTS (
    SELECT 1
      FROM public.amazon_removals ar
     WHERE ar.organization_id = p_organization_id
       AND ar.store_id = p_store_id
       AND ar.order_id = v_code
     LIMIT 1
  ) OR EXISTS (
    SELECT 1
      FROM public.expected_packages ep
     WHERE ep.organization_id = p_organization_id
       AND ep.store_id = p_store_id
       AND ep.order_id = v_code
     LIMIT 1
  ) THEN
    v_matched_field := 'order_id';
    v_match_type := 'removal_order_id';

    SELECT coalesce(sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity)), 0)::integer
      INTO v_sku_scanned
      FROM public.return_items ri
      JOIN public.packages p ON p.id = ri.package_id AND p.deleted_at IS NULL
     WHERE ri.organization_id = p_organization_id
       AND ri.store_id = p_store_id
       AND ri.deleted_at IS NULL
       AND p.order_id = v_code
       AND NOT public._scanner_return_item_test_excluded(
         ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
       );

    SELECT coalesce(jsonb_agg(r ORDER BY r->>'sku', r->>'fnsku'), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT public._scanner_inventory_row_json(
          CASE WHEN count(DISTINCT ep.id) = 1 THEN min(ep.id::text) ELSE '' END,
          p_organization_id,
          p_store_id,
          max(ep.tracking_number),
          max(ep.id_slip_contents),
          max(ep.sku),
          max(ep.fnsku),
          max(ep.order_id),
          (max(ep.resolved_product_id::text))::uuid,
          (max(ep.resolved_catalog_product_id::text))::uuid,
          max(ep.identifier_resolution_status),
          max(ep.identifier_resolution_confidence),
          sum(coalesce(ep.expected_scan_quantity, 0))::integer,
          v_sku_scanned
        ) AS r
          FROM public.expected_packages ep
         WHERE ep.organization_id = p_organization_id
           AND ep.store_id = p_store_id
           AND ep.order_id = v_code
         GROUP BY
           public._scanner_tracking_norm(ep.tracking_number),
           coalesce(ep.id_slip_contents, ''),
           lower(coalesce(ep.sku, '')),
           lower(coalesce(ep.fnsku, ''))
         HAVING sum(coalesce(ep.expected_scan_quantity, 0)) > 0
      ) sub;

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', coalesce(v_rows, '[]'::jsonb),
      'package_ids', '[]'::jsonb,
      'tracking_numbers', '[]'::jsonb,
      'scrub_applied', true
    );
  END IF;

  -- ── shipment_id (priority 7) ─────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1
      FROM public.amazon_removal_shipments s
     WHERE s.organization_id = p_organization_id
       AND s.store_id = p_store_id
       AND (
         coalesce(s.raw_row->>'shipment-id', '') = v_code
         OR coalesce(s.raw_row->>'Shipment ID', '') = v_code
         OR coalesce(s.raw_row->>'shipment_id', '') = v_code
         OR coalesce(s.raw_row->>'fba-shipment-id', '') = v_code
       )
     LIMIT 1
  ) THEN
    v_matched_field := 'shipment_id';
    v_match_type := 'shipment_id';

    WITH ship_orders AS (
      SELECT DISTINCT btrim(s.order_id) AS order_id
        FROM public.amazon_removal_shipments s
       WHERE s.organization_id = p_organization_id
         AND s.store_id = p_store_id
         AND (
           coalesce(s.raw_row->>'shipment-id', '') = v_code
           OR coalesce(s.raw_row->>'Shipment ID', '') = v_code
           OR coalesce(s.raw_row->>'shipment_id', '') = v_code
           OR coalesce(s.raw_row->>'fba-shipment-id', '') = v_code
         )
         AND s.order_id IS NOT NULL
         AND btrim(s.order_id) <> ''
    ),
    ship_trackings AS (
      SELECT DISTINCT btrim(s.tracking_number) AS tracking_number
        FROM public.amazon_removal_shipments s
       WHERE s.organization_id = p_organization_id
         AND s.store_id = p_store_id
         AND (
           coalesce(s.raw_row->>'shipment-id', '') = v_code
           OR coalesce(s.raw_row->>'Shipment ID', '') = v_code
           OR coalesce(s.raw_row->>'shipment_id', '') = v_code
           OR coalesce(s.raw_row->>'fba-shipment-id', '') = v_code
         )
         AND s.tracking_number IS NOT NULL
         AND btrim(s.tracking_number) <> ''
    )
    SELECT coalesce(jsonb_agg(r ORDER BY r->>'sku', r->>'fnsku'), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT public._scanner_inventory_row_json(
          ep.id::text,
          p_organization_id,
          p_store_id,
          ep.tracking_number,
          ep.id_slip_contents,
          ep.sku,
          ep.fnsku,
          ep.order_id,
          ep.resolved_product_id,
          ep.resolved_catalog_product_id,
          ep.identifier_resolution_status,
          ep.identifier_resolution_confidence,
          coalesce(ep.expected_scan_quantity, 0)::integer,
          0
        ) AS r
          FROM public.expected_packages ep
         WHERE ep.organization_id = p_organization_id
           AND ep.store_id = p_store_id
           AND (
             ep.order_id IN (SELECT order_id FROM ship_orders)
             OR ep.tracking_number IN (SELECT tracking_number FROM ship_trackings)
             OR public._scanner_tracking_norm(ep.tracking_number) IN (
               SELECT public._scanner_tracking_norm(tracking_number) FROM ship_trackings
             )
           )
      ) sub;

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', coalesce(v_rows, '[]'::jsonb),
      'package_ids', '[]'::jsonb,
      'tracking_numbers', '[]'::jsonb,
      'scrub_applied', true
    );
  END IF;

  -- ── fnsku product fallback (priority 8) ────────────────────────────────────
  IF EXISTS (
    SELECT 1
      FROM public.expected_packages ep
     WHERE ep.organization_id = p_organization_id
       AND ep.store_id = p_store_id
       AND ep.fnsku = v_code
     LIMIT 1
  ) THEN
    v_matched_field := 'fnsku';
    v_match_type := 'product_identifier_fallback';

    SELECT coalesce(sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity)), 0)::integer
      INTO v_fnsku_scanned
      FROM public.return_items ri
      JOIN public.packages p ON p.id = ri.package_id AND p.deleted_at IS NULL
     WHERE ri.organization_id = p_organization_id
       AND ri.store_id = p_store_id
       AND ri.fnsku = v_code
       AND ri.deleted_at IS NULL
       AND NOT public._scanner_return_item_test_excluded(
         ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
       );

    SELECT coalesce(jsonb_agg(r ORDER BY r->>'sku', r->>'fnsku'), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT public._scanner_inventory_row_json(
          CASE WHEN count(DISTINCT ep.id) = 1 THEN min(ep.id::text) ELSE '' END,
          p_organization_id,
          p_store_id,
          max(ep.tracking_number),
          max(ep.id_slip_contents),
          max(ep.sku),
          max(ep.fnsku),
          max(ep.order_id),
          (max(ep.resolved_product_id::text))::uuid,
          (max(ep.resolved_catalog_product_id::text))::uuid,
          max(ep.identifier_resolution_status),
          max(ep.identifier_resolution_confidence),
          sum(coalesce(ep.expected_scan_quantity, 0))::integer,
          v_fnsku_scanned
        ) AS r
          FROM public.expected_packages ep
         WHERE ep.organization_id = p_organization_id
           AND ep.store_id = p_store_id
           AND ep.fnsku = v_code
         GROUP BY
           public._scanner_tracking_norm(ep.tracking_number),
           coalesce(ep.id_slip_contents, ''),
           lower(coalesce(ep.sku, '')),
           lower(coalesce(ep.fnsku, ''))
         HAVING sum(coalesce(ep.expected_scan_quantity, 0)) > 0
      ) sub;

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', v_rows,
      'package_ids', '[]'::jsonb,
      'tracking_numbers', '[]'::jsonb,
      'scrub_applied', true
    );
  END IF;

  -- ── sku product fallback (priority 9) ────────────────────────────────────────
  IF EXISTS (
    SELECT 1
      FROM public.expected_packages ep
     WHERE ep.organization_id = p_organization_id
       AND ep.store_id = p_store_id
       AND ep.sku = v_code
     LIMIT 1
  ) THEN
    v_matched_field := 'sku';
    v_match_type := 'product_identifier_fallback';

    SELECT coalesce(sum(public._scanner_return_item_scanned_qty(ri.scanned_quantity)), 0)::integer
      INTO v_sku_scanned
      FROM public.return_items ri
      JOIN public.packages p ON p.id = ri.package_id AND p.deleted_at IS NULL
     WHERE ri.organization_id = p_organization_id
       AND ri.store_id = p_store_id
       AND ri.sku = v_code
       AND ri.deleted_at IS NULL
       AND NOT public._scanner_return_item_test_excluded(
         ri.item_name, ri.sku, ri.fnsku, ri.product_identifier, ri.notes, ri.raw_return_data
       );

    SELECT coalesce(jsonb_agg(r ORDER BY r->>'sku', r->>'fnsku'), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT public._scanner_inventory_row_json(
          CASE WHEN count(DISTINCT ep.id) = 1 THEN min(ep.id::text) ELSE '' END,
          p_organization_id,
          p_store_id,
          max(ep.tracking_number),
          max(ep.id_slip_contents),
          max(ep.sku),
          max(ep.fnsku),
          max(ep.order_id),
          (max(ep.resolved_product_id::text))::uuid,
          (max(ep.resolved_catalog_product_id::text))::uuid,
          max(ep.identifier_resolution_status),
          max(ep.identifier_resolution_confidence),
          sum(coalesce(ep.expected_scan_quantity, 0))::integer,
          v_sku_scanned
        ) AS r
          FROM public.expected_packages ep
         WHERE ep.organization_id = p_organization_id
           AND ep.store_id = p_store_id
           AND ep.sku = v_code
         GROUP BY
           public._scanner_tracking_norm(ep.tracking_number),
           coalesce(ep.id_slip_contents, ''),
           lower(coalesce(ep.sku, '')),
           lower(coalesce(ep.fnsku, ''))
         HAVING sum(coalesce(ep.expected_scan_quantity, 0)) > 0
      ) sub;

    RETURN jsonb_build_object(
      'ok', true,
      'matched_field', v_matched_field,
      'match_type', v_match_type,
      'rows', v_rows,
      'package_ids', '[]'::jsonb,
      'tracking_numbers', '[]'::jsonb,
      'scrub_applied', true
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'matched_field', NULL,
    'match_type', NULL,
    'rows', '[]'::jsonb,
    'package_ids', '[]'::jsonb,
    'tracking_numbers', '[]'::jsonb,
    'scrub_applied', true
  );
END;
$$;

COMMENT ON FUNCTION public.scanner_identity_gate_lookup(uuid, uuid, text) IS
  'Phase 9E: warehouse identifiers first (tracking/package/box/slip/order/shipment) then product_identifier_fallback.';

COMMIT;

NOTIFY pgrst, 'reload schema';
