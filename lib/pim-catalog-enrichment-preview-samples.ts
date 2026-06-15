import pg from "pg";

export const PIM_PREVIEW_STALE_ASIN = "B00D6Q9E3E";
export const PIM_PREVIEW_MAX_SAMPLES = 10;

export type PimPreviewSampleRow = {
  id: string;
  asin: string | null;
  product_name: string | null;
  updated_at: string | null;
  bucket: string;
};

async function connectReadonly(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '60s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

export async function selectPimPreviewSampleProducts(args: {
  postgresUrl: string;
  organizationId: string;
  storeId: string;
  maxSamples?: number;
}): Promise<PimPreviewSampleRow[]> {
  const { postgresUrl, organizationId, storeId } = args;
  const maxSamples = args.maxSamples ?? PIM_PREVIEW_MAX_SAMPLES;
  const c = await connectReadonly(postgresUrl);

  try {
    const linked = await c.query(
      `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
       FROM products p
       WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
         AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
         AND EXISTS (
           SELECT 1 FROM product_prices pp
           WHERE pp.organization_id=p.organization_id AND pp.store_id=p.store_id AND pp.product_id=p.id
         )
       ORDER BY p.updated_at DESC NULLS LAST LIMIT 1`,
      [organizationId, storeId],
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
       ORDER BY p.updated_at DESC NULLS LAST LIMIT 1`,
      [organizationId, storeId],
    );
    const unresolved = await c.query(
      `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
       FROM products p
       WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
         AND (p.asin IS NULL OR btrim(p.asin) = '')
       ORDER BY p.updated_at DESC NULLS LAST LIMIT 1`,
      [organizationId, storeId],
    );
    const recent = await c.query(
      `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
       FROM products p
       WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
         AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
       ORDER BY p.updated_at DESC NULLS LAST LIMIT 3`,
      [organizationId, storeId],
    );

    const out: PimPreviewSampleRow[] = [];
    const seen = new Set<string>();
    const push = (row: Record<string, unknown>, bucket: string) => {
      const id = String(row.id ?? "");
      if (!id || seen.has(id)) return;
      const asin = row.asin ? String(row.asin).trim() : "";
      if (!asin || asin.toUpperCase() === PIM_PREVIEW_STALE_ASIN) return;
      seen.add(id);
      out.push({
        id,
        asin,
        product_name: row.product_name ? String(row.product_name) : null,
        updated_at: row.updated_at ? String(row.updated_at) : null,
        bucket,
      });
    };

    for (const r of linked.rows) push(r, "linked_asin_with_price");
    for (const r of missingPrice.rows) push(r, "missing_price");
    for (const r of recent.rows) push(r, "recently_updated");

    if (out.length < maxSamples) {
      const extra = await c.query(
        `SELECT p.id::text, p.asin, p.product_name, p.updated_at::text
         FROM products p
         WHERE p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
           AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
         ORDER BY random() LIMIT 5`,
        [organizationId, storeId],
      );
      for (const r of extra.rows) {
        push(r, "linked_asin_extra");
        if (out.length >= maxSamples) break;
      }
    }

    void unresolved.rows;
    return out.slice(0, maxSamples);
  } finally {
    await c.end();
  }
}

export function pickPreviewProductIds(samples: PimPreviewSampleRow[]): string[] {
  return samples.map((s) => s.id);
}

export type ProductDataUpdatePreviewSummary = {
  ran_at: string;
  dry_run: true;
  sample_count: number;
  sample_products: PimPreviewSampleRow[];
  would_update_count: number;
  would_skip_count: number;
  missing_data_count: number;
  api_errors: { product_id: string; reason: string }[];
  rate_limit_warnings: string[];
  metrics: Record<string, unknown>;
};

export function buildPreviewSummary(args: {
  samples: PimPreviewSampleRow[];
  metrics: Record<string, unknown>;
  failures: { product_id: string; reason: string }[];
}): ProductDataUpdatePreviewSummary {
  const { samples, metrics, failures } = args;
  const throttled = Number(metrics.throttled_count ?? 0);
  const pricingThrottled = Number(metrics.pricing_throttled_count ?? 0);
  const warnings: string[] = [];
  if (throttled > 0) warnings.push(`catalog/pricing throttled: ${throttled}`);
  if (pricingThrottled > 0) warnings.push(`pricing throttled: ${pricingThrottled}`);
  if (Number(metrics.deferred_count ?? 0) > 0) {
    warnings.push(`deferred (429): ${metrics.deferred_count}`);
  }

  return {
    ran_at: new Date().toISOString(),
    dry_run: true,
    sample_count: samples.length,
    sample_products: samples,
    would_update_count: Number(metrics.would_update_count ?? 0),
    would_skip_count: Number(metrics.would_skip_count ?? 0),
    missing_data_count: Number(metrics.missing_data_count ?? 0),
    api_errors: failures.slice(0, 10),
    rate_limit_warnings: warnings,
    metrics,
  };
}
