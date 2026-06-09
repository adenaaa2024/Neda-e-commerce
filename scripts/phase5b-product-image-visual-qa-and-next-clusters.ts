/**
 * PHASE-5B-PRODUCT-IMAGE-VISUAL-QA-AND-NEXT-CLUSTERS (read-only staging QA)
 *   npx tsx scripts/phase5b-product-image-visual-qa-and-next-clusters.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { canonicalAmazonImageKey } from "../lib/amazon-catalog-image-extract";
import {
  evaluateSuspiciousMainImage,
  isKnownBadImageUrl,
  KNOWN_BAD_IMAGE_SUBSTRINGS,
} from "../lib/pim-image-suspicious-policy";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REPAIR_FETCH_PATH = "phase5b_suspicious_image_repair";
const OLD_CLUSTER = "31BH1QY2CvL";
const OUT_BASE = ".cursor/audit-reports/phase5b-product-image-visual-qa";

type QaRow = {
  product_id: string;
  title: string | null;
  asin: string | null;
  old_image: string | null;
  new_image: string | null;
  source_asin: string | null;
  reason: string | null;
  recommendation: "accept" | "rollback" | "manual_review";
  recommendation_detail: string;
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function csvEsc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  fs.writeFileSync(
    filePath,
    [headers.join(","), ...rows.map((r) => headers.map((h) => csvEsc(r[h])).join(","))].join("\n") + "\n",
    "utf8",
  );
}

function normAsin(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

function imageKey(url: string | null | undefined): string {
  return canonicalAmazonImageKey(String(url ?? "").trim()) || String(url ?? "").trim();
}

function titlePrefix(title: string | null | undefined): string {
  return String(title ?? "")
    .trim()
    .slice(0, 40)
    .toLowerCase();
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL guard failed");
  if (!originalUrl.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL guard failed");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  await staging.connect();
  await original.connect();
  await staging.query("SET statement_timeout = '180s'");
  await original.query("SET statement_timeout = '180s'");

  const repaired = await staging.query(
    `SELECT
       p.id::text,
       p.product_name,
       p.asin,
       p.main_image_url,
       p.amazon_raw,
       p.updated_at::text,
       p.amazon_raw->'pim_image_provenance'->>'image_source_asin' AS source_asin,
       p.amazon_raw->'pim_image_provenance'->>'overwrite_reason' AS overwrite_reason,
       p.amazon_raw->'pim_image_provenance'->>'image_fetch_path' AS fetch_path
     FROM public.products p
     WHERE p.organization_id = $1::uuid
       AND p.store_id = $2::uuid
       AND p.deleted_at IS NULL
       AND (
         p.amazon_raw->'pim_image_provenance'->>'image_fetch_path' = $3
         OR p.amazon_raw->'pim_image_provenance'->>'overwrite_reason' LIKE '%known_bad%'
       )
     ORDER BY p.updated_at DESC NULLS LAST`,
    [ORG, STORE, REPAIR_FETCH_PATH],
  );

  const ids = repaired.rows.map((r: { id: string }) => r.id);
  const oldById = new Map<string, string | null>();
  if (ids.length) {
    const oldRows = await original.query(
      `SELECT id::text, main_image_url FROM public.products
       WHERE id = ANY($1::uuid[]) AND organization_id = $2::uuid`,
      [ids, ORG],
    );
    for (const r of oldRows.rows as Array<{ id: string; main_image_url: string | null }>) {
      oldById.set(r.id, r.main_image_url);
    }
  }

  const replacementUsage = await staging.query(
    `SELECT
       p.main_image_url,
       count(*)::int AS product_count,
       count(DISTINCT upper(btrim(p.asin))) FILTER (WHERE p.asin IS NOT NULL AND btrim(p.asin) <> '')::int AS distinct_asins,
       count(DISTINCT left(lower(btrim(p.product_name)), 40)) FILTER (WHERE p.product_name IS NOT NULL)::int AS distinct_title_prefixes,
       array_agg(DISTINCT upper(btrim(p.asin))) FILTER (WHERE p.asin IS NOT NULL) AS sample_asins
     FROM public.products p
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
       AND p.main_image_url IS NOT NULL AND btrim(p.main_image_url) <> ''
     GROUP BY p.main_image_url
     HAVING count(*) >= 2
     ORDER BY count(*) DESC
     LIMIT 200`,
    [ORG, STORE],
  );

  const replacementClusters = (replacementUsage.rows as Array<Record<string, unknown>>).map((r) => ({
    image_url: String(r.main_image_url),
    image_key: imageKey(String(r.main_image_url)),
    product_count: Number(r.product_count),
    distinct_asins: Number(r.distinct_asins),
    distinct_title_prefixes: Number(r.distinct_title_prefixes),
    suspicious:
      Number(r.distinct_asins) >= 3 ||
      (Number(r.product_count) >= 10 && Number(r.distinct_title_prefixes) >= 5),
    contains_4152: String(r.main_image_url).includes("4152CsQbheL"),
    contains_old_cluster: KNOWN_BAD_IMAGE_SUBSTRINGS.some((s) => String(r.main_image_url).includes(s)),
  }));

  const cluster4152 = replacementClusters.find((c) => c.contains_4152);
  const replacementStillSuspicious =
    Boolean(cluster4152?.suspicious) ||
    (cluster4152 != null && Number(cluster4152.product_count) >= 50);

  const qaRows: QaRow[] = [];
  let accepted = 0;
  let manual = 0;
  let rollback = 0;

  for (const row of repaired.rows as Array<Record<string, unknown>>) {
    const productId = String(row.id);
    const oldImage = oldById.get(productId) ?? (String(row.main_image_url ?? "").includes(OLD_CLUSTER) ? String(row.main_image_url) : null);
    const newImage = String(row.main_image_url ?? "") || null;
    const productAsin = normAsin(row.asin as string | null);
    const sourceAsin = normAsin(row.source_asin as string | null);
    const reason = String(row.overwrite_reason ?? "known_bad_url_cluster|main_image_not_in_amazon_raw_candidates");

    let recommendation: QaRow["recommendation"] = "accept";
    let recommendationDetail = "source_asin_matches_product; replacement_not_known_bad";

    if (isKnownBadImageUrl(newImage)) {
      recommendation = "rollback";
      recommendationDetail = "new_image_still_known_bad_placeholder";
    } else if (sourceAsin && productAsin && sourceAsin !== productAsin) {
      recommendation = "manual_review";
      recommendationDetail = "source_asin_differs_from_product_asin";
    } else if (replacementStillSuspicious && newImage?.includes("4152CsQbheL")) {
      recommendation = "manual_review";
      recommendationDetail = "replacement_4152CsQbheL_still_high_fanout_across_catalog";
    } else if (evaluateSuspiciousMainImage({ main_image_url: newImage, amazon_raw: row.amazon_raw }).suspicious) {
      recommendation = "manual_review";
      recommendationDetail = "new_image_still_flags_suspicious_policy";
    } else if (!sourceAsin || !productAsin) {
      recommendation = "manual_review";
      recommendationDetail = "missing_asin_for_provenance_check";
    }

    if (recommendation === "accept") accepted++;
    else if (recommendation === "rollback") rollback++;
    else manual++;

    qaRows.push({
      product_id: productId,
      title: row.product_name as string | null,
      asin: row.asin as string | null,
      old_image: oldImage,
      new_image: newImage,
      source_asin: row.source_asin as string | null,
      reason,
      recommendation,
      recommendation_detail: recommendationDetail,
    });
  }

  const badClusters = await staging.query(
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

  const nextClusters = (badClusters.rows as Array<Record<string, unknown>>)
    .map((r) => {
      const url = String(r.main_image_url);
      const key = imageKey(url);
      const distinctAsins = Number(r.distinct_asins);
      const distinctTitles = Number(r.distinct_title_prefixes);
      const productCount = Number(r.product_count);
      const isOldCluster = url.includes(OLD_CLUSTER);
      const is4152 = url.includes("4152CsQbheL");
      const suspicious = evaluateSuspiciousMainImage({ main_image_url: url, amazon_raw: null }).suspicious || isKnownBadImageUrl(url);
      const confidence =
        isOldCluster || is4152
          ? 0
          : suspicious && distinctAsins <= 1
            ? 0.95
            : suspicious && distinctAsins === 2 && distinctTitles <= 2
              ? 0.75
              : suspicious && productCount >= 5 && distinctAsins >= 3
                ? 0.55
                : 0.2;
      return {
        image_key: key,
        image_url_sample: url.slice(0, 120),
        product_count: productCount,
        distinct_asins: distinctAsins,
        distinct_title_prefixes: distinctTitles,
        known_bad: isKnownBadImageUrl(url),
        confidence,
        safe_to_stage_repair: confidence >= 0.7 && !is4152,
      };
    })
    .filter((c) => !c.image_url_sample.includes(OLD_CLUSTER) && !c.image_url_sample.includes("4152CsQbheL"))
    .sort((a, b) => b.confidence - a.confidence || b.product_count - a.product_count)
    .slice(0, 5);

  await staging.end();
  await original.end();

  const qaHeaders = [
    "product_id",
    "title",
    "asin",
    "old_image",
    "new_image",
    "source_asin",
    "reason",
    "recommendation",
    "recommendation_detail",
  ];
  writeCsv(path.join(outDir, "qa_updated_products.csv"), qaHeaders, qaRows);

  const clusterRec =
    rollback > 0
      ? "rollback_cluster"
      : manual > accepted
        ? "hold_for_manual_review"
        : replacementStillSuspicious
          ? "hold_for_manual_review"
          : "accept_cluster";

  const blockers: string[] = [];
  if (replacementStillSuspicious) {
    blockers.push("Replacement image 4152CsQbheL still shared across many products/ASINs on staging");
  }
  if (manual > 0) {
    blockers.push(`${manual} repaired products flagged for manual_review before production`);
  }
  blockers.push("SAFE_TO_APPLY_5B_PRODUCTION remains no until cluster sign-off");

  let buildResult = "SKIP";
  let buildOk = false;
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
    buildOk = true;
    buildResult = "PASS";
  } catch (e) {
    buildResult = "FAIL";
    blockers.push(`build failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const suspiciousClusterCount = (badClusters.rows as Array<Record<string, unknown>>).filter((r) => {
    const u = String(r.main_image_url);
    return isKnownBadImageUrl(u) || Number(r.distinct_asins) >= 2;
  }).length;

  const result = {
    phase_number: "5B",
    qa_products_count: qaRows.length,
    replacement_still_suspicious: replacementStillSuspicious ? "yes" : "no",
    replacement_4152CsQbheL_stats: cluster4152 ?? null,
    accepted_count: accepted,
    needs_manual_review_count: manual,
    rollback_recommended_count: rollback,
    rollback_recommended: clusterRec === "rollback_cluster" ? "yes" : "no",
    cluster_recommendation: clusterRec,
    next_clusters_recommended: nextClusters,
    suspicious_duplicate_clusters_remaining: suspiciousClusterCount,
    build_result: buildResult,
    SAFE_TO_APPLY_FIRST_CLUSTER_PRODUCTION:
      clusterRec === "accept_cluster" && !replacementStillSuspicious && buildOk ? "yes" : "no",
    SAFE_TO_APPLY_5B_PRODUCTION: "no",
    blockers,
  };

  fs.writeFileSync(path.join(outDir, "qa-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "qa-report.md",
    ),
    [
      "# Phase 5B — Product image visual QA",
      "",
      `Run: \`${rid}\` · Staging only · Cluster repaired: \`${OLD_CLUSTER}\``,
      "",
      "## QA summary",
      "",
      `- Repaired products on staging: **${qaRows.length}**`,
      `- Accept: **${accepted}** · Manual review: **${manual}** · Rollback: **${rollback}**`,
      `- Replacement 4152CsQbheL still suspicious: **${replacementStillSuspicious ? "yes" : "no"}**`,
      `- Cluster recommendation: **${clusterRec}**`,
      "",
      "## Next 5 clusters (staging, highest confidence)",
      "",
      ...nextClusters.map(
        (c, i) =>
          `${i + 1}. \`${c.image_key.slice(0, 48)}…\` — ${c.product_count} products, confidence ${c.confidence}, safe_to_stage=${c.safe_to_stage_repair}`,
      ),
      "",
      "## Deliverables",
      "",
      "- `qa_updated_products.csv`",
      "- `qa-result.json`",
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
