/**
 * AUDIT-TODAY-AUTOMATION-API-RUNS (read-only)
 *   npx tsx scripts/audit-today-automation-api-runs-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { readStoreAutomationSettings } from "../lib/platform-automation-scope-storage";
import {
  computeApiCardNextRun,
  computeProductEnrichmentNextRun,
  computeRemovalRecentNextRun,
} from "../lib/platform-automation-schedule";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/audit-today-automation-api-runs";

type CardKey =
  | "removal_shipment_sync"
  | "product_data_update"
  | "reimbursements_api"
  | "settlement_api"
  | "finances_archive_api";

type CardAudit = {
  card: CardKey;
  label: string;
  enabled: boolean;
  scheduled: boolean;
  last_run_at: string | null;
  last_status: string;
  updated_today_count: number;
  updated_today_detail: string;
  next_run_at: string | null;
  source_tables_logs: string[];
  ran_today: boolean;
  success_today: boolean;
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function utcToday(): { date: string; start: string; end: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return { date, start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.999Z` };
}

function isTodayUtc(iso: string | null | undefined, date: string): boolean {
  return Boolean(iso && iso.slice(0, 10) === date);
}

async function tableExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function uploadsToday(
  c: pg.Client,
  types: string[],
  start: string,
  end: string,
): Promise<number> {
  const r = await c.query(
    `SELECT count(*)::int AS c FROM raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type = ANY($2::text[])
       AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz`,
    [ORG, types, start, end],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function auditLogTodayCount(
  c: pg.Client,
  types: string[],
  start: string,
  end: string,
): Promise<number> {
  if (!(await tableExists(c, "platform_automation_audit_log"))) return 0;
  const r = await c.query(
    `SELECT count(*)::int AS c FROM platform_automation_audit_log
     WHERE organization_id=$1::uuid AND automation_type = ANY($2::text[])
       AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz`,
    [ORG, types, start, end],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function bgJobsToday(
  c: pg.Client,
  jobType: string,
  start: string,
  end: string,
): Promise<number> {
  if (!(await tableExists(c, "background_jobs"))) return 0;
  const r = await c.query(
    `SELECT count(*)::int AS c FROM background_jobs
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND job_type=$3
       AND created_at >= $4::timestamptz AND created_at <= $5::timestamptz`,
    [ORG, STORE, jobType, start, end],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function financesRunsToday(c: pg.Client, start: string, end: string): Promise<number> {
  if (!(await tableExists(c, "amazon_finances_source_runs"))) return 0;
  const r = await c.query(
    `SELECT count(*)::int AS c FROM amazon_finances_source_runs
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND updated_at >= $3::timestamptz AND updated_at <= $4::timestamptz`,
    [ORG, STORE, start, end],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function latestPeJob(c: pg.Client): Promise<{
  last_run_at: string | null;
  last_status: string;
}> {
  if (await tableExists(c, "background_jobs")) {
    const r = await c.query(
      `SELECT status, finished_at::text, started_at::text, created_at::text
       FROM background_jobs
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND job_type='product_enrichment'
       ORDER BY created_at DESC LIMIT 1`,
      [ORG, STORE],
    );
    const row = r.rows[0] as { status: string; finished_at: string | null; started_at: string | null; created_at: string | null } | undefined;
    if (row) {
      return {
        last_run_at: row.finished_at ?? row.started_at ?? row.created_at,
        last_status: row.status,
      };
    }
  }
  return { last_run_at: null, last_status: "never" };
}

function auditUiStatic(): {
  ui_status_mismatches: string[];
  ui_audit_notes: string[];
} {
  const mismatches: string[] = [];
  const notes: string[] = [];

  // AutomationSavedStatusSummary always renders Removal block regardless of apiReportType
  mismatches.push(
    "Saved automation status summary always shows Removal/Shipment last+next run even when Automation type = Product Data Update (AutomationApiCenterClient.tsx → AutomationSavedStatusSummary)",
  );
  mismatches.push(
    "Saved automation status does not filter/highlight the selected automation type — only shows On/Off list for other cards without their last/next run",
  );

  notes.push(
    "Product Data Update card header (h2) is clean — no removal status in card title; mismatch is in shared Saved automation status panel above all cards",
  );
  notes.push(
    "Per-card RuntimeStatsFromView uses scoped runtime (product_enrichment, removal recent, reimbursements_api, etc.) — card-level last/next is wired correctly",
  );

  return { ui_status_mismatches: mismatches, ui_audit_notes: notes };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL missing");

  const bounds = utcToday();
  const now = new Date();
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const ps = await c.query(`SELECT automation_settings, updated_at::text FROM platform_settings WHERE id=true`);
  const settings = readStoreAutomationSettings(ps.rows[0]?.automation_settings, ORG, STORE);

  const removalRt = settings.removal_api_sync.cron_runtime ?? {};
  const removalNext =
    removalRt.next_run_at ??
    (settings.removal_api_sync.enabled
      ? computeRemovalRecentNextRun(settings.removal_api_sync, now)?.toISOString() ?? null
      : null);

  const peJob = await latestPeJob(c);
  const peNext = settings.product_enrichment.enabled
    ? computeProductEnrichmentNextRun(settings.product_enrichment, now)?.toISOString() ?? null
    : null;

  const reimbRt = settings.reimbursements_api.cron_runtime ?? {};
  const settRt = settings.settlement_api.cron_runtime ?? {};
  const finRt = settings.finances_archive_api.cron_runtime ?? {};

  const removalUploadsToday = await uploadsToday(c, ["REMOVAL_ORDER", "REMOVAL_SHIPMENT"], bounds.start, bounds.end);
  const removalAuditToday = await auditLogTodayCount(
    c,
    ["removal_api_sync", "removal_order", "removal_shipment"],
    bounds.start,
    bounds.end,
  );

  const peJobsToday = await bgJobsToday(c, "product_enrichment", bounds.start, bounds.end);
  const reimbUploadsToday = await uploadsToday(c, ["REIMBURSEMENTS", "reimbursements"], bounds.start, bounds.end);
  const settUploadsToday = await uploadsToday(c, ["SETTLEMENT", "settlement_repository"], bounds.start, bounds.end);
  const finUploadsToday = await uploadsToday(c, ["TRANSACTIONS", "transaction_view"], bounds.start, bounds.end);
  const finRunsToday = await financesRunsToday(c, bounds.start, bounds.end);

  const cards: CardAudit[] = [
    {
      card: "removal_shipment_sync",
      label: "Removal / Shipment Sync",
      enabled: settings.removal_api_sync.enabled,
      scheduled: settings.removal_api_sync.enabled,
      last_run_at: removalRt.last_run_at ?? null,
      last_status: removalRt.last_run_status ?? "never",
      updated_today_count: removalUploadsToday,
      updated_today_detail: `${removalUploadsToday} raw_report_uploads (REMOVAL_ORDER+REMOVAL_SHIPMENT); ${removalAuditToday} audit rows`,
      next_run_at: removalNext,
      source_tables_logs: [
        "platform_settings.automation_settings.scopes → removal_api_sync.cron_runtime",
        "platform_automation_audit_log",
        "raw_report_uploads",
      ],
      ran_today:
        isTodayUtc(removalRt.last_run_at, bounds.date) ||
        removalUploadsToday > 0 ||
        removalAuditToday > 0,
      success_today:
        isTodayUtc(removalRt.last_success_at, bounds.date) ||
        (removalRt.last_run_status === "success" && isTodayUtc(removalRt.last_run_at, bounds.date)),
    },
    {
      card: "product_data_update",
      label: "Product Data Update",
      enabled: settings.product_enrichment.enabled,
      scheduled: settings.product_enrichment.enabled,
      last_run_at: peJob.last_run_at,
      last_status: peJob.last_status,
      updated_today_count: peJobsToday,
      updated_today_detail: `${peJobsToday} background_jobs (product_enrichment) today`,
      next_run_at: peNext,
      source_tables_logs: ["background_jobs", "platform_automation_audit_log (product_enrichment)"],
      ran_today: peJobsToday > 0 || isTodayUtc(peJob.last_run_at, bounds.date),
      success_today: peJobsToday > 0 && peJob.last_status === "completed",
    },
    {
      card: "reimbursements_api",
      label: "Reimbursements API",
      enabled: settings.reimbursements_api.enabled,
      scheduled: settings.reimbursements_api.enabled,
      last_run_at: reimbRt.last_run_at ?? null,
      last_status: reimbRt.last_run_status ?? "never",
      updated_today_count: reimbUploadsToday,
      updated_today_detail: `${reimbUploadsToday} raw_report_uploads (REIMBURSEMENTS)`,
      next_run_at:
        reimbRt.next_run_at ??
        (settings.reimbursements_api.enabled
          ? computeApiCardNextRun(settings.reimbursements_api, now)?.toISOString() ?? null
          : null),
      source_tables_logs: [
        "platform_settings → reimbursements_api.cron_runtime",
        "raw_report_uploads",
        "platform_automation_audit_log",
      ],
      ran_today:
        isTodayUtc(reimbRt.last_run_at, bounds.date) ||
        reimbUploadsToday > 0 ||
        (await auditLogTodayCount(c, ["reimbursements_api"], bounds.start, bounds.end)) > 0,
      success_today: isTodayUtc(reimbRt.last_success_at, bounds.date),
    },
    {
      card: "settlement_api",
      label: "Settlement API",
      enabled: settings.settlement_api.enabled,
      scheduled: settings.settlement_api.enabled,
      last_run_at: settRt.last_run_at ?? null,
      last_status: settRt.last_run_status ?? "never",
      updated_today_count: settUploadsToday,
      updated_today_detail: `${settUploadsToday} raw_report_uploads (SETTLEMENT)`,
      next_run_at:
        settRt.next_run_at ??
        (settings.settlement_api.enabled
          ? computeApiCardNextRun(settings.settlement_api, now)?.toISOString() ?? null
          : null),
      source_tables_logs: [
        "platform_settings → settlement_api.cron_runtime",
        "raw_report_uploads",
        "platform_automation_audit_log",
      ],
      ran_today:
        isTodayUtc(settRt.last_run_at, bounds.date) ||
        settUploadsToday > 0 ||
        (await auditLogTodayCount(c, ["settlement_api"], bounds.start, bounds.end)) > 0,
      success_today: isTodayUtc(settRt.last_success_at, bounds.date),
    },
    {
      card: "finances_archive_api",
      label: "Finances archive API",
      enabled: settings.finances_archive_api.enabled,
      scheduled: settings.finances_archive_api.enabled,
      last_run_at: finRt.last_run_at ?? null,
      last_status: finRt.last_run_status ?? "never",
      updated_today_count: finUploadsToday + finRunsToday,
      updated_today_detail: `${finUploadsToday} raw_report_uploads + ${finRunsToday} amazon_finances_source_runs`,
      next_run_at:
        finRt.next_run_at ??
        (settings.finances_archive_api.enabled
          ? computeApiCardNextRun(settings.finances_archive_api, now)?.toISOString() ?? null
          : null),
      source_tables_logs: [
        "platform_settings → finances_archive_api.cron_runtime",
        "amazon_finances_source_runs",
        "raw_report_uploads",
        "platform_automation_audit_log",
      ],
      ran_today:
        isTodayUtc(finRt.last_run_at, bounds.date) || finRunsToday > 0 || finUploadsToday > 0,
      success_today: isTodayUtc(finRt.last_success_at, bounds.date),
    },
  ];

  await c.end();

  const ui = auditUiStatic();
  const updatedTodayCounts = Object.fromEntries(cards.map((x) => [x.card, x.updated_today_count]));

  const fixPrompt =
    ui.ui_status_mismatches.length > 0
      ? "PHASE-AUTOMATION-UI-SAVED-STATUS-SCOPE-FIX — filter AutomationSavedStatusSummary by selected apiReportType; show per-card last/next for active type only; keep removal summary only on removal_shipment tab"
      : null;

  const result = {
    audit: "AUDIT-TODAY-AUTOMATION-API-RUNS",
    mode: "read_only",
    scope: { organization_id: ORG, store_id: STORE, database: "original" },
    audit_utc_date: bounds.date,
    audited_at_utc: new Date().toISOString(),
    today_api_runs: cards.map((x) => ({
      ...x,
      enabled: x.enabled ? "yes" : "no",
      scheduled: x.scheduled ? "yes" : "no",
      ui_card_mismatch: ui.ui_status_mismatches.some((m) =>
        x.card === "product_data_update"
          ? m.includes("Product Data Update") || m.includes("Saved automation")
          : false,
      )
        ? "yes"
        : x.card === "removal_shipment_sync"
          ? "no"
          : "no",
    })),
    updated_today_counts: updatedTodayCounts,
    ui_status_mismatches: ui.ui_status_mismatches,
    ui_audit_notes: ui.ui_audit_notes,
    fix_prompt_if_needed: fixPrompt,
  };

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
