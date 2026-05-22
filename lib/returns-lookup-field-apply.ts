/**
 * Apply product-input lookup fields to Returns UI forms (V196).
 */

import { classifyProductBarcode } from "./product-barcode-classify";

export type LookupFieldsLike = {
  item_name?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  upc?: string | null;
  product_identifier?: string | null;
  normalized_input?: string;
};

export type ProductLinkageHeadlineLike = {
  product_name?: string | null;
  fallback_display_name?: string | null;
};

/** Canonical display name for item_name when a product resolves. */
export function canonicalItemNameFromLookup(
  fields: LookupFieldsLike,
  linkage?: ProductLinkageHeadlineLike | null,
): string | null {
  const fromFields = fields.item_name?.trim();
  if (fromFields) return fromFields;
  const fromLinkage =
    linkage?.product_name?.trim() ?? linkage?.fallback_display_name?.trim() ?? null;
  return fromLinkage || null;
}

export function upcFromProductIdentifier(productIdentifier: string | null | undefined): string {
  const raw = productIdentifier?.trim() ?? "";
  if (!raw) return "";
  const c = classifyProductBarcode(raw);
  return c.kind === "upc_ean" ? c.normalized : "";
}

export function primaryScanFromLookup(fields: LookupFieldsLike): string {
  return (
    fields.product_identifier?.trim() ||
    fields.normalized_input?.trim() ||
    fields.fnsku?.trim() ||
    fields.asin?.trim() ||
    fields.sku?.trim() ||
    fields.upc?.trim() ||
    ""
  );
}
