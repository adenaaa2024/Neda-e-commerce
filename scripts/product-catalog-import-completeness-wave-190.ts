/**
 * PRODUCT-CATALOG-IMPORT-COMPLETENESS-WAVE-190 — read-only staging gap matrix.
 *
 *   npx tsx scripts/product-catalog-import-completeness-wave-190.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  buildWave2TableConfig,
  countWave2TierEligible,
  probeTableCoverage,
  WAVE2_TARGET_ORDER,
  WAVE2_TIERS_BY_TABLE,
  type Wave2TargetTable,
  type Wave2Tier,
} from "../lib/product-id-mapping-wave2-pg";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/product-catalog-import-completeness-wave-190";

const EXTRA_TABLES = ["amazon_fba_inventory", "amazon_settlements", "expected_packages"] as const;

type GapRow = {
  source_table: string;
  total_rows: number;
  with_identifiers: number;
  resolved_product_id: number;
  unresolved: number;
  ambiguous_status: number;
  coverage_pct: number;
  wave2_safe_map_backfill: Record<string, number | string>;
  fba_like_unresolved: number | null;
  fbm_like_unresolved: number | null;
  upc_like_unresolved: number | null;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function hasCol(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, col],
  );
  return (r.rowCount ?? 0) > 0;
}

async function classifyUnresolved(client: pg.Client, table: string): Promise<{
  fba_like: number;
  fbm_like: number;
  upc_like: number;
} | null> {
  if (!(await tableExists(client, table))) return null;
  const cols: string[] = [];
  if (await hasCol(client, table, "fnsku")) cols.push("fnsku");
  if (await hasCol(client, table, "fulfillment_channel_sku")) cols.push("fulfillment_channel_sku AS fnsku");
  if (await hasCol(client, table, "asin")) cols.push("asin");
  if (await hasCol(client, table, "sku")) cols.push("sku");
  if (await hasCol(client, table, "seller_sku")) cols.push("seller_sku AS sku");
  if (await hasCol(client, table, "upc")) cols.push("upc");
  if (!(await hasCol(client, table, "resolved_product_id"))) return null;

  const fnskuExpr =
    (await hasCol(client, table, "fnsku"))
      ? `NULLIF(TRIM(fnsku), '')`
      : (await hasCol(client, table, "fulfillment_channel_sku"))
        ? `NULLIF(TRIM(fulfillment_channel_sku), '')`
        : "NULL";
  const asinExpr = (await hasCol(client, table, "asin")) ? `NULLIF(TRIM(asin), '')` : "NULL";
  const skuExpr = (await hasCol(client, table, "sku"))
    ? `NULLIF(TRIM(sku), '')`
    : (await hasCol(client, table, "seller_sku"))
      ? `NULLIF(TRIM(seller_sku), '')`
      : "NULL";
  const upcExpr = (await hasCol(client, table, "upc")) ? `NULLIF(TRIM(upc), '')` : "NULL";

  const q = `
    SELECT
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL AND (${fnskuExpr} IS NOT NULL))::int AS fba_like,
      COUNT(*) FILTER (
        WHERE resolved_product_id IS NULL
          AND ${fnskuExpr} IS NULL
          AND (${skuExpr} IS NOT NULL OR (${asinExpr} IS NOT NULL))
      )::int AS fbm_like,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL AND ${upcExpr} IS NOT NULL)::int AS upc_like
    FROM public."${table}"
  `;
  const r = await client.query(q);
  return r.rows[0] as { fba_like: number; fbm_like: number; upc_like: number };
}

async function identifierRowCount(client: pg.Client, table: string): Promise<number | null> {
  if (!(await tableExists(client, table))) return null;
  const fnskuExpr =
    (await hasCol(client, table, "fnsku"))
      ? `NULLIF(TRIM(fnsku), '')`
      : (await hasCol(client, table, "fulfillment_channel_sku"))
        ? `NULLIF(TRIM(fulfillment_channel_sku), '')`
        : "NULL";
  const asinExpr = (await hasCol(client, table, "asin")) ? `NULLIF(TRIM(asin), '')` : "NULL";
  const skuExpr = (await hasCol(client, table, "sku"))
    ? `NULLIF(TRIM(sku), '')`
    : (await hasCol(client, table, "seller_sku"))
      ? `NULLIF(TRIM(seller_sku), '')`
      : "NULL";
  const upcExpr = (await hasCol(client, table, "upc")) ? `NULLIF(TRIM(upc), '')` : "NULL";
  const r = await client.query(`
    SELECT COUNT(*)::int AS n FROM public."${table}"
    WHERE ${fnskuExpr} IS NOT NULL OR ${asinExpr} IS NOT NULL OR ${skuExpr} IS NOT NULL OR ${upcExpr} IS NOT NULL
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function spineStats(client: pg.Client): Promise<Record<string, unknown>> {
  const products = await client.query(`SELECT COUNT(*)::int AS n FROM public.products`);
  const mapTotal = await client.query(`SELECT COUNT(*)::int AS n FROM public.product_identifier_map WHERE deleted_at IS NULL`);
  const mapWithProduct = await client.query(
    `SELECT COUNT(*)::int AS n FROM public.product_identifier_map WHERE deleted_at IS NULL AND product_id IS NOT NULL`,
  );
  const mapOrphan = await client.query(
    `SELECT COUNT(*)::int AS n FROM public.product_identifier_map WHERE deleted_at IS NULL AND product_id IS NULL`,
  );
  const productsNoMap = await client.query(`
    SELECT COUNT(*)::int AS n
    FROM public.products p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.product_identifier_map m
      WHERE m.product_id = p.id AND m.deleted_at IS NULL
    )
  `);
  return {
    products: products.rows[0]?.n,
    product_identifier_map_active: mapTotal.rows[0]?.n,
    map_with_product_id: mapWithProduct.rows[0]?.n,
    map_missing_product_id: mapOrphan.rows[0]?.n,
    products_without_map_row: productsNoMap.rows[0]?.n,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(process.env.STAGING_SUPABASE_URL?.trim() || "") || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const spine = await spineStats(client);
  const gapMatrix: GapRow[] = [];

  const wave2TablesArg = process.argv.find((x) => x.startsWith("--wave2-tables="));
  const wave2Tables = wave2TablesArg
    ? new Set(wave2TablesArg.split("=")[1]!.split(",").map((s) => s.trim()))
    : new Set<Wave2TargetTable>(["amazon_amazon_fulfilled_inventory", "amazon_manage_fba_inventory"]);

  for (const table of WAVE2_TARGET_ORDER) {
    const cov = await probeTableCoverage(client, table);
    if (!cov) continue;
    const cfg = await buildWave2TableConfig(client, table);
    const wave2: Record<string, number> = {};
    if (cfg && wave2Tables.has(table)) {
      for (const tier of WAVE2_TIERS_BY_TABLE[table]) {
        try {
          await client.query(`SET statement_timeout = '120s'`);
          wave2[`tier_${tier}`] = await countWave2TierEligible(client, cfg, tier as Wave2Tier);
        } catch (e) {
          wave2[`tier_${tier}`] = -1;
          wave2[`tier_${tier}_error`] = String(e instanceof Error ? e.message : e);
        } finally {
          await client.query(`SET statement_timeout = '0'`);
        }
      }
    } else if (cfg) {
      wave2._note = "tier counts skipped; pass --wave2-tables=<csv> for full dry-run";
    }
    const withId = (await identifierRowCount(client, table)) ?? 0;
    const cls = await classifyUnresolved(client, table);
    gapMatrix.push({
      source_table: table,
      total_rows: cov.total,
      with_identifiers: withId,
      resolved_product_id: cov.resolved,
      unresolved: cov.unresolved,
      ambiguous_status: cov.ambiguous,
      coverage_pct: cov.coverage_pct,
      wave2_safe_map_backfill: wave2,
      fba_like_unresolved: cls?.fba_like ?? null,
      fbm_like_unresolved: cls?.fbm_like ?? null,
      upc_like_unresolved: cls?.upc_like ?? null,
    });
  }

  async function extraCoverage(table: string) {
    if (!(await tableExists(client, table))) return null;
    if (!(await hasCol(client, table, "resolved_product_id"))) return null;
    const hasAmb = await hasCol(client, table, "identifier_resolution_status");
    const r = await client.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
        COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
        ${hasAmb ? ", COUNT(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::int AS ambiguous" : ", 0::int AS ambiguous"}
      FROM public."${table}"
    `);
    const row = r.rows[0] as { total: number; resolved: number; unresolved: number; ambiguous: number };
    const total = Number(row.total);
    return {
      total,
      resolved: Number(row.resolved),
      unresolved: Number(row.unresolved),
      ambiguous: Number(row.ambiguous),
      coverage_pct: total > 0 ? Math.round((Number(row.resolved) / total) * 1000) / 10 : 100,
    };
  }

  for (const table of EXTRA_TABLES) {
    const cov = await extraCoverage(table);
    if (!cov) continue;
    const cls = await classifyUnresolved(client, table);
    gapMatrix.push({
      source_table: table,
      total_rows: cov.total,
      with_identifiers: (await identifierRowCount(client, table)) ?? 0,
      resolved_product_id: cov.resolved,
      unresolved: cov.unresolved,
      ambiguous_status: cov.ambiguous,
      coverage_pct: cov.coverage_pct,
      wave2_safe_map_backfill: {},
      fba_like_unresolved: cls?.fba_like ?? null,
      fbm_like_unresolved: cls?.fbm_like ?? null,
      upc_like_unresolved: cls?.upc_like ?? null,
    });
  }

  const wave2Total = gapMatrix.reduce((s, g) => {
    for (const [k, v] of Object.entries(g.wave2_safe_map_backfill)) {
      if (k.endsWith("_error") || k === "_note") continue;
      if (typeof v === "number" && v >= 0) s += v;
    }
    return s;
  }, 0);

  const manifest = {
    prompt: "PRODUCT-CATALOG-IMPORT-COMPLETENESS-WAVE-190",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only",
    spine,
    gap_matrix: gapMatrix,
    estimated_safe_wave2_resolver_promotions: wave2Total,
    highest_value_source_table: gapMatrix
      .slice()
      .sort((a, b) => b.unresolved - a.unresolved)[0]?.source_table ?? null,
  };

  fs.writeFileSync(path.join(outDir, "gap-matrix.json"), JSON.stringify(manifest, null, 2));
  await client.end();
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
