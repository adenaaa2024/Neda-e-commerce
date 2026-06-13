/**
 * Server-side batch enrichment for ProductLinkageDisplayContract (product_name from products).
 * Import from API routes and server modules — not a "use server" action file.
 */

import {
  mapRowToProductLinkageDisplayContract,
  type ProductLinkageDisplayContract,
} from "./product-linkage-display-contract";
import { resolveScannerProductIdentifiers } from "./scanner-product-resolve";
import { supabaseServer } from "./supabase-server";
import { isUuidString } from "./uuid";

export type ProductLinkageDisplayInput = {
  source_table: string;
  source_row_id: string;
  row: Record<string, unknown>;
};

function str(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function hydrateRowFromSpineMap(
  organizationId: string,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (str(row, "resolved_product_id")) return row;

  const storeId = str(row, "store_id");
  if (!storeId) return row;

  const resolved = await resolveScannerProductIdentifiers(supabaseServer, {
    organizationId,
    storeId,
    sku: str(row, "sku", "seller_sku", "msku"),
    asin: str(row, "asin"),
    fnsku: str(row, "fnsku"),
    upc: str(row, "upc", "upc_code", "product_identifier"),
    legacyProductId: str(row, "product_id"),
  });

  if (!resolved.resolved_product_id || resolved.identifier_resolution_status !== "resolved") {
    return row;
  }

  return {
    ...row,
    resolved_product_id: resolved.resolved_product_id,
    resolved_catalog_product_id: resolved.resolved_catalog_product_id,
    identifier_resolution_status: resolved.identifier_resolution_status,
    identifier_resolution_confidence: resolved.identifier_resolution_confidence,
  };
}

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

  const hydratedItems = await Promise.all(
    items.map(async (item) => ({
      ...item,
      row: await hydrateRowFromSpineMap(organizationId, item.row),
    })),
  );

  const productIds = [
    ...new Set(
      hydratedItems
        .flatMap((i) => {
          const ids: string[] = [];
          const resolved = i.row.resolved_product_id;
          const legacy = i.row.product_id;
          if (typeof resolved === "string" && isUuidString(resolved)) ids.push(resolved);
          if (typeof legacy === "string" && isUuidString(legacy)) ids.push(legacy);
          return ids;
        }),
    ),
  ];

  const products = await loadProductsById(organizationId, productIds);

  return hydratedItems.map((item) => {
    const rid =
      typeof item.row.resolved_product_id === "string"
        ? item.row.resolved_product_id
        : typeof item.row.product_id === "string"
          ? item.row.product_id
          : null;
    const product = rid ? { id: rid, ...products.get(rid) } : null;
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
