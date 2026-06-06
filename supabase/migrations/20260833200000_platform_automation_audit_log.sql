-- Append-only audit trail for superadmin platform automation settings / manual runs.
-- Does not use audit_events (warehouse entity_kind constraints).

CREATE TABLE IF NOT EXISTS public.platform_automation_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  automation_type text NOT NULL,
  action text NOT NULL,
  actor_user_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  actor_email text,
  before_json jsonb,
  after_json jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.platform_automation_audit_log IS
  'Superadmin automation UI: schedule saves, field changes, run now, resume. No secrets.';

CREATE INDEX IF NOT EXISTS idx_platform_automation_audit_org_store_created
  ON public.platform_automation_audit_log (organization_id, store_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_automation_audit_type_action
  ON public.platform_automation_audit_log (automation_type, action, created_at DESC);

ALTER TABLE public.platform_automation_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_automation_audit_log_service_all ON public.platform_automation_audit_log;
CREATE POLICY platform_automation_audit_log_service_all
  ON public.platform_automation_audit_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT ALL ON public.platform_automation_audit_log TO service_role;
