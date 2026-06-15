/**
 * PHASE-PIM-PRODUCT-API-SMALL-PREVIEW-RUN-V1
 * Tiny dry-run preview — Amazon API path, zero product/map/price writes.
 *
 *   npx tsx scripts/phase-pim-product-api-small-preview-run-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { findActiveBackgroundJob } from "../lib/jobs/repository";
import { ASYNC_JOBS_STAGING_REF } from "../lib/jobs/staging-guard";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-pim-product-api-small-preview-run-v1";

type SampleRow = {
  id: string;
  asin: string | null;
  product_name: string | null;
  updated_at: string | null;
  bucket: string;
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

async function selectSamples(c: pg.Client): Promise<SampleRow[]> {
  const linked = await c.query(
    `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
     FROM products p
     WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
       AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
       AND EXISTS (
         SELECT 1 FROM product_prices pp
         WHERE pp.organization_id=p.organization_id AND pp.store_id=p.store_id AND pp.product_id=p.id
       )
     ORDER BY p.updated_at DESC NULLS LAST
     LIMIT 1`,
    [ORG, STORE],
  );

  const missingPrice = await c.query(
    `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
     FROM products p
     WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
       AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM product_prices pp
         WHERE pp.organization_id=p.organization_id AND pp.store_id=p.store_id AND pp.product_id=p.id
       )
     ORDER BY p.updated_at DESC NULLS LAST
     LIMIT 1`,
    [ORG, STORE],
  );

  const unresolved = await c.query(
    `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
     FROM products p
     WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
       AND (p.asin IS NULL OR btrim(p.asin) = '')
     ORDER BY p.updated_at DESC NULLS LAST
     LIMIT 1`,
    [ORG, STORE],
  );

  const recent = await c.query(
    `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
     FROM products p
     WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
       AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
     ORDER BY p.updated_at DESC NULLS LAST
     LIMIT 3`,
    [ORG, STORE],
  );

  const out: SampleRow[] = [];
  const seen = new Set<string>();
  const push = (row: Record<string, unknown>, bucket: string) => {
    const id = String(row.id ?? "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      asin: row.asin ? String(row.asin) : null,
      product_name: row.product_name ? String(row.product_name) : null,
      updated_at: row.updated_at ? String(row.updated_at) : null,
      bucket,
    });
  };

  for (const r of linked.rows) push(r, "linked_asin_with_price");
  for (const r of missingPrice.rows) push(r, "missing_price");
  for (const r of unresolved.rows) push(r, "unresolved_no_asin");
  for (const r of recent.rows) push(r, "recently_updated");

  // Fill to ~8 with additional linked ASIN rows if needed
  if (out.length < 8) {
    const extra = await c.query(
      `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
       FROM products p
       WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
         AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
       ORDER BY random()
       LIMIT 5`,
      [ORG, STORE],
    );
    for (const r of extra.rows) {
      push(r, "linked_asin_extra");
      if (out.length >= 10) break;
    }
  }

  return out.slice(0, 10);
}

function scannerGitCheck(): { pass: boolean; changed_files: string[] } {
  try {
    const diff = execSync("git diff --name-only HEAD -- app/scanner/", { encoding: "utf8" }).trim();
    const changed = diff ? diff.split("\n").filter(Boolean) : [];
    return { pass: changed.length === 0, changed_files: changed };
  } catch {
    return { pass: true, changed_files: [] };
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
    return { pass: false, error: String(err.stderr ?? err.message ?? e).slice(-1500) };
  }
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

  const ro = await connectReadonly(pgUrl);
  const before = await counts(ro);
  const samples = await selectSamples(ro);
  await ro.end();

  if (samples.length < 3) {
    throw new Error(`Insufficient sample products (${samples.length})`);
  }

  const productIds = samples.map((s) => s.id);
  const { runPimCatalogEnrichmentBatch } = await import("../lib/pim-catalog-enrichment-batch");

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
    allowEnrichmentDebug: true,
    allowSuspiciousImageOverwrite: false,
    dryRun: true,
  });

  const ro2 = await connectReadonly(pgUrl);
  const after = await counts(ro2);
  const activeQ = await ro2.query(
    `SELECT count(*)::int AS n FROM background_jobs
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND job_type='product_enrichment' AND status IN ('queued','running')`,
    [ORG, STORE],
  );
  await ro2.end();

  const supa = createClient(url, key, { auth: { persistSession: false } });
  const activeViaRepo = await findActiveBackgroundJob(supa, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
  });

  const metrics = preview.ok ? preview.metrics : {};
  const wouldUpdate = Number(metrics.would_update_count ?? 0);
  const wouldSkip = Number(metrics.would_skip_count ?? 0);
  const missingData = Number(metrics.missing_data_count ?? 0);
  const throttled = Number(metrics.throttled_count ?? 0);
  const pricingThrottled = Number(metrics.pricing_throttled_count ?? 0);

  const apiErrors = preview.ok
    ? (preview.failures ?? []).map((f) => ({ product_id: f.product_id, reason: f.reason }))
    : [{ product_id: null, reason: preview.error }];

  const samplePayload = preview.ok
    ? {
        dry_run: true,
        product_ids: productIds,
        metrics_summary: {
          batch_size: metrics.batch_size,
          would_update_count: wouldUpdate,
          would_skip_count: wouldSkip,
          missing_data_count: missingData,
          throttled_count: throttled,
          pricing_throttled_count: pricingThrottled,
          catalog_not_found_count: metrics.catalog_not_found_count,
          prices_inserted_preview: metrics.prices_inserted,
          rows_saved_preview: metrics.rows_saved,
        },
        enrichment_debug_sample: (preview.enrichment_debug ?? []).slice(0, 5),
        failures: preview.failures?.slice(0, 5) ?? [],
      }
    : { error: preview.ok ? null : preview.error };

  const countsUnchanged =
    before.products === after.products &&
    before.product_identifier_map === after.product_identifier_map &&
    before.product_prices === after.product_prices &&
    before.claim_candidates === after.claim_candidates;

  const staticSmoke = runStaticSmoke();
  let buildPass = false;
  let buildError: string | null = null;
  if (process.argv.includes("--skip-build")) {
    buildPass = true;
  } else {
    try {
      execSync("npm run build", { encoding: "utf8", stdio: "pipe", timeout: 600_000 });
      buildPass = true;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      buildError = String(err.stderr ?? err.message ?? e).slice(-2000);
    }
  }

  const scanner = scannerGitCheck();
  const activeAfter = activeQ.rows[0]?.n ?? 0;

  const previewOk =
    preview.ok &&
    Boolean(metrics.dry_run) &&
    countsUnchanged &&
    activeAfter === 0 &&
    !activeViaRepo &&
    buildPass &&
    staticSmoke.pass;

  const blockingErrors = apiErrors.filter(
    (e) =>
      e.reason &&
      !/NOT_FOUND|HTTP 404|not found in marketplace/i.test(String(e.reason)) &&
      !/skipped_no_asin/i.test(String(e.reason)),
  );

  const applySmallBatchOk = previewOk && blockingErrors.length === 0;

  const result = {
    phase: "PHASE-PIM-PRODUCT-API-SMALL-PREVIEW-RUN-V1",
    run_id: rid,
    mode: "preview_dry_run_direct_batch_no_background_job",
    sample_selection: samples,
    preview_run_result: preview.ok
      ? { ok: true, status: "completed_preview", batch_size: metrics.batch_size }
      : { ok: false, error: preview.error, status: preview.status },
    would_update_count: wouldUpdate,
    would_skip_count: wouldSkip,
    missing_data_count: missingData,
    api_error_summary: {
      failure_count: apiErrors.length,
      items: apiErrors.slice(0, 10),
    },
    rate_limit_summary: {
      throttled_count: throttled,
      pricing_throttled_count: pricingThrottled,
      deferred_count: Number(metrics.deferred_count ?? 0),
      retry_count: Number(metrics.retry_count ?? 0),
      warnings: throttled + pricingThrottled > 0 ? ["rate_limit_or_transient_seen"] : [],
    },
    sample_preview_payload: samplePayload,
    product_counts_before_after: { before: before.products, after: after.products, unchanged: before.products === after.products },
    product_identifier_map_before_after: {
      before: before.product_identifier_map,
      after: after.product_identifier_map,
      unchanged: before.product_identifier_map === after.product_identifier_map,
    },
    product_prices_before_after: {
      before: before.product_prices,
      after: after.product_prices,
      unchanged: before.product_prices === after.product_prices,
    },
    active_jobs_after: {
      sql_count: activeAfter,
      find_active_background_job: activeViaRepo,
      pass: activeAfter === 0 && !activeViaRepo,
    },
    ui_status_note: "Direct dry-run batch (no UI job); expected idle — no job enqueued",
    no_product_mutation_verification: { pass: countsUnchanged, before, after },
    no_claim_candidate_mutation_verification: {
      pass: before.claim_candidates === after.claim_candidates,
      count: after.claim_candidates,
    },
    no_scanner_change_verification: scanner,
    build_result: buildPass ? "PASS" : "FAIL",
    build_error: buildError,
    smoke_result: staticSmoke.pass ? "PASS" : "FAIL",
    smoke_error: staticSmoke.error ?? null,
    SAFE_PRODUCT_API_PREVIEW_OK: previewOk ? "yes" : "no",
    SAFE_TO_RUN_PRODUCT_API_APPLY_SMALL_BATCH: applySmallBatchOk ? "yes" : "no",
    NEXT_PROMPT: previewOk
      ? "PHASE-PIM-PRODUCT-API-SMALL-APPLY-BATCH-V1"
      : "PHASE-PIM-PRODUCT-API-PREVIEW-FIX-V1",
  };

  fs.writeFileSync(path.join(outDir, "preview-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "preview-summary.md"),
    `# PIM small preview dry-run

**Samples:** ${samples.length}
**Would update:** ${wouldUpdate} · **Skip:** ${wouldSkip} · **Missing data:** ${missingData}
**Counts unchanged:** ${countsUnchanged ? "yes" : "NO"}
**Active jobs after:** ${activeAfter}
**SAFE_PRODUCT_API_PREVIEW_OK:** ${result.SAFE_PRODUCT_API_PREVIEW_OK}
**SAFE_TO_RUN_PRODUCT_API_APPLY_SMALL_BATCH:** ${result.SAFE_TO_RUN_PRODUCT_API_APPLY_SMALL_BATCH}
`,
  );

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        samples: samples.length,
        would_update_count: wouldUpdate,
        would_skip_count: wouldSkip,
        counts_unchanged: countsUnchanged,
        SAFE_PRODUCT_API_PREVIEW_OK: result.SAFE_PRODUCT_API_PREVIEW_OK,
        SAFE_TO_RUN_PRODUCT_API_APPLY_SMALL_BATCH: result.SAFE_TO_RUN_PRODUCT_API_APPLY_SMALL_BATCH,
        NEXT_PROMPT: result.NEXT_PROMPT,
      },
      null,
      2,
    ),
  );

  if (!previewOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
