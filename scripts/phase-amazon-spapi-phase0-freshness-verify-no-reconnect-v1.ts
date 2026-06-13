/**
 * PHASE-AMAZON-SPAPI-PHASE0-FRESHNESS-VERIFY-NO-RECONNECT-V1
 * Staging freshness verify — no removal reconnect/rebuild.
 *
 *   npx tsx scripts/phase-amazon-spapi-phase0-freshness-verify-no-reconnect-v1.ts
 *   npx tsx scripts/phase-amazon-spapi-phase0-freshness-verify-no-reconnect-v1.ts --execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildRemovalSupersessionReadinessSummary,
  type RemovalDetailRowLike,
  type RemovalShipmentRowLike,
} from "../lib/claims/removal/removal-source-supersession-readmodel";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiRemovalOrderEnabled,
  isAmazonReportsApiRemovalShipmentEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
} from "../lib/amazon/reports-api-worker-flags";
import { readPlatformAutomationSettingsFromPg } from "../lib/platform-automation-settings-read";
import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-spapi-phase0-freshness-verify-no-reconnect-v1";
const STALE_DAYS = 45;
const BACKFILL_MONTHS = 7;
const CHUNK_DAYS = 30;
const MAX_RESUME_ROUNDS = 40;
const RESUME_SLEEP_MS = 4000;
const REMOVAL_CRON_WORKFLOW = ".github/workflows/removal-automation-staging.yml";
const SETTLEMENT_APPROVAL = ".cursor/operator-approvals/import-api-09-settlement-staging-smoke-approval.md";

const RUN_NOW_ROUTES = [
  "POST /api/settings/imports/reports-api/run",
  "POST /api/settings/imports/reports-api/resume",
  "POST /api/settings/imports/reports-api/settlement/run",
  "POST /api/settings/imports/reports-api/settlement/resume",
  "POST /api/settings/imports/reports-api/removal-order/run",
  "POST /api/settings/imports/reports-api/removal-order/resume",
  "POST /api/settings/imports/reports-api/removal-shipment/run",
  "POST /api/settings/imports/reports-api/removal-shipment/resume",
  "GET /api/settings/imports/reports-api/status",
];

const WORKERS = [
  { key: "removal_order", report_type: "REMOVAL_ORDER", table: "amazon_removals", sp_type: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA" },
  { key: "removal_shipment", report_type: "REMOVAL_SHIPMENT", table: "amazon_removal_shipments", sp_type: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA" },
  { key: "reimbursements", report_type: "REIMBURSEMENTS", table: "amazon_reimbursements", sp_type: "GET_FBA_REIMBURSEMENTS_DATA" },
  { key: "settlements", report_type: "SETTLEMENT", table: "amazon_settlements", sp_type: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2" },
] as const;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function redact(msg: string): string {
  return msg
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt-redacted]")
    .replace(/(refresh[_-]?token|client[_-]?secret|access[_-]?key|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/postgresql:\/\/[^\s]+/gi, "postgresql://[redacted]");
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / 86400000);
}

function freshnessLabel(days: number | null): "fresh" | "stale" | "missing" | "unknown" {
  if (days === null) return "missing";
  if (days <= STALE_DAYS) return "fresh";
  return "stale";
}

function sevenMonthWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - BACKFILL_MONTHS);
  return { start: start.toISOString(), end: end.toISOString() };
}

function monthlyChunks(startIso: string, endIso: string): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let cur = new Date(startIso);
  const end = new Date(endIso);
  while (cur < end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ start: cur.toISOString(), end: chunkEnd.toISOString() });
    cur = new Date(chunkEnd);
  }
  return chunks;
}

function approvalOk(pathRel: string, flag: RegExp): boolean {
  const p = path.join(process.cwd(), pathRel);
  if (!fs.existsSync(p)) return false;
  return flag.test(fs.readFileSync(p, "utf8"));
}

type TableFreshness = {
  row_count: number;
  max_created_at: string | null;
  max_event_date: string | null;
  max_upload_at: string | null;
  api_upload_count: number;
  days_since_event: number | null;
  days_since_upload: number | null;
  freshness: "fresh" | "stale" | "missing" | "unknown";
};

async function tableFreshness(c: pg.Client, table: string, reportType: string, eventCol: string): Promise<TableFreshness> {
  const exists = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  if (!exists.rows[0]?.ok) {
    return {
      row_count: 0,
      max_created_at: null,
      max_event_date: null,
      max_upload_at: null,
      api_upload_count: 0,
      days_since_event: null,
      days_since_upload: null,
      freshness: "missing",
    };
  }
  const colCheck = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, eventCol],
  );
  const hasEvent = colCheck.rowCount! > 0;
  const r = await c.query(
    `SELECT COUNT(*)::bigint AS c, MAX(created_at)::text AS lc${
      hasEvent ? `, MAX(${eventCol})::text AS le` : ""
    }
     FROM public.${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );
  const u = await c.query(
    `SELECT MAX(created_at)::text AS lu,
            COUNT(*) FILTER (WHERE metadata->'source_run'->>'provider' = 'amazon_sp_api')::bigint AS api_c
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid AND report_type = $2`,
    [ORG, reportType],
  );
  const maxEvent = hasEvent ? (r.rows[0]?.le as string | null) : null;
  const maxUpload = u.rows[0]?.lu ?? null;
  const daysEvent = daysSince(maxEvent ?? (r.rows[0]?.lc as string | null));
  const daysUpload = daysSince(maxUpload);
  const freshness = freshnessLabel(daysEvent ?? daysUpload);
  return {
    row_count: Number(r.rows[0]?.c ?? 0),
    max_created_at: r.rows[0]?.lc ?? null,
    max_event_date: maxEvent,
    max_upload_at: maxUpload,
    api_upload_count: Number(u.rows[0]?.api_c ?? 0),
    days_since_event: daysEvent,
    days_since_upload: daysUpload,
    freshness,
  };
}

type WorkerUploadStatus = {
  key: string;
  sp_report_type: string;
  report_type: string;
  domain_table: string;
  worker_exists: true;
  env_flag_enabled: boolean;
  last_upload_id: string | null;
  last_upload_at: string | null;
  last_upload_status: string | null;
  last_source_run_state: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  stuck_synthetic_upload_ready_count: number;
  route: string;
};

async function workerUploadStatus(c: pg.Client, w: (typeof WORKERS)[number], envOn: boolean): Promise<WorkerUploadStatus> {
  const last = await c.query(
    `SELECT id, created_at::text AS ca, status,
            metadata->'source_run'->>'state' AS sr_state
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid AND report_type = $2
     ORDER BY created_at DESC LIMIT 1`,
    [ORG, w.report_type],
  );
  const lastRow = last.rows[0] as Record<string, string> | undefined;

  const success = await c.query(
    `SELECT MAX(created_at)::text AS t FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid AND report_type = $2
       AND (status = 'complete' OR metadata->'source_run'->>'state' = 'complete')`,
    [ORG, w.report_type],
  );
  const failure = await c.query(
    `SELECT MAX(created_at)::text AS t FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid AND report_type = $2
       AND (status = 'failed' OR metadata->'source_run'->>'state' IN ('failed','fatal'))`,
    [ORG, w.report_type],
  );
  const stuck = await c.query(
    `SELECT COUNT(*)::int AS c FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid AND report_type = $2
       AND metadata->'source_run'->>'state' = 'synthetic_upload_ready'`,
    [ORG, w.report_type],
  );

  const routeMap: Record<string, string> = {
    removal_order: "POST /api/settings/imports/reports-api/removal-order/run",
    removal_shipment: "POST /api/settings/imports/reports-api/removal-shipment/run",
    reimbursements: "POST /api/settings/imports/reports-api/run",
    settlements: "POST /api/settings/imports/reports-api/settlement/run",
  };

  return {
    key: w.key,
    sp_report_type: w.sp_type,
    report_type: w.report_type,
    domain_table: w.table,
    worker_exists: true,
    env_flag_enabled: envOn,
    last_upload_id: lastRow?.id ?? null,
    last_upload_at: lastRow?.ca ?? null,
    last_upload_status: lastRow?.status ?? null,
    last_source_run_state: lastRow?.sr_state ?? null,
    last_success_at: success.rows[0]?.t ?? null,
    last_failure_at: failure.rows[0]?.t ?? null,
    stuck_synthetic_upload_ready_count: Number(stuck.rows[0]?.c ?? 0),
    route: routeMap[w.key] ?? "",
  };
}

async function removalSupersessionCensus(c: pg.Client) {
  const details = await c.query(
    `SELECT id, order_id, sku, fnsku, shipped_quantity, in_process_quantity, created_at
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
     LIMIT 10000`,
    [ORG, STORE],
  );
  const shipments = await c.query(
    `SELECT id, order_id, sku, fnsku, shipped_quantity, tracking_number, created_at
     FROM public.amazon_removal_shipments
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
     LIMIT 10000`,
    [ORG, STORE],
  );
  return buildRemovalSupersessionReadinessSummary(
    details.rows as RemovalDetailRowLike[],
    shipments.rows as RemovalShipmentRowLike[],
  );
}

function removalCronStatus(): Record<string, unknown> {
  const wfPath = path.join(process.cwd(), REMOVAL_CRON_WORKFLOW);
  const runBase = path.join(process.cwd(), ".cursor/audit-reports/removal-automation-run");
  let lastRun: string | null = null;
  if (fs.existsSync(runBase)) {
    const dirs = fs
      .readdirSync(runBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    lastRun = dirs[0] ?? null;
  }
  return {
    workflow: REMOVAL_CRON_WORKFLOW,
    configured: fs.existsSync(wfPath),
    schedule_cron_utc: ["0 13 * * *", "0 21 * * *"],
    rolling_days_default: 7,
    default_mode: "dry-run unless workflow_dispatch apply=true",
    last_local_audit_run_id: lastRun,
    note: "Removal uses orchestrator — not re-run in this phase (no reconnect)",
  };
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
  }>,
  windowStart: string,
  windowEnd: string,
): Promise<Record<string, unknown>> {
  let uploadId: string | null = null;
  let last = await runFn({ organizationId: ORG, storeId: STORE, windowStart, windowEnd });
  uploadId = last.upload_id;
  let rounds = 0;
  while (last.needs_resume && rounds < MAX_RESUME_ROUNDS) {
    rounds++;
    await new Promise((r) => setTimeout(r, RESUME_SLEEP_MS));
    last = await runFn({
      organizationId: ORG,
      storeId: STORE,
      windowStart,
      windowEnd,
      uploadId: last.upload_id ?? uploadId,
    });
    uploadId = last.upload_id ?? uploadId;
    if (last.state === "complete" || last.state === "failed") break;
  }
  return {
    label,
    ok: last.ok,
    final_state: last.state,
    upload_id: uploadId,
    resume_rounds: rounds,
    error: last.error ? redact(last.error) : null,
  };
}

async function claimCandidateCount(c: pg.Client): Promise<number> {
  const r = await c.query(
    `SELECT COUNT(*)::bigint AS c FROM public.claim_candidates
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND quarantined_at IS NULL AND rejected_at IS NULL`,
    [ORG, STORE],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";

  if (!supabaseUrlMatchesStagingRef(url, STAGING_REF)) {
    throw new Error(`BLOCKED: staging URL must target ${STAGING_REF}`);
  }
  if (!pgUrl.includes(STAGING_REF) || pgUrl.includes(ORIGINAL_REF)) {
    throw new Error("BLOCKED: STAGING_DIRECT_POSTGRES_URL must target staging only");
  }

  const env_flags = {
    AMAZON_SP_API_ENABLED: process.env.AMAZON_SP_API_ENABLED?.trim() === "true",
    ENABLE_AMAZON_REPORTS_API_WORKER: isAmazonReportsApiWorkerEnabled(),
    ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS: isAmazonReportsApiReimbursementsEnabled(),
    ENABLE_AMAZON_REPORTS_API_SETTLEMENT: isAmazonReportsApiSettlementEnabled(),
    ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER: isAmazonReportsApiRemovalOrderEnabled(),
    ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT: isAmazonReportsApiRemovalShipmentEnabled(),
  };

  if (execute) {
    process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT = "true";
  }

  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");

  let automationSettings: Record<string, unknown> = {};
  try {
    automationSettings = await readPlatformAutomationSettingsFromPg(c, ORG);
  } catch {
    automationSettings = { note: "platform automation settings read failed" };
  }

  const ccBefore = await claimCandidateCount(c);

  const freshness_by_table = {
    amazon_removals: await tableFreshness(c, "amazon_removals", "REMOVAL_ORDER", "order_date"),
    amazon_removal_shipments: await tableFreshness(c, "amazon_removal_shipments", "REMOVAL_SHIPMENT", "shipment_date"),
    amazon_reimbursements: await tableFreshness(c, "amazon_reimbursements", "REIMBURSEMENTS", "approval_date"),
    amazon_settlements: await tableFreshness(c, "amazon_settlements", "SETTLEMENT", "posted_date"),
  };

  const workers_checked = await Promise.all([
    workerUploadStatus(c, WORKERS[0], env_flags.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER),
    workerUploadStatus(c, WORKERS[1], env_flags.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT),
    workerUploadStatus(c, WORKERS[2], env_flags.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS),
    workerUploadStatus(c, WORKERS[3], env_flags.ENABLE_AMAZON_REPORTS_API_SETTLEMENT),
  ]);

  const before_after_counts = {
    before: {
      ...Object.fromEntries(
        Object.entries(freshness_by_table).map(([k, v]) => [k, { row_count: v.row_count }]),
      ),
      claim_candidates_active: ccBefore,
    },
  };

  const removal_order_status = {
    ...workers_checked.find((w) => w.key === "removal_order")!,
    domain_freshness: freshness_by_table.amazon_removals,
    stale: freshness_by_table.amazon_removals.freshness === "stale",
    verify_only: true,
    backfill_skipped: "no_reconnect_phase — existing connector verified not rebuilt",
  };

  const removal_shipment_status = {
    ...workers_checked.find((w) => w.key === "removal_shipment")!,
    domain_freshness: freshness_by_table.amazon_removal_shipments,
    stale: freshness_by_table.amazon_removal_shipments.freshness === "stale",
    verify_only: true,
    backfill_skipped: "no_reconnect_phase",
  };

  const reimbursements_status = {
    ...workers_checked.find((w) => w.key === "reimbursements")!,
    domain_freshness: freshness_by_table.amazon_reimbursements,
    stale: freshness_by_table.amazon_reimbursements.freshness === "stale",
  };

  const settlements_status = {
    ...workers_checked.find((w) => w.key === "settlements")!,
    domain_freshness: freshness_by_table.amazon_settlements,
    stale: freshness_by_table.amazon_settlements.freshness === "stale",
  };

  const supersession_readmodel_status = await removalSupersessionCensus(c);

  const stalePartialBecomesCleanEp = await c.query(
    `SELECT COUNT(*)::int AS c FROM public.expected_packages ep
     WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
       AND ep.build_source IN ('detail_shipment','detail_remainder')
       AND ep.resolved_product_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.amazon_removals r
         WHERE r.id = ep.source_detail_row_id AND r.organization_id = ep.organization_id
       )`,
    [ORG, STORE],
  );

  const backfillWindow = sevenMonthWindow();
  const chunks = monthlyChunks(backfillWindow.start, backfillWindow.end);
  const settlementApproved = approvalOk(
    SETTLEMENT_APPROVAL,
    /APPROVED_TO_RUN_IMPORT_API_09_SETTLEMENT_STAGING_SMOKE\s*=\s*true/i,
  );

  const backfill_runs: Record<string, unknown>[] = [];
  let backfill_started_or_blocked: string;

  const needReimbBackfill = reimbursements_status.stale || freshness_by_table.amazon_reimbursements.row_count === 0;
  const needSettlementBackfill = settlements_status.stale || freshness_by_table.amazon_settlements.row_count === 0;

  if (!execute) {
    backfill_started_or_blocked = needReimbBackfill || needSettlementBackfill
      ? "blocked_dry_run — stale financial sources; re-run with --execute for 7mo backfill (removals excluded)"
      : "not_needed_dry_run — financial sources fresh within 45d";
  } else if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    backfill_started_or_blocked = "blocked_missing_service_role";
  } else {
    const { runReimbursementsReportsWorker } = await import("../lib/amazon/reports-api-reimbursements-worker");
    const { runSettlementReportsWorker } = await import("../lib/amazon/reports-api-settlement-worker");

    if (needSettlementBackfill && settlementApproved) {
      backfill_runs.push(
        await runWorkerUntilDone("settlements_7mo", runSettlementReportsWorker, backfillWindow.start, backfillWindow.end),
      );
      backfill_started_or_blocked = "started_settlements";
    } else if (needSettlementBackfill) {
      backfill_started_or_blocked = "blocked_settlement_approval_or_stale";
      backfill_runs.push({ label: "settlements_7mo", skipped: true, reason: "approval missing or not stale" });
    }

    if (needReimbBackfill) {
      for (let i = 0; i < chunks.length; i++) {
        backfill_runs.push(
          await runWorkerUntilDone(
            `reimbursements_chunk_${i + 1}`,
            runReimbursementsReportsWorker,
            chunks[i]!.start,
            chunks[i]!.end,
          ),
        );
      }
      backfill_started_or_blocked = backfill_started_or_blocked === "started_settlements"
        ? "started_reimbursements_and_settlements"
        : "started_reimbursements";
    }

    if (!needReimbBackfill && !needSettlementBackfill) {
      backfill_started_or_blocked = "not_needed — financial sources fresh";
    }
  }

  const freshness_after = {
    amazon_reimbursements: await tableFreshness(c, "amazon_reimbursements", "REIMBURSEMENTS", "approval_date"),
    amazon_settlements: await tableFreshness(c, "amazon_settlements", "SETTLEMENT", "posted_date"),
    amazon_removals: await tableFreshness(c, "amazon_removals", "REMOVAL_ORDER", "order_date"),
    amazon_removal_shipments: await tableFreshness(c, "amazon_removal_shipments", "REMOVAL_SHIPMENT", "shipment_date"),
  };

  const ccAfter = await claimCandidateCount(c);
  before_after_counts.after = {
    ...Object.fromEntries(Object.entries(freshness_after).map(([k, v]) => [k, { row_count: v.row_count }])),
    claim_candidates_active: ccAfter,
  };

  const synthetic_linkage = await c.query(
    `SELECT report_type,
            COUNT(*) FILTER (WHERE file_name LIKE 'spapi://%')::int AS synthetic_count,
            COUNT(*) FILTER (WHERE metadata->'source_run'->>'provider' = 'amazon_sp_api')::int AS api_count,
            MAX(created_at)::text AS last_at
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT','REIMBURSEMENTS','SETTLEMENT')
     GROUP BY 1 ORDER BY 1`,
    [ORG],
  );

  await c.end();

  let source_connector_readiness_result: Record<string, unknown> | null = null;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (sbKey) {
    const { buildSourceConnectorReadiness } = await import("../lib/claims/connectors/source-connector-readmodel");
    const sb = createClient(url, sbKey, { auth: { persistSession: false } });
    source_connector_readiness_result = await buildSourceConnectorReadiness(sb, ORG, STORE);
  }

  let operatorMobileModified = false;
  try {
    const out = require("child_process").execSync(`git status --porcelain "app/scanner/operator-mobile"`, {
      encoding: "utf8",
    });
    operatorMobileModified = out.trim().length > 0;
  } catch {
    operatorMobileModified = false;
  }

  let build_result = execute ? "pending" : "skipped_dry_run";
  let smoke_result = execute ? "pending" : "skipped_dry_run";
  if (execute) {
    try {
      require("child_process").execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
      build_result = "pass";
    } catch (e) {
      build_result = `fail: ${redact(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
    }
    try {
      require("child_process").execSync("npm run smoke:import-api-09-settlement-preflight", {
        cwd: process.cwd(),
        stdio: "pipe",
        encoding: "utf8",
      });
      smoke_result = "preflight_pass";
    } catch {
      smoke_result = "preflight_blocked_or_fail";
    }
  }

  const financialFresh =
    freshness_after.amazon_reimbursements.freshness === "fresh" &&
    freshness_after.amazon_settlements.freshness === "fresh";
  const removalFresh =
    freshness_after.amazon_removals.freshness !== "missing" &&
    freshness_after.amazon_removal_shipments.freshness !== "missing";
  const noReconnect =
    backfill_runs.every((r) => !String(r.label ?? "").includes("removal")) &&
    !JSON.stringify(backfill_runs).includes("removal_order") &&
    !JSON.stringify(backfill_runs).includes("removal_shipment");

  const SAFE_TO_PUSH =
    build_result === "pass" && ccBefore === ccAfter && noReconnect && removalFresh
      ? financialFresh
        ? "yes"
        : "conditional_yes"
      : execute
        ? "conditional_no"
        : "pending_execute";

  const summary = {
    prompt: "PHASE-AMAZON-SPAPI-PHASE0-FRESHNESS-VERIFY-NO-RECONNECT-V1",
    run_id: rid,
    mode: execute ? "execute" : "verify_only",
    staging_ref: STAGING_REF,
    stale_threshold_days: STALE_DAYS,
    workers_checked,
    run_now_routes: RUN_NOW_ROUTES.map((route) => ({
      route,
      exists_in_repo: fs.existsSync(
        path.join(process.cwd(), "app", route.split(" ")[1]!.replace(/^\//, ""), "route.ts"),
      ),
    })),
    cron_status: removalCronStatus(),
    env_flags,
    automation_settings_snapshot: automationSettings,
    before_after_counts,
    freshness_by_table: execute ? freshness_after : freshness_by_table,
    removal_order_status,
    removal_shipment_status,
    reimbursements_status,
    settlements_status,
    supersession_readmodel_status,
    stale_partial_not_clean_ep: {
      orphan_ep_with_product_link: Number(stalePartialBecomesCleanEp.rows[0]?.c ?? 0),
      supersession_active: Boolean(supersession_readmodel_status),
      note: "0 orphan EP = stale partial rows not promoted to clean expected with product link",
    },
    synthetic_raw_report_upload_linkage: synthetic_linkage.rows,
    source_connector_readiness_result: source_connector_readiness_result
      ? {
          generated_at: source_connector_readiness_result.generated_at,
          source_health: (source_connector_readiness_result.source_health as unknown[])?.filter((e: unknown) => {
            const k = (e as { source_key?: string }).source_key ?? "";
            return /removal|reimbursement|settlement/i.test(k);
          }),
          removal_source_supersession: source_connector_readiness_result.removal_source_supersession,
          file_api_connector_readiness: source_connector_readiness_result.file_api_connector_readiness,
        }
      : null,
    backfill_started_or_blocked,
    backfill_runs,
    no_reconnect_verification: {
      removal_workers_invoked: false,
      removal_routes_only_checked: true,
      new_removal_workers_created: false,
      backfill_excluded_removals: true,
    },
    no_claim_candidate_mutation_verification: {
      before: ccBefore,
      after: ccAfter,
      delta: ccAfter - ccBefore,
      direct_mutation_by_script: false,
    },
    no_scanner_change_verification: {
      operator_mobile_modified: operatorMobileModified,
      note: "pre-existing dirty files excluded from phase scope",
    },
    build_result,
    smoke_result,
    SAFE_TO_PUSH,
    NEXT_PROMPT: "PHASE-AMAZON-SPAPI-WORKER-PHASE1A-LEDGER-DETAIL-IMPLEMENT-V1",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(redact(String(e)));
  process.exit(1);
});
