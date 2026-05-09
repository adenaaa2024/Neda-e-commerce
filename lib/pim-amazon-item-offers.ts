import "server-only";

import { fetchSpApiJsonWithRetry } from "./pim-amazon-spapi-fetch";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitterMs(base: number): number {
  return Math.floor(base * (0.85 + Math.random() * 0.3));
}

/**
 * Amazon Selling Partner API — Product Pricing API v0
 * GET /products/pricing/v0/items/{asin}/offers
 * @see https://developer-docs.amazon.com/sp-api/docs/product-pricing-api-v0-reference
 */

function trimHost(h: string): string {
  return h.replace(/\/+$/, "");
}

function readMoney(node: unknown): { amount: number; currency: string } | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const o = node as Record<string, unknown>;
  const rawAmt = o.Amount ?? o.amount;
  const rawCur = o.CurrencyCode ?? o.currencyCode ?? o.currency;
  const currency = typeof rawCur === "string" && rawCur.trim().length === 3 ? rawCur.trim().toUpperCase() : "USD";
  const n =
    typeof rawAmt === "number" ? rawAmt : typeof rawAmt === "string" ? Number.parseFloat(rawAmt) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return { amount: n, currency };
}

/** Which competitive row from Product Pricing API v0 was chosen (strictly from payload). */
export type PricingApiTier = "featured_offer" | "buy_box" | "lowest_landed";

const TIER_FEATURED = 0;
const TIER_BUY_BOX = 1;
const TIER_LOWEST_LANDED = 2;
const TIER_LIST_MSRP = 3;

type RankedPrice = { amount: number; currency: string; tier: number; label: PricingApiTier };

function pickBetter(a: RankedPrice, b: RankedPrice): RankedPrice {
  if (a.tier !== b.tier) return a.tier < b.tier ? a : b;
  return a.amount <= b.amount ? a : b;
}

function landedOrListingFromOfferRow(r: Record<string, unknown>): { amount: number; currency: string } | null {
  const landed = readMoney(r.LandedPrice ?? r.landedPrice);
  const listing = readMoney(r.ListingPrice ?? r.listingPrice);
  return landed ?? listing;
}

function collectRankedFromOffers(offers: unknown): RankedPrice[] {
  const out: RankedPrice[] = [];
  if (!Array.isArray(offers)) return out;
  for (const o of offers) {
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    const row = o as Record<string, unknown>;
    const buying = row.BuyingPrice ?? row.buyingPrice;
    if (!buying || typeof buying !== "object" || Array.isArray(buying)) continue;
    const b = buying as Record<string, unknown>;
    const hit = landedOrListingFromOfferRow(b);
    if (!hit) continue;
    const featured = Boolean(row.IsFeaturedMerchant ?? row.isFeaturedMerchant);
    const buyBox = Boolean(row.IsBuyBoxWinner ?? row.isBuyBoxWinner);
    const tier = featured ? TIER_FEATURED : buyBox ? TIER_BUY_BOX : TIER_LOWEST_LANDED;
    const label: PricingApiTier = featured ? "featured_offer" : buyBox ? "buy_box" : "lowest_landed";
    out.push({ ...hit, tier, label });
  }
  return out;
}

function collectRankedFromSummary(summary: unknown): RankedPrice[] {
  const out: RankedPrice[] = [];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return out;
  const s = summary as Record<string, unknown>;

  const pushRows = (lp: unknown, tier: number, label: PricingApiTier) => {
    if (!Array.isArray(lp)) return;
    for (const row of lp) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const hit = landedOrListingFromOfferRow(r);
      if (!hit) continue;
      out.push({ ...hit, tier, label });
    }
  };

  pushRows(s.BuyBoxPrices ?? s.buyBoxPrices, TIER_BUY_BOX, "buy_box");
  pushRows(s.LowestPrices ?? s.lowestPrices, TIER_LOWEST_LANDED, "lowest_landed");
  pushRows(s.ListPrice ?? s.listPrice, TIER_LIST_MSRP, "lowest_landed");

  return out;
}

function selectBestRankedFromPayload(json: unknown): RankedPrice | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;
  const payload = root.payload ?? root;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const all: RankedPrice[] = [
    ...collectRankedFromOffers(p.Offers ?? p.offers),
    ...collectRankedFromSummary(p.Summary ?? p.summary),
  ];
  if (!all.length) return null;
  return all.reduce((a, b) => pickBetter(a, b));
}

function firstErrorCode(json: unknown): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const errs = (json as Record<string, unknown>).errors;
  if (!Array.isArray(errs) || !errs.length) return null;
  const e0 = errs[0];
  if (!e0 || typeof e0 !== "object" || Array.isArray(e0)) return null;
  const c = (e0 as Record<string, unknown>).code;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

function payloadStatus(json: unknown): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;
  const payload = root.payload ?? root;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const st = (payload as Record<string, unknown>).Status ?? (payload as Record<string, unknown>).status;
  return typeof st === "string" && st.trim() ? st.trim() : null;
}

function parsePayload(json: unknown): { amount: number; currency: string; pricingApiTier: PricingApiTier } | null {
  const hit = selectBestRankedFromPayload(json);
  if (!hit) return null;
  return { amount: hit.amount, currency: hit.currency, pricingApiTier: hit.label };
}

export type AmazonPricingFailureKind =
  | "missing_role"
  | "invalid_marketplace"
  | "throttled"
  | "endpoint_not_configured"
  | "no_offer_data"
  | "asin_not_found"
  | "bad_request";

export type AmazonItemOffersResult =
  | {
      ok: true;
      amount: number;
      currency: string;
      rawSample: string;
      httpStatus: number;
      attempts: number;
      pricingApiTier: PricingApiTier;
    }
  | {
      ok: false;
      kind: AmazonPricingFailureKind;
      status: number;
      message: string;
      attempts: number;
      httpStatus?: number;
    };

/**
 * Fetches competitive pricing / offers for one ASIN (New condition).
 * Uses Product Pricing API v0 with retries on 429/503.
 */
export async function fetchAmazonItemOffersBestNewPrice(params: {
  spApiHost: string;
  accessToken: string;
  marketplaceId: string;
  asin: string;
}): Promise<AmazonItemOffersResult> {
  const midTrim = params.marketplaceId.trim();
  if (!midTrim) {
    return {
      ok: false,
      kind: "endpoint_not_configured",
      status: 0,
      message: "MarketplaceId is empty; cannot call Product Pricing item offers.",
      attempts: 0,
    };
  }

  const host = trimHost(params.spApiHost);
  const asin = encodeURIComponent(params.asin.trim());
  const mid = encodeURIComponent(midTrim);
  const url = `${host}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${mid}&ItemCondition=New`;

  const res = await fetchSpApiJsonWithRetry(
    url,
    {
      headers: {
        "x-amz-access-token": params.accessToken,
        Accept: "application/json",
      },
      method: "GET",
      cache: "no-store",
    },
    { maxAttempts: 6, baseDelayMs: 450, maxDelayMs: 40_000 },
  );

  const attempts = res.attempts;
  const text = res.text ?? "";
  const json = res.json;

  if (!res.ok) {
    const code = firstErrorCode(json) ?? "";
    const lower = text.toLowerCase();
    if (res.status === 403) {
      return {
        ok: false,
        kind: "missing_role",
        status: 403,
        message: text?.slice(0, 500) || "Forbidden (pricing role / token scope).",
        attempts,
        httpStatus: res.status,
      };
    }
    if (res.status === 429 || res.status === 503) {
      return {
        ok: false,
        kind: "throttled",
        status: res.status,
        message: text?.slice(0, 500) || `HTTP ${res.status} after retries`,
        attempts,
        httpStatus: res.status,
      };
    }
    if (res.status === 404 || code === "NOT_FOUND" || /not\s*found/i.test(text)) {
      return {
        ok: false,
        kind: "asin_not_found",
        status: res.status,
        message: text?.slice(0, 500) || "ASIN or offer data not found for this marketplace.",
        attempts,
        httpStatus: res.status,
      };
    }
    if (res.status === 400 || res.status === 422) {
      const invalidMp =
        code === "INVALID_MARKETPLACE" ||
        /invalid\s*marketplace|unknown\s*marketplace|marketplaceid/i.test(lower);
      return {
        ok: false,
        kind: invalidMp ? "invalid_marketplace" : "bad_request",
        status: res.status,
        message: text?.slice(0, 500) || `HTTP ${res.status}`,
        attempts,
        httpStatus: res.status,
      };
    }
    if (code === "QuotaExceeded" || lower.includes("quota") || lower.includes("throttl")) {
      return {
        ok: false,
        kind: "throttled",
        status: res.status,
        message: text?.slice(0, 500) || "Quota exceeded.",
        attempts,
        httpStatus: res.status,
      };
    }
    return {
      ok: false,
      kind: "bad_request",
      status: res.status,
      message: text?.slice(0, 500) || `HTTP ${res.status}`,
      attempts,
      httpStatus: res.status,
    };
  }

  const errCode = firstErrorCode(json);
  if (errCode === "NOT_FOUND" || errCode === "InvalidInput") {
    return {
      ok: false,
      kind: errCode === "NOT_FOUND" ? "asin_not_found" : "bad_request",
      status: res.status,
      message: text?.slice(0, 500) || errCode,
      attempts,
      httpStatus: res.status,
    };
  }

  const st = payloadStatus(json);
  if (st && st.toLowerCase() !== "success") {
    const noBuy =
      /no\s*buyable|nobuyable|no\s*offer|customer\s*not\s*found/i.test(st) ||
      st.toLowerCase().includes("nobuyableoffers");
    return {
      ok: false,
      kind: noBuy ? "no_offer_data" : "no_offer_data",
      status: res.status,
      message: `Pricing payload status: ${st}`,
      attempts,
      httpStatus: res.status,
    };
  }

  const parsed = parsePayload(json);
  if (!parsed) {
    return {
      ok: false,
      kind: "no_offer_data",
      status: res.status,
      message: st ? `No usable prices (status ${st}).` : "Pricing payload had no usable offer amounts.",
      attempts,
      httpStatus: res.status,
    };
  }
  const rawSample = text.length > 2500 ? `${text.slice(0, 2500)}…` : text;
  return {
    ok: true,
    amount: parsed.amount,
    currency: parsed.currency,
    rawSample,
    httpStatus: res.status,
    attempts,
    pricingApiTier: parsed.pricingApiTier,
  };
}

/**
 * Extra backoff rounds after SP-API built-in retries still return `throttled`.
 * Used for catalog enrichment so transient quota spikes can clear without failing the whole product.
 */
export async function fetchAmazonItemOffersBestNewPriceWithBackoff(
  params: {
    spApiHost: string;
    accessToken: string;
    marketplaceId: string;
    asin: string;
  },
  opts?: { extraThrottleAttempts?: number },
): Promise<AmazonItemOffersResult> {
  const maxExtra = Math.max(0, Math.min(6, opts?.extraThrottleAttempts ?? 4));
  let last = await fetchAmazonItemOffersBestNewPrice(params);
  if (last.ok || last.kind !== "throttled") return last;
  for (let i = 0; i < maxExtra; i++) {
    const base = Math.min(32_000, 900 * 2 ** i);
    await sleep(jitterMs(base));
    last = await fetchAmazonItemOffersBestNewPrice(params);
    if (last.ok || last.kind !== "throttled") return last;
  }
  return last;
}
