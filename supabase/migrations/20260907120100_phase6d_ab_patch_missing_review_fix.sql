-- Fix missing_review JSON path merge in patch_package_missing_review
BEGIN;

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
  IF v_missing -> 'by_slip_content_id' IS NULL OR jsonb_typeof(v_missing -> 'by_slip_content_id') <> 'object' THEN
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
        ARRAY['by_slip_content_id', v_slip_key],
        jsonb_build_object(
          'marked_missing_qty', v_qty,
          'marked_at', now(),
          'marked_by', p_actor_profile_id
        ),
        true
      );
    ELSE
      v_missing := v_missing #- ARRAY['by_slip_content_id', v_slip_key];
    END IF;
  END IF;

  v_ois_after := v_ois_before
    || jsonb_build_object(
      'receive_state', COALESCE(v_ois_before ->> 'receive_state', 'open'),
      'finalized_at', v_ois_before -> 'finalized_at',
      'finalized_by', v_ois_before -> 'finalized_by',
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

COMMIT;

NOTIFY pgrst, 'reload schema';
