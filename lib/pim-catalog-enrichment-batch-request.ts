import { isUuidString } from "./uuid";

export const PIM_CATALOG_ENRICHMENT_MAX_PER_RUN = 80;
export const PIM_CATALOG_ENRICHMENT_DELAY_MS = 220;

export type PimCatalogEnrichmentRequestBody = {
  organization_id?: string;
  store_id?: string;
  limit?: number;
  start_index?: number;
  prioritize_incomplete?: boolean;
  force_fresh_price_rows?: boolean;
  retry_failed_only?: boolean;
  retry_missing_prices_only?: boolean;
  product_ids?: string[];
  include_enrichment_debug?: boolean;
  allow_suspicious_image_overwrite?: boolean;
};

export type PimCatalogEnrichmentBatchParams = {
  organizationId: string;
  storeId: string;
  limit: number;
  startIndex: number;
  prioritizeIncomplete: boolean;
  forceFreshPriceRows: boolean;
  retryOnly: boolean;
  retryMissingPrices: boolean;
  retryIds: string[];
  allowEnrichmentDebug: boolean;
  allowSuspiciousImageOverwrite: boolean;
};

export type PimCatalogEnrichmentBatchError = { ok: false; error: string; status: number };

export type PimCatalogEnrichmentFailureRow = { product_id: string; reason: string };

export type PimCatalogEnrichmentDebugRow = {
  product_id: string;
  asin: string;
  marketplace_id: string | null;
  pricing_endpoint: string;
  pricing_http: number | null;
  pricing_outcome: string;
  catalog_http: number | null;
  catalog_detail: string;
  list_price_candidate: string;
  offers_price_candidate: string;
  price_insert: string;
  category_status: string;
  image_status: string;
};

export type PimCatalogEnrichmentBatchSuccess = {
  ok: true;
  continuation?: { next_start_index: number; total_eligible: number };
  metrics: Record<string, unknown>;
  failures: PimCatalogEnrichmentFailureRow[];
  failed_product_ids: string[];
  enrichment_debug?: PimCatalogEnrichmentDebugRow[];
};

export type PimCatalogEnrichmentBatchResult = PimCatalogEnrichmentBatchSuccess | PimCatalogEnrichmentBatchError;

export function parsePimCatalogEnrichmentBatchParams(
  body: PimCatalogEnrichmentRequestBody,
): PimCatalogEnrichmentBatchParams {
  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  const limit = Math.min(
    PIM_CATALOG_ENRICHMENT_MAX_PER_RUN,
    Math.max(1, Number(body.limit ?? PIM_CATALOG_ENRICHMENT_MAX_PER_RUN) || PIM_CATALOG_ENRICHMENT_MAX_PER_RUN),
  );
  const startIndexRaw = Number(body.start_index ?? 0);
  const startIndex = Number.isFinite(startIndexRaw) ? Math.max(0, Math.floor(startIndexRaw)) : 0;
  const retryIds = Array.isArray(body.product_ids)
    ? body.product_ids.map((x) => String(x).trim()).filter((x) => isUuidString(x))
    : [];
  return {
    organizationId,
    storeId,
    limit,
    startIndex,
    prioritizeIncomplete: Boolean(body.prioritize_incomplete),
    forceFreshPriceRows: Boolean(body.force_fresh_price_rows),
    retryOnly: Boolean(body.retry_failed_only),
    retryMissingPrices: Boolean(body.retry_missing_prices_only),
    retryIds,
    allowEnrichmentDebug: Boolean(body.include_enrichment_debug),
    allowSuspiciousImageOverwrite: Boolean(body.allow_suspicious_image_overwrite),
  };
}

export function validatePimCatalogEnrichmentBatchParams(
  params: PimCatalogEnrichmentBatchParams,
): PimCatalogEnrichmentBatchError | null {
  if (params.retryMissingPrices && params.retryOnly) {
    return {
      ok: false,
      error: "Use either retry_missing_prices_only or retry_failed_only, not both.",
      status: 400,
    };
  }
  if (!isUuidString(params.organizationId)) {
    return { ok: false, error: "organization_id must be a UUID.", status: 400 };
  }
  if (!isUuidString(params.storeId)) {
    return { ok: false, error: "store_id must be a UUID.", status: 400 };
  }
  if (params.retryOnly && params.retryIds.length === 0) {
    return {
      ok: false,
      error: "retry_failed_only requires product_ids from the last run.",
      status: 400,
    };
  }
  if (params.retryMissingPrices && params.retryIds.length > 0) {
    return {
      ok: false,
      error: "retry_missing_prices_only does not use product_ids; omit that field.",
      status: 400,
    };
  }
  return null;
}

/** Metric keys in enrich-images success responses (PimCatalogHub batch loop). */
export const PIM_CATALOG_ENRICHMENT_METRIC_KEYS = [
  "scanned",
  "start_index",
  "batch_size",
  "with_asin",
  "with_fnsku",
  "with_sku",
  "with_name",
  "enriched_images",
  "enriched_brand",
  "enriched_title",
  "enriched_category",
  "enriched_prices",
  "categories_updated",
  "category_candidates_found",
  "category_skipped_low_confidence",
  "price_candidates_found",
  "prices_inserted",
  "pricing_api_not_available",
  "pricing_permission_missing",
  "price_skipped_no_match",
  "products_with_existing_price",
  "category_retry_attempted",
  "category_retry_success",
  "image_retry_attempted",
  "image_retry_success",
  "still_missing_category",
  "still_missing_image",
  "rows_saved",
  "catalog_snapshots_saved",
  "catalog_only_refresh",
  "no_match",
  "skipped_no_asin",
  "skipped_no_image_found",
  "failed",
  "enriched",
  "throttled_count",
  "retry_count",
  "deferred_count",
  "pricing_invalid_marketplace_count",
  "pricing_asin_not_found_count",
  "pricing_no_offer_data_count",
  "pricing_endpoint_not_configured_count",
  "pricing_throttled_count",
  "price_insert_skipped_duplicate",
  "price_insert_db_errors",
  "catalog_not_found_count",
  "price_from_alternate_asin",
  "price_from_saved_amazon_raw",
  "price_from_catalog_products_listing",
  "price_from_catalog_products_fallback_offer",
  "api_price_ai_disambiguations",
  "retry_missing_prices_only",
  "prioritize_incomplete",
  "force_fresh_price_rows",
] as const;
