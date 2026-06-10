/**
 * Phase 6F — product grain matching across slip, shipment expected, and operator scans.
 * Match priority: resolved_product_id → FNSKU → ASIN+SKU → ASIN → SKU → UPC/GTIN → title (low confidence).
 */

export type ProductGrain = {
  resolved_product_id: string | null;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  upc: string | null;
  gtin: string | null;
  title: string | null;
};

export type ProductGrainConfidence =
  | "resolved_product_id"
  | "fnsku"
  | "asin_sku"
  | "asin"
  | "sku"
  | "upc_gtin"
  | "title_low"
  | "unresolved";

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

function cell(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

export function productGrainConfidence(grain: ProductGrain): ProductGrainConfidence {
  if (grain.resolved_product_id) return "resolved_product_id";
  if (grain.fnsku) return "fnsku";
  if (grain.asin && grain.sku) return "asin_sku";
  if (grain.asin) return "asin";
  if (grain.sku) return "sku";
  if (grain.upc || grain.gtin) return "upc_gtin";
  if (grain.title) return "title_low";
  return "unresolved";
}

/** Stable aggregation key for slip / EP / scan lines at the same product grain. */
export function productGrainKey(grain: ProductGrain): string | null {
  if (grain.resolved_product_id) return `pid:${grain.resolved_product_id}`;
  if (grain.fnsku) return `fnsku:${norm(grain.fnsku)}`;
  if (grain.asin && grain.sku) return `asin+sku:${norm(grain.asin)}:${norm(grain.sku)}`;
  if (grain.asin) return `asin:${norm(grain.asin)}`;
  if (grain.sku) return `sku:${norm(grain.sku)}`;
  const upc = grain.upc ?? grain.gtin;
  if (upc) return `upc:${norm(upc)}`;
  if (grain.title) return `title:${norm(grain.title).slice(0, 48)}`;
  return null;
}

/** Whether two grains refer to the same product at the highest shared tier. */
export function productGrainsMatch(a: ProductGrain, b: ProductGrain): boolean {
  const ka = productGrainKey(a);
  const kb = productGrainKey(b);
  if (ka && kb && ka === kb) return true;
  if (a.resolved_product_id && b.resolved_product_id && a.resolved_product_id === b.resolved_product_id) {
    return true;
  }
  if (a.fnsku && b.fnsku && norm(a.fnsku) === norm(b.fnsku)) return true;
  if (a.asin && b.asin && a.sku && b.sku && norm(a.asin) === norm(b.asin) && norm(a.sku) === norm(b.sku)) {
    return true;
  }
  if (a.asin && b.asin && norm(a.asin) === norm(b.asin) && (!a.sku || !b.sku)) return true;
  if (a.sku && b.sku && norm(a.sku) === norm(b.sku) && (!a.asin || !b.asin)) return true;
  const aUpc = a.upc ?? a.gtin;
  const bUpc = b.upc ?? b.gtin;
  if (aUpc && bUpc && norm(aUpc) === norm(bUpc)) return true;
  return false;
}

export function slipRowToProductGrain(raw: Record<string, unknown>): ProductGrain {
  return {
    resolved_product_id: cell(raw.resolved_product_id),
    fnsku: cell(raw.fnsku ?? raw.parsed_fnsku),
    asin: cell(raw.parsed_asin ?? raw.asin),
    sku: cell(raw.parsed_sku ?? raw.sku),
    upc: cell(raw.upc ?? raw.parsed_upc),
    gtin: cell(raw.gtin ?? raw.parsed_gtin),
    title: cell(raw.description ?? raw.ocr_product_name ?? raw.item_name),
  };
}

export function expectedPackageRowToProductGrain(raw: Record<string, unknown>): ProductGrain {
  const products = raw.products as { product_name?: string } | null | undefined;
  return {
    resolved_product_id: cell(raw.resolved_product_id ?? raw.expected_product_id ?? raw.product_id),
    fnsku: cell(raw.fnsku),
    asin: cell(raw.asin),
    sku: cell(raw.sku),
    upc: null,
    gtin: null,
    title: cell(products?.product_name ?? raw.product_name ?? raw.item_name),
  };
}

export function returnItemRowToProductGrain(raw: Record<string, unknown>): ProductGrain {
  return {
    resolved_product_id: cell(raw.resolved_product_id),
    fnsku: cell(raw.fnsku),
    asin: cell(raw.asin),
    sku: cell(raw.sku),
    upc: cell(raw.product_identifier ?? raw.upc_code ?? raw.barcode),
    gtin: cell(raw.gtin),
    title: cell(raw.item_name ?? raw.product_name),
  };
}
