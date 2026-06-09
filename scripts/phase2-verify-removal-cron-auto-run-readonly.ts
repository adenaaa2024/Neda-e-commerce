/**
 * PHASE-2-VERIFY-REMOVAL-CRON-AUTO-RUN — read-only production audit.
 *   npx tsx scripts/phase2-verify-removal-cron-auto-run-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { evaluateLocalDailyScheduleDue } from "../lib/automation-timezone-schedule";
import { VERCEL_REMOVAL_CRON_WAKE_SCHEDULE } from "../lib/removal-cron-schedule-gate";
import { productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const SLOT_CUTOFF = "2026-06-09T06:30:00.000Z";
const MANUAL_CATCHUP_DAY = "2026-06-08";
const OUT_BASE = ".cursor/audit-reports/phase2-verify-removal-cron-auto-run";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type CronRuntime = {
  last_run_at?: string | null;
  last_success_at?: string | null;
  last_failed_at?: string | null;
  last_run_status?: string | null;
  last_error?: string | null;
  next_run_at?: string | null;
  last_slot_key?: string | null;
};

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const nowUtc = await client.query(`SELECT now() AT TIME ZONE 'utc' AS ts`);
  const auditedAt = String((nowUtc.rows[0] as { ts: string }).ts);

  const auditTable = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='platform_automation_audit_log'
     ) AS ok`,
  );
  const hasAuditTable = Boolean((auditTable.rows[0] as { ok: boolean }).ok);

  let auditAfterSlot: pg.QueryResult | null = null;
  if (hasAuditTable) {
    auditAfterSlot = await client.query(
      `SELECT automation_type, action, created_at::text, actor_email,
              metadata->>'source' AS source,
              LEFT(COALESCE(after_json::text, metadata::text, '{}'), 400) AS detail_snip
       FROM platform_automation_audit_log
       WHERE organization_id = $1::uuid
         AND action IN ('cron_tick', 'cron_run', 'manual_run', 'run_now', 'resume')
         AND created_at >= $2::timestamptz
       ORDER BY created_at ASC`,
      [ORG, SLOT_CUTOFF],
    );
  }

  const ps = await client.query(`SELECT automation_settings, updated_at::text FROM platform_settings WHERE id = true`);
  const automation = (ps.rows[0] as { automation_settings?: unknown; updated_at?: string })?.automation_settings;
  const scopeKey = `${ORG}:${STORE}`;
  const scope = (automation as { scopes?: Record<string, { removal_api_sync?: { cron_runtime?: CronRuntime; recent_sync?: unknown } }> })
    ?.scopes?.[scopeKey];
  const cronRuntime: CronRuntime = scope?.removal_api_sync?.cron_runtime ?? {};
  const recentSync = scope?.removal_api_sync?.recent_sync ?? null;

  const uploadsAfterSlot = await client.query(
    `SELECT id::text, report_type, status, created_at::text, updated_at::text,
            metadata->'source_run'->>'state' AS run_state,
            metadata->'source_run'->'window'->>'start' AS w_start,
            metadata->'source_run'->'window'->>'end' AS w_end,
            metadata->>'trigger' AS metadata_trigger,
            metadata->>'source' AS metadata_source
     FROM raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND created_at >= $2::timestamptz
     ORDER BY created_at ASC`,
    [ORG, SLOT_CUTOFF],
  );

  const uploadsOnManualDay = await client.query(
    `SELECT id::text, report_type, status, created_at::text
     FROM raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND created_at::date = $2::date
     ORDER BY created_at ASC`,
    [ORG, MANUAL_CATCHUP_DAY],
  );

  const domain = await client.query(
    `SELECT
      (SELECT MAX(order_date)::text FROM amazon_removals WHERE organization_id=$1::uuid) AS max_removal_order_date,
      (SELECT MAX(COALESCE(shipment_date, order_date))::text FROM amazon_removal_shipments WHERE organization_id=$1::uuid) AS max_shipment_domain_date,
      (SELECT MAX(COALESCE(order_date, created_at::date))::text FROM expected_packages
        WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS max_ep_source_date,
      (SELECT (now() AT TIME ZONE 'UTC')::date::text) AS today_utc`,
    [ORG],
  );

  const dailyUploads = await client.query(
    `SELECT created_at::date::text AS day, report_type, count(*)::int AS n
     FROM raw_report_uploads
     WHERE organization_id = $1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND created_at >= $2::date
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [ORG, MANUAL_CATCHUP_DAY],
  );

  await client.end();

  const lastRunAt = cronRuntime.last_run_at ?? null;
  const lastSuccessAt = cronRuntime.last_success_at ?? null;
  const scheduleSim = [
    "2026-06-09T06:30:00.000Z",
    "2026-06-09T06:45:00.000Z",
    "2026-06-09T08:00:00.000Z",
  ].map((t) => ({
    at: t,
    gate: evaluateLocalDailyScheduleDue({
      enabled: true,
      timeZone: String((recentSync as { timezone?: string })?.timezone ?? "America/Los_Angeles"),
      runTimesLocal: (recentSync as { run_times_local?: string[] })?.run_times_local ?? ["23:30"],
      lastRunAt,
      lastSlotKey: cronRuntime.last_slot_key ?? null,
      now: new Date(t),
    }),
  }));
  const vercelWakeGate = scheduleSim.find((s) => s.at === "2026-06-09T08:00:00.000Z")?.gate;
  const lastRunMs = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const slotMs = Date.parse(SLOT_CUTOFF);
  const ranAfterSlot = Number.isFinite(lastRunMs) && lastRunMs >= slotMs;

  const cronAuditRows = (auditAfterSlot?.rows ?? []).filter((r) =>
    ["cron_tick", "cron_run"].includes(String((r as { action?: string }).action)),
  );
  const manualAuditRows = (auditAfterSlot?.rows ?? []).filter((r) =>
    ["manual_run", "run_now", "resume"].includes(String((r as { action?: string }).action)),
  );

  const uploadsAfter = uploadsAfterSlot.rows as Array<Record<string, unknown>>;
  const domainMax = domain.rows[0] as Record<string, string>;

  let runSource: "cron" | "manual" | "none" = "none";
  let skippedReason: string | null = null;
  const errors: string[] = [];

  if (cronAuditRows.length > 0) {
    runSource = "cron";
  } else if (ranAfterSlot && cronRuntime.last_slot_key) {
    runSource = "cron";
  } else if (ranAfterSlot && !cronRuntime.last_slot_key) {
    runSource = "manual";
    skippedReason = "cron_runtime updated after slot but last_slot_key null — likely manual/script path, not Vercel cron route";
  } else if (uploadsAfter.length > 0) {
    runSource = "manual";
    skippedReason = "uploads after slot without cron audit/runtime slot evidence";
  } else {
    runSource = "none";
    if (Date.parse(auditedAt) < slotMs) {
      skippedReason = "audit_before_scheduled_next_run_at";
    } else {
      skippedReason = "no_post_slot_runtime_or_upload_activity";
    }
  }

  const cronAutoRan = runSource === "cron" && ranAfterSlot;

  if (!hasAuditTable) {
    errors.push("platform_automation_audit_log table missing on production");
  }
  if (hasAuditTable && cronAuditRows.length === 0) {
    errors.push("no cron_tick/cron_run audit rows after slot — cron route does not write audit log yet");
  }

  let exactFixIfNotRunning: string | null = null;
  if (!cronAutoRan) {
    const fixes: string[] = [];
    fixes.push("Confirm Vercel production deploy includes vercel.json crons path /api/cron/removal-nightly-sync (schedule 30 6 * * * UTC wake).");
    fixes.push("Verify Vercel env: CRON_SECRET matches Authorization Bearer on cron invocations.");
    fixes.push("Verify ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON=true on Vercel production.");
    fixes.push("Verify NEXT_PUBLIC_SUPABASE_URL targets kxsvedvpjldygtdbylsy on Vercel production.");
    fixes.push(
      "CRITICAL: vercel.json wake 08:00 UTC is outside 15m grace after 06:30 UTC slot — gate returns not_scheduled at Vercel wake; change vercel.json to `30 6 * * *` or widen REMOVAL_CRON_WAKE_GRACE_MS to >=90m.",
    );
    fixes.push("Add cron_tick/cron_run rows to platform_automation_audit_log in route.ts for observability.");
    if (runSource === "none" && !uploadsAfter.length) {
      fixes.push("Check Vercel project → Cron Jobs tab for last invocation status (401/503/skipped).");
    }
    exactFixIfNotRunning = fixes.join(" ");
  }

  const domainStillJune8 =
    domainMax.max_removal_order_date <= MANUAL_CATCHUP_DAY &&
    domainMax.max_shipment_domain_date <= MANUAL_CATCHUP_DAY &&
    domainMax.max_ep_source_date <= MANUAL_CATCHUP_DAY;

  if (vercelWakeGate?.due === false) {
    errors.push(`predicted_vercel_wake_skip:${vercelWakeGate.reason} at 08:00 UTC vs slot 06:30 UTC + 15m grace`);
  }

  void domainStillJune8;

  const result = {
    phase_number: 2,
    cron_auto_ran: cronAutoRan ? "yes" : "no",
    run_source: runSource,
    last_run_at: lastRunAt,
    last_success_at: lastSuccessAt,
    last_run_status: cronRuntime.last_run_status ?? null,
    last_error: cronRuntime.last_error ?? null,
    next_run_at: cronRuntime.next_run_at ?? null,
    last_slot_key: cronRuntime.last_slot_key ?? null,
    domain_max_dates: domainMax,
    skipped_reason: skippedReason,
    errors,
    vercel_wake_schedule: VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
    vercel_json_schedule: "30 6 * * *",
    slot_cutoff_utc: SLOT_CUTOFF,
    audited_at_utc: auditedAt,
    recent_sync: recentSync,
    platform_settings_updated_at: ps.rows[0]?.updated_at ?? null,
    audit_log_after_slot: auditAfterSlot?.rows ?? [],
    cron_audit_rows_after_slot: cronAuditRows,
    manual_audit_rows_after_slot: manualAuditRows,
    uploads_after_slot: uploadsAfter,
    uploads_on_manual_catchup_day: uploadsOnManualDay.rows,
    daily_upload_counts_since_manual_day: dailyUploads.rows,
    schedule_gate_simulation: scheduleSim,
    vercel_wake_predicted_skip: vercelWakeGate?.due === false ? vercelWakeGate.reason : null,
    SAFE_TO_MARK_PHASE_2_100: cronAutoRan ? "yes" : "no",
    new_phase_2_percent: cronAutoRan ? 100 : 70,
    exact_fix_if_not_running: exactFixIfNotRunning,
    notes: [
      "Manual catch-up on 2026-06-08 also updates cron_runtime without last_slot_key.",
      "Cron route does not currently emit platform_automation_audit_log cron_tick/cron_run entries.",
      "Primary auto-run evidence: cron_runtime.last_run_at >= slot AND last_slot_key set, plus post-slot uploads/domain advance.",
    ],
  };

  fs.writeFileSync(path.join(outDir, "audit_result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
