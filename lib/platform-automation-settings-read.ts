import type pg from "pg";

import { normalizePlatformAutomationSettings } from "./platform-automation-schedule";
import {
  DEFAULT_PLATFORM_AUTOMATION_SETTINGS,
  type PlatformAutomationSettings,
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
