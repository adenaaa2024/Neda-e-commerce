/**
 * IMPORTS-FILE-ONLY-CUSTOMER-UX-CLEANUP — static checks
 *   npx tsx scripts/test-imports-file-only-customer-ux-cleanup.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function staticChecks(): void {
  const importsClient = readFileSync(join(process.cwd(), "app/(admin)/imports/ImportsClient.tsx"), "utf8");
  const universal = readFileSync(join(process.cwd(), "app/(admin)/imports/UniversalImporter.tsx"), "utf8");
  const history = readFileSync(join(process.cwd(), "app/(admin)/imports/RawReportImportsPanel.tsx"), "utf8");

  assert.match(importsClient, /UniversalImporter/);
  assert.match(importsClient, /RawReportImportsPanel/);

  assert.match(importsClient, /role === "super_admin"\s*\?\s*<ImportsApiAutomationNotice/);
  assert.doesNotMatch(importsClient, /Platform Settings → Automation/);
  assert.doesNotMatch(importsClient, /\/platform\/settings\/automation/);

  assert.match(universal, /UniversalImporter/);
  assert.match(history, /RawReportImportsPanel/);
  assert.match(history, /ImportHistoryFilter/);
}

function main(): void {
  staticChecks();
  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: "IMPORTS-FILE-ONLY-CUSTOMER-UX-CLEANUP",
        checks: [
          "no_customer_automation_notice",
          "super_admin_only_notice_gate",
          "universal_importer_present",
          "import_history_present",
        ],
        safe_to_continue: true,
      },
      null,
      2,
    ),
  );
}

main();
