/**
 * AUTOMATION-SETTINGS-ORCHESTRATOR-WIRING-DRYRUN — unit + staging dry-run
 *   npx tsx scripts/test-automation-settings-orchestrator-wiring-dryrun.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { readPlatformAutomationSettingsFromPg } from "../lib/platform-automation-settings-read";
import {
  evaluateDailyScheduleDue,
  evaluateProductEnrichmentSchedule,
  evaluateRemovalAutomationSchedule,
  resolveSchedulerAction,
} from "../lib/platform-automation-scheduler-due";
import { DEFAULT_PLATFORM_AUTOMATION_SETTINGS } from "../lib/platform-automation-settings-types";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

function staticChecks(): void {
  const orch = readFileSync(join(process.cwd(), "scripts/removal-automation-orchestrator.ts"), "utf8");
  const tick = readFileSync(join(process.cwd(), "scripts/platform-automation-scheduler-tick.ts"), "utf8");
  assert.match(orch, /readPlatformAutomationSettingsFromPg/);
  assert.match(orch, /evaluateRemovalAutomationSchedule/);
  assert.match(orch, /--from-scheduler/);
  assert.match(tick, /platform_settings\.automation_settings/);
  assert.match(tick, /auto_apply: false/);
}

function unitDisabledNoop(): void {
  const disabled = evaluateDailyScheduleDue(false, [13, 21], new Date("2026-06-01T13:00:00Z"));
  assert.equal(disabled.due, false);
  assert.equal(disabled.reason, "schedule_disabled");

  const action = resolveSchedulerAction({
    enabled: false,
    due: true,
    applyRequested: false,
    confirmApply: false,
  });
  assert.equal(action.action, "noop");
  assert.equal(action.reason, "disabled");

  const pe = evaluateProductEnrichmentSchedule(DEFAULT_PLATFORM_AUTOMATION_SETTINGS.product_enrichment);
  assert.equal(pe.schedule.enabled, false);
  assert.equal(pe.schedule.due, false);
}

function unitEnabledDueDryRun(): void {
  const enabledSchedule = {
    ...DEFAULT_PLATFORM_AUTOMATION_SETTINGS.product_enrichment,
    enabled: true,
    run_hours_utc: [13, 21],
  };
  const due = evaluateDailyScheduleDue(true, [13, 21], new Date("2026-06-01T13:30:00Z"));
  assert.equal(due.due, true);
  assert.equal(due.reason, "hour_match");

  const notDue = evaluateDailyScheduleDue(true, [13, 21], new Date("2026-06-01T10:00:00Z"));
  assert.equal(notDue.due, false);

  const dryRun = resolveSchedulerAction({
    enabled: true,
    due: true,
    applyRequested: false,
    confirmApply: false,
  });
  assert.equal(dryRun.action, "dry_run_log");

  const rem = evaluateRemovalAutomationSchedule({
    ...DEFAULT_PLATFORM_AUTOMATION_SETTINGS.removal_api_sync,
    enabled: true,
  });
  assert.equal(rem.historical.auto_apply, false);
  assert.ok(rem.historical.window_keys.includes("nov_2025_w1"));
}

async function stagingDisabledNoop(): Promise<void> {
  loadEnvLocalIntoProcess();
  assert.equal(refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""), STAGING_REF);
  assert.notEqual(process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim(), "true");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  assert.ok(dbUrl);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const settings = await readPlatformAutomationSettingsFromPg(client);
  await client.end();

  assert.equal(settings.product_enrichment.enabled, false);
  assert.equal(settings.removal_api_sync.enabled, false);

  const out = execSync(
    "npx tsx scripts/removal-automation-orchestrator.ts --from-scheduler --run-id=wiring-test-noop",
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.match(out, /NOOP|"status":"NOOP"/);

  const tickOut = execSync(
    "npx tsx scripts/platform-automation-scheduler-tick.ts --run-id=wiring-test-tick",
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.match(tickOut, /noop|"action":"noop"/i);
}

async function stagingEnabledDueDryRun(): Promise<void> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const hour = new Date().getUTCHours();
  await client.query(
    `UPDATE public.platform_settings
     SET automation_settings = automation_settings || $1::jsonb
     WHERE id = true`,
    [
      JSON.stringify({
        product_enrichment: { enabled: true, runs_per_day: 1, run_hours_utc: [hour] },
        removal_api_sync: {
          enabled: true,
          recent_sync: { runs_per_day: 1, run_hours_utc: [hour], rolling_days: 7 },
        },
      }),
    ],
  );
  await client.end();

  try {
    const out = execSync(
      "npx tsx scripts/platform-automation-scheduler-tick.ts --run-id=wiring-test-due --force-due",
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.match(out, /dry_run|dry-run|Would enqueue/i);
  } finally {
    const c2 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await c2.connect();
    await c2.query(
      `UPDATE public.platform_settings
       SET automation_settings = $1::jsonb WHERE id = true`,
      [JSON.stringify(DEFAULT_PLATFORM_AUTOMATION_SETTINGS)],
    );
    await c2.end();
  }
}

async function main(): Promise<void> {
  staticChecks();
  unitDisabledNoop();
  unitEnabledDueDryRun();
  await stagingDisabledNoop();
  await stagingEnabledDueDryRun();
  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: "AUTOMATION-SETTINGS-ORCHESTRATOR-WIRING-DRYRUN",
        safe_to_continue: true,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
