/**
 * Shared identifier normalization for product linkage (scanner + operational imports).
 * Client-safe for pure helpers; no DB access.
 */

/** Excel / placeholder tokens rejected across PIM + audit pipelines. */
export const IDENTIFIER_IGNORE_VALUES: ReadonlySet<string> = new Set([
  "",
  "x",
  "0",
  "fbm",
  "this one is good",
  "unknown",
  "null",
  "#name?",
  "#ref!",
  "#value!",
  "#div/0!",
  "#n/a",
  "#null!",
  "#num!",
]);

export const ASIN_RE = /^B[0-9A-Z]{9}$/;
export const FNSKU_RE = /^X[0-9A-Z]{9}$/;
export const BARCODE_RE = /^[0-9]{8,14}$/;

function trimAndIgnore(raw: unknown): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t || IDENTIFIER_IGNORE_VALUES.has(t.toLowerCase())) return null;
  return t;
}

/** Normalize Amazon ASIN (uppercase B0…). */
export function normalizeLinkageAsin(raw: unknown): string | null {
  const t = trimAndIgnore(raw);
  if (!t) return null;
  const u = t.toUpperCase();
  return ASIN_RE.test(u) ? u : null;
}

/** Normalize FNSKU (uppercase X0…). */
export function normalizeLinkageFnsku(raw: unknown): string | null {
  const t = trimAndIgnore(raw);
  if (!t) return null;
  const u = t.toUpperCase();
  return FNSKU_RE.test(u) ? u : null;
}

/** Seller SKU / MSKU — trimmed; case preserved. */
export function normalizeLinkageSku(raw: unknown): string | null {
  return trimAndIgnore(raw);
}

/**
 * Normalize UPC / EAN / GTIN to digits-only barcode.
 * Returns null when fewer than 8 digits after stripping.
 */
export function normalizeLinkageBarcodeDigits(raw: unknown): string | null {
  const t = trimAndIgnore(raw);
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 14) return null;
  if (!BARCODE_RE.test(digits)) return null;
  return digits;
}

/**
 * Expand barcode to lookup variants (UPC-A ↔ EAN-13 leading zero).
 * Example: 012345678905 and 12345678905 both resolve when either is stored.
 */
export function expandBarcodeLookupValues(raw: unknown): string[] {
  const canonical = normalizeLinkageBarcodeDigits(raw);
  if (!canonical) return [];
  const out = new Set<string>([canonical]);
  if (canonical.length === 13 && canonical.startsWith("0")) {
    out.add(canonical.slice(1));
  }
  if (canonical.length === 12) {
    out.add(`0${canonical}`);
  }
  return [...out];
}

export type NormalizedOperationalIdentifiers = {
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  upc: string | null;
  /** All barcode variants to query (UPC/EAN/GTIN). */
  barcodeVariants: string[];
};

/** Normalize a bundle of operational identifiers for deterministic matching. */
export function normalizeOperationalIdentifiers(input: {
  asin?: unknown;
  fnsku?: unknown;
  sku?: unknown;
  msku?: unknown;
  upc?: unknown;
  upc_code?: unknown;
  gtin?: unknown;
  ean?: unknown;
  product_identifier?: unknown;
  barcode?: unknown;
}): NormalizedOperationalIdentifiers {
  const sku = normalizeLinkageSku(input.sku ?? input.msku);
  const barcodeRaw =
    input.upc ??
    input.upc_code ??
    input.gtin ??
    input.ean ??
    input.product_identifier ??
    input.barcode;
  const variants = expandBarcodeLookupValues(barcodeRaw);
  return {
    asin: normalizeLinkageAsin(input.asin),
    fnsku: normalizeLinkageFnsku(input.fnsku),
    sku,
    upc: variants[0] ?? null,
    barcodeVariants: variants,
  };
}
