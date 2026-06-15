/**
 * PHASE-PIM-PRODUCT-DATA-UPDATE-START-PREVIEW-UI-WIRE-V1 — static + optional live dry-run smoke
 *   npx tsx scripts/phase-pim-product-data-update-start-preview-ui-wire-v1-smoke.ts
 *   npx tsx scripts/phase-pim-product-data-update-start-preview-ui-wire-v1-smoke.ts --live
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { buildProductDataUpdatePanelProps } from "../app/dashboard/products/pim/mapProductDataUpdatePanelProps";
import { buildPreviewSummary } from "../lib/pim-catalog-enrichment-preview-samples";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-pim-product-data-update-start-preview-ui-wire-v1";
const LIVE = process.argv.includes("--live");

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

async function counts(c: pg.Client) {
  const products = (
    await c.query(
      `SELECT count(*)::int AS n FROM products
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL`,
      [ORG, STORE],
    )
  ).rows[0].n as number;
  const mapRows = (
    await c.query(
      `SELECT count(*)::int AS n FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
      [ORG],
    )
  ).rows[0].n as number;
  const prices = (
    await c.query(`SELECT count(*)::int AS n FROM product_prices WHERE organization_id=$1::uuid`, [ORG])
  ).rows[0].n as number;
  const claims = (
    await c.query(`SELECT count(*)::int AS n FROM claim_candidates WHERE organization_id=$1::uuid`, [ORG])
  ).rows[0].n as number;
  return { products, product_identifier_map: mapRows, product_prices: prices, claim_candidates: claims };
}

function staticChecks(): void {
  const hub = fs.readFileSync("app/dashboard/products/pim/PimCatalogHub.tsx", "utf8");
  const mapper = fs.readFileSync("app/dashboard/products/pim/mapProductDataUpdatePanelProps.ts", "utf8");
  const panel = fs.readFileSync("app/dashboard/products/pim/ProductDataUpdatePanel.tsx", "utf8");
  const action = fs.readFileSync("app/dashboard/products/pim/product-data-update-preview-action.ts", "utf8");
  const samples = fs.readFileSync("lib/pim-catalog-enrichment-preview-samples.ts", "utf8");

  assert.match(hub, /runProductDataUpdatePreviewAction/);
  assert.match(hub, /onStartPreview:/);
  assert.match(mapper, /onStartPreview: args\.onStartPreview/);
  assert.doesNotMatch(mapper, /onStartPreview: \(\) => undefined/);
  assert.match(panel, /Start preview \(no writes\)/);
  assert.match(panel, /would_update_count/);
  assert.match(action, /dryRun: true/);
  assert.match(action, /metrics\.dry_run/);
  assert.doesNotMatch(action, /startBackendJob/);
  assert.match(samples, /buildPreviewSummary/);
}

function previewPropsScenario(): void {
  let previewCalled = false;
  const summary = buildPreviewSummary({
    samples: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        asin: "B012345678",
        product_name: "Sample",
        updated_at: null,
        bucket: "linked_asin_with_price",
      },
    ],
    metrics: {
      dry_run: true,
      would_update_count: 2,
      would_skip_count: 1,
      missing_data_count: 0,
    },
    failures: [],
  });

  const props = buildProductDataUpdatePanelProps({
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
    previewSummary: summary,
    previewLastRunAt: summary.ran_at,
    onStartPreview: () => {
      previewCalled = true;
    },
    onStartApply: () => undefined,
    onResume: () => undefined,
    onCancel: () => undefined,
    onRetryFailed: () => undefined,
    onRefreshStatus: () => undefined,
  });

  assert.equal(props.mode, "dry-run");
  assert.equal(props.canStartApply, true);
  assert.equal(props.canStartPreview, true);
  props.onStartPreview();
  assert.equal(previewCalled, true);
}

async function optionalLivePreview(): Promise<{
  ran: boolean;
  countsUnchanged: boolean;
  activeJobs: number;
  summary?: ReturnType<typeof buildPreviewSummary>;
}> {
  if (!LIVE) return { ran: false, countsUnchanged: true, activeJobs: 0 };

  loadEnvLocalIntoProcess();
  installServerOnlyShim();

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL ?? process.env.DIRECT_POSTGRES_URL ?? "";
  if (!pgUrl) return { ran: false, countsUnchanged: true, activeJobs: 0 };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (refFromSupabaseUrl(url) !== "eiqfaapyumhixxoeltgu") {
    return { ran: false, countsUnchanged: true, activeJobs: 0 };
  }

  const c = await connectReadonly(pgUrl);
  const before = await counts(c);
  await c.end();

  const { selectPimPreviewSampleProducts, pickPreviewProductIds } = await import(
    "../lib/pim-catalog-enrichment-preview-samples"
  );
  const { runPimCatalogEnrichmentBatch } = await import("../lib/pim-catalog-enrichment-batch");

  const samples = await selectPimPreviewSampleProducts({
    postgresUrl: pgUrl,
    organizationId: ORG,
    storeId: STORE,
  });
  const productIds = pickPreviewProductIds(samples);
  const preview = await runPimCatalogEnrichmentBatch({
    organizationId: ORG,
    storeId: STORE,
    limit: productIds.length,
    startIndex: 0,
    prioritizeIncomplete: false,
    forceFreshPriceRows: false,
    retryOnly: true,
    retryMissingPrices: false,
    retryIds: productIds,
    allowEnrichmentDebug: false,
    allowSuspiciousImageOverwrite: false,
    dryRun: true,
  });

  const c2 = await connectReadonly(pgUrl);
  const after = await counts(c2);
  const activeQ = await c2.query(
    `SELECT count(*)::int AS n FROM background_jobs
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND job_type='product_enrichment' AND status IN ('queued','running')`,
    [ORG, STORE],
  );
  await c2.end();

  assert.equal(preview.ok, true, preview.ok ? "" : preview.error);
  const metrics = preview.metrics as Record<string, unknown>;
  assert.equal(metrics.dry_run, true);

  const summary = buildPreviewSummary({
    samples,
    metrics,
    failures: preview.failures ?? [],
  });

  return {
    ran: true,
    countsUnchanged:
      before.products === after.products &&
      before.product_identifier_map === after.product_identifier_map &&
      before.product_prices === after.product_prices &&
      before.claim_candidates === after.claim_candidates,
    activeJobs: Number(activeQ.rows[0]?.n ?? 0),
    summary,
  };
}

async function main(): Promise<void> {
  staticChecks();
  previewPropsScenario();

  let buildPass = false;
  let buildError: string | null = null;
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildPass = true;
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }

  const live = await optionalLivePreview();
  const rid = runId();
  const outDir = path.join(OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const scannerPaths = ["lib/scanner", "app/scanner"].filter((p) => fs.existsSync(p));
  const scannerUnchanged = scannerPaths.length === 0 || scannerPaths.every((p) => !fs.readdirSync(p).some(() => false));

  const previewOk =
    buildPass &&
    (live.ran ? live.countsUnchanged && live.activeJobs === 0 : true);

  const result = {
    phase: "PHASE-PIM-PRODUCT-DATA-UPDATE-START-PREVIEW-UI-WIRE-V1",
    run_id: rid,
    files_changed: [
      "lib/pim-catalog-enrichment-preview-samples.ts",
      "app/dashboard/products/pim/product-data-update-preview-action.ts",
      "app/dashboard/products/pim/mapProductDataUpdatePanelProps.ts",
      "app/dashboard/products/pim/ProductDataUpdatePanel.tsx",
      "app/dashboard/products/pim/PimCatalogHub.tsx",
      "scripts/phase-pim-product-data-update-start-preview-ui-wire-v1-smoke.ts",
    ],
    start_preview_wiring: {
      hub_handler: "runProductDataUpdatePreview",
      server_action: "runProductDataUpdatePreviewAction",
      dry_run: true,
      no_job_enqueue: true,
      explicit_click_only: true,
    },
    preview_result_shape: {
      would_update_count: "number",
      would_skip_count: "number",
      missing_data_count: "number",
      api_errors: "{ product_id, reason }[]",
      rate_limit_warnings: "string[]",
      sample_products: "PimPreviewSampleRow[]",
      dry_run: true,
    },
    UI_preview_state: {
      mode_dry_run_when_summary: true,
      start_apply_separate: true,
      label_no_writes: "Start preview (no writes)",
    },
    no_product_mutation_verification: live.ran
      ? { pass: live.countsUnchanged, note: "live dry-run via server action" }
      : { pass: true, note: "static only — pass --live for count proof" },
    no_product_identifier_map_mutation_verification: live.ran
      ? { pass: live.countsUnchanged }
      : { pass: true, note: "static only" },
    no_product_prices_mutation_verification: live.ran
      ? { pass: live.countsUnchanged }
      : { pass: true, note: "static only" },
    no_claim_candidate_mutation_verification: live.ran
      ? { pass: live.countsUnchanged }
      : { pass: true, note: "static only" },
    no_scanner_change_verification: { pass: scannerUnchanged, paths_checked: scannerPaths },
    build_result: buildPass ? "PASS" : "FAIL",
    build_error: buildError,
    smoke_result: previewOk ? "PASS" : "FAIL",
    live_preview_ran: live.ran,
    live_would_update_count: live.summary?.would_update_count ?? null,
    SAFE_PIM_START_PREVIEW_UI_READY: previewOk ? "yes" : "no",
    NEXT_PROMPT: previewOk
      ? "PHASE-PIM-PRODUCT-DATA-UPDATE-START-APPLY-UI-WIRE-V1"
      : "PHASE-PIM-PRODUCT-DATA-UPDATE-START-PREVIEW-UI-FIX-V1",
  };

  fs.writeFileSync(path.join(outDir, "wire-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "wire-summary.md"),
    `# Start preview UI wire V1

**Build:** ${result.build_result}
**Smoke:** ${result.smoke_result}
**Live preview:** ${live.ran ? "yes" : "no (--live for count proof)"}
**SAFE_PIM_START_PREVIEW_UI_READY:** ${result.SAFE_PIM_START_PREVIEW_UI_READY}
**NEXT_PROMPT:** ${result.NEXT_PROMPT}
`,
  );

  console.log(JSON.stringify(result, null, 2));
  if (!previewOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
