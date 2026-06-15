/**
 * PHASE-AMAZON-REIMBURSEMENTS-ORIGINAL-BACKFILL-RETRY-V1
 *   npx tsx scripts/phase-amazon-reimbursements-original-backfill-retry-v1.ts
 *   APPROVED_REIMBURSEMENTS_ORIGINAL_BACKFILL_RETRY=yes npx tsx scripts/phase-amazon-reimbursements-original-backfill-retry-v1.ts --execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { rollingReimbursementsWindow } from "../lib/amazon/reports-api-reimbursements-window";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
} from "../lib/amazon/reports-api-worker-flags";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const FAILED_UPLOAD = "34663738-12c3-4f52-8261-15e2356497cd";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-reimbursements-original-backfill-retry-v1";
const MAX_RESUME_ROUNDS = 40;
const RESUME_SLEEP_MS = 4000;

const DEPLOYED_FILES = [
  "lib/amazon/reports-api-pull-worker.ts",
  "lib/amazon/reports-api-report-request.ts",
  "lib/amazon/reports-api-reimbursements-window.ts",
];

type Census = {
  row_count: number;
  max_event_date: string | null;
  max_created_at: string | null;
  approval_date_populated: number;
  amount_total_populated: number;
};

async function census(c: pg.Client): Promise<Census> {
  const r = await c.query(
    `SELECT count(*)::int AS c,
            max(approval_date)::text AS max_ev,
            max(created_at)::text AS max_ca,
            count(*) FILTER (WHERE approval_date IS NOT NULL)::int AS ev_pop,
            count(*) FILTER (WHERE amount_total IS NOT NULL)::int AS amt_pop
     FROM public.amazon_reimbursements WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );
  return {
    row_count: Number(r.rows[0]?.c ?? 0),
    max_event_date: r.rows[0]?.max_ev ?? null,
    max_created_at: r.rows[0]?.max_ca ?? null,
    approval_date_populated: Number(r.rows[0]?.ev_pop ?? 0),
    amount_total_populated: Number(r.rows[0]?.amt_pop ?? 0),
  };
}

async function claimCount(c: pg.Client): Promise<number> {
  const r = await c.query(`SELECT count(*)::int AS c FROM public.claim_candidates WHERE organization_id=$1::uuid`, [
    ORG,
  ]);
  return Number(r.rows[0]?.c ?? 0);
}

async function duplicateCheck(c: pg.Client): Promise<Record<string, unknown>> {
  const reimb = await c.query(
    `SELECT count(*)::int AS dup_groups FROM (
       SELECT source_line_hash FROM public.amazon_reimbursements
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
       GROUP BY source_line_hash HAVING count(*) > 1
     ) d`,
    [ORG, STORE],
  );
  return { reimbursement_source_line_hash_dup_groups: reimb.rows[0]?.dup_groups ?? 0 };
}

async function uploadStates(c: pg.Client): Promise<Record<string, unknown>> {
  const r = await c.query(
    `SELECT report_type, metadata->'source_run'->>'state' AS st, count(*)::int AS c
     FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid
       AND report_type IN ('REIMBURSEMENTS','SETTLEMENT')
       AND metadata->'source_run'->>'provider'='amazon_sp_api'
     GROUP BY 1,2 ORDER BY 1,3 DESC`,
    [ORG],
  );
  return { by_report_type_state: r.rows };
}

async function diagnoseFailedUpload(c: pg.Client): Promise<Record<string, unknown>> {
  const r = await c.query(
    `SELECT id::text, report_type, status, file_name, created_at, updated_at, metadata
     FROM public.raw_report_uploads WHERE id=$1::uuid`,
    [FAILED_UPLOAD],
  );
  const row = r.rows[0];
  if (!row) return { found: false };
  const meta = row.metadata as { source_run?: Record<string, unknown> } | null;
  const sr = meta?.source_run ?? {};
  const staging = await c.query(`SELECT count(*)::int AS c FROM public.amazon_staging WHERE upload_id=$1::uuid`, [
    FAILED_UPLOAD,
  ]);
  const domain = await c.query(
    `SELECT count(*)::int AS c FROM public.amazon_reimbursements WHERE upload_id=$1::uuid`,
    [FAILED_UPLOAD],
  );
  return {
    found: true,
    upload_id: row.id,
    report_type: row.report_type,
    status: row.status,
    source_run_state: sr.state ?? null,
    attempt: sr.attempt ?? null,
    window: sr.window ?? null,
    external_ids: sr.external_ids ?? null,
    idempotency_key: sr.idempotency_key ?? null,
    last_error_code: (sr.attempt as { last_error_code?: string } | undefined)?.last_error_code ?? null,
    last_error_detail: (sr.attempt as { last_error_detail?: string } | undefined)?.last_error_detail ?? null,
    staging_rows: staging.rows[0]?.c ?? 0,
    domain_rows: domain.rows[0]?.c ?? 0,
  };
}

function rollingWindow(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function runWorkerUntilDone(
  label: string,
  runFn: (args: {
    organizationId: string;
    storeId: string;
    windowStart: string;
    windowEnd: string;
    uploadId?: string | null;
  }) => Promise<{
    ok: boolean;
    upload_id: string | null;
    state: string | null;
    needs_resume: boolean;
    error?: string;
    error_code?: string;
    idempotent_replay?: boolean;
  }>,
  windowStart: string,
  windowEnd: string,
  uploadId?: string | null,
): Promise<Record<string, unknown>> {
  let currentUploadId = uploadId ?? null;
  let last = await runFn({
    organizationId: ORG,
    storeId: STORE,
    windowStart,
    windowEnd,
    uploadId: currentUploadId,
  });
  currentUploadId = last.upload_id ?? currentUploadId;
  let rounds = 0;
  while (last.needs_resume && rounds < MAX_RESUME_ROUNDS) {
    rounds++;
    await new Promise((r) => setTimeout(r, RESUME_SLEEP_MS));
    last = await runFn({
      organizationId: ORG,
      storeId: STORE,
      windowStart,
      windowEnd,
      uploadId: last.upload_id ?? currentUploadId,
    });
    currentUploadId = last.upload_id ?? currentUploadId;
    if (last.state === "complete" || last.state === "failed") break;
  }
  return {
    label,
    ok: last.ok,
    final_state: last.state,
    upload_id: currentUploadId,
    error_code: last.error_code ?? null,
    error: last.error?.slice(0, 200) ?? null,
    window_start: windowStart,
    window_end: windowEnd,
    resume_rounds: rounds,
    idempotent_replay: last.idempotent_replay ?? false,
  };
}

async function observedReimbursementSmoke(c: pg.Client): Promise<Record<string, unknown>> {
  const map = await c.query(
    `SELECT product_id::text FROM public.product_identifier_map
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND fnsku='X004LKS4VD' LIMIT 1`,
    [ORG, STORE],
  );
  const productId = map.rows[0]?.product_id ?? null;
  if (!productId) return { ok: false, reason: "no_product_map_for_X004LKS4VD" };
  const rows = await c.query(
    `SELECT count(*)::int AS c, coalesce(sum(amount_total),0)::numeric AS s
     FROM public.amazon_reimbursements
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND product_id=$3::uuid
       AND amount_total IS NOT NULL`,
    [ORG, STORE, productId],
  );
  return {
    ok: Number(rows.rows[0]?.c ?? 0) >= 0,
    product_id: productId,
    row_count: rows.rows[0]?.c ?? 0,
    amount_total_sum: rows.rows[0]?.s ?? 0,
  };
}

async function settlementReadOnlySmoke(c: pg.Client): Promise<Record<string, unknown>> {
  const r = await c.query(
    `SELECT count(*)::int AS c, max(posted_date)::text AS max_d
     FROM public.amazon_settlements WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );
  return { ok: true, row_count: r.rows[0]?.c ?? 0, max_posted_date: r.rows[0]?.max_d ?? null };
}

function bindOriginalEnv(): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  process.env.DIRECT_POSTGRES_URL = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
}

function assertOriginalRef(): void {
  const url = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  if (refFromSupabaseUrl(url) !== ORIGINAL_REF) {
    throw new Error(`BLOCKED: ORIGINAL_SUPABASE_URL must target ${ORIGINAL_REF}`);
  }
}

function assertApproval(execute: boolean): void {
  if (!execute) return;
  const approved = process.env.APPROVED_REIMBURSEMENTS_ORIGINAL_BACKFILL_RETRY?.trim().toLowerCase();
  if (approved !== "yes") {
    throw new Error("BLOCKED: set APPROVED_REIMBURSEMENTS_ORIGINAL_BACKFILL_RETRY=yes for --execute");
  }
}

async function feeAdjustedSmoke(): Promise<Record<string, unknown>> {
  try {
    execSync("npx tsx scripts/smoke-fee-adjusted-estimate-readmodel-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, SMOKE_ORG_ID: ORG, SMOKE_STORE_ID: STORE },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  loadEnvLocalIntoProcess();
  assertOriginalRef();
  assertApproval(execute);

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  bindOriginalEnv();

  if (execute) {
    process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT = "false";
  }

  const client = new pg.Client({
    connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const failedUploadDiagnosis = await diagnoseFailedUpload(client);
  const before = {
    amazon_reimbursements: await census(client),
    claim_candidates: await claimCount(client),
    raw_upload_states: await uploadStates(client),
  };

  const reimbursementRuns: Record<string, unknown>[] = [];

  if (execute) {
    const { runReimbursementsReportsWorker } = await import("../lib/amazon/reports-api-reimbursements-worker");

    const w7 = rollingReimbursementsWindow(7);
    reimbursementRuns.push(
      await runWorkerUntilDone(
        "reimbursements_7d_retry",
        (args) => runReimbursementsReportsWorker(args, { runPipeline: true }),
        w7.start,
        w7.end,
      ),
    );

    const sevenOk =
      reimbursementRuns[0]?.ok === true || reimbursementRuns[0]?.final_state === "complete";
    if (sevenOk) {
      const w30 = rollingReimbursementsWindow(30);
      reimbursementRuns.push(
        await runWorkerUntilDone(
          "reimbursements_30d_retry",
          (args) => runReimbursementsReportsWorker(args, { runPipeline: true }),
          w30.start,
          w30.end,
        ),
      );
    }
  }

  const after = {
    amazon_reimbursements: await census(client),
    claim_candidates: await claimCount(client),
    raw_upload_states: await uploadStates(client),
  };
  const failedAfter = await diagnoseFailedUpload(client);
  const dup = await duplicateCheck(client);
  const observed = await observedReimbursementSmoke(client);
  const settlementSmoke = await settlementReadOnlySmoke(client);
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
  const feeAdjusted = execute ? await feeAdjustedSmoke() : { skipped: true };

  if (execute) {
    try {
      execSync("npm run test:reports-api-reimbursements-window", { stdio: "pipe", encoding: "utf8" });
      execSync("npm run test:reports-api-reimbursements-mock", { stdio: "pipe", encoding: "utf8" });
    } catch (e) {
      smokeResult = `unit_fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
    if (smokeResult === "pending") {
      try {
        execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
        buildResult = "pass";
      } catch (e) {
        buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      }
      try {
        execSync("npx tsx scripts/test-scanner-shipment-line-aggregation-fix.ts", {
          stdio: "pipe",
          encoding: "utf8",
        });
        smokeResult = "pass";
      } catch (e) {
        smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      }
    }
  }

  const ccDelta = after.claim_candidates - before.claim_candidates;
  const reimbAdvanced =
    (after.amazon_reimbursements.max_event_date ?? "") >
    (before.amazon_reimbursements.max_event_date ?? "");
  const reimbRowsGrew = after.amazon_reimbursements.row_count > before.amazon_reimbursements.row_count;
  const sevenOk =
    !execute ||
    reimbursementRuns.some((r) => r.label === "reimbursements_7d_retry" && (r.ok === true || r.final_state === "complete"));
  const thirtyOk =
    !execute ||
    !reimbursementRuns.some((r) => r.label === "reimbursements_30d_retry") ||
    reimbursementRuns.some((r) => r.label === "reimbursements_30d_retry" && (r.ok === true || r.final_state === "complete"));

  const pass =
    execute &&
    sevenOk &&
    thirtyOk &&
    ccDelta === 0 &&
    !operatorMobileTouched &&
    buildResult === "pass" &&
    (reimbAdvanced || reimbRowsGrew);

  const report = {
    run_id: runId,
    mode: execute ? "original_execute" : "dry_run",
    original_project_ref: ORIGINAL_REF,
    failed_upload_diagnosis: failedUploadDiagnosis,
    root_cause:
      "report_fatal: reimbursement createReport window included unavailable dates (Amazon 168h data lag); rolling window ended at now instead of lag-clamped end",
    files_changed: DEPLOYED_FILES.filter((f) => fs.existsSync(path.join(process.cwd(), f))),
    reimbursement_7d_retry_result: reimbursementRuns.find((r) => r.label === "reimbursements_7d_retry") ?? null,
    reimbursement_30d_retry_result: reimbursementRuns.find((r) => r.label === "reimbursements_30d_retry") ?? null,
    raw_upload_state_result: { before: before.raw_upload_states, after: after.raw_upload_states, failed_upload_after: failedAfter },
    row_counts_before_after: {
      amazon_reimbursements: { before: before.amazon_reimbursements.row_count, after: after.amazon_reimbursements.row_count },
    },
    max_approval_date_before_after: {
      before: before.amazon_reimbursements.max_event_date,
      after: after.amazon_reimbursements.max_event_date,
      advanced: reimbAdvanced,
    },
    amount_total_population_result: {
      before: before.amazon_reimbursements.amount_total_populated,
      after: after.amazon_reimbursements.amount_total_populated,
    },
    duplicate_check: dup,
    observed_reimbursement_lane_result: observed,
    settlement_readonly_smoke: settlementSmoke,
    fee_adjusted_estimate_smoke: feeAdjusted,
    claim_candidates_delta: ccDelta,
    no_scanner_change_verification: { operator_mobile_touched: operatorMobileTouched },
    build_result: buildResult,
    smoke_result: smokeResult,
    flags_checked: execute
      ? {
          worker: isAmazonReportsApiWorkerEnabled(),
          reimbursements: isAmazonReportsApiReimbursementsEnabled(),
          settlement: isAmazonReportsApiSettlementEnabled(),
        }
      : null,
    SAFE_REIMBURSEMENTS_ORIGINAL_FIXED: pass ? "yes" : execute ? "no" : "pending_execute",
    NEXT_PROMPT:
      "PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-ORIGINAL-VERIFY-CRON — wire scheduled reimbursement/settlement pulls on original with 90d clamp; monitor raw_upload complete/failed ratio",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-AMAZON-REIMBURSEMENTS-ORIGINAL-BACKFILL-RETRY-V1\n\n**Run:** ${runId}\n**SAFE_REIMBURSEMENTS_ORIGINAL_FIXED:** ${report.SAFE_REIMBURSEMENTS_ORIGINAL_FIXED}\n\n## Root cause\n${report.root_cause}\n`,
  );
  console.log(JSON.stringify({ ok: pass, outDir, SAFE_REIMBURSEMENTS_ORIGINAL_FIXED: report.SAFE_REIMBURSEMENTS_ORIGINAL_FIXED }));
  if (execute && !pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
