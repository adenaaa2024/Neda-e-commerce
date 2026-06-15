/**
 * PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-ORIGINAL-VERIFY-CRON
 * Read-only original cron/readiness verification — no claim_candidates writes, no SP-API execute by default.
 *
 *   npx tsx scripts/phase-amazon-financial-reports-backfill-original-verify-cron.ts
 *   APPROVED_FINANCIAL_CRON_ORIGINAL_MICRO_EXECUTE=yes npx tsx scripts/phase-amazon-financial-reports-backfill-original-verify-cron.ts --micro-execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import {
  REIMBURSEMENTS_DATA_LAG_DAYS,
  clampReimbursementsCreateWindow,
  rollingReimbursementsWindow,
} from "../lib/amazon/reports-api-reimbursements-window";
import { buildReimbursementsCreateReportBody, buildSettlementListReportsQuery } from "../lib/amazon/reports-api-report-request";
import {
  SETTLEMENT_LIST_REPORTS_MAX_WINDOW_DAYS,
  clampSettlementListWindow,
  chunkDateWindow,
  settlementListWindowSpanDays,
} from "../lib/amazon/reports-api-settlement-list-window";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
} from "../lib/amazon/reports-api-worker-flags";
import { apiCardSyncWindowThroughToday } from "../lib/platform-automation-api-card-window";
import { readPlatformAutomationApiFlags } from "../lib/platform-automation-api-flags";
import { evaluateAllApiCardSchedules } from "../lib/platform-automation-scheduler-due";
import { readStoreAutomationSettingsFromPg } from "../lib/platform-automation-settings-read";
import { bindProductionSupabaseEnv, PRODUCTION_REF, productionPostgresUrl } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = PRODUCTION_REF;
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-financial-reports-backfill-original-verify-cron";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function envFlagPresent(name: string): boolean {
  const v = process.env[name]?.trim();
  return v != null && v !== "";
}

function envFlagTruthy(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

type Census = {
  row_count: number;
  max_event_date: string | null;
  max_created_at: string | null;
};

async function tableCensus(c: pg.Client, table: string, eventCol: string): Promise<Census> {
  const r = await c.query(
    `SELECT count(*)::int AS c, max(${eventCol})::text AS max_ev, max(created_at)::text AS max_ca
     FROM public.${table} WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );
  return {
    row_count: Number(r.rows[0]?.c ?? 0),
    max_event_date: r.rows[0]?.max_ev ?? null,
    max_created_at: r.rows[0]?.max_ca ?? null,
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

async function rawUploadRatio(c: pg.Client): Promise<Record<string, unknown>> {
  const r = await c.query(
    `SELECT report_type,
            count(*) FILTER (WHERE status='complete')::int AS complete,
            count(*) FILTER (WHERE status='failed')::int AS failed,
            count(*) FILTER (WHERE status NOT IN ('complete','failed'))::int AS other,
            count(*)::int AS total
     FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid
       AND report_type IN ('REIMBURSEMENTS','SETTLEMENT')
       AND metadata->'source_run'->>'provider'='amazon_sp_api'
     GROUP BY report_type ORDER BY report_type`,
    [ORG],
  );
  const byType: Record<string, { complete: number; failed: number; other: number; total: number; complete_ratio: number | null }> = {};
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const complete = Number(row.complete ?? 0);
    const failed = Number(row.failed ?? 0);
    const total = Number(row.total ?? 0);
    byType[String(row.report_type)] = {
      complete,
      failed,
      other: Number(row.other ?? 0),
      total,
      complete_ratio: total > 0 ? Math.round((complete / total) * 1000) / 1000 : null,
    };
  }
  return byType;
}

async function observedReimbursementLane(c: pg.Client): Promise<Record<string, unknown>> {
  const sample = await c.query(
    `SELECT count(*)::int AS c,
            count(*) FILTER (WHERE amount_total IS NOT NULL AND amount_total <> 0)::int AS with_amount
     FROM public.amazon_reimbursements
     WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );
  const recent = await c.query(
    `SELECT approval_date::text, amount_total, fnsku
     FROM public.amazon_reimbursements
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND amount_total IS NOT NULL
     ORDER BY approval_date DESC NULLS LAST LIMIT 1`,
    [ORG, STORE],
  );
  return {
    row_count: sample.rows[0]?.c ?? 0,
    rows_with_nonzero_amount: sample.rows[0]?.with_amount ?? 0,
    latest_row: recent.rows[0] ?? null,
    lane_ok: Number(sample.rows[0]?.with_amount ?? 0) > 0,
  };
}

function reimbursementLagVerification(): Record<string, unknown> {
  const nowEnd = new Date().toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const clamped = clampReimbursementsCreateWindow({ start: weekAgo, end: nowEnd });
  const body = buildReimbursementsCreateReportBody({
    marketplaceIds: ["ATVPDKIKX0DER"],
    dataStartTime: weekAgo,
    dataEndTime: nowEnd,
  });
  const lagMs = Date.now() - Date.parse(clamped.end);
  const lagDays = lagMs / 86_400_000;
  const rolling7 = rollingReimbursementsWindow(7);
  return {
    REIMBURSEMENTS_DATA_LAG_DAYS,
    clamped_end_before_now: Date.parse(clamped.end) < Date.now(),
    lag_days_from_now_approx: Math.round(lagDays * 10) / 10,
    lag_at_least_7_days: lagDays >= 7,
    create_body_uses_clamped_window: body.dataEndTime === clamped.end,
    rolling_7d_window: rolling7,
    pass: lagDays >= 7 && body.dataEndTime === clamped.end,
  };
}

function settlement90dVerification(): Record<string, unknown> {
  const end = "2026-06-13T02:45:44.885Z";
  const start = "2025-11-13T02:45:44.885Z";
  const window = { start, end };
  const clamped = clampSettlementListWindow(window);
  const q = buildSettlementListReportsQuery({
    marketplaceIds: ["ATVPDKIKX0DER"],
    windowStart: start,
    windowEnd: end,
  });
  const chunks = chunkDateWindow("2026-04-14T00:00:00.000Z", "2026-06-13T00:00:00.000Z", 30);
  return {
    SETTLEMENT_LIST_REPORTS_MAX_WINDOW_DAYS,
    input_span_days: settlementListWindowSpanDays(window),
    clamped_span_days: settlementListWindowSpanDays(clamped),
    query_created_since: q.createdSince,
    query_created_until: q.createdUntil,
    chunk_count_60d: chunks.length,
    pass:
      settlementListWindowSpanDays(clamped) <= SETTLEMENT_LIST_REPORTS_MAX_WINDOW_DAYS &&
      Date.parse(q.createdUntil) - Date.parse(q.createdSince) <= 90 * 86_400_000 + 1000,
  };
}

function cronRoutesOrWorkflowsFound(): Record<string, unknown> {
  const vercel = fs.existsSync(path.join(process.cwd(), "vercel.json"))
    ? JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"))
    : {};
  const crons = (vercel.crons ?? []) as Array<{ path: string; schedule: string }>;
  const workflows = [
    ".github/workflows/removal-automation-staging.yml",
    ".github/workflows/platform-automation-api-cards-staging.yml",
  ].map((f) => ({
    path: f,
    exists: fs.existsSync(path.join(process.cwd(), f)),
    targets: f.includes("api-cards") ? "staging_only_financial_api_cards" : "staging_only_removals",
  }));
  const apiRoutes = [
    "app/api/cron/removal-nightly-sync/route.ts",
    "app/api/settings/imports/reports-api/settlement/run/route.ts",
    "app/api/settings/imports/reports-api/settlement/resume/route.ts",
  ].filter((f) => fs.existsSync(path.join(process.cwd(), f)));
  return {
    vercel_crons: crons,
    financial_vercel_cron: crons.some((c) => c.path.includes("financial") || c.path.includes("reimburse") || c.path.includes("settlement")),
    removal_vercel_cron: crons.find((c) => c.path.includes("removal")),
    github_workflows: workflows,
    manual_api_routes: apiRoutes,
    production_financial_cron_route: fs.existsSync(
      path.join(process.cwd(), "app/api/cron/financial-api-cards-sync/route.ts"),
    ),
    scheduled_executor_module: "lib/platform-automation-api-card-scheduled-run.ts",
    staging_orchestrator: "scripts/platform-automation-api-cards-orchestrator.ts (blocks original ref)",
  };
}

function scannerUntouched(): { pass: boolean; detail: string } {
  const scannerRoot = path.join(process.cwd(), "app/scanner/operator-mobile");
  if (!fs.existsSync(scannerRoot)) return { pass: true, detail: "operator-mobile path missing — no changes checked" };
  const git = execSync("git status --porcelain app/scanner/operator-mobile", {
    encoding: "utf8",
    cwd: process.cwd(),
  }).trim();
  return { pass: git.length === 0, detail: git.length ? `dirty: ${git.split("\n").length} paths` : "clean working tree" };
}

async function feeAdjustedSmokeOriginal(): Promise<Record<string, unknown>> {
  try {
    bindProductionSupabaseEnv();
    const { buildFeeAdjustedEstimate } = await import("../lib/fees/fee-adjusted-estimate-readmodel");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
    const client = createClient(url, key, { auth: { persistSession: false } });
    const map = await client
      .from("product_identifier_map")
      .select("product_id")
      .eq("organization_id", ORG)
      .eq("store_id", STORE)
      .ilike("fnsku", "B0000B11UX")
      .limit(1)
      .maybeSingle();
    const productId = (map.data as { product_id?: string } | null)?.product_id;
    if (!productId) return { pass: false, reason: "no_product_for_spine_fnsku" };
    const est = await buildFeeAdjustedEstimate(client, ORG, STORE, productId);
    return {
      pass: true,
      product_id: productId,
      observed_reimbursement: est.observed_reimbursement,
      estimated_amazon_payout: est.estimated_amazon_payout,
      internal_cost_loss: est.internal_cost_loss,
    };
  } catch (e) {
    return { pass: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  const id = runId();
  const microExecute = process.argv.includes("--micro-execute");
  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();

  const flagsStatus = {
    env_present: {
      ENABLE_AMAZON_REPORTS_API_WORKER: envFlagPresent("ENABLE_AMAZON_REPORTS_API_WORKER"),
      ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS: envFlagPresent("ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS"),
      ENABLE_AMAZON_REPORTS_API_SETTLEMENT: envFlagPresent("ENABLE_AMAZON_REPORTS_API_SETTLEMENT"),
      ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON: envFlagPresent("ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON"),
      CRON_SECRET: envFlagPresent("CRON_SECRET"),
      ORIGINAL_DIRECT_POSTGRES_URL: envFlagPresent("ORIGINAL_DIRECT_POSTGRES_URL"),
      ORIGINAL_SUPABASE_URL: envFlagPresent("ORIGINAL_SUPABASE_URL"),
    },
    env_truthy_local: readPlatformAutomationApiFlags(),
  };

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    execSync("npm run test:reports-api-reimbursements-window", { stdio: "pipe", encoding: "utf8" });
    execSync("npm run test:reports-api-settlement-list-window", { stdio: "pipe", encoding: "utf8" });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }

  const reimbLag = reimbursementLagVerification();
  const sett90 = settlement90dVerification();
  const cronFound = cronRoutesOrWorkflowsFound();
  const scannerCheck = scannerUntouched();

  const dbUrl = productionPostgresUrl();
  if (!dbUrl.includes(ORIGINAL_REF)) throw new Error("ORIGINAL postgres URL ref mismatch");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const claimBefore = await claimCount(client);
  const reimbCensus = await tableCensus(client, "amazon_reimbursements", "approval_date");
  const settCensus = await tableCensus(client, "amazon_settlements", "posted_date");
  const dup = await duplicateCheck(client);
  const uploadRatio = await rawUploadRatio(client);
  const observed = await observedReimbursementLane(client);

  const storeSettings = await readStoreAutomationSettingsFromPg(client, ORG, STORE);
  const now = new Date();
  const evals = evaluateAllApiCardSchedules(storeSettings, now);

  const { runScheduledApiCard } = await import("../lib/platform-automation-api-card-scheduled-run");
  const dryRunCards: Record<string, unknown> = {};
  for (const card of ["reimbursements_api", "settlement_api"] as const) {
    dryRunCards[card] = await runScheduledApiCard({
      connectionString: dbUrl,
      organizationId: ORG,
      storeId: STORE,
      evaluation: evals[card],
      schedule: storeSettings[card],
      dryRun: true,
    });
  }

  const claimAfter = await claimCount(client);
  await client.end();

  const feeAdjusted = await feeAdjustedSmokeOriginal();

  let optionalExecute: Record<string, unknown> | null = null;
  if (microExecute) {
    if (process.env.APPROVED_FINANCIAL_CRON_ORIGINAL_MICRO_EXECUTE?.trim() !== "yes") {
      optionalExecute = { blocked: true, reason: "APPROVED_FINANCIAL_CRON_ORIGINAL_MICRO_EXECUTE=yes required" };
    } else if (!isAmazonReportsApiReimbursementsEnabled()) {
      optionalExecute = { blocked: true, reason: "reimbursements env flags off — set in process for micro execute" };
    } else {
      process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
      process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS = "true";
      process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT = "false";
      process.env.DIRECT_POSTGRES_URL = dbUrl;
      bindProductionSupabaseEnv();
      const { runReimbursementsReportsWorker } = await import("../lib/amazon/reports-api-reimbursements-worker");
      const win = rollingReimbursementsWindow(7);
      const result = await runReimbursementsReportsWorker({
        organizationId: ORG,
        storeId: STORE,
        windowStart: win.start,
        windowEnd: win.end,
        actorUserId: null,
        uploadId: null,
      });
      optionalExecute = {
        approval_gate: "APPROVED_FINANCIAL_CRON_ORIGINAL_MICRO_EXECUTE=yes",
        window: win,
        result: {
          ok: result.ok,
          state: result.state,
          needs_resume: result.needs_resume,
          upload_id: result.upload_id,
          error: result.error?.slice(0, 200) ?? null,
        },
      };
    }
  }

  const ccDelta = claimAfter - claimBefore;
  const productionFinancialCronWired = Boolean(cronFound.production_financial_cron_route);
  const stagingOnlyWorkflow = Boolean(
    (cronFound.github_workflows as Array<{ path: string; targets: string }>).find((w) =>
      w.path.includes("api-cards"),
    )?.exists,
  );

  const reimbursementScheduleStatus = {
    enabled: storeSettings.reimbursements_api.enabled,
    rolling_days: storeSettings.reimbursements_api.rolling_days,
    run_hours_utc: storeSettings.reimbursements_api.run_hours_utc,
    cron_runtime: storeSettings.reimbursements_api.cron_runtime ?? null,
    evaluation: evals.reimbursements_api.schedule,
    preview_window: apiCardSyncWindowThroughToday(storeSettings.reimbursements_api.rolling_days),
    dry_run: dryRunCards.reimbursements_api,
    production_cron_route: productionFinancialCronWired,
  };

  const settlementScheduleStatus = {
    enabled: storeSettings.settlement_api.enabled,
    rolling_days: storeSettings.settlement_api.rolling_days,
    run_hours_utc: storeSettings.settlement_api.run_hours_utc,
    cron_runtime: storeSettings.settlement_api.cron_runtime ?? null,
    evaluation: evals.settlement_api.schedule,
    preview_window: apiCardSyncWindowThroughToday(storeSettings.settlement_api.rolling_days),
    dry_run: dryRunCards.settlement_api,
    production_cron_route: productionFinancialCronWired,
  };

  const blockers: string[] = [];
  if (!reimbLag.pass) blockers.push("reimbursement_lag_clamp_unit_fail");
  if (!sett90.pass) blockers.push("settlement_90d_clamp_unit_fail");
  if (!productionFinancialCronWired) blockers.push("no_production_financial_vercel_cron_route");
  if (stagingOnlyWorkflow) blockers.push("github_api_cards_workflow_staging_only");
  if (!flagsStatus.env_truthy_local.reimbursements_enabled) blockers.push("local_env_reimbursements_flag_off");
  if (!flagsStatus.env_truthy_local.settlement_enabled) blockers.push("local_env_settlement_flag_off");
  if (!reimbursementScheduleStatus.enabled) blockers.push("platform_settings_reimbursements_schedule_disabled");
  if (!settlementScheduleStatus.enabled) blockers.push("platform_settings_settlement_schedule_disabled");
  if (ccDelta !== 0) blockers.push(`claim_candidates_delta_${ccDelta}`);
  if (!observed.lane_ok) blockers.push("observed_reimbursement_lane_empty");

  const safeReady =
    reimbLag.pass &&
    sett90.pass &&
    ccDelta === 0 &&
    observed.lane_ok &&
    scannerCheck.pass &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    productionFinancialCronWired &&
    reimbursementScheduleStatus.enabled &&
    settlementScheduleStatus.enabled
      ? "yes"
      : reimbLag.pass &&
          sett90.pass &&
          ccDelta === 0 &&
          observed.lane_ok &&
          buildResult === "pass" &&
          smokeResult === "pass"
        ? "conditional_no"
        : "no";

  const summary = {
    prompt: "PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-ORIGINAL-VERIFY-CRON",
    run_id: id,
    original_ref: ORIGINAL_REF,
    read_only: !microExecute,
    cron_routes_or_workflows_found: cronFound,
    flags_status: flagsStatus,
    reimbursement_schedule_status: reimbursementScheduleStatus,
    settlement_schedule_status: settlementScheduleStatus,
    reimbursement_lag_clamp_verification: reimbLag,
    settlement_90d_clamp_verification: sett90,
    dry_run_result: dryRunCards,
    optional_execute_result_if_run: optionalExecute,
    raw_upload_complete_failed_ratio: uploadRatio,
    row_counts_before_after: {
      amazon_reimbursements: reimbCensus,
      amazon_settlements: settCensus,
    },
    max_event_dates_before_after: {
      amazon_reimbursements_max_approval_date: reimbCensus.max_event_date,
      amazon_settlements_max_posted_date: settCensus.max_event_date,
    },
    duplicate_check: dup,
    observed_reimbursement_lane_result: observed,
    fee_adjusted_estimate_smoke: feeAdjusted,
    claim_candidates_delta: ccDelta,
    no_scanner_change_verification: scannerCheck,
    build_result: buildResult,
    smoke_result: smokeResult,
    blockers,
    SAFE_FINANCIAL_CRON_ORIGINAL_READY: safeReady,
    NEXT_PROMPT:
      safeReady === "yes"
        ? "PHASE-AMAZON-FINANCIAL-API-CARDS-PRODUCTION-CRON-WIRE-V1 — Vercel wake route + ENABLE flags on production deploy"
        : "PHASE-AMAZON-FINANCIAL-API-CARDS-PRODUCTION-CRON-WIRE-V1 — wire /api/cron/financial-api-cards-sync on original; enable platform_settings reimbursements_api + settlement_api schedules; set Vercel ENABLE_AMAZON_REPORTS_API_* flags",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      ok: safeReady !== "no",
      run_id: id,
      SAFE: safeReady,
      reimb_rows: reimbCensus.row_count,
      sett_rows: settCensus.row_count,
      cc_delta: ccDelta,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
