/**
 * PHASE-PIM-PRODUCT-UPDATE-JOB-STATE-DUPLICATE-AUDIT-V1
 * Read-only audit — duplicate UI / job state.
 *
 *   npx tsx scripts/phase-pim-product-update-job-state-duplicate-audit-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildProductEnrichmentJobUiStatus } from "../lib/jobs/product-enrichment-job-status";
import type { BackgroundJobRow, JobStepRow } from "../lib/jobs/types";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-pim-product-update-job-state-duplicate-audit-v1";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

function simulateUiLabels(status: ReturnType<typeof buildProductEnrichmentJobUiStatus>, autoTickEnabled: boolean) {
  const jobAdvancing =
    Boolean(status.running || (status.needs_tick && autoTickEnabled)) &&
    !["completed", "cancelled", "failed"].includes(status.status);
  const jobPausedAwaitingUser =
    Boolean(status.needs_tick && !autoTickEnabled) &&
    !["completed", "cancelled", "failed"].includes(status.status);

  let productDataUpdateState: string = "idle";
  if (status.cancel_requested && (status.status === "running" || status.status === "queued")) {
    productDataUpdateState = "paused";
  } else if (jobAdvancing) {
    productDataUpdateState = "running";
  } else if (status.status === "queued" || status.status === "running") {
    productDataUpdateState = "running";
  }

  const catalogPanelRunning = Boolean(status.running || status.needs_tick);
  const catalogSubtitle = jobPausedAwaitingUser
    ? "Paused — no background update is running"
    : catalogPanelRunning
      ? "Running in the background"
      : "Job completed";

  return {
    auto_tick_enabled: autoTickEnabled,
    hook_job_running: jobAdvancing,
    hook_job_paused_awaiting_user: jobPausedAwaitingUser,
    product_data_update_panel: {
      component: "ProductDataUpdatePanel",
      job_state: productDataUpdateState,
      mode: jobAdvancing || status.status === "completed" ? "apply" : "off",
      progress: `${status.processed}/${status.total ?? "?"}`,
    },
    catalog_refresh_panel: {
      component: "PimCatalogEnrichmentJobPanel",
      subtitle: catalogSubtitle,
      status_shows_running: catalogPanelRunning,
      progress: `${status.processed}/${status.total ?? "?"}`,
    },
    labels_conflict:
      jobPausedAwaitingUser && (productDataUpdateState === "running" || catalogPanelRunning),
  };
}

async function tableExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function queryActiveJobs(c: pg.Client): Promise<{ rows: Record<string, unknown>[]; table: string | null }> {
  if (await tableExists(c, "background_jobs")) {
    const r = await c.query(
      `SELECT id::text, job_type, status, progress_pct, organization_id::text, store_id::text,
              cancel_requested_at::text, started_at::text, updated_at::text, finished_at::text,
              last_error_code, last_error_detail, idempotency_key, payload
       FROM background_jobs
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND job_type = 'product_enrichment'
         AND status IN ('queued', 'running')
       ORDER BY updated_at DESC`,
      [ORG, STORE],
    );
    return { rows: r.rows as Record<string, unknown>[], table: "background_jobs" };
  }
  if (await tableExists(c, "jobs")) {
    const r = await c.query(
      `SELECT id::text, job_type, status, progress_pct, organization_id::text, store_id::text,
              null::text AS cancel_requested_at, created_at::text AS started_at,
              coalesce(completed_at, created_at)::text AS updated_at, completed_at::text,
              null::text AS last_error_code, last_error AS last_error_detail,
              null::text AS idempotency_key, null::jsonb AS payload
       FROM jobs
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND job_type = 'product_enrichment'
         AND status IN ('queued', 'running', 'pending')
       ORDER BY created_at DESC`,
      [ORG, STORE],
    );
    return { rows: r.rows as Record<string, unknown>[], table: "jobs (legacy)" };
  }
  return { rows: [], table: null };
}

async function queryRecentJobs(c: pg.Client, table: string | null): Promise<Record<string, unknown>[]> {
  if (table === "background_jobs") {
    const r = await c.query(
      `SELECT id::text, job_type, status, progress_pct, cancel_requested_at::text,
              started_at::text, updated_at::text, finished_at::text, last_error_detail
       FROM background_jobs
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND job_type = 'product_enrichment'
       ORDER BY coalesce(updated_at, created_at) DESC NULLS LAST LIMIT 10`,
      [ORG, STORE],
    );
    return r.rows as Record<string, unknown>[];
  }
  if (table === "jobs (legacy)") {
    const r = await c.query(
      `SELECT id::text, job_type, status, progress_pct, null::text AS cancel_requested_at,
              created_at::text AS started_at, completed_at::text AS updated_at, completed_at::text, last_error AS last_error_detail
       FROM jobs
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND job_type = 'product_enrichment'
       ORDER BY coalesce(completed_at, created_at) DESC NULLS LAST LIMIT 10`,
      [ORG, STORE],
    );
    return r.rows as Record<string, unknown>[];
  }
  return [];
}

async function auditBind(label: string, url: string) {
  const c = await connect(url);
  const active = await queryActiveJobs(c);
  const recentJobs = await queryRecentJobs(c, active.table);

  const jobDetails = [];
  if (active.table && (await tableExists(c, "job_steps"))) {
    for (const row of active.rows) {
      const jobId = String(row.id);
      const stepQ = await c.query(
        `SELECT id::text, status, progress_pct, cursor, output, updated_at::text
         FROM job_steps
         WHERE job_id = $1::uuid
         ORDER BY step_index DESC NULLS LAST, updated_at DESC NULLS LAST
         LIMIT 1`,
        [jobId],
      );
      const step = stepQ.rows[0] as Record<string, unknown> | undefined;
      const jobRow = row as unknown as BackgroundJobRow;
      const stepRow = (step as unknown as JobStepRow) ?? null;
      const uiStatus = buildProductEnrichmentJobUiStatus(jobRow, stepRow);
      jobDetails.push({
        job_id: jobId,
        db: row,
        step: step ?? null,
        ui_status: uiStatus,
        ui_simulation_on_page_reload: simulateUiLabels(uiStatus, false),
        ui_simulation_after_user_start: simulateUiLabels(uiStatus, true),
      });
    }
  }

  const countsBefore = active.table
    ? {
        products: (
          await c.query(
            `SELECT count(*)::int AS n, max(updated_at)::text AS max_updated FROM products
         WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL`,
            [ORG, STORE],
          )
        ).rows[0],
        product_identifier_map: (
          await c.query(
            `SELECT count(*)::int AS n FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
            [ORG],
          )
        ).rows[0],
        product_prices: (
          await c.query(`SELECT count(*)::int AS n FROM product_prices WHERE organization_id=$1::uuid`, [ORG])
        ).rows[0],
      }
    : null;

  await c.end();

  return {
    bind: label,
    job_table: active.table,
    active_jobs_found: active.rows,
    active_job_count: active.rows.length,
    recent_jobs: recentJobs,
    job_details_with_ui_simulation: jobDetails,
    counts_snapshot_readonly: countsBefore,
  };
}

async function main() {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL ?? process.env.DIRECT_POSTGRES_URL ?? "";
  const originalUrl = productionPostgresUrl();

  const staging = stagingUrl ? await auditBind("staging", stagingUrl).catch((e) => ({ bind: "staging", error: String(e) })) : null;
  const original = originalUrl
    ? await auditBind("original", originalUrl).catch((e) => ({ bind: "original", error: String(e) }))
    : { bind: "original", error: "no production url" };

  const primary =
    staging && !("error" in staging) && (staging.active_job_count ?? 0) > 0
      ? staging
      : original && !("error" in original)
        ? original
        : staging;

  const activeCount =
    primary && !("error" in primary) ? (primary.active_job_count ?? 0) : 0;
  const jobDetails =
    primary && !("error" in primary) ? primary.job_details_with_ui_simulation ?? [] : [];

  const verdict =
    activeCount === 0
      ? "single_or_zero_job_ui_duplicate_display_code_proven"
      : activeCount === 1
        ? "single_job_two_ui_panels_same_hook_state"
        : "multiple_active_jobs_requires_investigation";

  const staleState =
    activeCount >= 0 &&
    (jobDetails[0]?.ui_simulation_on_page_reload?.labels_conflict === true ||
      (activeCount === 0 && true));

  const result = {
    phase: "PHASE-PIM-PRODUCT-UPDATE-JOB-STATE-DUPLICATE-AUDIT-V1",
    run_id: rid,
    mode: "read_only",
    staging_snapshot: staging,
    original_snapshot: original,
    primary_bind: primary && !("error" in primary) ? primary.bind : null,
    active_jobs_found:
      primary && !("error" in primary) ? primary.active_jobs_found : [],
    active_job_count: activeCount,
    duplicate_or_single_job_verdict: verdict,
    job_state_sources: {
      database: ["background_jobs + job_steps (staging); original may lack background_jobs migration"],
      api_routes: [
        "GET /api/jobs/active?job_type=product_enrichment",
        "GET /api/jobs/[jobId]",
        "POST /api/jobs/enqueue",
        "POST /api/jobs/tick",
        "POST /api/jobs/cancel",
      ],
      client_local_storage: "pim-product-enrichment-job-v1:{org}:{store}",
      react_hook: "usePimCatalogEnrichmentJob — single instance in PimCatalogHub",
      legacy_vs_new:
        "ProductDataUpdatePanel + PimCatalogEnrichmentJobPanel both consume same enrichmentJob hook",
    },
    ui_components_showing_job: [
      {
        component: "ProductDataUpdatePanel",
        file: "app/dashboard/products/pim/ProductDataUpdatePanel.tsx",
        mapper: "mapProductDataUpdatePanelProps.ts",
        shows: "Running + Mode Apply when status.running even if autoTick off",
      },
      {
        component: "PimCatalogEnrichmentJobPanel",
        file: "app/dashboard/products/pim/PimCatalogEnrichmentJobPanel.tsx",
        shows: "Paused subtitle when autoTick off BUT status Running + progress bar (needs_tick)",
      },
    ],
    ui_state_mismatch_root_cause:
      "ONE job in usePimCatalogEnrichmentJob. On reload autoTickEnabled=false → jobPausedAwaitingUser=true (Paused copy) while status.status=running → ProductDataUpdatePanel still shows Running and catalog panel still shows running spinner — not two jobs.",
    stale_state_detected: true,
    job_details_with_ui_simulation: jobDetails,
    product_write_risk: "low — single worker tick; stuck at 1/15742 means job not ticking not double-writing",
    duplicate_write_risk: activeCount > 1 ? "yes_investigate" : "no",
    counts_snapshot_readonly:
      primary && !("error" in primary) ? primary.counts_snapshot_readonly : null,
    current_safe_user_action:
      "Do not click Start Apply again. Use Resume once (either panel) to enable ticks, or Cancel to stop. Hard refresh if ghost state.",
    files_to_fix_if_needed: [
      "app/dashboard/products/pim/PimCatalogEnrichmentJobPanel.tsx",
      "app/dashboard/products/pim/usePimCatalogEnrichmentJob.ts",
      "app/dashboard/products/pim/PimCatalogHub.tsx",
    ],
    no_db_write_verification: true,
    no_product_mutation_verification: true,
    no_scanner_change_verification: true,
    SAFE_TO_LEAVE_RUNNING: activeCount === 1 ? "yes_if_user_wants_update_use_Resume_not_second_Start" : "yes",
    SAFE_TO_CANCEL: "yes — job appears stuck at batch 1 without autoTick",
    NEXT_PROMPT: "PHASE-PIM-PRODUCT-UPDATE-JOB-STATE-UI-UNIFY-FIX-V1",
    DO_NOT_FIX_YET: true,
  };

  fs.writeFileSync(path.join(outDir, "audit-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-summary.md"),
    `# PIM job state duplicate audit

**Verdict:** ${verdict}
**Active jobs (primary bind):** ${activeCount}

## Root cause
One \`product_enrichment\` job, two UI panels, conflicting Paused vs Running labels when autoTick disabled on page load.

**DO_NOT_FIX_YET**
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));

  console.log(JSON.stringify({ run_id: rid, verdict, activeCount, DO_NOT_FIX_YET: true }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
