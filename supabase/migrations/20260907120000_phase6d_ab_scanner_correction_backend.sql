-- =============================================================================
-- PHASE-6D-A/B — scanner correction backend (manifest contract, guards, audit)
-- Staging apply only. No new tables/columns.
-- =============================================================================

BEGIN;

-- ── 1. audit_events.action enum extension (minimal) ───────────────────────────
ALTER TABLE public.audit_events
  DROP CONSTRAINT IF EXISTS audit_events_action_chk;

ALTER TABLE public.audit_events
  ADD CONSTRAINT audit_events_action_chk CHECK (
    action IN (
      'soft_delete', 'restore', 'move_parent', 'restore_preview', 'restore_apply',
      'cascade_delete_pallet', 'cascade_delete_package', 'delete_return_item',
      'expected_release', 'expected_move',
      'missing_review_patch', 'package_reopen', 'package_finalize'
    )
  );

-- ── 2. Helpers ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._package_operator_item_scan_read(p_manifest jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    CASE
      WHEN p_manifest IS NOT NULL AND jsonb_typeof(p_manifest) = 'object' THEN p_manifest -> 'operator_item_scan'
      ELSE NULL
    END,
    '{}'::jsonb
  );
$$;

CREATE OR REPLACE FUNCTION public._package_receive_state(p_manifest jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN lower(COALESCE(public._package_operator_item_scan_read(p_manifest) ->> 'receive_state', 'open')) = 'finalized'
      THEN 'finalized'
    ELSE 'open'
  END;
$$;

CREATE OR REPLACE FUNCTION public._package_scanned_quantity_sum(
  p_organization_id uuid,
  p_package_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    SUM(COALESCE(ri.scanned_quantity, 1)),
    0
  )::integer
  FROM public.return_items ri
  WHERE ri.organization_id = p_organization_id
    AND ri.package_id = p_package_id
    AND ri.deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public._merge_package_manifest_operator_item_scan(
  p_manifest jsonb,
  p_operator_item_scan jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT
    CASE
      WHEN p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object' THEN
        jsonb_build_object('operator_item_scan', p_operator_item_scan)
      ELSE
        p_manifest || jsonb_build_object('operator_item_scan', p_operator_item_scan)
    END;
$$;

CREATE OR REPLACE FUNCTION public._audit_package_receive_event(
  p_organization_id uuid,
  p_store_id uuid,
  p_package_id uuid,
  p_action text,
  p_actor_id uuid,
  p_before_state jsonb,
  p_after_state jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.audit_events') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.audit_events (
    organization_id,
    store_id,
    entity_kind,
    entity_id,
    action,
    actor_id,
    actor_kind,
    before_state,
    after_state,
    metadata,
    idempotency_key
  )
  VALUES (
    p_organization_id,
    p_store_id,
    'package',
    p_package_id,
    p_action,
    p_actor_id,
    'operator',
    p_before_state,
    p_after_state,
    p_metadata,
    p_idempotency_key
  );
END;
$$;

-- Phase 6D-C hook — no claim reconcile in this slice.
CREATE OR REPLACE FUNCTION public.reconcile_package_finalize_claims(
  p_organization_id uuid,
  p_package_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'stub', true,
    'phase', '6D-C',
    'package_id', p_package_id::text
  );
$$;

COMMENT ON FUNCTION public.reconcile_package_finalize_claims IS
  'Phase 6D stub — full shortage/empty_box claim reconcile in 6D-C/D.';

-- ── 3. patch_package_missing_review ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.patch_package_missing_review(
  p_organization_id uuid,
  p_package_id uuid,
  p_slip_content_id uuid DEFAULT NULL,
  p_marked boolean DEFAULT true,
  p_marked_missing_qty integer DEFAULT 1,
  p_bulk_remaining boolean DEFAULT false,
  p_actor_profile_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg record;
  v_ois_before jsonb;
  v_ois_after jsonb;
  v_missing jsonb;
  v_qty integer;
  v_slip_key text;
BEGIN
  v_qty := GREATEST(1, LEAST(500, COALESCE(p_marked_missing_qty, 1)));

  SELECT p.id, p.organization_id, p.store_id, p.manifest_data
    INTO v_pkg
    FROM public.packages p
   WHERE p.id = p_package_id
     AND p.organization_id = p_organization_id
     AND p.deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'package_not_found');
  END IF;

  v_ois_before := public._package_operator_item_scan_read(v_pkg.manifest_data);

  IF public._package_receive_state(v_pkg.manifest_data) = 'finalized' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'package_finalized');
  END IF;

  v_missing := COALESCE(v_ois_before -> 'missing_review', '{}'::jsonb);
  IF jsonb_typeof(v_missing) <> 'object' THEN
    v_missing := '{}'::jsonb;
  END IF;

  IF COALESCE(v_missing -> 'by_slip_content_id', '{}'::jsonb) IS NULL
     OR jsonb_typeof(v_missing -> 'by_slip_content_id') <> 'object' THEN
    v_missing := v_missing || jsonb_build_object('by_slip_content_id', '{}'::jsonb);
  END IF;

  IF p_bulk_remaining THEN
    IF p_marked THEN
      v_missing := v_missing
        || jsonb_build_object(
          'bulk_remaining_marked_at', to_jsonb(now()),
          'bulk_remaining_marked_by', to_jsonb(p_actor_profile_id::text)
        );
    ELSE
      v_missing := v_missing
        || jsonb_build_object(
          'bulk_remaining_marked_at', NULL,
          'bulk_remaining_marked_by', NULL
        );
    END IF;
  ELSE
    IF p_slip_content_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'slip_content_id_required');
    END IF;
    v_slip_key := p_slip_content_id::text;
    IF p_marked THEN
      v_missing := jsonb_set(
        v_missing,
        ARRAY['by_slip_content_id'],
        (v_missing -> 'by_slip_content_id')
          || jsonb_build_object(
            v_slip_key,
            jsonb_build_object(
              'marked_missing_qty', v_qty,
              'marked_at', now(),
              'marked_by', p_actor_profile_id
            )
          ),
        true
      );
    ELSE
      v_missing := jsonb_set(
        v_missing,
        ARRAY['by_slip_content_id'],
        (v_missing -> 'by_slip_content_id') - v_slip_key,
        true
      );
    END IF;
  END IF;

  v_ois_after := v_ois_before
    || jsonb_build_object(
      'receive_state', COALESCE(v_ois_before ->> 'receive_state', 'open'),
      'finalize_revision', COALESCE((v_ois_before ->> 'finalize_revision')::integer, 0),
      'empty_box_marked', COALESCE((v_ois_before ->> 'empty_box_marked')::boolean, false),
      'missing_review', v_missing
    );

  UPDATE public.packages
     SET manifest_data = public._merge_package_manifest_operator_item_scan(v_pkg.manifest_data, v_ois_after),
         updated_at = now()
   WHERE id = p_package_id;

  PERFORM public._audit_package_receive_event(
    p_organization_id,
    v_pkg.store_id,
    p_package_id,
    'missing_review_patch',
    p_actor_profile_id,
    v_ois_before,
    v_ois_after,
    jsonb_build_object(
      'slip_content_id', p_slip_content_id,
      'marked', p_marked,
      'marked_missing_qty', v_qty,
      'bulk_remaining', p_bulk_remaining
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'package_id', p_package_id,
    'operator_item_scan', v_ois_after
  );
END;
$$;

-- ── 4. reopen_package_receive_correction ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_package_receive_correction(
  p_organization_id uuid,
  p_package_id uuid,
  p_actor_profile_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg record;
  v_ois_before jsonb;
  v_ois_after jsonb;
  v_revision integer;
BEGIN
  SELECT p.id, p.organization_id, p.store_id, p.manifest_data, p.status
    INTO v_pkg
    FROM public.packages p
   WHERE p.id = p_package_id
     AND p.organization_id = p_organization_id
     AND p.deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'package_not_found');
  END IF;

  v_ois_before := public._package_operator_item_scan_read(v_pkg.manifest_data);

  IF public._package_receive_state(v_pkg.manifest_data) <> 'finalized' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'package_id', p_package_id,
      'already_open', true,
      'operator_item_scan', v_ois_before
    );
  END IF;

  v_revision := COALESCE((v_ois_before ->> 'finalize_revision')::integer, 0) + 1;

  v_ois_after := v_ois_before
    || jsonb_build_object(
      'receive_state', 'open',
      'finalized_at', NULL,
      'finalized_by', NULL,
      'finalize_revision', v_revision
    );

  UPDATE public.packages
     SET manifest_data = public._merge_package_manifest_operator_item_scan(v_pkg.manifest_data, v_ois_after),
         status = CASE WHEN v_pkg.status IN ('closed', 'suspicious') THEN 'open' ELSE v_pkg.status END,
         updated_at = now()
   WHERE id = p_package_id;

  PERFORM public._audit_package_receive_event(
    p_organization_id,
    v_pkg.store_id,
    p_package_id,
    'package_reopen',
    p_actor_profile_id,
    v_ois_before,
    v_ois_after,
    jsonb_build_object('reason', COALESCE(p_reason, ''))
  );

  RETURN jsonb_build_object(
    'ok', true,
    'package_id', p_package_id,
    'finalize_revision', v_revision,
    'operator_item_scan', v_ois_after
  );
END;
$$;

-- ── 5. finalize_package_receive_close (6B + 6D manifest/audit/guards) ────────
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
  v_scanned_sum integer;
  v_ois_before jsonb;
  v_ois_after jsonb;
  v_revision integer;
  v_reconcile jsonb;
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
  v_ois_before := public._package_operator_item_scan_read(v_pkg.manifest_data);

  IF public._package_receive_state(v_pkg.manifest_data) = 'finalized' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'package_already_finalized');
  END IF;

  IF p_store_id IS NOT NULL AND v_pkg.store_id IS NOT NULL AND v_pkg.store_id <> p_store_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'store_mismatch');
  END IF;

  v_scanned_sum := public._package_scanned_quantity_sum(p_organization_id, p_package_id);

  IF p_empty_box AND v_scanned_sum > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty_box_not_allowed_when_scanned');
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

  v_revision := COALESCE((v_ois_before ->> 'finalize_revision')::integer, 0) + 1;

  v_ois_after := v_ois_before
    || jsonb_build_object(
      'receive_state', 'finalized',
      'finalized_at', now(),
      'finalized_by', p_actor_profile_id,
      'finalize_revision', v_revision,
      'empty_box_marked', p_empty_box,
      'missing_review', COALESCE(v_ois_before -> 'missing_review', '{}'::jsonb)
    );

  UPDATE public.packages
     SET status = v_new_status,
         notes = v_notes,
         manifest_data = public._merge_package_manifest_operator_item_scan(v_pkg.manifest_data, v_ois_after),
         updated_at = now()
   WHERE id = p_package_id;

  PERFORM public._audit_package_receive_event(
    p_organization_id,
    v_store,
    p_package_id,
    'package_finalize',
    p_actor_profile_id,
    v_ois_before,
    v_ois_after,
    jsonb_build_object(
      'status', v_new_status,
      'empty_box', p_empty_box,
      'scanned_sum', v_scanned_sum
    )
  );

  v_reconcile := public.reconcile_package_finalize_claims(p_organization_id, p_package_id);

  RETURN jsonb_build_object(
    'ok', true,
    'package_id', p_package_id,
    'status', v_new_status,
    'receive_state', 'finalized',
    'finalize_revision', v_revision,
    'scanned_sum', v_scanned_sum,
    'shortage_lines_created', v_shortage_created,
    'shortage_lines_touched', v_shortage_touched,
    'empty_box_case_id', v_empty_case_id,
    'empty_box_evidence_count', v_empty_evidence,
    'claim_cases_available', v_claim_cases_ok,
    'claim_evidence_available', v_claim_evidence_ok,
    'reconcile_hook', v_reconcile
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_package_receive_close IS
  'Phase 6B/6D: finalize package receive — shortage claim_lines, manifest operator_item_scan, audit, reconcile stub.';

COMMENT ON FUNCTION public.patch_package_missing_review IS
  'Phase 6D: patch packages.manifest_data.operator_item_scan.missing_review only — never creates return_items.';

COMMENT ON FUNCTION public.reopen_package_receive_correction IS
  'Phase 6D: reopen finalized package for operator correction; bumps finalize_revision and audits.';

REVOKE ALL ON FUNCTION public.patch_package_missing_review(uuid, uuid, uuid, boolean, integer, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_package_receive_correction(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_package_finalize_claims(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.patch_package_missing_review(uuid, uuid, uuid, boolean, integer, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reopen_package_receive_correction(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_package_finalize_claims(uuid, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
