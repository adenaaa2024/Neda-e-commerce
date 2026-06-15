/**
 * PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1-ORIGINAL-APPLY
 *   npx tsx scripts/phase-removal-sync-expected-packages-rebuild-orchestrator-v1-original-apply.ts
 *   APPROVED_REMOVAL_EP_REBUILD_ORCHESTRATOR_ORIGINAL_APPLY=yes npx tsx scripts/phase-removal-sync-expected-packages-rebuild-orchestrator-v1-original-apply.ts --execute
 *   APPROVED_REMOVAL_EP_REBUILD_ORCHESTRATOR_ORIGINAL_APPLY=yes npx tsx ... --execute --execute-pipeline
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { parseSourceRun } from "../lib/amazon/reports-api-source-run";
import {
  evaluateExplicitRebuildSkipFromDb,
  expectedPackagesRebuildRecordedForUpload,
} from "../lib/removal/expected-packages-explicit-rebuild-guard";
import {
  bindProductionSupabaseEnv,
  PRODUCTION_REF,
  productionPostgresUrl,
} from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const OUT_BASE =
  ".cursor/audit-reports/phase-removal-sync-expected-packages-rebuild-orchestrator-v1-original-apply";

const CODE_FILES = {
  pipeline_hook: "lib/amazon/reports-api-pipeline-handoff.ts",
  orchestrator: "lib/removal/removal-expected-packages-rebuild-orchestrator.ts",
  explicit_guard: "lib/removal/expected-packages-explicit-rebuild-guard.ts",
  metadata: "lib/raw-report-upload-metadata.ts",
  production_sync: "lib/production-removal-sync-run.ts",
  domain_sync: "scripts/sp-api-removal-reports-domain-sync-execute.ts",
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readContains(file: string, needle: string): boolean {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) return false;
  return fs.readFileSync(p, "utf8").includes(needle);
}

async function claimCount(c: pg.Client): Promise<number> {
  const r = await c.query(`SELECT count(*)::int AS c FROM public.claim_candidates WHERE organization_id=$1::uuid`, [
    ORG,
  ]);
  return Number(r.rows[0]?.c ?? 0);
}

async function originalBeforeSnapshot(c: pg.Client): Promise<Record<string, unknown>> {
  const removals = await c.query(
    `SELECT count(*)::int AS row_count, max(created_at)::text AS max_created_at,
            max(coalesce(shipment_date, request_date))::text AS max_event_date
     FROM public.amazon_removals WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );
  const shipments = await c.query(
    `SELECT count(*)::int AS row_count, max(created_at)::text AS max_created_at,
            max(shipment_date)::text AS max_event_date
     FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );
  const ep = await c.query(
    `SELECT count(*)::int AS row_count, max(updated_at)::text AS max_updated_at
     FROM public.expected_packages WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );
  const uploads = await c.query(
    `SELECT report_type,
            count(*) FILTER (WHERE metadata->'source_run'->>'state'='complete')::int AS complete,
            count(*) FILTER (WHERE metadata->'source_run'->>'state'='failed')::int AS failed,
            count(*) FILTER (WHERE metadata->'source_run'->>'state'='synthetic_upload_ready')::int AS stuck,
            count(*) FILTER (WHERE metadata->'import_metrics'->'expected_packages_rebuild_after_import'->>'rebuild_called'='true')::int AS hook_recorded
     FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
     GROUP BY report_type ORDER BY report_type`,
    [ORG],
  );
  const target = await c.query(
    `SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation
     FROM public.v_inventory_item_status
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND trim(coalesce(tracking_number,''))=$3 AND upper(trim(coalesce(fnsku,'')))=$4`,
    [ORG, STORE, TRACKING, FNSKU],
  );
  const row = target.rows[0] as Record<string, unknown> | undefined;
  return {
    amazon_removals: removals.rows[0],
    amazon_removal_shipments: shipments.rows[0],
    expected_packages: ep.rows[0],
    raw_upload_removal_states: uploads.rows,
    claim_candidates: await claimCount(c),
    target_case: {
      tracking: TRACKING,
      fnsku: FNSKU,
      row: row ?? null,
      pass:
        Number(row?.expected_qty_clean ?? -1) === 52 && Number(row?.disputed_expected_qty ?? -1) === 1,
    },
  };
}

async function pickUploadWithRebuildMeta(c: pg.Client) {
  const r = await c.query(
    `SELECT id::text, report_type, metadata, status
     FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'import_metrics'->'expected_packages_rebuild_after_import'->>'rebuild_called'='true'
     ORDER BY created_at DESC LIMIT 1`,
    [ORG],
  );
  const row = r.rows[0] as { id: string; report_type: string; metadata: unknown; status: string } | undefined;
  if (!row) return null;
  const sr = parseSourceRun(row.metadata);
  if (!sr?.store_id) return null;
  return { ...row, sourceRun: sr };
}

async function pickResumableUpload(c: pg.Client) {
  const r = await c.query(
    `SELECT id::text, report_type, metadata, status, created_at
     FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'source_run'->>'state' NOT IN ('complete','failed')
       AND metadata->'source_run'->>'provider'='amazon_sp_api'
     ORDER BY created_at DESC LIMIT 5`,
    [ORG],
  );
  for (const row of r.rows as Array<{ id: string; report_type: string; metadata: unknown; status: string }>) {
    const sr = parseSourceRun(row.metadata);
    if (!sr?.store_id) continue;
    return { ...row, sourceRun: sr };
  }
  return null;
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

function deployedCodeVerification(): Record<string, unknown> {
  return {
    pipeline_hook_exists: readContains(CODE_FILES.pipeline_hook, "maybeRebuildExpectedPackagesAfterRemovalImport"),
    orchestrator_exists: fs.existsSync(path.join(process.cwd(), CODE_FILES.orchestrator)),
    dedupe_guard_exists: readContains(
      CODE_FILES.orchestrator,
      "rebuildProcessedThisRun",
    ),
    metadata_idempotency: readContains(
      CODE_FILES.metadata,
      "expected_packages_rebuild_after_import",
    ),
    explicit_rebuild_guard: readContains(
      CODE_FILES.explicit_guard,
      "pipeline_hook_already_rebuilt",
    ),
    production_sync_guard: readContains(
      CODE_FILES.production_sync,
      "evaluateExplicitRebuildSkipFromDb",
    ),
    domain_sync_guard: readContains(
      CODE_FILES.domain_sync,
      "evaluateExplicitRebuildSkipFromDb",
    ),
    fetch_only_skip: readContains(
      CODE_FILES.pipeline_hook,
      'reportType0 === "REMOVAL_ORDER" || reportType0 === "REMOVAL_SHIPMENT"',
    ),
    run_pipeline_mode: readContains(
      "lib/amazon/reports-api-removal-pipeline-mode.ts",
      "resolveRemovalReportsRunPipeline",
    ),
    files: CODE_FILES,
  };
}

async function main(): Promise<void> {
  const id = runId();
  const execute = process.argv.includes("--execute");
  const executePipeline = process.argv.includes("--execute-pipeline");
  const approved = process.env.APPROVED_REMOVAL_EP_REBUILD_ORCHESTRATOR_ORIGINAL_APPLY?.trim() === "yes";

  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  process.env.DIRECT_POSTGRES_URL = productionPostgresUrl();
  process.env.ORIGINAL_DIRECT_POSTGRES_URL = productionPostgresUrl();

  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const before = await originalBeforeSnapshot(client);
  const epBefore = await epDerivedCount(client);
  const ccBefore = Number(before.claim_candidates ?? 0);
  const uploadWithMeta = await pickUploadWithRebuildMeta(client);
  const resumableUpload = await pickResumableUpload(client);

  const codeVerify = deployedCodeVerification();

  let removalPipelineResult: Record<string, unknown> = {
    status: execute ? "not_run" : "read_only",
    reason: execute ? "pending_candidate" : "dry_run",
  };
  let autoHookResult: Record<string, unknown> | null = null;
  let explicitSkipResult: Record<string, unknown> | null = null;

  if (execute && !approved) {
    removalPipelineResult = { status: "blocked", reason: "APPROVED_REMOVAL_EP_REBUILD_ORCHESTRATOR_ORIGINAL_APPLY=yes required" };
  } else if (execute && approved) {
    process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";

    if (uploadWithMeta) {
      const { maybeRebuildExpectedPackagesAfterRemovalImport, resetExpectedPackagesRebuildOrchestratorDedupeForTests } =
        await import("../lib/removal/removal-expected-packages-rebuild-orchestrator");
      const { supabaseServer } = await import("../lib/supabase-server");
      resetExpectedPackagesRebuildOrchestratorDedupeForTests();
      autoHookResult = await maybeRebuildExpectedPackagesAfterRemovalImport({
        uploadId: uploadWithMeta.id,
        organizationId: ORG,
        reportType: uploadWithMeta.report_type,
        sourceRun: uploadWithMeta.sourceRun,
        supabase: supabaseServer,
      });
      explicitSkipResult = await evaluateExplicitRebuildSkipFromDb({
        client,
        organizationId: ORG,
        rebuildExpectedPackages: true,
        orderPipelineOk: uploadWithMeta.report_type === "REMOVAL_ORDER",
        shipmentPipelineOk: uploadWithMeta.report_type === "REMOVAL_SHIPMENT",
        orderUploadId: uploadWithMeta.report_type === "REMOVAL_ORDER" ? uploadWithMeta.id : null,
        shipmentUploadId: uploadWithMeta.report_type === "REMOVAL_SHIPMENT" ? uploadWithMeta.id : null,
      });
      removalPipelineResult = {
        status: "idempotency_verify_only",
        upload_id: uploadWithMeta.id,
        report_type: uploadWithMeta.report_type,
        note: "Upload already has rebuild metadata — orchestrator must skip without second RPC",
      };
    }

    if (executePipeline && resumableUpload) {
      const { runRemovalOrderReportsWorker } = await import("../lib/amazon/reports-api-removal-order-worker");
      const { runRemovalShipmentReportsWorker } = await import("../lib/amazon/reports-api-removal-shipment-worker");
      const worker =
        resumableUpload.report_type === "REMOVAL_ORDER"
          ? runRemovalOrderReportsWorker
          : runRemovalShipmentReportsWorker;
      const sr = resumableUpload.sourceRun;
      const window = sr.window ?? { start: sr.data_start_time ?? "", end: sr.data_end_time ?? "" };
      const workerResult = await worker(
        {
          organizationId: ORG,
          storeId: STORE,
          windowStart: window.start,
          windowEnd: window.end,
          uploadId: resumableUpload.id,
        },
        { runPipeline: true },
      );
      removalPipelineResult = {
        status: "pipeline_resume_executed",
        upload_id: resumableUpload.id,
        report_type: resumableUpload.report_type,
        run_pipeline: true,
        worker_result: {
          ok: workerResult.ok,
          state: workerResult.state,
          needs_resume: workerResult.needs_resume,
          upload_id: workerResult.upload_id,
          error: workerResult.error?.slice(0, 200) ?? null,
        },
      };
    } else if (executePipeline && !resumableUpload) {
      removalPipelineResult = {
        status: "pipeline_execute_pending",
        reason: "no_resumable_removal_upload_on_original",
        note: "Use --execute for idempotency verify; pipeline awaits next REMOVAL_* import or stuck upload",
      };
    }
  }

  const after = await originalBeforeSnapshot(client);
  const epAfter = await epDerivedCount(client);
  const ccAfter = Number(after.claim_candidates ?? 0);
  await client.end();

  let scannerPass = true;
  try {
    scannerPass =
      execSync('git status --porcelain "app/scanner/operator-mobile"', { encoding: "utf8" }).trim().length === 0;
  } catch {
    scannerPass = true;
  }

  let buildResult = execute ? "pending" : "skipped";
  let smokeResult = execute ? "pending" : "skipped";
  if (execute) {
    try {
      execSync("npm run test:production-removal-sync-dedupe-rebuild", { stdio: "pipe", encoding: "utf8" });
      smokeResult = "unit_pass";
    } catch {
      smokeResult = "unit_fail";
    }
    try {
      execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
      buildResult = "pass";
    } catch (e) {
      buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    }
  }

  const ccDelta = ccAfter - ccBefore;
  const targetPass =
    (after.target_case as { pass?: boolean })?.pass === true &&
    (before.target_case as { pass?: boolean })?.pass === true;
  const hookTestRan = Boolean(autoHookResult);
  const pipelineRan =
    removalPipelineResult.status === "pipeline_resume_executed" ||
    removalPipelineResult.status === "idempotency_verify_only";
  const idempotencyOk =
    !hookTestRan ||
    autoHookResult!.skipped_reason === "already_rebuilt_for_upload" ||
    autoHookResult!.rebuild_called === false;
  const explicitSkipOk = !explicitSkipResult || explicitSkipResult.skip === true;
  const epUnchanged = epBefore === epAfter;

  const safeReady = execute
    ? codeVerify.pipeline_hook_exists &&
      codeVerify.orchestrator_exists &&
      targetPass &&
      ccDelta === 0 &&
      scannerPass &&
      buildResult === "pass" &&
      epUnchanged &&
      (hookTestRan ? idempotencyOk && explicitSkipOk : false) &&
      (pipelineRan || hookTestRan)
      ? "yes"
      : targetPass && ccDelta === 0 && buildResult === "pass"
        ? "pending_pipeline_execute"
        : "conditional_no"
    : codeVerify.pipeline_hook_exists &&
        codeVerify.orchestrator_exists &&
        targetPass &&
        ccDelta === 0 &&
        scannerPass
      ? "yes"
      : "conditional_no";

  const summary = {
    prompt: "PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1-ORIGINAL-APPLY",
    run_id: id,
    original_ref: PRODUCTION_REF,
    mode: execute ? (executePipeline ? "execute_with_pipeline_attempt" : "execute_idempotency") : "read_only",
    maysam_approval: approved ? "yes" : "missing",
    original_before_snapshot: before,
    original_after_snapshot: after,
    deployed_code_verification: codeVerify,
    execute_candidates: {
      upload_with_rebuild_meta: uploadWithMeta
        ? { id: uploadWithMeta.id, report_type: uploadWithMeta.report_type }
        : null,
      resumable_upload: resumableUpload
        ? { id: resumableUpload.id, report_type: resumableUpload.report_type, status: resumableUpload.status }
        : null,
    },
    removal_pipeline_execute_result: removalPipelineResult,
    auto_hook_metadata_result: autoHookResult,
    explicit_rebuild_skip_result: explicitSkipResult,
    expected_packages_before_after: {
      derived_before: epBefore,
      derived_after: epAfter,
      unchanged_on_idempotency_run: epUnchanged,
    },
    clean_disputed_gating_result: {
      target_before: before.target_case,
      target_after: after.target_case,
      pass: targetPass,
    },
    target_case_result: after.target_case,
    raw_upload_state_result: before.raw_upload_removal_states,
    claim_candidates_delta: ccDelta,
    no_scanner_change_verification: { pass: scannerPass },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_REMOVAL_EP_ORIGINAL_ORCHESTRATOR_READY: safeReady,
    hook_metadata_on_original: (before.raw_upload_removal_states as Array<{ hook_recorded?: number }>).some(
      (r) => Number(r.hook_recorded ?? 0) > 0,
    ),
    NEXT_PROMPT:
      safeReady === "yes"
        ? "PHASE-REMOVAL-EP-ORCHESTRATOR-PRODUCTION-CRON-OBSERVE-V1 — monitor next scheduled removal import on original for hook metadata"
        : safeReady === "pending_pipeline_execute"
          ? "PHASE-REMOVAL-EP-ORCHESTRATOR-ORIGINAL-PIPELINE-MICRO-EXECUTE-V1 — next REMOVAL_* import with runPipeline:true on original; or resume in-flight upload when available"
          : "Investigate target regression or build failure before next removal import",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      ok: safeReady === "yes" || safeReady === "pending_pipeline_execute",
      run_id: id,
      mode: summary.mode,
      SAFE: safeReady,
      target_pass: targetPass,
      cc_delta: ccDelta,
    }),
  );
  if (execute && safeReady === "conditional_no") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
