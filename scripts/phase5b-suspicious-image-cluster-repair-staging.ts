/**
 * PHASE-5B-FIX-SUSPICIOUS-IMAGE-CLUSTERS-STAGING
 * Targeted image repair on staging — no bulk refresh, no product_identifier_map writes.
 *
 *   npx tsx scripts/phase5b-suspicious-image-cluster-repair-staging.ts
 *   npx tsx scripts/phase5b-suspicious-image-cluster-repair-staging.ts --execute
 *   npx tsx scripts/phase5b-suspicious-image-cluster-repair-staging.ts --execute --cluster=31BH1QY2CvL --limit=20
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { evaluateSuspiciousMainImage } from "../lib/pim-image-suspicious-policy";
import {
  assertStagingSupabaseUrl,
  loadEnvLocalIntoProcess,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const DEFAULT_CLUSTER = "31BH1QY2CvL";
const DELAY_MS = 250;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`${prefix}=`));
  return a ? a.split("=").slice(1).join("=").trim() : null;
}

function wireStagingSupabaseEnv(): void {
  const stagingUrl =
    process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const stagingKey =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() ||
    process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (stagingUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl;
  if (stagingKey) process.env.SUPABASE_SERVICE_ROLE_KEY = stagingKey;
  assertStagingSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", "NEXT_PUBLIC_SUPABASE_URL");
}

async function loadClusterProductIds(
  client: pg.Client,
  clusterNeedle: string | null,
  productId: string | null,
  limit: number,
): Promise<
  Array<{
    id: string;
    asin: string | null;
    product_name: string | null;
    main_image_url: string | null;
    amazon_raw: unknown;
  }>
> {
  if (productId) {
    const r = await client.query(
      `SELECT id::text, asin, product_name, main_image_url, amazon_raw
       FROM public.products
       WHERE id = $1::uuid AND organization_id = $2::uuid AND store_id = $3::uuid AND deleted_at IS NULL`,
      [productId, ORG, STORE],
    );
    return r.rows as Array<{
      id: string;
      asin: string | null;
      product_name: string | null;
      main_image_url: string | null;
      amazon_raw: unknown;
    }>;
  }
  const r = await client.query(
    `SELECT id::text, asin, product_name, main_image_url, amazon_raw
     FROM public.products
     WHERE organization_id = $1::uuid
       AND store_id = $2::uuid
       AND deleted_at IS NULL
       AND main_image_url ILIKE $3
     ORDER BY updated_at DESC NULLS LAST
     LIMIT $4`,
    [ORG, STORE, `%${clusterNeedle ?? DEFAULT_CLUSTER}%`, limit],
  );
  return r.rows as Array<{
    id: string;
    asin: string | null;
    product_name: string | null;
    main_image_url: string | null;
    amazon_raw: unknown;
  }>;
}

async function main() {
  loadEnvLocalIntoProcess();
  wireStagingSupabaseEnv();

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require.cache[require.resolve("server-only")] = {
    id: "server-only",
    filename: "server-only",
    loaded: true,
    exports: {},
  } as NodeModule;

  const { repairSuspiciousProductImage } = await import("../lib/pim-suspicious-image-repair");

  const execute = process.argv.includes("--execute");
  const clusterNeedle = argValue("--cluster");
  const productId = argValue("--product-id");
  const limit = Math.min(500, Math.max(1, Number(argValue("--limit") ?? "113") || 113));
  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!pgUrl.includes(STAGING_REF)) {
    throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");
  }
  if (pgUrl.includes(ORIGINAL_REF)) {
    throw new Error("BLOCKED: original postgres URL");
  }

  const id = runId();
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/product-image-linkage-repair", id);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const rows = await loadClusterProductIds(client, clusterNeedle, productId, limit);
  const outcomes: Awaited<ReturnType<typeof repairSuspiciousProductImage>>[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const suspicious = evaluateSuspiciousMainImage(row);
    if (!productId && !suspicious.suspicious) {
      outcomes.push({
        product_id: row.id,
        product_asin: row.asin,
        old_image_url: row.main_image_url,
        new_candidate_url: null,
        source_asin: null,
        decision: "skipped",
        skip_reason: "not_flagged_in_cluster_query",
        suspicious_reasons: [],
      });
      continue;
    }
    const outcome = await repairSuspiciousProductImage({
      row,
      organizationId: ORG,
      storeId: STORE,
      dryRun: !execute,
      client,
    });
    outcomes.push(outcome);
    if (i + 1 < rows.length) await sleep(DELAY_MS);
  }

  await client.end();

  const updated = outcomes.filter((o) => o.decision === "updated" && !o.skip_reason?.startsWith("dry_run")).length;
  const wouldUpdate = outcomes.filter((o) => o.decision === "updated").length;
  const skipped = outcomes.filter((o) => o.decision === "skipped" || o.skip_reason?.startsWith("dry_run")).length;

  const summary = {
    phase_number: "5B",
    run_id: id,
    staging_applied: execute,
    staging_ref: STAGING_REF,
    cluster_needle: clusterNeedle ?? DEFAULT_CLUSTER,
    product_id: productId,
    targeted_clusters_processed: productId ? [`product:${productId}`] : [clusterNeedle ?? DEFAULT_CLUSTER],
    products_in_cluster: rows.length,
    images_updated_count: execute ? updated : 0,
    images_would_update_count: wouldUpdate,
    images_skipped_count: skipped,
    new_columns_created: false,
    new_columns_reason: "provenance stored in products.amazon_raw (pim_image_provenance + flat keys)",
    resolver_consistency_fixed: true,
    fnsku_asin_guard_added: true,
    suspicious_overwrite_policy_added: true,
    sample_before_after: outcomes.slice(0, 10),
    SAFE_TO_APPLY_5B_PRODUCTION: execute && updated > 0 ? "no_pending_staging_review" : "no",
    blockers: execute
      ? []
      : ["dry_run — pass --execute to apply on staging"],
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "outcomes.json"), JSON.stringify(outcomes, null, 2));

  console.log(
    JSON.stringify({
      outDir,
      execute,
      cluster: clusterNeedle,
      products: rows.length,
      would_update: wouldUpdate,
      updated: execute ? updated : 0,
      skipped,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
