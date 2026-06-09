-- =============================================================================
-- PHASE-6B — package finalize shortage + empty box (staging apply)
-- Derives shortage at close from expected_packages vs SUM(return_items.scanned_quantity).
-- Does not create return_items for missing/shortage.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.finalize_package_receive_close(
  p_organization_id uuid,
  p_package_id uuid,
  p_store_id uuid DEFAULT NULL,
  p_empty_box boolean DEFAULT false,
  p_actor_profile_id uuid DEFAULT NULL,
  p_notes_append text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg record;
  v_claim_cases_ok boolean;
  v_claim_evidence_ok boolean;
  v_shortage_created integer := 0;
  v_shortage_touched integer := 0;
  v_empty_case_id uuid;
  v_empty_evidence integer := 0;
  v_new_status text;
  v_grp record;
  v_photo text;
  v_notes text;
  v_tracking_norm text;
  v_has_shortage boolean := false;
  v_store uuid;
  v_row_count integer;
BEGIN
  SELECT p.*
    INTO v_pkg
    FROM public.packages p
   WHERE p.id = p_package_id
     AND p.organization_id = p_organization_id
     AND p.deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'package_not_found');
  END IF;

  v_store := COALESCE(p_store_id, v_pkg.store_id);

  IF p_store_id IS NOT NULL AND v_pkg.store_id IS NOT NULL AND v_pkg.store_id <> p_store_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'store_mismatch');
  END IF;

  v_claim_cases_ok := to_regclass('public.claim_cases') IS NOT NULL;
  v_claim_evidence_ok := to_regclass('public.claim_evidence') IS NOT NULL;

  IF p_empty_box AND NOT v_claim_cases_ok THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'claim_cases_schema_required',
      'schema_approval_required', true
    );
  END IF;

  IF p_notes_append IS NOT NULL AND btrim(p_notes_append) <> '' THEN
    v_notes := CASE
      WHEN v_pkg.notes IS NOT NULL AND btrim(v_pkg.notes) <> '' THEN v_pkg.notes || E'\n' || p_notes_append
      ELSE p_notes_append
    END;
  ELSE
    v_notes := v_pkg.notes;
  END IF;

  SELECT tn.operational
    INTO v_tracking_norm
    FROM public.normalize_removal_tracking_operational(v_pkg.tracking_number) tn
   LIMIT 1;

  IF v_tracking_norm IS NULL OR btrim(v_tracking_norm) = '' THEN
    v_tracking_norm := v_pkg.tracking_number;
  END IF;

  FOR v_grp IN
    WITH pkg AS (
      SELECT
        p_organization_id AS organization_id,
        v_store AS store_id,
        v_tracking_norm AS tracking_number,
        v_pkg.id_slip_contents AS slip_code,
        v_pkg.order_id AS order_id,
        v_pkg.pallet_id AS pallet_id,
        p_package_id AS package_id
    ),
    expected_groups AS (
      SELECT
        ep.sku,
        ep.fnsku,
        SUM(COALESCE(ep.expected_scan_quantity, 0))::numeric AS qty_expected,
        (
          SELECT ep2.id
            FROM public.expected_packages ep2
            LEFT JOIN LATERAL public.normalize_removal_tracking_operational(ep2.tracking_number) tn2 ON TRUE
           WHERE ep2.organization_id = (SELECT organization_id FROM pkg)
             AND ((SELECT store_id FROM pkg) IS NULL OR ep2.store_id = (SELECT store_id FROM pkg))
             AND COALESCE(tn2.operational, ep2.tracking_number) IS NOT DISTINCT FROM (SELECT tracking_number FROM pkg)
             AND ep2.id_slip_contents IS NOT DISTINCT FROM (SELECT slip_code FROM pkg)
             AND ep2.sku IS NOT DISTINCT FROM ep.sku
             AND ep2.fnsku IS NOT DISTINCT FROM ep.fnsku
             AND ep2.build_source IN ('detail_shipment', 'detail_remainder', 'legacy')
           ORDER BY ep2.created_at
           LIMIT 1
        ) AS root_ep_id
      FROM public.expected_packages ep
      LEFT JOIN LATERAL public.normalize_removal_tracking_operational(ep.tracking_number) tn ON TRUE
      CROSS JOIN pkg
     WHERE ep.organization_id = pkg.organization_id
       AND (pkg.store_id IS NULL OR ep.store_id = pkg.store_id)
       AND COALESCE(tn.operational, ep.tracking_number) IS NOT DISTINCT FROM pkg.tracking_number
       AND ep.id_slip_contents IS NOT DISTINCT FROM pkg.slip_code
     GROUP BY ep.sku, ep.fnsku
    ),
    received_groups AS (
      SELECT
        ri.sku,
        ri.fnsku,
        COALESCE(SUM(COALESCE(ri.scanned_quantity, 1)), 0)::numeric AS qty_received
      FROM public.return_items ri
      CROSS JOIN pkg
     WHERE ri.package_id = pkg.package_id
       AND ri.organization_id = pkg.organization_id
       AND ri.deleted_at IS NULL
     GROUP BY ri.sku, ri.fnsku
    )
    SELECT
      eg.sku,
      eg.fnsku,
      eg.root_ep_id,
      eg.qty_expected AS quantity_expected,
      COALESCE(rg.qty_received, 0) AS quantity_actual,
      GREATEST(eg.qty_expected - COALESCE(rg.qty_received, 0), 0) AS quantity_delta
    FROM expected_groups eg
    LEFT JOIN received_groups rg
      ON rg.sku IS NOT DISTINCT FROM eg.sku
     AND rg.fnsku IS NOT DISTINCT FROM eg.fnsku
   WHERE eg.root_ep_id IS NOT NULL
     AND eg.qty_expected > 0
     AND GREATEST(eg.qty_expected - COALESCE(rg.qty_received, 0), 0) > 0
  LOOP
    v_has_shortage := true;

    INSERT INTO public.claim_lines (
      organization_id,
      store_id,
      package_id,
      pallet_id,
      expected_package_root_id,
      tracking_number,
      order_id,
      sku,
      fnsku,
      line_grain,
      discrepancy_kind,
      quantity_expected,
      quantity_actual,
      quantity_delta,
      quantity_basis,
      count_basis,
      source_table,
      source_row_id,
      idempotency_key,
      status,
      metadata
    )
    VALUES (
      p_organization_id,
      v_store,
      p_package_id,
      v_pkg.pallet_id,
      v_grp.root_ep_id,
      v_tracking_norm,
      v_pkg.order_id,
      v_grp.sku,
      v_grp.fnsku,
      'expected_group',
      'short',
      v_grp.quantity_expected,
      v_grp.quantity_actual,
      v_grp.quantity_delta,
      'units',
      'scan_count',
      'packages',
      p_package_id::text,
      'cl:package_finalize:short:' || p_organization_id::text || ':' || p_package_id::text || ':' || v_grp.root_ep_id::text,
      'detected',
      jsonb_build_object(
        'finalize_source', 'phase6b_package_close',
        'empty_box', p_empty_box
      )
    )
    ON CONFLICT (idempotency_key) DO UPDATE SET
      quantity_expected = EXCLUDED.quantity_expected,
      quantity_actual = EXCLUDED.quantity_actual,
      quantity_delta = EXCLUDED.quantity_delta,
      package_id = EXCLUDED.package_id,
      updated_at = now();

    v_shortage_touched := v_shortage_touched + 1;
  END LOOP;

  SELECT COUNT(*)::integer
    INTO v_shortage_created
    FROM public.claim_lines cl
   WHERE cl.organization_id = p_organization_id
     AND cl.package_id = p_package_id
     AND cl.line_grain = 'expected_group'
     AND cl.discrepancy_kind = 'short'
     AND cl.idempotency_key LIKE 'cl:package_finalize:short:' || p_organization_id::text || ':' || p_package_id::text || ':%';

  IF p_empty_box AND v_claim_cases_ok THEN
    INSERT INTO public.claim_cases (
      organization_id,
      store_id,
      claim_source,
      scanner_issue_type,
      status,
      primary_package_id,
      primary_tracking_number,
      primary_order_id,
      opened_by,
      idempotency_key,
      metadata
    )
    VALUES (
      p_organization_id,
      v_store,
      'scanner_operator_issue',
      'empty_box',
      'open',
      p_package_id,
      v_pkg.tracking_number,
      v_pkg.order_id,
      p_actor_profile_id,
      'cc:package_finalize:empty_box:' || p_organization_id::text || ':' || p_package_id::text,
      jsonb_build_object('finalize_source', 'phase6b_package_close')
    )
    ON CONFLICT (idempotency_key) DO UPDATE SET
      scanner_issue_type = EXCLUDED.scanner_issue_type,
      primary_package_id = EXCLUDED.primary_package_id,
      updated_at = now()
    RETURNING id INTO v_empty_case_id;

    IF v_claim_evidence_ok AND v_empty_case_id IS NOT NULL THEN
      FOR v_photo IN
        SELECT DISTINCT btrim(u)
          FROM unnest(
            COALESCE(v_pkg.inside_photo_urls, '{}'::text[])
            || COALESCE(v_pkg.outside_photo_urls, '{}'::text[])
            || COALESCE(v_pkg.slip_photo_urls, '{}'::text[])
          ) AS u
         WHERE btrim(u) <> ''
      LOOP
        INSERT INTO public.claim_evidence (
          organization_id,
          claim_case_id,
          package_id,
          evidence_kind,
          capture_source,
          scanner_issue_type,
          public_url,
          captured_by,
          metadata
        )
        SELECT
          p_organization_id,
          v_empty_case_id,
          p_package_id,
          'photo',
          'scanner',
          'empty_box',
          v_photo,
          p_actor_profile_id,
          jsonb_build_object(
            'idempotency_key', 'ce:package_empty_box:' || p_package_id::text || ':' || md5(v_photo)
          )
        WHERE NOT EXISTS (
          SELECT 1
            FROM public.claim_evidence ce
           WHERE ce.claim_case_id = v_empty_case_id
             AND ce.public_url = v_photo
             AND ce.evidence_kind = 'photo'
        );

        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count > 0 THEN
          v_empty_evidence := v_empty_evidence + 1;
        END IF;
      END LOOP;

      IF v_notes IS NOT NULL AND btrim(v_notes) <> '' THEN
        INSERT INTO public.claim_evidence (
          organization_id,
          claim_case_id,
          package_id,
          evidence_kind,
          capture_source,
          scanner_issue_type,
          operator_note,
          captured_by,
          metadata
        )
        SELECT
          p_organization_id,
          v_empty_case_id,
          p_package_id,
          'operator_note',
          'operator',
          'empty_box',
          v_notes,
          p_actor_profile_id,
          jsonb_build_object(
            'idempotency_key', 'ce:package_empty_box_note:' || p_package_id::text
          )
        WHERE NOT EXISTS (
          SELECT 1
            FROM public.claim_evidence ce
           WHERE ce.claim_case_id = v_empty_case_id
             AND ce.evidence_kind = 'operator_note'
             AND ce.metadata->>'idempotency_key' = 'ce:package_empty_box_note:' || p_package_id::text
        );

        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count > 0 THEN
          v_empty_evidence := v_empty_evidence + 1;
        END IF;
      END IF;
    END IF;
  END IF;

  v_new_status := CASE
    WHEN v_has_shortage OR p_empty_box THEN 'suspicious'
    ELSE 'closed'
  END;

  UPDATE public.packages
     SET status = v_new_status,
         notes = v_notes,
         updated_at = now()
   WHERE id = p_package_id;

  RETURN jsonb_build_object(
    'ok', true,
    'package_id', p_package_id,
    'status', v_new_status,
    'shortage_lines_created', v_shortage_created,
    'shortage_lines_touched', v_shortage_touched,
    'empty_box_case_id', v_empty_case_id,
    'empty_box_evidence_count', v_empty_evidence,
    'claim_cases_available', v_claim_cases_ok,
    'claim_evidence_available', v_claim_evidence_ok
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_package_receive_close IS
  'Phase 6B: finalize package item receive — derive shortage claim_lines at close; optional empty_box claim_case + package photo evidence.';

REVOKE ALL ON FUNCTION public.finalize_package_receive_close(uuid, uuid, uuid, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_package_receive_close(uuid, uuid, uuid, boolean, uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
