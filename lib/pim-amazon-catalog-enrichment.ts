import "server-only";

import { extractBestMainImageFromCatalogItem } from "./amazon-catalog-image-extract";
import {
  filterValidAmazonRetailMarketplaceIds,
  pickPrimaryAmazonRetailMarketplaceId,
} from "./amazon-retail-marketplace-ids";
import { getAmazonAccessToken, type AmazonSpApiCredentials } from "./amazon/sp-api";
import { amazonSpCredentialsLookComplete } from "./amazon-marketplace-credentials";
import { fetchSpApiJsonWithRetry } from "./pim-amazon-spapi-fetch";
import { supabaseServer } from "./supabase-server";

const DEFAULT_CATALOG_HOST = "https://sellingpartnerapi-na.amazon.com";
const DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER";

function trimHost(h: string): string {
  return h.replace(/\/+$/, "");
}

function credsRecordToLwa(credentials: Record<string, unknown>): AmazonSpApiCredentials | null {
  const lwaClientId = String(
    credentials.lwa_client_id ?? credentials.lwaClientId ?? credentials.client_id ?? "",
  ).trim();
  const lwaClientSecret = String(
    credentials.lwa_client_secret ?? credentials.lwaClientSecret ?? credentials.client_secret ?? "",
  ).trim();
  const refreshToken = String(
    credentials.refresh_token ?? credentials.refreshToken ?? "",
  ).trim();
  if (!lwaClientId || !lwaClientSecret || !refreshToken) return null;
  return { lwaClientId, lwaClientSecret, refreshToken };
}

function marketplaceIdsFromCredentials(credentials: Record<string, unknown>): string[] {
  const single = String(credentials.marketplace_id ?? credentials.marketplaceId ?? "").trim();
  if (single) return [single];
  const multi = String(credentials.marketplace_ids ?? credentials.marketplaceIds ?? "").trim();
  if (multi) {
    return multi
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [DEFAULT_MARKETPLACE_ID];
}

function finalizeMarketplacesForStore(
  storeMarketplaceId: string | null | undefined,
  rawFromCredentials: string[],
):
  | { ok: true; marketplaceIds: string[]; pricingMarketplaceId: string | null }
  | { ok: false; error: string } {
  const valid = filterValidAmazonRetailMarketplaceIds(rawFromCredentials);
  if (rawFromCredentials.length > 0 && valid.length === 0) {
    return {
      ok: false,
      error:
        "Configured Amazon marketplace_id values are not recognized retail marketplaces. " +
        "Update the linked marketplace or `amazon_sp_api` organization key with a valid marketplace id.",
    };
  }
  const marketplaceIds = valid.length ? valid : filterValidAmazonRetailMarketplaceIds([DEFAULT_MARKETPLACE_ID]);
  const pricingMarketplaceId = pickPrimaryAmazonRetailMarketplaceId({
    storeMarketplaceId: storeMarketplaceId ?? null,
    credentialMarketplaceIds: marketplaceIds,
  });
  return { ok: true, marketplaceIds, pricingMarketplaceId };
}

function catalogHostFromCredentials(credentials: Record<string, unknown>): string {
  const ep = String(credentials.endpoint ?? credentials.sp_api_endpoint ?? "").trim();
  return trimHost(ep || DEFAULT_CATALOG_HOST);
}

/**
 * Resolves LWA + marketplace + SP-API host for catalog reads for a store.
 * Priority: store-linked `marketplaces` row → `organization_api_keys` JSON (`amazon_sp_api`) → any org Amazon marketplace row.
 */
export async function resolveAmazonCatalogContext(
  organizationId: string,
  storeId: string,
): Promise<
  | {
      ok: true;
      credentials: AmazonSpApiCredentials;
      marketplaceIds: string[];
      catalogHost: string;
      /** Single marketplace for Product Pricing `GET …/items/{asin}/offers` */
      pricingMarketplaceId: string | null;
      storeMarketplaceId: string | null;
    }
  | { ok: false; error: string }
> {
  const { data: store, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id, organization_id, marketplace_id, platform, marketplaces(id, provider, credentials)")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (storeErr || !store) {
    return { ok: false, error: "Store not found for this organization." };
  }

  const storeMpRaw = String((store as { marketplace_id?: string | null }).marketplace_id ?? "").trim() || null;

  const mpRel = (store as { marketplaces?: { provider?: string; credentials?: unknown } | null }).marketplaces;
  if (mpRel?.credentials && typeof mpRel.credentials === "object" && !Array.isArray(mpRel.credentials)) {
    const credObj = mpRel.credentials as Record<string, unknown>;
    if (String(mpRel.provider ?? "").trim() === "amazon_sp_api" && amazonSpCredentialsLookComplete(credObj)) {
      const lwa = credsRecordToLwa(credObj);
      if (lwa) {
        const rawIds = marketplaceIdsFromCredentials(credObj);
        const fin = finalizeMarketplacesForStore(storeMpRaw, rawIds);
        if (!fin.ok) return fin;
        return {
          ok: true,
          credentials: lwa,
          marketplaceIds: fin.marketplaceIds,
          catalogHost: catalogHostFromCredentials(credObj),
          pricingMarketplaceId: fin.pricingMarketplaceId,
          storeMarketplaceId: storeMpRaw,
        };
      }
    }
  }

  const { data: keyRow } = await supabaseServer
    .from("organization_api_keys")
    .select("api_key")
    .eq("organization_id", organizationId)
    .eq("name", "amazon_sp_api")
    .maybeSingle();

  const rawKey = (keyRow as { api_key?: string } | null)?.api_key;
  if (rawKey && rawKey.trim()) {
    try {
      const parsed = JSON.parse(rawKey) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const lwa = credsRecordToLwa(parsed as Record<string, unknown>);
        if (lwa) {
          const rawIds = marketplaceIdsFromCredentials(parsed as Record<string, unknown>);
          const fin = finalizeMarketplacesForStore(storeMpRaw, rawIds);
          if (!fin.ok) return fin;
          return {
            ok: true,
            credentials: lwa,
            marketplaceIds: fin.marketplaceIds,
            catalogHost: catalogHostFromCredentials(parsed as Record<string, unknown>),
            pricingMarketplaceId: fin.pricingMarketplaceId,
            storeMarketplaceId: storeMpRaw,
          };
        }
      }
    } catch {
      /* fall through */
    }
  }

  const { data: mpRows } = await supabaseServer
    .from("marketplaces")
    .select("credentials")
    .eq("organization_id", organizationId)
    .eq("provider", "amazon_sp_api")
    .limit(3);

  for (const row of mpRows ?? []) {
    const credObj = (row as { credentials?: unknown }).credentials;
    if (!credObj || typeof credObj !== "object" || Array.isArray(credObj)) continue;
    const c = credObj as Record<string, unknown>;
    if (!amazonSpCredentialsLookComplete(c)) continue;
    const lwa = credsRecordToLwa(c);
    if (lwa) {
      const rawIds = marketplaceIdsFromCredentials(c);
      const fin = finalizeMarketplacesForStore(storeMpRaw, rawIds);
      if (!fin.ok) return fin;
      return {
        ok: true,
        credentials: lwa,
        marketplaceIds: fin.marketplaceIds,
        catalogHost: catalogHostFromCredentials(c),
        pricingMarketplaceId: fin.pricingMarketplaceId,
        storeMarketplaceId: storeMpRaw,
      };
    }
  }

  return {
    ok: false,
    error:
      "Amazon Selling Partner credentials are not configured for this workspace or store. " +
      "Link an Amazon marketplace to the store in Settings, or add an `amazon_sp_api` key in organization API keys.",
  };
}

export async function getAmazonCatalogAccessToken(ctx: {
  credentials: AmazonSpApiCredentials;
}): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  try {
    const t = await getAmazonAccessToken(ctx.credentials);
    return { ok: true, accessToken: t.accessToken };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Amazon token request failed.";
    return { ok: false, error: msg };
  }
}

function catalogNotFoundMessage(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("not_found") || t.includes('"code":"not_found"') || t.includes("not found");
}

async function fetchAmazonCatalogItemJsonOnce(params: {
  catalogHost: string;
  accessToken: string;
  marketplaceIds: string[];
  asin: string;
  includedData?: string;
}): Promise<
  | { ok: true; body: unknown; attempts: number }
  | { ok: false; status: number; error: string; attempts: number; lastTransient?: boolean }
> {
  const base = trimHost(params.catalogHost);
  const mids = params.marketplaceIds.map((s) => s.trim()).filter(Boolean);
  if (!mids.length) {
    return { ok: false, status: 0, error: "No marketplace ids for catalog request.", attempts: 0 };
  }
  const qp = new URLSearchParams({
    marketplaceIds: mids.join(","),
    includedData:
      params.includedData?.trim() || "summaries,attributes,images,productTypes,salesRanks",
  });
  const url = `${base}/catalog/2022-04-01/items/${encodeURIComponent(params.asin)}?${qp}`;
  const res = await fetchSpApiJsonWithRetry(url, {
    headers: {
      "x-amz-access-token": params.accessToken,
      "Content-Type": "application/json",
    },
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.text?.slice(0, 500) || `HTTP ${res.status}`,
      attempts: res.attempts,
      lastTransient: res.lastTransient,
    };
  }
  return { ok: true, body: res.json ?? {}, attempts: res.attempts };
}

/**
 * Catalog Items GET with SP-API throttling retries.
 * On 404 NOT_FOUND with multiple marketplaces configured, retries one marketplace at a time (safe regional fallback).
 */
export async function fetchAmazonCatalogItemJson(params: {
  catalogHost: string;
  accessToken: string;
  marketplaceIds: string[];
  asin: string;
  /** Amazon Catalog Items API `includedData` (comma-separated). */
  includedData?: string;
}): Promise<
  | { ok: true; body: unknown; attempts: number }
  | { ok: false; status: number; error: string; attempts: number; lastTransient?: boolean }
> {
  const uniq = [...new Set(params.marketplaceIds.map((s) => s.trim()).filter(Boolean))];
  let totalAttempts = 0;

  let first = await fetchAmazonCatalogItemJsonOnce({ ...params, marketplaceIds: uniq });
  totalAttempts += first.attempts;
  if (first.ok) return { ok: true, body: first.body, attempts: totalAttempts };

  if (first.status === 404 && uniq.length > 1 && catalogNotFoundMessage(first.error)) {
    for (const one of uniq) {
      const r = await fetchAmazonCatalogItemJsonOnce({ ...params, marketplaceIds: [one] });
      totalAttempts += r.attempts;
      if (r.ok) return { ok: true, body: r.body, attempts: totalAttempts };
    }
    return { ok: false, status: 404, error: first.error, attempts: totalAttempts };
  }

  return {
    ok: false,
    status: first.status,
    error: first.error,
    attempts: totalAttempts,
    lastTransient: first.lastTransient,
  };
}

export function extractCatalogMainImageAndText(item: unknown): {
  main_image_url: string | null;
  product_name: string | null;
  brand: string | null;
} {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { main_image_url: null, product_name: null, brand: null };
  }
  const root = item as Record<string, unknown>;
  const summaries = root.summaries;
  let product_name: string | null = null;
  let brand: string | null = null;
  if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
    const s0 = summaries[0] as Record<string, unknown>;
    const n = s0.itemName ?? s0.item_name;
    const b = s0.brand;
    if (typeof n === "string" && n.trim()) product_name = n.trim();
    if (typeof b === "string" && b.trim()) brand = b.trim();
  }

  const { bestUrl: main_image_url } = extractBestMainImageFromCatalogItem(item);

  return { main_image_url, product_name, brand };
}

export function isLikelyAsin(v: string): boolean {
  const s = v.trim();
  return /^[A-Z0-9]{10}$/i.test(s);
}
