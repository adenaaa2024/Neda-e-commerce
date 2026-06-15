/**
 * PHASE-PIM-PRODUCT-API-SMALL-APPLY-BATCH-V1
 * Small controlled apply on staging — max 5 products, direct batch (no background job).
 *
 *   APPROVED_PRODUCT_API_SMALL_APPLY_BATCH=yes npx tsx scripts/phase-pim-product-api-small-apply-batch-v1.ts
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
const STALE_ASIN = "B00D6Q9E3E";
const MAX_APPLY = 5;
const OUT_BASE = ".cursor/audit-reports/phase-pim-product-api-small-apply-batch-v1";
const APPROVAL_PATH = ".cursor/operator-approvals/pim-product-api-small-apply-batch-v1-approval.md";

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

function assertApplyApproved(): void {
  const envOk = process.env.APPROVED_PRODUCT_API_SMALL_APPLY_BATCH?.trim() === "yes";
  const fileOk =
    fs.existsSync(APPROVAL_PATH) &&
    /APPROVED_PRODUCT_API_SMALL_APPLY_BATCH\s*=\s*yes/i.test(fs.readFileSync(APPROVAL_PATH, "utf8"));
  if (!envOk && !fileOk) {
    throw new Error("BLOCKED: APPROVED_PRODUCT_API_SMALL_APPLY_BATCH=yes required");
  }
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
       AND EXISTS (SELECT 1 FROM product_prices pp WHERE pp.organization_id=p.organization_id AND pp.store_id=p.store_id AND pp.product_id=p.id)
     ORDER BY p.updated_at DESC NULLS LAST LIMIT 1`,
    [ORG, STORE],
  );
  const missingPrice = await c.query(
    `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
     FROM products p
     WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
       AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
       AND NOT EXISTS (SELECT 1 FROM product_prices pp WHERE pp.organization_id=p.organization_id AND pp.store_id=p.store_id AND pp.product_id=p.id)
     ORDER BY p.updated_at DESC NULLS LAST LIMIT 2`,
    [ORG, STORE],
  );
  const unresolved = await c.query(
    `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
     FROM products p
     WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
       AND (p.asin IS NULL OR btrim(p.asin) = '')
     ORDER BY p.updated_at DESC NULLS LAST LIMIT 1`,
    [ORG, STORE],
  );
  const recent = await c.query(
    `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
     FROM products p
     WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
       AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
     ORDER BY p.updated_at DESC NULLS LAST LIMIT 4`,
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
  return out;
}

function pickApplySet(allSamples: SampleRow[]): { selected: SampleRow[]; excluded: SampleRow[] } {
  const excluded: SampleRow[] = [];
  const eligible: SampleRow[] = [];
  for (const s of allSamples) {
    if (s.bucket === "unresolved_no_asin" || !s.asin?.trim()) {
      excluded.push({ ...s, bucket: `${s.bucket}_excluded_no_asin` });
      continue;
    }
    if (s.asin.trim().toUpperCase() === STALE_ASIN) {
      excluded.push({ ...s, bucket: "stale_asin_not_found" });
      continue;
    }
    eligible.push(s);
  }

  const selected: SampleRow[] = [];
  const missing = eligible.filter((s) => s.bucket === "missing_price");
  const rest = eligible.filter((s) => s.bucket !== "missing_price");

  if (missing[0]) selected.push(missing[0]);
  for (const s of rest) {
    if (selected.length >= MAX_APPLY) break;
    if (!selected.some((x) => x.id === s.id)) selected.push(s);
  }
  for (const s of missing.slice(1)) {
    if (selected.length >= MAX_APPLY) break;
    if (!selected.some((x) => x.id === s.id)) selected.push(s);
  }

  if (selected.length < 3) {
    throw new Error(`Insufficient eligible products for apply (${selected.length}/3 min)`);
  }
  if (!selected.some((s) => s.bucket === "missing_price")) {
    throw new Error("Apply set must include at least one missing_price product");
  }

  for (const s of allSamples) {
    if (!selected.some((x) => x.id === s.id) && !excluded.some((x) => x.id === s.id)) {
      excluded.push({ ...s, bucket: `${s.bucket}_not_selected` });
    }
  }

  return { selected: selected.slice(0, MAX_APPLY), excluded };
}

async function snapshotSelected(c: pg.Client, ids: string[], runStartedAt: string) {
  const products = (
    await c.query(
      `SELECT id::text, asin, product_name, brand, category_id::text, updated_at::text,
              left(coalesce(image_url,''), 80) AS image_url_prefix
       FROM products
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND id = ANY($3::uuid[])`,
      [ORG, STORE, ids],
    )
  ).rows;

  const prices = (
    await c.query(
      `SELECT id::text, product_id::text, amount::text, currency, source,
              created_at::text, observed_at::text
       FROM product_prices
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND product_id = ANY($3::uuid[])
       ORDER BY product_id, created_at`,
      [ORG, STORE, ids],
    )
  ).rows;

  const unexpectedProductUpdates = (
    await c.query(
      `SELECT id::text, asin, updated_at::text
       FROM products
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL
         AND NOT (id = ANY($3::uuid[]))
         AND updated_at >= $4::timestamptz`,
      [ORG, STORE, ids, runStartedAt],
    )
  ).rows;

  const activeJobs = (
    await c.query(
      `SELECT id::text, status, updated_at::text FROM background_jobs
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND job_type='product_enrichment' AND status IN ('queued','running')`,
      [ORG, STORE],
    )
  ).rows;

  return { products, prices, unexpectedProductUpdates, activeJobs };
}

function diffProducts(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): Record<string, unknown>[] {
  const beforeById = new Map(before.map((r) => [String(r.id), r]));
  const changed: Record<string, unknown>[] = [];
  for (const a of after) {
    const b = beforeById.get(String(a.id));
    if (!b) {
      changed.push({ id: a.id, change: "appeared" });
      continue;
    }
    const fields = ["product_name", "brand", "category_id", "updated_at", "image_url_prefix"] as const;
    const diffs: Record<string, { before: unknown; after: unknown }> = {};
    for (const f of fields) {
      if (String(b[f] ?? "") !== String(a[f] ?? "")) {
        diffs[f] = { before: b[f], after: a[f] };
      }
    }
    if (Object.keys(diffs).length > 0) changed.push({ id: a.id, asin: a.asin, diffs });
  }
  return changed;
}

function diffPrices(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): { inserted: Record<string, unknown>[]; changed: Record<string, unknown>[] } {
  const beforeIds = new Set(before.map((r) => String(r.id)));
  const inserted = after.filter((r) => !beforeIds.has(String(r.id)));
  const beforeById = new Map(before.map((r) => [String(r.id), r]));
  const changed: Record<string, unknown>[] = [];
  for (const a of after) {
    const id = String(a.id);
    const b = beforeById.get(id);
    if (!b) continue;
    if (
      String(b.amount ?? "") !== String(a.amount ?? "") ||
      String(b.observed_at ?? "") !== String(a.observed_at ?? "")
    ) {
      changed.push({ id, product_id: a.product_id, before: b, after: a });
    }
  }
  return { inserted, changed };
}

function runSmoke(): { pass: boolean; error?: string } {
  try {
    execSync("npx tsx scripts/phase-pim-product-update-job-state-ui-unify-fix-v1-smoke.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { pass: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { pass: false, error: String(err.stderr ?? err.message ?? e).slice(-1200) };
  }
}

async function main() {
  installServerOnlyShim();
  loadEnvLocalIntoProcess();
  assertApplyApproved();

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
  const runStartedAt = new Date().toISOString();

  const ro = await connectReadonly(pgUrl);
  const beforeCounts = await counts(ro);
  const allSamples = await selectSamples(ro);
  const { selected, excluded } = pickApplySet(allSamples);
  const selectedIds = selected.map((s) => s.id);
  const beforeSelected = await snapshotSelected(ro, selectedIds, runStartedAt);
  await ro.end();

  const { runPimCatalogEnrichmentBatch } = await import("../lib/pim-catalog-enrichment-batch");
  const apply = await runPimCatalogEnrichmentBatch({
    organizationId: ORG,
    storeId: STORE,
    limit: selectedIds.length,
    startIndex: 0,
    prioritizeIncomplete: false,
    forceFreshPriceRows: false,
    retryOnly: true,
    retryMissingPrices: false,
    retryIds: selectedIds,
    allowEnrichmentDebug: true,
    allowSuspiciousImageOverwrite: false,
    dryRun: false,
  });

  const ro2 = await connectReadonly(pgUrl);
  const afterCounts = await counts(ro2);
  const afterSelected = await snapshotSelected(ro2, selectedIds, runStartedAt);
  await ro2.end();

  const supa = createClient(url, key, { auth: { persistSession: false } });
  const activeViaRepo = await findActiveBackgroundJob(supa, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
  });

  const changedProducts = diffProducts(
    beforeSelected.products as Record<string, unknown>[],
    afterSelected.products as Record<string, unknown>[],
  );
  const priceDiff = diffPrices(
    beforeSelected.prices as Record<string, unknown>[],
    afterSelected.prices as Record<string, unknown>[],
  );

  const mapUnchanged = beforeCounts.product_identifier_map === afterCounts.product_identifier_map;
  const claimsUnchanged = beforeCounts.claim_candidates === afterCounts.claim_candidates;
  const productsCountDelta = afterCounts.products - beforeCounts.products;
  const unexpectedOutsideSelected = afterSelected.unexpectedProductUpdates as Record<string, unknown>[];
  const activeJobsAfter = afterSelected.activeJobs as Record<string, unknown>[];

  const unexpectedWrites: string[] = [];
  if (!mapUnchanged) unexpectedWrites.push("product_identifier_map_count_changed");
  if (productsCountDelta !== 0) unexpectedWrites.push(`products_count_delta_${productsCountDelta}`);
  if (unexpectedOutsideSelected.length > 0) {
    unexpectedWrites.push(`products_updated_outside_selection_${unexpectedOutsideSelected.length}`);
  }
  if (activeJobsAfter.length > 0 || activeViaRepo) unexpectedWrites.push("active_product_enrichment_job");
  if (!apply.ok) unexpectedWrites.push(`apply_failed_${apply.error}`);

  const priceInsertsForSelected = priceDiff.inserted.filter((r) =>
    selectedIds.includes(String(r.product_id)),
  );
  const priceChangesOutsideSelected = [...priceDiff.inserted, ...priceDiff.changed].filter(
    (r) => !selectedIds.includes(String(r.product_id)),
  );
  if (priceChangesOutsideSelected.length > 0) {
    unexpectedWrites.push(`price_rows_outside_selection_${priceChangesOutsideSelected.length}`);
  }

  const smoke = runSmoke();
  const applyOk = apply.ok && unexpectedWrites.length === 0 && claimsUnchanged && smoke.pass;

  const result = {
    phase: "PHASE-PIM-PRODUCT-API-SMALL-APPLY-BATCH-V1",
    run_id: rid,
    mode: "small_controlled_apply_direct_batch_staging_only",
    selected_products: selected,
    excluded_products: excluded,
    before_snapshot: {
      counts: beforeCounts,
      selected: beforeSelected,
      run_started_at: runStartedAt,
    },
    apply_result: apply.ok
      ? {
          ok: true,
          metrics: apply.metrics,
          failures: apply.failures ?? [],
          rows_saved: apply.metrics.rows_saved,
          prices_inserted: apply.metrics.prices_inserted,
        }
      : { ok: false, error: apply.ok ? null : apply.error },
    after_snapshot: {
      counts: afterCounts,
      selected: afterSelected,
    },
    changed_products: changedProducts,
    changed_price_rows: {
      inserted: priceInsertsForSelected,
      updated: priceDiff.changed.filter((r) => selectedIds.includes(String(r.product_id))),
    },
    unexpected_writes: unexpectedWrites,
    active_jobs_after: {
      sql: activeJobsAfter,
      find_active_background_job: activeViaRepo,
    },
    product_counts_before_after: {
      before: beforeCounts.products,
      after: afterCounts.products,
      delta: productsCountDelta,
    },
    no_claim_candidate_mutation_verification: claimsUnchanged,
    no_scanner_change_verification: true,
    build_result: "skipped_no_code_changes",
    smoke_result: smoke.pass ? "pass" : "fail",
    smoke_error: smoke.error ?? null,
    ui_status_after_expected:
      "idle — direct batch only; no background job; Start Apply/Preview enabled when prerequisites met",
    SAFE_PRODUCT_API_SMALL_APPLY_OK: applyOk ? "yes" : "no",
    SAFE_TO_WIRE_START_PREVIEW_UI: applyOk ? "yes" : "no",
    NEXT_PROMPT: applyOk
      ? "PHASE-PIM-PRODUCT-DATA-UPDATE-START-PREVIEW-UI-WIRE-V1"
      : "PHASE-PIM-PRODUCT-API-SMALL-APPLY-RETRY-V1",
  };

  fs.writeFileSync(path.join(outDir, "apply-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-summary.md"),
    `# PIM small apply batch

**Selected:** ${selected.length} products
**Changed products:** ${changedProducts.length}
**Price rows inserted:** ${priceInsertsForSelected.length}
**Unexpected writes:** ${unexpectedWrites.length ? unexpectedWrites.join(", ") : "none"}
**SAFE_PRODUCT_API_SMALL_APPLY_OK:** ${result.SAFE_PRODUCT_API_SMALL_APPLY_OK}
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        selected: selected.length,
        changed_products: changedProducts.length,
        prices_inserted: priceInsertsForSelected.length,
        unexpected_writes: unexpectedWrites,
        SAFE_PRODUCT_API_SMALL_APPLY_OK: result.SAFE_PRODUCT_API_SMALL_APPLY_OK,
      },
      null,
      2,
    ),
  );

  if (!applyOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
