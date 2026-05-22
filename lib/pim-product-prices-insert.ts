import "server-only";

import type { PricingApiTier } from "./pim-amazon-item-offers";
import { supabaseServer } from "./supabase-server";

/** How long to treat same amount+currency+source as duplicate (append-only history beyond window). */
export const AMAZON_ENRICHMENT_PRICE_DEDUPE_HOURS = 6;

export type ProductPricesInsertShape = {
  hasPrice: boolean;
  hasAmount: boolean;
  hasAsin: boolean;
};

export type AmazonEnrichmentPriceFrom =
  | "catalog_items_api"
  | "pricing_item_offers"
  | "saved_amazon_raw_catalog"
  | "catalog_products_listing"
  | "catalog_products_fallback_offer";

/** Stored on product_prices.metadata for UI / audits (never invent values). */
export type AmazonPriceSourceKind = "pricing_api" | "catalog_listing" | "fallback_offer";

export function priceSourceKindForEnrichmentFrom(from: AmazonEnrichmentPriceFrom): AmazonPriceSourceKind {
  if (from === "pricing_item_offers") return "pricing_api";
  if (from === "catalog_products_fallback_offer") return "fallback_offer";
  return "catalog_listing";
}

export type InsertAmazonProductPriceResult =
  | { ok: true }
  | {
      ok: false;
      reason: "duplicate_recent" | "db_error" | "validation";
      message?: string;
      diagnostic?: string;
      insertKeys?: string[];
    };

/**
 * Detect legacy vs PIM `product_prices` money columns via PostgREST (service role).
 * Some DBs keep NOT NULL `price`; PIM uses `amount`. Both may exist after migrations.
 */
export async function detectProductPricesInsertShape(): Promise<ProductPricesInsertShape> {
  const [priceProbe, amountProbe, asinProbe] = await Promise.all([
    supabaseServer.from("product_prices").select("price").limit(1),
    supabaseServer.from("product_prices").select("amount").limit(1),
    supabaseServer.from("product_prices").select("asin").limit(1),
  ]);
  return {
    hasPrice: !priceProbe.error,
    hasAmount: !amountProbe.error,
    hasAsin: !asinProbe.error,
  };
}

function extractPgConstraintName(message: string): string | null {
  const nullCol = message.match(/null value in column \"([^\"]+)\"/i);
  if (nullCol?.[1]) return `column:${nullCol[1]!.trim()}`;
  const m =
    message.match(/constraint\s+\"([^\"]+)\"/i) ||
    message.match(/constraint\s+«([^»]+)»/i) ||
    message.match(/violates\s+not-null\s+constraint\s+on\s+column\s+\"([^\"]+)\"/i);
  return m?.[1]?.trim() ? m[1]!.trim() : null;
}

function formatProductPriceInsertDiagnostic(
  err: { message: string; code?: string; details?: string | null; hint?: string | null },
  ctx: {
    productId: string;
    asin: string;
    amount: number;
    currency: string;
    sku: string | null;
    insertKeys: string[];
  },
): string {
  const constraint = extractPgConstraintName(err.message) ?? extractPgConstraintName(String(err.details ?? ""));
  const parts = [
    err.message,
    err.code ? `code=${err.code}` : null,
    err.details ? `details=${err.details}` : null,
    err.hint ? `hint=${err.hint}` : null,
    constraint ? `constraint_or_column=${constraint}` : null,
    `candidate_amount=${ctx.amount}`,
    `candidate_currency=${ctx.currency}`,
    `product_id=${ctx.productId}`,
    `asin=${ctx.asin}`,
    ctx.sku ? `sku=${ctx.sku}` : "sku=null_or_omitted",
    `insert_payload_keys=${ctx.insertKeys.join(",")}`,
  ];
  return parts.filter(Boolean).join(" | ");
}

export function buildAmazonEnrichmentProductPricesRow(
  shape: ProductPricesInsertShape,
  params: {
    organizationId: string;
    storeId: string;
    productId: string;
    amount: number;
    currency: string;
    observedAtIso: string;
    source: string;
    metadata: Record<string, unknown>;
    productSku: string | null;
    asin: string;
  },
): Record<string, unknown> {
  const cur =
    params.currency && String(params.currency).trim().length >= 1
      ? String(params.currency).trim().toUpperCase().slice(0, 8)
      : "USD";
  const row: Record<string, unknown> = {
    organization_id: params.organizationId,
    store_id: params.storeId,
    product_id: params.productId,
    currency: cur.length === 3 ? cur : "USD",
    observed_at: params.observedAtIso,
    source: params.source,
    metadata: params.metadata,
  };
  if (shape.hasPrice) {
    row.price = params.amount;
  }
  if (shape.hasAmount) {
    row.amount = params.amount;
  }
  if (!shape.hasPrice && !shape.hasAmount) {
    row.amount = params.amount;
  }
  if (params.productSku) {
    row.sku = params.productSku;
  }
  if (shape.hasAsin && params.asin.trim()) {
    row.asin = params.asin.trim().toUpperCase();
  }
  return row;
}

export async function insertAmazonEnrichmentProductPrice(
  shape: ProductPricesInsertShape,
  params: {
    organizationId: string;
    storeId: string;
    productId: string;
    asin: string;
    amount: number;
    currency: string;
    from: AmazonEnrichmentPriceFrom;
    productSku?: string | null;
    rawSample?: string | null;
    /** Merged into row metadata (audit only). */
    metadataExtra?: Record<string, unknown>;
    /** Overrides inferred `price_source` on metadata when set. */
    priceSourceKind?: AmazonPriceSourceKind;
    /** When `from` is pricing_item_offers, tier chosen from API payload. */
    pricingApiTier?: PricingApiTier | null;
    /** When true, skip the recent same-amount duplicate check (allows a new history row sooner). */
    skipRecentDuplicateCheck?: boolean;
  },
): Promise<InsertAmazonProductPriceResult> {
  const org = String(params.organizationId ?? "").trim();
  const sto = String(params.storeId ?? "").trim();
  const pid = String(params.productId ?? "").trim();
  if (!org || !sto || !pid) {
    return {
      ok: false,
      reason: "validation",
      message: "organization_id, store_id, and product_id are required.",
      diagnostic: `org=${org || "(empty)"} store=${sto || "(empty)"} product_id=${pid || "(empty)"}`,
      insertKeys: [],
    };
  }

  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    return {
      ok: false,
      reason: "validation",
      message: "Price candidate amount must be a finite number > 0.",
      diagnostic: `candidate_amount=${params.amount} candidate_currency=${params.currency}`,
      insertKeys: [],
    };
  }

  const cur =
    params.currency && String(params.currency).trim()
      ? String(params.currency).trim().toUpperCase()
      : "USD";
  if (!cur) {
    return {
      ok: false,
      reason: "validation",
      message: "Currency missing after normalization.",
      diagnostic: `candidate_amount=${params.amount}`,
      insertKeys: [],
    };
  }

  const { data: prod, error: prodErr } = await supabaseServer
    .from("products")
    .select("id")
    .eq("id", pid)
    .eq("organization_id", org)
    .eq("store_id", sto)
    .is("deleted_at", null)
    .maybeSingle();
  if (prodErr || !prod) {
    return {
      ok: false,
      reason: "validation",
      message: prodErr?.message ?? "Product not found for this org/store (or deleted).",
      diagnostic: `product_id=${pid} org=${org} store=${sto}`,
      insertKeys: [],
    };
  }

  const sinceIso = new Date(Date.now() - AMAZON_ENRICHMENT_PRICE_DEDUPE_HOURS * 3600_000).toISOString();
  const currencyNorm = cur.length === 3 ? cur : "USD";
  let dupeQ = supabaseServer
    .from("product_prices")
    .select("id")
    .eq("organization_id", org)
    .eq("store_id", sto)
    .eq("product_id", pid)
    .eq("source", "amazon_enrichment")
    .gte("observed_at", sinceIso);
  if (shape.hasAmount) {
    dupeQ = dupeQ.eq("amount", params.amount);
  }
  if (shape.hasPrice) {
    dupeQ = dupeQ.eq("price", params.amount);
  }
  if (!shape.hasAmount && !shape.hasPrice) {
    dupeQ = dupeQ.eq("amount", params.amount);
  }
  dupeQ = dupeQ.eq("currency", currencyNorm).limit(1);

  if (!params.skipRecentDuplicateCheck) {
    const { data: recentDupe } = await dupeQ;
    if (recentDupe?.length) {
      return { ok: false, reason: "duplicate_recent" };
    }
  }

  const skuTrim =
    params.productSku != null && String(params.productSku).trim() ? String(params.productSku).trim() : null;
  const observedAt = new Date().toISOString();
  const priceSource =
    params.priceSourceKind ?? priceSourceKindForEnrichmentFrom(params.from);
  const metadata: Record<string, unknown> = {
    from: params.from,
    asin: params.asin,
    price_source: priceSource,
    ...(params.from === "pricing_item_offers" && params.pricingApiTier
      ? { pricing_api_tier: params.pricingApiTier }
      : {}),
    ...(params.rawSample ? { raw_sample: params.rawSample } : {}),
    ...(params.metadataExtra && typeof params.metadataExtra === "object" ? params.metadataExtra : {}),
  };

  const row = buildAmazonEnrichmentProductPricesRow(shape, {
    organizationId: org,
    storeId: sto,
    productId: pid,
    amount: params.amount,
    currency: currencyNorm,
    observedAtIso: observedAt,
    source: "amazon_enrichment",
    metadata,
    productSku: skuTrim,
    asin: params.asin,
  });

  const insertKeys = Object.keys(row).sort();
  const { error: insErr } = await supabaseServer.from("product_prices").insert(row);
  if (insErr) {
    const diagnostic = formatProductPriceInsertDiagnostic(insErr, {
      productId: pid,
      asin: params.asin,
      amount: params.amount,
      currency: currencyNorm,
      sku: skuTrim,
      insertKeys,
    });
    console.error("[pim enrich] product_prices insert failed", diagnostic);
    return { ok: false, reason: "db_error", message: insErr.message, diagnostic, insertKeys };
  }

  const { error: tsErr } = await supabaseServer
    .from("products")
    .update({ last_price_updated_at: observedAt })
    .eq("id", pid)
    .eq("organization_id", org)
    .eq("store_id", sto);
  if (tsErr) {
    console.warn("[pim enrich] products.last_price_updated_at update failed", tsErr.message);
  }

  return { ok: true };
}
