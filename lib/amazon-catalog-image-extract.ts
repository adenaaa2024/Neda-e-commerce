/**
 * Extract image URLs from Amazon Catalog Items API JSON (summaries + images blocks).
 * Used by PIM enrichment and display helpers — no network calls.
 */

function pushUrl(out: Set<string>, u: unknown) {
  if (typeof u === "string" && u.trim()) out.add(u.trim());
}

function walkImagesBlock(block: unknown, out: Set<string>) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return;
  const o = block as Record<string, unknown>;
  const inner = o.images;
  if (!Array.isArray(inner)) return;
  for (const img of inner) {
    if (typeof img === "string") pushUrl(out, img);
    else if (img && typeof img === "object" && !Array.isArray(img)) {
      const im = img as Record<string, unknown>;
      for (const k of ["link", "url", "src", "medium_url", "large_url", "hi_res_url", "hiResUrl", "hiRes", "large"]) {
        pushUrl(out, im[k]);
      }
      const vars = im.variants;
      if (Array.isArray(vars)) {
        for (const v of vars) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const vo = v as Record<string, unknown>;
            for (const k of ["link", "url"]) pushUrl(out, vo[k]);
          }
        }
      }
    }
  }
}

/** Collect every plausible product image URL from a catalog `items` API payload. */
export function collectAmazonCatalogImageUrls(catalogItemRoot: unknown): string[] {
  const out = new Set<string>();
  if (!catalogItemRoot || typeof catalogItemRoot !== "object" || Array.isArray(catalogItemRoot)) {
    return [];
  }
  const root = catalogItemRoot as Record<string, unknown>;

  const imagesTop = root.images;
  if (Array.isArray(imagesTop)) {
    for (const block of imagesTop) {
      if (typeof block === "string") pushUrl(out, block);
      else walkImagesBlock(block, out);
    }
  }

  const attrs = root.attributes;
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    const a = attrs as Record<string, unknown>;
    const imgAttr = a.image_locator || a.image_locator_external_id || a.product_photo;
    if (imgAttr && typeof imgAttr === "object") {
      walkImagesBlock({ images: [imgAttr] }, out);
    }
  }

  for (const k of ["main_image_url", "mainImageUrl", "primary_image_url", "image_url", "imageUrl"]) {
    pushUrl(out, root[k]);
  }

  return [...out];
}

/** Heuristic “resolution / quality” score for picking among Amazon CDN image URLs. */
export function scoreAmazonImageUrl(u: string): number {
  let s = 0;
  const m1 = u.match(/_S[XYL](\d+)_/gi);
  if (m1) for (const x of m1) {
    const n = Number.parseInt(x.replace(/\D/g, ""), 10);
    if (Number.isFinite(n)) s = Math.max(s, n);
  }
  const mSl = u.match(/_SL(\d+)_/gi);
  if (mSl) for (const x of mSl) {
    const n = Number.parseInt(x.replace(/\D/g, ""), 10);
    if (Number.isFinite(n)) s = Math.max(s, n);
  }
  const m2 = u.match(/(\d{2,4})x(\d{2,4})/);
  if (m2) {
    const a = Number.parseInt(m2[1], 10) * Number.parseInt(m2[2], 10);
    if (Number.isFinite(a)) s = Math.max(s, Math.floor(Math.sqrt(a)) * 10);
  }
  if (/SL1500|UL1500|SX\d{3,4}/i.test(u)) s = Math.max(s, 1500);
  return s;
}

/**
 * Collapse obvious Amazon size/variant suffixes so _SL75_, _SL500_, _AC_UL600_SR600,400_… map to one logical image.
 * Non-Amazon URLs fall back to normalized string equality.
 */
export function canonicalAmazonImageKey(url: string): string {
  const raw = url.trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.search = "";
    let path = u.pathname;
    path = path.replace(/\._[A-Z]{1,6}\d+[^/._]*(?=\.|$)/gi, "");
    path = path.replace(/\._AC_[^/._]+(?=\.|$)/gi, "");
    path = path.replace(/__+[A-Z0-9_,-]+(?=\.|$)/gi, "");
    path = path.replace(/\._[A-Z]{1,6}_/gi, ".");
    path = path.replace(/\.+$/g, "");
    return `${u.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Deduplicate URLs that differ only by Amazon media size tokens; keep the highest-scoring URL per canonical key.
 */
export function dedupeAmazonProductImageUrls(urls: string[]): string[] {
  const best = new Map<string, { url: string; score: number }>();
  for (const u of urls) {
    const t = typeof u === "string" ? u.trim() : "";
    if (!t) continue;
    const key = canonicalAmazonImageKey(t);
    if (!key) continue;
    const sc = scoreAmazonImageUrl(t);
    const prev = best.get(key);
    if (!prev || sc > prev.score) best.set(key, { url: t, score: sc });
  }
  return [...best.values()].map((x) => x.url);
}

/**
 * Pick the best URL for `products.main_image_url` — prefers larger Amazon CDN variants when dimensions appear in the path.
 */
export function pickBestAmazonImageUrl(urls: string[]): string | null {
  const deduped = dedupeAmazonProductImageUrls(urls);
  if (!deduped.length) return null;
  let best = deduped[0];
  let bestScore = scoreAmazonImageUrl(best);
  for (let i = 1; i < deduped.length; i++) {
    const u = deduped[i];
    const sc = scoreAmazonImageUrl(u);
    if (sc > bestScore) {
      best = u;
      bestScore = sc;
    }
  }
  return best || null;
}

export function extractBestMainImageFromCatalogItem(catalogItemRoot: unknown): {
  bestUrl: string | null;
  candidates: string[];
} {
  const candidates = dedupeAmazonProductImageUrls(collectAmazonCatalogImageUrls(catalogItemRoot));
  return { bestUrl: pickBestAmazonImageUrl(candidates), candidates };
}
