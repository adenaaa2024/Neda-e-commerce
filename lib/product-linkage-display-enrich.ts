/**
 * Server-side batch enrichment for ProductLinkageDisplayContract (product_name from products).
 * Import from API routes and server modules — not a "use server" action file.
 */

import {
  mapRowToProductLinkageDisplayContract,
  type ProductLinkageDisplayContract,
} from "./product-linkage-display-contract";
import { supabaseServer } from "./supabase-server";
import { isUuidString } from "./uuid";

export type ProductLinkageDisplayInput = {
  source_table: string;
  source_row_id: string;
  row: Record<string, unknown>;
};

async function loadProductsById(
  organizationId: string,
  productIds: string[],
): Promise<Map<string, { name?: string | null; product_name?: string | null }>> {
  const out = new Map<string, { name?: string | null; product_name?: string | null }>();
  if (!productIds.length) return out;

  const select = "id, name, product_name";
  const fallbackSelect = "id, product_name";

  let rows: Record<string, unknown>[] = [];
  const primary = await supabaseServer
    .from("products")
    .select(select)
    .eq("organization_id", organizationId)
    .in("id", productIds);

  if (primary.error) {
    const fb = await supabaseServer
      .from("products")
      .select(fallbackSelect)
      .eq("organization_id", organizationId)
      .in("id", productIds);
    if (fb.error) return out;
    rows = (fb.data as Record<string, unknown>[]) ?? [];
  } else {
    rows = (primary.data as Record<string, unknown>[]) ?? [];
  }

  for (const p of rows) {
    const id = typeof p.id === "string" ? p.id : null;
    if (!id) continue;
    out.set(id, {
      name: typeof p.name === "string" ? p.name : null,
      product_name: typeof p.product_name === "string" ? p.product_name : null,
    });
  }
  return out;
}

/** Build display contracts for operational rows (batch `products.product_name` fetch). */
export async function buildProductLinkageDisplayContracts(
  organizationId: string,
  items: ProductLinkageDisplayInput[],
): Promise<ProductLinkageDisplayContract[]> {
  if (!isUuidString(organizationId)) return [];

  const productIds = [
    ...new Set(
      items
        .map((i) => {
          const r = i.row.resolved_product_id;
          return typeof r === "string" && isUuidString(r) ? r : null;
        })
        .filter((x): x is string => !!x),
    ),
  ];

  const products = await loadProductsById(organizationId, productIds);

  return items.map((item) => {
    const rid =
      typeof item.row.resolved_product_id === "string" ? item.row.resolved_product_id : null;
    const product = rid ? products.get(rid) ?? null : null;
    return mapRowToProductLinkageDisplayContract({
      source_table: item.source_table,
      source_row_id: item.source_row_id,
      row: item.row,
      product,
    });
  });
}

export async function fetchProductLinkageDisplayContract(input: {
  organizationId: string;
  source_table: string;
  source_row_id: string;
  row: Record<string, unknown>;
}): Promise<ProductLinkageDisplayContract> {
  const [one] = await buildProductLinkageDisplayContracts(input.organizationId, [
    {
      source_table: input.source_table,
      source_row_id: input.source_row_id,
      row: input.row,
    },
  ]);
  return (
    one ??
    mapRowToProductLinkageDisplayContract({
      source_table: input.source_table,
      source_row_id: input.source_row_id,
      row: input.row,
    })
  );
}
