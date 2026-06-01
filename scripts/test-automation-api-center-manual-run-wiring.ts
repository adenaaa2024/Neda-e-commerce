/**
 * AUTOMATION-API-CENTER-MANUAL-RUN-WIRING — static checks
 *   npx tsx scripts/test-automation-api-center-manual-run-wiring.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reimbursementFlagWarning, readPlatformAutomationApiFlags } from "../lib/platform-automation-api-flags";
import {
  AUTOMATION_MANUAL_RUN_ROUTES,
  featureFlagBlockedMessage,
} from "../lib/platform-automation-manual-run-ui";

function staticChecks(): void {
  const client = readFileSync(
    join(process.cwd(), "app/platform/settings/automation/AutomationApiCenterClient.tsx"),
    "utf8",
  );
  const shared = readFileSync(
    join(process.cwd(), "app/platform/settings/automation/automation-api-center-shared.tsx"),
    "utf8",
  );
  const runStatus = readFileSync(join(process.cwd(), "lib/platform-automation-run-status.ts"), "utf8");
  const runUi = readFileSync(join(process.cwd(), "lib/platform-automation-manual-run-ui.ts"), "utf8");

  assert.match(client, /AUTOMATION_MANUAL_RUN_ROUTES\.reimbursements_run/);
  assert.match(client, /AUTOMATION_MANUAL_RUN_ROUTES\.settlement_run/);
  assert.match(client, /AUTOMATION_MANUAL_RUN_ROUTES\.finances_run/);
  assert.match(client, /AUTOMATION_MANUAL_RUN_ROUTES\.removal_order_run/);
  assert.match(client, /AUTOMATION_MANUAL_RUN_ROUTES\.removal_shipment_run/);
  assert.match(client, /enqueueProductEnrichmentJob/);
  assert.match(client, /resumeReimbursements/);
  assert.match(client, /resumeSettlement/);
  assert.match(client, /resumeFinances/);
  assert.match(client, /window_start/);
  assert.match(client, /organization_id: orgId/);
  assert.match(client, /store_id: storeId/);
  assert.match(client, /postAutomationManualRun/);
  assert.match(client, /featureFlagBlockedMessage/);
  assert.doesNotMatch(client, /SUPABASE_SERVICE_ROLE/);
  assert.doesNotMatch(client, /process\.env\.[A-Z_]*SECRET/);

  assert.match(shared, /ImportResumeNotice/);
  assert.match(shared, /onResume/);
  assert.match(shared, /\/imports/);

  assert.match(runStatus, /buildAutomationManualRunStates/);
  assert.match(runStatus, /manual_runs/);
  assert.match(runStatus, /readFinancesArchiveRuntime/);
  assert.match(runStatus, /background_jobs/);
  assert.match(runStatus, /raw_report_uploads/);

  assert.equal(AUTOMATION_MANUAL_RUN_ROUTES.reimbursements_run, "/api/settings/imports/reports-api/run");
  assert.equal(
    AUTOMATION_MANUAL_RUN_ROUTES.settlement_resume,
    "/api/settings/imports/reports-api/settlement/resume",
  );
  assert.doesNotMatch(runUi, /service_role/i);
}

function flagMessageChecks(): void {
  const flags = readPlatformAutomationApiFlags();
  const warn = reimbursementFlagWarning({ ...flags, reimbursements_enabled: false });
  assert.equal(warn.disabled, true);
  const msg = featureFlagBlockedMessage("worker_disabled", "fallback");
  assert.match(msg, /ENABLE_AMAZON_REPORTS_API_WORKER/);
}

function main(): void {
  staticChecks();
  flagMessageChecks();
  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: "AUTOMATION-API-CENTER-MANUAL-RUN-WIRING",
        routes: AUTOMATION_MANUAL_RUN_ROUTES,
        safe_to_continue: true,
      },
      null,
      2,
    ),
  );
}

main();
