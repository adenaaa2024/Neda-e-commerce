/**
 * V178 — canonical user-facing copy for ProductLinkageDisplayContract surfaces.
 * Client-safe; no DB access; does not create mappings.
 */

import type { ProductLinkageDisplayContract } from "./product-linkage-display-contract";
import {
  formatLinkageConfidence,
  isAmbiguousLinkageStatus,
  isMismatchLinkageStatus,
  isUnresolvedLinkageStatus,
  normalizeResolutionStatus,
  resolutionStatusBadgeClass,
  resolutionStatusLabel,
  type ProductLinkageFields,
} from "./scanner-product-linkage-ui";

/** V178 operator copy for unresolved rows. */
export const PRODUCT_LINKAGE_LABEL_NO_LINK = "No product link yet";

/** V178 operator copy for ambiguous rows. */
export const PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW = "Needs review";

export function productLinkageDisplayHeadline(linkage: ProductLinkageDisplayContract): string {
  const canonical = linkage.product_name?.trim();
  if (canonical) return canonical;
  return linkage.fallback_display_name?.trim() || "—";
}

/**
 * Primary status chip label (V178 copy for unresolved/ambiguous; technical labels otherwise).
 */
export function productLinkageUserStatusLabel(linkage: ProductLinkageDisplayContract): string {
  const status = normalizeResolutionStatus(linkage.identifier_resolution_status);
  if (isAmbiguousLinkageStatus(status)) return PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW;
  if (isUnresolvedLinkageStatus(status) || (!linkage.is_resolved && !status)) {
    return PRODUCT_LINKAGE_LABEL_NO_LINK;
  }
  if (isMismatchLinkageStatus(status)) return "Legacy mismatch";
  return resolutionStatusLabel(status);
}

export function productLinkageUserStatusBadgeClass(linkage: ProductLinkageDisplayContract): string {
  return resolutionStatusBadgeClass(linkage.identifier_resolution_status);
}

export function productLinkageConfidenceLabel(linkage: ProductLinkageDisplayContract): string | null {
  return formatLinkageConfidence(linkage.identifier_resolution_confidence);
}

/** Map contract back to linkage fields for legacy ReturnItemProductLinkage fetch paths. */
export function productLinkageUserStatusLabelFromFields(fields: ProductLinkageFields): string {
  const status = normalizeResolutionStatus(fields.identifier_resolution_status ?? null);
  if (isAmbiguousLinkageStatus(status)) return PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW;
  if (isUnresolvedLinkageStatus(status) || (!fields.resolved_product_id && !status)) {
    return PRODUCT_LINKAGE_LABEL_NO_LINK;
  }
  if (isMismatchLinkageStatus(status)) return "Legacy mismatch";
  return resolutionStatusLabel(status);
}

export function productLinkageFieldsFromContract(
  linkage: ProductLinkageDisplayContract,
): ProductLinkageFields {
  return {
    sku: linkage.sku,
    asin: linkage.asin,
    fnsku: linkage.fnsku,
    product_identifier: linkage.upc,
    resolved_product_id: linkage.resolved_product_id,
    resolved_catalog_product_id: linkage.resolved_catalog_product_id,
    identifier_resolution_status: linkage.identifier_resolution_status,
    identifier_resolution_confidence: linkage.identifier_resolution_confidence,
    item_name: linkage.fallback_display_name,
  };
}
