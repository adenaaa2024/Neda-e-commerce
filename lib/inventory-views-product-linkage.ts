/**
 * V179 — inventory views → ProductLinkageDisplayContract (read-only, no view DDL).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  InventoryViewLinkageClass,
  InventoryViewLinkageSource,
  NedaInventoryItemStatusRow,
  NedaInventoryVarianceStatus,
} from "./inventory-views-neda-read-contract";
import { buildExpectedScannedProductComparison } from "./inventory-product-comparison";
import { mapRowToProductLinkageDisplayContract } from "./product-linkage-display-contract";
import type { ProductLinkageDisplayContract } from "./product-linkage-display-contract";
import { normalizeResolutionStatus } from "./scanner-product-linkage-ui";
import { resolveScannerProductIdentifiers } from "./scanner-product-resolve";

export type InventoryViewDbRow = Record<string, unknown>;

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function classifyViewLinkage(
  viewName: string,
  columns: string[],
): InventoryViewLinkageClass {
  const hasResolved = columns.includes("resolved_product_id");
  const hasProductId = columns.includes("product_id");
  const hasName = columns.some((c) =>
    ["product_name", "item_name", "title"].includes(c),
  );
  const hasIds = columns.some((c) => ["sku", "fnsku", "asin", "upc"].includes(c));
  const isAgg =
    viewName.includes("counted") ||
    viewName === "v_inventory_status" ||
    (!columns.includes("id") &&
      !columns.some((c) => c.endsWith("_id") && c !== "organization_id" && c !== "store_id"));

  if (hasResolved || (hasProductId && hasName)) return "product_linked";
  if (hasIds && columns.includes("store_id")) return "identifier_only";
  if (isAgg && !hasIds) return "aggregate_only";
  if (hasIds) return "identifier_only";
  return "missing_linkage";
}

export function expectedQtyFromInventoryRow(row: InventoryViewDbRow): number {
  for (const k of [
    "expected_quantity",
    "expected_scan_quantity",
    "expected_qty",
    "expected_count",
    "shipped_quantity",
  ]) {
    const v = num(row[k], NaN);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 1;
}

export function scannedQtyFromInventoryRow(row: InventoryViewDbRow): number {
  for (const k of [
    "scanned_quantity",
    "scanned_qty",
    "scanned_count",
    "actual_scanned_count",
    "counted_quantity",
  ]) {
    const v = num(row[k], NaN);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

export function computeInventoryVarianceStatus(
  expected: number,
  scanned: number,
  linkageClass: InventoryViewLinkageClass,
): NedaInventoryVarianceStatus {
  if (linkageClass === "aggregate_only") return "aggregate_only";
  if (expected <= 0 && scanned <= 0) return "no_scan_target";
  if (expected <= 0) return scanned > 0 ? "over_scanned" : "unknown";
  if (scanned === expected) return "matched";
  if (scanned < expected) return "under_scanned";
  if (scanned > expected) return "over_scanned";
  return "unknown";
}

export async function resolveInventoryViewProductLinkage(
  supabase: SupabaseClient,
  viewName: string,
  row: InventoryViewDbRow,
  rowId: string,
): Promise<{ contract: ProductLinkageDisplayContract; source: InventoryViewLinkageSource }> {
  const persistedId = n(row.resolved_product_id);
  const persistedStatus = n(row.identifier_resolution_status);
  const productName = n(row.product_name) ?? n(row.item_name) ?? n(row.title);

  if (
    persistedId &&
    normalizeResolutionStatus(persistedStatus) === "resolved"
  ) {
    const { data: prod } = await supabase
      .from("products")
      .select("id, product_name, name")
      .eq("id", persistedId)
      .maybeSingle();
    return {
      contract: mapRowToProductLinkageDisplayContract({
        source_table: viewName,
        source_row_id: rowId,
        row,
        product: prod as { product_name?: string | null; name?: string | null } | null,
      }),
      source: "view_column",
    };
  }

  if (persistedId && productName) {
    return {
      contract: mapRowToProductLinkageDisplayContract({
        source_table: viewName,
        source_row_id: rowId,
        row: { ...row, resolved_product_id: persistedId, identifier_resolution_status: "resolved" },
      }),
      source: "view_column",
    };
  }

  const orgId = n(row.organization_id);
  if (!orgId) {
    return {
      contract: mapRowToProductLinkageDisplayContract({
        source_table: viewName,
        source_row_id: rowId,
        row,
      }),
      source: "unresolved",
    };
  }

  const resolved = await resolveScannerProductIdentifiers(supabase, {
    organizationId: orgId,
    storeId: n(row.store_id),
    sku: n(row.sku) ?? n(row.seller_sku),
    asin: n(row.asin),
    fnsku: n(row.fnsku),
    upc: n(row.upc),
    legacyProductId: n(row.product_id),
  });

  const contract = mapRowToProductLinkageDisplayContract({
    source_table: viewName,
    source_row_id: rowId,
    row: {
      ...row,
      asin: n(row.asin),
      sku: n(row.sku) ?? n(row.seller_sku),
      fnsku: n(row.fnsku),
      resolved_product_id: resolved.resolved_product_id,
      resolved_catalog_product_id: resolved.resolved_catalog_product_id,
      identifier_resolution_status: resolved.identifier_resolution_status,
      identifier_resolution_confidence: resolved.identifier_resolution_confidence,
      item_name: productName ?? n(row.sku) ?? n(row.fnsku),
    },
  });

  if (resolved.resolved_product_id && resolved.identifier_resolution_status === "resolved") {
    const { data: prod } = await supabase
      .from("products")
      .select("id, product_name, name")
      .eq("id", resolved.resolved_product_id)
      .maybeSingle();
    if (prod) {
      return {
        contract: mapRowToProductLinkageDisplayContract({
          source_table: viewName,
          source_row_id: rowId,
          row: {
            sku: row.sku,
            fnsku: row.fnsku,
            asin: row.asin,
            resolved_product_id: resolved.resolved_product_id,
            resolved_catalog_product_id: resolved.resolved_catalog_product_id,
            identifier_resolution_status: resolved.identifier_resolution_status,
            identifier_resolution_confidence: resolved.identifier_resolution_confidence,
          },
          product: prod as { product_name?: string | null; name?: string | null },
        }),
        source: "identifier_map",
      };
    }
    return { contract, source: "identifier_map" };
  }

  return { contract, source: "unresolved" };
}

export async function buildNedaInventoryItemStatusRow(
  supabase: SupabaseClient,
  row: InventoryViewDbRow,
  linkageClass: InventoryViewLinkageClass,
): Promise<NedaInventoryItemStatusRow> {
  const viewName = "v_inventory_item_status";
  const slip = n(row.slip_code) ?? n(row.id_slip_contents);
  const rowId =
    n(row.id) ??
    n(row.return_item_id) ??
    n(row.item_id) ??
    ([n(row.tracking_number), slip, n(row.sku), n(row.fnsku)].filter(Boolean).join(":") || "line");

  const expected = expectedQtyFromInventoryRow(row);
  const scanned = scannedQtyFromInventoryRow(row);
  const { contract, source } = await resolveInventoryViewProductLinkage(
    supabase,
    viewName,
    row,
    rowId,
  );

  return {
    source_view: viewName,
    source_row_id: rowId,
    organization_id: String(row.organization_id ?? ""),
    store_id: n(row.store_id),
    package_id: n(row.package_id),
    pallet_id: n(row.pallet_id),
    order_id: n(row.order_id),
    tracking_number: n(row.tracking_number),
    slip_code: slip,
    package_code: n(row.package_code),
    sku: n(row.sku) ?? n(row.seller_sku),
    fnsku: n(row.fnsku),
    asin: n(row.asin),
    expected_quantity: expected,
    scanned_quantity: scanned,
    variance_status: computeInventoryVarianceStatus(expected, scanned, linkageClass),
    inventory_status: n(row.inventory_status) ?? n(row.status),
    product_linkage: contract,
    product_comparison: buildExpectedScannedProductComparison({
      expected: contract,
      expectedQty: expected,
      scannedQty: scanned,
    }),
    linkage_source: linkageClass === "aggregate_only" ? "aggregate_no_row_product" : source,
    linkage_class: linkageClass,
  };
}

export function assessInventoryViewsReadiness(
  viewsPresent: Record<string, boolean>,
  itemRows: NedaInventoryItemStatusRow[],
): "PASS" | "PARTIAL" | "FAIL" {
  if (!viewsPresent.v_inventory_item_status) return "FAIL";
  if (itemRows.length === 0) return "PARTIAL";
  const resolved = itemRows.filter((r) => r.product_linkage.is_resolved).length;
  const withIds = itemRows.filter((r) => r.sku || r.fnsku).length;
  if (withIds === 0) return "PARTIAL";
  if (resolved === 0) return "PARTIAL";
  return "PASS";
}
