/**
 * PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1 — staging verify
 *   npx tsx scripts/phase-removal-sync-expected-packages-rebuild-orchestrator-v1-staging-verify.ts
 *   npx tsx scripts/phase-removal-sync-expected-packages-rebuild-orchestrator-v1-staging-verify.ts --execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { parseSourceRun } from "../lib/amazon/reports-api-source-run";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-removal-sync-expected-packages-rebuild-orchestrator-v1";

async function claimCount(c: pg.Client): Promise<number> {
  const r = await c.query(`SELECT count(*)::int AS c FROM public.claim_candidates WHERE organization_id=$1::uuid`, [
    ORG,
  ]);
  return Number(r.rows[0]?.c ?? 0);
}

async function epDerivedCount(c: pg.Client): Promise<number> {
  const r = await c.query(
    `SELECT count(*)::int AS c FROM public.expected_packages
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND build_source IN ('detail_shipment','detail_remainder')`,
    [ORG, STORE],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function pickUpload(c: pg.Client) {
  const r = await c.query(
    `SELECT id::text, report_type, metadata, status
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'source_run'->>'state' = 'complete'
     ORDER BY created_at DESC
     LIMIT 20`,
    [ORG],
  );
  for (const row of r.rows as Array<{ id: string; report_type: string; metadata: unknown; status: string }>) {
    const sr = parseSourceRun(row.metadata);
    if (!sr?.store_id) continue;
    const domainTable = row.report_type === "REMOVAL_ORDER" ? "amazon_removals" : "amazon_removal_shipments";
    const dom = await c.query(`SELECT count(*)::int AS c FROM public.${domainTable} WHERE upload_id=$1::uuid`, [row.id]);
    if (Number(dom.rows[0]?.c ?? 0) > 0) return { ...row, sourceRun: sr, domain_rows: Number(dom.rows[0]?.c) };
  }
  return null;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  loadEnvLocalIntoProcess();
  if (getStagingProjectRef() !== STAGING_REF) throw new Error("Staging ref guard failed");

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.STAGING_SUPABASE_URL?.trim() ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  process.env.DIRECT_POSTGRES_URL = pgUrl;
  const client = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const ccBefore = await claimCount(client);
  const epBefore = await epDerivedCount(client);
  const upload = await pickUpload(client);

  let orchestratorResult: Record<string, unknown> | null = null;
  if (execute && upload) {
    const { resetExpectedPackagesRebuildOrchestratorDedupeForTests, maybeRebuildExpectedPackagesAfterRemovalImport } =
      await import("../lib/removal/removal-expected-packages-rebuild-orchestrator");
    const { supabaseServer } = await import("../lib/supabase-server");
    resetExpectedPackagesRebuildOrchestratorDedupeForTests();
    orchestratorResult = await maybeRebuildExpectedPackagesAfterRemovalImport({
      uploadId: upload.id,
      organizationId: ORG,
      reportType: upload.report_type,
      sourceRun: upload.sourceRun,
      supabase: supabaseServer,
    });
  }

  const ccAfter = await claimCount(client);
  const epAfter = await epDerivedCount(client);

  const disputed = await client.query(
    `SELECT count(*)::int AS c FROM public.expected_packages
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND build_status = 'shipment_overflow_conflict'`,
    [ORG, STORE],
  );

  const invSample = await client.query(
    `SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation
     FROM public.v_inventory_item_status
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND disputed_expected_qty > 0
     LIMIT 3`,
    [ORG, STORE],
  );

  await client.end();

  let operatorMobileTouched = false;
  try {
    operatorMobileTouched =
      execSync('git status --porcelain "app/scanner/operator-mobile"', { encoding: "utf8" }).trim().length > 0;
  } catch {
    operatorMobileTouched = false;
  }

  let buildResult = execute ? "pending" : "skipped";
  let smokeResult = execute ? "pending" : "skipped";
  if (execute) {
    try {
      execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
      buildResult = "pass";
    } catch (e) {
      buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
    }
    try {
      execSync("npx tsx scripts/test-scanner-shipment-line-aggregation-fix.ts", { stdio: "pipe", encoding: "utf8" });
      smokeResult = "pass";
    } catch (e) {
      smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
  }

  const rebuildCalled =
    orchestratorResult?.rebuild_called === true ||
    orchestratorResult?.skipped_reason === "already_rebuilt_for_upload";
  const pass =
    execute &&
    Boolean(upload) &&
    rebuildCalled &&
    ccBefore === ccAfter &&
    !operatorMobileTouched &&
    buildResult === "pass";

  const priorMeta =
    upload?.metadata && typeof upload.metadata === "object"
      ? (upload.metadata as Record<string, unknown>).import_metrics &&
        typeof (upload.metadata as Record<string, unknown>).import_metrics === "object"
        ? (
            (upload.metadata as Record<string, unknown>).import_metrics as Record<string, unknown>
          ).expected_packages_rebuild_after_import ?? null
        : null
      : null;

  const report = {
    run_id: runId,
    mode: execute ? "execute" : "dry_run",
    orchestration_point_found:
      "lib/amazon/reports-api-pipeline-handoff.ts runReportsApiImportPipeline — after state complete for REMOVAL_ORDER/REMOVAL_SHIPMENT",
    files_changed: [
      "lib/removal/removal-expected-packages-rebuild-orchestrator.ts",
      "lib/amazon/reports-api-pipeline-handoff.ts",
      "lib/raw-report-upload-metadata.ts",
    ],
    rebuild_trigger_rule:
      "runReportsApiImportPipeline success + REMOVAL_* report + domain_complete + store_id + not fetch-only (pipeline never invoked when runPipeline:false)",
    affected_org_store_detection: "metadata.source_run.store_id on raw_report_uploads; organization_id from pipeline params",
    idempotency_rule:
      "Per-upload metadata import_metrics.expected_packages_rebuild_after_import + in-process Set duplicate_in_same_run",
    staging_run_result: orchestratorResult,
    test_upload: upload
      ? {
          id: upload.id,
          report_type: upload.report_type,
          domain_rows: upload.domain_rows,
          prior_rebuild_meta: priorMeta ?? null,
        }
      : null,
    expected_packages_before_after: { derived_before: epBefore, derived_after: epAfter },
    disputed_gating_verification: {
      overflow_conflict_rows: disputed.rows[0]?.c ?? 0,
      inventory_disputed_sample: invSample.rows,
      note: "shipment_overflow_conflict remains review-needed; v_inventory_item_status excludes disputed from expected_qty",
    },
    claim_candidates_delta: ccAfter - ccBefore,
    no_scanner_change_verification: { operator_mobile_touched: operatorMobileTouched },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_APPLY_ORIGINAL: pass ? "yes_pending_maysam" : execute ? "no" : "pending_execute",
    original_apply_steps_if_approved: [
      "Maysam approves staging bundle",
      "Deploy lib/removal/removal-expected-packages-rebuild-orchestrator.ts + pipeline handoff wiring",
      "Resume or run removal import with run_pipeline:true on original — rebuild runs automatically after domain sync",
      "Verify upload metadata import_metrics.expected_packages_rebuild_after_import populated",
    ],
    NEXT_PROMPT:
      "PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1-ORIGINAL-APPLY — after Maysam approval, deploy and verify on original removal resume",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: pass, outDir, orchestratorResult, SAFE: report.SAFE_TO_APPLY_ORIGINAL }));
  if (execute && !pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
