/**
 * IMPORTS-FILE-ONLY-CUTOVER-PHASE1 — static checks
 *   npx tsx scripts/test-imports-file-only-cutover-phase1.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function staticChecks(): void {
  const importsClient = readFileSync(join(process.cwd(), "app/(admin)/imports/ImportsClient.tsx"), "utf8");
  const notice = readFileSync(join(process.cwd(), "app/(admin)/imports/ImportsApiAutomationNotice.tsx"), "utf8");
  const universal = readFileSync(join(process.cwd(), "app/(admin)/imports/UniversalImporter.tsx"), "utf8");
  const history = readFileSync(join(process.cwd(), "app/(admin)/imports/RawReportImportsPanel.tsx"), "utf8");
  const manualRun = readFileSync(join(process.cwd(), "lib/platform-automation-manual-run-ui.ts"), "utf8");

  assert.match(importsClient, /UniversalImporter/);
  assert.match(importsClient, /RawReportImportsPanel/);
  assert.match(importsClient, /role === "super_admin"\s*\?\s*<ImportsApiAutomationNotice/);

  assert.doesNotMatch(importsClient, /ReportsApiReimbursementsPanel/);
  assert.doesNotMatch(importsClient, /ReportsApiSettlementPanel/);
  assert.doesNotMatch(importsClient, /FinancesApiArchivePanel/);
  assert.doesNotMatch(importsClient, /reports-api\/run/);

  assert.match(notice, /Platform Settings → Automation/);
  assert.match(notice, /href="\/platform\/settings\/automation"/);

  assert.match(universal, /REPORT_TYPE_OPTIONS/);
  assert.match(universal, /UniversalImporter/);

  assert.match(history, /ImportHistoryFilter/);
  assert.match(history, /api/);

  assert.match(manualRun, /AUTOMATION_MANUAL_RUN_ROUTES/);
  assert.match(manualRun, /\/api\/settings\/imports\/reports-api\/run/);
}

function main(): void {
  staticChecks();
  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: "IMPORTS-FILE-ONLY-CUTOVER-PHASE1",
        checks: [
          "universal_importer_present",
          "api_panels_removed_from_imports",
          "automation_notice_super_admin_only",
          "import_history_unchanged",
          "manual_run_routes_present",
        ],
        safe_to_continue: true,
      },
      null,
      2,
    ),
  );
}

main();
