-- Safe add: platform_settings.automation_settings (no row overwrites).
-- Idempotent; production may already have 20260903120000 — IF NOT EXISTS is harmless.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS automation_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.platform_settings.automation_settings IS
  'Superadmin automation schedules (v2 scopes JSON). Defaults to empty object; per org:store scopes written by Automation UI.';
