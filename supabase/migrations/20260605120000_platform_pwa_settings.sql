-- Menorix Mobile Scanner PWA enforcement settings (singleton platform_settings.pwa_settings JSONB).

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS pwa_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.platform_settings.pwa_settings IS
  'Menorix operator-mobile PWA policy: version enforcement, install requirement, orientation lock.';

UPDATE public.platform_settings
SET pwa_settings = pwa_settings || '{
  "ENABLE_VERSION_ENFORCEMENT": true,
  "ENABLE_PWA_REQUIRED": true,
  "ENABLE_ORIENTATION_LOCK": true,
  "ALLOW_BROWSER_BYPASS": false,
  "MINIMUM_SUPPORTED_VERSION": "1.2.0",
  "LATEST_AVAILABLE_VERSION": "1.2.0"
}'::jsonb
WHERE id = true
  AND (pwa_settings = '{}'::jsonb OR pwa_settings IS NULL);
