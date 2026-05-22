/**
 * V179 — Neda read contract for expected_packages (read-only, no DB writes).
 */

import type { ProductLinkageDisplayContract } from "./product-linkage-display-contract";
import type { ExpectedScannedProductComparison } from "./inventory-product-comparison";

/** How product_linkage was produced for this expected_packages row. */
export type ExpectedPackageLinkageSource = "persisted_column" | "identifier_map" | "unresolved";

export type ExpectedPackageVarianceStatus =
  | "matched"
  | "under_scanned"
  | "over_scanned"
  | "unknown"
  | "no_scan_target";

export type NedaExpectedPackageReadRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  upload_id: string | null;
  order_id: string;
  order_type: string | null;
  tracking_number: string | null;
  sku: string;
  fnsku: string | null;
  asin: string | null;
  disposition: string | null;
  /** Expected quantity for warehouse scan plan. */
  expected_quantity: number;
  /** Count of return_items matched by scan-join strategy (see audit). */
  scanned_quantity: number;
  variance_status: ExpectedPackageVarianceStatus;
  build_source: string | null;
  build_status: string | null;
  product_linkage: ProductLinkageDisplayContract;
  linkage_source: ExpectedPackageLinkageSource;
  product_comparison: ExpectedScannedProductComparison;
};

export type NedaExpectedPackagesReadResponse = {
  rows: NedaExpectedPackageReadRow[];
  linkage_readiness: "PASS" | "PARTIAL" | "FAIL";
  schema_has_resolver_columns: boolean;
  notes: string[];
};
