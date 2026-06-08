/**
 * PRODUCTION removal catch-up — resume stuck uploads, rolling sync, rebuild EP.
 *
 *   npx tsx scripts/production-removal-catchup-execute.ts
 *   APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true npx tsx scripts/production-removal-catchup-execute.ts --apply
 *
 * Options:
 *   --apply              Execute (default: dry-run census only)
 *   --skip-fetch         Resume stuck uploads + rebuild only
 *   --skip-stuck-resume  Fetch + rebuild only
 *   --rolling-days=7     Rolling window (default 7)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire, type Module } from "node:module";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  PRODUCTION_ORG_ID,
  PRODUCTION_STORE_ID,
  queryDomainMaxDates,
  queryStuckRemovalUploads,
  rebuildExpectedPackagesProduction,
  resumeUploadImportPipeline,
  runProductionRemovalSync,
  syncWindowThroughToday,
} from "../lib/production-removal-sync-run";
import { persistRemovalCronRuntime } from "../lib/removal-cron-runtime-storage";
import { loadProductionRemovalAutomationSettings } from "../lib/removal-cron-schedule-gate";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const DEFAULT_STUCK = [
  "69b73022-9374-4307-9803-e45213cf0aad",
  "f78ea692-a005-4379-99ea-76dcac94b894",
  "d1d648a3-4300-4924-b216-beb95791050a",
];

const OUT_BASE = ".cursor/audit-reports/production-removal-catchup";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function argInt(name: string, fallback: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return fallback;
  const n = Number.parseInt(a.split("=")[1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const skipFetch = process.argv.includes("--skip-fetch");
  const skipStuck = process.argv.includes("--skip-stuck-resume");
  const rollingDays = argInt("rolling-days", 7);
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '1800s'");

  const beforeDates = await queryDomainMaxDates(client, PRODUCTION_ORG_ID);
  const stuckBefore = await queryStuckRemovalUploads(client, PRODUCTION_ORG_ID);
  const { scope: removalScope, cron_runtime: cronBefore } = await loadProductionRemovalAutomationSettings();
  await client.end();

  const census = {
    dry_run: !apply,
    target_ref: PRODUCTION_REF,
    rolling_days: rollingDays,
    domain_max_dates_before: beforeDates,
    stuck_uploads_before: stuckBefore,
    cron_runtime_before: cronBefore,
    default_stuck_ids: DEFAULT_STUCK,
  };

  if (!apply) {
    fs.writeFileSync(path.join(outDir, "census.json"), JSON.stringify(census, null, 2));
    console.log(JSON.stringify(census, null, 2));
    console.log(
      "\nApply: APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true npx tsx scripts/production-removal-catchup-execute.ts --apply",
    );
    return;
  }

  if (process.env.APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC?.trim().toLowerCase() !== "true") {
    throw new Error("APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true required for --apply");
  }

  const resumeResults: Array<{ upload_id: string; ok: boolean; state: string; error?: string }> = [];

  if (!skipStuck) {
    const orderFirst = [...DEFAULT_STUCK].sort((a, b) => {
      const ta = stuckBefore.find((s) => s.id.startsWith(a.slice(0, 8)))?.report_type ?? "";
      const tb = stuckBefore.find((s) => s.id.startsWith(b.slice(0, 8)))?.report_type ?? "";
      if (ta === "REMOVAL_ORDER" && tb !== "REMOVAL_ORDER") return -1;
      if (tb === "REMOVAL_ORDER" && ta !== "REMOVAL_ORDER") return 1;
      return 0;
    });
    for (const uploadId of orderFirst) {
      const res = await resumeUploadImportPipeline(uploadId);
      resumeResults.push({ upload_id: uploadId, ...res });
      if (!res.ok) {
        console.error(`Stuck resume failed for ${uploadId}: ${res.error ?? res.state}`);
      }
    }
  }

  let syncResult: Awaited<ReturnType<typeof runProductionRemovalSync>> | null = null;
  if (!skipFetch) {
    syncResult = await runProductionRemovalSync({
      window: syncWindowThroughToday(rollingDays),
      skipFetch: false,
      rebuildExpectedPackages: false,
    });
  }

  const client2 = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client2.connect();
  await client2.query("SET statement_timeout = '1800s'");
  const rebuild = await rebuildExpectedPackagesProduction(client2);
  const afterDates = await queryDomainMaxDates(client2, PRODUCTION_ORG_ID);
  const stuckAfter = await queryStuckRemovalUploads(client2, PRODUCTION_ORG_ID);
  await client2.end();

  const cronAfter = await persistRemovalCronRuntime(
    PRODUCTION_ORG_ID,
    PRODUCTION_STORE_ID,
    { last_run_status: "success", last_success_at: new Date().toISOString(), last_run_at: new Date().toISOString() },
    removalScope,
  );

  const today = afterDates.today_utc;
  const warehouseReady =
    stuckAfter.length === 0 &&
    afterDates.max_removal_order_date === today &&
    afterDates.max_shipment_domain_date === today &&
    afterDates.max_ep_source_date === today &&
    rebuild.rebuild_valid;

  const result = {
    removal_catchup_applied: true,
    resume_results: resumeResults,
    rolling_sync: syncResult
      ? {
          errors: syncResult.errors,
          order_fetch: syncResult.order_fetch,
          shipment_fetch: syncResult.shipment_fetch,
          order_pipeline: syncResult.order_pipeline,
          shipment_pipeline: syncResult.shipment_pipeline,
        }
      : null,
    domain_max_dates: afterDates,
    domain_max_dates_before: beforeDates,
    expected_packages_rebuilt: rebuild.rebuild,
    rebuild_valid: rebuild.rebuild_valid,
    stuck_uploads_after: stuckAfter,
    cron_runtime_status: cronAfter,
    SAFE_FOR_WAREHOUSE_SCAN_TODAY: warehouseReady ? "yes" : "no",
    errors: [
      ...resumeResults.filter((r) => !r.ok).map((r) => `resume:${r.upload_id}:${r.error ?? r.state}`),
      ...(syncResult?.errors ?? []),
      ...(rebuild.rebuild_valid ? [] : ["rebuild_verify_failed"]),
      ...(stuckAfter.length ? [`stuck_remaining:${stuckAfter.length}`] : []),
    ],
  };

  fs.writeFileSync(path.join(outDir, "catchup_result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
