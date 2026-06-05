import { PWA_APP_VERSION } from "./pwa-app-version";

/** Singleton `platform_settings.pwa_settings` — Menorix operator-mobile policy. */
export type PlatformPwaSettings = {
  /** Schema bump — missing on legacy rows triggers demo-safe boolean rewrite. */
  POLICY_SCHEMA_VERSION?: number;
  ENABLE_VERSION_ENFORCEMENT: boolean;
  /** hardRequireInstalledPwaForOperators — hard-block mobile browser without install. */
  ENABLE_PWA_REQUIRED: boolean;
  ENABLE_ORIENTATION_LOCK: boolean;
  /** Allow browser-tab access (desktop admin/testing) without installed PWA. */
  ALLOW_BROWSER_BYPASS: boolean;
  HARD_BLOCK_BROWSER: boolean;
  HARD_BLOCK_MOBILE_BROWSER: boolean;
  /** Version hard-block applies only to installed standalone PWA, not browser tabs. */
  HARD_BLOCK_ONLY_INSTALLED_STALE_PWA: boolean;
  MINIMUM_SUPPORTED_VERSION: string;
  LATEST_AVAILABLE_VERSION: string;
};

export const DEFAULT_PLATFORM_PWA_SETTINGS: PlatformPwaSettings = {
  POLICY_SCHEMA_VERSION: 2,
  ENABLE_VERSION_ENFORCEMENT: true,
  ENABLE_PWA_REQUIRED: false,
  ENABLE_ORIENTATION_LOCK: true,
  ALLOW_BROWSER_BYPASS: true,
  HARD_BLOCK_BROWSER: false,
  HARD_BLOCK_MOBILE_BROWSER: false,
  HARD_BLOCK_ONLY_INSTALLED_STALE_PWA: true,
  MINIMUM_SUPPORTED_VERSION: PWA_APP_VERSION,
  LATEST_AVAILABLE_VERSION: PWA_APP_VERSION,
};

export type PwaVersionEndpointPayload = {
  ok: true;
  current_app_version: string;
  minimum_supported_version: string;
  latest_available_version: string;
  required_version: string;
  enable_version_enforcement: boolean;
  enable_pwa_required: boolean;
  enable_orientation_lock: boolean;
  allow_browser_bypass: boolean;
  hard_block_browser: boolean;
  hard_block_mobile_browser: boolean;
  hard_block_only_installed_stale_pwa: boolean;
  fetched_at: string;
};
