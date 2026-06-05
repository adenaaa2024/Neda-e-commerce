import { PWA_APP_VERSION } from "./pwa-app-version";
import type { PlatformPwaSettings, PwaVersionEndpointPayload } from "./pwa-settings-types";

export function buildPwaVersionEndpointPayload(
  settings: PlatformPwaSettings,
): PwaVersionEndpointPayload {
  return {
    ok: true,
    current_app_version: PWA_APP_VERSION,
    minimum_supported_version: settings.MINIMUM_SUPPORTED_VERSION,
    latest_available_version: settings.LATEST_AVAILABLE_VERSION,
    required_version: settings.MINIMUM_SUPPORTED_VERSION,
    enable_version_enforcement: settings.ENABLE_VERSION_ENFORCEMENT,
    enable_pwa_required: settings.ENABLE_PWA_REQUIRED,
    enable_orientation_lock: settings.ENABLE_ORIENTATION_LOCK,
    allow_browser_bypass: settings.ALLOW_BROWSER_BYPASS,
    hard_block_browser: settings.HARD_BLOCK_BROWSER,
    hard_block_mobile_browser: settings.HARD_BLOCK_MOBILE_BROWSER,
    hard_block_only_installed_stale_pwa: settings.HARD_BLOCK_ONLY_INSTALLED_STALE_PWA,
    fetched_at: new Date().toISOString(),
  };
}
