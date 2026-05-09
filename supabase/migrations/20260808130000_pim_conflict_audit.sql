-- 20260808130000_pim_conflict_audit.sql
-- Audit log for PIM conflict repair actions (detach wrong imap links).
-- NOT a history table. NOT a session table. Repair audit only.

CREATE TABLE IF NOT EXISTS public.pim_conflict_audit_log (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL,
  store_id          uuid        NOT NULL,
  performed_by      uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  action            text        NOT NULL
    CHECK (action IN ('detach_imap', 'soft_delete_imap', 'skip_csv_row')),
  upload_id         uuid        REFERENCES public.raw_report_uploads (id) ON DELETE SET NULL,
  imap_row_id       uuid,
  identifier_type   text,
  identifier_value  text,
  before_product_id uuid,
  after_product_id  uuid,
  csv_row_number    text,
  performed_at      timestamptz NOT NULL DEFAULT now(),
  notes             text,
  metadata          jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pca_log_org_store_time
  ON public.pim_conflict_audit_log (organization_id, store_id, performed_at DESC);

COMMENT ON TABLE public.pim_conflict_audit_log IS
  'Audit trail for PIM identifier conflict repair actions (detach wrong imap links). '
  'Every admin repair writes one row per affected imap row.';

ALTER TABLE public.pim_conflict_audit_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'pim_conflict_audit_log'
      AND policyname = 'pim_conflict_audit_org_select'
  ) THEN
    CREATE POLICY pim_conflict_audit_org_select
      ON public.pim_conflict_audit_log FOR SELECT
      USING (
        organization_id IN (
          SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
      );
  END IF;
END $$;

GRANT SELECT ON public.pim_conflict_audit_log TO authenticated;
GRANT INSERT ON public.pim_conflict_audit_log TO service_role;
