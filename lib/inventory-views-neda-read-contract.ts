/**
 * V179 — Neda read contract for inventory/scanner views (read-only).
 */

import type { ProductLinkageDisplayContract } from "./product-linkage-display-contract";
import type { ExpectedScannedProductComparison } from "./inventory-product-comparison";

export type InventoryViewName =
  | "v_scanned_items_counted"
  | "v_inventory_status"
  | "v_inventory_item_status";

export type InventoryViewLinkageClass =
  | "product_linked"
  | "identifier_only"
  | "aggregate_only"
  | "missing_linkage";

export type InventoryViewLinkageSource =
  | "view_column"
  | "identifier_map"
  | "aggregate_no_row_product"
  | "unresolved";

export type NedaInventoryVarianceStatus =
  | "matched"
  | "under_scanned"
  | "over_scanned"
  | "unknown"
  | "no_scan_target"
  | "aggregate_only";

/** Package-level aggregate from v_inventory_status (status chip only — no product linkage). */
export type NedaInventoryPackageStatusRow = {
  organization_id: string;
  store_id: string | null;
  tracking_number: string | null;
  slip_code: string | null;
  order_id: string | null;
  total_expected: number;
  total_scanned: number;
  status: string;
};

/** One row from v_inventory_item_status (primary Neda surface). */
export type NedaInventoryItemStatusRow = {
  source_view: "v_inventory_item_status";
  source_row_id: string;
  organization_id: string;
  store_id: string | null;
  package_id: string | null;
  pallet_id: string | null;
  order_id: string | null;
  tracking_number: string | null;
  slip_code: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  expected_quantity: number;
  scanned_quantity: number;
  variance_status: NedaInventoryVarianceStatus;
  inventory_status: string | null;
  product_linkage: ProductLinkageDisplayContract;
  product_comparison: ExpectedScannedProductComparison;
  linkage_source: InventoryViewLinkageSource;
  linkage_class: InventoryViewLinkageClass;
};

export type NedaInventoryViewsReadResponse = {
  item_status_rows: NedaInventoryItemStatusRow[];
  /** Package-level rollup from v_inventory_status (when filters match). */
  package_status: NedaInventoryPackageStatusRow | null;
  linkage_readiness: "PASS" | "PARTIAL" | "FAIL";
  views_present: Record<InventoryViewName, boolean>;
  notes: string[];
};
