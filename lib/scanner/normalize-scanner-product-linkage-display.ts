/**
 * Shipment Entry — single read-model path for scanner product linkage display.
 * Display-only: resolves via exact identifiers when persisted row lacks linkage.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isUuidString } from "@/lib/uuid";
import {
  buildProductLinkageDisplayContract,
  fetchProductNamesByResolvedIds,
  PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageIsAmbiguous,
  type ProductLinkageDisplayContract,
  type ProductLinkageSourceRow,
  type ProductsLookupClient,
} from "@/lib/scanner/product-linkage-display-contract";
import { resolveProductForScannerItem } from "@/lib/scanner/resolve-product-for-scanner-item";

export const PRODUCT_LINKAGE_LINKED_LABEL = "Linked";
export const PRODUCT_LINKAGE_NEEDS_PRODUCT_REVIEW_LABEL = "Needs product review";

function trimOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function normStatus(v: unknown): string | null {
  const s = trimOrNull(v);
  return s ? s.toLowerCase() : null;
}

export function rowHasScannerIdentifiers(row: ProductLinkageSourceRow): boolean {
  return Boolean(
    trimOrNull(row.fnsku) ||
      trimOrNull(row.upc) ||
      trimOrNull(row.sku) ||
      trimOrNull(row.asin) ||
      trimOrNull(row.product_identifier),
  );
}

/** True when display should attempt live exact-identifier resolve (read-only). */
export function needsScannerLinkageResolve(row: ProductLinkageSourceRow): boolean {
  const resolvedId =
    trimOrNull(row.resolved_product_id) ??
    trimOrNull(row.product_id) ??
    trimOrNull(row.resolved_catalog_product_id);
  const status = normStatus(row.identifier_resolution_status);

  if (status === "ambiguous" || status === "mismatch") return false;
  if (resolvedId && (status === "resolved" || status === "matched") && trimOrNull(row.product_name)) {
    return false;
  }
  if (resolvedId && (status === "resolved" || status === "matched")) {
    return !trimOrNull(row.product_name);
  }
  return rowHasScannerIdentifiers(row);
}

export type NormalizeScannerLinkageInput = {
  organizationId: string;
  storeId: string | null;
  sourceTable: string;
  sourceRowId?: string | null;
  row: ProductLinkageSourceRow;
  /** Default true — set false to skip live resolve (pure mapper). */
  resolveIfNeeded?: boolean;
};

export async function normalizeScannerProductLinkageDisplay(
  supabase: SupabaseClient,
  input: NormalizeScannerLinkageInput,
): Promise<ProductLinkageDisplayContract> {
  const org = String(input.organizationId ?? "").trim();
  if (!isUuidString(org)) {
    return buildProductLinkageDisplayContract(input.row, new Map());
  }

  let working: ProductLinkageSourceRow = { ...input.row };
  const storeId = trimOrNull(input.storeId);

  if (input.resolveIfNeeded !== false && needsScannerLinkageResolve(working)) {
    const res = await resolveProductForScannerItem(supabase, {
      organization_id: org,
      store_id: storeId,
      fnsku: working.fnsku ?? null,
      upc: working.upc ?? null,
      sku: working.sku ?? null,
      asin: working.asin ?? null,
      source_table: input.sourceTable,
      source_row_id: trimOrNull(input.sourceRowId) ?? undefined,
    });
    working = {
      ...working,
      resolved_product_id: res.resolved_product_id ?? working.resolved_product_id ?? null,
      resolved_catalog_product_id: res.resolved_catalog_product_id ?? working.resolved_catalog_product_id ?? null,
      identifier_resolution_status: res.status,
      identifier_resolution_confidence: res.confidence,
    };
  }

  const resolvedId =
    trimOrNull(working.resolved_product_id) ??
    trimOrNull(working.product_id) ??
    trimOrNull(working.resolved_catalog_product_id);
  const nameMap = await fetchProductNamesByResolvedIds(
    supabase as unknown as ProductsLookupClient,
    resolvedId ? [resolvedId] : [],
  );
  return buildProductLinkageDisplayContract(working, nameMap);
}

/** Status chip / linkage label: Linked | Needs product review | No product link yet */
export function productLinkageOperatorStatusLabel(linkage: ProductLinkageDisplayContract): string {
  if (productLinkageIsAmbiguous(linkage)) return PRODUCT_LINKAGE_NEEDS_PRODUCT_REVIEW_LABEL;
  const resolvedId = linkage.resolved_product_id?.trim();
  const status = normStatus(linkage.identifier_resolution_status);
  if (
    resolvedId &&
    (status === "resolved" || status === "matched") &&
    !productLinkageIsAmbiguous(linkage)
  ) {
    return PRODUCT_LINKAGE_LINKED_LABEL;
  }
  return PRODUCT_LINKAGE_UNMAPPED_LABEL;
}

export function productLinkageShowsLinkedStatus(linkage: ProductLinkageDisplayContract): boolean {
  return productLinkageOperatorStatusLabel(linkage) === PRODUCT_LINKAGE_LINKED_LABEL;
}

export function productLinkageShowsNeedsProductReview(linkage: ProductLinkageDisplayContract): boolean {
  return productLinkageOperatorStatusLabel(linkage) === PRODUCT_LINKAGE_NEEDS_PRODUCT_REVIEW_LABEL;
}

/** Back-compat alias for ambiguous chip copy in meta components. */
export function productLinkageNeedsReviewLabel(): string {
  return PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL;
}
