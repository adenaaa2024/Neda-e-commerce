import type pg from "pg";

import { normalizePlatformAutomationSettings } from "./platform-automation-schedule";
import {
  readLegacyPlatformAutomationSettings,
  readStoreAutomationSettings,
} from "./platform-automation-scope-storage";
import {
  DEFAULT_PLATFORM_AUTOMATION_SETTINGS,
  type PlatformAutomationSettings,
  type StoreAutomationSettings,
} from "./platform-automation-settings-types";

/** Read singleton platform_settings.automation_settings via Postgres (scripts / scheduler). */
export async function readPlatformAutomationSettingsFromPg(
  client: pg.Client | pg.PoolClient,
): Promise<PlatformAutomationSettings> {
  const r = await client.query(
    `SELECT automation_settings FROM public.platform_settings WHERE id = true LIMIT 1`,
  );
  const raw = r.rows[0]?.automation_settings;
  if (raw == null) return DEFAULT_PLATFORM_AUTOMATION_SETTINGS;
  return normalizePlatformAutomationSettings(raw);
}

/** Scoped org/store settings from v2 automation_settings.scopes. */
export async function readStoreAutomationSettingsFromPg(
  client: pg.Client | pg.PoolClient,
  organizationId: string,
  storeId: string,
): Promise<StoreAutomationSettings> {
  const r = await client.query(
    `SELECT automation_settings FROM public.platform_settings WHERE id = true LIMIT 1`,
  );
  const raw = r.rows[0]?.automation_settings;
  return readStoreAutomationSettings(raw, organizationId, storeId);
}

/** Legacy flat settings (first scope or defaults) — scheduler compat. */
export function readLegacyAutomationSettingsFromRaw(raw: unknown): PlatformAutomationSettings {
  return readLegacyPlatformAutomationSettings(raw);
}
