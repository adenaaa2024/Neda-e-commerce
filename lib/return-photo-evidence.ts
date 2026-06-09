import { capScannerPhotoUrls } from "@/lib/scanner/scanner-photo-section-limit";

/**
 * `return_items.photo_evidence` JSONB: SmartCamera category counts (numbers) plus optional URL slots.
 * URL keys are stored in the same object — not separate DB columns.
 */
export const RETURN_PHOTO_EVIDENCE_URL_KEYS = ["item_url", "expiry_url", "return_label_url"] as const;
export type ReturnPhotoEvidenceUrlKey = (typeof RETURN_PHOTO_EVIDENCE_URL_KEYS)[number];

export type ReturnPhotoEvidenceRow = Record<string, string | number | string[] | null | undefined> | null;

const GALLERY_URLS_KEY = "urls";
/** Operator scanner optional item photos (up to 3). First slot mirrors `item_url`. */
const ITEM_URLS_KEY = "item_urls";
/** Operator scanner expiry label photos (up to 3). First slot mirrors `expiry_url`. */
const EXPIRY_URLS_KEY = "expiry_urls";

const PHOTO_EVIDENCE_ARRAY_URL_KEYS = [GALLERY_URLS_KEY, ITEM_URLS_KEY, EXPIRY_URLS_KEY] as const;

export function getReturnPhotoEvidenceUrls(pe: ReturnPhotoEvidenceRow | undefined): {
  item_url: string;
  expiry_url: string;
  return_label_url: string;
} {
  const o = pe ?? {};
  const s = (k: string) => (typeof o[k] === "string" ? o[k].trim() : "");
  return {
    item_url: s("item_url"),
    expiry_url: s("expiry_url"),
    return_label_url: s("return_label_url"),
  };
}

/** Category slug → photo count (excludes URL keys and gallery `urls` array). */
export function photoEvidenceCategoryCounts(pe: ReturnPhotoEvidenceRow): Record<string, number> {
  const out: Record<string, number> = {};
  if (!pe) return out;
  for (const [k, v] of Object.entries(pe)) {
    if ((RETURN_PHOTO_EVIDENCE_URL_KEYS as readonly string[]).includes(k)) continue;
    if ((PHOTO_EVIDENCE_ARRAY_URL_KEYS as readonly string[]).includes(k)) continue;
    if (typeof v === "number" && v > 0) out[k] = v;
  }
  return out;
}

export function photoEvidenceNumericTotal(pe: ReturnPhotoEvidenceRow): number {
  return Object.values(photoEvidenceCategoryCounts(pe)).reduce((a, b) => a + b, 0);
}

export function hasReturnPhotoEvidenceCounts(pe: ReturnPhotoEvidenceRow): boolean {
  return Object.values(photoEvidenceCategoryCounts(pe)).some((n) => n > 0);
}

export function getReturnPhotoEvidenceGalleryUrls(pe: ReturnPhotoEvidenceRow | undefined): string[] {
  const o = pe ?? {};
  const raw = o[GALLERY_URLS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export function hasReturnPhotoEvidenceUrlSlots(pe: ReturnPhotoEvidenceRow): boolean {
  const u = getReturnPhotoEvidenceUrls(pe);
  if (u.item_url || u.expiry_url || u.return_label_url) return true;
  return getReturnPhotoEvidenceGalleryUrls(pe).length > 0;
}

/**
 * Merges SmartCamera counts with optional URL slots for insert/update payloads.
 */
export function mergeReturnPhotoEvidence(
  counts: Record<string, number> | null | undefined,
  urls: Partial<Record<ReturnPhotoEvidenceUrlKey, string>>,
  options?: { galleryUrls?: string[] },
): Record<string, string | number | string[]> | null {
  const out: Record<string, string | number | string[]> = {};
  if (counts) {
    for (const [k, v] of Object.entries(counts)) {
      if (typeof v === "number" && v > 0) out[k] = v;
    }
  }
  for (const k of RETURN_PHOTO_EVIDENCE_URL_KEYS) {
    const t = urls[k]?.trim();
    if (t) out[k] = t;
  }
  const g = options?.galleryUrls?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (g.length > 0) out[GALLERY_URLS_KEY] = g;
  return Object.keys(out).length ? out : null;
}

function isHttpPhotoUrl(raw: string | null | undefined): raw is string {
  const s = String(raw ?? "").trim();
  return Boolean(s && /^https?:\/\//i.test(s));
}

function getPhotoEvidenceUrlArray(pe: ReturnPhotoEvidenceRow | undefined, key: string): string[] {
  const o = pe ?? {};
  const raw = o[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && isHttpPhotoUrl(x.trim()));
}

function mergePhotoUrlBuckets(primary: string | null, arrayKeyUrls: string[]): string[] {
  const merged: string[] = [];
  if (primary) merged.push(primary);
  for (const u of arrayKeyUrls) {
    if (!merged.includes(u)) merged.push(u);
  }
  return capScannerPhotoUrls(merged);
}

/** Split operator item-unit photos into issue evidence, expiry, and optional item buckets. */
export function splitOperatorItemUnitPhotos(
  pe: ReturnPhotoEvidenceRow | undefined | null,
  options?: { hasExpiredTag?: boolean },
): {
  evidenceUrls: string[];
  expiryEvidenceUrls: string[];
  optionalItemPhotoUrls: string[];
  /** First optional item photo — backward-compatible single-slot read. */
  optionalItemPhotoUrl: string | null;
} {
  const urlSlots = getReturnPhotoEvidenceUrls(pe);
  const gallery = getReturnPhotoEvidenceGalleryUrls(pe);
  const itemUrl = isHttpPhotoUrl(urlSlots.item_url) ? urlSlots.item_url.trim() : null;
  const expiryUrl = isHttpPhotoUrl(urlSlots.expiry_url) ? urlSlots.expiry_url.trim() : null;
  const optionalItemPhotoUrls = mergePhotoUrlBuckets(itemUrl, getPhotoEvidenceUrlArray(pe, ITEM_URLS_KEY));
  const reserved = new Set<string>([
    ...optionalItemPhotoUrls,
    ...(expiryUrl ? [expiryUrl] : []),
    ...getPhotoEvidenceUrlArray(pe, EXPIRY_URLS_KEY),
  ]);

  let expiryEvidenceUrls = mergePhotoUrlBuckets(expiryUrl, getPhotoEvidenceUrlArray(pe, EXPIRY_URLS_KEY));
  let evidenceUrls = capScannerPhotoUrls(gallery.filter((u) => !reserved.has(u)));

  if (expiryEvidenceUrls.length === 0 && options?.hasExpiredTag) {
    const legacyGallery = gallery.filter((u) => !optionalItemPhotoUrls.includes(u));
    if (legacyGallery.length === 1) {
      expiryEvidenceUrls = [legacyGallery[0]!];
      evidenceUrls = [];
    } else if (legacyGallery.length > 1) {
      expiryEvidenceUrls = capScannerPhotoUrls([legacyGallery[legacyGallery.length - 1]!]);
      evidenceUrls = capScannerPhotoUrls(legacyGallery.slice(0, -1));
    }
  }

  return {
    evidenceUrls,
    expiryEvidenceUrls,
    optionalItemPhotoUrls,
    optionalItemPhotoUrl: optionalItemPhotoUrls[0] ?? null,
  };
}

/** Persist operator item-unit photos into `return_items.photo_evidence` JSONB buckets. */
export function buildOperatorItemUnitPhotoEvidence(input: {
  evidenceUrls?: readonly string[] | null;
  expiryEvidenceUrls?: readonly string[] | null;
  optionalItemPhotoUrls?: readonly string[] | null;
  /** Legacy single optional photo — merged into `optionalItemPhotoUrls`. */
  optionalItemPhotoUrl?: string | null;
}): Record<string, string | number | string[]> | null {
  const evidence = capScannerPhotoUrls(input.evidenceUrls ?? []);
  const expiryEvidence = capScannerPhotoUrls(input.expiryEvidenceUrls ?? []);
  const optionalMerged = capScannerPhotoUrls([
    ...(input.optionalItemPhotoUrls ?? []),
    ...(input.optionalItemPhotoUrl ? [input.optionalItemPhotoUrl] : []),
  ]);
  const optionalItemUrl = optionalMerged[0] ?? "";
  const expiryUrl = expiryEvidence[0] ?? "";
  const reserved = new Set<string>([...optionalMerged, ...expiryEvidence]);
  const galleryUrls = evidence.filter((u) => !reserved.has(u));

  const out: Record<string, string | number | string[]> = {};
  if (optionalItemUrl) out.item_url = optionalItemUrl;
  if (optionalMerged.length > 0) out[ITEM_URLS_KEY] = optionalMerged;
  if (expiryUrl) out.expiry_url = expiryUrl;
  if (expiryEvidence.length > 0) out[EXPIRY_URLS_KEY] = expiryEvidence;
  if (galleryUrls.length > 0) out[GALLERY_URLS_KEY] = galleryUrls;

  return Object.keys(out).length ? out : null;
}
