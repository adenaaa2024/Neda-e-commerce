-- Backfill pim_import_sessions for existing PIM async Product Master uploads.

BEGIN;

INSERT INTO public.pim_import_sessions (
  organization_id,
  store_id,
  upload_id,
  import_type,
  source_filename,
  uploaded_by,
  created_at,
  updated_at,
  status,
  progress_percent,
  current_step,
  preview_metrics,
  apply_metrics,
  metadata
)
SELECT
  r.organization_id,
  COALESCE(
    NULLIF(BTRIM(r.metadata->>'import_store_id'), '')::uuid,
    NULLIF(BTRIM(r.metadata->>'ledger_store_id'), '')::uuid,
    NULLIF(BTRIM(r.metadata->>'store_id'), '')::uuid
  ) AS store_id,
  r.id,
  'pim_product_master',
  COALESCE(NULLIF(BTRIM(r.file_name), ''), 'upload'),
  r.created_by,
  r.created_at,
  r.updated_at,
  CASE
    WHEN r.metadata->>'pim_import_cancelled' IN ('true', 't', '1') THEN 'cancelled'
    WHEN lower(COALESCE(r.metadata->>'preview_status', '')) = 'cancelled' THEN 'cancelled'
    WHEN lower(COALESCE(r.metadata->'pim_import_job'->>'lifecycle', '')) = 'completed' THEN 'completed'
    WHEN lower(COALESCE(r.metadata->'pim_import_job'->>'lifecycle', '')) = 'cancelled' THEN 'cancelled'
    WHEN lower(COALESCE(r.metadata->'pim_import_job'->>'lifecycle', '')) IN ('failed', 'error') THEN 'failed'
    WHEN lower(COALESCE(r.metadata->>'preview_status', '')) = 'preview_ready' THEN 'preview_ready'
    WHEN lower(COALESCE(r.metadata->'pim_import_job'->>'lifecycle', '')) IN ('importing', 'import_queued') THEN 'importing'
    WHEN lower(COALESCE(r.metadata->'pim_import_job'->>'lifecycle', '')) = 'previewing' THEN 'preview_running'
    ELSE 'uploaded'
  END,
  LEAST(
    100,
    GREATEST(
      0,
      CASE
        WHEN (r.metadata->'pim_import_job'->>'progress_pct') ~ '^[0-9]+$'
          THEN (r.metadata->'pim_import_job'->>'progress_pct')::integer
        ELSE 0
      END
    )
  ),
  COALESCE(NULLIF(BTRIM(r.metadata->'pim_import_job'->>'stage_label'), ''), 'uploaded'),
  COALESCE(
    r.metadata->'pim_import_job'->'preview_quality',
    r.metadata->'pim_preview_result'->'quality',
    '{}'::jsonb
  ),
  COALESCE(r.metadata->'pim_import_job'->'apply_metrics', '{}'::jsonb),
  jsonb_build_object(
    'backfilled',
    true,
    'content_sha256',
    to_jsonb(r.metadata->>'content_sha256')
  )
FROM public.raw_report_uploads r
WHERE r.report_type = 'pim_product_master'
  AND (
    r.metadata->>'pim_async_import' IN ('true', 't', '1')
    OR r.metadata->>'pim_catalog_seed' IN ('true', 't', '1')
  )
  AND NOT EXISTS (SELECT 1 FROM public.pim_import_sessions s WHERE s.upload_id = r.id)
  AND NULLIF(BTRIM(COALESCE(r.metadata->>'import_store_id', r.metadata->>'ledger_store_id', r.metadata->>'store_id')), '')
    ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

UPDATE public.raw_report_uploads r
SET
  metadata = COALESCE(r.metadata, '{}'::jsonb) || jsonb_build_object('pim_import_session_id', s.id::text),
  updated_at = now()
FROM public.pim_import_sessions s
WHERE s.upload_id = r.id
  AND (COALESCE(r.metadata, '{}'::jsonb)->>'pim_import_session_id') IS DISTINCT FROM s.id::text;

NOTIFY pgrst, 'reload schema';

COMMIT;
