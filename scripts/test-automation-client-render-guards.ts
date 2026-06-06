/**
 * Simulate client-side derived values that run during AutomationApiCenterClient render.
 */
import assert from "node:assert/strict";

import { buildStoreAutomationSavePreview } from "../lib/platform-automation-ui-format";
import {
  computeApiCardNextRun,
  computeProductEnrichmentNextRun,
  computeRemovalHistoricalNextRun,
  computeRemovalRecentNextRun,
  deriveUtcRunTimesDisplayFromLocal,
  normalizeStoreAutomationSettings,
} from "../lib/platform-automation-schedule";
import { hobbyRemovalScheduleWarning } from "../lib/platform-automation-run-environment-client";

const PARTIAL_CASES: unknown[] = [
  null,
  {},
  { removal_api_sync: { enabled: true } },
  { removal_api_sync: { recent_sync: null, historical_backfill: null, cron_runtime: null } },
  {
    removal_api_sync: {
      enabled: true,
      recent_sync: {
        runs_per_day: 1,
        run_times_local: ["23:30"],
        timezone: "America/Los_Angeles",
        report_types: null,
      },
      historical_backfill: { enabled: true, window_keys: null },
    },
  },
];

for (const raw of PARTIAL_CASES) {
  const draft = normalizeStoreAutomationSettings(raw);
  const now = new Date();
  computeProductEnrichmentNextRun(draft.product_enrichment, now);
  computeRemovalRecentNextRun(draft.removal_api_sync, now);
  computeRemovalHistoricalNextRun(draft.removal_api_sync, now);
  computeApiCardNextRun(draft.reimbursements_api, now);
  deriveUtcRunTimesDisplayFromLocal(
    draft.removal_api_sync.recent_sync.timezone,
    draft.removal_api_sync.recent_sync.run_times_local,
  );
  hobbyRemovalScheduleWarning({
    runs_per_day: draft.removal_api_sync.recent_sync.runs_per_day,
    run_times_local: draft.removal_api_sync.recent_sync.run_times_local,
    run_hours_utc: draft.removal_api_sync.recent_sync.run_hours_utc,
  });
  buildStoreAutomationSavePreview(draft);
  assert.ok(draft.removal_api_sync.recent_sync.report_types.includes("removal_order"));
  assert.ok(Array.isArray(draft.removal_api_sync.historical_backfill.window_keys));
}

console.log("ok automation-client-render-guards");
