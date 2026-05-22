/**
 * User-facing labels for PIM product category / price provenance (API + UI).
 */

export function derivePimCategorySourceLabel(product: Record<string, unknown>): string {
  const meta = product.metadata;
  const m =
    meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as unknown as Record<string, unknown>) : {};
  const src = String(m.pim_category_source ?? "").trim();
  if (src === "manual") return "manual";
  if (src === "ai_assisted") return "AI-assisted selection";
  if (src === "amazon_browse") return "Amazon browse classification";
  if (src === "amazon_product_type") return "Amazon product type";
  if (src === "amazon_attributes") return "Amazon attributes";
  const fp = m.pim_field_provenance;
  const catProv =
    fp && typeof fp === "object" && !Array.isArray(fp)
      ? (fp as unknown as Record<string, unknown>).category_id
      : null;
  if (
    catProv &&
    typeof catProv === "object" &&
    !Array.isArray(catProv) &&
    String((catProv as unknown as Record<string, unknown>).source ?? "") === "amazon_catalog_enrichment"
  ) {
    return "Amazon enrichment";
  }
  if (String(product.category_id ?? "").trim()) return "imported";
  return "—";
}

function readPriceRowMeta(row: Record<string, unknown>): Record<string, unknown> {
  const m = row.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as unknown as Record<string, unknown>) : {};
}

/**
 * Human-readable label for the latest `product_prices` row (metadata from enrichment).
 */
export function derivePimPriceOriginLabel(latestRow: Record<string, unknown> | null): string | null {
  if (!latestRow) return null;
  const s = String(latestRow.source ?? "").trim().toLowerCase();
  if (s !== "amazon_enrichment") return "manual/imported";

  const meta = readPriceRowMeta(latestRow);
  const ps = String(meta.price_source ?? "").trim();
  const tier = String(meta.pricing_api_tier ?? "").trim();
  if (ps === "pricing_api") {
    if (tier === "featured_offer") return "Amazon Product Pricing API (featured offer)";
    if (tier === "buy_box") return "Amazon Product Pricing API (Buy Box)";
    if (tier === "lowest_landed") return "Amazon Product Pricing API (lowest landed)";
    return "Amazon Product Pricing API";
  }
  if (ps === "catalog_listing") {
    const from = String(meta.from ?? "").trim();
    if (from === "catalog_items_api") return "Amazon Catalog API (list/listing price)";
    if (from === "saved_amazon_raw_catalog") return "Saved Amazon catalog JSON (list price)";
    if (from === "catalog_products_listing") return "Imported listing row (catalog_products price)";
    return "Listing / catalog export";
  }
  if (ps === "fallback_offer") return "Imported listing row (offer-style fields in raw_payload)";
  return "Amazon enrichment";
}
