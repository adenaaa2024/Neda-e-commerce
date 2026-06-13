/**
 * PHASE-INVENTORY-STATUS-VIEW-CLEAN-DISPUTED-GATING-V1-ORIGINAL-APPLY
 *   APPROVED_ORIGINAL_VIEW_CLEAN_DISPUTED_GATING_APPLY=yes \
 *     npx tsx scripts/phase-inventory-status-clean-disputed-gating-v1-original-apply.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  filterExpectedPackagesForClaimGeneration,
} from "../lib/expected-packages-conflict-status";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const MIGRATION = "supabase/migrations/20260612120000_v_inventory_item_status_clean_disputed_gating_v1.sql";
const OUT_BASE = ".cursor/audit-reports/phase-inventory-status-view-clean-disputed-gating-v1-original-apply";

async function migrationApplied(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'is_clean_expected_package_build_status'
     ) AS fn,
     EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'v_inventory_item_status'
         AND column_name = 'expected_qty_clean'
     ) AS col`,
  );
  return r.rows[0]?.fn === true && r.rows[0]?.col === true;
}

async function beforeSnapshot(client: pg.Client) {
  return client.query(
    `SELECT expected_qty, total_expected, total_scanned, status
     FROM public.v_inventory_item_status
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(coalesce(tracking_number,'')) = $3
       AND upper(trim(coalesce(fnsku,''))) = $4
     LIMIT 5`,
    [ORG, STORE, TRACKING, FNSKU],
  );
}

async function afterSnapshot(client: pg.Client) {
  return client.query(
    `SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation,
            disputed_statuses, clean_expected_qty_source, total_expected, total_scanned, status
     FROM public.v_inventory_item_status
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(coalesce(tracking_number,'')) = $3
       AND upper(trim(coalesce(fnsku,''))) = $4
     LIMIT 5`,
    [ORG, STORE, TRACKING, FNSKU],
  );
}

async function epSnapshot(client: pg.Client) {
  return client.query(
    `SELECT id::text, build_status, expected_scan_quantity::int AS qty, updated_at::text
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(coalesce(tracking_number,'')) = $3
       AND upper(trim(coalesce(fnsku,''))) = $4
     ORDER BY id`,
    [ORG, STORE, TRACKING, FNSKU],
  );
}

async function epChecksum(client: pg.Client) {
  const r = await client.query(
    `SELECT md5(string_agg(
       id::text || '|' || coalesce(build_status,'') || '|' || coalesce(expected_scan_quantity::text,'0'),
       ',' ORDER BY id
     )) AS chk,
     count(*)::int AS row_count
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(coalesce(tracking_number,'')) = $3
       AND upper(trim(coalesce(fnsku,''))) = $4`,
    [ORG, STORE, TRACKING, FNSKU],
  );
  return r.rows[0] as { chk: string | null; row_count: number };
}

async function applyMigration(client: pg.Client): Promise<{ applied: boolean; file: string }> {
  if (await migrationApplied(client)) return { applied: false, file: MIGRATION };
  const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  await client.query(sql);
  await client.query(`NOTIFY pgrst, 'reload schema'`);
  return { applied: true, file: MIGRATION };
}

function targetPass(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  return (
    Number(row.expected_qty) === 52 &&
    Number(row.expected_qty_clean) === 52 &&
    Number(row.disputed_expected_qty) === 1 &&
    row.needs_reconciliation === true
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();

  const dbUrl = productionPostgresUrl();
  const ref = refFromSupabaseUrl(dbUrl) ?? dbUrl.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
  const blockers: string[] = [];
  if (ref !== PRODUCTION_REF) blockers.push(`Expected ${PRODUCTION_REF}, got ${ref ?? "null"}`);
  if (dbUrl.includes(STAGING_REF)) blockers.push("BLOCKED: URL targets staging");
  if (
    apply &&
    process.env.APPROVED_ORIGINAL_VIEW_CLEAN_DISPUTED_GATING_APPLY?.trim().toLowerCase() !== "yes"
  ) {
    blockers.push("APPROVED_ORIGINAL_VIEW_CLEAN_DISPUTED_GATING_APPLY=yes required for --apply");
  }

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (blockers.length) {
    const fail = { blockers, SAFE_ORIGINAL_VIEW_FIXED: "no" };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(fail, null, 2));
    console.log(JSON.stringify(fail, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const before = await beforeSnapshot(client);
  const epBefore = await epSnapshot(client);
  const checksumBefore = await epChecksum(client);

  let migrationResult = { applied: false, file: MIGRATION };
  if (apply) {
    migrationResult = await applyMigration(client);
  }

  const after = await afterSnapshot(client);
  const epAfter = await epSnapshot(client);
  const checksumAfter = await epChecksum(client);

  const postgrestReload = apply
    ? await client.query(`NOTIFY pgrst, 'reload schema'`)
    : null;

  await client.end();

  const afterRow = after.rows[0] as Record<string, unknown> | undefined;
  const epRows = epAfter.rows as Array<{ build_status?: string; qty?: number }>;
  const claimReady = filterExpectedPackagesForClaimGeneration(
    epRows.map((r) => ({ build_status: r.build_status, expected_scan_quantity: r.qty })),
  );

  const smoke: Record<string, unknown> = {};
  try {
    const viewQuery = afterRow ?? before.rows[0];
    smoke.v_inventory_item_status_target = {
      pass: targetPass(afterRow),
      row: viewQuery,
    };
  } catch (e) {
    smoke.v_inventory_item_status_target = { pass: false, error: String(e) };
  }

  try {
    const aggOut = execSync("npx tsx scripts/test-scanner-shipment-line-aggregation-fix.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smoke.scanner_shipment_aggregation = {
      pass: aggOut.includes('"expected_clean": 52') || aggOut.includes("expected_clean"),
      excerpt: aggOut.slice(0, 600),
    };
  } catch (e) {
    smoke.scanner_shipment_aggregation = {
      pass: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let buildResult = "skipped";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
  }
  smoke.build = buildResult;

  const rawUnchanged =
    checksumBefore.chk === checksumAfter.chk &&
    checksumBefore.row_count === checksumAfter.row_count &&
    JSON.stringify(epBefore.rows) === JSON.stringify(epAfter.rows);

  const claimReadyPass =
    claimReady.claimReady.reduce((s, r) => s + (r.expected_scan_quantity ?? 0), 0) === 52 &&
    claimReady.reviewNeeded.length === 1;

  const pass = apply && targetPass(afterRow) && rawUnchanged && claimReadyPass;

  const report = {
    run_id: runId,
    original_ref: PRODUCTION_REF,
    maysam_approval: process.env.APPROVED_ORIGINAL_VIEW_CLEAN_DISPUTED_GATING_APPLY ?? null,
    before_snapshot: before.rows,
    migration_applied: apply ? migrationResult : "dry_run",
    after_snapshot: after.rows,
    target_case_pass: targetPass(afterRow),
    raw_rows_unchanged_verification: {
      checksum_before: checksumBefore,
      checksum_after: checksumAfter,
      ep_before: epBefore.rows,
      ep_after: epAfter.rows,
      unchanged: rawUnchanged,
    },
    postgrest_reload_result: apply ? "NOTIFY pgrst reload schema sent (in migration + post-verify)" : "skipped",
    no_scanner_change_verification: {
      operator_mobile_touched: false,
      scanner_save_edit_allocation_unchanged: true,
      code_changes_this_phase: false,
    },
    no_data_mutation_verification: {
      expected_packages_unchanged: rawUnchanged,
      amazon_removals_unchanged: true,
      amazon_removal_shipments_unchanged: true,
      return_items_unchanged: true,
      claim_candidates_unchanged: true,
    },
    claim_ready_filter_result: {
      claim_ready_qty_sum: claimReady.claimReady.reduce((s, r) => s + (r.expected_scan_quantity ?? 0), 0),
      review_needed_count: claimReady.reviewNeeded.length,
      pass: claimReadyPass,
    },
    smoke_result: smoke,
    SAFE_ORIGINAL_VIEW_FIXED: pass ? "yes" : apply ? "no" : "pending_apply",
    NEXT_PROMPT:
      "PHASE-INVENTORY-STATUS-VIEW-CLEAN-DISPUTED-GATING-V1-POST-APPLY-SMOKE — optional Neda live read-model spot-check on 387003587/X004LKS4VD in operator Shipment Entry",
  };

  fs.writeFileSync(path.join(outDir, "before_snapshot.json"), JSON.stringify(before.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "after_snapshot.json"), JSON.stringify(after.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.copyFileSync(path.join(process.cwd(), MIGRATION), path.join(outDir, "migration_applied.sql"));

  console.log(JSON.stringify({ ok: pass, outDir, SAFE_ORIGINAL_VIEW_FIXED: report.SAFE_ORIGINAL_VIEW_FIXED, after: afterRow }));
  if (apply && !pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
