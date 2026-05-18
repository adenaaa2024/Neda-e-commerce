import "server-only";

import { isLikelyAsin } from "./pim-amazon-catalog-enrichment";
import { fetchSpApiJsonWithRetry } from "./pim-amazon-spapi-fetch";

function trimHost(h: string): string {
  return h.replace(/\/+$/, "");
}

function readAsinFromCatalogItemNode(node: unknown): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const o = node as unknown as Record<string, unknown>;
  const direct = o.asin;
  if (typeof direct === "string" && isLikelyAsin(direct)) return direct.trim().toUpperCase();
  const summaries = o.summaries;
  if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
    const s0 = summaries[0] as unknown as Record<string, unknown>;
    const a = s0.asin ?? s0.ASIN;
    if (typeof a === "string" && isLikelyAsin(a)) return a.trim().toUpperCase();
  }
  return null;
}

/**
 * Catalog Items API v2022-04-01 — keyword search (not identifier-based).
 * @see https://developer-docs.amazon.com/sp-api/docs/catalog-items-api-v2022-04-01-reference
 */
export async function fetchAmazonCatalogSearchItemsJson(params: {
  catalogHost: string;
  accessToken: string;
  marketplaceIds: string[];
  keywords: string;
  pageSize?: number;
}): Promise<
  | { ok: true; numberOfResults: number; items: unknown[]; rawSample: string }
  | { ok: false; status: number; error: string }
> {
  const kw = params.keywords.trim();
  if (!kw) {
    return { ok: false, status: 0, error: "keywords empty" };
  }
  const base = trimHost(params.catalogHost);
  const ps = Math.min(20, Math.max(1, params.pageSize ?? 10));
  const qp = new URLSearchParams({
    marketplaceIds: params.marketplaceIds.join(","),
    keywords: kw.slice(0, 200),
    includedData: "summaries,images",
    pageSize: String(ps),
  });
  const url = `${base}/catalog/2022-04-01/items?${qp}`;
  const res = await fetchSpApiJsonWithRetry(url, {
    headers: {
      "x-amz-access-token": params.accessToken,
      Accept: "application/json",
    },
    method: "GET",
    cache: "no-store",
  });
  const text = res.text ?? "";
  if (!res.ok) {
    return { ok: false, status: res.status, error: text?.slice(0, 400) || `HTTP ${res.status}` };
  }
  let json: unknown = res.json;
  if (json == null && text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, status: res.status, error: "Invalid JSON from search" };
    }
  }
  const root = json && typeof json === "object" && !Array.isArray(json) ? (json as unknown as Record<string, unknown>) : {};
  const nr = root.numberOfResults;
  const numberOfResults = typeof nr === "number" && Number.isFinite(nr) ? nr : 0;
  const itemsRaw = root.items;
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const rawSample = text.length > 2800 ? `${text.slice(0, 2800)}…` : text;
  return { ok: true, numberOfResults, items, rawSample };
}

/**
 * Only use search hits when ambiguity is low (single hit, or all hits agree on ASIN, or reinforces product ASIN).
 */
export function pickConservativeSearchCatalogAsin(params: {
  numberOfResults: number;
  items: unknown[];
  productAsin: string;
}): string | null {
  const pa = params.productAsin.trim().toUpperCase();
  const asins: string[] = [];
  for (const it of params.items) {
    const a = readAsinFromCatalogItemNode(it);
    if (a) asins.push(a);
  }
  if (!asins.length) return null;
  if (pa && asins.some((x) => x === pa)) return pa;
  if (params.numberOfResults === 1 && asins.length === 1) return asins[0]!;
  const uniq = [...new Set(asins)];
  if (uniq.length === 1 && params.items.length <= 3) return uniq[0]!;
  return null;
}
