import "server-only";

import { isLikelyAsin } from "./pim-amazon-catalog-enrichment";
import {
  fetchAmazonItemOffersBestNewPriceWithBackoff,
  type AmazonItemOffersResult,
} from "./pim-amazon-item-offers";
import { supabaseServer } from "./supabase-server";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Alternate ASINs from `product_identifier_map` for the same `product_id` (excludes primary if passed for ordering elsewhere).
 */
export async function pimPrefetchAlternateAsinsByProduct(
  organizationId: string,
  storeId: string,
  productIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!productIds.length) return out;
  const { data, error } = await supabaseServer
    .from("product_identifier_map")
    .select("product_id, asin")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .in("product_id", productIds);
  if (error || !data?.length) return out;
  const acc = new Map<string, Set<string>>();
  for (const r of data) {
    const pid = String((r as { product_id?: string }).product_id ?? "").trim();
    const a = String((r as { asin?: string | null }).asin ?? "").trim().toUpperCase();
    if (!pid || !isLikelyAsin(a)) continue;
    if (!acc.has(pid)) acc.set(pid, new Set());
    acc.get(pid)!.add(a);
  }
  for (const [k, v] of acc) out.set(k, [...v].sort());
  return out;
}

export async function pimPrefetchIdentifierMapCatalogLinks(
  organizationId: string,
  storeId: string,
  productIds: string[],
): Promise<{ product_id: string; catalog_product_id: string }[]> {
  if (!productIds.length) return [];
  const { data, error } = await supabaseServer
    .from("product_identifier_map")
    .select("product_id, catalog_product_id")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .in("product_id", productIds);
  if (error || !data?.length) return [];
  const out: { product_id: string; catalog_product_id: string }[] = [];
  for (const r of data) {
    const pid = String((r as { product_id?: string }).product_id ?? "").trim();
    const cid = String((r as { catalog_product_id?: string | null }).catalog_product_id ?? "").trim();
    if (!pid || !cid) continue;
    out.push({ product_id: pid, catalog_product_id: cid });
  }
  return out;
}

/**
 * Listing snapshots (`catalog_products`) linked by identifier map and/or seller SKU match.
 */
export async function pimPrefetchCatalogProductsForEnrichment(params: {
  organizationId: string;
  storeId: string;
  products: { id: string; sku?: string | null; asin?: string | null }[];
  mapCatalogLinks: { product_id: string; catalog_product_id: string }[];
}): Promise<Map<string, Record<string, unknown>[]>> {
  const byProduct = new Map<string, Record<string, unknown>[]>();
  const append = (pid: string, row: Record<string, unknown>) => {
    const id = String(row.id ?? "");
    if (!id) return;
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    const list = byProduct.get(pid)!;
    if (list.some((x) => String(x.id) === id)) return;
    list.push(row);
  };

  const cpIds = new Set<string>();
  for (const m of params.mapCatalogLinks) {
    if (m.product_id && m.catalog_product_id) cpIds.add(m.catalog_product_id);
  }
  if (cpIds.size) {
    const { data: cpRows } = await supabaseServer
      .from("catalog_products")
      .select("*")
      .eq("organization_id", params.organizationId)
      .eq("store_id", params.storeId)
      .in("id", [...cpIds]);
    const cpById = new Map(
      (cpRows ?? []).map((r) => [String((r as { id: unknown }).id), r as Record<string, unknown>]),
    );
    for (const m of params.mapCatalogLinks) {
      const row = cpById.get(m.catalog_product_id);
      if (row) append(m.product_id, row);
    }
  }

  const skus = [...new Set(params.products.map((p) => String(p.sku ?? "").trim()).filter(Boolean))];
  if (skus.length) {
    const chunk = skus.slice(0, 120);
    const { data: bySku } = await supabaseServer
      .from("catalog_products")
      .select("*")
      .eq("organization_id", params.organizationId)
      .eq("store_id", params.storeId)
      .in("seller_sku", chunk)
      .limit(800);
    for (const p of params.products) {
      const sku = String(p.sku ?? "").trim();
      const asin = String(p.asin ?? "").trim().toUpperCase();
      if (!sku) continue;
      for (const raw of bySku ?? []) {
        const row = raw as Record<string, unknown>;
        if (String(row.seller_sku ?? "").trim() !== sku) continue;
        const cpAsin = String(row.asin ?? "").trim().toUpperCase();
        if (asin && cpAsin && cpAsin !== asin) continue;
        append(p.id, row);
      }
    }
  }

  return byProduct;
}

export type PricingAsinTrial = { asin: string; kind: string; http: number | null; marketplace_id?: string };

/**
 * Product Pricing item offers: for each ASIN (primary first, then alternates from identifier map),
 * try each configured marketplace in order on `asin_not_found` / `invalid_marketplace` / `throttled`.
 */
export async function tryAmazonItemOffersAcrossAsins(params: {
  spApiHost: string;
  accessToken: string;
  /** Retail marketplace ids for this store/credentials, primary first (NOT_FOUND fallback order). */
  marketplaceIdsOrdered: string[];
  asins: string[];
  extraThrottleAttempts?: number;
  delayBetweenAsinsMs?: number;
  delayBetweenMarketplacesMs?: number;
}): Promise<{
  result: AmazonItemOffersResult;
  usedAsin: string | null;
  usedMarketplaceId: string | null;
  trials: PricingAsinTrial[];
  /** Sum of SP-API attempt counts across all tries (for enrichment metrics). */
  attemptsSum: number;
}> {
  const trials: PricingAsinTrial[] = [];
  let attemptsSum = 0;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const a of params.asins) {
    const u = a.trim().toUpperCase();
    if (!isLikelyAsin(u) || seen.has(u)) continue;
    seen.add(u);
    list.push(u);
  }

  const mps = [...new Set(params.marketplaceIdsOrdered.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];

  let last: AmazonItemOffersResult = {
    ok: false,
    kind: "endpoint_not_configured",
    status: 0,
    message: mps.length ? "No ASINs to query." : "No marketplace ids configured for Product Pricing.",
    attempts: 0,
  };

  if (!list.length || !mps.length) {
    return { result: last, usedAsin: null, usedMarketplaceId: null, trials, attemptsSum: 0 };
  }

  const betweenAsin = params.delayBetweenAsinsMs ?? 280;
  const betweenMp = params.delayBetweenMarketplacesMs ?? 220;

  for (let i = 0; i < list.length; i++) {
    const asin = list[i]!;
    for (let mi = 0; mi < mps.length; mi++) {
      const mp = mps[mi]!;
      const off = await fetchAmazonItemOffersBestNewPriceWithBackoff(
        {
          spApiHost: params.spApiHost,
          accessToken: params.accessToken,
          marketplaceId: mp,
          asin,
        },
        { extraThrottleAttempts: params.extraThrottleAttempts ?? 4 },
      );
      last = off;
      attemptsSum += Math.max(0, off.attempts);
      trials.push({
        asin,
        kind: off.ok ? "ok" : off.kind,
        http: off.ok ? off.httpStatus : (off.httpStatus ?? off.status ?? null),
        marketplace_id: mp,
      });
      if (off.ok) {
        return { result: off, usedAsin: asin, usedMarketplaceId: mp, trials, attemptsSum };
      }
      if (off.kind === "missing_role") {
        return { result: off, usedAsin: null, usedMarketplaceId: null, trials, attemptsSum };
      }
      const tryNextMp = off.kind === "asin_not_found" || off.kind === "invalid_marketplace" || off.kind === "throttled";
      if (tryNextMp && mi + 1 < mps.length) {
        const extra = off.kind === "throttled" ? 900 : 0;
        await sleep(Math.max(betweenMp, extra));
        continue;
      }
      break;
    }
    if (i + 1 < list.length) {
      await sleep(betweenAsin);
    }
  }
  return { result: last, usedAsin: null, usedMarketplaceId: null, trials, attemptsSum };
}
