/**
 * Phase 10 — catalog / manual product text search classification.
 * Identifier-shaped queries use exact eq; title queries use name-only ilike (RPC uses pg_trgm).
 */
import { classifyProductBarcode, type ProductBarcodeKind } from "@/lib/product-barcode-classify";

export type CatalogSearchQueryKind = "upc" | "sku" | "fnsku" | "asin" | "title";

export type ClassifiedCatalogQuery = {
  kind: CatalogSearchQueryKind;
  normalized: string;
  barcodeKind: ProductBarcodeKind;
};

const RE_ASIN = /^B0[A-Z0-9]{8}$/i;
const RE_FNSKU = /^X0[A-Z0-9]{8}$/i;
const RE_UPC = /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/;

/** Classify free-text catalog search input (PIM grid q, operator override search). */
export function classifyCatalogSearchQuery(raw: string): ClassifiedCatalogQuery {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { kind: "title", normalized: "", barcodeKind: "unknown" };
  }

  const barcode = classifyProductBarcode(trimmed);
  if (barcode.kind === "upc_ean") {
    return { kind: "upc", normalized: barcode.normalized, barcodeKind: barcode.kind };
  }
  if (barcode.kind === "asin") {
    return { kind: "asin", normalized: barcode.normalized, barcodeKind: barcode.kind };
  }
  if (barcode.kind === "fnsku") {
    return { kind: "fnsku", normalized: barcode.normalized, barcodeKind: barcode.kind };
  }
  if (barcode.kind === "sku_msku") {
    return { kind: "sku", normalized: barcode.normalized, barcodeKind: barcode.kind };
  }

  const upper = trimmed.toUpperCase().replace(/\s+/g, "");
  if (RE_UPC.test(trimmed.replace(/\D/g, ""))) {
    return { kind: "upc", normalized: trimmed.replace(/\D/g, ""), barcodeKind: "upc_ean" };
  }
  if (RE_ASIN.test(upper)) return { kind: "asin", normalized: upper, barcodeKind: "asin" };
  if (RE_FNSKU.test(upper)) return { kind: "fnsku", normalized: upper, barcodeKind: "fnsku" };

  return { kind: "title", normalized: trimmed, barcodeKind: "unknown" };
}

export function isIdentifierCatalogQuery(kind: CatalogSearchQueryKind): boolean {
  return kind !== "title";
}

/** Escape LIKE/ILIKE pattern for PostgREST `.or()` filters. */
export function catalogIlikePattern(q: string): string {
  return `%${q.replace(/%/g, "").replace(/_/g, "")}%`;
}
