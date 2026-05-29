import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuidString } from "@/lib/uuid";

/**
 * Deterministic scanner product resolution — no OCR/title-only matches,
 * no product creation, no Amazon/OpenAI calls.
 */
export type ResolveProductForScannerItemInput = {
  organization_id: string;
  store_id: string | null;
  /** @deprecated Use `expected_package_id`. Kept for callers still passing EP id under the old name. */
  expected_item_id?: string | null;
  /** `expected_packages.id` — not used for EP product columns (live DB has no linkage on EP). */
  expected_package_id?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  msku?: string | null;
  sku?: string | null;
  upc?: string | null;
  ocr_product_name?: string | null;
  raw_text?: string | null;
  source_table?: string | null;
  source_row_id?: string | null;
};

export type ResolveProductForScannerItemResult = {
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  status: "resolved" | "ambiguous" | "unresolved";
  confidence: number;
  matched_via: string;
  review_required: boolean;
  meta: Record<string, unknown>;
};

function trimOrNull(v: string | null | undefined): string | null {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
}

function distinctProductIdsFromMapRows(rows: { product_id?: string | null }[] | null | undefined): string[] {
  const set = new Set<string>();
  for (const r of rows ?? []) {
    const id = String(r?.product_id ?? "").trim();
    if (isUuidString(id)) set.add(id);
  }
  return [...set];
}

function firstCatalogId(rows: Record<string, unknown>[]): string | null {
  for (const r of rows) {
    const c = trimOrNull(String(r.catalog_product_id ?? ""));
    if (c && isUuidString(c)) return c;
  }
  return null;
}

type MapColumn = "fnsku" | "seller_sku" | "msku" | "upc_code" | "asin";

/**
 * Resolution order (live DB — linkage on `return_items` / `slip_contents`, not `expected_packages`):
 * 1) product_identifier_map — exact FNSKU
 * 2) product_identifier_map — exact SKU (seller_sku / msku)
 * 3) product_identifier_map — exact UPC
 * 4) product_identifier_map — exact ASIN
 * 5) direct `products` row (org + store) — fnsku, sku, upc_code/barcode, asin when unique
 * Multiple distinct product_ids at a tier → ambiguous (needs review, no auto-link).
 */
export async function resolveProductForScannerItem(
  supabase: SupabaseClient,
  input: ResolveProductForScannerItemInput,
): Promise<ResolveProductForScannerItemResult> {
  const org = String(input.organization_id ?? "").trim();
  const store = trimOrNull(input.store_id);
  const meta: Record<string, unknown> = {
    source_table: input.source_table ?? null,
    source_row_id: input.source_row_id ?? null,
  };

  const empty = (): ResolveProductForScannerItemResult => ({
    resolved_product_id: null,
    resolved_catalog_product_id: null,
    status: "unresolved",
    confidence: 0,
    matched_via: "none",
    review_required: false,
    meta,
  });

  if (!isUuidString(org)) return empty();

  const epHint =
    trimOrNull(input.expected_package_id) ?? trimOrNull(input.expected_item_id);
  if (epHint && isUuidString(epHint)) {
    meta.expected_packages_id = epHint;
  }

  const fnsku = trimOrNull(input.fnsku);
  const asin = trimOrNull(input.asin);
  const sku = trimOrNull(input.sku) ?? trimOrNull(input.msku);
  const upc = trimOrNull(input.upc);

  const mapSelect = "product_id, catalog_product_id, fnsku, asin, seller_sku";

  const applyStoreScope = <T extends { or: (s: string) => T }>(q: T): T => {
    if (store && isUuidString(store)) {
      return q.or(`store_id.eq.${store},store_id.is.null`);
    }
    return q;
  };

  const fromMap = async (
    column: MapColumn,
    value: string,
    matchedVia: string,
    confidence: number,
    reviewRequired = false,
  ): Promise<ResolveProductForScannerItemResult | null> => {
    let q = supabase
      .from("product_identifier_map")
      .select(mapSelect)
      .eq("organization_id", org)
      .eq(column, value);
    q = applyStoreScope(q);
    const { data: rows, error } = await q.limit(40);
    if (error) {
      meta[`map_${column}_error`] = error.message;
      return null;
    }
    const safe = (rows ?? []) as Record<string, unknown>[];
    const ids = distinctProductIdsFromMapRows(safe as { product_id?: string | null }[]);
    if (ids.length === 1) {
      return {
        resolved_product_id: ids[0]!,
        resolved_catalog_product_id: firstCatalogId(safe),
        status: "resolved",
        confidence,
        matched_via: matchedVia,
        review_required: reviewRequired,
        meta: { ...meta, map_hit: column },
      };
    }
    if (ids.length > 1) {
      return {
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        status: "ambiguous",
        confidence: 0.4,
        matched_via: matchedVia,
        review_required: true,
        meta: { ...meta, candidate_product_ids: ids },
      };
    }
    return null;
  };

  const fromProducts = async (
    column: "fnsku" | "sku" | "asin" | "upc_code" | "barcode",
    value: string,
    matchedVia: string,
    confidence: number,
    extraAsin?: string | null,
  ): Promise<ResolveProductForScannerItemResult | null> => {
    if (!store || !isUuidString(store)) return null;
    let q = supabase
      .from("products")
      .select("id")
      .eq("organization_id", org)
      .eq("store_id", store)
      .eq(column, value)
      .limit(10);
    const asinFilter = trimOrNull(extraAsin);
    if (asinFilter) q = q.eq("asin", asinFilter);
    const { data: pr, error: pErr } = await q;
    if (pErr) {
      meta[`products_${column}_error`] = pErr.message;
      return null;
    }
    const ids = [
      ...new Set(
        (pr ?? [])
          .map((r) => String((r as { id?: string }).id ?? "").trim())
          .filter((id) => isUuidString(id)),
      ),
    ];
    if (ids.length === 1) {
      return {
        resolved_product_id: ids[0]!,
        resolved_catalog_product_id: null,
        status: "resolved",
        confidence,
        matched_via: matchedVia,
        review_required: false,
        meta: { ...meta, direct: column },
      };
    }
    if (ids.length > 1) {
      return {
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        status: "ambiguous",
        confidence: 0.25,
        matched_via: matchedVia,
        review_required: true,
        meta: { ...meta, note: `multiple_products_same_${column}` },
      };
    }
    return null;
  };

  if (fnsku) {
    const hit =
      (await fromMap("fnsku", fnsku, "product_identifier_map.fnsku", 0.95)) ??
      (await fromProducts("fnsku", fnsku, "products.fnsku", 0.9));
    if (hit) return hit;
  }

  if (sku) {
    const skuMap =
      (await fromMap("seller_sku", sku, "product_identifier_map.seller_sku", 0.9)) ??
      (await fromMap("msku", sku, "product_identifier_map.msku", 0.88));
    if (skuMap) return skuMap;
    const directSku = await fromProducts("sku", sku, "products.sku", 0.85, asin && sku ? asin : null);
    if (directSku) return directSku;
  }

  if (upc) {
    const upcMap = await fromMap("upc_code", upc, "product_identifier_map.upc", 0.85);
    if (upcMap) return upcMap;
    const upcDirect =
      (await fromProducts("upc_code", upc, "products.upc_code", 0.8)) ??
      (await fromProducts("barcode", upc, "products.barcode", 0.8));
    if (upcDirect) return upcDirect;
  }

  if (asin) {
    const asinMap = await fromMap("asin", asin, "product_identifier_map.asin", 0.8);
    if (asinMap) return asinMap;
    const asinDirect = await fromProducts("asin", asin, "products.asin", 0.75);
    if (asinDirect) return asinDirect;
  }

  if (trimOrNull(input.ocr_product_name) || trimOrNull(input.raw_text)) {
    meta.ocr_ignored = true;
  }

  return {
    resolved_product_id: null,
    resolved_catalog_product_id: null,
    status: "unresolved",
    confidence: 0,
    matched_via: "none",
    review_required: Boolean(fnsku || asin || sku || upc),
    meta,
  };
}
