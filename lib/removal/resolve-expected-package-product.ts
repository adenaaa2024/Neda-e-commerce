/**
 * Removal-derived expected_packages → shared scanner resolver + queue buckets.
 * Read-only resolver path: never inserts products or product_identifier_map rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resolveScannerProductIdentifiers,
  type ScannerResolutionColumns,
} from "../scanner-product-resolve";

export type ExpectedPackageResolverBucket =
  | "resolved"
  | "ambiguous"
  | "missing_product_needs_evidence"
  | "product_promotion_candidate";

export type RemovalExpectedPackageRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  sku?: string | null;
  fnsku?: string | null;
  asin?: string | null;
  upc?: string | null;
  upc_code?: string | null;
  product_id?: string | null;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: string | null;
  source_detail_row_id?: string | null;
  order_id?: string | null;
  build_source?: string | null;
};

export type RemovalHintBundle = {
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  hydrated_asin_from_removal: boolean;
  hydrated_upc_from_removal: boolean;
};

export type ResolvedExpectedPackageResult = {
  bucket: ExpectedPackageResolverBucket;
  columns: ScannerResolutionColumns;
  hints: RemovalHintBundle;
  promotion_preview_only: boolean;
};

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function hasAnyIdentifier(hints: RemovalHintBundle): boolean {
  return !!(hints.sku || hints.fnsku || hints.asin || hints.upc);
}

/** Parse ASIN/UPC hints from amazon_removals.raw_data without persisting. */
export function parseRemovalRawDataHints(rawData: unknown): { asin: string | null; upc: string | null } {
  if (rawData === null || rawData === undefined) return { asin: null, upc: null };
  let obj: Record<string, unknown> | null = null;
  if (typeof rawData === "string") {
    try {
      obj = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return { asin: null, upc: null };
    }
  } else if (typeof rawData === "object") {
    obj = rawData as Record<string, unknown>;
  }
  if (!obj) return { asin: null, upc: null };

  const asin = n(obj.asin) ?? n(obj.ASIN);
  const upc =
    n(obj.upc) ??
    n(obj.UPC) ??
    n(obj.upc_code) ??
    n(obj.gtin) ??
    n(obj.GTIN) ??
    n(obj.product_identifier);
  return { asin, upc };
}

export function buildRemovalHintBundle(
  row: RemovalExpectedPackageRow,
  opts?: {
    asinFromRemoval?: string | null;
    upcFromRemoval?: string | null;
  },
): RemovalHintBundle {
  const asinFromRow = n(row.asin);
  const upcFromRow = n(row.upc) ?? n(row.upc_code);
  const asinFromRemoval = n(opts?.asinFromRemoval);
  const upcFromRemoval = n(opts?.upcFromRemoval);

  return {
    sku: n(row.sku),
    fnsku: n(row.fnsku),
    asin: asinFromRow ?? asinFromRemoval,
    upc: upcFromRow ?? upcFromRemoval,
    hydrated_asin_from_removal: !asinFromRow && !!asinFromRemoval,
    hydrated_upc_from_removal: !upcFromRow && !!upcFromRemoval,
  };
}

/**
 * Classify resolver output into operator queue buckets.
 * `product_promotion_candidate` is preview-only here — actual E2 requires Amazon evidence.
 */
export function classifyExpectedPackageResolverBucket(
  columns: ScannerResolutionColumns,
  hints: RemovalHintBundle,
): ExpectedPackageResolverBucket {
  if (columns.identifier_resolution_status === "resolved" && columns.resolved_product_id) {
    return "resolved";
  }
  if (
    columns.identifier_resolution_status === "ambiguous" ||
    columns.identifier_resolution_status === "mismatch"
  ) {
    return "ambiguous";
  }
  if (!hasAnyIdentifier(hints)) {
    return "missing_product_needs_evidence";
  }
  return "missing_product_needs_evidence";
}

/** Preview rows eligible for E2 after PC03D evidence — not allocated as live promotion candidates. */
export function isProductPromotionPreviewEligible(hints: RemovalHintBundle): boolean {
  return !!(hints.fnsku && hints.sku);
}

export async function resolveExpectedPackageProduct(
  supabase: SupabaseClient,
  row: RemovalExpectedPackageRow,
  opts?: {
    asinFromRemoval?: string | null;
    upcFromRemoval?: string | null;
  },
): Promise<ResolvedExpectedPackageResult> {
  const hints = buildRemovalHintBundle(row, opts);
  const columns = await resolveScannerProductIdentifiers(supabase, {
    organizationId: String(row.organization_id),
    storeId: row.store_id,
    sku: hints.sku,
    asin: hints.asin,
    fnsku: hints.fnsku,
    upc: hints.upc,
  });

  const bucket = classifyExpectedPackageResolverBucket(columns, hints);
  const promotion_preview_only =
    bucket === "missing_product_needs_evidence" && isProductPromotionPreviewEligible(hints);

  return {
    bucket,
    columns,
    hints,
    promotion_preview_only,
  };
}
