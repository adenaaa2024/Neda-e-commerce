/**
 * PHASE-4D-API-RUN-AUDIT-TODAY (read-only)
 *   npx tsx scripts/phase4d-api-run-audit-today-readonly.ts
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

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase4d-api-run-audit-today";

type JobKey =
  | "removal_order"
  | "removal_shipment"
  | "product_enrichment"
  | "reimbursements_api"
  | "settlement_api"
  | "finances_archive_api";

type JobAudit = {
  job: JobKey;
  schedule_enabled: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  runtime_status: string;
  ran_today: boolean;
  success_today: boolean;
  raw_domain_table: string;
  domain_row_count: number | null;
  domain_max_date: string | null;
  data_current_through_today: boolean | null;
  count_before_after_logged: string | null;
  latest_raw_report_uploads: Array<Record<string, unknown>>;
  uploads_today: number;
  audit_log_today: Array<Record<string, unknown>>;
  errors_blockers: string[];
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function utcTodayBounds(): { start: string; end: string; date: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return {
    date,
    start: `${date}T00:00:00.000Z`,
    end: `${date}T23:59:59.999Z`,
  };
}

function isTodayUtc(iso: string | null | undefined, todayDate: string): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) === todayDate;
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function countTable(client: pg.Client, table: string): Promise<number | null> {
  if (!(await tableExists(client, table))) return null;
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.${table} WHERE organization_id=$1::uuid`,
    [ORG],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function latestUploads(
  client: pg.Client,
  reportTypes: string[],
  limit = 3,
): Promise<Array<Record<string, unknown>>> {
  const r = await client.query(
    `SELECT id::text, report_type, status, created_at::text, updated_at::text,
            metadata->>'source_run_id' AS source_run_id,
            metadata->>'window_end' AS window_end,
            metadata->>'window_start' AS window_start
     FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type = ANY($2::text[])
     ORDER BY created_at DESC
     LIMIT $3`,
    [ORG, reportTypes, limit],
  );
  return r.rows as Array<Record<string, unknown>>;
}

async function uploadsTodayCount(
  client: pg.Client,
  reportTypes: string[],
  start: string,
  end: string,
): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS c FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type = ANY($2::text[])
       AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz`,
    [ORG, reportTypes, start, end],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function auditLogToday(
  client: pg.Client,
  automationTypes: string[],
  start: string,
  end: string,
): Promise<Array<Record<string, unknown>>> {
  if (!(await tableExists(client, "platform_automation_audit_log"))) return [];
  const r = await client.query(
    `SELECT id::text, automation_type, action, created_at::text,
            after_json->>'last_run_status' AS run_status,
            after_json->>'last_error' AS last_error,
            after_json->>'skipped' AS skipped,
            metadata->>'source' AS source,
            metadata->>'run_id' AS run_id
     FROM public.platform_automation_audit_log
     WHERE organization_id=$1::uuid
       AND automation_type = ANY($2::text[])
       AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz
     ORDER BY created_at DESC
     LIMIT 20`,
    [ORG, automationTypes, start, end],
  );
  return r.rows as Array<Record<string, unknown>>;
}

async function maxDomainDate(
  client: pg.Client,
  table: string,
  dateCol: string,
): Promise<string | null> {
  if (!(await tableExists(client, table))) return null;
  const r = await client.query(
    `SELECT max(${dateCol})::text AS d FROM public.${table} WHERE organization_id=$1::uuid`,
    [ORG],
  );
  return (r.rows[0] as { d: string | null })?.d ?? null;
}

async function jobsToday(
  client: pg.Client,
  jobType: string,
  start: string,
  end: string,
): Promise<Array<Record<string, unknown>>> {
  if (!(await tableExists(client, "jobs"))) return [];
  const r = await client.query(
    `SELECT id::text, status, created_at::text, started_at::text, completed_at::text,
            last_error, cancel_requested_at::text
     FROM public.jobs
     WHERE organization_id=$1::uuid AND job_type=$2
       AND (created_at >= $3::timestamptz OR started_at >= $3::timestamptz OR completed_at >= $3::timestamptz)
       AND coalesce(completed_at, started_at, created_at) <= $4::timestamptz
     ORDER BY coalesce(completed_at, started_at, created_at) DESC NULLS LAST
     LIMIT 10`,
    [ORG, jobType, start, end],
  );
  return r.rows as Array<Record<string, unknown>>;
}

async function financesRunsToday(
  client: pg.Client,
  start: string,
  end: string,
): Promise<Array<Record<string, unknown>>> {
  if (!(await tableExists(client, "amazon_finances_source_runs"))) return [];
  const r = await client.query(
    `SELECT id::text, state, created_at::text, updated_at::text, window_end::text
     FROM public.amazon_finances_source_runs
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND updated_at >= $3::timestamptz AND updated_at <= $4::timestamptz
     ORDER BY updated_at DESC LIMIT 10`,
    [ORG, STORE, start, end],
  );
  return r.rows as Array<Record<string, unknown>>;
}

function parseCountsFromAudit(auditRows: Array<Record<string, unknown>>): string | null {
  for (const row of auditRows) {
    const after = row.after_json;
    if (after && typeof after === "object") {
      const o = after as Record<string, unknown>;
      if (o.counts_before != null || o.counts_after != null) {
        return JSON.stringify({ counts_before: o.counts_before, counts_after: o.counts_after });
      }
    }
  }
  return null;
}

async function auditRef(label: string, url: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const bounds = utcTodayBounds();
  const ps = await client.query(`SELECT automation_settings FROM platform_settings WHERE id=true LIMIT 1`);
  const settings = readStoreAutomationSettings(ps.rows[0]?.automation_settings, ORG, STORE);
  const now = new Date();

  const removalRt = settings.removal_api_sync.cron_runtime ?? {};
  const removalNext =
    removalRt.next_run_at ??
    (settings.removal_api_sync.enabled
      ? computeRemovalRecentNextRun(settings.removal_api_sync, now)?.toISOString() ?? null
      : null);

  const peNext = settings.product_enrichment.enabled
    ? computeProductEnrichmentNextRun(settings.product_enrichment, now)?.toISOString() ?? null
    : null;

  const reimbRt = settings.reimbursements_api.cron_runtime ?? {};
  const settRt = settings.settlement_api.cron_runtime ?? {};
  const finRt = settings.finances_archive_api.cron_runtime ?? {};

  const removalAuditTypes = ["removal_api_sync", "removal_order", "removal_shipment"];
  const removalAuditToday = await auditLogToday(client, removalAuditTypes, bounds.start, bounds.end);

  // Latest completed enrichment job
  let peLastRun: string | null = null;
  let peLastSuccess: string | null = null;
  let peStatus = "never";
  if (await tableExists(client, "jobs")) {
    const jr = await client.query(
      `SELECT status, started_at::text, completed_at::text, last_error
       FROM public.jobs WHERE organization_id=$1::uuid AND job_type='product_enrichment'
       ORDER BY coalesce(completed_at, started_at, created_at) DESC NULLS LAST LIMIT 1`,
      [ORG],
    );
    const j = jr.rows[0] as { status: string; started_at: string | null; completed_at: string | null; last_error: string | null } | undefined;
    if (j) {
      peLastRun = j.completed_at ?? j.started_at ?? null;
      peLastSuccess = j.status === "completed" ? j.completed_at : null;
      peStatus = j.status;
    }
  }

  const peJobsToday = await jobsToday(client, "product_enrichment", bounds.start, bounds.end);
  const peAuditToday = await auditLogToday(client, ["product_enrichment"], bounds.start, bounds.end);

  const removalOrderMax = await maxDomainDate(client, "amazon_removals", "request_date");
  const removalShipMax = await maxDomainDate(client, "amazon_removal_shipments", "shipment_date");

  const jobs: JobAudit[] = [
    {
      job: "removal_order",
      schedule_enabled: settings.removal_api_sync.enabled,
      last_run_at: removalRt.last_run_at ?? null,
      last_success_at: removalRt.last_success_at ?? null,
      next_run_at: removalNext,
      runtime_status: removalRt.last_run_status ?? "never",
      ran_today: isTodayUtc(removalRt.last_run_at, bounds.date) || removalAuditToday.some((x) => x.action === "cron_run"),
      success_today:
        isTodayUtc(removalRt.last_success_at, bounds.date) ||
        (removalRt.last_run_status === "success" && isTodayUtc(removalRt.last_run_at, bounds.date)),
      raw_domain_table: "amazon_removals",
      domain_row_count: await countTable(client, "amazon_removals"),
      domain_max_date: removalOrderMax,
      data_current_through_today: removalOrderMax ? removalOrderMax.slice(0, 10) >= bounds.date : null,
      count_before_after_logged: parseCountsFromAudit(removalAuditToday as unknown as Array<Record<string, unknown>>),
      latest_raw_report_uploads: await latestUploads(client, ["REMOVAL_ORDER"]),
      uploads_today: await uploadsTodayCount(client, ["REMOVAL_ORDER"], bounds.start, bounds.end),
      audit_log_today: removalAuditToday.filter(
        (x) => x.automation_type === "removal_api_sync" || x.automation_type === "removal_order",
      ),
      errors_blockers: [
        ...(settings.removal_api_sync.enabled ? [] : ["schedule_disabled"]),
        ...(removalRt.last_error ? [String(removalRt.last_error).slice(0, 200)] : []),
      ],
    },
    {
      job: "removal_shipment",
      schedule_enabled: settings.removal_api_sync.enabled,
      last_run_at: removalRt.last_run_at ?? null,
      last_success_at: removalRt.last_success_at ?? null,
      next_run_at: removalNext,
      runtime_status: removalRt.last_run_status ?? "never",
      ran_today: isTodayUtc(removalRt.last_run_at, bounds.date) || removalAuditToday.some((x) => x.action === "cron_run"),
      success_today:
        isTodayUtc(removalRt.last_success_at, bounds.date) ||
        (removalRt.last_run_status === "success" && isTodayUtc(removalRt.last_run_at, bounds.date)),
      raw_domain_table: "amazon_removal_shipments",
      domain_row_count: await countTable(client, "amazon_removal_shipments"),
      domain_max_date: removalShipMax,
      data_current_through_today: removalShipMax ? removalShipMax.slice(0, 10) >= bounds.date : null,
      count_before_after_logged: null,
      latest_raw_report_uploads: await latestUploads(client, ["REMOVAL_SHIPMENT"]),
      uploads_today: await uploadsTodayCount(client, ["REMOVAL_SHIPMENT"], bounds.start, bounds.end),
      audit_log_today: removalAuditToday.filter((x) => x.automation_type === "removal_shipment"),
      errors_blockers: settings.removal_api_sync.enabled ? [] : ["schedule_disabled (shared removal sync)"],
    },
    {
      job: "product_enrichment",
      schedule_enabled: settings.product_enrichment.enabled,
      last_run_at: peLastRun,
      last_success_at: peLastSuccess,
      next_run_at: peNext,
      runtime_status: peStatus,
      ran_today: peJobsToday.length > 0,
      success_today: peJobsToday.some((j) => j.status === "completed"),
      raw_domain_table: "products (catalog enrich)",
      domain_row_count: await countTable(client, "products"),
      domain_max_date: null,
      data_current_through_today: null,
      count_before_after_logged: null,
      latest_raw_report_uploads: [],
      uploads_today: 0,
      audit_log_today: peAuditToday,
      errors_blockers: [
        ...(settings.product_enrichment.enabled ? [] : ["schedule_disabled"]),
        "no SP-API listing pull — catalog enrich job only",
        ...(peJobsToday.length === 0 ? ["no jobs row today"] : []),
      ],
    },
    {
      job: "reimbursements_api",
      schedule_enabled: settings.reimbursements_api.enabled,
      last_run_at: reimbRt.last_run_at ?? null,
      last_success_at: reimbRt.last_success_at ?? null,
      next_run_at:
        reimbRt.next_run_at ??
        (settings.reimbursements_api.enabled
          ? computeApiCardNextRun(settings.reimbursements_api, now)?.toISOString() ?? null
          : null),
      runtime_status: reimbRt.last_run_status ?? "never",
      ran_today:
        isTodayUtc(reimbRt.last_run_at, bounds.date) ||
        (await auditLogToday(client, ["reimbursements_api"], bounds.start, bounds.end)).length > 0,
      success_today: isTodayUtc(reimbRt.last_success_at, bounds.date),
      raw_domain_table: "amazon_reimbursements",
      domain_row_count: await countTable(client, "amazon_reimbursements"),
      domain_max_date: await maxDomainDate(client, "amazon_reimbursements", "approval_date"),
      data_current_through_today: null,
      count_before_after_logged: null,
      latest_raw_report_uploads: await latestUploads(client, ["REIMBURSEMENTS", "reimbursements"]),
      uploads_today: await uploadsTodayCount(client, ["REIMBURSEMENTS", "reimbursements"], bounds.start, bounds.end),
      audit_log_today: await auditLogToday(client, ["reimbursements_api"], bounds.start, bounds.end),
      errors_blockers: settings.reimbursements_api.enabled ? [] : ["schedule_disabled"],
    },
    {
      job: "settlement_api",
      schedule_enabled: settings.settlement_api.enabled,
      last_run_at: settRt.last_run_at ?? null,
      last_success_at: settRt.last_success_at ?? null,
      next_run_at:
        settRt.next_run_at ??
        (settings.settlement_api.enabled
          ? computeApiCardNextRun(settings.settlement_api, now)?.toISOString() ?? null
          : null),
      runtime_status: settRt.last_run_status ?? "never",
      ran_today:
        isTodayUtc(settRt.last_run_at, bounds.date) ||
        (await auditLogToday(client, ["settlement_api"], bounds.start, bounds.end)).length > 0,
      success_today: isTodayUtc(settRt.last_success_at, bounds.date),
      raw_domain_table: "amazon_settlements",
      domain_row_count: await countTable(client, "amazon_settlements"),
      domain_max_date: await maxDomainDate(client, "amazon_settlements", "settlement_end_date"),
      data_current_through_today: null,
      count_before_after_logged: null,
      latest_raw_report_uploads: await latestUploads(client, ["SETTLEMENT", "settlement_repository"]),
      uploads_today: await uploadsTodayCount(client, ["SETTLEMENT", "settlement_repository"], bounds.start, bounds.end),
      audit_log_today: await auditLogToday(client, ["settlement_api"], bounds.start, bounds.end),
      errors_blockers: settings.settlement_api.enabled ? [] : ["schedule_disabled"],
    },
    {
      job: "finances_archive_api",
      schedule_enabled: settings.finances_archive_api.enabled,
      last_run_at: finRt.last_run_at ?? null,
      last_success_at: finRt.last_success_at ?? null,
      next_run_at:
        finRt.next_run_at ??
        (settings.finances_archive_api.enabled
          ? computeApiCardNextRun(settings.finances_archive_api, now)?.toISOString() ?? null
          : null),
      runtime_status: finRt.last_run_status ?? "never",
      ran_today:
        isTodayUtc(finRt.last_run_at, bounds.date) ||
        (await financesRunsToday(client, bounds.start, bounds.end)).length > 0,
      success_today: isTodayUtc(finRt.last_success_at, bounds.date),
      raw_domain_table: "amazon_finances_source_runs + amazon_transactions",
      domain_row_count: await countTable(client, "amazon_transactions"),
      domain_max_date: await maxDomainDate(client, "amazon_transactions", "posted_date"),
      data_current_through_today: null,
      count_before_after_logged: null,
      latest_raw_report_uploads: await latestUploads(client, ["TRANSACTIONS", "transaction_view"]),
      uploads_today: await uploadsTodayCount(client, ["TRANSACTIONS", "transaction_view"], bounds.start, bounds.end),
      audit_log_today: await auditLogToday(client, ["finances_archive_api"], bounds.start, bounds.end),
      errors_blockers: settings.finances_archive_api.enabled ? [] : ["schedule_disabled"],
    },
  ];

  // Enrich removal audit with orchestrator manifest counts if any audit today
  const orchManifestDirs = [
    path.join(process.cwd(), ".cursor/audit-reports/removal-automation-run"),
    path.join(process.cwd(), ".cursor/audit-reports/platform-automation-api-cards-run"),
  ];
  const localManifestHints: Record<string, unknown> = {};
  for (const base of orchManifestDirs) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs.readdirSync(base).sort().reverse();
    for (const d of dirs.slice(0, 3)) {
      const mp = path.join(base, d, "manifest.json");
      if (fs.existsSync(mp)) {
        try {
          const m = JSON.parse(fs.readFileSync(mp, "utf8"));
          if (String(m.run_id ?? d).slice(0, 10) === bounds.date.replace(/-/g, "").slice(0, 8) ||
              String(m.run_id ?? "").includes(bounds.date.replace(/-/g, ""))) {
            localManifestHints[base] = { run_id: m.run_id, counts: m.counts_after ?? m.card_results ?? m.safe_to_continue };
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  await client.end();

  const jobsRanToday = jobs.filter((j) => j.ran_today).map((j) => j.job);
  const jobsDidNotRun = jobs.filter((j) => !j.ran_today).map((j) => j.job);

  return {
    label,
    ref: label === "original" ? ORIGINAL_REF : STAGING_REF,
    audit_utc_date: bounds.date,
    audited_at_utc: new Date().toISOString(),
    api_run_status_table: jobs,
    jobs_ran_today: jobsRanToday,
    jobs_did_not_run: jobsDidNotRun,
    last_success_by_job: Object.fromEntries(jobs.map((j) => [j.job, j.last_success_at])),
    next_run_by_job: Object.fromEntries(jobs.map((j) => [j.job, j.next_run_at])),
    data_current_through_date: {
      removal_order_max: removalOrderMax,
      removal_shipment_max: removalShipMax,
      note: "data_current_through_today true only when domain max date >= audit UTC date",
    },
    local_orchestrator_manifest_hints: localManifestHints,
    removal_cron_runtime: removalRt,
    product_enrichment_jobs_today: peJobsToday,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const origUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!origUrl.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL guard failed");

  console.error("Auditing original/production…");
  const original = await auditRef("original", origUrl);
  console.error("Auditing staging…");
  const staging = stagUrl.includes(STAGING_REF) ? await auditRef("staging", stagUrl) : null;

  const origJobs = original.api_run_status_table as JobAudit[];
  const stagJobs = (staging?.api_run_status_table as JobAudit[]) ?? [];

  const allDisabled =
    origJobs.every((j) => !j.schedule_enabled) && stagJobs.every((j) => !j.schedule_enabled);
  const anyRanToday = [...origJobs, ...stagJobs].some((j) => j.ran_today);
  const removalDataCurrent = origJobs.find((j) => j.job === "removal_shipment")?.data_current_through_today;

  const errors: string[] = [];
  for (const j of origJobs) {
    if (j.schedule_enabled && !j.ran_today) errors.push(`original/${j.job}: enabled but no run today`);
    if (j.errors_blockers.length) errors.push(`original/${j.job}: ${j.errors_blockers.join("; ")}`);
  }
  for (const j of stagJobs) {
    if (j.schedule_enabled && !j.ran_today) errors.push(`staging/${j.job}: enabled but no run today`);
  }

  const result = {
    phase_number: "4D",
    audit_utc_date: utcTodayBounds().date,
    api_run_status_table: {
      original: origJobs,
      staging: stagJobs,
    },
    jobs_ran_today: {
      original: original.jobs_ran_today,
      staging: staging?.jobs_ran_today ?? [],
    },
    jobs_did_not_run: {
      original: original.jobs_did_not_run,
      staging: staging?.jobs_did_not_run ?? [],
    },
    last_success_by_job: {
      original: original.last_success_by_job,
      staging: staging?.last_success_by_job ?? {},
    },
    next_run_by_job: {
      original: original.next_run_by_job,
      staging: staging?.next_run_by_job ?? {},
    },
    data_current_through_date: {
      original: original.data_current_through_date,
      staging: staging?.data_current_through_date ?? null,
    },
    errors,
    SAFE_TO_ENABLE_OR_RUN_MANUAL_NOW:
      allDisabled && !anyRanToday
        ? "yes_for_manual_dry_run_only"
        : removalDataCurrent
          ? "yes_for_manual_catchup_if_needed"
          : "conditional",
    next_execute_prompt:
      allDisabled
        ? "PHASE-4D-MANUAL-REMOVAL-CATCHUP-STAGING — workflow_dispatch dry-run then single apply if removal data stale"
        : "PHASE-4C-API-CARDS-STAGING-APPLY-SMOKE — enable one API card schedule + force-due apply on staging",
    original,
    staging,
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
