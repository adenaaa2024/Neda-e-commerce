/**
 * ProductLinkageDisplayContract — server-built display shape for scanner slip / return-item rows.
 * Neda operator-mobile consumes this from server actions only (no client catalog queries).
 */

export type ProductLinkageDisplayContract = {
  /** Catalog `products.product_name` when `resolved_product_id` is set. */
  product_name: string | null;
  /** `products.id` when linkage resolved (display-only; server-sourced). */
  resolved_product_id: string | null;
  /** `resolved` | `unresolved` | `ambiguous` (lowercase when present). */
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
  /** Slip description, identifiers, or item_name when catalog name is absent. */
  fallback_display_name: string;
};

export type ProductLinkageSourceRow = {
  resolved_product_id?: string | null;
  identifier_resolution_status?: string | null;
  identifier_resolution_confidence?: number | null;
  description?: string | null;
  fnsku?: string | null;
  upc?: string | null;
  sku?: string | null;
  product_identifier?: string | null;
  item_name?: string | null;
};

function trimOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function normStatus(v: unknown): string | null {
  const s = trimOrNull(v);
  return s ? s.toLowerCase() : null;
}

function normConfidence(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/** Identifier / slip text label when catalog `product_name` is missing. */
export function buildProductLinkageFallbackName(row: ProductLinkageSourceRow): string {
  const desc = trimOrNull(row.description);
  if (desc) return desc;
  const item = trimOrNull(row.item_name);
  if (item) return item;
  const parts = [trimOrNull(row.fnsku), trimOrNull(row.upc), trimOrNull(row.sku), trimOrNull(row.product_identifier)].filter(
    Boolean,
  ) as string[];
  if (parts.length) return parts.join(" · ");
  return "Line item";
}

export function buildProductLinkageDisplayContract(
  row: ProductLinkageSourceRow,
  productNameById: ReadonlyMap<string, string>,
): ProductLinkageDisplayContract {
  const resolvedId = trimOrNull(row.resolved_product_id);
  const catalogName = resolvedId ? productNameById.get(resolvedId) ?? null : null;
  return {
    product_name: catalogName,
    resolved_product_id: resolvedId,
    identifier_resolution_status: normStatus(row.identifier_resolution_status),
    identifier_resolution_confidence: normConfidence(row.identifier_resolution_confidence),
    fallback_display_name: buildProductLinkageFallbackName(row),
  };
}

export function productLinkageIsUnresolved(linkage: ProductLinkageDisplayContract): boolean {
  const st = linkage.identifier_resolution_status;
  return st === "unresolved" || st === "ambiguous";
}

export function productLinkageIsAmbiguous(linkage: ProductLinkageDisplayContract): boolean {
  return linkage.identifier_resolution_status === "ambiguous";
}

/** Operator copy: unmapped catalog line (not ambiguous — that uses "Needs review"). */
export function productLinkageShowsUnmappedLabel(linkage: ProductLinkageDisplayContract): boolean {
  if (productLinkageIsAmbiguous(linkage)) return false;
  if (linkage.identifier_resolution_status === "resolved" && linkage.product_name?.trim()) return false;
  return productLinkageNoCatalogProduct(linkage);
}

export const PRODUCT_LINKAGE_UNMAPPED_LABEL = "No product link yet";
export const PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL = "Needs review";

export function productLinkageNoCatalogProduct(linkage: ProductLinkageDisplayContract): boolean {
  return !linkage.product_name?.trim();
}

/** Primary line for operator slip cards: catalog name, else fallback. */
export function productLinkagePrimaryLabel(linkage: ProductLinkageDisplayContract): string {
  return linkage.product_name?.trim() || linkage.fallback_display_name.trim() || "Line item";
}

/** Optional confidence suffix for resolved rows (0–100%). */
export function formatProductLinkageConfidencePct(confidence: number | null | undefined): string | null {
  if (confidence === null || confidence === undefined) return null;
  const n = Number(confidence);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n * 100)}%`;
}

/** Minimal products lookup — avoids deep Supabase generic instantiation in server actions. */
export type ProductsLookupClient = {
  from: (table: string) => {
    select: (cols: string) => {
      in: (col: string, ids: string[]) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
};

export async function fetchProductNamesByResolvedIds(
  supabase: ProductsLookupClient,
  productIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(productIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return out;

  const chunkSize = 80;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const primary = await supabase.from("products").select("id, product_name, name").in("id", chunk);
    let res = primary;
    if (primary.error) {
      res = await supabase.from("products").select("id, name").in("id", chunk);
    }
    if (res.error) break;
    const rows = Array.isArray(res.data) ? res.data : [];
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      const id = trimOrNull(r.id);
      const nm = trimOrNull(r.product_name) ?? trimOrNull(r.name);
      if (id && nm) out.set(id, nm);
    }
  }
  return out;
}
