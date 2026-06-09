/**
 * PHASE-4E-PRODUCTION-API-CATCHUP-AND-CRON-MISS-FIX
 *
 *   npx tsx scripts/phase4e-production-api-catchup-and-cron-miss-fix.ts
 *   npx tsx scripts/phase4e-production-api-catchup-and-cron-miss-fix.ts --apply-removal --apply-enrichment
 */
import { createRequire, type Module } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { evaluateRemovalCronGate, VERCEL_REMOVAL_CRON_WAKE_SCHEDULE } from "../lib/removal-cron-schedule-gate";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  PRODUCTION_ORG_ID,
  PRODUCTION_STORE_ID,
  queryDomainMaxDates,
  runProductionRemovalSync,
  syncWindowThroughToday,
} from "../lib/production-removal-sync-run";
import { loadProductionRemovalAutomationSettings } from "../lib/removal-cron-schedule-gate";
import { persistRemovalCronRuntime } from "../lib/removal-cron-runtime-storage";
import { auditRemovalCronEvent } from "../lib/platform-automation-manual-run-audit";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const ORG = PRODUCTION_ORG_ID;
const STORE = PRODUCTION_STORE_ID;
const OUT_BASE = ".cursor/audit-reports/phase4e-production-api-catchup";
const MISSED_SLOT = "2026-06-09T06:30:00.000Z";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function utcToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

async function investigateCronMiss(): Promise<Record<string, unknown>> {
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const slotTime = new Date(MISSED_SLOT);
  const { scope, cron_runtime } = await loadProductionRemovalAutomationSettings();

  const gateAtSlot = evaluateRemovalCronGate({ scope, cron_runtime, now: new Date("2026-06-09T06:35:00.000Z") });
  const gateNow = evaluateRemovalCronGate({ scope, cron_runtime, now: new Date() });

  const auditAfterSlot = await client.query(
    `SELECT automation_type, action, created_at::text, metadata->>'source' AS source,
            after_json->>'reason' AS reason, after_json->>'skipped' AS skipped
     FROM platform_automation_audit_log
     WHERE organization_id=$1::uuid AND created_at >= $2::timestamptz
       AND action IN ('cron_tick','cron_run')
     ORDER BY created_at ASC`,
    [ORG, MISSED_SLOT],
  );

  const uploadsAfterSlot = await client.query(
    `SELECT id::text, report_type, status, created_at::text
     FROM raw_report_uploads
     WHERE organization_id=$1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND created_at >= $2::timestamptz
     ORDER BY created_at ASC`,
    [ORG, MISSED_SLOT],
  );

  const lockCheck = await client.query(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
    [`removal-cron:${ORG}:${STORE}`],
  );
  if ((lockCheck.rows[0] as { acquired: boolean }).acquired) {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`removal-cron:${ORG}:${STORE}`]);
  }

  await client.end();

  const localEnv = {
    CRON_SECRET_present: Boolean(process.env.CRON_SECRET?.trim()),
    ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON: process.env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON ?? null,
    NEXT_PUBLIC_SUPABASE_URL_ref: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(PRODUCTION_REF)
      ? PRODUCTION_REF
      : "not_production",
  };

  const vercelEnvPath = ".cursor/audit-reports/production-warehouse-go-live/vercel-production.env";
  let vercelEnvAudit: Record<string, unknown> = { file_present: false };
  if (fs.existsSync(vercelEnvPath)) {
    const text = fs.readFileSync(vercelEnvPath, "utf8");
    vercelEnvAudit = {
      file_present: true,
      CRON_SECRET_present: /^CRON_SECRET=/m.test(text),
      ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON:
        text.match(/^ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON=(.*)$/m)?.[1] ?? null,
      NEXT_PUBLIC_SUPABASE_URL_has_production: text.includes(PRODUCTION_REF),
    };
  }

  const rootCauses: string[] = [];
  if (auditAfterSlot.rowCount === 0) {
    rootCauses.push("no_cron_tick_in_audit_log_after_0630_utc — Vercel route likely never reached production DB");
  }
  if (uploadsAfterSlot.rowCount === 0) {
    rootCauses.push("no_raw_report_uploads_after_0630_utc");
  }
  if (cron_runtime.last_slot_key == null && cron_runtime.last_success_at) {
    rootCauses.push("last_success_via_manual_script_not_vercel_cron (last_slot_key null)");
  }
  if (!vercelEnvAudit.file_present) {
    rootCauses.push("vercel_production_env_not_pulled_locally — verify CRON_SECRET + ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON on Vercel dashboard");
  } else if (vercelEnvAudit.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON !== "true") {
    rootCauses.push("ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON not true on Vercel production env file");
  }
  if (gateAtSlot.due && auditAfterSlot.rowCount === 0) {
    rootCauses.push("gate_would_have_been_due_at_0635_utc_but_no_audit — infra/env miss not schedule logic");
  }

  return {
    vercel_wake_schedule: VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
    missed_slot_utc: MISSED_SLOT,
    cron_runtime,
    gate_at_missed_slot_plus_5min: gateAtSlot,
    gate_now: gateNow,
    audit_rows_after_slot: auditAfterSlot.rows,
    uploads_after_slot: uploadsAfterSlot.rows,
    advisory_lock_acquired_now: lockCheck.rows[0],
    local_env: localEnv,
    vercel_env_audit: vercelEnvAudit,
    cron_miss_root_cause: rootCauses.length ? rootCauses.join("; ") : "unknown",
    recommended_fixes: [
      "Confirm Vercel production env: CRON_SECRET, ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON=true, NEXT_PUBLIC_SUPABASE_URL→kxsvedvpjldygtdbylsy",
      "Check Vercel deployment cron tab for /api/cron/removal-nightly-sync execution logs on 2026-06-09 06:30 UTC",
      "After env fix, manual GET with Authorization: Bearer $CRON_SECRET should write cron_tick to platform_automation_audit_log",
    ],
  };
}

async function runRemovalCatchup(rollingDays: number): Promise<Record<string, unknown>> {
  bindProductionSupabaseEnv();

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const beforeDates = await queryDomainMaxDates(client, ORG);
  await client.end();

  void auditRemovalCronEvent({
    organizationId: ORG,
    storeId: STORE,
    action: "manual_run",
    gate: { source: "phase4e_manual_catchup", rolling_days: rollingDays },
    result: { started_at: new Date().toISOString() },
  });

  const syncResult = await runProductionRemovalSync({
    window: syncWindowThroughToday(rollingDays),
    skipFetch: false,
    rebuildExpectedPackages: true,
  });

  const { scope } = await loadProductionRemovalAutomationSettings();
  await persistRemovalCronRuntime(
    ORG,
    STORE,
    {
      last_run_at: new Date().toISOString(),
      last_success_at: syncResult.errors.length ? undefined : new Date().toISOString(),
      last_run_status: syncResult.errors.length ? "failed" : "success",
      last_error: syncResult.errors.length ? syncResult.errors.join("; ").slice(0, 2000) : null,
      last_slot_key: `manual:phase4e:${utcToday()}`,
    },
    scope,
  );

  void auditRemovalCronEvent({
    organizationId: ORG,
    storeId: STORE,
    action: "cron_run",
    gate: { source: "phase4e_manual_catchup" },
    result: {
      errors: syncResult.errors,
      order_upload_id: syncResult.order_fetch.upload_id,
      shipment_upload_id: syncResult.shipment_fetch.upload_id,
      counts_after: syncResult.counts_after,
    },
  });

  const client2 = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client2.connect();
  const afterDates = await queryDomainMaxDates(client2, ORG);

  const todayStart = `${utcToday()}T00:00:00.000Z`;
  const uploadsToday = await client2.query(
    `SELECT id::text, report_type, status, created_at::text
     FROM raw_report_uploads
     WHERE organization_id=$1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND created_at >= $2::timestamptz
     ORDER BY created_at DESC`,
    [ORG, todayStart],
  );
  await client2.end();

  const orderOk = syncResult.order_fetch.ok && !syncResult.errors.some((e) => /order/i.test(e));
  const shipOk = syncResult.shipment_fetch.ok && !syncResult.errors.some((e) => /shipment/i.test(e));

  return {
    manual_removal_catchup_ran: true,
    removal_order_success: orderOk,
    removal_shipment_success: shipOk,
    sync_errors: syncResult.errors,
    domain_max_before: beforeDates,
    domain_max_after: afterDates,
    raw_uploads_created_today: uploadsToday.rows,
    data_current_through_date: afterDates.max_shipment_domain_date,
  };
}

async function runEnrichmentSmoke(): Promise<Record<string, unknown>> {
  bindProductionSupabaseEnv();

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const pick = await client.query<{ id: string; asin: string; main_image_url: string | null; amazon_raw_len: number }>(
    `SELECT p.id::text, p.asin,
            p.main_image_url,
            length(coalesce(p.amazon_raw::text,''))::int AS amazon_raw_len
     FROM products p
     WHERE p.organization_id=$1::uuid AND p.deleted_at IS NULL
       AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
       AND (p.main_image_url IS NULL OR btrim(p.main_image_url) = '' OR length(coalesce(p.amazon_raw::text,'')) < 50)
     ORDER BY p.updated_at ASC NULLS FIRST
     LIMIT 5`,
    [ORG],
  );

  const before = await client.query(
    `SELECT id::text, asin, main_image_url, amazon_raw, updated_at::text
     FROM products WHERE id = ANY($1::uuid[])`,
    [pick.rows.map((r) => r.id)],
  );
  await client.end();

  if (!pick.rows.length) {
    return { ok: false, reason: "no_eligible_products", product_ids: [] };
  }

  const { runPimCatalogEnrichmentBatch } = await import("../lib/pim-catalog-enrichment-batch");
  const result = await runPimCatalogEnrichmentBatch({
    organizationId: ORG,
    storeId: STORE,
    limit: 5,
    startIndex: 0,
    prioritizeIncomplete: false,
    forceFreshPriceRows: false,
    retryOnly: true,
    retryMissingPrices: false,
    retryIds: pick.rows.map((r) => r.id),
    allowEnrichmentDebug: true,
    allowSuspiciousImageOverwrite: false,
  });

  const client2 = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client2.connect();
  const after = await client2.query(
    `SELECT id::text, asin, main_image_url, amazon_raw, updated_at::text
     FROM products WHERE id = ANY($1::uuid[])`,
    [pick.rows.map((r) => r.id)],
  );
  await client2.end();

  let amazonRawUpdated = 0;
  let imagesChanged = 0;
  const beforeMap = new Map(
    before.rows.map((r: { id: string }) => [String(r.id), r as Record<string, unknown>]),
  );
  for (const row of after.rows as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const prev = beforeMap.get(id);
    if (!prev) continue;
    const prevRaw = JSON.stringify(prev.amazon_raw ?? null);
    const nextRaw = JSON.stringify(row.amazon_raw ?? null);
    if (prevRaw !== nextRaw) {
      amazonRawUpdated += 1;
    }
    if (String(prev.main_image_url ?? "") !== String(row.main_image_url ?? "")) {
      imagesChanged += 1;
    }
  }

  return {
    ok: result.ok,
    product_ids: pick.rows.map((r) => r.id),
    asins: pick.rows.map((r) => r.asin),
    batch_result: result,
    amazon_raw_updated_count: amazonRawUpdated,
    images_changed_count: imagesChanged,
    before_rows: before.rows,
    after_rows: after.rows,
  };
}

async function main(): Promise<void> {
  const applyRemoval = process.argv.includes("--apply-removal");
  const applyEnrichment = process.argv.includes("--apply-enrichment");
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  console.error("Phase 4E: investigating cron miss…");
  const cronInvestigation = await investigateCronMiss();

  let removalResult: Record<string, unknown> | null = null;
  if (applyRemoval) {
    if (process.env.APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC?.trim() !== "true") {
      throw new Error("APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true required for --apply-removal");
    }
    console.error("Phase 4E: running removal catch-up…");
    removalResult = await runRemovalCatchup(7);
  }

  let enrichmentResult: Record<string, unknown> | null = null;
  if (applyEnrichment) {
    console.error("Phase 4E: running product enrichment smoke (5 products)…");
    enrichmentResult = await runEnrichmentSmoke();
  }

  const summary = {
    phase_number: "4E",
    run_id: rid,
    cron_miss_root_cause: cronInvestigation.cron_miss_root_cause,
    cron_investigation: cronInvestigation,
    manual_removal_catchup_ran: applyRemoval,
    removal_order_success: removalResult?.removal_order_success ?? null,
    removal_shipment_success: removalResult?.removal_shipment_success ?? null,
    raw_uploads_created_today: removalResult?.raw_uploads_created_today ?? [],
    data_current_through_date: removalResult?.data_current_through_date ?? null,
    product_enrichment_smoke_result: enrichmentResult,
    amazon_raw_updated_count: enrichmentResult?.amazon_raw_updated_count ?? 0,
    images_changed_count: enrichmentResult?.images_changed_count ?? 0,
    audit_logs_written: applyRemoval ? "manual_run + cron_run via auditRemovalCronEvent" : "investigation only",
    SAFE_FOR_PRODUCTION_REMOVAL_CRON: (() => {
      const ve = cronInvestigation.vercel_env_audit as {
        ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON?: string;
      };
      return ve?.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON === "true"
        ? "conditional_verify_vercel_logs"
        : "no_until_vercel_env_confirmed";
    })(),
    SAFE_TO_ENABLE_PRODUCT_ENRICHMENT_SCHEDULE:
      enrichmentResult?.ok && Number(enrichmentResult?.amazon_raw_updated_count) > 0
        ? "conditional_after_operator_review"
        : "no_until_smoke_passes",
    next_api_prompt:
      "PHASE-4E-VERCEL-CRON-ENV-VERIFY — pull Vercel production env, confirm CRON_SECRET + ENABLE flag, hit cron route once, confirm audit_tick",
    blockers: [
      ...(applyRemoval ? [] : ["removal catchup not run — pass --apply-removal with APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true"]),
      ...(applyEnrichment ? [] : ["enrichment smoke not run — pass --apply-enrichment"]),
      "reimbursements/settlement/finances remain disabled — next: PHASE-4C-API-CARDS-STAGING-APPLY-SMOKE one card at a time",
    ],
    removal_result: removalResult,
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
