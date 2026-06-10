/**
 * PHASE-10 PIM catalog q benchmark (staging/original via env).
 *   npx tsx scripts/phase10-pim-catalog-q-benchmark.ts
 */
import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function pgUrl(): string {
  return (
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ||
    ""
  );
}

async function benchRpc(
  client: pg.Client,
  label: string,
  q: string | null,
  deepSearch: boolean,
  runs = 5,
): Promise<{ p95: number; worst: number }> {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await client.query(
      `SELECT public.pim_catalog_products_page(
         $1::uuid, $2::uuid, 1::integer, 25::integer, $3::text,
         NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text,
         'any'::text, 'any'::text, 'any'::text, 'any'::text, 'any'::text,
         'any'::text, 'any'::text, 'any'::text, 'updated_at'::text, 'desc'::text,
         $4::boolean
       )`,
      [ORG, STORE, q, deepSearch],
    );
    ms.push(performance.now() - t0);
  }
  return { p95: percentile(ms, 95), worst: Math.max(...ms) };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = pgUrl();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL or ORIGINAL_DIRECT_POSTGRES_URL required");

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const hasPhase10 = await client.query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'pim_catalog_products_page'
       AND pg_get_function_identity_arguments(p.oid) LIKE '%boolean%'`,
  );

  const sampleSku = await client.query(
    `SELECT sku FROM products WHERE organization_id = $1 AND store_id = $2 AND deleted_at IS NULL AND sku IS NOT NULL LIMIT 1`,
    [ORG, STORE],
  );
  const sampleTitle = await client.query(
    `SELECT left(product_name, 12) AS t FROM products WHERE organization_id = $1 AND store_id = $2 AND deleted_at IS NULL AND product_name IS NOT NULL LIMIT 1`,
    [ORG, STORE],
  );

  const sku = String(sampleSku.rows[0]?.sku ?? "DEMO-SKU");
  const title = String(sampleTitle.rows[0]?.t ?? "chocolate");

  const browse = await benchRpc(client, "browse", null, false);
  const skuExact = await benchRpc(client, "sku", sku, false);
  const titleTrgm = await benchRpc(client, "title", title, false);
  const titleDeep = await benchRpc(client, "title_deep", title, true);

  await client.end();

  const report = {
    phase10_rpc: (hasPhase10.rowCount ?? 0) > 0,
    browse_p95_ms: browse.p95,
    sku_exact_p95_ms: skuExact.p95,
    title_trgm_p95_ms: titleTrgm.p95,
    title_deep_p95_ms: titleDeep.p95,
    samples: { sku, title },
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
