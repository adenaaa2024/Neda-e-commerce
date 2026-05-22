/**
 * Read listing price from saved `catalog_products` rows (imported listing exports).
 * Never invents values — only returns positives from stored columns / raw_payload.
 */

function readNumeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function readCurrencyFromPayload(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as unknown as Record<string, unknown>;
  for (const k of ["currency", "Currency", "currency_code", "currencyCode", "price_currency", "Price Currency"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length === 3) return v.trim().toUpperCase();
  }
  return null;
}

function readMoneyNode(node: unknown): { amount: number; currency: string } | null {
  if (node == null) return null;
  if (typeof node === "number" && Number.isFinite(node) && node > 0) {
    return { amount: node, currency: "USD" };
  }
  if (typeof node === "string") {
    const n = Number.parseFloat(node.trim());
    if (Number.isFinite(n) && n > 0) return { amount: n, currency: "USD" };
    return null;
  }
  if (typeof node === "object" && !Array.isArray(node)) {
    const o = node as unknown as Record<string, unknown>;
    const rawAmt = o.Amount ?? o.amount ?? o.Value ?? o.value;
    const rawCur = o.CurrencyCode ?? o.currencyCode ?? o.currency;
    const currency =
      typeof rawCur === "string" && rawCur.trim().length === 3 ? rawCur.trim().toUpperCase() : "USD";
    const n =
      typeof rawAmt === "number" ? rawAmt : typeof rawAmt === "string" ? Number.parseFloat(rawAmt) : Number.NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return { amount: n, currency: currency.length === 3 ? currency : "USD" };
  }
  return null;
}

/**
 * Listing-export `raw_payload` keys that look like offer / landed amounts (not guessed).
 */
const OFFER_LIKE_PAYLOAD_KEYS = [
  "your price",
  "your_price",
  "landed price",
  "landed_price",
  "listing price",
  "listing_price",
  "price plus shipping",
  "price_plus_shipping",
  "b2b price",
  "b2b_price",
  "lowest_price",
  "lowest price",
];

function extractOfferLikeFromRawPayload(raw: unknown): { amount: number; currency: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as unknown as Record<string, unknown>;
  const keys = new Map<string, unknown>();
  for (const [k, v] of Object.entries(o)) {
    keys.set(k.trim().toLowerCase().replace(/\s+/g, "_"), v);
    keys.set(k.trim().toLowerCase(), v);
  }
  let best: { amount: number; currency: string } | null = null;
  for (const want of OFFER_LIKE_PAYLOAD_KEYS) {
    const v = keys.get(want.toLowerCase()) ?? keys.get(want.toLowerCase().replace(/_/g, " "));
    const hit = readMoneyNode(v);
    if (!hit) continue;
    if (!best || hit.amount < best.amount) best = hit;
  }
  return best;
}

/**
 * Best positive `price` on a catalog_products row; currency from raw_payload or USD default for listing exports.
 */
export function extractListingPriceFromCatalogProductRow(row: Record<string, unknown>): {
  amount: number;
  currency: string;
  catalog_product_id: string;
} | null {
  const id = String(row.id ?? "").trim();
  const amt = readNumeric(row.price);
  if (!id || amt == null) return null;
  const cur = readCurrencyFromPayload(row.raw_payload) ?? "USD";
  return { amount: amt, currency: cur.length === 3 ? cur : "USD", catalog_product_id: id };
}

/** Pick newest by last_seen_at then updated_at among valid price rows. */
export function pickBestCatalogProductListingPrice(rows: Record<string, unknown>[]): {
  amount: number;
  currency: string;
  catalog_product_id: string;
} | null {
  let best: { amount: number; currency: string; catalog_product_id: string; t: number } | null = null;
  for (const r of rows) {
    const hit = extractListingPriceFromCatalogProductRow(r);
    if (!hit) continue;
    const ls = r.last_seen_at != null ? new Date(String(r.last_seen_at)).getTime() : 0;
    const up = r.updated_at != null ? new Date(String(r.updated_at)).getTime() : 0;
    const t = Math.max(ls, up);
    if (!best || t >= best.t) best = { ...hit, t };
  }
  return best ? { amount: best.amount, currency: best.currency, catalog_product_id: best.catalog_product_id } : null;
}

/** Offer-style fields from `catalog_products.raw_payload` only (no scalar `price` column). */
export function pickBestCatalogProductFallbackOfferPrice(rows: Record<string, unknown>[]): {
  amount: number;
  currency: string;
  catalog_product_id: string;
} | null {
  let best: { amount: number; currency: string; catalog_product_id: string; t: number } | null = null;
  for (const r of rows) {
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    const hit = extractOfferLikeFromRawPayload(r.raw_payload);
    if (!hit) continue;
    const ls = r.last_seen_at != null ? new Date(String(r.last_seen_at)).getTime() : 0;
    const up = r.updated_at != null ? new Date(String(r.updated_at)).getTime() : 0;
    const t = Math.max(ls, up);
    if (!best || t >= best.t) best = { ...hit, catalog_product_id: id, t };
  }
  return best ? { amount: best.amount, currency: best.currency, catalog_product_id: best.catalog_product_id } : null;
}
