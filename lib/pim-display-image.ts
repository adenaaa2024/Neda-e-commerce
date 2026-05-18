/**
 * Resolve catalog image URL without calling SP-API.
 * Order: products.main_image_url → common keys inside amazon_raw → null (caller shows placeholder).
 */

import {
  canonicalAmazonImageKey,
  collectAmazonCatalogImageUrls,
  dedupeAmazonProductImageUrls,
  pickBestAmazonImageUrl,
  scoreAmazonImageUrl,
} from "./amazon-catalog-image-extract";

export function resolvePimDisplayImageUrl(
  mainImageUrl: unknown,
  amazonRaw: unknown,
): string | null {
  const fromMain =
    typeof mainImageUrl === "string" && mainImageUrl.trim() ? mainImageUrl.trim() : "";
  if (fromMain) return fromMain;

  if (!amazonRaw || typeof amazonRaw !== "object" || Array.isArray(amazonRaw)) return null;
  const raw = amazonRaw as unknown as Record<string, unknown>;

  const fromKeys = [
    raw.main_image_url,
    raw.mainImageUrl,
    raw.primary_image_url,
    raw.image_url,
    raw.imageUrl,
  ];
  for (const c of fromKeys) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }

  const listed = collectAmazonCatalogImageUrls(amazonRaw);
  const best = pickBestAmazonImageUrl(listed);
  if (best) return best;

  const pimListed = raw.pim_image_candidates;
  if (Array.isArray(pimListed)) {
    const urls = pimListed
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
    const b = pickBestAmazonImageUrl(urls);
    if (b) return b;
  }

  return null;
}

/** Extra image URLs from `amazon_raw` for galleries (excludes the primary display URL and size-duplicate URLs). */
export function collectPimAmazonRawGalleryUrls(amazonRaw: unknown, max = 16): string[] {
  const primary = resolvePimDisplayImageUrl(null, amazonRaw);
  const primaryKey = primary ? canonicalAmazonImageKey(primary) : "";

  const merged = new Set<string>();
  for (const u of collectAmazonCatalogImageUrls(amazonRaw)) {
    if (typeof u === "string" && u.trim()) merged.add(u.trim());
  }
  if (amazonRaw && typeof amazonRaw === "object" && !Array.isArray(amazonRaw)) {
    const extra = (amazonRaw as unknown as Record<string, unknown>).pim_image_candidates;
    if (Array.isArray(extra)) {
      for (const x of extra) {
        if (typeof x === "string" && x.trim()) merged.add(x.trim());
      }
    }
  }

  const deduped = dedupeAmazonProductImageUrls([...merged]);
  const filtered = deduped
    .filter((u) => {
      if (primary && u === primary) return false;
      if (primaryKey && canonicalAmazonImageKey(u) === primaryKey) return false;
      return true;
    })
    .map((u) => ({ u, s: scoreAmazonImageUrl(u) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.u);
  return filtered.slice(0, max);
}
