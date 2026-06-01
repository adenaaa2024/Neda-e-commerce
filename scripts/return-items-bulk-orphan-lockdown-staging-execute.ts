/**
 * RETURN-ITEMS-BULK-ORPHAN-LOCKDOWN-JOBS-AND-GUARDS
 * Cancel mutation jobs + apply/verify synthetic INSERT guard on staging.
 *
 *   npx tsx scripts/return-items-bulk-orphan-lockdown-staging-execute.ts --run-id=<UTC>
 *   npx tsx scripts/return-items-bulk-orphan-lockdown-staging-execute.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/return-items-bulk-orphan-lockdown-staging";
const MIGRATION_FILE = "20260601143000_return_items_block_synthetic_bulk_orphan_insert.sql";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(f: string): boolean {
  return process.argv.includes(f);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const beforeJobs = await client.query(`
    SELECT id::text, job_type, status, created_at::text
    FROM background_jobs
    WHERE status IN ('running', 'queued')
    ORDER BY created_at
  `);

  let jobsCancelled = 0;
  if (apply && beforeJobs.rows.length > 0) {
    const cancelRes = await client.query(`
      UPDATE background_jobs
      SET status = 'cancelled',
          cancel_requested_at = COALESCE(cancel_requested_at, now()),
          finished_at = COALESCE(finished_at, now()),
          lock_expires_at = NULL,
          locked_at = NULL,
          locked_by = NULL
      WHERE status IN ('running', 'queued')
      RETURNING id
    `);
    jobsCancelled = cancelRes.rowCount ?? 0;
  }

  const afterJobs = await client.query(`
    SELECT status, count(*)::int AS n FROM background_jobs GROUP BY 1 ORDER BY 1
  `);

  const migPath = path.join(process.cwd(), "supabase/migrations", MIGRATION_FILE);
  const migSql = fs.readFileSync(migPath, "utf8");

  let migrationApplied = false;
  const trigBefore = await client.query(`
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'return_items' AND t.tgname = 'trg_return_items_block_synthetic_bulk_orphan_insert'
  `);

  if (apply && trigBefore.rows.length === 0) {
    await client.query(migSql);
    migrationApplied = true;
  }

  const trigAfter = await client.query(`
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'return_items' AND t.tgname = 'trg_return_items_block_synthetic_bulk_orphan_insert'
  `);

  const bulkOrphan = await client.query(`
    SELECT count(*)::int AS n FROM return_items
    WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL
      AND package_id IS NULL AND pallet_id IS NULL
  `);

  const stillRunning = await client.query(`
    SELECT count(*)::int AS n FROM background_jobs WHERE status IN ('running', 'queued')
  `);

  await client.end();

  const report = {
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "apply" : "dry_run",
    jobs_before: beforeJobs.rows,
    jobs_cancelled: apply ? jobsCancelled : 0,
    jobs_after_status: afterJobs.rows,
    migration_file: MIGRATION_FILE,
    migration_applied_this_run: migrationApplied,
    trigger_present: trigAfter.rows.length > 0,
    active_bulk_orphan_count: (bulkOrphan.rows[0] as { n: number }).n,
    active_running_or_queued_jobs: (stillRunning.rows[0] as { n: number }).n,
    guard_added_or_existing: trigAfter.rows.length > 0 ? "yes" : "pending_apply",
    safe_to_cleanup:
      apply && trigAfter.rows.length > 0 && (stillRunning.rows[0] as { n: number }).n === 0,
  };

  fs.writeFileSync(path.join(outDir, "lockdown-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# RETURN-ITEMS-BULK-ORPHAN-LOCKDOWN",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Mode | **${report.mode}** |`,
      `| Jobs cancelled | **${report.jobs_cancelled}** (before: ${beforeJobs.rows.length}) |`,
      `| DB trigger | **${report.trigger_present ? "present" : "missing"}** |`,
      `| Active bulk orphan | **${report.active_bulk_orphan_count}** (unchanged — no cleanup) |`,
      `| SAFE_TO_CLEANUP | **${report.safe_to_cleanup ? "yes" : "no — run with --apply or verify trigger"}** |`,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
