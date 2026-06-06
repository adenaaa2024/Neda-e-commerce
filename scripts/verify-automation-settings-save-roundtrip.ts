/**
 * Verify automation_settings save round-trip on original + staging Postgres.
 */
import assert from "node:assert/strict";
import pg from "pg";

import { automationScopeKey, writeStoreAutomationSettings } from "../lib/platform-automation-scope-storage";
import { normalizeStoreAutomationSettings } from "../lib/platform-automation-schedule";
import { PRODUCTION_ORG_ID, PRODUCTION_STORE_ID } from "../lib/production-removal-sync-run";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

async function verifySave(url: string, label: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const before = await client.query(`SELECT automation_settings FROM public.platform_settings WHERE id = true`);
    const raw = before.rows[0]?.automation_settings ?? {};
    const settings = normalizeStoreAutomationSettings({
      removal_api_sync: {
        enabled: true,
        recent_sync: {
          runs_per_day: 1,
          run_times_local: ["23:30"],
          run_hours_utc: [21],
          timezone: "America/Los_Angeles",
          max_runtime_seconds: 1800,
          rolling_days: 7,
          report_types: ["removal_order", "removal_shipment"],
          rebuild_expected_packages: true,
          retry_on_failure: true,
        },
      },
    });
    const nextDoc = writeStoreAutomationSettings(raw, PRODUCTION_ORG_ID, PRODUCTION_STORE_ID, settings);
    await client.query(
      `UPDATE public.platform_settings SET automation_settings = $1::jsonb WHERE id = true`,
      [JSON.stringify(nextDoc)],
    );
    const after = await client.query(`SELECT automation_settings FROM public.platform_settings WHERE id = true`);
    const key = automationScopeKey(PRODUCTION_ORG_ID, PRODUCTION_STORE_ID);
    const scope = (after.rows[0]?.automation_settings as { scopes?: Record<string, unknown> })?.scopes?.[key] as {
      removal_api_sync?: { enabled?: boolean; recent_sync?: Record<string, unknown> };
    };
    assert.equal(scope?.removal_api_sync?.enabled, true);
    assert.equal(scope?.removal_api_sync?.recent_sync?.runs_per_day, 1);
    assert.equal((scope?.removal_api_sync?.recent_sync?.run_times_local as string[])?.[0], "23:30");
    assert.equal(scope?.removal_api_sync?.recent_sync?.max_runtime_seconds, 1800);
    const utcHours = scope?.removal_api_sync?.recent_sync?.run_hours_utc as number[];
    assert.equal(utcHours?.[0], 6, `${label}: stale UTC hour should be corrected to 6`);
    await client.query(`UPDATE public.platform_settings SET automation_settings = $1::jsonb WHERE id = true`, [
      JSON.stringify(raw),
    ]);
    console.log(`ok save round-trip ${label}`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const original = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  const staging = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || process.env.DIRECT_POSTGRES_URL?.trim();
  if (original) await verifySave(original, "original");
  if (staging) await verifySave(staging, "staging");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
