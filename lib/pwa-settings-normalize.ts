import {
  DEFAULT_PLATFORM_PWA_SETTINGS,
  type PlatformPwaSettings,
} from "./pwa-settings-types";
import { PWA_APP_VERSION } from "./pwa-app-version";

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readVersion(value: unknown, fallback: string): string {
  const v = String(value ?? "").trim();
  return v || fallback;
}

function isLegacyAggressivePolicy(src: Record<string, unknown>): boolean {
  const schema = typeof src.POLICY_SCHEMA_VERSION === "number" ? src.POLICY_SCHEMA_VERSION : 0;
  if (schema >= 2) return false;
  return src.HARD_BLOCK_ONLY_INSTALLED_STALE_PWA === undefined;
}

/** Merge partial JSONB from DB with typed defaults. Legacy rows get demo-safe gate booleans. */
export function normalizePlatformPwaSettings(raw: unknown): PlatformPwaSettings {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const legacy = isLegacyAggressivePolicy(src);
  const defaults = DEFAULT_PLATFORM_PWA_SETTINGS;

  const minimum = readVersion(
    src.MINIMUM_SUPPORTED_VERSION,
    legacy ? PWA_APP_VERSION : defaults.MINIMUM_SUPPORTED_VERSION,
  );
  const latest = readVersion(
    src.LATEST_AVAILABLE_VERSION,
    legacy ? PWA_APP_VERSION : defaults.LATEST_AVAILABLE_VERSION,
  );

  if (legacy) {
    return {
      POLICY_SCHEMA_VERSION: 2,
      ENABLE_VERSION_ENFORCEMENT: readBool(src.ENABLE_VERSION_ENFORCEMENT, defaults.ENABLE_VERSION_ENFORCEMENT),
      ENABLE_PWA_REQUIRED: false,
      ENABLE_ORIENTATION_LOCK: readBool(src.ENABLE_ORIENTATION_LOCK, defaults.ENABLE_ORIENTATION_LOCK),
      ALLOW_BROWSER_BYPASS: true,
      HARD_BLOCK_BROWSER: false,
      HARD_BLOCK_MOBILE_BROWSER: false,
      HARD_BLOCK_ONLY_INSTALLED_STALE_PWA: true,
      MINIMUM_SUPPORTED_VERSION: PWA_APP_VERSION,
      LATEST_AVAILABLE_VERSION: PWA_APP_VERSION,
    };
  }

  const normalized = {
    POLICY_SCHEMA_VERSION: 2 as const,
    ENABLE_VERSION_ENFORCEMENT: readBool(
      src.ENABLE_VERSION_ENFORCEMENT,
      defaults.ENABLE_VERSION_ENFORCEMENT,
    ),
    ENABLE_PWA_REQUIRED: readBool(src.ENABLE_PWA_REQUIRED, defaults.ENABLE_PWA_REQUIRED),
    ENABLE_ORIENTATION_LOCK: readBool(
      src.ENABLE_ORIENTATION_LOCK,
      defaults.ENABLE_ORIENTATION_LOCK,
    ),
    ALLOW_BROWSER_BYPASS: readBool(src.ALLOW_BROWSER_BYPASS, defaults.ALLOW_BROWSER_BYPASS),
    HARD_BLOCK_BROWSER: readBool(src.HARD_BLOCK_BROWSER, defaults.HARD_BLOCK_BROWSER),
    HARD_BLOCK_MOBILE_BROWSER: readBool(
      src.HARD_BLOCK_MOBILE_BROWSER,
      defaults.HARD_BLOCK_MOBILE_BROWSER,
    ),
    HARD_BLOCK_ONLY_INSTALLED_STALE_PWA: readBool(
      src.HARD_BLOCK_ONLY_INSTALLED_STALE_PWA,
      defaults.HARD_BLOCK_ONLY_INSTALLED_STALE_PWA,
    ),
    MINIMUM_SUPPORTED_VERSION: minimum,
    LATEST_AVAILABLE_VERSION: latest,
  };
  return normalized;
}
