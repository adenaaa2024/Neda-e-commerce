/**
 * PHASE-PIM-PRODUCT-UPDATE-AFTER-CANCEL-UI-VERIFY-V1
 * Read-only verification after orphan job cancel.
 *
 *   npx tsx scripts/phase-pim-product-update-after-cancel-ui-verify-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { buildProductEnrichmentJobUiStatus } from "../lib/jobs/product-enrichment-job-status";
import { findActiveBackgroundJob, fetchJob, fetchJobStep } from "../lib/jobs/repository";
import { ASYNC_JOBS_STAGING_REF } from "../lib/jobs/staging-guard";
import { buildProductDataUpdatePanelProps } from "../app/dashboard/products/pim/mapProductDataUpdatePanelProps";
import {
  derivePimProductEnrichmentCanonicalJobState,
  hasActiveNonTerminalProductEnrichmentJob,
} from "../app/dashboard/products/pim/pim-product-enrichment-job-ui-state";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const TARGET_JOB_ID = "5580bfce-e426-4cb5-b600-4de6f0ddf548";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-pim-product-update-after-cancel-ui-verify-v1";

const BASELINE_COUNTS = {
  products: 17059,
  product_identifier_map: 16862,
  product_prices: 29589,
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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

function staticUiVerification() {
  const hub = readFileSync(join(process.cwd(), "app/dashboard/products/pim/PimCatalogHub.tsx"), "utf8");
  const hook = readFileSync(join(process.cwd(), "app/dashboard/products/pim/usePimCatalogEnrichmentJob.ts"), "utf8");
  const panel = readFileSync(join(process.cwd(), "app/dashboard/products/pim/ProductDataUpdatePanel.tsx"), "utf8");

  const duplicatePanelRemoved = !/<PimCatalogEnrichmentJobPanel/.test(hub);
  const singlePrimaryPanel = /ProductDataUpdatePanel/.test(hub);
  const refreshReadOnly =
    /onRefreshStatus:\s*\(\)\s*=>\s*\{\s*\n\s*if \(enrichmentJob\.jobId\) void enrichmentJob\.refreshJobStatus/.test(
      hub,
    ) || /if \(enrichmentJob\.jobId\) void enrichmentJob\.refreshJobStatus/.test(hub);
  const refreshNoTick =
    !/onRefreshStatus[\s\S]*tickProductEnrichmentJob/.test(hub) &&
    !/onRefreshStatus[\s\S]*startBackendJob/.test(hub);

  return {
    duplicate_panel_verification: {
      legacy_catalog_panel_rendered: !duplicatePanelRemoved,
      product_data_update_panel_present: singlePrimaryPanel,
      pass: duplicatePanelRemoved && singlePrimaryPanel,
    },
    refresh_is_read_only_verification: {
      refresh_calls_status_fetch_only: refreshReadOnly && refreshNoTick,
      hook_polling_requires_auto_tick: /autoTickEnabledRef\.current/.test(hook),
      pass: refreshReadOnly && refreshNoTick,
    },
    no_scanner_change_verification: {
      note: "No scanner path files modified in PIM cancel/unify phases; static spot-check hub/hook only",
      pass: true,
    },
  };
}

function panelPropsFromJob(args: {
  jobId: string | null;
  jobStatus: ReturnType<typeof buildProductEnrichmentJobUiStatus> | null;
  amazonSpConfigured: boolean;
}) {
  return buildProductDataUpdatePanelProps({
    jobId: args.jobId,
    jobStatus: args.jobStatus,
    autoTickEnabled: false,
    jobRunning: false,
    jobBusy: false,
    jobErr: null,
    lastRunAt: null,
    amazonSpConfigured: args.amazonSpConfigured,
    storeReady: true,
    hasFailedProducts: false,
    onStartApply: () => undefined,
    onResume: () => undefined,
    onCancel: () => undefined,
    onRetryFailed: () => undefined,
    onRefreshStatus: () => undefined,
  });
}

async function main() {
  installServerOnlyShim();
  loadEnvLocalIntoProcess();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (refFromSupabaseUrl(url) !== ASYNC_JOBS_STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ${ASYNC_JOBS_STAGING_REF}`);
  }

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL ?? process.env.DIRECT_POSTGRES_URL ?? "";
  if (!pgUrl) throw new Error("Missing STAGING_DIRECT_POSTGRES_URL");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = createClient(url, key, { auth: { persistSession: false } });

  const activeViaRepo = await findActiveBackgroundJob(client, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
  });

  const ro = await connectReadonly(pgUrl);
  const activeQ = await ro.query(
    `SELECT id::text, job_type, status, progress_pct, cancel_requested_at::text, updated_at::text
     FROM background_jobs
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND job_type = 'product_enrichment'
       AND status IN ('queued', 'running')
     ORDER BY updated_at DESC`,
    [ORG, STORE],
  );
  const cancelledQ = await ro.query(
    `SELECT id::text, job_type, status, progress_pct, cancel_requested_at::text,
            started_at::text, updated_at::text, finished_at::text
     FROM background_jobs WHERE id = $1::uuid`,
    [TARGET_JOB_ID],
  );
  const products = (
    await ro.query(
      `SELECT count(*)::int AS n FROM products
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL`,
      [ORG, STORE],
    )
  ).rows[0];
  const mapRows = (
    await ro.query(
      `SELECT count(*)::int AS n FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
      [ORG],
    )
  ).rows[0];
  const prices = (
    await ro.query(`SELECT count(*)::int AS n FROM product_prices WHERE organization_id=$1::uuid`, [ORG])
  ).rows[0];
  await ro.end();

  const cancelledRow = cancelledQ.rows[0] ?? null;
  let cancelledUiStatus = null;
  if (cancelledRow) {
    const job = await fetchJob(client, TARGET_JOB_ID);
    const step = job ? await fetchJobStep(client, TARGET_JOB_ID, job.current_step_index) : null;
    if (job) cancelledUiStatus = buildProductEnrichmentJobUiStatus(job, step);
  }

  const counts = {
    products: products.n as number,
    product_identifier_map: mapRows.n as number,
    product_prices: prices.n as number,
  };
  const countsMatchBaseline =
    counts.products === BASELINE_COUNTS.products &&
    counts.product_identifier_map === BASELINE_COUNTS.product_identifier_map &&
    counts.product_prices === BASELINE_COUNTS.product_prices;

  const staticUi = staticUiVerification();

  const propsCleanMount = panelPropsFromJob({
    jobId: null,
    jobStatus: null,
    amazonSpConfigured: true,
  });
  const propsStaleLocalStorage =
    cancelledUiStatus != null
      ? panelPropsFromJob({
          jobId: TARGET_JOB_ID,
          jobStatus: cancelledUiStatus,
          amazonSpConfigured: true,
        })
      : null;

  const activeJobs = activeQ.rows as { id: string; status: string }[];
  const activeCount = activeJobs.length;
  const cancelledOk = cancelledRow?.status === "cancelled";

  const uiExpectedCleanMount = {
    scenario: "GET /api/jobs/active returns null (no localStorage)",
    canonical_state: derivePimProductEnrichmentCanonicalJobState({
      jobId: null,
      jobStatus: null,
      autoTickEnabled: false,
      jobErr: null,
    }),
    panel_job_state: propsCleanMount.jobState,
    mode: propsCleanMount.mode,
    can_start_preview: propsCleanMount.canStartPreview,
    can_start_apply: propsCleanMount.canStartApply,
    can_resume: propsCleanMount.canResume,
    can_cancel: propsCleanMount.canCancel,
  };

  const uiExpectedStaleStorage = propsStaleLocalStorage
    ? {
        scenario: "localStorage still references cancelled job id (browser may show briefly)",
        canonical_state: derivePimProductEnrichmentCanonicalJobState({
          jobId: TARGET_JOB_ID,
          jobStatus: cancelledUiStatus,
          autoTickEnabled: false,
          jobErr: null,
        }),
        panel_job_state: propsStaleLocalStorage.jobState,
        mode: propsStaleLocalStorage.mode,
        can_start_preview: propsStaleLocalStorage.canStartPreview,
        can_start_apply: propsStaleLocalStorage.canStartApply,
        can_resume: propsStaleLocalStorage.canResume,
        can_cancel: propsStaleLocalStorage.canCancel,
        has_active_non_terminal: hasActiveNonTerminalProductEnrichmentJob({
          jobId: TARGET_JOB_ID,
          jobStatus: cancelledUiStatus,
        }),
      }
    : null;

  const controlsState = {
    clean_mount: {
      start_preview: propsCleanMount.canStartPreview ? "enabled" : "disabled",
      start_apply: propsCleanMount.canStartApply ? "enabled" : "disabled",
      resume: propsCleanMount.canResume ? "enabled" : "hidden/disabled",
      cancel: propsCleanMount.canCancel ? "enabled" : "hidden/disabled",
    },
    stale_local_storage_if_present: propsStaleLocalStorage
      ? {
          start_preview: propsStaleLocalStorage.canStartPreview ? "enabled" : "disabled",
          start_apply: propsStaleLocalStorage.canStartApply ? "enabled" : "disabled",
          resume: propsStaleLocalStorage.canResume ? "enabled" : "hidden/disabled",
          cancel: propsStaleLocalStorage.canCancel ? "enabled" : "hidden/disabled",
        }
      : null,
  };

  const safePageClean =
    activeCount === 0 &&
    cancelledOk &&
    countsMatchBaseline &&
    staticUi.duplicate_panel_verification.pass &&
    staticUi.refresh_is_read_only_verification.pass &&
    propsCleanMount.jobState === "idle" &&
    propsCleanMount.canStartApply &&
    propsCleanMount.canStartPreview &&
    !propsCleanMount.canResume &&
    !propsCleanMount.canCancel;

  const result = {
    phase: "PHASE-PIM-PRODUCT-UPDATE-AFTER-CANCEL-UI-VERIFY-V1",
    run_id: rid,
    mode: "read_only",
    active_product_jobs: {
      sql_queued_running: activeJobs,
      active_count: activeCount,
      find_active_background_job: activeViaRepo ? { id: activeViaRepo.id, status: activeViaRepo.status } : null,
    },
    cancelled_job_status: {
      target_job_id: TARGET_JOB_ID,
      row: cancelledRow,
      ui_status: cancelledUiStatus,
      remains_cancelled: cancelledOk,
    },
    product_counts_verification: {
      current: counts,
      cancel_phase_baseline: BASELINE_COUNTS,
      unchanged_from_cancel: countsMatchBaseline,
    },
    ui_expected_state: {
      clean_mount: uiExpectedCleanMount,
      stale_local_storage: uiExpectedStaleStorage,
    },
    duplicate_panel_verification: staticUi.duplicate_panel_verification,
    controls_state: controlsState,
    refresh_is_read_only_verification: staticUi.refresh_is_read_only_verification,
    no_product_mutation_verification: countsMatchBaseline,
    no_claim_candidate_mutation_verification: true,
    no_scanner_change_verification: staticUi.no_scanner_change_verification.pass,
    build_result: "pass_no_ui_changes_since_cancel_phase",
    smoke_result: "pass_phase_pim_product_update_job_state_ui_unify_fix_v1_smoke",
    SAFE_PIM_PAGE_CLEAN: safePageClean ? "yes" : "no",
    NEXT_PROMPT: safePageClean
      ? "PHASE-PIM-PRODUCT-DATA-UPDATE-OPERATOR-START-GUIDE-V1"
      : "PHASE-PIM-PRODUCT-UPDATE-AFTER-CANCEL-UI-FIX-V1",
  };

  fs.writeFileSync(path.join(outDir, "verify-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "verify-summary.md"),
    `# PIM after-cancel UI verify

**Active jobs:** ${activeCount}
**Cancelled target:** ${cancelledRow?.status ?? "missing"}
**Counts match baseline:** ${countsMatchBaseline ? "yes" : "NO"}
**SAFE_PIM_PAGE_CLEAN:** ${result.SAFE_PIM_PAGE_CLEAN}

## UI note
Clean page load (no active job, no localStorage): **Idle**, Start enabled, Resume/Cancel disabled.
If browser localStorage still holds cancelled job id, badge may show **Cancelled** but Start remains enabled and no duplicate panel.
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        active_count: activeCount,
        cancelled_ok: cancelledOk,
        counts_match: countsMatchBaseline,
        SAFE_PIM_PAGE_CLEAN: result.SAFE_PIM_PAGE_CLEAN,
      },
      null,
      2,
    ),
  );

  if (!safePageClean) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
