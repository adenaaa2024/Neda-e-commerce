/**
 * SUPERADMIN-AUTOMATION-SETTINGS-FINALIZE — static + schedule unit checks
 *   npx tsx scripts/test-superadmin-automation-settings-finalize.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canEditPlatformProductSettings } from "../lib/platform-product-settings-access";
import {
  buildAutomationSavePreview,
  formatAutomationStatusLabel,
  formatAutomationTimestamp,
} from "../lib/platform-automation-ui-format";
import {
  computeNextDailyRunUtc,
  computeNextWeeklyRunUtc,
  computeProductEnrichmentNextRun,
  computeRemovalHistoricalNextRun,
  computeRemovalRecentNextRun,
  isAnyAutomationScheduleEnabled,
  normalizePlatformAutomationSettings,
  parseHoursUtcFromInput,
} from "../lib/platform-automation-schedule";
import {
  DEFAULT_PLATFORM_AUTOMATION_SETTINGS,
  DEFAULT_PRODUCT_ENRICHMENT_SCHEDULE,
} from "../lib/platform-automation-settings-types";

function staticChecks(): void {
  const page = readFileSync(join(process.cwd(), "app/platform/settings/automation/page.tsx"), "utf8");
  const client = readFileSync(
    join(process.cwd(), "app/platform/settings/automation/AutomationApiCenterClient.tsx"),
    "utf8",
  );
  const formatLib = readFileSync(join(process.cwd(), "lib/platform-automation-ui-format.ts"), "utf8");

  assert.match(page, /AutomationApiCenterClient/);
  assert.match(client, /API Automation/);
  assert.match(client, /Product Data Update/);
  assert.match(client, /Removal \/ Shipment Sync/);
  assert.match(client, /Older Data Backfill/);
  assert.match(client, /Runs separately from recent daily sync|One small window per week/);
  assert.match(client, /Schedules are off until you enable them/);
  assert.match(client, /Preview before save/);

  const appShell = readFileSync(join(process.cwd(), "components/AppShell.tsx"), "utf8");
  assert.match(appShell, /href === "\/platform\/settings"\) return path === "\/platform\/settings"/);
  assert.doesNotMatch(client, /background_jobs/);

  assert.match(formatLib, /buildAutomationSavePreview/);
  assert.match(formatLib, /formatAutomationTimestamp/);

  assert.ok(
    readFileSync(join(process.cwd(), "app/platform/settings/automation-settings-actions.ts"), "utf8").includes(
      "canEditPlatformProductSettings",
    ),
  );
  assert.ok(
    readFileSync(join(process.cwd(), "app/platform/settings/automation-settings-actions.ts"), "utf8").includes(
      "Only super_admin can edit platform automation settings",
    ),
  );
  assert.ok(readFileSync(join(process.cwd(), "lib/sidebar-config.ts"), "utf8").includes("/platform/settings/automation"));
  assert.ok(
    readFileSync(join(process.cwd(), "supabase/migrations/20260903120000_platform_automation_settings.sql"), "utf8").includes(
      '"enabled": false',
    ),
  );
}

function accessChecks(): void {
  assert.equal(canEditPlatformProductSettings("super_admin"), true);
  assert.equal(canEditPlatformProductSettings("SUPER_ADMIN"), true);
  assert.equal(canEditPlatformProductSettings("admin"), false);
  assert.equal(canEditPlatformProductSettings("system_admin"), false);
  assert.equal(canEditPlatformProductSettings(null), false);
}

function scheduleChecks(): void {
  const defaults = normalizePlatformAutomationSettings({});
  assert.equal(defaults.product_enrichment.enabled, false);
  assert.equal(defaults.removal_api_sync.enabled, false);
  assert.equal(defaults.removal_api_sync.historical_backfill.enabled, false);
  assert.equal(isAnyAutomationScheduleEnabled(defaults), false);

  const disabledPreview = buildAutomationSavePreview(defaults);
  assert.match(disabledPreview.productUpdate, /off/i);
  assert.match(disabledPreview.removalSync, /off/i);
  assert.match(disabledPreview.historicalBackfill, /off/i);

  const disabledNext = computeProductEnrichmentNextRun(DEFAULT_PRODUCT_ENRICHMENT_SCHEDULE, new Date("2026-06-01T10:00:00Z"));
  assert.equal(disabledNext, null);

  const enabledPe = {
    ...DEFAULT_PRODUCT_ENRICHMENT_SCHEDULE,
    enabled: true,
    run_hours_utc: [13, 21],
    runs_per_day: 2,
  };
  const enabledSettings = { ...DEFAULT_PLATFORM_AUTOMATION_SETTINGS, product_enrichment: enabledPe };
  const enabledPreview = buildAutomationSavePreview(enabledSettings);
  assert.match(enabledPreview.productUpdate, /Product Data Update will run/);

  const nextPe = computeProductEnrichmentNextRun(enabledPe, new Date("2026-06-01T10:00:00Z"));
  assert.ok(nextPe);
  assert.equal(nextPe!.getUTCHours(), 13);

  const ts = formatAutomationTimestamp(nextPe!.toISOString());
  assert.ok(ts.primary);
  assert.ok(ts.secondary?.includes("UTC"));

  const remEnabled = {
    ...DEFAULT_PLATFORM_AUTOMATION_SETTINGS.removal_api_sync,
    enabled: true,
  };
  const nextRem = computeRemovalRecentNextRun(remEnabled, new Date("2026-06-01T22:00:00Z"));
  assert.ok(nextRem);
  assert.equal(nextRem!.getUTCHours(), 13);
  assert.equal(nextRem!.getUTCDate(), 2);

  const histNext = computeRemovalHistoricalNextRun(
    {
      ...remEnabled,
      historical_backfill: {
        ...remEnabled.historical_backfill,
        enabled: true,
        run_day_of_week: 1,
        run_hour_utc: 4,
      },
    },
    new Date("2026-06-01T10:00:00Z"),
  );
  assert.ok(histNext);
  assert.equal(histNext!.getUTCDay(), 1);

  assert.equal(formatAutomationStatusLabel("never"), "Not run yet");

  assert.equal(
    computeNextDailyRunUtc(false, [6, 18], new Date("2026-06-01T10:00:00Z")),
    null,
  );
  assert.equal(
    computeNextWeeklyRunUtc(false, 0, 4, new Date("2026-06-01T10:00:00Z")),
    null,
  );

  const hours = parseHoursUtcFromInput("06:00, 18:30, bad", 2);
  assert.deepEqual(hours, [6, 18]);
}

function main(): void {
  staticChecks();
  accessChecks();
  scheduleChecks();
  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: "PLATFORM-AUTOMATION-UX-LABELS-AND-ACTIVE-NAV-FIX",
        checks: ["static", "access", "schedule", "preview"],
        safe_to_continue: true,
      },
      null,
      2,
    ),
  );
}

main();
