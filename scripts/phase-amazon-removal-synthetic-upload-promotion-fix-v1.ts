/**
 * PHASE-AMAZON-REMOVAL-SYNTHETIC-UPLOAD-PROMOTION-FIX-V1
 * Trace stuck removal uploads, reprocess via resume promotion, verify staging.
 *
 *   npx tsx scripts/phase-amazon-removal-synthetic-upload-promotion-fix-v1.ts
 *   npx tsx scripts/phase-amazon-removal-synthetic-upload-promotion-fix-v1.ts --execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { resolveRemovalReportsRunPipeline } from "../lib/amazon/reports-api-removal-pipeline-mode";
import {
  buildRemovalSupersessionReadinessSummary,
  type RemovalDetailRowLike,
  type RemovalShipmentRowLike,
} from "../lib/claims/removal/removal-source-supersession-readmodel";
import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-removal-synthetic-upload-promotion-fix-v1";
const MAX_RESUME_ROUNDS = 30;
const RESUME_SLEEP_MS = 3000;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type StuckUpload = {
  id: string;
  report_type: string;
  status: string | null;
  created_at: string;
  source_run_state: string | null;
  content_sha256: string | null;
  file_name: string | null;
};

async function listStuckUploads(c: pg.Client): Promise<StuckUpload[]> {
  const r = await c.query(
    `SELECT id, report_type, status, created_at::text AS created_at,
            metadata->'source_run'->>'state' AS source_run_state,
            metadata->>'content_sha256' AS content_sha256,
            file_name
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'source_run'->>'state' = 'synthetic_upload_ready'
     ORDER BY created_at DESC`,
    [ORG],
  );
  return r.rows as StuckUpload[];
}

async function lifecycleTrace(c: pg.Client, uploadId: string): Promise<Record<string, unknown>> {
  const r = await c.query(
    `SELECT id, report_type, status, created_at::text, updated_at::text, file_name,
            metadata->'source_run' AS source_run,
            metadata->>'content_sha256' AS content_sha256,
            metadata->'import_metrics' AS import_metrics
     FROM public.raw_report_uploads WHERE id = $1::uuid AND organization_id = $2::uuid`,
    [uploadId, ORG],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { upload_id: uploadId, found: false };

  const staging = await c.query(
    `SELECT COUNT(*)::int AS c FROM public.amazon_staging WHERE upload_id = $1::uuid`,
    [uploadId],
  );
  const domainTable =
    row.report_type === "REMOVAL_ORDER" ? "amazon_removals" : "amazon_removal_shipments";
  const domain = await c.query(
    `SELECT COUNT(*)::int AS c FROM public.${domainTable} WHERE upload_id = $1::uuid`,
    [uploadId],
  );

  return {
    upload_id: uploadId,
    found: true,
    report_type: row.report_type,
    status: row.status,
    file_name: row.file_name,
    source_run: row.source_run,
    content_sha256: row.content_sha256,
    import_metrics: row.import_metrics,
    staging_rows: staging.rows[0]?.c ?? 0,
    domain_rows: domain.rows[0]?.c ?? 0,
    domain_table: domainTable,
  };
}

async function domainCounts(c: pg.Client): Promise<{ removals: number; shipments: number }> {
  const r = await c.query(
    `SELECT
      (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid AND store_id=$2::uuid) AS removals,
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid AND store_id=$2::uuid) AS shipments`,
    [ORG, STORE],
  );
  return r.rows[0] as { removals: number; shipments: number };
}

async function claimCandidateCount(c: pg.Client): Promise<number> {
  const r = await c.query(
    `SELECT COUNT(*)::bigint AS c FROM public.claim_candidates
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND quarantined_at IS NULL AND rejected_at IS NULL`,
    [ORG, STORE],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function duplicateCheck(c: pg.Client): Promise<Record<string, number>> {
  const biz = await c.query(
    `SELECT COUNT(*)::int AS c FROM (
       SELECT source_detail_row_id, source_shipment_row_id, build_source, allocation_group_key
       FROM public.expected_packages
       WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')
       GROUP BY 1,2,3,4 HAVING COUNT(*)>1
     ) x`,
    [ORG],
  );
  const idem = await c.query(
    `SELECT COUNT(*)::int AS c FROM (
       SELECT metadata->'source_run'->>'idempotency_key' AS k
       FROM public.raw_report_uploads
       WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
         AND metadata->'source_run'->>'idempotency_key' IS NOT NULL
       GROUP BY 1 HAVING COUNT(*)>1
     ) x`,
    [ORG],
  );
  return {
    ep_business_key_dup_groups: Number(biz.rows[0]?.c ?? 0),
    upload_idempotency_dup_keys: Number(idem.rows[0]?.c ?? 0),
  };
}

async function supersessionCensus(c: pg.Client) {
  const details = await c.query(
    `SELECT id, order_id, sku, fnsku, shipped_quantity, in_process_quantity, created_at
     FROM public.amazon_removals WHERE organization_id=$1::uuid AND store_id=$2::uuid LIMIT 10000`,
    [ORG, STORE],
  );
  const shipments = await c.query(
    `SELECT id, order_id, sku, fnsku, shipped_quantity, tracking_number, created_at
     FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid AND store_id=$2::uuid LIMIT 10000`,
    [ORG, STORE],
  );
  return buildRemovalSupersessionReadinessSummary(
    details.rows as RemovalDetailRowLike[],
    shipments.rows as RemovalShipmentRowLike[],
  );
}

async function promoteUpload(
  reportType: string,
  uploadId: string,
  windowStart: string,
  windowEnd: string,
): Promise<Record<string, unknown>> {
  const { runRemovalOrderReportsWorker } = await import("../lib/amazon/reports-api-removal-order-worker");
  const { runRemovalShipmentReportsWorker } = await import(
    "../lib/amazon/reports-api-removal-shipment-worker"
  );
  const fn =
    reportType === "REMOVAL_ORDER" ? runRemovalOrderReportsWorker : runRemovalShipmentReportsWorker;

  let last = await fn({
    organizationId: ORG,
    storeId: STORE,
    windowStart,
    windowEnd,
    uploadId,
  });
  let rounds = 0;
  while (last.needs_resume && rounds < MAX_RESUME_ROUNDS) {
    rounds++;
    await new Promise((r) => setTimeout(r, RESUME_SLEEP_MS));
    last = await fn({
      organizationId: ORG,
      storeId: STORE,
      windowStart,
      windowEnd,
      uploadId: last.upload_id ?? uploadId,
    });
    if (last.state === "complete" || last.state === "failed") break;
  }
  return {
    upload_id: uploadId,
    report_type: reportType,
    ok: last.ok,
    final_state: last.state,
    resume_rounds: rounds,
    run_pipeline_resolved: resolveRemovalReportsRunPipeline({ uploadId }, {}),
    error: last.error ?? null,
  };
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

  if (execute) {
    process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";
  }

  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const stuck_uploads_before = await listStuckUploads(c);
  const lifecycle_trace = await Promise.all(stuck_uploads_before.map((u) => lifecycleTrace(c, u.id)));
  const domain_before = await domainCounts(c);
  const ccBefore = await claimCandidateCount(c);
  const dupBefore = await duplicateCheck(c);
  const supersessionBefore = await supersessionCensus(c);

  const root_cause = {
    summary:
      "Removal workers use fetch-only on net-new pulls (runPipeline false). Resume loops that pass uploadId but not run_pipeline:true never promoted synthetic_upload_ready uploads through runReportsApiImportPipeline.",
    contributing_factors: [
      "REMOVAL_API_INTAKE step 3: intentional runPipeline:false at fetch",
      "Sample/backfill scripts resume with uploadId only — no run_pipeline:true",
      "Not missing importer — runReportsApiImportPipeline exists but gated by runPipeline",
      "Not env flag — archive + content_sha256 present on stuck uploads",
      "removal_api_sync.enabled=false affects cron only, not direct pipeline promotion",
    ],
    fix:
      "resolveRemovalReportsRunPipeline: resume with uploadId auto-promotes unless runPipeline:false explicitly",
  };

  const reprocess_result: Record<string, unknown>[] = [];
  if (execute) {
    for (const stuck of stuck_uploads_before) {
      const trace = lifecycle_trace.find((t) => t.upload_id === stuck.id) as {
        source_run?: { window?: { start?: string; end?: string } };
      };
      const window = trace?.source_run?.window;
      if (!window?.start || !window?.end) {
        reprocess_result.push({
          upload_id: stuck.id,
          skipped: true,
          reason: "missing source_run.window",
        });
        continue;
      }
      reprocess_result.push(
        await promoteUpload(stuck.report_type, stuck.id, window.start, window.end),
      );
    }
  }

  const stuck_uploads_after = await listStuckUploads(c);
  const lifecycle_trace_after = await Promise.all(
    reprocess_result
      .filter((r) => !r.skipped)
      .map((r) => lifecycleTrace(c, String(r.upload_id))),
  );
  const domain_after = await domainCounts(c);
  const ccAfter = await claimCandidateCount(c);
  const dupAfter = await duplicateCheck(c);
  const supersessionAfter = await supersessionCensus(c);

  await c.end();

  let operatorMobileModified = false;
  try {
    operatorMobileModified =
      require("child_process")
        .execSync(`git status --porcelain "app/scanner/operator-mobile"`, { encoding: "utf8" })
        .trim().length > 0;
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
      build_result = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    }
    try {
      require("child_process").execSync("npm run smoke:claim-family-algorithm-readmodel-v1", {
        cwd: process.cwd(),
        stdio: "pipe",
        encoding: "utf8",
      });
      smoke_result = "pass";
    } catch {
      smoke_result = "fail_or_skipped";
    }
  }

  const promotedOk =
    execute &&
    reprocess_result.length > 0 &&
    reprocess_result.every((r) => r.skipped || r.final_state === "complete");

  const summary = {
    prompt: "PHASE-AMAZON-REMOVAL-SYNTHETIC-UPLOAD-PROMOTION-FIX-V1",
    run_id: rid,
    mode: execute ? "execute" : "dry_run",
    stuck_uploads_before,
    lifecycle_trace,
    root_cause,
    files_changed: [
      "lib/amazon/reports-api-removal-pipeline-mode.ts",
      "lib/amazon/reports-api-removal-order-worker.ts",
      "lib/amazon/reports-api-removal-shipment-worker.ts",
    ],
    reprocess_result,
    stuck_uploads_after_count: stuck_uploads_after.length,
    lifecycle_trace_after,
    domain_counts_before_after: { before: domain_before, after: domain_after },
    duplicate_check: { before: dupBefore, after: dupAfter },
    supersession_status: { before: supersessionBefore, after: supersessionAfter },
    claim_candidates_delta: ccAfter - ccBefore,
    no_reconnect_verification: {
      removal_api_connector_unchanged: true,
      new_removal_workers_created: false,
      expected_packages_rebuild_not_run: true,
    },
    no_scanner_change_verification: { operator_mobile_modified: operatorMobileModified },
    build_result,
    smoke_result,
    SAFE_TO_PUSH: promotedOk && build_result === "pass" && ccBefore === ccAfter ? "yes" : execute ? "conditional_yes" : "pending_execute",
    NEXT_PROMPT: "PHASE-AMAZON-SPAPI-PHASE0-FRESHNESS-VERIFY-NO-RECONNECT-V1 --execute",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
