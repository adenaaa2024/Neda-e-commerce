/**
 * AUTOMATION-API-CENTER-UI-PHASE1 — static + unit checks
 *   npx tsx scripts/test-automation-api-center-ui-phase1.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reimbursementFlagWarning, readPlatformAutomationApiFlags } from "../lib/platform-automation-api-flags";
import { canEditPlatformProductSettings } from "../lib/platform-product-settings-access";
import {
  automationScopeKey,
  parseAutomationPersisted,
  readStoreAutomationSettings,
  writeStoreAutomationSettings,
} from "../lib/platform-automation-scope-storage";
import {
  computeApiCardNextRun,
  computeRemovalRecentNextRun,
  formatLocalRunTimesForInput,
  isAnyStoreAutomationScheduleEnabled,
  normalizeAutomationSettingsInput,
  normalizeStoreAutomationSettings,
} from "../lib/platform-automation-schedule";
import { DEFAULT_STORE_AUTOMATION_SETTINGS } from "../lib/platform-automation-settings-types";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function staticChecks(): void {
  const page = readFileSync(join(process.cwd(), "app/platform/settings/automation/page.tsx"), "utf8");
  const client = readFileSync(
    join(process.cwd(), "app/platform/settings/automation/AutomationApiCenterClient.tsx"),
    "utf8",
  );
  const importsClient = readFileSync(join(process.cwd(), "app/(admin)/imports/ImportsClient.tsx"), "utf8");
  const scopeBar = readFileSync(
    join(process.cwd(), "app/platform/settings/automation/AutomationScopeBar.tsx"),
    "utf8",
  );
  const actions = readFileSync(join(process.cwd(), "app/platform/settings/automation-settings-actions.ts"), "utf8");

  assert.match(page, /AutomationApiCenterClient/);
  assert.match(client, /API Automation/);
  assert.match(scopeBar, /Company/);
  assert.match(scopeBar, /Store/);
  assert.match(scopeBar, /Automation type/);
  assert.match(client, /AutomationScopeBar/);
  assert.match(client, /Product Data Update/);
  assert.match(client, /apiReportType === "product_data_update"/);
  assert.match(client, /apiReportType === "removal_shipment"/);
  assert.match(client, /Removal \/ Shipment Sync/);
  assert.match(client, /Reimbursements API/);
  assert.match(client, /Settlement API/);
  assert.match(client, /Finances Archive API/);
  assert.match(client, /Older Data Backfill/);
  assert.match(client, /FeatureFlagBanner/);
  assert.match(client, /listPlatformAutomationOrganizationsAction/);
  assert.match(client, /savePlatformAutomationSettingsAction/);
  assert.match(client, /postAutomationManualRun/);
  assert.match(client, /ImportResumeNotice/);
  assert.match(client, /AUTOMATION_MANUAL_RUN_ROUTES/);
  assert.match(actions, /canEditPlatformProductSettings/);
  assert.match(actions, /Only super_admin can edit platform automation settings/);
  assert.match(actions, /writeStoreAutomationSettings/);

  assert.match(importsClient, /UniversalImporter/);
  assert.match(importsClient, /role === "super_admin"\s*\?\s*<ImportsApiAutomationNotice/);
  assert.doesNotMatch(importsClient, /ReportsApiReimbursementsPanel/);
  assert.doesNotMatch(importsClient, /AutomationApiCenterClient/);
}

function accessChecks(): void {
  assert.equal(canEditPlatformProductSettings("super_admin"), true);
  assert.equal(canEditPlatformProductSettings("admin"), false);
}

function scopeStorageChecks(): void {
  const key = automationScopeKey(ORG, STORE);
  assert.match(key, /^[0-9a-f-]+:[0-9a-f-]+$/);

  const legacy = {
    product_enrichment: { enabled: true, runs_per_day: 1, run_hours_utc: [8] },
    removal_api_sync: { enabled: false, recent_sync: { runs_per_day: 2, run_hours_utc: [13, 21], rolling_days: 7 } },
  };
  const parsed = parseAutomationPersisted(legacy);
  assert.equal(parsed.version, 2);
  assert.ok(Object.keys(parsed.scopes).length >= 1);

  const enabled = normalizeStoreAutomationSettings({
    ...DEFAULT_STORE_AUTOMATION_SETTINGS,
    reimbursements_api: {
      ...DEFAULT_STORE_AUTOMATION_SETTINGS.reimbursements_api,
      enabled: true,
      run_hours_utc: [9],
    },
  });
  const doc = writeStoreAutomationSettings({}, ORG, STORE, enabled);
  assert.equal(doc.version, 2);
  const round = readStoreAutomationSettings(doc, ORG, STORE);
  assert.equal(round.reimbursements_api.enabled, true);
  assert.equal(round.reimbursements_api.run_hours_utc[0], 9);
}

function flagChecks(): void {
  const flags = readPlatformAutomationApiFlags();
  assert.equal(typeof flags.reports_worker_enabled, "boolean");
  const warn = reimbursementFlagWarning({ ...flags, reimbursements_enabled: false, reports_worker_enabled: false });
  assert.equal(warn.disabled, true);
  assert.match(warn.detail, /ENABLE_AMAZON_REPORTS_API_WORKER/);
}

function scheduleChecks(): void {
  const next = computeApiCardNextRun(
    { ...DEFAULT_STORE_AUTOMATION_SETTINGS.reimbursements_api, enabled: true, run_hours_utc: [14] },
    new Date("2026-06-01T10:00:00Z"),
  );
  assert.ok(next);
  assert.equal(next!.getUTCHours(), 14);
}

function normalizationChecks(): void {
  assert.equal(normalizeAutomationSettingsInput, normalizeStoreAutomationSettings);

  const nullScope = readStoreAutomationSettings(null, ORG, STORE);
  assert.ok(nullScope.removal_api_sync.recent_sync.run_times_local);
  assert.ok(nullScope.removal_api_sync.cron_runtime);

  const partial = normalizeStoreAutomationSettings({
    removal_api_sync: { enabled: true },
  });
  assert.equal(partial.removal_api_sync.enabled, true);
  assert.ok(Array.isArray(partial.removal_api_sync.recent_sync.report_types));
  assert.ok(partial.removal_api_sync.cron_runtime);

  computeRemovalRecentNextRun({ enabled: true } as never);
  formatLocalRunTimesForInput(undefined);
  assert.equal(isAnyStoreAutomationScheduleEnabled({ removal_api_sync: { enabled: true } } as never), true);

  const client = readFileSync(
    join(process.cwd(), "app/platform/settings/automation/AutomationApiCenterClient.tsx"),
    "utf8",
  );
  assert.match(client, /normalizeStoreAutomationSettings/);
}

function main(): void {
  staticChecks();
  accessChecks();
  scopeStorageChecks();
  flagChecks();
  scheduleChecks();
  normalizationChecks();
  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: "AUTOMATION-API-CENTER-UI-PHASE1",
        checks: ["static", "access", "scope_storage", "flags", "schedule", "normalization", "imports_unchanged"],
        safe_to_continue: true,
      },
      null,
      2,
    ),
  );
}

main();
