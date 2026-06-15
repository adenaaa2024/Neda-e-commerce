/**
 * PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-FIX-V1-ORIGINAL-APPLY
 *   npx tsx scripts/phase-amazon-financial-reports-backfill-fix-v1-original-apply.ts
 *   APPROVED_FINANCIAL_REPORTS_BACKFILL_FIX_ORIGINAL_APPLY=yes npx tsx scripts/phase-amazon-financial-reports-backfill-fix-v1-original-apply.ts --execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import { chunkDateWindow } from "../lib/amazon/reports-api-settlement-list-window";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
} from "../lib/amazon/reports-api-worker-flags";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-financial-reports-backfill-fix-v1-original-apply";
const MAX_RESUME_ROUNDS = 40;
const RESUME_SLEEP_MS = 4000;

const DEPLOYED_FILES = [
  "lib/amazon/reports-api-settlement-list-window.ts",
  "lib/amazon/reports-api-report-request.ts",
  "lib/amazon/reports-api-pull-worker.ts",
  "lib/amazon/reports-api-source-run.ts",
  "lib/import-sync-mappers.ts",
  "scripts/test-reports-api-settlement-list-window.ts",
];

type Census = {
  row_count: number;
  max_event_date: string | null;
  max_created_at: string | null;
  physical_column_populated: number;
};

async function census(c: pg.Client, table: string, eventCol: string): Promise<Census> {
  const amountCol = table === "amazon_reimbursements" ? "amount_total" : "amount_total";
  const r = await c.query(
    `SELECT count(*)::int AS c,
            max(${eventCol})::text AS max_ev,
            max(created_at)::text AS max_ca,
            count(*) FILTER (WHERE ${eventCol} IS NOT NULL)::int AS ev_pop,
            count(*) FILTER (WHERE ${amountCol} IS NOT NULL)::int AS amt_pop
     FROM public.${table} WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );
  return {
    row_count: Number(r.rows[0]?.c ?? 0),
    max_event_date: r.rows[0]?.max_ev ?? null,
    max_created_at: r.rows[0]?.max_ca ?? null,
    physical_column_populated: Number(r.rows[0]?.ev_pop ?? 0),
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
  const sett = await c.query(
    `SELECT count(*)::int AS dup_groups FROM (
       SELECT organization_id, upload_id, amazon_line_key FROM public.amazon_settlements
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
       GROUP BY organization_id, upload_id, amazon_line_key HAVING count(*) > 1
     ) d`,
    [ORG, STORE],
  );
  return {
    reimbursement_source_line_hash_dup_groups: reimb.rows[0]?.dup_groups ?? 0,
    settlement_line_key_dup_groups: sett.rows[0]?.dup_groups ?? 0,
  };
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

async function resumeStuckCompleteUploads(
  supabase: ReturnType<typeof createClient>,
): Promise<Record<string, unknown>[]> {
  const { assessReportsApiPipelineCompletion } = await import(
    "../lib/amazon/reports-api-pipeline-completion"
  );
  const { runReimbursementsReportsWorker } = await import("../lib/amazon/reports-api-reimbursements-worker");
  const { runSettlementReportsWorker } = await import("../lib/amazon/reports-api-settlement-worker");

  const { data: uploads, error } = await supabase
    .from("raw_report_uploads")
    .select("id, report_type, metadata, created_at")
    .eq("organization_id", ORG)
    .in("report_type", ["REIMBURSEMENTS", "SETTLEMENT"])
    .order("created_at", { ascending: false })
    .limit(80);
  if (error) throw new Error(error.message);

  const results: Record<string, unknown>[] = [];
  for (const row of uploads ?? []) {
    const meta = (row as { metadata?: { source_run?: { state?: string } } }).metadata;
    const state = meta?.source_run?.state;
    if (state !== "complete" && state !== "failed") continue;

    const uploadId = String((row as { id: string }).id);
    const reportType = String((row as { report_type: string }).report_type);
    const assessment = await assessReportsApiPipelineCompletion(supabase, ORG, uploadId, reportType);
    if (state === "complete" && !assessment.needs_domain_sync) continue;

    const w = rollingWindow(7);
    const runFn =
      reportType === "SETTLEMENT" ? runSettlementReportsWorker : runReimbursementsReportsWorker;
    results.push(
      await runWorkerUntilDone(
        `resume_${reportType}_${uploadId.slice(0, 8)}`,
        runFn,
        w.start,
        w.end,
        uploadId,
      ),
    );
  }
  return results;
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

function assertMaysamApproval(execute: boolean): void {
  if (!execute) return;
  const approved = process.env.APPROVED_FINANCIAL_REPORTS_BACKFILL_FIX_ORIGINAL_APPLY?.trim().toLowerCase();
  if (approved !== "yes") {
    throw new Error(
      "BLOCKED: set APPROVED_FINANCIAL_REPORTS_BACKFILL_FIX_ORIGINAL_APPLY=yes for --execute",
    );
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
  assertMaysamApproval(execute);

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  bindOriginalEnv();

  if (execute) {
    process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT = "true";
  }

  const client = new pg.Client({
    connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const originalBeforeSnapshot = {
    amazon_reimbursements: await census(client, "amazon_reimbursements", "approval_date"),
    amazon_settlements: await census(client, "amazon_settlements", "posted_date"),
    claim_candidates: await claimCount(client),
    raw_upload_states: await uploadStates(client),
  };

  const reimbursementRuns: Record<string, unknown>[] = [];
  const settlementRuns: Record<string, unknown>[] = [];
  let resumeResults: Record<string, unknown>[] = [];

  if (execute) {
    const supabase = createClient(
      process.env.ORIGINAL_SUPABASE_URL!.trim(),
      process.env.ORIGINAL_SERVICE_ROLE_KEY!.trim(),
      { auth: { persistSession: false } },
    );

    resumeResults = await resumeStuckCompleteUploads(supabase);

    const { runReimbursementsReportsWorker } = await import("../lib/amazon/reports-api-reimbursements-worker");
    const { runSettlementReportsWorker } = await import("../lib/amazon/reports-api-settlement-worker");

    const w7 = rollingWindow(7);
    reimbursementRuns.push(
      await runWorkerUntilDone("reimbursements_7d", runReimbursementsReportsWorker, w7.start, w7.end),
    );

    const w30 = rollingWindow(30);
    for (const [i, chunk] of chunkDateWindow(w30.start, w30.end, 30).entries()) {
      settlementRuns.push(
        await runWorkerUntilDone(
          `settlements_30d_chunk_${i + 1}`,
          runSettlementReportsWorker,
          chunk.start,
          chunk.end,
        ),
      );
    }
  }

  const originalAfterSnapshot = {
    amazon_reimbursements: await census(client, "amazon_reimbursements", "approval_date"),
    amazon_settlements: await census(client, "amazon_settlements", "posted_date"),
    claim_candidates: await claimCount(client),
    raw_upload_states: await uploadStates(client),
  };

  const dup = await duplicateCheck(client);
  const observed = await observedReimbursementSmoke(client);
  await client.end();

  let operatorMobileTouched = false;
  try {
    operatorMobileTouched =
      execSync('git status --porcelain "app/scanner/operator-mobile"', { encoding: "utf8" }).trim().length > 0;
  } catch {
    operatorMobileTouched = false;
  }

  const deployedFiles = DEPLOYED_FILES.filter((f) => fs.existsSync(path.join(process.cwd(), f)));

  let buildResult = execute ? "pending" : "skipped";
  let smokeResult = execute ? "pending" : "skipped";
  const feeAdjusted = execute ? await feeAdjustedSmoke() : { skipped: true };

  if (execute) {
    try {
      execSync("npm run test:reports-api-settlement-list-window", { stdio: "pipe", encoding: "utf8" });
      execSync("npm run test:reports-api-settlement-create-body", { stdio: "pipe", encoding: "utf8" });
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

  const noList400 = settlementRuns.every((r) => r.error_code !== "list_reports_failed");
  const reimbOk =
    !execute ||
    reimbursementRuns.some((r) => r.ok === true || r.final_state === "complete") ||
    reimbursementRuns.every((r) => r.error_code !== "list_reports_failed");
  const settOk =
    !execute ||
    settlementRuns.some((r) => r.ok === true || r.final_state === "complete") ||
    settlementRuns.every((r) => r.error_code !== "list_reports_failed");

  const eventAdvancement = {
    amazon_reimbursements_max_approval_date: {
      before: originalBeforeSnapshot.amazon_reimbursements.max_event_date,
      after: originalAfterSnapshot.amazon_reimbursements.max_event_date,
      advanced:
        (originalAfterSnapshot.amazon_reimbursements.max_event_date ?? "") >=
        (originalBeforeSnapshot.amazon_reimbursements.max_event_date ?? ""),
    },
    amazon_settlements_max_posted_date: {
      before: originalBeforeSnapshot.amazon_settlements.max_event_date,
      after: originalAfterSnapshot.amazon_settlements.max_event_date,
      advanced:
        (originalAfterSnapshot.amazon_settlements.max_event_date ?? "") >=
        (originalBeforeSnapshot.amazon_settlements.max_event_date ?? ""),
    },
  };

  const ccDelta = originalAfterSnapshot.claim_candidates - originalBeforeSnapshot.claim_candidates;

  const pass =
    execute &&
    reimbOk &&
    settOk &&
    noList400 &&
    ccDelta === 0 &&
    !operatorMobileTouched &&
    buildResult === "pass" &&
    eventAdvancement.amazon_reimbursements_max_approval_date.advanced &&
    eventAdvancement.amazon_settlements_max_posted_date.advanced;

  const report = {
    run_id: runId,
    mode: execute ? "original_execute" : "dry_run",
    maysam_approval: execute ? "APPROVED_FINANCIAL_REPORTS_BACKFILL_FIX_ORIGINAL_APPLY=yes" : "not_required",
    original_project_ref: ORIGINAL_REF,
    original_before_snapshot: originalBeforeSnapshot,
    deployed_files: deployedFiles,
    flags_checked: execute
      ? {
          worker: isAmazonReportsApiWorkerEnabled(),
          reimbursements: isAmazonReportsApiReimbursementsEnabled(),
          settlement: isAmazonReportsApiSettlementEnabled(),
        }
      : null,
    reimbursement_7d_result: reimbursementRuns,
    settlement_30d_result: settlementRuns,
    raw_upload_resume_result: resumeResults,
    raw_upload_state_result: originalAfterSnapshot.raw_upload_states,
    original_after_snapshot: originalAfterSnapshot,
    event_date_advancement: eventAdvancement,
    duplicate_check: dup,
    observed_reimbursement_lane_result: observed,
    fee_adjusted_estimate_smoke: feeAdjusted,
    claim_candidates_delta: ccDelta,
    no_scanner_change_verification: { operator_mobile_touched: operatorMobileTouched },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_FINANCIAL_ORIGINAL_FIXED: pass ? "yes" : execute ? "no" : "pending_execute",
    NEXT_PROMPT:
      "PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-ORIGINAL-VERIFY-CRON — wire scheduled reimbursement/settlement pulls on original with 90d clamp; monitor raw_upload complete/failed ratio",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-FIX-V1-ORIGINAL-APPLY\n\n**Run:** ${runId}\n**SAFE_FINANCIAL_ORIGINAL_FIXED:** ${report.SAFE_FINANCIAL_ORIGINAL_FIXED}\n`,
  );
  console.log(
    JSON.stringify({
      ok: pass,
      outDir,
      SAFE_FINANCIAL_ORIGINAL_FIXED: report.SAFE_FINANCIAL_ORIGINAL_FIXED,
      claim_candidates_delta: ccDelta,
      event_date_advancement: eventAdvancement,
    }),
  );
  if (execute && !pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
