/**
 * PHASE-9F-PRODUCT-SEARCH-INDEXES-STAGING-AND-PRODUCTION
 *
 *   npx tsx scripts/phase9f-product-search-indexes-staging-and-production-apply-and-verify.ts
 *   APPROVED_PHASE9F_PRODUCT_SEARCH_STAGING=true npx tsx scripts/phase9f-product-search-indexes-staging-and-production-apply-and-verify.ts --apply
 *   (production auto-runs when staging passes and APPROVED_PHASE9F_PRODUCT_SEARCH_PRODUCTION=true)
 */
import { execSync } from "node:child_process";
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
const MIGRATION = "supabase/migrations/20260912120000_phase9f_product_search_indexes.sql";
const MIGRATION_VERSION = "20260912120000";
const OUT_BASE = ".cursor/audit-reports/phase9f-product-search-indexes-staging-and-production";

const NEW_INDEX_NAMES = [
  "idx_products_org_store_fnsku",
  "idx_products_org_store_asin",
  "idx_products_org_store_upc_code",
  "idx_products_org_store_product_name_trgm",
];
const SKU_INDEX = "idx_products_org_store_sku";

const WARMUP = 3;
const ITERS = 20;

type IdKind = "upc" | "sku" | "fnsku" | "asin" | "title";

function runId(): string {
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

function pgUrl(ref: "staging" | "original"): string {
  const url =
    ref === "staging"
      ? process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? ""
      : process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const want = ref === "staging" ? STAGING_REF : ORIGINAL_REF;
  if (!url.includes(want)) throw new Error(`${ref} postgres URL must target ${want}`);
  return url;
}

function supabaseFor(ref: "staging" | "original"): SupabaseClient {
  const url =
    ref === "staging"
      ? (process.env.STAGING_SUPABASE_URL?.trim() ?? process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "")
      : (process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "");
  const key =
    ref === "staging"
      ? (process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "")
      : (process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "");
  const want = ref === "staging" ? STAGING_REF : ORIGINAL_REF;
  if (!url.includes(want) || !key) throw new Error(`${ref} Supabase creds missing`);
  return createClient(url, key, { auth: { persistSession: false } });
}

async function connectPg(ref: "staging" | "original"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: pgUrl(ref), ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  return c;
}

async function migrationApplied(client: pg.Client, version: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`, [version]);
  return r.rows.length > 0;
}

async function indexExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${name}`]);
  return r.rows[0]?.e === true;
}

async function pgTrgmExists(client: pg.Client): Promise<boolean> {
  const r = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS e`);
  return r.rows[0]?.e === true;
}

async function loadSamples(client: pg.Client): Promise<Record<IdKind, string>> {
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
    upc: String(row.upc ?? "612511069669").trim(),
    sku: String(row.sku ?? "B003W0PCEO-VEN").trim(),
    fnsku: String(row.fnsku ?? "X003RRASTH").trim(),
    asin: String(row.asin ?? "B007OXL3GQ").trim(),
    title: String(row.title_prefix ?? "Monin Mango").trim(),
  };
}

async function benchmarkResolve(
  sb: SupabaseClient,
  kind: Exclude<IdKind, "title">,
  value: string,
): Promise<number> {
  const input = {
    organization_id: ORG,
    store_id: STORE,
    upc: kind === "upc" ? value : null,
    sku: kind === "sku" ? value : null,
    fnsku: kind === "fnsku" ? value : null,
    asin: kind === "asin" ? value : null,
  };
  for (let i = 0; i < WARMUP; i++) await resolveProductForScannerItem(sb, input);
  const timings: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await resolveProductForScannerItem(sb, input);
    timings.push(Math.round(performance.now() - t0));
  }
  return percentile(timings, 95);
}

async function benchmarkTitle(client: pg.Client, prefix: string): Promise<number> {
  const pattern = `%${prefix.replace(/%/g, "").replace(/_/g, "")}%`;
  const sql = `
    SELECT id FROM products
    WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
      AND (product_name ILIKE $3 OR sku ILIKE $3 OR fnsku ILIKE $3 OR asin ILIKE $3)
    LIMIT 20
  `;
  for (let i = 0; i < WARMUP; i++) await client.query(sql, [ORG, STORE, pattern]);
  const timings: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await client.query(sql, [ORG, STORE, pattern]);
    timings.push(Math.round(performance.now() - t0));
  }
  return percentile(timings, 95);
}

async function benchmarkAll(
  ref: "staging" | "original",
  samples: Record<IdKind, string>,
): Promise<Record<IdKind, number>> {
  const sb = supabaseFor(ref);
  const pg = await connectPg(ref);
  const upc = await benchmarkResolve(sb, "upc", samples.upc);
  const sku = await benchmarkResolve(sb, "sku", samples.sku);
  const fnsku = await benchmarkResolve(sb, "fnsku", samples.fnsku);
  const asin = await benchmarkResolve(sb, "asin", samples.asin);
  const title = await benchmarkTitle(pg, samples.title);
  await pg.end();
  return { upc, sku, fnsku, asin, title };
}

async function applyMigration(client: pg.Client): Promise<"applied" | "already_applied"> {
  if (await migrationApplied(client, MIGRATION_VERSION)) return "already_applied";
  await client.query(fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8"));
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [MIGRATION_VERSION, path.basename(MIGRATION)],
  );
  return "applied";
}

async function auditEnv(
  ref: "staging" | "original",
  client: pg.Client,
): Promise<{
  pg_trgm: boolean;
  sku_index: boolean;
  indexes: Record<string, boolean>;
}> {
  const pg_trgm = await pgTrgmExists(client);
  const sku_index = await indexExists(client, SKU_INDEX);
  const indexes: Record<string, boolean> = {};
  for (const n of NEW_INDEX_NAMES) indexes[n] = await indexExists(client, n);
  return { pg_trgm, sku_index, indexes };
}

function beforeAfter(before: number, after: number): { before: number; after: number; delta_ms: number } {
  return { before, after, delta_ms: after - before };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  let stagingApplied: "yes" | "no" | "already_applied" = "no";
  let productionApplied: "yes" | "no" | "already_applied" = "no";
  let skuIndexStatus = "unknown";
  let pgTrgmStaging = false;
  let pgTrgmProduction = false;
  let titleTrgmAdded = false;

  const stagingClient = await connectPg("staging");
  const stagingPreAudit = await auditEnv("staging", stagingClient);
  pgTrgmStaging = stagingPreAudit.pg_trgm;
  const samplesStaging = await loadSamples(stagingClient);

  if (!pgTrgmStaging) {
    blockers.push(
      "staging: pg_trgm not installed — title trigram index skipped on staging; operator approval required to CREATE EXTENSION pg_trgm on staging",
    );
  }

  skuIndexStatus = stagingPreAudit.sku_index ? "exists" : "missing";

  const stagingBefore = await benchmarkAll("staging", samplesStaging);

  if (apply) {
    if (process.env.APPROVED_PHASE9F_PRODUCT_SEARCH_STAGING !== "true") {
      throw new Error("Set APPROVED_PHASE9F_PRODUCT_SEARCH_STAGING=true to apply on staging");
    }
    const status = await applyMigration(stagingClient);
    stagingApplied = status === "applied" ? "yes" : "already_applied";
    await new Promise((r) => setTimeout(r, 1200));
  } else {
    stagingApplied = (await migrationApplied(stagingClient, MIGRATION_VERSION)) ? "already_applied" : "no";
  }

  const stagingPostAudit = await auditEnv("staging", stagingClient);
  await stagingClient.end();

  for (const idx of ["idx_products_org_store_fnsku", "idx_products_org_store_asin", "idx_products_org_store_upc_code"]) {
    if (!stagingPostAudit.indexes[idx]) blockers.push(`staging missing ${idx} after apply`);
  }
  titleTrgmAdded = stagingPostAudit.indexes.idx_products_org_store_product_name_trgm === true;
  if (pgTrgmStaging && !titleTrgmAdded && stagingApplied !== "no") {
    blockers.push("staging: pg_trgm present but title trgm index missing");
  }

  const stagingAfter = await benchmarkAll("staging", samplesStaging);

  let productionBefore: Record<IdKind, number> | null = null;
  let productionAfter: Record<IdKind, number> | null = null;

  const stagingPass =
    stagingApplied !== "no" &&
    stagingPostAudit.indexes.idx_products_org_store_fnsku &&
    stagingPostAudit.indexes.idx_products_org_store_asin &&
    stagingPostAudit.indexes.idx_products_org_store_upc_code;

  if (stagingPass && apply && process.env.APPROVED_PHASE9F_PRODUCT_SEARCH_PRODUCTION === "true") {
    const prodClient = await connectPg("original");
    pgTrgmProduction = await pgTrgmExists(prodClient);
    const samplesProd = await loadSamples(prodClient);
    productionBefore = await benchmarkAll("original", samplesProd);

    const prodStatus = await applyMigration(prodClient);
    productionApplied = prodStatus === "applied" ? "yes" : "already_applied";
    await new Promise((r) => setTimeout(r, 1500));

    const prodPost = await auditEnv("original", prodClient);
    for (const idx of ["idx_products_org_store_fnsku", "idx_products_org_store_asin", "idx_products_org_store_upc_code"]) {
      if (!prodPost.indexes[idx]) blockers.push(`production missing ${idx}`);
    }
    if (pgTrgmProduction && !prodPost.indexes.idx_products_org_store_product_name_trgm) {
      blockers.push("production pg_trgm present but title trgm index missing");
    }
    await prodClient.end();

    productionAfter = await benchmarkAll("original", samplesProd);
  } else if (!apply) {
    const prodClient = await connectPg("original");
    pgTrgmProduction = await pgTrgmExists(prodClient);
    productionApplied = (await migrationApplied(prodClient, MIGRATION_VERSION)) ? "already_applied" : "no";
    await prodClient.end();
  } else if (!stagingPass) {
    blockers.push("staging verify failed — production apply skipped");
  } else {
    blockers.push("Set APPROVED_PHASE9F_PRODUCT_SEARCH_PRODUCTION=true to apply on production");
  }

  let buildResult = "pending";
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe" });
    buildResult = "PASS";
  } catch (e) {
    buildResult = "FAIL";
    blockers.push(`build: ${String((e as { message?: string })?.message ?? e)}`);
  }

  const indexesAdded = NEW_INDEX_NAMES.filter((n) => stagingPostAudit.indexes[n]).concat(
    stagingPreAudit.sku_index ? [] : stagingPostAudit.sku_index ? [SKU_INDEX] : [],
  );

  const output = {
    phase_number: "9F",
    staging_applied: stagingApplied,
    production_applied: productionApplied,
    indexes_added: indexesAdded,
    sku_index_exists_or_added: skuIndexStatus,
    pg_trgm_exists: pgTrgmStaging || pgTrgmProduction ? "yes" : "no",
    pg_trgm_staging: pgTrgmStaging,
    pg_trgm_production: pgTrgmProduction,
    title_trgm_added: titleTrgmAdded ? "yes" : "no",
    upc_p95_before_after: beforeAfter(stagingBefore.upc, stagingAfter.upc),
    sku_p95_before_after: beforeAfter(stagingBefore.sku, stagingAfter.sku),
    fnsku_p95_before_after: beforeAfter(stagingBefore.fnsku, stagingAfter.fnsku),
    asin_p95_before_after: beforeAfter(stagingBefore.asin, stagingAfter.asin),
    title_p95_before_after: beforeAfter(stagingBefore.title, stagingAfter.title),
    production_benchmarks:
      productionBefore && productionAfter
        ? {
            upc: beforeAfter(productionBefore.upc, productionAfter.upc),
            sku: beforeAfter(productionBefore.sku, productionAfter.sku),
            fnsku: beforeAfter(productionBefore.fnsku, productionAfter.fnsku),
            asin: beforeAfter(productionBefore.asin, productionAfter.asin),
            title: beforeAfter(productionBefore.title, productionAfter.title),
          }
        : null,
    staging_before_p95: stagingBefore,
    staging_after_p95: stagingAfter,
    build_result: buildResult,
    SAFE_FOR_LIVE_PRODUCT_SEARCH:
      productionApplied !== "no" &&
      buildResult === "PASS" &&
      !blockers.some((b) => b.startsWith("production"))
        ? "yes"
        : "no",
    blockers,
    samples: samplesStaging,
  };

  fs.writeFileSync(path.join(outDir, "phase9f_result.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
