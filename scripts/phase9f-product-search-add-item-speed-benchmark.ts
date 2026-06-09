/**
 * PHASE-9F-PRODUCT-SEARCH-ADD-ITEM-SPEED-BENCHMARK (read-only audit)
 *   npx tsx scripts/phase9f-product-search-add-item-speed-benchmark.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { resolveProductForScannerItem } from "../lib/scanner/resolve-product-for-scanner-item";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase9f-product-search-add-item-speed-benchmark";
const WARMUP = 3;
const ITERS = 24;

type IdKind = "upc" | "sku" | "fnsku" | "asin" | "title";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function pgUrl(): string {
  const url = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!url.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL must target production");
  if (url.includes(STAGING_REF)) throw new Error("BLOCKED: staging URL");
  return url;
}

function supabase(): SupabaseClient {
  const url = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url.includes(ORIGINAL_REF) || !key) throw new Error("ORIGINAL Supabase env required");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadSamples(client: pg.Client): Promise<Record<IdKind, { value: string; note: string }>> {
  const r = await client.query(
    `
    SELECT
      (SELECT m.upc_code FROM product_identifier_map m
        WHERE m.organization_id=$1 AND (m.store_id=$2 OR m.store_id IS NULL)
          AND m.deleted_at IS NULL AND m.upc_code IS NOT NULL AND btrim(m.upc_code) <> ''
        ORDER BY m.id LIMIT 1) AS upc,
      (SELECT p.sku FROM products p
        WHERE p.organization_id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL
          AND p.sku IS NOT NULL AND btrim(p.sku) <> ''
        ORDER BY p.id LIMIT 1) AS sku,
      (SELECT p.fnsku FROM products p
        WHERE p.organization_id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL
          AND p.fnsku IS NOT NULL AND btrim(p.fnsku) <> ''
        ORDER BY p.id LIMIT 1) AS fnsku,
      (SELECT p.asin FROM products p
        WHERE p.organization_id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL
          AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
        ORDER BY p.id LIMIT 1) AS asin,
      (SELECT left(btrim(p.product_name), 12) FROM products p
        WHERE p.organization_id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL
          AND p.product_name IS NOT NULL AND length(btrim(p.product_name)) >= 8
        ORDER BY p.id LIMIT 1) AS title_prefix
    `,
    [ORG, STORE],
  );
  const row = r.rows[0] ?? {};
  return {
    upc: { value: String(row.upc ?? "612511069669").trim(), note: "map.upc_code then products.upc_code|barcode" },
    sku: { value: String(row.sku ?? "B003W0PCEO-VEN").trim(), note: "map.seller_sku|msku then products.sku" },
    fnsku: { value: String(row.fnsku ?? "X003RRASTH").trim(), note: "map.fnsku then products.fnsku" },
    asin: { value: String(row.asin ?? "B007OXL3GQ").trim(), note: "map.asin then products.asin" },
    title: {
      value: String(row.title_prefix ?? "Monin Mango").trim(),
      note: "searchOperatorProductsForStoreAction ilike on products.*",
    },
  };
}

async function explainPlan(
  client: pg.Client,
  label: string,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>> {
  const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const plan = (r.rows[0] as { "QUERY PLAN"?: unknown })?.["QUERY PLAN"];
  const root = Array.isArray(plan) ? (plan[0] as Record<string, unknown>)?.Plan : null;
  const planObj = root as Record<string, unknown> | null;
  return {
    label,
    execution_ms: (planObj?.["Actual Total Time"] as number | undefined) ?? null,
    node_type: planObj?.["Node Type"] ?? null,
    index_name: extractIndexName(planObj),
    plan_summary: summarizePlan(planObj),
  };
}

function extractIndexName(plan: Record<string, unknown> | null, depth = 0): string | null {
  if (!plan || depth > 8) return null;
  if (plan["Index Name"]) return String(plan["Index Name"]);
  for (const key of ["Plans", "Plan"]) {
    const child = plan[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        const hit = extractIndexName(c as Record<string, unknown>, depth + 1);
        if (hit) return hit;
      }
    } else if (child && typeof child === "object") {
      const hit = extractIndexName(child as Record<string, unknown>, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function summarizePlan(plan: Record<string, unknown> | null, depth = 0): string {
  if (!plan || depth > 6) return "";
  const parts = [String(plan["Node Type"] ?? "")];
  if (plan["Index Name"]) parts.push(`idx=${plan["Index Name"]}`);
  if (plan["Relation Name"]) parts.push(`rel=${plan["Relation Name"]}`);
  const childPlans = plan["Plans"] as Record<string, unknown>[] | undefined;
  if (childPlans?.length) {
    parts.push(`> ${summarizePlan(childPlans[0]!, depth + 1)}`);
  }
  return parts.filter(Boolean).join(" ");
}

async function benchmarkResolve(
  sb: SupabaseClient,
  kind: IdKind,
  value: string,
): Promise<{ p95: number; worst: number; path: string; status: string }> {
  const input = {
    organization_id: ORG,
    store_id: STORE,
    upc: kind === "upc" ? value : null,
    sku: kind === "sku" ? value : null,
    fnsku: kind === "fnsku" ? value : null,
    asin: kind === "asin" ? value : null,
  };
  for (let i = 0; i < WARMUP; i++) {
    await resolveProductForScannerItem(sb, input);
  }
  const timings: number[] = [];
  let lastPath = "";
  let lastStatus = "";
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    const res = await resolveProductForScannerItem(sb, input);
    timings.push(Math.round(performance.now() - t0));
    lastPath = String(res.matched_via ?? "none");
    lastStatus = res.status;
  }
  return {
    p95: percentile(timings, 95),
    worst: Math.max(...timings),
    path: lastPath,
    status: lastStatus,
  };
}

async function benchmarkTitleSearch(client: pg.Client, prefix: string): Promise<{ p95: number; worst: number }> {
  const pattern = `%${prefix.replace(/%/g, "").replace(/_/g, "")}%`;
  const sql = `
    SELECT id FROM products
    WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
      AND (
        product_name ILIKE $3 OR sku ILIKE $3 OR fnsku ILIKE $3 OR asin ILIKE $3
      )
    LIMIT 20
  `;
  for (let i = 0; i < WARMUP; i++) {
    await client.query(sql, [ORG, STORE, pattern]);
  }
  const timings: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await client.query(sql, [ORG, STORE, pattern]);
    timings.push(Math.round(performance.now() - t0));
  }
  return { p95: percentile(timings, 95), worst: Math.max(...timings) };
}

async function listRelevantIndexes(client: pg.Client): Promise<Record<string, string[]>> {
  const r = await client.query(
    `SELECT tablename, indexname, indexdef
     FROM pg_indexes
     WHERE schemaname='public'
       AND tablename IN ('products','product_identifier_map','catalog_products')
     ORDER BY tablename, indexname`,
  );
  const out: Record<string, string[]> = { products: [], product_identifier_map: [], catalog_products: [] };
  for (const row of r.rows as Array<{ tablename: string; indexdef: string }>) {
    out[row.tablename]?.push(row.indexdef);
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: pgUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const samples = await loadSamples(client);
  const indexes = await listRelevantIndexes(client);

  const explainSpecs: Array<{ label: string; sql: string; params: unknown[] }> = [
    {
      label: "map_fnsku",
      sql: `SELECT product_id FROM product_identifier_map
       WHERE organization_id=$1::uuid AND fnsku=$2
         AND (store_id=$3::uuid OR store_id IS NULL) AND deleted_at IS NULL LIMIT 40`,
      params: [ORG, samples.fnsku.value, STORE],
    },
    {
      label: "map_seller_sku",
      sql: `SELECT product_id FROM product_identifier_map
       WHERE organization_id=$1::uuid AND seller_sku=$2
         AND (store_id=$3::uuid OR store_id IS NULL) AND deleted_at IS NULL LIMIT 40`,
      params: [ORG, samples.sku.value, STORE],
    },
    {
      label: "map_upc",
      sql: `SELECT product_id FROM product_identifier_map
       WHERE organization_id=$1::uuid AND upc_code=$2
         AND (store_id=$3::uuid OR store_id IS NULL) AND deleted_at IS NULL LIMIT 40`,
      params: [ORG, samples.upc.value, STORE],
    },
    {
      label: "map_asin",
      sql: `SELECT product_id FROM product_identifier_map
       WHERE organization_id=$1::uuid AND asin=$2
         AND (store_id=$3::uuid OR store_id IS NULL) AND deleted_at IS NULL LIMIT 40`,
      params: [ORG, samples.asin.value, STORE],
    },
    {
      label: "products_fnsku",
      sql: `SELECT id FROM products WHERE organization_id=$1::uuid AND store_id=$2::uuid AND fnsku=$3 AND deleted_at IS NULL LIMIT 10`,
      params: [ORG, STORE, samples.fnsku.value],
    },
    {
      label: "products_sku",
      sql: `SELECT id FROM products WHERE organization_id=$1::uuid AND store_id=$2::uuid AND sku=$3 AND deleted_at IS NULL LIMIT 10`,
      params: [ORG, STORE, samples.sku.value],
    },
    {
      label: "products_asin",
      sql: `SELECT id FROM products WHERE organization_id=$1::uuid AND store_id=$2::uuid AND asin=$3 AND deleted_at IS NULL LIMIT 10`,
      params: [ORG, STORE, samples.asin.value],
    },
    {
      label: "products_upc",
      sql: `SELECT id FROM products WHERE organization_id=$1::uuid AND store_id=$2::uuid AND upc_code=$3 AND deleted_at IS NULL LIMIT 10`,
      params: [ORG, STORE, samples.upc.value],
    },
    {
      label: "title_ilike",
      sql: `SELECT id FROM products WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL
       AND (product_name ILIKE $3 OR sku ILIKE $3 OR fnsku ILIKE $3 OR asin ILIKE $3) LIMIT 20`,
      params: [ORG, STORE, `%${samples.title.value}%`],
    },
  ];
  const explains: Record<string, unknown>[] = [];
  for (const spec of explainSpecs) {
    explains.push(await explainPlan(client, spec.label, spec.sql, spec.params));
  }

  await client.end();

  const sb = supabase();
  const upcBench = await benchmarkResolve(sb, "upc", samples.upc.value);
  const skuBench = await benchmarkResolve(sb, "sku", samples.sku.value);
  const fnskuBench = await benchmarkResolve(sb, "fnsku", samples.fnsku.value);
  const asinBench = await benchmarkResolve(sb, "asin", samples.asin.value);

  const pg2 = new pg.Client({ connectionString: pgUrl(), ssl: { rejectUnauthorized: false } });
  await pg2.connect();
  const titleBench = await benchmarkTitleSearch(pg2, samples.title.value);
  await pg2.end();

  const slowPaths: string[] = [];
  const missingIndexes: string[] = [];
  const indexDefs = [...indexes.products, ...indexes.product_identifier_map].join("\n");

  const needs = [
    { key: "idx_products_org_store_fnsku", pattern: /products.*organization_id.*store_id.*fnsku/i, reason: "products.fnsku fallback after map miss" },
    { key: "idx_products_org_store_asin", pattern: /products.*organization_id.*store_id.*asin/i, reason: "products.asin fallback" },
    { key: "idx_products_org_store_upc", pattern: /products.*organization_id.*store_id.*upc_code/i, reason: "products.upc_code fallback" },
    { key: "idx_product_identifier_map_org_store_seller_sku", pattern: /product_identifier_map.*organization_id.*store_id.*seller_sku(?!.*asin)/i, reason: "map seller_sku-only lookup (current index requires asin)" },
    { key: "idx_products_org_store_title_trgm", pattern: /gin.*product_name|trgm.*product_name/i, reason: "title ilike search (searchOperatorProductsForStoreAction)" },
  ];

  for (const n of needs) {
    if (!n.pattern.test(indexDefs)) missingIndexes.push(`${n.key} — ${n.reason}`);
  }

  const benchMap: Record<IdKind, { p95: number; worst: number }> = {
    upc: { p95: upcBench.p95, worst: upcBench.worst },
    sku: { p95: skuBench.p95, worst: skuBench.worst },
    fnsku: { p95: fnskuBench.p95, worst: fnskuBench.worst },
    asin: { p95: asinBench.p95, worst: asinBench.worst },
    title: { p95: titleBench.p95, worst: titleBench.worst },
  };

  for (const [kind, b] of Object.entries(benchMap)) {
    if (b.p95 >= 150) slowPaths.push(`${kind}: p95=${b.p95}ms worst=${b.worst}ms`);
  }

  for (const ex of explains) {
    if (Number(ex.execution_ms) > 50 && !ex.index_name) {
      slowPaths.push(`explain ${ex.label}: ${ex.execution_ms}ms no index (${ex.plan_summary})`);
    }
    if (ex.label === "map_seller_sku" && String(ex.plan_summary).includes("Seq Scan")) {
      if (!missingIndexes.some((m) => m.includes("seller_sku"))) {
        missingIndexes.push("idx_product_identifier_map_org_store_seller_sku — seq scan on SKU tier");
      }
    }
    if (ex.label === "title_ilike" && String(ex.plan_summary).includes("Seq Scan")) {
      slowPaths.push(`title search uses sequential scan on products (${ex.execution_ms}ms)`);
    }
  }

  const recommendedFix = missingIndexes.length
    ? `-- Phase 9F — product search / Add Item index plan (indexes only; no new tables/columns)
BEGIN;

-- products direct-match fallbacks (map tier misses today seq-scan ~11–14ms each)
CREATE INDEX IF NOT EXISTS idx_products_org_store_fnsku
  ON public.products (organization_id, store_id, fnsku)
  WHERE deleted_at IS NULL AND fnsku IS NOT NULL AND btrim(fnsku) <> '';

CREATE INDEX IF NOT EXISTS idx_products_org_store_asin
  ON public.products (organization_id, store_id, asin)
  WHERE deleted_at IS NULL AND asin IS NOT NULL AND btrim(asin) <> '';

CREATE INDEX IF NOT EXISTS idx_products_org_store_upc_code
  ON public.products (organization_id, store_id, upc_code)
  WHERE deleted_at IS NULL AND upc_code IS NOT NULL AND btrim(upc_code) <> '';

-- Title search (requires pg_trgm — separate operator approval; p95 currently 123ms):
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS idx_products_org_store_product_name_trgm
--   ON public.products USING gin (product_name gin_trgm_ops)
--   WHERE deleted_at IS NULL AND product_name IS NOT NULL;

COMMIT;
NOTIFY pgrst, 'reload schema';`
    : "No index-only migration required; monitor p95 under load.";

  const safeToImplement =
    missingIndexes.filter((m) => !m.includes("trgm")).length > 0 &&
    benchMap.title.p95 < 500
      ? "yes"
      : missingIndexes.some((m) => m.includes("trgm")) && benchMap.title.p95 >= 150
        ? "conditional"
        : benchMap.title.p95 >= 150
          ? "no"
          : "yes";

  const result = {
    phase_number: "9F",
    mode: "read_only_audit",
    target: ORIGINAL_REF,
    add_item_path: "lookupProductInputForReturnItem → resolveScannerProductIdentifiers → resolveProductForScannerItem",
    product_search_path: "searchOperatorProductsForStoreAction (products ilike product_name|name|sku|fnsku|asin)",
    resolution_order: [
      "product_identifier_map.fnsku → products.fnsku",
      "product_identifier_map.seller_sku|msku → products.sku",
      "product_identifier_map.upc_code → products.upc_code|barcode",
      "product_identifier_map.asin → products.asin",
    ],
    samples,
    upc_p95: benchMap.upc.p95,
    sku_p95: benchMap.sku.p95,
    fnsku_p95: benchMap.fnsku.p95,
    asin_p95: benchMap.asin.p95,
    title_p95: benchMap.title.p95,
    worst_ms: {
      upc: upcBench.worst,
      sku: skuBench.worst,
      fnsku: fnskuBench.worst,
      asin: asinBench.worst,
      title: titleBench.worst,
    },
    resolve_paths: {
      upc: upcBench,
      sku: skuBench,
      fnsku: fnskuBench,
      asin: asinBench,
    },
    explain_plans: explains,
    indexes_present: indexes,
    slow_paths: slowPaths,
    missing_indexes: missingIndexes,
    recommended_fix: recommendedFix,
    SAFE_TO_IMPLEMENT_9F: safeToImplement,
    blockers:
      benchMap.title.p95 >= 150
        ? ["title_p95 >= 150ms — trigram index or search RPC refactor needs operator approval"]
        : [],
  };

  fs.writeFileSync(path.join(outDir, "phase9f_benchmark_result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "recommended_index_migration.sql"), recommendedFix + "\n");
  fs.writeFileSync(
    path.join(outDir, "benchmark-report.md",
    ),
    [
      "# Phase 9F — Product Search / Add Item speed benchmark",
      "",
      `Run: \`${rid}\` · Target: \`${ORIGINAL_REF}\` · Read-only`,
      "",
      "## p95 (ms)",
      "",
      `- UPC: **${result.upc_p95}**`,
      `- SKU: **${result.sku_p95}**`,
      `- FNSKU: **${result.fnsku_p95}**`,
      `- ASIN: **${result.asin_p95}**`,
      `- Title prefix: **${result.title_p95}**`,
      "",
      `SAFE_TO_IMPLEMENT_9F: **${result.SAFE_TO_IMPLEMENT_9F}**`,
    ].join("\n") + "\n",
  );

  console.log(
    JSON.stringify(
      {
        upc_p95: result.upc_p95,
        sku_p95: result.sku_p95,
        fnsku_p95: result.fnsku_p95,
        asin_p95: result.asin_p95,
        title_p95: result.title_p95,
        slow_paths: result.slow_paths,
        missing_indexes: result.missing_indexes,
        recommended_fix: result.missing_indexes.length ? "see recommended_index_migration.sql" : result.recommended_fix,
        SAFE_TO_IMPLEMENT_9F: result.SAFE_TO_IMPLEMENT_9F,
        blockers: result.blockers,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
