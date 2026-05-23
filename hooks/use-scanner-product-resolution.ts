"use client";

import { useMemo } from "react";
import {
  scannerProductResolutionBadges,
  type ScannerResolutionBadge,
} from "@/lib/scanner/product-resolution-badges";

/**
 * Memoized badge list for scanner rows — safe when DB columns are absent (all undefined).
 */
export function useScannerProductResolutionBadges(
  identifierResolutionStatus?: string | null,
  productMatchStatus?: string | null,
  productReviewRequired?: boolean | null,
  identifierResolutionSource?: string | null,
): ScannerResolutionBadge[] {
  return useMemo(
    () =>
      scannerProductResolutionBadges({
        identifier_resolution_status: identifierResolutionStatus,
        product_match_status: productMatchStatus,
        product_review_required: productReviewRequired,
        identifier_resolution_source: identifierResolutionSource,
      }),
    [identifierResolutionStatus, productMatchStatus, productReviewRequired, identifierResolutionSource],
  );
}
