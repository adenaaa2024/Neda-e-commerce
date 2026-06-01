/**
 * AUTOMATION-API-CENTER-FINAL-UX-COMBO-CLEANUP — static checks
 *   npx tsx scripts/test-automation-api-center-final-ux-combo-cleanup.ts
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

  assert.match(scopeBar, /Automation type/);
  assert.doesNotMatch(scopeBar, /API report type/);
  assert.match(scopeBar, /aria-label="Automation company"/);
  assert.match(scopeBar, /aria-label="Automation store"/);
  assert.match(scopeBar, /aria-label="Automation type"/);
  assert.doesNotMatch(scopeBar, /Server flags:/);

  const automationTypes = [
    "product_data_update",
    "removal_shipment",
    "reimbursements",
    "settlement",
    "finances_archive",
    "older_backfill",
  ] as const;
  for (const type of automationTypes) {
    assert.match(client, new RegExp(`apiReportType === "${type}"`));
  }

  assert.match(client, /apiReportType === "product_data_update"\s*\?\s*\([\s\S]*Product Data Update/);
  assert.match(client, /apiReportType === "reimbursements"\s*\?\s*\([\s\S]*Reimbursements API/);

  const productSectionIdx = client.indexOf('apiReportType === "product_data_update"');
  const unconditionalProductIdx = client.indexOf("{/* Card 1 — Product Data Update */}");
  assert.equal(unconditionalProductIdx, -1, "Product card must not be fixed outside combo");
  assert.ok(productSectionIdx >= 0, "Product card must be combo-gated");

  assert.match(client, /Save for this company \/ store/);
  assert.doesNotMatch(client, /flags={flags}/);
}

function reportTypeChecks(): void {
  assert.equal(AUTOMATION_API_REPORT_TYPE_OPTIONS.length, 6);
  assert.equal(AUTOMATION_API_REPORT_TYPE_OPTIONS[0]?.value, "product_data_update");
  assert.equal(AUTOMATION_API_REPORT_TYPE_OPTIONS[0]?.label, "Product Data Update");
  assert.equal(readAutomationApiReportType(), "product_data_update");
}

function main(): void {
  staticChecks();
  reportTypeChecks();
  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: "AUTOMATION-API-CENTER-FINAL-UX-COMBO-CLEANUP",
        checks: [
          "automation_type_combo",
          "single_card_at_a_time",
          "product_data_update_in_combo",
          "company_store_always_visible",
          "no_global_flag_banner_in_scope_bar",
          "no_fixed_product_card",
        ],
        safe_to_continue: true,
      },
      null,
      2,
    ),
  );
}

main();
