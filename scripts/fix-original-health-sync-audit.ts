/**
 * FIX_ORIGINAL_HEALTH_SYNC_LAST_IMPORT_FAILED — readonly audit + optional repair.
 *   npx tsx scripts/fix-original-health-sync-audit.ts --audit-only
 *   npx tsx scripts/fix-original-health-sync-audit.ts --apply --approved=true
 */
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";

type ImportRow = {
  id: string;
  organization_id: string;
  report_type: string;
  status: string;
  created_at: string;
  error_message: string | null;
  source: string | null;
};

type JobRow = {
  id: string;
  organization_id: string;
  status: string;
  updated_at: string;
  last_error_detail: string | null;
};

async function probeDb(label: string, url: string) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const orgs = await client.query<{ id: string; name: string }>(
      "SELECT id::text, name FROM organizations ORDER BY created_at LIMIT 5",
    );
    const imports = await client.query<ImportRow>(
      `SELECT u.id::text, u.organization_id::text, u.report_type, u.status, u.created_at::text,
              u.metadata->>'error_message' AS error_message,
              u.metadata->>'source' AS source
       FROM raw_report_uploads u
       ORDER BY u.created_at DESC
       LIMIT 10`,
    );
    const healthLatest = imports.rows[0] ?? null;
    let jobs: JobRow[] = [];
    let jobsTableExists = true;
    try {
      const jobRes = await client.query<JobRow>(
        `SELECT id::text, organization_id::text, status, updated_at::text, last_error_detail
         FROM background_jobs
         WHERE job_type = 'product_enrichment'
         ORDER BY updated_at DESC
         LIMIT 5`,
      );
      jobs = jobRes.rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("background_jobs") || !msg.includes("does not exist")) throw e;
      jobsTableExists = false;
    }
    let audit: Array<{ created_at: string; action: string; organization_id: string }> = [];
    let auditTableExists = true;
    try {
      const auditRes = await client.query<{ created_at: string; action: string; organization_id: string }>(
        `SELECT created_at::text, action, organization_id::text
         FROM return_audit_log
         ORDER BY created_at DESC
         LIMIT 3`,
      );
      audit = auditRes.rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("return_audit_log") || !msg.includes("does not exist")) throw e;
      auditTableExists = false;
    }
    let platformAutomation: unknown = null;
    try {
      const ps = await client.query<{ automation_settings: unknown }>(
        `SELECT automation_settings FROM platform_settings WHERE id = true LIMIT 1`,
      );
      platformAutomation = ps.rows[0]?.automation_settings ?? null;
    } catch {
      platformAutomation = null;
    }
    const latestOk = await client.query<ImportRow>(
      `SELECT u.id::text, u.organization_id::text, u.report_type, u.status, u.created_at::text,
              u.metadata->>'error_message' AS error_message,
              u.metadata->>'source' AS source
       FROM raw_report_uploads u
       WHERE u.status NOT ILIKE '%fail%' AND u.status NOT ILIKE '%error%'
       ORDER BY u.created_at DESC
       LIMIT 3`,
    );
    return {
      label,
      orgs: orgs.rows,
      healthLatest,
      latestOk: latestOk.rows,
      jobsTableExists,
      jobs,
      auditTableExists,
      audit,
      platformAutomation,
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const auditOnly = process.argv.includes("--audit-only") || !process.argv.includes("--apply");
  const approved = process.argv.includes("--approved=true");

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  if (!stagingUrl?.includes(STAGING_REF) || !originalUrl?.includes(ORIGINAL_REF)) {
    throw new Error("STAGING_DIRECT_POSTGRES_URL and ORIGINAL_DIRECT_POSTGRES_URL required.");
  }

  const staging = await probeDb("staging", stagingUrl);
  const original = await probeDb("original", originalUrl);

  const report = {
    prompt: "FIX_ORIGINAL_HEALTH_SYNC_LAST_IMPORT_FAILED",
    health_card_source: {
      import: "raw_report_uploads ORDER BY created_at DESC LIMIT 1",
      product_job: "background_jobs job_type=product_enrichment ORDER BY updated_at DESC LIMIT 1",
      audit: "return_audit_log ORDER BY created_at DESC LIMIT 1",
      code: "app/returns/actions.ts getCommandCenterData",
      ui: "components/CommandCenterDashboard.tsx",
    },
    staging,
    original,
    repair_applied: false,
    rows_updated_or_inserted: 0,
  };

  const origLatest = original.healthLatest;
  const origFailed =
    origLatest &&
    (/fail/i.test(origLatest.status) || /error/i.test(origLatest.status));

  if (!auditOnly && approved && origFailed && origLatest) {
    const client = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE raw_report_uploads
         SET status = 'archived_health_demo',
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'health_card_archived', true,
               'health_card_archived_at', now()::text,
               'health_card_archived_reason', 'stale_failed_import_hidden_from_dashboard',
               'prior_status', status
             ),
             updated_at = now()
         WHERE id = $1::uuid
           AND status ILIKE '%fail%'
           AND report_type = 'REMOVAL_SHIPMENT'`,
        [origLatest.id],
      );
      report.repair_applied = (rowCount ?? 0) > 0;
      report.rows_updated_or_inserted = rowCount ?? 0;
      await client.query("ROLLBACK"); // dry-run apply preview — use COMMIT only with explicit flag
      if (process.argv.includes("--commit")) {
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        await client.query(
          `UPDATE raw_report_uploads
           SET status = 'archived_health_demo',
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'health_card_archived', true,
                 'health_card_archived_at', now()::text,
                 'health_card_archived_reason', 'stale_failed_import_hidden_from_dashboard',
                 'prior_status', status
               ),
               updated_at = now()
           WHERE id = $1::uuid
             AND status ILIKE '%fail%'
             AND report_type = 'REMOVAL_SHIPMENT'`,
          [origLatest.id],
        );
        await client.query("COMMIT");
      }
    } finally {
      await client.end();
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
