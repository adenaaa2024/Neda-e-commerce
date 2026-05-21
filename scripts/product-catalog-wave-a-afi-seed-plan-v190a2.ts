/**
 * PRODUCT-CATALOG-WAVE-A-AFI-SEED-PLAN-V190A2 — read-only staging classification.
 *
 *   npx tsx scripts/product-catalog-wave-a-afi-seed-plan-v190a2.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  buildWave2TableConfig,
  countWave2TierEligible,
  probeTableCoverage,
  type Wave2Tier,
} from "../lib/product-id-mapping-wave2-pg";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TABLE = "amazon_amazon_fulfilled_inventory";
const OUT_BASE = ".cursor/audit-reports/product-catalog-wave-a-afi-seed-plan-v190a2";
const V190A_RUN = "20260524T210100Z";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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
  await client.query(`SET statement_timeout = '600s'`);

  const coverage = await probeTableCoverage(client, TABLE);
  const cfg = await buildWave2TableConfig(client, TABLE);
  const wave2: Record<string, number> = {};
  if (cfg) {
    for (const tier of [1, 2, 4] as Wave2Tier[]) {
      try {
        wave2[`tier_${tier}`] = await countWave2TierEligible(client, cfg, tier);
      } catch (e) {
        wave2[`tier_${tier}`] = -1;
        wave2[`tier_${tier}_error`] = String(e instanceof Error ? e.message : e);
      }
    }
  }

  const classify = await client.query(`
    WITH u AS (
      SELECT
        t.id,
        t.organization_id,
        t.store_id,
        NULLIF(TRIM(t.fulfillment_channel_sku), '') AS fnsku,
        NULLIF(TRIM(t.seller_sku), '') AS sku,
        NULLIF(TRIM(t.asin), '') AS asin
      FROM public.amazon_amazon_fulfilled_inventory t
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
        AND t.organization_id IS NOT NULL
    ),
    fnsku_products AS (
      SELECT u.id AS afi_id, COUNT(DISTINCT p.id)::int AS n
      FROM u
      JOIN public.products p
        ON p.organization_id = u.organization_id
       AND p.store_id = u.store_id
       AND u.fnsku IS NOT NULL
       AND NULLIF(TRIM(p.fnsku), '') = u.fnsku
      GROUP BY u.id
    ),
    sku_asin_products AS (
      SELECT u.id AS afi_id, COUNT(DISTINCT p.id)::int AS n
      FROM u
      JOIN public.products p
        ON p.organization_id = u.organization_id
       AND p.store_id = u.store_id
       AND u.sku IS NOT NULL AND u.asin IS NOT NULL
       AND NULLIF(TRIM(p.sku), '') = u.sku
       AND NULLIF(TRIM(p.asin), '') = u.asin
      GROUP BY u.id
    ),
    asin_products AS (
      SELECT u.id AS afi_id, COUNT(DISTINCT p.id)::int AS n
      FROM u
      JOIN public.products p
        ON p.organization_id = u.organization_id
       AND p.store_id = u.store_id
       AND u.asin IS NOT NULL
       AND NULLIF(TRIM(p.asin), '') = u.asin
      GROUP BY u.id
    ),
    labeled AS (
      SELECT
        u.*,
        COALESCE(fp.n, 0) AS fnsku_product_count,
        COALESCE(sa.n, 0) AS sku_asin_product_count,
        COALESCE(ap.n, 0) AS asin_product_count,
        CASE
          WHEN u.fnsku IS NULL AND u.sku IS NULL AND u.asin IS NULL THEN 'no_identifiers'
          WHEN COALESCE(fp.n, 0) = 1 THEN 'single_product_via_fnsku'
          WHEN COALESCE(sa.n, 0) = 1 THEN 'single_product_via_sku_asin'
          WHEN COALESCE(ap.n, 0) = 1 THEN 'single_product_via_asin'
          WHEN GREATEST(COALESCE(fp.n,0), COALESCE(sa.n,0), COALESCE(ap.n,0)) > 1 THEN 'ambiguous_multiple_products'
          ELSE 'no_single_product_match'
        END AS bucket
      FROM u
      LEFT JOIN fnsku_products fp ON fp.afi_id = u.id
      LEFT JOIN sku_asin_products sa ON sa.afi_id = u.id
      LEFT JOIN asin_products ap ON ap.afi_id = u.id
    )
    SELECT bucket, COUNT(*)::int AS n
    FROM labeled
    GROUP BY bucket
    ORDER BY n DESC
  `);

  const buckets: Record<string, number> = {};
  for (const row of classify.rows as { bucket: string; n: number }[]) {
    buckets[row.bucket] = row.n;
  }

  const seedBatches = await client.query(`
    WITH u AS (
      SELECT
        t.id,
        t.organization_id,
        t.store_id,
        NULLIF(TRIM(t.fulfillment_channel_sku), '') AS fnsku,
        NULLIF(TRIM(t.seller_sku), '') AS sku,
        NULLIF(TRIM(t.asin), '') AS asin
      FROM public.amazon_amazon_fulfilled_inventory t
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
    ),
    single_fnsku AS (
      SELECT u.id, u.organization_id, u.store_id, u.fnsku, u.sku, u.asin,
        (SELECT p.id FROM public.products p
         WHERE p.organization_id = u.organization_id AND p.store_id = u.store_id
           AND u.fnsku IS NOT NULL AND NULLIF(TRIM(p.fnsku), '') = u.fnsku
         LIMIT 1) AS product_id
      FROM u
      WHERE u.fnsku IS NOT NULL
        AND (SELECT COUNT(DISTINCT p.id) FROM public.products p
             WHERE p.organization_id = u.organization_id AND p.store_id = u.store_id
               AND NULLIF(TRIM(p.fnsku), '') = u.fnsku) = 1
    )
    SELECT COUNT(*)::int AS promote_resolver_only FROM single_fnsku
  `);

  await client.end();

  const unresolved = coverage?.unresolved ?? 6738;
  const resolverOnly = Number(seedBatches.rows[0]?.promote_resolver_only ?? 0);
  const singleProduct =
    (buckets.single_product_via_fnsku ?? 0) +
    (buckets.single_product_via_sku_asin ?? 0) +
    (buckets.single_product_via_asin ?? 0);

  const manifest = {
    prompt: "PRODUCT-CATALOG-WAVE-A-AFI-SEED-PLAN-V190A2",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only_plan",
    v190a_execute_run_id: V190A_RUN,
    afi_coverage: coverage,
    unresolved_after_v190a: unresolved,
    wave2_remaining_eligible: wave2,
    product_table_buckets: buckets,
    single_product_match_total: singleProduct,
    ambiguous: buckets.ambiguous_multiple_products ?? 0,
    no_product_match: buckets.no_single_product_match ?? 0,
    no_identifiers: buckets.no_identifiers ?? 0,
    recommended_batches: {
      batch_a_resolver_tier2_4: {
        description: "Wave-2 tier 2/4 resolver only (existing products via map)",
        estimated_rows: (wave2.tier_2 ?? 0) + (wave2.tier_4 ?? 0),
      },
      batch_b_link_existing_product: {
        description: "UPDATE AFI resolved_* from single products match (no new product, may need map insert first)",
        estimated_rows: singleProduct,
      },
      batch_c_governed_product_create: {
        description: "NEXT-PRODUCT-32 style product+map CREATE — separate approval",
        estimated_rows: buckets.no_single_product_match ?? 0,
      },
    },
    product_creation_allowed_on_afi: false,
  };

  fs.writeFileSync(path.join(outDir, "classification.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
