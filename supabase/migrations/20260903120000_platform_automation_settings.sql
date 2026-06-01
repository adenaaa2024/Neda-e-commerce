-- Platform automation schedule (Menorix superadmin-only).
-- Stored on singleton platform_settings.automation_settings JSONB.
-- All schedules default disabled — no cron/job enable until explicitly saved.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS automation_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.platform_settings.automation_settings IS
  'Superadmin-only automation schedule: product_enrichment + removal_api_sync. Defaults all disabled.';

-- Idempotent seed: merge defaults without overwriting operator saves.
UPDATE public.platform_settings
SET automation_settings = automation_settings || '{
  "product_enrichment": {
    "enabled": false,
    "runs_per_day": 1,
    "run_hours_utc": [6]
  },
  "removal_api_sync": {
    "enabled": false,
    "recent_sync": {
      "runs_per_day": 2,
      "run_hours_utc": [13, 21],
      "rolling_days": 7
    },
    "historical_backfill": {
      "enabled": false,
      "runs_per_week": 1,
      "run_day_of_week": 0,
      "run_hour_utc": 4,
      "window_keys": ["nov_2025_w1"]
    }
  }
}'::jsonb
WHERE id = true
  AND (automation_settings = '{}'::jsonb OR automation_settings IS NULL);
