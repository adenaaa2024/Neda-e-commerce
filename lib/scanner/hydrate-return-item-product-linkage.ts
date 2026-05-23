import type { SupabaseClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "@/app/returns/returns-constants";
import { isUuidString } from "@/lib/uuid";
import {
  buildProductLinkageDisplayContract,
  fetchProductNamesByResolvedIds,
  type ProductLinkageDisplayContract,
  type ProductLinkageSourceRow,
  type ProductsLookupClient,
} from "@/lib/scanner/product-linkage-display-contract";
import type { ResolveProductForScannerItemResult } from "@/lib/scanner/resolve-product-for-scanner-item";

const RETURN_LINKAGE_ROW_SELECT = `id, organization_id, store_id, item_name, fnsku, sku, product_identifier, asin, ${RETURN_SCANNER_LINKAGE_SELECT}`;

export type ReturnItemLinkageRow = ProductLinkageSourceRow & {
  id?: string;
  organization_id?: string | null;
  store_id?: string | null;
  asin?: string | null;
};

export function buildProductLinkageFromResolveResult(
  source: ProductLinkageSourceRow,
  res: ResolveProductForScannerItemResult,
  productNameById: ReadonlyMap<string, string>,
): ProductLinkageDisplayContract {
  return buildProductLinkageDisplayContract(
    {
      ...source,
      resolved_product_id: res.resolved_product_id,
      identifier_resolution_status: res.status,
      identifier_resolution_confidence: res.confidence,
    },
    productNameById,
  );
}

export async function hydrateReturnItemProductLinkage(
  supabase: SupabaseClient,
  returnItemId: string,
  organizationId?: string | null,
): Promise<{ linkage: ProductLinkageDisplayContract | null; row: ReturnItemLinkageRow | null }> {
  const rid = String(returnItemId ?? "").trim();
  if (!isUuidString(rid)) return { linkage: null, row: null };

  let q = supabase.from(RETURN_ITEMS_TABLE).select(RETURN_LINKAGE_ROW_SELECT).eq("id", rid);
  const org = String(organizationId ?? "").trim();
  if (org && isUuidString(org)) q = q.eq("organization_id", org);

  const { data, error } = await q.maybeSingle();
  if (error || !data || typeof data !== "object") {
    return { linkage: null, row: null };
  }

  const row = data as ReturnItemLinkageRow;
  const resolvedId =
    typeof row.resolved_product_id === "string" && isUuidString(row.resolved_product_id.trim())
      ? row.resolved_product_id.trim()
      : null;
  const productNameById = await fetchProductNamesByResolvedIds(
    supabase as unknown as ProductsLookupClient,
    resolvedId ? [resolvedId] : [],
  );
  return {
    linkage: buildProductLinkageDisplayContract(row, productNameById),
    row,
  };
}
