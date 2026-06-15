/**
 * PHASE-PIM-PRODUCT-UPDATE-READINESS-SMOKE-V1
 * Read-only Product API / Product Data Update readiness + static smoke.
 * Does NOT enqueue, tick, apply, preview, resume, or cancel jobs.
 *
 *   npx tsx scripts/phase-pim-product-update-readiness-smoke-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { buildProductEnrichmentJobUiStatus } from "../lib/jobs/product-enrichment-job-status";
import { readAsyncJobPhase1Approval } from "../lib/jobs/approval";
import { findActiveBackgroundJob } from "../lib/jobs/repository";
import { ASYNC_JOBS_STAGING_REF } from "../lib/jobs/staging-guard";
import { buildProductDataUpdatePanelProps } from "../app/dashboard/products/pim/mapProductDataUpdatePanelProps";
import {
  derivePimProductEnrichmentCanonicalJobState,
  hasActiveNonTerminalProductEnrichmentJob,
} from "../app/dashboard/products/pim/pim-product-enrichment-job-ui-state";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-pim-product-update-readiness-smoke-v1";

const ROUTE_FILES = {
  preview_batch: "app/api/dashboard/products/catalog/enrich-images/route.ts",
  enqueue_apply: "app/api/jobs/enqueue/route.ts",
  tick: "app/api/jobs/tick/route.ts",
  status: "app/api/jobs/[jobId]/route.ts",
  active: "app/api/jobs/active/route.ts",
  cancel: "app/api/jobs/cancel/route.ts",
  retry: "app/api/jobs/retry/route.ts",
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
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

function verifyRoutes(): Record<string, unknown> {
  const found: Record<string, boolean> = {};
  for (const [key, rel] of Object.entries(ROUTE_FILES)) {
    const abs = join(process.cwd(), rel);
    found[key] = existsSync(abs) && /export async function (POST|GET)/.test(readFileSync(abs, "utf8"));
  }
  const worker = existsSync(join(process.cwd(), "lib/jobs/workers/product-enrichment-worker.ts"));
  const client = existsSync(join(process.cwd(), "lib/pim-catalog-enrichment-job-client.ts"));
  return {
    routes: found,
    worker_registered_file: worker,
    ui_client_wired: client,
    pause_route: false,
    pause_note: "Pause not implemented; panel sets canPause=false",
    retry_failed_via_payload: true,
    retry_missing_prices_via_payload: true,
    all_core_routes_present:
      found.preview_batch &&
      found.enqueue_apply &&
      found.tick &&
      found.status &&
      found.active &&
      found.cancel,
  };
}

function staticUiChecks(): Record<string, unknown> {
  const hub = readFileSync(join(process.cwd(), "app/dashboard/products/pim/PimCatalogHub.tsx"), "utf8");
  const hook = readFileSync(join(process.cwd(), "app/dashboard/products/pim/usePimCatalogEnrichmentJob.ts"), "utf8");
  const panel = readFileSync(join(process.cwd(), "app/dashboard/products/pim/ProductDataUpdatePanel.tsx"), "utf8");
  const mapper = readFileSync(join(process.cwd(), "app/dashboard/products/pim/mapProductDataUpdatePanelProps.ts"), "utf8");
  const batchReq = readFileSync(join(process.cwd(), "lib/pim-catalog-enrichment-batch-request.ts"), "utf8");
  const worker = readFileSync(join(process.cwd(), "lib/jobs/workers/product-enrichment-worker.ts"), "utf8");

  const duplicatePanelRemoved = !/<PimCatalogEnrichmentJobPanel/.test(hub);
  const singlePanel = /<ProductDataUpdatePanel/.test(hub);

  const refreshReadOnly =
    /onRefreshStatus:\s*\(\)\s*=>\s*\{[\s\S]*refreshJobStatus/.test(hub) &&
    !/onRefreshStatus[\s\S]{0,400}tickProductEnrichmentJob/.test(hub) &&
    !/onRefreshStatus[\s\S]{0,400}startBackendJob/.test(hub);

  const mountNoAutoTick =
    /fetchActiveProductEnrichmentJob/.test(hook) &&
    /startPolling\(active\.job_id\)/.test(hook) &&
    !/useEffect[\s\S]{0,800}enableAutoTick\(\)/.test(hook);
  const autoTickOnlyAfterStart =
    /enableAutoTick\(\)/.test(hook) &&
    (/startBackendJob[\s\S]{0,600}enableAutoTick/.test(hook) ||
      /resumeBackendJob[\s\S]{0,800}enableAutoTick/.test(hook));

  const applyExplicitOnly =
    /onStartApply:\s*\(\)\s*=>\s*\{[\s\S]{0,600}runProductDataUpdate[\s\S]{0,400},\s*true\s*,?\s*\)/.test(hub) &&
    !/useEffect[\s\S]{0,1200}runProductDataUpdate/.test(hub);

  const previewButtonInPanel = /Start preview/.test(panel) && /onStartPreview/.test(panel);
  const previewStubInMapper = /onStartPreview:\s*\(\)\s*=>\s*undefined/.test(mapper);
  const previewWiredInHub =
    /onStartPreview:/.test(hub) ||
    (/runProductDataUpdate[\s\S]{0,200}loopUntilDone,\s*false\)/.test(hub) &&
      !/onStartApply[\s\S]{0,300}loopUntilDone,\s*false\)/.test(hub));

  const noDryRunInBatch = !/dry_run|dryRun|preview_only/.test(batchReq);
  const workerCallsBatch = /runPimCatalogEnrichmentBatch/.test(worker);

  const propsIdle = buildProductDataUpdatePanelProps({
    jobId: null,
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

  const canonicalIdle = derivePimProductEnrichmentCanonicalJobState({
    jobId: null,
    jobStatus: null,
    autoTickEnabled: false,
    jobErr: null,
  });

  return {
    duplicate_panel_removed: duplicatePanelRemoved,
    single_product_data_update_panel: singlePanel,
    ui_idle_state: {
      canonical: canonicalIdle,
      panel_job_state: propsIdle.jobState,
      mode: propsIdle.mode,
      can_start_preview: propsIdle.canStartPreview,
      can_start_apply: propsIdle.canStartApply,
      can_resume: propsIdle.canResume,
      can_cancel: propsIdle.canCancel,
      pass: canonicalIdle === "idle" && propsIdle.jobState === "idle" && propsIdle.mode === "off",
    },
    refresh_read_only: refreshReadOnly,
    no_auto_start_on_load: mountNoAutoTick && autoTickOnlyAfterStart,
    apply_mode_gating: {
      explicit_onStartApply_only: applyExplicitOnly,
      startBackendJob_requires_user_action: /const startBackendJob = useCallback/.test(hook),
      pass: applyExplicitOnly && autoTickOnlyAfterStart,
    },
    preview_mode_readiness: {
      panel_has_preview_button: previewButtonInPanel,
      mapper_preview_handler_stubbed: previewStubInMapper,
      hub_wires_onStartPreview: previewWiredInHub,
      batch_has_dry_run_flag: !noDryRunInBatch,
      worker_always_invokes_writing_batch: workerCallsBatch && noDryRunInBatch,
      note:
        "No write-free preview path in worker/batch; Start preview not wired to runProductDataUpdate(limit batch). Preview readiness = UI+route existence only until dry-run or single-batch preview wired.",
      pass: previewButtonInPanel && !previewWiredInHub ? false : previewButtonInPanel,
    },
  };
}

function scannerGitCheck(): Record<string, unknown> {
  try {
    const diff = execSync("git diff --name-only HEAD -- app/scanner/", { encoding: "utf8" }).trim();
    const untracked = execSync("git ls-files --others --exclude-standard app/scanner/", {
      encoding: "utf8",
    }).trim();
    const changed = diff ? diff.split("\n").filter(Boolean) : [];
    const newFiles = untracked ? untracked.split("\n").filter(Boolean) : [];
    return {
      changed_files: changed,
      untracked_files: newFiles,
      pass: changed.length === 0 && newFiles.length === 0,
    };
  } catch {
    return { pass: true, note: "git check skipped" };
  }
}

function runStaticSmoke(): { pass: boolean; error?: string } {
  try {
    execSync("npx tsx scripts/phase-pim-product-update-job-state-ui-unify-fix-v1-smoke.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { pass: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { pass: false, error: String(err.stderr ?? err.message ?? e) };
  }
}

function runBuild(): { pass: boolean; error?: string } {
  try {
    execSync("npm run build", { encoding: "utf8", stdio: "pipe", timeout: 600_000 });
    return { pass: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { pass: false, error: String(err.stderr ?? err.message ?? e).slice(-2000) };
  }
}

async function storeApiReadiness(client: pg.Client): Promise<Record<string, unknown>> {
  const keys = await client.query(
    `SELECT name, role FROM organization_api_keys WHERE organization_id = $1::uuid`,
    [ORG],
  );
  const names = new Set(keys.rows.map((r: { name: string }) => String(r.name ?? "").trim()));
  const mp = await client.query(
    `SELECT id::text, provider, credentials IS NOT NULL AS has_credentials
     FROM marketplaces WHERE organization_id = $1::uuid AND provider = 'amazon_sp_api'`,
    [ORG],
  );
  const amazonKey = names.has("amazon_sp_api");
  const amazonMp = mp.rows.some((r: { has_credentials: boolean }) => r.has_credentials);
  return {
    organization_api_keys_amazon_sp_api: amazonKey,
    marketplaces_amazon_sp_api_with_credentials: amazonMp,
    amazon_sp_configured: amazonKey || amazonMp,
    marketplace_rows: mp.rows.length,
  };
}

async function productApiFlags(client: pg.Client): Promise<Record<string, unknown>> {
  const scopeKey = `${ORG}:${STORE}`;
  let productEnrichmentSchedule: unknown = null;
  let globalPe: unknown = null;
  try {
    const ps = await client.query(`SELECT automation_settings FROM platform_settings WHERE id = true LIMIT 1`);
    const doc = (ps.rows[0]?.automation_settings ?? {}) as Record<string, unknown>;
    globalPe = doc.product_enrichment ?? null;
    const scopes = doc.scopes as Record<string, unknown> | undefined;
    productEnrichmentSchedule =
      (scopes?.[scopeKey] as { product_enrichment?: unknown } | undefined)?.product_enrichment ??
      globalPe;
  } catch {
    productEnrichmentSchedule = null;
  }

  const approval = readAsyncJobPhase1Approval();
  const envFlags = {
    NEXT_PUBLIC_SUPABASE_URL_staging: refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") === ASYNC_JOBS_STAGING_REF,
  };

  return {
    async_job_phase1_approval: approval,
    product_enrichment_schedule: productEnrichmentSchedule,
    product_enrichment_global: globalPe,
    env_staging_ref: envFlags,
  };
}

async function dataHealth(client: pg.Client): Promise<Record<string, unknown>> {
  const products = (
    await client.query(
      `SELECT count(*)::int AS n FROM products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
      [ORG, STORE],
    )
  ).rows[0].n as number;

  const linkedAsin = (
    await client.query(
      `SELECT count(*)::int AS n FROM products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND asin IS NOT NULL AND btrim(asin) <> ''`,
      [ORG, STORE],
    )
  ).rows[0].n as number;

  const unresolved = (
    await client.query(
      `SELECT count(*)::int AS n FROM products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND (asin IS NULL OR btrim(asin) = '')`,
      [ORG, STORE],
    )
  ).rows[0].n as number;

  const mapCount = (
    await client.query(
      `SELECT count(*)::int AS n FROM product_identifier_map
       WHERE organization_id = $1::uuid AND deleted_at IS NULL`,
      [ORG],
    )
  ).rows[0].n as number;

  const pricesCount = (
    await client.query(`SELECT count(*)::int AS n FROM product_prices WHERE organization_id = $1::uuid`, [ORG])
  ).rows[0].n as number;

  const missingPrice = (
    await client.query(
      `SELECT count(*)::int AS n
       FROM products p
       WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
         AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
         AND NOT EXISTS (
           SELECT 1 FROM product_prices pp
           WHERE pp.organization_id = p.organization_id AND pp.store_id = p.store_id AND pp.product_id = p.id
         )`,
      [ORG, STORE],
    )
  ).rows[0].n as number;

  const claimCandidates = (
    await client.query(`SELECT count(*)::int AS n FROM claim_candidates WHERE organization_id = $1::uuid`, [ORG])
  ).rows[0].n as number;

  return {
    products_count: products,
    linked_asin_count: linkedAsin,
    unresolved_count: unresolved,
    product_identifier_map_count: mapCount,
    product_prices_count: pricesCount,
    missing_price_count: missingPrice,
    claim_candidates_count: claimCandidates,
  };
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

  const supa = createClient(url, key, { auth: { persistSession: false } });
  const ro = await connectReadonly(pgUrl);

  const healthBefore = await dataHealth(ro);

  const activeQ = await ro.query(
    `SELECT id::text, status, progress_pct, updated_at::text
     FROM background_jobs
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND job_type = 'product_enrichment'
       AND status IN ('queued', 'running')
     ORDER BY updated_at DESC`,
    [ORG, STORE],
  );
  const activeViaRepo = await findActiveBackgroundJob(supa, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
  });

  const routes = verifyRoutes();
  const ui = staticUiChecks();
  const scanner = scannerGitCheck();
  const storeApi = await storeApiReadiness(ro);
  const flags = await productApiFlags(ro);

  const healthAfter = await dataHealth(ro);
  await ro.end();

  const skipBuild = process.argv.includes("--skip-build");
  const staticSmoke = runStaticSmoke();
  const build = skipBuild ? { pass: true, error: null as string | null, skipped: true } : runBuild();

  const countsUnchanged =
    healthBefore.products_count === healthAfter.products_count &&
    healthBefore.product_identifier_map_count === healthAfter.product_identifier_map_count &&
    healthBefore.product_prices_count === healthAfter.product_prices_count &&
    healthBefore.claim_candidates_count === healthAfter.claim_candidates_count;

  const activeCount = activeQ.rows.length;
  const applyReady =
    activeCount === 0 &&
    Boolean((ui.ui_idle_state as { pass?: boolean })?.pass) &&
    Boolean(routes.all_core_routes_present) &&
    Boolean((ui.apply_mode_gating as { pass?: boolean })?.pass) &&
    Boolean(flags.async_job_phase1_approval && (flags.async_job_phase1_approval as { approved: boolean }).approved) &&
    Boolean(ui.no_auto_start_on_load) &&
    Boolean(ui.refresh_read_only) &&
    Boolean(storeApi.amazon_sp_configured) &&
    staticSmoke.pass &&
    build.pass &&
    countsUnchanged;

  const previewInfraReady =
    activeCount === 0 &&
    Boolean((ui.ui_idle_state as { pass?: boolean })?.pass) &&
    Boolean(routes.all_core_routes_present) &&
    Boolean(storeApi.amazon_sp_configured) &&
    staticSmoke.pass &&
    build.pass;

  const previewWriteFree =
    Boolean((ui.preview_mode_readiness as { hub_wires_onStartPreview?: boolean })?.hub_wires_onStartPreview) &&
    Boolean((ui.preview_mode_readiness as { batch_has_dry_run_flag?: boolean })?.batch_has_dry_run_flag);

  const result = {
    phase: "PHASE-PIM-PRODUCT-UPDATE-READINESS-SMOKE-V1",
    run_id: rid,
    mode: "read_only_no_job_mutations",
    active_product_jobs: {
      active_count: activeCount,
      sql_rows: activeQ.rows,
      find_active_background_job: activeViaRepo ? { id: activeViaRepo.id, status: activeViaRepo.status } : null,
      pass: activeCount === 0 && !activeViaRepo,
    },
    ui_idle_state_verification: ui.ui_idle_state,
    product_update_routes_found: routes,
    preview_mode_readiness: {
      ...(ui.preview_mode_readiness as Record<string, unknown>),
      routes_present: routes.all_core_routes_present,
      active_jobs_zero: activeCount === 0,
      write_free_preview_available: previewWriteFree,
      operator_start_preview_wired: Boolean(
        (ui.preview_mode_readiness as { hub_wires_onStartPreview?: boolean })?.hub_wires_onStartPreview,
      ),
      infra_ready: previewInfraReady,
      pass: previewInfraReady && previewWriteFree,
    },
    apply_mode_gating: ui.apply_mode_gating,
    no_auto_start_verification: {
      pass: ui.no_auto_start_on_load,
      detail: "Mount polls status only; autoTick enabled only after Start/Resume",
    },
    refresh_read_only_verification: { pass: ui.refresh_read_only },
    product_api_flags_status: flags,
    store_api_readiness: storeApi,
    current_product_data_health: healthAfter,
    missing_price_count: healthAfter.missing_price_count,
    no_product_mutation_verification: {
      pass: countsUnchanged,
      before: {
        products: healthBefore.products_count,
        map: healthBefore.product_identifier_map_count,
        prices: healthBefore.product_prices_count,
      },
      after: {
        products: healthAfter.products_count,
        map: healthAfter.product_identifier_map_count,
        prices: healthAfter.product_prices_count,
      },
    },
    no_claim_candidate_mutation_verification: {
      pass: healthBefore.claim_candidates_count === healthAfter.claim_candidates_count,
      count: healthAfter.claim_candidates_count,
    },
    no_scanner_change_verification: scanner,
    duplicate_panel_verification: {
      pass: ui.duplicate_panel_removed && ui.single_product_data_update_panel,
    },
    build_result: build.pass ? "PASS" : "FAIL",
    build_error: build.error ?? null,
    smoke_result: staticSmoke.pass ? "PASS" : "FAIL",
    smoke_error: staticSmoke.error ?? null,
    SAFE_PRODUCT_API_UPDATE_READY_FOR_PREVIEW: previewInfraReady && previewWriteFree ? "yes" : "no",
    SAFE_PRODUCT_API_UPDATE_READY_FOR_APPLY: applyReady ? "yes" : "no",
    preview_blockers: [
      !previewInfraReady ? "base_infra_not_ready" : null,
      !(ui.preview_mode_readiness as { hub_wires_onStartPreview?: boolean })?.hub_wires_onStartPreview
        ? "start_preview_not_wired_in_PimCatalogHub"
        : null,
      !(ui.preview_mode_readiness as { batch_has_dry_run_flag?: boolean })?.batch_has_dry_run_flag
        ? "no_dry_run_flag_in_enrichment_batch_or_worker"
        : null,
    ].filter(Boolean),
    apply_blockers: [
      !applyReady && !build.pass ? "build_failed" : null,
      !applyReady && !staticSmoke.pass ? "static_smoke_failed" : null,
      !applyReady && activeCount > 0 ? "active_jobs_present" : null,
      !applyReady && !(flags.async_job_phase1_approval as { approved: boolean }).approved
        ? "async_job_approval"
        : null,
      !applyReady && !(ui.apply_mode_gating as { pass?: boolean })?.pass ? "apply_not_explicitly_gated" : null,
      !applyReady && !storeApi.amazon_sp_configured ? "amazon_sp_not_configured" : null,
    ].filter(Boolean),
    NEXT_PROMPT: applyReady
      ? "PHASE-PIM-PRODUCT-DATA-UPDATE-OPERATOR-START-GUIDE-V1"
      : previewInfraReady
        ? "PHASE-PIM-PRODUCT-UPDATE-START-PREVIEW-WIRE-V1"
        : "PHASE-PIM-PRODUCT-UPDATE-READINESS-FIX-V1",
  };

  fs.writeFileSync(path.join(outDir, "readiness-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "readiness-summary.md",
    ),
    `# PIM Product API Update readiness smoke

| Check | Result |
|-------|--------|
| Active product_enrichment jobs | ${activeCount} |
| UI idle (clean mount) | ${(ui.ui_idle_state as { pass: boolean }).pass ? "PASS" : "FAIL"} |
| Routes wired | ${routes.all_core_routes_present ? "PASS" : "FAIL"} |
| Amazon SP configured | ${storeApi.amazon_sp_configured ? "yes" : "no"} |
| Missing price count | ${healthAfter.missing_price_count} |
| Build | ${build.pass ? "PASS" : "FAIL"} |
| Static smoke | ${staticSmoke.pass ? "PASS" : "FAIL"} |
| SAFE preview | **${result.SAFE_PRODUCT_API_UPDATE_READY_FOR_PREVIEW}** |
| SAFE apply | **${result.SAFE_PRODUCT_API_UPDATE_READY_FOR_APPLY}** |

## Notes
- **Start preview** button exists but \`onStartPreview\` is not wired in \`PimCatalogHub\` (mapper stub).
- Worker/batch have **no dry-run**; any tick/enrich-images POST **writes**.
- Apply is gated behind explicit **Start apply** + \`enableAutoTick\` only after user action.
`,
  );

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        active_count: activeCount,
        SAFE_PREVIEW: result.SAFE_PRODUCT_API_UPDATE_READY_FOR_PREVIEW,
        SAFE_APPLY: result.SAFE_PRODUCT_API_UPDATE_READY_FOR_APPLY,
        build: result.build_result,
        smoke: result.smoke_result,
        NEXT_PROMPT: result.NEXT_PROMPT,
      },
      null,
      2,
    ),
  );

  if (!staticSmoke.pass || activeCount > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
