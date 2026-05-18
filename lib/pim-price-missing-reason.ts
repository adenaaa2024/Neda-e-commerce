/**
 * User-visible explanation when a product has no `product_prices` rows yet.
 */

export function readPimPriceEnrichmentFromMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const pe = (metadata as unknown as Record<string, unknown>).pim_price_enrichment;
  if (!pe || typeof pe !== "object" || Array.isArray(pe)) return null;
  return pe as unknown as Record<string, unknown>;
}

export function readPimPriceMissingReasonFromMetadata(metadata: unknown): string | null {
  const pe = readPimPriceEnrichmentFromMetadata(metadata);
  if (!pe) return null;
  const r = pe.missing_price_reason;
  return typeof r === "string" && r.trim() ? r.trim() : null;
}

export function legacyPricingOutcomeHint(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const ce = (metadata as unknown as Record<string, unknown>).pim_catalog_enrichment;
  if (!ce || typeof ce !== "object" || Array.isArray(ce)) return null;
  const o = (ce as unknown as Record<string, unknown>).pricing_outcome;
  return typeof o === "string" && o.trim() ? `Last Amazon pricing API outcome: ${o.trim()}.` : null;
}

/**
 * @param hasPriceRow — true when `product_prices` has at least one row for this product.
 */
export function derivePimPriceMissingReasonForProductDetail(params: {
  hasPriceRow: boolean;
  productMetadata: unknown;
}): string | null {
  if (params.hasPriceRow) return null;
  const direct = readPimPriceMissingReasonFromMetadata(params.productMetadata);
  if (direct) return direct;
  return legacyPricingOutcomeHint(params.productMetadata);
}
