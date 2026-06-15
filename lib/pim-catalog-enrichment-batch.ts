import {
  collectAmazonCatalogImageUrls,
  dedupeAmazonProductImageUrls,
  extractBestMainImageFromCatalogItem,
  pickBestAmazonImageUrl,
  scoreAmazonImageUrl,
} from "./amazon-catalog-image-extract";
import {
  pimPrefetchAlternateAsinsByProduct,
  pimPrefetchCatalogProductsForEnrichment,
  pimPrefetchIdentifierMapCatalogLinks,
  tryAmazonItemOffersAcrossAsins,
  type PricingAsinTrial,
} from "./pim-enrich-catalog-price-attempts";
import { pickAmazonApiPriceCandidateIndexWithOpenAI } from "./pim-price-candidate-ai";
import { pickAmazonCategoryLabelWithOpenAI } from "./pim-category-candidate-ai";
import {
  dedupeAmazonCategoryCandidatesByMaxScore,
  extractAmazonCategoryCandidates,
  extractBrowseCategoryDisplayName,
  extractListPriceFromCatalog,
  extractSummaryItemNameBrand,
  isWeakProductName,
  mergeEnrichmentProvenance,
  pimCategorySourceFromCandidate,
  type AmazonCategoryCandidate,
} from "./pim-catalog-item-enrichment-fields";
import type { PricingApiTier } from "./pim-amazon-item-offers";
import {
  pickBestCatalogProductFallbackOfferPrice,
  pickBestCatalogProductListingPrice,
} from "./pim-saved-listing-price";
import {
  fetchAmazonCatalogItemJson,
  getAmazonCatalogAccessToken,
  isLikelyAsin,
  resolveAmazonCatalogContext,
} from "./pim-amazon-catalog-enrichment";
import {
  fetchAmazonCatalogSearchItemsJson,
  pickConservativeSearchCatalogAsin,
} from "./pim-amazon-catalog-search";
import { isPimInvalidVendorCategoryLabel } from "./pim-invalid-label";
import {
  detectProductPricesInsertShape,
  insertAmazonEnrichmentProductPrice,
  type InsertAmazonProductPriceResult,
  type ProductPricesInsertShape,
} from "./pim-product-prices-insert";
import {
  buildImageProvenance,
  evaluateSuspiciousMainImage,
  mergeImageProvenanceIntoAmazonRaw,
  shouldAllowMainImageOverwrite,
} from "./pim-image-suspicious-policy";
import { supabaseServer } from "./supabase-server";
import { getPimFieldProvenanceObject } from "./pim-field-provenance";
import { isUuidString } from "./uuid";
import {
  PIM_CATALOG_ENRICHMENT_DELAY_MS,
  PIM_CATALOG_ENRICHMENT_MAX_PER_RUN,
  parsePimCatalogEnrichmentBatchParams,
  validatePimCatalogEnrichmentBatchParams,
  type PimCatalogEnrichmentBatchParams,
  type PimCatalogEnrichmentBatchResult,
  type PimCatalogEnrichmentDebugRow,
  type PimCatalogEnrichmentFailureRow,
} from "./pim-catalog-enrichment-batch-request";

export {
  PIM_CATALOG_ENRICHMENT_DELAY_MS,
  PIM_CATALOG_ENRICHMENT_MAX_PER_RUN,
  parsePimCatalogEnrichmentBatchParams,
  validatePimCatalogEnrichmentBatchParams,
  PIM_CATALOG_ENRICHMENT_METRIC_KEYS,
} from "./pim-catalog-enrichment-batch-request";
export type {
  PimCatalogEnrichmentBatchParams,
  PimCatalogEnrichmentBatchResult,
  PimCatalogEnrichmentBatchSuccess,
  PimCatalogEnrichmentBatchError,
  PimCatalogEnrichmentRequestBody,
  PimCatalogEnrichmentDebugRow,
  PimCatalogEnrichmentFailureRow,
} from "./pim-catalog-enrichment-batch-request";

const MAX_PER_RUN = PIM_CATALOG_ENRICHMENT_MAX_PER_RUN;
const DELAY_MS = PIM_CATALOG_ENRICHMENT_DELAY_MS;

const MIN_CATEGORY_MATCH_SCORE = 0.72;
const MIN_CATEGORY_CREATE_SCORE = 0.86;
const MIN_CATEGORY_AI_POOL_SCORE = 0.55;
const RETRY_CATALOG_CONFIDENCE_SCALE = 0.84;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function maybeInsertAmazonEnrichmentProductPrice(
  dryRun: boolean,
  shape: ProductPricesInsertShape,
  args: Parameters<typeof insertAmazonEnrichmentProductPrice>[1],
): Promise<InsertAmazonProductPriceResult> {
  if (dryRun) return { ok: true };
  return insertAmazonEnrichmentProductPrice(shape, args);
}

async function maybeUpdateProductRow(
  dryRun: boolean,
  patch: Record<string, unknown>,
  rowId: string,
  organizationId: string,
  storeId: string,
): Promise<{ error: { message: string } | null }> {
  if (dryRun) return { error: null };
  const { error } = await supabaseServer
    .from("products")
    .update(patch)
    .eq("id", rowId)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId);
  return { error: error ? { message: error.message } : null };
}

function isMissingMainImage(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v !== "string") return true;
  return !v.trim();
}

function nearlyEqualPrice(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0005;
}

function mergePimPriceEnrichmentMeta(base: Record<string, unknown>, pricePatch: Record<string, unknown>): void {
  const prev =
    base.pim_price_enrichment && typeof base.pim_price_enrichment === "object" && !Array.isArray(base.pim_price_enrichment)
      ? (base.pim_price_enrichment as unknown as Record<string, unknown>)
      : {};
  base.pim_price_enrichment = { ...prev, ...pricePatch };
}

function summarizeMissingPriceReason(args: {
  pricingMarketplaceConfigured: boolean;
  catalogHttp: number | null;
  catalogFailed: boolean;
  pricingTrials: PricingAsinTrial[];
  pricingDetail: string;
  hadLiveListPrice: boolean;
  hadSavedRawList: boolean;
  hadListingExportPrice: boolean;
  hadOfferLikeFallback?: boolean;
}): string {
  const parts: string[] = [];
  if (!args.pricingMarketplaceConfigured) {
    parts.push("Product Pricing API was not run (no pricing marketplace ids on the store/credentials).");
  } else if (args.pricingTrials.length) {
    const last = args.pricingTrials[args.pricingTrials.length - 1]!;
    const mp = last.marketplace_id ? ` (marketplace ${last.marketplace_id})` : "";
    parts.push(`Pricing API tried ${args.pricingTrials.length} ASIN/marketplace attempt(s); last: ${last.kind} for ${last.asin}${mp}.`);
  } else {
    parts.push(`Pricing: ${args.pricingDetail}.`);
  }
  if (args.catalogFailed) {
    parts.push(`Catalog Items API failed (HTTP ${args.catalogHttp ?? "—"}); no live list price from that response.`);
  } else if (!args.hadLiveListPrice) {
    parts.push("Live catalog response had no parsable list/listing price.");
  }
  if (!args.hadSavedRawList) {
    parts.push("Saved amazon_raw had no parsable catalog list price.");
  }
  if (!args.hadListingExportPrice) {
    parts.push("No linked catalog_products row with a positive listing price column.");
  }
  if (args.hadOfferLikeFallback != null && !args.hadOfferLikeFallback) {
    parts.push("No offer-style price fields in catalog_products raw_payload.");
  }
  return parts.join(" ");
}

type FailureRow = PimCatalogEnrichmentFailureRow;

type EnrichmentDebugRow = PimCatalogEnrichmentDebugRow;

type ProductRow = {
  id: string;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  upc_code?: string | null;
  product_name?: string | null;
  brand?: string | null;
  main_image_url?: string | null;
  amazon_raw?: unknown;
  category_id?: string | null;
  metadata?: unknown;
};

function wantsCatalogEnrichment(r: ProductRow): boolean {
  return (
    isMissingMainImage(r.main_image_url) ||
    isWeakProductName(r.product_name) ||
    !String(r.brand ?? "").trim() ||
    !String(r.category_id ?? "").trim()
  );
}

const ENRICH_PRODUCT_SELECT =
  "id, asin, fnsku, sku, upc_code, product_name, brand, main_image_url, amazon_raw, category_id, metadata";

async function fetchProductRowsForEnrichment(args: {
  organizationId: string;
  storeId: string;
  retryOnly: boolean;
  retryIds: string[];
  retryMissingPrices: boolean;
}): Promise<{ rows: ProductRow[]; error: string | null }> {
  const { organizationId, storeId, retryOnly, retryIds, retryMissingPrices } = args;

  if (retryOnly && retryIds.length) {
    const { data, error } = await supabaseServer
      .from("products")
      .select(ENRICH_PRODUCT_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .is("deleted_at", null)
      .in("id", retryIds);
    return { rows: (data ?? []) as ProductRow[], error: error?.message ?? null };
  }

  const pageSize = 1000;
  const out: ProductRow[] = [];
  for (let from = 0; ; from += pageSize) {
    let q = supabaseServer
      .from("products")
      .select(ENRICH_PRODUCT_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .is("deleted_at", null);
    if (retryMissingPrices) {
      q = q.order("updated_at", { ascending: false, nullsFirst: false });
    } else {
      q = q.order("id", { ascending: true });
    }
    q = q.range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) return { rows: [], error: error.message };
    const chunk = (data ?? []) as ProductRow[];
    out.push(...chunk);
    if (chunk.length < pageSize) break;
  }
  return { rows: out, error: null };
}

async function resolveOrCreateCategoryId(
  organizationId: string,
  label: string,
  categoryByLowerName: Map<string, string>,
  minScore: number,
  candidateScore: number,
  dryRun = false,
): Promise<{ id: string } | null> {
  const trimmed = label.trim();
  if (!trimmed || isPimInvalidVendorCategoryLabel(trimmed)) return null;
  const hit = categoryByLowerName.get(trimmed.toLowerCase());
  if (hit) return { id: hit };
  if (candidateScore < minScore) return null;
  if (dryRun) return null;
  const { data, error } = await supabaseServer
    .from("product_categories")
    .insert({ organization_id: organizationId, name: trimmed })
    .select("id")
    .single();
  if (!error && data?.id) {
    const id = String(data.id);
    categoryByLowerName.set(trimmed.toLowerCase(), id);
    return { id };
  }
  const { data: rows } = await supabaseServer
    .from("product_categories")
    .select("id,name")
    .eq("organization_id", organizationId);
  const found = (rows ?? []).find(
    (r) => String((r as { name?: string }).name ?? "")
      .trim()
      .toLowerCase() === trimmed.toLowerCase(),
  ) as { id?: string } | undefined;
  if (found?.id) {
    const id = String(found.id);
    categoryByLowerName.set(trimmed.toLowerCase(), id);
    return { id };
  }
  return null;
}

async function resolveAsinFromFnskuViaIdentifierMap(params: {
  organizationId: string;
  storeId: string;
  productId: string;
  fnsku: string;
}): Promise<string | null> {
  const fn = params.fnsku.trim();
  if (!fn) return null;
  const { data } = await supabaseServer
    .from("product_identifier_map")
    .select("asin")
    .eq("organization_id", params.organizationId)
    .eq("store_id", params.storeId)
    .eq("product_id", params.productId)
    .eq("fnsku", fn)
    .limit(8);
  for (const r of data ?? []) {
    const a = String((r as { asin?: string | null }).asin ?? "").trim();
    if (isLikelyAsin(a)) return a.toUpperCase();
  }
  return null;
}

export async function runPimCatalogEnrichmentBatch(
  params: PimCatalogEnrichmentBatchParams,
): Promise<PimCatalogEnrichmentBatchResult> {
  const validationErr = validatePimCatalogEnrichmentBatchParams(params);
  if (validationErr) return validationErr;

  const {
    organizationId,
    storeId,
    limit,
    startIndex,
    prioritizeIncomplete,
    forceFreshPriceRows,
    retryOnly,
    retryMissingPrices,
    retryIds,
    allowEnrichmentDebug,
    allowSuspiciousImageOverwrite,
    dryRun = false,
  } = params;

  const priceDedupe: { skipRecentDuplicateCheck?: boolean } = forceFreshPriceRows
    ? { skipRecentDuplicateCheck: true }
    : {};

  const { data: storeRow, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (storeErr || !storeRow) {
    return { ok: false, error: "Store not found for this organization.", status: 400 };
  }

  const ctx = await resolveAmazonCatalogContext(organizationId, storeId);
  if (!ctx.ok) {
    return { ok: false, error: ctx.error, status: 422 };
  }

  const tokenRes = await getAmazonCatalogAccessToken({ credentials: ctx.credentials });
  if (!tokenRes.ok) {
    return { ok: false, error: `Amazon authentication failed: ${tokenRes.error}`, status: 502 };
  }

  const { rows: fetchedRows, error: fetchErr } = await fetchProductRowsForEnrichment({
    organizationId,
    storeId,
    retryOnly,
    retryIds,
    retryMissingPrices,
  });
  if (fetchErr) {
    return { ok: false, error: fetchErr, status: 400 };
  }

  let list = fetchedRows;
  let skipped_no_asin_for_missing_price = 0;

  if (retryMissingPrices) {
    const { data: ppRows, error: ppQErr } = await supabaseServer
      .from("product_prices")
      .select("product_id")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId);
    if (ppQErr) {
      return { ok: false, error: ppQErr.message, status: 400 };
    }
    const pricedSet = new Set(
      (ppRows ?? [])
        .map((r) => String((r as { product_id?: string }).product_id ?? "").trim())
        .filter(Boolean),
    );
    skipped_no_asin_for_missing_price = list.filter((r) => !isLikelyAsin(String(r.asin ?? "").trim())).length;
    list = list.filter((r) => {
      const a = String(r.asin ?? "").trim();
      return isLikelyAsin(a) && !pricedSet.has(r.id);
    });
  }

  const withValidAsin = list.filter((r) => {
    const asin = typeof r.asin === "string" ? r.asin.trim() : "";
    return isLikelyAsin(asin);
  });

  const skipped_no_asin = retryMissingPrices
    ? skipped_no_asin_for_missing_price
    : retryOnly
      ? 0
      : Math.max(0, list.length - withValidAsin.length);

  const priceRetryBoost = (x: ProductRow) => {
    const m =
      x.metadata && typeof x.metadata === "object" && !Array.isArray(x.metadata)
        ? (x.metadata as unknown as Record<string, unknown>)
        : {};
    const pe =
      m.pim_price_enrichment && typeof m.pim_price_enrichment === "object" && !Array.isArray(m.pim_price_enrichment)
        ? (m.pim_price_enrichment as unknown as Record<string, unknown>)
        : {};
    const po = String(pe.pricing_outcome ?? "").toLowerCase();
    if (po.includes("thrott")) return 0;
    const ce =
      m.pim_catalog_enrichment && typeof m.pim_catalog_enrichment === "object" && !Array.isArray(m.pim_catalog_enrichment)
        ? (m.pim_catalog_enrichment as unknown as Record<string, unknown>)
        : {};
    const po2 = String(ce.pricing_outcome ?? "").toLowerCase();
    if (po2.includes("thrott")) return 0;
    return 1;
  };

  const orderedForRun = retryOnly
    ? withValidAsin.filter((r) => retryIds.includes(r.id))
    : retryMissingPrices
      ? [...withValidAsin].sort(
          (a, b) => priceRetryBoost(a) - priceRetryBoost(b) || String(a.id).localeCompare(String(b.id)),
        )
      : [...withValidAsin].sort((a, b) => {
          if (prioritizeIncomplete) {
            const pri = (x: ProductRow) => (wantsCatalogEnrichment(x) ? 0 : 1);
            return pri(a) - pri(b) || String(a.id).localeCompare(String(b.id));
          }
          return String(a.id).localeCompare(String(b.id));
        });
  const toProcess = orderedForRun.slice(startIndex, startIndex + limit);
  const scanned = orderedForRun.length;
  const nextStartIndex = startIndex + toProcess.length;
  const continuation =
    nextStartIndex < orderedForRun.length
      ? { next_start_index: nextStartIndex, total_eligible: orderedForRun.length }
      : undefined;

  const with_asin = withValidAsin.length;
  const with_fnsku = withValidAsin.filter((r) => String(r.fnsku ?? "").trim().length > 0).length;
  const with_sku = withValidAsin.filter((r) => String(r.sku ?? "").trim().length > 0).length;
  const with_name = withValidAsin.filter((r) => !isWeakProductName(r.product_name)).length;

  let enriched_images = 0;
  let enriched_brand = 0;
  let enriched_title = 0;
  let skipped_no_image_found = 0;
  let no_match = 0;
  let failed = 0;
  let rows_saved = 0;
  let catalog_only_refresh = 0;
  const failures: FailureRow[] = [];

  let categories_updated = 0;
  let category_candidates_found = 0;
  let category_skipped_low_confidence = 0;
  let price_candidates_found = 0;
  let prices_inserted = 0;
  let pricing_api_not_available = 0;
  let pricing_permission_missing = 0;
  let price_skipped_no_match = 0;
  let products_with_existing_price = 0;
  let category_retry_attempted = 0;
  let category_retry_success = 0;
  let image_retry_attempted = 0;
  let image_retry_success = 0;
  let fnsku_map_asin_mismatch_skipped = 0;
  let suspicious_image_overwritten = 0;
  let still_missing_category = 0;
  let still_missing_image = 0;

  const pricingMarketplaceId = ctx.pricingMarketplaceId ?? "";
  let throttled_count = 0;
  let retry_count = 0;
  let deferred_count = 0;
  let pricing_invalid_marketplace_count = 0;
  let pricing_asin_not_found_count = 0;
  let pricing_no_offer_data_count = 0;
  let pricing_endpoint_not_configured_count = 0;
  let pricing_throttled_count = 0;
  let price_insert_skipped_duplicate = 0;
  let price_insert_db_errors = 0;
  let catalog_not_found_count = 0;
  let price_from_alternate_asin = 0;
  let price_from_saved_amazon_raw = 0;
  let price_from_catalog_products_listing = 0;
  let price_from_catalog_products_fallback_offer = 0;
  let api_price_ai_disambiguations = 0;

  const enrichmentDebug: EnrichmentDebugRow[] = [];

  const { data: catRows } = await supabaseServer
    .from("product_categories")
    .select("id,name")
    .eq("organization_id", organizationId);
  const categoryByLowerName = new Map<string, string>();
  for (const c of catRows ?? []) {
    const rec = c as { id?: string; name?: string };
    const id = String(rec.id ?? "").trim();
    const n = String(rec.name ?? "").trim();
    if (!id || !n) continue;
    categoryByLowerName.set(n.toLowerCase(), id);
  }

  if (toProcess.length) {
    const ids = toProcess.map((r) => r.id);
    const { data: ppExisting } = await supabaseServer
      .from("product_prices")
      .select("product_id")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .in("product_id", ids);
    products_with_existing_price = new Set(
      (ppExisting ?? []).map((r) => String((r as { product_id?: string }).product_id ?? "").trim()).filter(Boolean),
    ).size;
  }

  const ppInsertShape = await detectProductPricesInsertShape();

  const runIds = toProcess.map((r) => r.id);
  const altAsinMap = await pimPrefetchAlternateAsinsByProduct(organizationId, storeId, runIds);
  const mapCatalogLinks = await pimPrefetchIdentifierMapCatalogLinks(organizationId, storeId, runIds);
  const catalogByProduct = await pimPrefetchCatalogProductsForEnrichment({
    organizationId,
    storeId,
    products: toProcess,
    mapCatalogLinks,
  });

  const pricingMarketplaceOrder = (() => {
    const primary = (pricingMarketplaceId ?? "").trim().toUpperCase();
    const rest = (ctx.marketplaceIds ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    const out: string[] = [];
    if (primary) out.push(primary);
    for (const x of rest) if (!out.includes(x)) out.push(x);
    return out;
  })();

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i];
    const asin = String(row.asin ?? "").trim();
    const primaryAsinUpper = asin.trim().toUpperCase();
    const altList = altAsinMap.get(row.id) ?? [];
    const orderedAsins = [primaryAsinUpper, ...altList.filter((a) => a !== primaryAsinUpper)];

    const cat = await fetchAmazonCatalogItemJson({
      catalogHost: ctx.catalogHost,
      accessToken: tokenRes.accessToken,
      marketplaceIds: ctx.marketplaceIds,
      asin,
    });
    const catalogRateLimited = !cat.ok && (cat.status === 429 || Boolean(cat.lastTransient));
    retry_count += Math.max(0, cat.attempts - 1);

    let offersPrice: { amount: number; currency: string } | null = null;
    let offersRawSample: string | null = null;
    let offersOutcome: "ok" | "permission" | "not_available" | "no_offers" | "skipped" = "skipped";
    let offersHttpStatus: number | null = null;
    let offersDetail = "skipped";
    let offersAsinUsed: string | null = null;
    let offersPricingMarketplaceUsed: string | null = null;
    let offersPricingApiTier: PricingApiTier | null = null;
    let pricingTrials: PricingAsinTrial[] = [];

    if (pricingMarketplaceOrder.length) {
      const { result: off, usedAsin, usedMarketplaceId, trials, attemptsSum } = await tryAmazonItemOffersAcrossAsins({
        spApiHost: ctx.catalogHost,
        accessToken: tokenRes.accessToken,
        marketplaceIdsOrdered: pricingMarketplaceOrder,
        asins: orderedAsins,
        extraThrottleAttempts: 4,
        delayBetweenAsinsMs: DELAY_MS,
      });
      pricingTrials = trials;
      retry_count += Math.max(0, attemptsSum - trials.length);
      offersAsinUsed = usedAsin;
      offersPricingMarketplaceUsed = usedMarketplaceId;
      if (off.ok) {
        offersOutcome = "ok";
        offersDetail = "ok";
        offersHttpStatus = off.httpStatus;
        offersPrice = { amount: off.amount, currency: off.currency };
        offersRawSample = off.rawSample;
        offersPricingApiTier = off.pricingApiTier;
        if (usedAsin && usedAsin !== primaryAsinUpper) price_from_alternate_asin += 1;
      } else {
        offersHttpStatus = off.httpStatus ?? off.status;
        offersDetail = off.kind;
        switch (off.kind) {
          case "missing_role":
            pricing_permission_missing += 1;
            offersOutcome = "permission";
            break;
          case "throttled":
            pricing_throttled_count += 1;
            throttled_count += 1;
            pricing_api_not_available += 1;
            offersOutcome = "not_available";
            break;
          case "invalid_marketplace":
            pricing_invalid_marketplace_count += 1;
            pricing_api_not_available += 1;
            offersOutcome = "not_available";
            break;
          case "asin_not_found":
            pricing_asin_not_found_count += 1;
            pricing_api_not_available += 1;
            offersOutcome = "not_available";
            break;
          case "no_offer_data":
            pricing_no_offer_data_count += 1;
            pricing_api_not_available += 1;
            offersOutcome = "no_offers";
            break;
          case "endpoint_not_configured":
            pricing_endpoint_not_configured_count += 1;
            offersOutcome = "skipped";
            break;
          case "bad_request":
            pricing_api_not_available += 1;
            offersOutcome = "not_available";
            break;
          default:
            pricing_api_not_available += 1;
            offersOutcome = "not_available";
        }
      }
    } else {
      pricing_endpoint_not_configured_count += 1;
      offersDetail = "endpoint_not_configured";
    }

    if (!cat.ok) {
      if (cat.status === 404) {
        const ex = cat.error.toLowerCase();
        if (ex.includes("not_found") || ex.includes("not found")) catalog_not_found_count += 1;
      }
      if (cat.status === 429 || cat.lastTransient) {
        throttled_count += 1;
        deferred_count += 1;
      }

      const savedListPartial = extractListPriceFromCatalog(row.amazon_raw);
      const listingPickPartial = pickBestCatalogProductListingPrice(catalogByProduct.get(row.id) ?? []);
      const fallbackPickPartial = pickBestCatalogProductFallbackOfferPrice(catalogByProduct.get(row.id) ?? []);

      let priceCandThis = 0;
      if (offersPrice && offersPrice.amount > 0) priceCandThis += 1;
      if (savedListPartial && savedListPartial.amount > 0) priceCandThis += 1;
      if (listingPickPartial && listingPickPartial.amount > 0) priceCandThis += 1;
      if (fallbackPickPartial && fallbackPickPartial.amount > 0) priceCandThis += 1;
      price_candidates_found += priceCandThis;

      let priceInsertedThis = 0;
      const insertedSourcesPartial: string[] = [];
      const offerAsinForRow = (offersAsinUsed ?? asin).trim().toUpperCase();
      if (offersPrice && offersPrice.amount > 0) {
        const ins = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
          organizationId,
          storeId,
          productId: row.id,
          asin: offerAsinForRow,
          amount: offersPrice.amount,
          currency: offersPrice.currency,
          from: "pricing_item_offers",
          productSku: row.sku,
          rawSample: offersRawSample,
          pricingApiTier: offersPricingApiTier,
          ...priceDedupe,
        });
        if (ins.ok) {
          priceInsertedThis += 1;
          prices_inserted += 1;
          insertedSourcesPartial.push("pricing_item_offers");
        } else if (ins.reason === "duplicate_recent") {
          price_insert_skipped_duplicate += 1;
        } else if (ins.reason === "validation") {
          failures.push({
            product_id: row.id,
            reason: `product_prices insert validation: ${ins.message ?? "unknown"}${ins.diagnostic ? ` || ${ins.diagnostic}` : ""}${ins.insertKeys?.length ? ` || insert_keys=${ins.insertKeys.join(",")}` : ""}`,
          });
        } else {
          price_insert_db_errors += 1;
          failures.push({
            product_id: row.id,
            reason: `product_prices insert failed: ${ins.message ?? "unknown"}${ins.diagnostic ? ` || ${ins.diagnostic}` : ""}${ins.insertKeys?.length ? ` || insert_keys=${ins.insertKeys.join(",")}` : ""}`,
          });
        }
      }
      if (priceInsertedThis === 0 && savedListPartial && savedListPartial.amount > 0) {
        const insR = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
          organizationId,
          storeId,
          productId: row.id,
          asin: primaryAsinUpper,
          amount: savedListPartial.amount,
          currency: savedListPartial.currency,
          from: "saved_amazon_raw_catalog",
          productSku: row.sku,
          ...priceDedupe,
        });
        if (insR.ok) {
          priceInsertedThis += 1;
          prices_inserted += 1;
          price_from_saved_amazon_raw += 1;
          insertedSourcesPartial.push("saved_amazon_raw_catalog");
        } else if (insR.reason === "duplicate_recent") {
          price_insert_skipped_duplicate += 1;
        } else if (insR.reason === "validation") {
          failures.push({
            product_id: row.id,
            reason: `product_prices (saved_raw) validation: ${insR.message ?? "unknown"}`,
          });
        } else if (insR.reason === "db_error") {
          price_insert_db_errors += 1;
          failures.push({ product_id: row.id, reason: `product_prices (saved_raw) insert: ${insR.message ?? ""}` });
        }
      }
      if (priceInsertedThis === 0 && listingPickPartial && listingPickPartial.amount > 0) {
        const insL = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
          organizationId,
          storeId,
          productId: row.id,
          asin: primaryAsinUpper,
          amount: listingPickPartial.amount,
          currency: listingPickPartial.currency,
          from: "catalog_products_listing",
          productSku: row.sku,
          metadataExtra: { catalog_product_id: listingPickPartial.catalog_product_id },
          ...priceDedupe,
        });
        if (insL.ok) {
          priceInsertedThis += 1;
          prices_inserted += 1;
          price_from_catalog_products_listing += 1;
          insertedSourcesPartial.push("catalog_products_listing");
        } else if (insL.reason === "duplicate_recent") {
          price_insert_skipped_duplicate += 1;
        } else if (insL.reason === "validation") {
          failures.push({
            product_id: row.id,
            reason: `product_prices (listing snapshot) validation: ${insL.message ?? "unknown"}`,
          });
        } else if (insL.reason === "db_error") {
          price_insert_db_errors += 1;
          failures.push({ product_id: row.id, reason: `product_prices (listing snapshot) insert: ${insL.message ?? ""}` });
        }
      }
      if (priceInsertedThis === 0 && fallbackPickPartial && fallbackPickPartial.amount > 0) {
        const insF = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
          organizationId,
          storeId,
          productId: row.id,
          asin: primaryAsinUpper,
          amount: fallbackPickPartial.amount,
          currency: fallbackPickPartial.currency,
          from: "catalog_products_fallback_offer",
          productSku: row.sku,
          metadataExtra: { catalog_product_id: fallbackPickPartial.catalog_product_id },
          ...priceDedupe,
        });
        if (insF.ok) {
          priceInsertedThis += 1;
          prices_inserted += 1;
          price_from_catalog_products_fallback_offer += 1;
          insertedSourcesPartial.push("catalog_products_fallback_offer");
        } else if (insF.reason === "duplicate_recent") {
          price_insert_skipped_duplicate += 1;
        } else if (insF.reason === "validation") {
          failures.push({
            product_id: row.id,
            reason: `product_prices (listing offer fields) validation: ${insF.message ?? "unknown"}`,
          });
        } else if (insF.reason === "db_error") {
          price_insert_db_errors += 1;
          failures.push({ product_id: row.id, reason: `product_prices (listing offer fields) insert: ${insF.message ?? ""}` });
        }
      }

      const prevMetaPartial =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? ({ ...(row.metadata as unknown as Record<string, unknown>) } as unknown as Record<string, unknown>)
          : ({} as unknown as Record<string, unknown>);
      prevMetaPartial.pim_last_catalog_enrichment_at = new Date().toISOString();
      prevMetaPartial.pim_catalog_enrichment = {
        asin,
        catalog_http: cat.status,
        catalog_error_excerpt: cat.error.slice(0, 500),
        pricing_outcome: offersDetail,
        pricing_http: offersHttpStatus,
        marketplace_id: offersPricingMarketplaceUsed ?? pricingMarketplaceId ?? null,
        partial_run: true,
        note: "Catalog Items request failed; pricing API was still attempted when marketplace id is configured.",
      };
      const missingReasonPartial =
        priceInsertedThis > 0
          ? null
          : summarizeMissingPriceReason({
              pricingMarketplaceConfigured: pricingMarketplaceOrder.length > 0,
              catalogHttp: cat.status,
              catalogFailed: true,
              pricingTrials,
              pricingDetail: offersDetail,
              hadLiveListPrice: false,
              hadSavedRawList: Boolean(savedListPartial && savedListPartial.amount > 0),
              hadListingExportPrice: Boolean(listingPickPartial && listingPickPartial.amount > 0),
              hadOfferLikeFallback:
                (catalogByProduct.get(row.id) ?? []).length > 0
                  ? Boolean(fallbackPickPartial && fallbackPickPartial.amount > 0)
                  : undefined,
            });
      mergePimPriceEnrichmentMeta(prevMetaPartial, {
        last_attempt_at: new Date().toISOString(),
        primary_asin: primaryAsinUpper,
        alternate_asins_tried: orderedAsins.filter((a) => a !== primaryAsinUpper),
        pricing_asin_used: offerAsinForRow,
        pricing_marketplace_used: offersPricingMarketplaceUsed,
        pricing_trials: pricingTrials,
        pricing_http: offersHttpStatus,
        pricing_outcome: offersDetail,
        marketplace_id: offersPricingMarketplaceUsed ?? pricingMarketplaceId ?? null,
        inserted_sources: insertedSourcesPartial,
        missing_price_reason: missingReasonPartial,
      });

      const { error: metaUErr } = await maybeUpdateProductRow(
        dryRun,
        { metadata: prevMetaPartial },
        row.id,
        organizationId,
        storeId,
      );

      if (!metaUErr) {
        rows_saved += 1;
      } else {
        failed += 1;
        failures.push({ product_id: row.id, reason: metaUErr.message });
      }

      if (allowEnrichmentDebug) {
        enrichmentDebug.push({
          product_id: row.id,
          asin,
          marketplace_id: pricingMarketplaceId || null,
          pricing_endpoint: "/products/pricing/v0/items/{asin}/offers",
          pricing_http: offersHttpStatus,
          pricing_outcome: offersDetail,
          catalog_http: cat.status,
          catalog_detail: cat.error.slice(0, 280),
          list_price_candidate: "—",
          offers_price_candidate:
            offersPrice && offersPrice.amount > 0 ? `${offersPrice.amount} ${offersPrice.currency}` : "—",
          price_insert:
            priceInsertedThis > 0
              ? "inserted (pricing_item_offers)"
              : offersPrice && offersPrice.amount > 0
                ? "skipped (duplicate_recent or db_error — see failures)"
                : "no candidate",
          category_status: "catalog_unavailable",
          image_status: "catalog_unavailable",
        });
      }

      if (!metaUErr && (cat.status === 429 || cat.lastTransient)) {
        failures.push({
          product_id: row.id,
          reason: `[deferred] Catalog throttled (HTTP ${cat.status}) after ${cat.attempts} attempt(s). Pricing outcome: ${offersDetail}.`,
        });
      } else if (!metaUErr && priceInsertedThis === 0 && cat.status !== 429 && !cat.lastTransient) {
        failed += 1;
        failures.push({
          product_id: row.id,
          reason: `Catalog API HTTP ${cat.status}: ${cat.error.slice(0, 240)}`,
        });
      }

      if (i + 1 < toProcess.length) await sleep(DELAY_MS);
      continue;
    }

    const text = extractSummaryItemNameBrand(cat.body);
    const mainFromItemPrimary = extractBestMainImageFromCatalogItem(cat.body);
    const browseLabel = extractBrowseCategoryDisplayName(cat.body);
    const catCandidatesPrimary = extractAmazonCategoryCandidates(cat.body);
    const listPriceCatalog = extractListPriceFromCatalog(cat.body);

    let priceCandThis = 0;
    if (listPriceCatalog && listPriceCatalog.amount > 0) priceCandThis += 1;
    if (offersPrice && offersPrice.amount > 0) priceCandThis += 1;
    price_candidates_found += priceCandThis;

    const needCat0 = !String(row.category_id ?? "").trim();
      const needImg0 = isMissingMainImage(row.main_image_url);
      const supplementalBodies: Record<string, unknown>[] = [];
      const fetchOpts = {
        catalogHost: ctx.catalogHost,
        accessToken: tokenRes.accessToken,
        marketplaceIds: ctx.marketplaceIds,
      };

      const tryMergeSupplementalBody = async (asinForFetch: string, meta: Record<string, unknown>) => {
        if (!isLikelyAsin(asinForFetch) || asinForFetch.toUpperCase() === asin.toUpperCase()) return;
        if (needCat0) category_retry_attempted += 1;
        if (needImg0) image_retry_attempted += 1;
        const r = await fetchAmazonCatalogItemJson({ ...fetchOpts, asin: asinForFetch });
        retry_count += Math.max(0, r.attempts - 1);
        if (!r.ok) {
          await sleep(DELAY_MS);
          return;
        }
        const raw = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? (r.body as unknown as Record<string, unknown>) : null;
        if (!raw) {
          await sleep(DELAY_MS);
          return;
        }
        supplementalBodies.push({ ...raw, ...meta });
        const cc = extractAmazonCategoryCandidates(r.body);
        const imx = extractBestMainImageFromCatalogItem(r.body);
        if (needCat0 && cc.length) category_retry_success += 1;
        if (needImg0 && (imx.bestUrl || imx.candidates.length)) image_retry_success += 1;
        await sleep(DELAY_MS);
      };

      const fnSku = String(row.fnsku ?? "").trim();
      if ((needCat0 || needImg0) && fnSku) {
        const mappedAsin = await resolveAsinFromFnskuViaIdentifierMap({
          organizationId,
          storeId,
          productId: row.id,
          fnsku: fnSku,
        });
        if (mappedAsin) {
          const prodAsinNorm = String(row.asin ?? "").trim().toUpperCase();
          const mapAsinNorm = mappedAsin.trim().toUpperCase();
          if (prodAsinNorm && prodAsinNorm !== mapAsinNorm) {
            fnsku_map_asin_mismatch_skipped += 1;
          } else {
            await tryMergeSupplementalBody(mappedAsin, { pim_enrichment_supplement: "fnsku_identifier_map" });
          }
        }
      }

      const titleQ = String(row.product_name ?? "").trim();
      const brandQ = String(row.brand ?? "").trim();
      const skuQ = String(row.sku ?? "").trim();
      const keywordSteps: string[] = [];
      if (titleQ.length >= 4) keywordSteps.push(titleQ.slice(0, 180));
      if (brandQ && titleQ.length >= 3) keywordSteps.push(`${brandQ} ${titleQ}`.trim().slice(0, 180));
      if (skuQ.length >= 3 && /^[A-Za-z0-9._\-]+$/.test(skuQ)) keywordSteps.push(skuQ.slice(0, 80));

      for (const kw of keywordSteps) {
        if (!(needCat0 || needImg0)) break;
        if (needCat0) category_retry_attempted += 1;
        if (needImg0) image_retry_attempted += 1;
        const sh = await fetchAmazonCatalogSearchItemsJson({
          catalogHost: ctx.catalogHost,
          accessToken: tokenRes.accessToken,
          marketplaceIds: ctx.marketplaceIds,
          keywords: kw,
          pageSize: 10,
        });
        if (!sh.ok) {
          await sleep(DELAY_MS);
          continue;
        }
        const pickAsin = pickConservativeSearchCatalogAsin({
          numberOfResults: sh.numberOfResults,
          items: sh.items,
          productAsin: asin,
        });
        if (!pickAsin) {
          await sleep(DELAY_MS);
          continue;
        }
        await tryMergeSupplementalBody(pickAsin, {
          pim_enrichment_supplement: "keyword_search",
          pim_enrichment_keywords: kw,
        });
      }

      const stripSupplementKeys = (b: Record<string, unknown>): Record<string, unknown> => {
        const o = { ...b };
        delete o.pim_enrichment_supplement;
        delete o.pim_enrichment_keywords;
        return o;
      };

      const mergedCatCandidates = dedupeAmazonCategoryCandidatesByMaxScore([
        ...catCandidatesPrimary,
        ...supplementalBodies.flatMap((b) =>
          extractAmazonCategoryCandidates(stripSupplementKeys(b)).map((c) => ({
            ...c,
            score: Math.min(0.95, c.score * RETRY_CATALOG_CONFIDENCE_SCALE),
          })),
        ),
      ]);

      const prevBrand = typeof row.brand === "string" ? row.brand.trim() : "";
      const prevRaw =
        row.amazon_raw && typeof row.amazon_raw === "object" && !Array.isArray(row.amazon_raw)
          ? ({ ...(row.amazon_raw as unknown as Record<string, unknown>) } as unknown as Record<string, unknown>)
          : ({} as unknown as Record<string, unknown>);
      const bodyObj =
        cat.body && typeof cat.body === "object" && !Array.isArray(cat.body)
          ? ({ ...(cat.body as unknown as Record<string, unknown>) } as unknown as Record<string, unknown>)
          : ({} as unknown as Record<string, unknown>);

      const urlsFromPrev = collectAmazonCatalogImageUrls(prevRaw);
      const urlsFromNew = collectAmazonCatalogImageUrls(cat.body);
      const extraImgUrls: string[] = [];
      for (const sb of supplementalBodies) {
        const clean = stripSupplementKeys(sb);
        extraImgUrls.push(...collectAmazonCatalogImageUrls(clean));
        const imx = extractBestMainImageFromCatalogItem(clean);
        if (imx.bestUrl) extraImgUrls.push(imx.bestUrl);
        extraImgUrls.push(...imx.candidates);
      }
      const mergedCandidates = dedupeAmazonProductImageUrls([
        ...urlsFromPrev,
        ...urlsFromNew,
        ...mainFromItemPrimary.candidates,
        ...extraImgUrls,
      ])
        .map((u) => ({ u, s: scoreAmazonImageUrl(u) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.u);
      const mergedCandidatesTop = dedupeAmazonProductImageUrls(mergedCandidates)
        .map((u) => ({ u, s: scoreAmazonImageUrl(u) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.u)
        .slice(0, 16);
      bodyObj.pim_image_candidates = mergedCandidatesTop;

      const bestMain = mainFromItemPrimary.bestUrl ?? pickBestAmazonImageUrl(mergedCandidatesTop);

      category_candidates_found += mergedCatCandidates.length;

      const hasPayload = Boolean(
        text.product_name?.trim() ||
          text.brand?.trim() ||
          bestMain ||
          mergedCandidatesTop.length > 0 ||
          urlsFromNew.length > 0 ||
          browseLabel ||
          mergedCatCandidates.length > 0 ||
          listPriceCatalog,
      );
      if (!hasPayload) {
        no_match += 1;
        if (i + 1 < toProcess.length) await sleep(DELAY_MS);
        continue;
      }

      const mergedAmazonRaw = { ...prevRaw, ...bodyObj } as unknown as Record<string, unknown>;
      const amazonRawChanged =
        JSON.stringify(row.amazon_raw ?? {}) !== JSON.stringify(mergedAmazonRaw);

      const prevMeta =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? ({ ...(row.metadata as unknown as Record<string, unknown>) } as unknown as Record<string, unknown>)
          : ({} as unknown as Record<string, unknown>);
      prevMeta.pim_last_catalog_enrichment_at = new Date().toISOString();
      prevMeta.pim_catalog_enrichment = {
        asin,
        marketplace_id: offersPricingMarketplaceUsed ?? pricingMarketplaceId ?? null,
        pricing_http: offersHttpStatus,
        pricing_outcome: offersDetail,
        catalog_http: 200,
        fnsku_present: Boolean(String(row.fnsku ?? "").trim()),
        sku_present: Boolean(String(row.sku ?? "").trim()),
        supplemental_hits: supplementalBodies.length,
        note:
          "Amazon Catalog Items API v2022-04-01 (summaries, attributes, images, productTypes, salesRanks). " +
          "Optional Product Pricing API v0 item offers (New) when marketplace id is present. " +
          "Keyword / FNSKU-map retries may augment category or image candidates without replacing confident existing values. " +
          "Scalars are written only when missing or weak; price history is append-only on product_prices.",
      };

      const patch: Record<string, unknown> = {
        amazon_raw: mergedAmazonRaw,
        metadata: prevMeta,
      };

      const provenanceFields: string[] = [];
      const provenanceOverrides: Record<string, { confidence?: number; source?: string }> = {};
      let didImage = false;
      let didTitle = false;
      let didBrand = false;
      let didCategory = false;

      if (bestMain && isMissingMainImage(row.main_image_url)) {
        patch.main_image_url = bestMain;
        didImage = true;
        const prov = buildImageProvenance({
          source: "catalog_items_api",
          sourceAsin: asin,
          fetchPath: "pim_catalog_enrichment_batch",
        });
        mergedAmazonRaw.pim_image_provenance = prov;
        mergedAmazonRaw.image_source = prov.image_source;
        mergedAmazonRaw.image_source_asin = prov.image_source_asin;
        mergedAmazonRaw.image_fetch_path = prov.image_fetch_path;
        mergedAmazonRaw.image_updated_at = prov.image_updated_at;
      } else if (
        bestMain &&
        allowSuspiciousImageOverwrite &&
        shouldAllowMainImageOverwrite(row) &&
        row.main_image_url?.trim() &&
        bestMain.trim() !== row.main_image_url.trim()
      ) {
        const suspicious = evaluateSuspiciousMainImage(row);
        patch.main_image_url = bestMain;
        didImage = true;
        suspicious_image_overwritten += 1;
        const prov = buildImageProvenance({
          source: "catalog_items_api",
          sourceAsin: asin,
          fetchPath: "pim_catalog_enrichment_batch_suspicious_overwrite",
          overwriteReason: suspicious.reasons.join("|"),
        });
        Object.assign(mergedAmazonRaw, mergeImageProvenanceIntoAmazonRaw(mergedAmazonRaw, prov));
      } else if (!bestMain && isMissingMainImage(row.main_image_url)) {
        skipped_no_image_found += 1;
      }

      if (isWeakProductName(row.product_name) && text.product_name?.trim()) {
        patch.product_name = text.product_name.trim();
        provenanceFields.push("product_name");
        didTitle = true;
      }
      if (!prevBrand && text.brand?.trim()) {
        patch.brand = text.brand.trim();
        provenanceFields.push("brand");
        didBrand = true;
      }

      const hasCat = String(row.category_id ?? "").trim();
      if (!hasCat && mergedCatCandidates.length) {
        let chosen: AmazonCategoryCandidate | null = null;
        let viaAi = false;

        for (const c of mergedCatCandidates) {
          if (c.score < MIN_CATEGORY_MATCH_SCORE) continue;
          const cid = categoryByLowerName.get(c.label.toLowerCase());
          if (cid && !isPimInvalidVendorCategoryLabel(c.label)) {
            chosen = c;
            break;
          }
        }

        if (!chosen) {
          const top = mergedCatCandidates[0];
          if (top && top.score >= MIN_CATEGORY_CREATE_SCORE) {
            const created = await resolveOrCreateCategoryId(
              organizationId,
              top.label,
              categoryByLowerName,
              MIN_CATEGORY_CREATE_SCORE,
              top.score,
              dryRun,
            );
            if (created) chosen = top;
          }
        }

        if (!chosen) {
          const pool = mergedCatCandidates.filter((c) => c.score >= MIN_CATEGORY_AI_POOL_SCORE);
          if (pool.length >= 2) {
            const aiLabel = await pickAmazonCategoryLabelWithOpenAI({
              organizationId,
              productTitle: text.product_name ?? row.product_name ?? null,
              candidates: pool.map((c) => ({ label: c.label, score: c.score, source: c.source })),
            });
            if (aiLabel) {
              const match = mergedCatCandidates.find((c) => c.label.trim().toLowerCase() === aiLabel.toLowerCase());
              if (match) {
                const existing = categoryByLowerName.get(match.label.toLowerCase());
                if (existing) {
                  chosen = match;
                  viaAi = true;
                } else if (match.score >= MIN_CATEGORY_CREATE_SCORE) {
                  const created = await resolveOrCreateCategoryId(
                    organizationId,
                    match.label,
                    categoryByLowerName,
                    MIN_CATEGORY_CREATE_SCORE,
                    match.score,
                    dryRun,
                  );
                  if (created) {
                    chosen = match;
                    viaAi = true;
                  }
                }
              }
            }
          }
        }

        if (chosen) {
          let cid = categoryByLowerName.get(chosen.label.toLowerCase()) ?? null;
          if (!cid) {
            const r = await resolveOrCreateCategoryId(
              organizationId,
              chosen.label,
              categoryByLowerName,
              MIN_CATEGORY_CREATE_SCORE,
              chosen.score,
              dryRun,
            );
            cid = r?.id ?? null;
          }
          if (cid) {
            patch.category_id = cid;
            provenanceFields.push("category_id");
            provenanceOverrides.category_id = {
              confidence: Math.min(0.97, chosen.score + (viaAi ? 0.02 : 0)),
              source: "amazon_catalog_enrichment",
            };
            prevMeta.pim_category_source = pimCategorySourceFromCandidate(chosen, viaAi);
            prevMeta.pim_category_enrichment = {
              chosen_label: chosen.label,
              chosen_score: chosen.score,
              chosen_source: chosen.source,
              via_ai: viaAi,
              candidates: mergedCatCandidates.slice(0, 12).map((c) => ({
                label: c.label,
                score: c.score,
                source: c.source,
              })),
            };
            didCategory = true;
            categories_updated += 1;
          }
        } else if (mergedCatCandidates.length) {
          category_skipped_low_confidence += 1;
          prevMeta.pim_category_enrichment = {
            candidates: mergedCatCandidates.slice(0, 12).map((c) => ({
              label: c.label,
              score: c.score,
              source: c.source,
            })),
            note: "No category assignment: confidence below thresholds or invalid label.",
          };
        }
      }

      if (provenanceFields.length) {
        const existingProv = getPimFieldProvenanceObject(row as unknown as Record<string, unknown>);
        const prov = mergeEnrichmentProvenance(existingProv ?? {}, provenanceFields, provenanceOverrides);
        if (prov) prevMeta.pim_field_provenance = prov;
      }

      const { error: uErr } = await maybeUpdateProductRow(dryRun, patch, row.id, organizationId, storeId);

      if (uErr) {
        failed += 1;
        failures.push({ product_id: row.id, reason: uErr.message });
      } else {
        rows_saved += 1;
        if (didImage) enriched_images += 1;
        if (didTitle) enriched_title += 1;
        if (didBrand) enriched_brand += 1;

        let priceInsertedThis = 0;
        let insertedOffersOk = false;
        let insertOffersP = Boolean(offersPrice && offersPrice.amount > 0);
        let insertListP = Boolean(listPriceCatalog && listPriceCatalog.amount > 0);
        let apiDisambig: string | null = null;
        if (
          insertOffersP &&
          insertListP &&
          offersPrice &&
          listPriceCatalog &&
          !nearlyEqualPrice(listPriceCatalog.amount, offersPrice.amount)
        ) {
          const rel =
            Math.abs(offersPrice.amount - listPriceCatalog.amount) /
            Math.max(offersPrice.amount, listPriceCatalog.amount, 1e-9);
          if (rel > 0.005 || Math.abs(offersPrice.amount - listPriceCatalog.amount) > 0.05) {
            const idx = await pickAmazonApiPriceCandidateIndexWithOpenAI({
              organizationId,
              productTitle: row.product_name ?? null,
              candidates: [
                {
                  amount: offersPrice.amount,
                  currency: offersPrice.currency,
                  source: "Product Pricing API — item offers (New)",
                },
                {
                  amount: listPriceCatalog.amount,
                  currency: listPriceCatalog.currency,
                  source: "Catalog Items API — list/listing price",
                },
              ],
            });
            if (idx === 0) {
              insertListP = false;
              apiDisambig = "ai_chose_offers_only";
              api_price_ai_disambiguations += 1;
            } else if (idx === 1) {
              insertOffersP = false;
              apiDisambig = "ai_chose_list_only";
              api_price_ai_disambiguations += 1;
            } else {
              apiDisambig = "both_api_candidates_kept";
            }
          }
        }

        const offerAsinFor = (offersAsinUsed ?? asin).trim().toUpperCase();
        const insertedSourcesOk: string[] = [];

        if (insertOffersP && offersPrice && offersPrice.amount > 0) {
          const insOffers = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
            organizationId,
            storeId,
            productId: row.id,
            asin: offerAsinFor,
            amount: offersPrice.amount,
            currency: offersPrice.currency,
            from: "pricing_item_offers",
            productSku: row.sku,
            rawSample: offersRawSample,
            pricingApiTier: offersPricingApiTier,
            ...priceDedupe,
          });
          insertedOffersOk = insOffers.ok;
          if (insOffers.ok) {
            priceInsertedThis += 1;
            prices_inserted += 1;
            insertedSourcesOk.push("pricing_item_offers");
          } else if (insOffers.reason === "duplicate_recent") {
            price_insert_skipped_duplicate += 1;
          } else if (insOffers.reason === "validation") {
            failures.push({
              product_id: row.id,
              reason: `product_prices (offers) validation: ${insOffers.message ?? "unknown"}${insOffers.diagnostic ? ` || ${insOffers.diagnostic}` : ""}${insOffers.insertKeys?.length ? ` || insert_keys=${insOffers.insertKeys.join(",")}` : ""}`,
            });
          } else {
            price_insert_db_errors += 1;
            failures.push({
              product_id: row.id,
              reason: `product_prices (offers) insert: ${insOffers.message ?? insOffers.reason}${insOffers.diagnostic ? ` || ${insOffers.diagnostic}` : ""}${insOffers.insertKeys?.length ? ` || insert_keys=${insOffers.insertKeys.join(",")}` : ""}`,
            });
          }
        }
        if (insertListP && listPriceCatalog && listPriceCatalog.amount > 0) {
          const sameAsOffers =
            offersPrice &&
            offersPrice.amount > 0 &&
            nearlyEqualPrice(listPriceCatalog.amount, offersPrice.amount) &&
            insertedOffersOk;
          if (!sameAsOffers) {
            const insList = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
              organizationId,
              storeId,
              productId: row.id,
              asin,
              amount: listPriceCatalog.amount,
              currency: listPriceCatalog.currency,
              from: "catalog_items_api",
              productSku: row.sku,
              ...priceDedupe,
            });
            if (insList.ok) {
              priceInsertedThis += 1;
              prices_inserted += 1;
              insertedSourcesOk.push("catalog_items_api");
            } else if (insList.reason === "duplicate_recent") {
              price_insert_skipped_duplicate += 1;
            } else if (insList.reason === "validation") {
              failures.push({
                product_id: row.id,
                reason: `product_prices (list) validation: ${insList.message ?? "unknown"}${insList.diagnostic ? ` || ${insList.diagnostic}` : ""}${insList.insertKeys?.length ? ` || insert_keys=${insList.insertKeys.join(",")}` : ""}`,
              });
            } else {
              price_insert_db_errors += 1;
              failures.push({
                product_id: row.id,
                reason: `product_prices (list) insert: ${insList.message ?? insList.reason}${insList.diagnostic ? ` || ${insList.diagnostic}` : ""}${insList.insertKeys?.length ? ` || insert_keys=${insList.insertKeys.join(",")}` : ""}`,
              });
            }
          }
        }

        if (priceInsertedThis === 0) {
          const savedMerged = extractListPriceFromCatalog(mergedAmazonRaw);
          if (savedMerged && savedMerged.amount > 0) {
            const insR = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
              organizationId,
              storeId,
              productId: row.id,
              asin: primaryAsinUpper,
              amount: savedMerged.amount,
              currency: savedMerged.currency,
              from: "saved_amazon_raw_catalog",
              productSku: row.sku,
              ...priceDedupe,
            });
            if (insR.ok) {
              priceInsertedThis += 1;
              prices_inserted += 1;
              price_from_saved_amazon_raw += 1;
              insertedSourcesOk.push("saved_amazon_raw_catalog");
            } else if (insR.reason === "duplicate_recent") {
              price_insert_skipped_duplicate += 1;
            } else if (insR.reason === "validation") {
              failures.push({
                product_id: row.id,
                reason: `product_prices (saved_raw) validation: ${insR.message ?? "unknown"}`,
              });
            } else if (insR.reason === "db_error") {
              price_insert_db_errors += 1;
              failures.push({ product_id: row.id, reason: `product_prices (saved_raw) insert: ${insR.message ?? ""}` });
            }
          }
        }
        if (priceInsertedThis === 0) {
          const listingPickOk = pickBestCatalogProductListingPrice(catalogByProduct.get(row.id) ?? []);
          if (listingPickOk && listingPickOk.amount > 0) {
            const insL = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
              organizationId,
              storeId,
              productId: row.id,
              asin: primaryAsinUpper,
              amount: listingPickOk.amount,
              currency: listingPickOk.currency,
              from: "catalog_products_listing",
              productSku: row.sku,
              metadataExtra: { catalog_product_id: listingPickOk.catalog_product_id },
              ...priceDedupe,
            });
            if (insL.ok) {
              priceInsertedThis += 1;
              prices_inserted += 1;
              price_from_catalog_products_listing += 1;
              insertedSourcesOk.push("catalog_products_listing");
            } else if (insL.reason === "duplicate_recent") {
              price_insert_skipped_duplicate += 1;
            } else if (insL.reason === "validation") {
              failures.push({
                product_id: row.id,
                reason: `product_prices (listing snapshot) validation: ${insL.message ?? "unknown"}`,
              });
            } else if (insL.reason === "db_error") {
              price_insert_db_errors += 1;
              failures.push({ product_id: row.id, reason: `product_prices (listing snapshot) insert: ${insL.message ?? ""}` });
            }
          }
        }
        if (priceInsertedThis === 0) {
          const fallbackPickOk = pickBestCatalogProductFallbackOfferPrice(catalogByProduct.get(row.id) ?? []);
          if (fallbackPickOk && fallbackPickOk.amount > 0) {
            const insF = await maybeInsertAmazonEnrichmentProductPrice(dryRun,ppInsertShape, {
              organizationId,
              storeId,
              productId: row.id,
              asin: primaryAsinUpper,
              amount: fallbackPickOk.amount,
              currency: fallbackPickOk.currency,
              from: "catalog_products_fallback_offer",
              productSku: row.sku,
              metadataExtra: { catalog_product_id: fallbackPickOk.catalog_product_id },
              ...priceDedupe,
            });
            if (insF.ok) {
              priceInsertedThis += 1;
              prices_inserted += 1;
              price_from_catalog_products_fallback_offer += 1;
              insertedSourcesOk.push("catalog_products_fallback_offer");
            } else if (insF.reason === "duplicate_recent") {
              price_insert_skipped_duplicate += 1;
            } else if (insF.reason === "validation") {
              failures.push({
                product_id: row.id,
                reason: `product_prices (listing offer fields) validation: ${insF.message ?? "unknown"}`,
              });
            } else if (insF.reason === "db_error") {
              price_insert_db_errors += 1;
              failures.push({ product_id: row.id, reason: `product_prices (listing offer fields) insert: ${insF.message ?? ""}` });
            }
          }
        }

        const listingPickMeta = pickBestCatalogProductListingPrice(catalogByProduct.get(row.id) ?? []);
        const fallbackPickMeta = pickBestCatalogProductFallbackOfferPrice(catalogByProduct.get(row.id) ?? []);
        const savedMergedMeta = extractListPriceFromCatalog(mergedAmazonRaw);
        mergePimPriceEnrichmentMeta(prevMeta, {
          last_attempt_at: new Date().toISOString(),
          primary_asin: primaryAsinUpper,
          alternate_asins_tried: orderedAsins.filter((a) => a !== primaryAsinUpper),
          pricing_asin_used: offerAsinFor,
          pricing_marketplace_used: offersPricingMarketplaceUsed,
          pricing_trials: pricingTrials,
          pricing_http: offersHttpStatus,
          pricing_outcome: offersDetail,
          marketplace_id: offersPricingMarketplaceUsed ?? pricingMarketplaceId ?? null,
          inserted_sources: insertedSourcesOk,
          api_price_disambiguation: apiDisambig,
          missing_price_reason:
            priceInsertedThis > 0
              ? null
              : summarizeMissingPriceReason({
                  pricingMarketplaceConfigured: pricingMarketplaceOrder.length > 0,
                  catalogHttp: 200,
                  catalogFailed: false,
                  pricingTrials,
                  pricingDetail: offersDetail,
                  hadLiveListPrice: Boolean(listPriceCatalog && listPriceCatalog.amount > 0),
                  hadSavedRawList: Boolean(savedMergedMeta && savedMergedMeta.amount > 0),
                  hadListingExportPrice: Boolean(listingPickMeta && listingPickMeta.amount > 0),
                  hadOfferLikeFallback:
                    (catalogByProduct.get(row.id) ?? []).length > 0
                      ? Boolean(fallbackPickMeta && fallbackPickMeta.amount > 0)
                      : undefined,
                }),
        });
        const { error: metaPriceUErr } = await maybeUpdateProductRow(
          dryRun,
          { metadata: prevMeta },
          row.id,
          organizationId,
          storeId,
        );
        if (metaPriceUErr) {
          failures.push({
            product_id: row.id,
            reason: `metadata (pim_price_enrichment) update failed: ${metaPriceUErr.message}`,
          });
        }

        const scalarOrPrice = didImage || didTitle || didBrand || didCategory || priceInsertedThis > 0;
        if (!scalarOrPrice && amazonRawChanged) catalog_only_refresh += 1;

        if (priceInsertedThis === 0 && priceCandThis === 0 && offersOutcome !== "permission") {
          price_skipped_no_match += 1;
        }

        if (!String(patch.category_id ?? row.category_id ?? "").trim()) {
          still_missing_category += 1;
        }
        const finalMainUrl = patch.main_image_url ?? row.main_image_url;
        if (isMissingMainImage(finalMainUrl)) {
          still_missing_image += 1;
        }

        if (allowEnrichmentDebug) {
          const listCand =
            listPriceCatalog && listPriceCatalog.amount > 0
              ? `${listPriceCatalog.amount} ${listPriceCatalog.currency}`
              : "—";
          const offCand =
            offersPrice && offersPrice.amount > 0 ? `${offersPrice.amount} ${offersPrice.currency}` : "—";
          let priceInsertLabel = "no insert";
          if (priceInsertedThis > 0) priceInsertLabel = "inserted ≥1 row";
          else if (priceCandThis > 0) priceInsertLabel = "candidates only (duplicate window or db error)";
          enrichmentDebug.push({
            product_id: row.id,
            asin,
            marketplace_id: pricingMarketplaceId || null,
            pricing_endpoint: "/products/pricing/v0/items/{asin}/offers",
            pricing_http: offersHttpStatus,
            pricing_outcome: offersDetail,
            catalog_http: 200,
            catalog_detail: "ok",
            list_price_candidate: listCand,
            offers_price_candidate: offCand,
            price_insert: priceInsertLabel,
            category_status: didCategory ? "updated" : needCat0 ? "unchanged" : "already_set",
            image_status: didImage ? "updated" : needImg0 ? "still_missing" : "already_set",
          });
        }
      }

    if (i + 1 < toProcess.length) {
      let tail = DELAY_MS;
      if (offersDetail === "throttled") tail += 1400;
      if (catalogRateLimited) tail += 900;
      await sleep(tail);
    }
  }

  const would_update_count = dryRun ? rows_saved + prices_inserted : rows_saved + prices_inserted;
  const would_skip_count = dryRun
    ? Math.max(0, toProcess.length - would_update_count - failed - skipped_no_asin)
    : 0;
  const missing_data_count = dryRun
    ? catalog_not_found_count +
      still_missing_category +
      still_missing_image +
      pricing_api_not_available +
      no_match
    : 0;

  return {
    ok: true,
    ...(continuation ? { continuation } : {}),
    metrics: {
      scanned,
      start_index: startIndex,
      batch_size: toProcess.length,
      with_asin,
      with_fnsku,
      with_sku,
      with_name,
      enriched_images,
      enriched_brand,
      enriched_title,
      enriched_category: categories_updated,
      enriched_prices: prices_inserted,
      categories_updated,
      category_candidates_found,
      category_skipped_low_confidence,
      price_candidates_found,
      prices_inserted,
      pricing_api_not_available,
      pricing_permission_missing,
      price_skipped_no_match,
      products_with_existing_price,
      category_retry_attempted,
      category_retry_success,
      image_retry_attempted,
      image_retry_success,
      fnsku_map_asin_mismatch_skipped,
      suspicious_image_overwritten,
      still_missing_category,
      still_missing_image,
      rows_saved,
      catalog_snapshots_saved: rows_saved,
      catalog_only_refresh,
      no_match,
      skipped_no_asin,
      skipped_no_image_found,
      failed,
      enriched: enriched_images + enriched_title + enriched_brand + categories_updated,
      throttled_count,
      retry_count,
      deferred_count,
      pricing_invalid_marketplace_count,
      pricing_asin_not_found_count,
      pricing_no_offer_data_count,
      pricing_endpoint_not_configured_count,
      pricing_throttled_count,
      price_insert_skipped_duplicate,
      price_insert_db_errors,
      catalog_not_found_count,
      price_from_alternate_asin,
      price_from_saved_amazon_raw,
      price_from_catalog_products_listing,
      price_from_catalog_products_fallback_offer,
      api_price_ai_disambiguations,
      retry_missing_prices_only: retryMissingPrices,
      prioritize_incomplete: prioritizeIncomplete,
      force_fresh_price_rows: forceFreshPriceRows,
      ...(dryRun
        ? {
            dry_run: true,
            would_update_count,
            would_skip_count,
            missing_data_count,
          }
        : {}),
    },
    failures,
    failed_product_ids: failures.map((f) => f.product_id),
    ...(allowEnrichmentDebug ? { enrichment_debug: enrichmentDebug } : {}),
  };
}
