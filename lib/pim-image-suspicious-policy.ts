/**
 * Suspicious product image detection + overwrite policy (Phase 5B).
 * No DB writes — used by enrichment and targeted repair scripts.
 */

import {
  canonicalAmazonImageKey,
  collectAmazonCatalogImageUrls,
} from "./amazon-catalog-image-extract";

/** Worst audit clusters — shared placeholders across unrelated ASINs. */
export const KNOWN_BAD_IMAGE_SUBSTRINGS = ["31BH1QY2CvL", "4152CsQbheL", "41gCLv9NY9L"] as const;

/** Staging repair waves blocked from production until operator sign-off. */
export const BLOCKED_PRODUCTION_IMAGE_CLUSTER_NEEDLES = [
  "31BH1QY2CvL",
  "4152CsQbheL",
  "41gCLv9NY9L",
] as const;

export type SuspiciousImageReason =
  | "known_bad_url_cluster"
  | "main_image_not_in_amazon_raw_candidates";

export type PimImageProvenance = {
  image_source: string;
  image_source_asin: string | null;
  image_fetch_path: string;
  image_updated_at: string;
  overwrite_reason?: string;
};

export type SuspiciousImageRow = {
  main_image_url?: string | null;
  amazon_raw?: unknown;
};

export function isKnownBadImageUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  const u = url.trim();
  return KNOWN_BAD_IMAGE_SUBSTRINGS.some((s) => u.includes(s));
}

export function collectAmazonRawImageCandidates(amazonRaw: unknown): string[] {
  const urls = collectAmazonCatalogImageUrls(amazonRaw);
  if (amazonRaw && typeof amazonRaw === "object" && !Array.isArray(amazonRaw)) {
    const raw = amazonRaw as Record<string, unknown>;
    const pimListed = raw.pim_image_candidates;
    if (Array.isArray(pimListed)) {
      for (const x of pimListed) {
        if (typeof x === "string" && x.trim()) urls.push(x.trim());
      }
    }
  }
  return urls;
}

export function mainImageNotInAmazonRawCandidates(
  mainImageUrl: string | null | undefined,
  amazonRaw: unknown,
): boolean {
  if (!mainImageUrl?.trim()) return false;
  const key = canonicalAmazonImageKey(mainImageUrl.trim());
  if (!key) return false;
  const candidates = collectAmazonRawImageCandidates(amazonRaw);
  if (!candidates.length) return true;
  return !candidates.some((c) => canonicalAmazonImageKey(c) === key);
}

export function evaluateSuspiciousMainImage(row: SuspiciousImageRow): {
  suspicious: boolean;
  reasons: SuspiciousImageReason[];
} {
  const reasons: SuspiciousImageReason[] = [];
  if (isKnownBadImageUrl(row.main_image_url)) {
    reasons.push("known_bad_url_cluster");
  }
  if (mainImageNotInAmazonRawCandidates(row.main_image_url, row.amazon_raw)) {
    reasons.push("main_image_not_in_amazon_raw_candidates");
  }
  return { suspicious: reasons.length > 0, reasons };
}

/** Overwrite sticky main_image_url only when audit flags the row. */
export function shouldAllowMainImageOverwrite(row: SuspiciousImageRow): boolean {
  return evaluateSuspiciousMainImage(row).suspicious;
}

export function mergeImageProvenanceIntoAmazonRaw(
  amazonRaw: Record<string, unknown>,
  prov: PimImageProvenance,
): Record<string, unknown> {
  return {
    ...amazonRaw,
    pim_image_provenance: prov,
    image_source: prov.image_source,
    image_source_asin: prov.image_source_asin,
    image_fetch_path: prov.image_fetch_path,
    image_updated_at: prov.image_updated_at,
  };
}

export function buildImageProvenance(args: {
  source: string;
  sourceAsin: string | null;
  fetchPath: string;
  overwriteReason?: string;
}): PimImageProvenance {
  return {
    image_source: args.source,
    image_source_asin: args.sourceAsin,
    image_fetch_path: args.fetchPath,
    image_updated_at: new Date().toISOString(),
    ...(args.overwriteReason ? { overwrite_reason: args.overwriteReason } : {}),
  };
}
