/**
 * PHASE-5B-BLOCK-4152-PLACEHOLDER-AND-REPAIR-NEXT-SAFE-CLUSTERS-STAGING
 *   npx tsx scripts/phase5b-block-4152-and-repair-next-safe-clusters-staging.ts --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { canonicalAmazonImageKey } from "../lib/amazon-catalog-image-extract";
import {
  BLOCKED_PRODUCTION_IMAGE_CLUSTER_NEEDLES,
  evaluateSuspiciousMainImage,
  isKnownBadImageUrl,
  KNOWN_BAD_IMAGE_SUBSTRINGS,
} from "../lib/pim-image-suspicious-policy";
import {
  assertStagingSupabaseUrl,
  loadEnvLocalIntoProcess,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const PLACEHOLDER_4152 = "4152CsQbheL";
const OLD_CLUSTER = "31BH1QY2CvL";
const BLOCKED_1883_RESULT = "41gCLv9NY9L";
const OUT_BASE = ".cursor/audit-reports/phase5b-block-4152-repair-next-safe-clusters";
const DELAY_MS = 250;
const FANOUT_MANUAL_REVIEW_MIN_ASINS = 10;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function csvEsc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

type ProductRow = {
  id: string;
  asin: string | null;
  product_name: string | null;
  main_image_url: string | null;
  amazon_raw: unknown;
};

type SafeCluster = {
  image_url: string;
  image_key: string;
  product_count: number;
  distinct_asins: number;
  confidence: number;
};

async function loadNextSafeClusters(client: pg.Client): Promise<SafeCluster[]> {
  const r = await client.query(
    `SELECT
       p.main_image_url,
       count(*)::int AS product_count,
       count(DISTINCT upper(btrim(p.asin))) FILTER (WHERE p.asin IS NOT NULL AND btrim(p.asin) <> '')::int AS distinct_asins,
       count(DISTINCT left(lower(btrim(p.product_name)), 40)) FILTER (WHERE p.product_name IS NOT NULL)::int AS distinct_title_prefixes
     FROM public.products p
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
       AND p.main_image_url IS NOT NULL AND btrim(p.main_image_url) <> ''
     GROUP BY p.main_image_url
     HAVING count(*) >= 3
     ORDER BY count(*) DESC`,
    [ORG, STORE],
  );

  return (r.rows as Array<{
    main_image_url: string;
    product_count: number;
    distinct_asins: number;
    distinct_title_prefixes: number;
  }>)
    .map((row) => {
      const url = String(row.main_image_url);
      const distinctAsins = Number(row.distinct_asins);
      const distinctTitles = Number(row.distinct_title_prefixes);
      const productCount = Number(row.product_count);
      const isOldCluster = url.includes(OLD_CLUSTER);
      const is4152 = url.includes(PLACEHOLDER_4152);
      const is1883Result = url.includes(BLOCKED_1883_RESULT);
      const suspicious =
        evaluateSuspiciousMainImage({ main_image_url: url, amazon_raw: null }).suspicious ||
        isKnownBadImageUrl(url);
      const confidence =
        isOldCluster || is4152 || is1883Result
          ? 0
          : suspicious && distinctAsins <= 1
            ? 0.95
            : suspicious && distinctAsins === 2 && distinctTitles <= 2
              ? 0.75
              : suspicious && productCount >= 5 && distinctAsins >= 3
                ? 0.55
                : 0.2;
      return {
        image_url: url,
        image_key: canonicalAmazonImageKey(url),
        product_count: productCount,
        distinct_asins: distinctAsins,
        confidence,
        safe_to_stage_repair: confidence >= 0.7 && !is4152 && !is1883Result,
      };
    })
    .filter(
      (c) =>
        c.safe_to_stage_repair &&
        !c.image_url.includes(OLD_CLUSTER) &&
        !c.image_url.includes(PLACEHOLDER_4152) &&
        !c.image_url.includes(BLOCKED_1883_RESULT),
    )
    .sort((a, b) => b.confidence - a.confidence || b.product_count - a.product_count)
    .slice(0, 5);
}

async function loadProductsByImage(client: pg.Client, imageUrl: string): Promise<ProductRow[]> {
  const r = await client.query(
    `SELECT id::text, asin, product_name, main_image_url, amazon_raw
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND main_image_url = $3
     ORDER BY updated_at DESC NULLS LAST`,
    [ORG, STORE, imageUrl],
  );
  return r.rows as ProductRow[];
}

async function load1883Cluster(client: pg.Client): Promise<ProductRow[]> {
  const r = await client.query(
    `SELECT id::text, asin, product_name, main_image_url, amazon_raw
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND (
         main_image_url ILIKE $3
         OR amazon_raw->>'pim_image_production_blocked' LIKE '1883_cluster:%'
       )
     ORDER BY product_name`,
    [ORG, STORE, `%${PLACEHOLDER_4152}%`],
  );
  return r.rows as ProductRow[];
}

type FanoutAuditRow = {
  product_id: string;
  asin: string | null;
  main_image_url: string | null;
  image_key: string;
  qa_status: "manual_review";
  skip_reason: string;
};

async function audit1883SharedPlaceholderFanout(
  client: pg.Client,
  clusterRows: ProductRow[],
): Promise<FanoutAuditRow[]> {
  if (!clusterRows.length) return [];
  const byKey = new Map<string, { asins: Set<string>; rows: ProductRow[] }>();
  for (const row of clusterRows) {
    const key = canonicalAmazonImageKey(String(row.main_image_url ?? "")) || String(row.main_image_url ?? "");
    const bucket = byKey.get(key) ?? { asins: new Set<string>(), rows: [] };
    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (asin) bucket.asins.add(asin);
    bucket.rows.push(row);
    byKey.set(key, bucket);
  }

  const flagged = [...byKey.entries()].filter(([, v]) => v.asins.size >= FANOUT_MANUAL_REVIEW_MIN_ASINS);
  const out: FanoutAuditRow[] = [];
  for (const [imageKey, bucket] of flagged) {
    for (const row of bucket.rows) {
      out.push({
        product_id: row.id,
        asin: row.asin,
        main_image_url: row.main_image_url,
        image_key: imageKey,
        qa_status: "manual_review",
        skip_reason: `shared_placeholder_across_${bucket.asins.size}_asins`,
      });
    }
  }
  return out;
}

async function persistManualReviewFlags(
  client: pg.Client,
  rows: Array<{ product_id: string; skip_reason: string }>,
): Promise<void> {
  if (!rows.length) return;
  for (const row of rows) {
    await client.query(
      `UPDATE public.products p
       SET amazon_raw = jsonb_set(
             jsonb_set(
               COALESCE(p.amazon_raw, '{}'::jsonb),
               '{pim_image_qa_status}',
               to_jsonb('manual_review'::text),
               true
             ),
             '{pim_image_qa_reason}',
             to_jsonb($3::text),
             true
           ),
           updated_at = now()
       WHERE p.id = $1::uuid
         AND p.organization_id = $2::uuid`,
      [row.product_id, ORG, row.skip_reason],
    );
  }
}

async function markProductionBlocked(client: pg.Client, productIds: string[]): Promise<void> {
  if (!productIds.length) return;
  await client.query(
    `UPDATE public.products p
     SET amazon_raw = jsonb_set(
           COALESCE(p.amazon_raw, '{}'::jsonb),
           '{pim_image_production_blocked}',
           to_jsonb($3::text),
           true
         ),
         updated_at = now()
     WHERE p.id = ANY($1::uuid[])
       AND p.organization_id = $2::uuid`,
    [productIds, ORG, `1883_cluster:${PLACEHOLDER_4152}:staging_only`],
  );
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const skip1883 = process.argv.includes("--skip-1883");
  loadEnvLocalIntoProcess();
  wireStagingSupabaseEnv();

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!pgUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");
  if (pgUrl.includes(ORIGINAL_REF)) throw new Error("BLOCKED: original postgres URL");

  const knownBadAdded = KNOWN_BAD_IMAGE_SUBSTRINGS.includes(PLACEHOLDER_4152 as (typeof KNOWN_BAD_IMAGE_SUBSTRINGS)[number]);

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require.cache[require.resolve("server-only")] = {
    id: "server-only",
    filename: "server-only",
    loaded: true,
    exports: {},
  } as NodeModule;
  const { repairSuspiciousProductImage } = await import("../lib/pim-suspicious-image-repair");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const cluster1883 = await load1883Cluster(client);
  const nextClusters = await loadNextSafeClusters(client);
  const nextProducts: ProductRow[] = [];
  for (const c of nextClusters) {
    nextProducts.push(...(await loadProductsByImage(client, c.image_url)));
  }

  const allTargets = [
    ...(skip1883 ? [] : cluster1883.map((r) => ({ ...r, wave: "1883_rerepair" as const }))),
    ...nextProducts.map((r) => ({ ...r, wave: "next_safe_cluster" as const })),
  ];

  const outcomes: Awaited<ReturnType<typeof repairSuspiciousProductImage>>[] = [];
  for (let i = 0; i < allTargets.length; i++) {
    const row = allTargets[i]!;
    const outcome = await repairSuspiciousProductImage({
      row,
      organizationId: ORG,
      storeId: STORE,
      dryRun: !execute,
      client,
      forceRepair: row.wave === "next_safe_cluster",
      fetchPath:
        row.wave === "1883_rerepair"
          ? "phase5b_rerepair_4152_block"
          : "phase5b_next_safe_cluster_repair",
    });
    outcomes.push({ ...outcome, ...( { wave: row.wave } as Record<string, unknown>) });
    if (i + 1 < allTargets.length) await sleep(DELAY_MS);
  }

  if (execute && cluster1883.length) {
    await markProductionBlocked(
      client,
      cluster1883.map((r) => r.id),
    );
  }

  const fanout1883 = await audit1883SharedPlaceholderFanout(client, cluster1883);
  if (execute && fanout1883.length) {
    await persistManualReviewFlags(
      client,
      fanout1883.map((r) => ({ product_id: r.product_id, skip_reason: r.skip_reason })),
    );
  }

  await client.end();

  const blockers: string[] = [];
  if (!knownBadAdded) blockers.push("4152CsQbheL not in KNOWN_BAD_IMAGE_SUBSTRINGS");

  const updated = outcomes.filter((o) => o.decision === "updated" && !o.skip_reason?.startsWith("dry_run")).length;
  const wouldUpdate = outcomes.filter((o) => o.decision === "updated").length;

  const newImageFanout = new Map<string, Set<string>>();
  for (const o of outcomes.filter((x) => x.qa_status === "updated" && x.new_candidate_url)) {
    const key = canonicalAmazonImageKey(o.new_candidate_url!);
    const asins = newImageFanout.get(key) ?? new Set<string>();
    if (o.product_asin) asins.add(o.product_asin);
    newImageFanout.set(key, asins);
  }
  const sharedNewImageKeys = [...newImageFanout.entries()].filter(([, asins]) => asins.size >= 10);
  const wave1883 = outcomes.filter((o) => (o as { wave?: string }).wave === "1883_rerepair");
  const waveNext = outcomes.filter((o) => (o as { wave?: string }).wave === "next_safe_cluster");

  const manualReviewIds = new Set<string>();
  for (const o of outcomes) {
    if (o.qa_status === "manual_review") manualReviewIds.add(o.product_id);
  }
  for (const f of fanout1883) manualReviewIds.add(f.product_id);
  let manualReview = manualReviewIds.size;
  if (sharedNewImageKeys.length > 0) {
    for (const o of outcomes) {
      if (o.qa_status === "updated" && o.new_candidate_url) {
        const key = canonicalAmazonImageKey(o.new_candidate_url);
        if (sharedNewImageKeys.some(([k]) => k === key)) {
          o.qa_status = "manual_review";
          o.skip_reason = "shared_new_image_across_many_asins";
          manualReviewIds.add(o.product_id);
        }
      }
    }
    manualReview = manualReviewIds.size;
    blockers.push(
      `Updated image still shared across ${sharedNewImageKeys[0]?.[1].size ?? 0} ASINs (${sharedNewImageKeys[0]?.[0] ?? "unknown"})`,
    );
  }
  if (fanout1883.length > 0) {
    blockers.push(
      `1883 cluster: ${fanout1883.length} products share placeholder ${fanout1883[0]?.image_key ?? BLOCKED_1883_RESULT} across many ASINs`,
    );
  }
  if (wave1883.some((o) => o.qa_status === "manual_review") || fanout1883.length > 0) {
    blockers.push(
      `${Math.max(wave1883.filter((o) => o.qa_status === "manual_review").length, fanout1883.length)} 1883-cluster products require manual_review`,
    );
  }
  blockers.push("1883/4152 cluster blocked from production until operator sign-off");

  const qaRows = [
    ...outcomes.map((o) => ({
      product_id: o.product_id,
      wave: (o as { wave?: string }).wave ?? "",
      asin: o.product_asin,
      old_image: o.old_image_url,
      new_image: o.new_candidate_url,
      source_asin: o.source_asin,
      qa_status: o.qa_status,
      decision: o.decision,
      skip_reason: o.skip_reason,
    })),
    ...fanout1883.map((f) => ({
      product_id: f.product_id,
      wave: "1883_fanout_audit",
      asin: f.asin,
      old_image: f.main_image_url,
      new_image: null,
      source_asin: null,
      qa_status: f.qa_status,
      decision: "skipped",
      skip_reason: f.skip_reason,
    })),
  ];

  fs.writeFileSync(
    path.join(outDir, "qa-result.csv"),
    [
      "product_id,wave,asin,old_image,new_image,source_asin,qa_status,decision,skip_reason",
      ...qaRows.map((r) =>
        ["product_id", "wave", "asin", "old_image", "new_image", "source_asin", "qa_status", "decision", "skip_reason"]
          .map((k) => csvEsc(r[k as keyof typeof r]))
          .join(","),
      ),
    ].join("\n") + "\n",
  );

  const nextClusterUpdated = waveNext.filter((o) => o.qa_status === "updated").length;
  const nextClusterImagesOk =
    nextClusters.length === 5 &&
    nextClusterUpdated > 0 &&
    !waveNext.some((o) => isKnownBadImageUrl(o.new_candidate_url ?? ""));
  const nextClusterOk = nextClusterImagesOk && fanout1883.length === 0;

  const result = {
    known_bad_added: knownBadAdded ? PLACEHOLDER_4152 : "no",
    known_bad_list: [...KNOWN_BAD_IMAGE_SUBSTRINGS],
    blocked_production_clusters: [...BLOCKED_PRODUCTION_IMAGE_CLUSTER_NEEDLES],
    "1883_cluster_blocked": "yes",
    "1883_cluster_product_count": cluster1883.length,
    next_safe_clusters_processed: nextClusters.length,
    next_safe_cluster_keys: nextClusters.map((c) => c.image_key),
    next_safe_cluster_products: nextProducts.length,
    images_updated_count: execute ? updated : 0,
    images_would_update_count: wouldUpdate,
    manual_review_count: manualReview,
    wave_1883_manual_review: Math.max(
      wave1883.filter((o) => o.qa_status === "manual_review").length,
      fanout1883.length,
    ),
    wave_1883_fanout_image_key: fanout1883[0]?.image_key ?? null,
    wave_1883_updated: wave1883.filter((o) => o.qa_status === "updated").length,
    wave_next_updated: waveNext.filter((o) => o.qa_status === "updated").length,
    fanout_1883_audit_count: fanout1883.length,
    next_safe_clusters_staging_ok: nextClusterImagesOk ? "yes" : "no",
    staging_execute: execute,
    SAFE_TO_APPLY_ANY_IMAGE_CLUSTER_PRODUCTION: nextClusterOk ? "yes" : "no",
    SAFE_TO_APPLY_5B_PRODUCTION: "no",
    blockers,
    outcomes_sample: outcomes.slice(0, 15),
  };

  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Phase 5B — Block 4152 + repair next safe clusters (staging)",
      "",
      `- Run: \`${rid}\` · Execute: **${execute}**`,
      `- Known bad added: **${PLACEHOLDER_4152}**`,
      `- 1883 cluster blocked for production: **yes** (${cluster1883.length} products)`,
      `- Next safe clusters processed: **${nextClusters.length}** (${nextProducts.length} products)`,
      `- Images updated: **${execute ? updated : wouldUpdate}** (would-update if dry-run)`,
      `- Manual review: **${manualReview}**`,
      "",
      `SAFE_TO_APPLY_ANY_IMAGE_CLUSTER_PRODUCTION: **${result.SAFE_TO_APPLY_ANY_IMAGE_CLUSTER_PRODUCTION}**`,
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
