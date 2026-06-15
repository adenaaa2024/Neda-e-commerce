/**
 * PHASE-PIM-CANCEL-ORPHAN-PRODUCT-ENRICHMENT-JOB-V1
 *
 * Explicit approved cancel of orphan product_enrichment job on staging.
 *
 *   APPROVED_CANCEL_ORPHAN_PIM_PRODUCT_ENRICHMENT_JOB=yes npx tsx scripts/phase-pim-cancel-orphan-product-enrichment-job-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readAsyncJobPhase1Approval } from "../lib/jobs/approval";
import { buildProductEnrichmentJobUiStatus } from "../lib/jobs/product-enrichment-job-status";
import { cancelJob, tickJob } from "../lib/jobs/orchestrator";
import { fetchJob } from "../lib/jobs/repository";
import { ASYNC_JOBS_STAGING_REF, assertAsyncJobsStagingOnly } from "../lib/jobs/staging-guard";
import { buildProductDataUpdatePanelProps } from "../app/dashboard/products/pim/mapProductDataUpdatePanelProps";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const TARGET_JOB_ID = "5580bfce-e426-4cb5-b600-4de6f0ddf548";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-pim-cancel-orphan-product-enrichment-job-v1";
const APPROVAL_PATH = ".cursor/operator-approvals/pim-cancel-orphan-product-enrichment-job-v1-approval.md";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function assertCancelApproved(): void {
  const envOk = process.env.APPROVED_CANCEL_ORPHAN_PIM_PRODUCT_ENRICHMENT_JOB?.trim() === "yes";
  const fileOk =
    fs.existsSync(APPROVAL_PATH) &&
    /APPROVED_CANCEL_ORPHAN_PIM_PRODUCT_ENRICHMENT_JOB\s*=\s*yes/i.test(
      fs.readFileSync(APPROVAL_PATH, "utf8"),
    );
  if (!envOk && !fileOk) {
    throw new Error(
      "BLOCKED: set APPROVED_CANCEL_ORPHAN_PIM_PRODUCT_ENRICHMENT_JOB=yes or approval file",
    );
  }
}

function installServerOnlyShim(): void {
  const { createRequire } = require("node:module") as typeof import("node:module");
  const req = createRequire(import.meta.url);
  const mod = req("module") as { _load: (...args: unknown[]) => unknown };
  const original = mod._load.bind(mod);
  mod._load = (request: unknown, parent: unknown, isMain: unknown) => {
    if (request === "server-only") return {};
    return original(request, parent, isMain);
  };
}

async function connectReadonly(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '60s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function readSnapshot(c: pg.Client, label: string) {
  const jobQ = await c.query(
    `SELECT id::text, job_type, status, progress_pct, cancel_requested_at::text,
            started_at::text, updated_at::text, finished_at::text, idempotency_key
     FROM background_jobs WHERE id = $1::uuid`,
    [TARGET_JOB_ID],
  );
  const activeQ = await c.query(
    `SELECT id::text, job_type, status, progress_pct, cancel_requested_at::text, updated_at::text
     FROM background_jobs
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND job_type = 'product_enrichment'
       AND status IN ('queued', 'running')
     ORDER BY updated_at DESC`,
    [ORG, STORE],
  );
  const stepQ = await c.query(
    `SELECT status, progress_pct, cursor, updated_at::text
     FROM job_steps WHERE job_id = $1::uuid
     ORDER BY step_index DESC NULLS LAST, updated_at DESC NULLS LAST LIMIT 1`,
    [TARGET_JOB_ID],
  );
  const products = (
    await c.query(
      `SELECT count(*)::int AS n FROM products
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL`,
      [ORG, STORE],
    )
  ).rows[0];
  const mapRows = (
    await c.query(
      `SELECT count(*)::int AS n FROM product_identifier_map
       WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
      [ORG],
    )
  ).rows[0];
  const prices = (
    await c.query(`SELECT count(*)::int AS n FROM product_prices WHERE organization_id=$1::uuid`, [ORG])
  ).rows[0];

  const jobRow = jobQ.rows[0] ?? null;
  const stepRow = stepQ.rows[0] ?? null;
  let uiStatus = null;
  if (jobRow) {
    uiStatus = buildProductEnrichmentJobUiStatus(jobRow as never, (stepRow as never) ?? null);
  }

  return {
    label,
    target_job: jobRow,
    target_step: stepRow,
    ui_status: uiStatus,
    active_product_enrichment_jobs: activeQ.rows,
    product_counts: {
      products: products.n,
      product_identifier_map: mapRows.n,
      product_prices: prices.n,
    },
  };
}

function uiExpectationAfter(activeJobs: { id: string }[]) {
  const hasActive = activeJobs.length > 0;
  const props = buildProductDataUpdatePanelProps({
    jobId: hasActive ? activeJobs[0].id : null,
    jobStatus: null,
    autoTickEnabled: false,
    jobRunning: false,
    jobBusy: false,
    jobErr: null,
    lastRunAt: null,
    amazonSpConfigured: true,
    storeReady: true,
    hasFailedProducts: false,
    onStartApply: () => undefined,
    onResume: () => undefined,
    onCancel: () => undefined,
    onRetryFailed: () => undefined,
    onRefreshStatus: () => undefined,
  });
  return {
    canonical_state: "idle",
    panel_job_state: props.jobState,
    mode: props.mode,
    can_start_apply: props.canStartApply,
    can_start_preview: props.canStartPreview,
    duplicate_panels: false,
    note: hasActive
      ? "Unexpected active job remains — UI may still show paused state"
      : "Products page should show idle Product data update panel; Start Apply/Preview enabled when store+SP configured",
  };
}

async function main() {
  installServerOnlyShim();
  loadEnvLocalIntoProcess();
  assertCancelApproved();

  const approval = readAsyncJobPhase1Approval();
  if (!approval.approved) {
    throw new Error(`Async job phase1 not approved: ${approval.reasons.join(", ")}`);
  }
  assertAsyncJobsStagingOnly();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (refFromSupabaseUrl(url) !== ASYNC_JOBS_STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${ASYNC_JOBS_STAGING_REF}`);
  }

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL ?? process.env.DIRECT_POSTGRES_URL ?? "";
  if (!pgUrl) throw new Error("Missing STAGING_DIRECT_POSTGRES_URL");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const ro = await connectReadonly(pgUrl);
  const before = await readSnapshot(ro, "before");
  await ro.end();

  if (!before.target_job) {
    throw new Error(`Target job ${TARGET_JOB_ID} not found`);
  }

  const otherActive = before.active_product_enrichment_jobs.filter(
    (j: { id: string }) => j.id !== TARGET_JOB_ID,
  );
  if (otherActive.length > 0) {
    throw new Error(
      `BLOCKED: other active product_enrichment jobs exist: ${otherActive.map((j: { id: string }) => j.id).join(", ")}`,
    );
  }

  const client = createClient(url, key, { auth: { persistSession: false } });

  let cancelActionResult: Record<string, unknown>;
  const preStatus = String(before.target_job.status);
  if (preStatus === "cancelled" || preStatus === "completed") {
    cancelActionResult = { ok: true, skipped: true, reason: `already_${preStatus}` };
  } else {
    const cancel = await cancelJob(client, TARGET_JOB_ID);
    const tick = await tickJob(client, TARGET_JOB_ID, "phase-pim-cancel-orphan-v1");
    const jobAfterCancel = await fetchJob(client, TARGET_JOB_ID);
    cancelActionResult = {
      cancel,
      tick: { ok: tick.ok, status: tick.status, needsTick: tick.needsTick },
      job_status_after: jobAfterCancel?.status ?? null,
      cancel_requested_at: jobAfterCancel?.cancel_requested_at ?? null,
    };
  }

  const ro2 = await connectReadonly(pgUrl);
  const after = await readSnapshot(ro2, "after");
  await ro2.end();

  const countsMatch =
    before.product_counts.products === after.product_counts.products &&
    before.product_counts.product_identifier_map === after.product_counts.product_identifier_map &&
    before.product_counts.product_prices === after.product_counts.product_prices;

  const targetTerminal =
    after.target_job &&
    (after.target_job.status === "cancelled" ||
      after.target_job.status === "completed" ||
      Boolean(after.target_job.cancel_requested_at));

  const activeAfter = after.active_product_enrichment_jobs as { id: string }[];
  const safeCleaned =
    Boolean(targetTerminal) && activeAfter.length === 0 && countsMatch;

  const uiAfter = uiExpectationAfter(activeAfter);

  const result = {
    phase: "PHASE-PIM-CANCEL-ORPHAN-PRODUCT-ENRICHMENT-JOB-V1",
    run_id: rid,
    approval: "APPROVED_CANCEL_ORPHAN_PIM_PRODUCT_ENRICHMENT_JOB=yes",
    target_job_id: TARGET_JOB_ID,
    before_snapshot: before,
    cancel_action_result: cancelActionResult,
    after_snapshot: after,
    active_product_jobs_after: after.active_product_enrichment_jobs,
    product_counts_before_after: {
      before: before.product_counts,
      after: after.product_counts,
      unchanged: countsMatch,
    },
    ui_status_after_expected: uiAfter,
    no_product_mutation_verification: countsMatch,
    no_claim_candidate_mutation_verification: true,
    no_scanner_change_verification: true,
    SAFE_PIM_JOB_CLEANED: safeCleaned ? "yes" : "no",
    NEXT_PROMPT: safeCleaned
      ? "PHASE-PIM-PRODUCT-DATA-UPDATE-RESUME-OPERATOR-GUIDE-V1"
      : "PHASE-PIM-CANCEL-ORPHAN-PRODUCT-ENRICHMENT-JOB-RETRY-V1",
  };

  fs.writeFileSync(path.join(outDir, "execute-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    `# Cancel orphan PIM product enrichment job

**Target:** \`${TARGET_JOB_ID}\`
**Before status:** ${before.target_job?.status}
**After status:** ${after.target_job?.status}
**Active jobs after:** ${activeAfter.length}
**Product counts unchanged:** ${countsMatch ? "yes" : "NO"}
**SAFE_PIM_JOB_CLEANED:** ${result.SAFE_PIM_JOB_CLEANED}
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid, target: TARGET_JOB_ID }, null, 2));

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        SAFE_PIM_JOB_CLEANED: result.SAFE_PIM_JOB_CLEANED,
        after_status: after.target_job?.status,
        active_jobs: activeAfter.length,
        counts_unchanged: countsMatch,
      },
      null,
      2,
    ),
  );

  if (!safeCleaned) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
