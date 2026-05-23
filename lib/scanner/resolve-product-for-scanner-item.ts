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

/**
 * Resolution order (live DB — linkage on `return_items` / `slip_contents`, not `expected_packages`):
 * 1) product_identifier_map (FNSKU, then ASIN+SKU)
 * 2) UPC via map — multiple hits → ambiguous; single hit → resolved with review_required
 * 3) direct products row (org + store + sku) when unique
 * 4) catalog_products only when carried on a map row (catalog_product_id)
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

  if (fnsku) {
    let q = supabase
      .from("product_identifier_map")
      .select(mapSelect)
      .eq("organization_id", org)
      .eq("fnsku", fnsku);
    q = applyStoreScope(q);
    const { data: rows, error } = await q.limit(40);
    if (error) meta.map_fnsku_error = error.message;
    else {
      const safe = (rows ?? []) as Record<string, unknown>[];
      const ids = distinctProductIdsFromMapRows(safe as { product_id?: string | null }[]);
      if (ids.length === 1) {
        return {
          resolved_product_id: ids[0]!,
          resolved_catalog_product_id: firstCatalogId(safe),
          status: "resolved",
          confidence: 0.95,
          matched_via: "product_identifier_map.fnsku",
          review_required: false,
          meta: { ...meta, map_hit: "fnsku" },
        };
      }
      if (ids.length > 1) {
        return {
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          status: "ambiguous",
          confidence: 0.4,
          matched_via: "product_identifier_map.fnsku",
          review_required: true,
          meta: { ...meta, candidate_product_ids: ids },
        };
      }
    }
  }

  if (asin && sku) {
    let q = supabase
      .from("product_identifier_map")
      .select(mapSelect)
      .eq("organization_id", org)
      .eq("asin", asin)
      .eq("seller_sku", sku);
    q = applyStoreScope(q);
    const { data: rows, error } = await q.limit(40);
    if (error) meta.map_asin_sku_error = error.message;
    else {
      const safe = (rows ?? []) as Record<string, unknown>[];
      const ids = distinctProductIdsFromMapRows(safe as { product_id?: string | null }[]);
      if (ids.length === 1) {
        return {
          resolved_product_id: ids[0]!,
          resolved_catalog_product_id: firstCatalogId(safe),
          status: "resolved",
          confidence: 0.9,
          matched_via: "product_identifier_map.asin_seller_sku",
          review_required: false,
          meta: { ...meta, map_hit: "asin_seller_sku" },
        };
      }
      if (ids.length > 1) {
        return {
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          status: "ambiguous",
          confidence: 0.35,
          matched_via: "product_identifier_map.asin_seller_sku",
          review_required: true,
          meta: { ...meta, candidate_product_ids: ids },
        };
      }
    }
  }

  if (upc) {
    let q = supabase.from("product_identifier_map").select(mapSelect).eq("organization_id", org).eq("upc_code", upc);
    q = applyStoreScope(q);
    const { data: rows, error } = await q.limit(40);
    if (error) meta.map_upc_error = error.message;
    else {
      const safe = (rows ?? []) as Record<string, unknown>[];
      const ids = distinctProductIdsFromMapRows(safe as { product_id?: string | null }[]);
      if (ids.length > 1) {
        return {
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          status: "ambiguous",
          confidence: 0.2,
          matched_via: "product_identifier_map.upc",
          review_required: true,
          meta: { ...meta, candidate_product_ids: ids },
        };
      }
      if (ids.length === 1) {
        return {
          resolved_product_id: ids[0]!,
          resolved_catalog_product_id: firstCatalogId(safe),
          status: "resolved",
          confidence: 0.55,
          matched_via: "product_identifier_map.upc_unique",
          review_required: true,
          meta: { ...meta, map_hit: "upc", note: "upc_single_hit_requires_review" },
        };
      }
    }
  }

  if (sku && store && isUuidString(store)) {
    const { data: pr, error: pErr } = await supabase
      .from("products")
      .select("id")
      .eq("organization_id", org)
      .eq("store_id", store)
      .eq("sku", sku)
      .limit(3);
    if (!pErr && pr && pr.length === 1) {
      const id = String((pr[0] as { id: string }).id).trim();
      if (isUuidString(id)) {
        return {
          resolved_product_id: id,
          resolved_catalog_product_id: null,
          status: "resolved",
          confidence: 0.85,
          matched_via: "products.sku",
          review_required: false,
          meta: { ...meta, direct: "sku" },
        };
      }
    }
    if (!pErr && pr && pr.length > 1) {
      return {
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        status: "ambiguous",
        confidence: 0.25,
        matched_via: "products.sku",
        review_required: true,
        meta: { ...meta, note: "multiple_products_same_sku_store" },
      };
    }
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
