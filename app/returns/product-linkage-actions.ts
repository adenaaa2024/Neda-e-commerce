"use server";

import { supabaseServer } from "@/lib/supabase-server";
import {
  pickProductRowDisplayName,
  resolveLinkageDisplayTitle,
  type ProductLinkageFields,
} from "@/lib/scanner-product-linkage-ui";
import {
  syncSlipContentsResolverForPackage,
  verifySlipContentsResolverReadable,
} from "@/lib/slip-contents-resolver-write";
import { isUuidString } from "@/lib/uuid";

export type CanonicalProductDisplay = {
  product_id: string;
  catalog_product_id: string | null;
  title: string;
  category: string | null;
  expiry: string | null;
  sku: string | null;
};

/** Read-only canonical product fields for linked return_items (no mutations). */
export async function fetchCanonicalProductDisplay(input: {
  organizationId: string;
  resolvedProductId: string | null;
  resolvedCatalogProductId?: string | null;
  itemExpirationDate?: string | null;
  /** Operator/OCR fields for title fallback when product row has no name. */
  linkageFields?: Pick<
    ProductLinkageFields,
    "item_name" | "sku" | "asin" | "fnsku" | "product_identifier"
  > | null;
}): Promise<{ ok: true; display: CanonicalProductDisplay | null } | { ok: false; error: string }> {
  const orgId = input.organizationId.trim();
  const productId = input.resolvedProductId?.trim() ?? "";
  if (!isUuidString(orgId)) return { ok: false, error: "Invalid organization." };
  if (!productId || !isUuidString(productId)) return { ok: true, display: null };

  const productSelect =
    "id, name, product_name, sku, category_id, product_categories(name)";
  const productSelectFallback = "id, product_name, sku, category_id, product_categories(name)";

  let product: Record<string, unknown> | null = null;
  let pErr: { message: string } | null = null;

  const primary = await supabaseServer
    .from("products")
    .select(productSelect)
    .eq("id", productId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (primary.error) {
    const fallback = await supabaseServer
      .from("products")
      .select(productSelectFallback)
      .eq("id", productId)
      .eq("organization_id", orgId)
      .maybeSingle();
    pErr = fallback.error;
    product = (fallback.data as Record<string, unknown> | null) ?? null;
  } else {
    product = (primary.data as Record<string, unknown> | null) ?? null;
  }

  if (pErr) return { ok: false, error: pErr.message };
  if (!product) return { ok: true, display: null };

  const catJoin = product.product_categories as { name?: string } | null;
  const category =
    catJoin && typeof catJoin === "object" && typeof catJoin.name === "string"
      ? catJoin.name
      : null;

  let catalogTitle: string | null = null;
  const catalogId = input.resolvedCatalogProductId?.trim() ?? "";
  if (catalogId && isUuidString(catalogId)) {
    const { data: cat } = await supabaseServer
      .from("catalog_products")
      .select("id, item_name")
      .eq("id", catalogId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (cat?.item_name && typeof cat.item_name === "string") {
      catalogTitle = cat.item_name.trim() || null;
    }
  }

  const productSku = typeof product.sku === "string" ? product.sku : null;
  const canonicalFromProduct =
    pickProductRowDisplayName({
      name: typeof product.name === "string" ? product.name : null,
      product_name: typeof product.product_name === "string" ? product.product_name : null,
    }) ||
    catalogTitle ||
    (productSku?.trim() ? productSku.trim() : null);

  const title = resolveLinkageDisplayTitle(canonicalFromProduct, {
    item_name: input.linkageFields?.item_name ?? null,
    sku: input.linkageFields?.sku ?? productSku,
    asin: input.linkageFields?.asin ?? null,
    fnsku: input.linkageFields?.fnsku ?? null,
    product_identifier: input.linkageFields?.product_identifier ?? null,
  });

  return {
    ok: true,
    display: {
      product_id: productId,
      catalog_product_id: catalogId && isUuidString(catalogId) ? catalogId : null,
      title,
      category,
      expiry: input.itemExpirationDate?.trim() || null,
      sku: typeof product.sku === "string" ? product.sku : null,
    },
  };
}

export async function runSlipContentsResolverSyncForPackage(input: {
  organizationId: string;
  packageId: string;
  storeId: string | null;
}): Promise<
  | { ok: true; rows_patched: number; rows_seen: number }
  | { ok: false; error: string }
> {
  if (!isUuidString(input.organizationId) || !isUuidString(input.packageId)) {
    return { ok: false, error: "Invalid organization or package id." };
  }
  return syncSlipContentsResolverForPackage(supabaseServer, {
    organizationId: input.organizationId,
    packageId: input.packageId,
    storeId: input.storeId,
  });
}

export async function runVerifySlipContentsResolverReadable(organizationId: string) {
  if (!isUuidString(organizationId)) {
    return { ok: false as const, error: "Invalid organization." };
  }
  return verifySlipContentsResolverReadable(supabaseServer, organizationId);
}
