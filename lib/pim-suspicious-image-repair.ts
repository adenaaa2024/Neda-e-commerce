/**
 * Targeted suspicious-image repair — catalog fetch by product ASIN only (no identifier_map writes).
 */

import type pg from "pg";

import {
  collectAmazonCatalogImageUrls,
  dedupeAmazonProductImageUrls,
  extractBestMainImageFromCatalogItem,
  scoreAmazonImageUrl,
} from "./amazon-catalog-image-extract";
import {
  buildImageProvenance,
  evaluateSuspiciousMainImage,
  isKnownBadImageUrl,
  mergeImageProvenanceIntoAmazonRaw,
  shouldAllowMainImageOverwrite,
} from "./pim-image-suspicious-policy";

export type SuspiciousImageRepairRow = {
  id: string;
  asin: string | null;
  product_name: string | null;
  main_image_url: string | null;
  amazon_raw: unknown;
};

export type SuspiciousImageRepairOutcome = {
  product_id: string;
  product_asin: string | null;
  old_image_url: string | null;
  new_candidate_url: string | null;
  source_asin: string | null;
  decision: "updated" | "skipped";
  qa_status: "updated" | "manual_review" | "skipped";
  skip_reason: string | null;
  suspicious_reasons: string[];
};

/** Prefer highest-resolution variant; block known-bad placeholders. */
export function selectBestCatalogMainImage(candidates: string[]): {
  url: string | null;
  manualReview: boolean;
  reason: string;
} {
  const ranked = dedupeAmazonProductImageUrls(candidates)
    .filter((u) => !isKnownBadImageUrl(u))
    .map((u) => ({ u, s: scoreAmazonImageUrl(u) }))
    .sort((a, b) => b.s - a.s);

  if (!ranked.length) {
    return { url: null, manualReview: true, reason: "catalog_only_known_bad_or_no_image" };
  }

  const hiRes = ranked.filter((x) => x.s >= 500);
  const pick = (hiRes[0] ?? ranked[0])!.u;
  const upgraded = tryUpgradeAmazonImageResolution(pick);
  if (isKnownBadImageUrl(upgraded)) {
    return { url: null, manualReview: true, reason: "upgraded_url_still_known_bad" };
  }
  return { url: upgraded, manualReview: false, reason: hiRes.length ? "hi_res_candidate" : "best_non_bad_candidate" };
}

/** Same Amazon image id at higher CDN size when only thumbnail variant exists. */
export function tryUpgradeAmazonImageResolution(url: string): string {
  if (/_SL75_/i.test(url)) return url.replace(/_SL75_/gi, "_SL500_");
  if (/_SL150_/i.test(url)) return url.replace(/_SL150_/gi, "_SL500_");
  return url;
}

export async function repairSuspiciousProductImage(args: {
  row: SuspiciousImageRepairRow;
  organizationId: string;
  storeId: string;
  dryRun: boolean;
  client: pg.Client;
  fetchPath?: string;
  forceRepair?: boolean;
}): Promise<SuspiciousImageRepairOutcome> {
  const {
    row,
    organizationId,
    storeId,
    dryRun,
    client,
    fetchPath = "phase5b_suspicious_image_repair",
    forceRepair = false,
  } = args;
  const catalog = await import("./pim-amazon-catalog-enrichment");
  const oldUrl = row.main_image_url?.trim() || null;
  const productAsin = String(row.asin ?? "").trim().toUpperCase() || null;
  const suspicious = evaluateSuspiciousMainImage(row);

  const base: SuspiciousImageRepairOutcome = {
    product_id: row.id,
    product_asin: productAsin,
    old_image_url: oldUrl,
    new_candidate_url: null,
    source_asin: null,
    decision: "skipped",
    qa_status: "skipped",
    skip_reason: null,
    suspicious_reasons: suspicious.reasons,
  };

  if (!suspicious.suspicious && !forceRepair) {
    return { ...base, skip_reason: "not_flagged_suspicious" };
  }
  if (!forceRepair && !shouldAllowMainImageOverwrite(row)) {
    return { ...base, skip_reason: "overwrite_policy_denied" };
  }
  if (!productAsin || !(await catalog.isLikelyAsin(productAsin))) {
    return { ...base, skip_reason: "missing_product_asin" };
  }

  const ctx = await catalog.resolveAmazonCatalogContext(organizationId, storeId);
  if (!ctx.ok) {
    return { ...base, skip_reason: `catalog_context: ${ctx.error}` };
  }

  const tokenRes = await catalog.getAmazonCatalogAccessToken({ credentials: ctx.credentials });
  if (!tokenRes.ok) {
    return { ...base, skip_reason: `auth_failed: ${tokenRes.error}` };
  }

  const cat = await catalog.fetchAmazonCatalogItemJson({
    catalogHost: ctx.catalogHost,
    accessToken: tokenRes.accessToken,
    marketplaceIds: ctx.marketplaceIds,
    asin: productAsin,
  });

  if (!cat.ok || !cat.body) {
    const errDetail = !cat.ok ? `${cat.status}: ${cat.error}` : "empty body";
    return { ...base, skip_reason: `catalog_fetch_failed: ${errDetail}` };
  }

  const primary = extractBestMainImageFromCatalogItem(cat.body);
  const allCandidates = dedupeAmazonProductImageUrls([
    ...collectAmazonCatalogImageUrls(cat.body),
    ...primary.candidates,
    ...(primary.bestUrl ? [primary.bestUrl] : []),
  ]);
  const picked = selectBestCatalogMainImage(allCandidates);
  const bestMain = picked.url;
  const mergedCandidates = allCandidates
    .filter((u) => !isKnownBadImageUrl(u))
    .map((u) => tryUpgradeAmazonImageResolution(u))
    .filter((u) => !isKnownBadImageUrl(u))
    .sort((a, b) => scoreAmazonImageUrl(b) - scoreAmazonImageUrl(a));

  if (!bestMain) {
    return {
      ...base,
      qa_status: "manual_review",
      skip_reason: picked.reason,
      source_asin: productAsin,
    };
  }
  if (oldUrl && bestMain.trim() === oldUrl) {
    return {
      ...base,
      qa_status: isKnownBadImageUrl(oldUrl) ? "manual_review" : "skipped",
      new_candidate_url: bestMain,
      source_asin: productAsin,
      skip_reason: isKnownBadImageUrl(oldUrl)
        ? "catalog_only_known_bad_placeholder"
        : "candidate_same_as_current",
    };
  }
  if (isKnownBadImageUrl(bestMain)) {
    return {
      ...base,
      qa_status: "manual_review",
      new_candidate_url: bestMain,
      source_asin: productAsin,
      skip_reason: "candidate_is_known_bad_placeholder",
    };
  }

  const prevRaw =
    row.amazon_raw && typeof row.amazon_raw === "object" && !Array.isArray(row.amazon_raw)
      ? ({ ...(row.amazon_raw as Record<string, unknown>) } as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const bodyObj =
    cat.body && typeof cat.body === "object" && !Array.isArray(cat.body)
      ? ({ ...(cat.body as Record<string, unknown>) } as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  bodyObj.pim_image_candidates = mergedCandidates.slice(0, 16);
  const provenance = buildImageProvenance({
    source: "catalog_items_api",
    sourceAsin: productAsin,
    fetchPath,
    overwriteReason: suspicious.reasons.join("|"),
  });
  const mergedAmazonRaw = mergeImageProvenanceIntoAmazonRaw(
    { ...prevRaw, ...bodyObj },
    provenance,
  );

  if (!dryRun) {
    await client.query(
      `UPDATE public.products
       SET main_image_url = $1,
           amazon_raw = $2::jsonb,
           updated_at = now()
       WHERE id = $3::uuid
         AND organization_id = $4::uuid
         AND store_id = $5::uuid
         AND deleted_at IS NULL`,
      [bestMain, JSON.stringify(mergedAmazonRaw), row.id, organizationId, storeId],
    );
  }

  return {
    ...base,
    new_candidate_url: bestMain,
    source_asin: productAsin,
    decision: "updated",
    qa_status: "updated",
    skip_reason: dryRun ? "dry_run_would_update" : null,
  };
}
