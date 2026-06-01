/**
 * AUTOMATION-API-CENTER-UI-QA-AND-COMBO-REPORT-POLISH — static checks
 *   npx tsx scripts/test-automation-api-center-ui-qa-polish.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUTOMATION_API_REPORT_TYPE_OPTIONS,
  readAutomationApiReportType,
} from "../lib/platform-automation-api-report-type";

function staticChecks(): void {
  const client = readFileSync(
    join(process.cwd(), "app/platform/settings/automation/AutomationApiCenterClient.tsx"),
    "utf8",
  );
  const scopeBar = readFileSync(
    join(process.cwd(), "app/platform/settings/automation/AutomationScopeBar.tsx"),
    "utf8",
  );
  const importsClient = readFileSync(join(process.cwd(), "app/(admin)/imports/ImportsClient.tsx"), "utf8");

  assert.match(scopeBar, /Automation scope/);
  assert.match(scopeBar, /aria-label="Automation company"/);
  assert.match(scopeBar, /aria-label="Automation store"/);
  assert.match(scopeBar, /Automation type/);
  assert.match(scopeBar, /global workspace/);
  assert.match(scopeBar, /Configuring/);

  assert.match(client, /AutomationScopeBar/);
  assert.match(client, /handleOrgChange/);
  assert.match(client, /handleStoreChange/);
  assert.match(client, /apiReportType === "product_data_update"/);
  assert.match(client, /apiReportType === "removal_shipment"/);
  assert.match(client, /apiReportType === "reimbursements"/);
  assert.match(client, /apiReportType === "settlement"/);
  assert.match(client, /apiReportType === "finances_archive"/);
  assert.match(client, /apiReportType === "older_backfill"/);
  assert.match(client, /Product Data Update/);
  assert.doesNotMatch(client, /useUserRole/);
  assert.doesNotMatch(client, /Select a company and store to configure API automation/);

  assert.match(importsClient, /UniversalImporter/);
  assert.match(importsClient, /role === "super_admin"\s*\?\s*<ImportsApiAutomationNotice/);
  assert.doesNotMatch(importsClient, /ReportsApiReimbursementsPanel/);
}

function reportTypeChecks(): void {
  assert.equal(AUTOMATION_API_REPORT_TYPE_OPTIONS.length, 6);
  assert.equal(readAutomationApiReportType(), "product_data_update");
}

function main(): void {
  staticChecks();
  reportTypeChecks();
  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: "AUTOMATION-API-CENTER-UI-QA-AND-COMBO-REPORT-POLISH",
        checks: ["scope_bar", "report_type_combo", "no_global_workspace_hook", "imports_unchanged"],
        safe_to_continue: true,
      },
      null,
      2,
    ),
  );
}

main();
