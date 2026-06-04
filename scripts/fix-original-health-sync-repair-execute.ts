/**
 * FIX_ORIGINAL_HEALTH_SYNC — copy demo-safe platform automation config staging → original.
 * Does NOT run imports, Amazon API, or sync jobs.
 *
 *   npx tsx scripts/fix-original-health-sync-repair-execute.ts --dry-run
 *   npx tsx scripts/fix-original-health-sync-repair-execute.ts --apply --approved=true
 */
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { pickHealthImportRow } from "../lib/command-center-health";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";

async function columnExists(client: pg.Client, table: string, column: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const dryRun = !process.argv.includes("--apply") || !process.argv.includes("--approved=true");
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  if (!stagingUrl?.includes(STAGING_REF) || !originalUrl?.includes(ORIGINAL_REF)) {
    throw new Error("STAGING_DIRECT_POSTGRES_URL and ORIGINAL_DIRECT_POSTGRES_URL required.");
  }

  const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  await staging.connect();
  await original.connect();

  const beforeImports = await original.query(
    `SELECT created_at::text, report_type, status
     FROM raw_report_uploads
     ORDER BY created_at DESC
     LIMIT 25`,
  );
  const beforePick = pickHealthImportRow(beforeImports.rows);
  const beforeFailedLatest = beforeImports.rows[0] as { status?: string; report_type?: string } | undefined;

  let automationCopied = false;
  let automationBefore: unknown = null;
  let automationAfter: unknown = null;

  const hasAutomationCol = await columnExists(original, "platform_settings", "automation_settings");
  if (hasAutomationCol) {
    const origPs = await original.query(`SELECT automation_settings FROM platform_settings WHERE id = true`);
    automationBefore = origPs.rows[0]?.automation_settings ?? null;
    const stagingPs = await staging.query(`SELECT automation_settings FROM platform_settings WHERE id = true`);
    const stagingAutomation = stagingPs.rows[0]?.automation_settings ?? null;
    const shouldCopy =
      stagingAutomation != null &&
      (automationBefore == null ||
        (typeof automationBefore === "object" &&
          Object.keys(automationBefore as object).length === 0));

    if (shouldCopy && !dryRun) {
      await original.query(
        `UPDATE platform_settings
         SET automation_settings = $1::jsonb
         WHERE id = true
           AND (automation_settings IS NULL OR automation_settings = '{}'::jsonb)`,
        [JSON.stringify(stagingAutomation)],
      );
      automationCopied = true;
    } else if (shouldCopy && dryRun) {
      automationCopied = true;
    }
    const afterPs = await original.query(`SELECT automation_settings FROM platform_settings WHERE id = true`);
    automationAfter = afterPs.rows[0]?.automation_settings ?? automationBefore;
  }

  const afterImports = await original.query(
    `SELECT created_at::text, report_type, status
     FROM raw_report_uploads
     ORDER BY created_at DESC
     LIMIT 25`,
  );
  const afterPick = pickHealthImportRow(afterImports.rows);

  await staging.end();
  await original.end();

  console.log(
    JSON.stringify(
      {
        ok: true,
        dry_run: dryRun,
        repair_applied: !dryRun && automationCopied,
        rows_updated_or_inserted: !dryRun && automationCopied ? 1 : 0,
        root_cause: ["A", "B", "D"],
        original_values_before: {
          latest_import_any: beforeFailedLatest,
          health_card_import_pick: beforePick,
          automation_settings: automationBefore,
          background_jobs_table: false,
        },
        original_values_after: {
          health_card_import_pick: afterPick,
          automation_settings: automationAfter,
        },
        code_fix: "pickHealthImportRow + resolveProductJobHealthFallback in getCommandCenterData",
        safe_to_refresh_original_dashboard: afterPick && !/fail|error/i.test(String(afterPick.status ?? "")),
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
