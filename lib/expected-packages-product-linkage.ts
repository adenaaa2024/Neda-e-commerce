/**
 * V179 — expected_packages → ProductLinkageDisplayContract (read-only).
 * Uses persisted resolver columns when present; else product_identifier_map lookup.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { mapRowToProductLinkageDisplayContract } from "./product-linkage-display-contract";
import type { ProductLinkageDisplayContract } from "./product-linkage-display-contract";
import {
  type ExpectedPackageLinkageSource,
  type ExpectedPackageVarianceStatus,
  type NedaExpectedPackageReadRow,
  type NedaExpectedPackagesReadResponse,
} from "./expected-packages-neda-read-contract";
import { resolveScannerProductIdentifiers } from "./scanner-product-resolve";

export type ExpectedPackageDbRow = Record<string, unknown> & {
  id: string;
  organization_id: string;
  store_id?: string | null;
  upload_id?: string | null;
  order_id?: string | null;
  order_type?: string | null;
  sku?: string | null;
  fnsku?: string | null;
  tracking_number?: string | null;
  disposition?: string | null;
  shipped_quantity?: number | null;
  expected_scan_quantity?: number | null;
  build_source?: string | null;
  build_status?: string | null;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: string | null;
  identifier_resolution_confidence?: number | null;
  product_id?: string | null;
  asin?: string | null;
};

export type ExpectedPackagesSchemaProbe = {
  table_exists: boolean;
  columns: string[];
  has_store_id: boolean;
  has_resolver_columns: boolean;
  has_identifiers: boolean;
  row_count: number | null;
};

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

export function computeVarianceStatus(
  expected: number,
  scanned: number,
): ExpectedPackageVarianceStatus {
  if (expected <= 0 && scanned <= 0) return "no_scan_target";
  if (expected <= 0) return scanned > 0 ? "over_scanned" : "unknown";
  if (scanned === expected) return "matched";
  if (scanned < expected) return "under_scanned";
  if (scanned > expected) return "over_scanned";
  return "unknown";
}

export function expectedQuantityFromRow(row: ExpectedPackageDbRow): number {
  const scan = num(row.expected_scan_quantity, NaN);
  if (Number.isFinite(scan) && scan > 0) return scan;
  const shipped = num(row.shipped_quantity, NaN);
  if (Number.isFinite(shipped) && shipped > 0) return shipped;
  return 1;
}

export async function probeExpectedPackagesSchema(
  supabase: SupabaseClient,
): Promise<ExpectedPackagesSchemaProbe> {
  const { count, error: cErr } = await supabase
    .from("expected_packages")
    .select("id", { count: "exact", head: true });
  const { data: sample, error: sErr } = await supabase.from("expected_packages").select("*").limit(1);
  if (sErr || cErr) {
    return {
      table_exists: false,
      columns: [],
      has_store_id: false,
      has_resolver_columns: false,
      has_identifiers: false,
      row_count: null,
    };
  }
  const row = (sample?.[0] ?? {}) as Record<string, unknown>;
  const columns = Object.keys(row);
  const hasResolver =
    columns.includes("resolved_product_id") &&
    columns.includes("identifier_resolution_status");
  return {
    table_exists: true,
    columns,
    has_store_id: columns.includes("store_id"),
    has_resolver_columns: hasResolver,
    has_identifiers: columns.some((c) =>
      ["sku", "fnsku", "asin", "upc", "upc_code", "product_id"].includes(c),
    ),
    row_count: count ?? null,
  };
}

export async function resolveExpectedPackageProductLinkage(
  supabase: SupabaseClient,
  row: ExpectedPackageDbRow,
  opts?: { asinFromDetail?: string | null },
): Promise<{ contract: ProductLinkageDisplayContract; source: ExpectedPackageLinkageSource }> {
  const asin = n(row.asin) ?? n(opts?.asinFromDetail);
  const persistedId = n(row.resolved_product_id);
  const persistedStatus = n(row.identifier_resolution_status);

  if (persistedId && persistedStatus === "resolved") {
    const contract = mapRowToProductLinkageDisplayContract({
      source_table: "expected_packages",
      source_row_id: String(row.id),
      row: { ...row, asin },
    });
    if (row.product_id) {
      const { data: prod } = await supabase
        .from("products")
        .select("id, product_name, name")
        .eq("id", persistedId)
        .maybeSingle();
      if (prod) {
        return {
          contract: mapRowToProductLinkageDisplayContract({
            source_table: "expected_packages",
            source_row_id: String(row.id),
            row: { ...row, asin },
            product: prod as { product_name?: string | null; name?: string | null },
          }),
          source: "persisted_column",
        };
      }
    }
    return { contract, source: "persisted_column" };
  }

  const storeId = n(row.store_id);
  const orgId = String(row.organization_id);
  const resolved = await resolveScannerProductIdentifiers(supabase, {
    organizationId: orgId,
    storeId,
    sku: n(row.sku),
    asin,
    fnsku: n(row.fnsku),
    legacyProductId: n(row.product_id),
  });

  const contract = mapRowToProductLinkageDisplayContract({
    source_table: "expected_packages",
    source_row_id: String(row.id),
    row: {
      sku: row.sku,
      fnsku: row.fnsku,
      asin,
      product_id: row.product_id,
      resolved_product_id: resolved.resolved_product_id,
      resolved_catalog_product_id: resolved.resolved_catalog_product_id,
      identifier_resolution_status: resolved.identifier_resolution_status,
      identifier_resolution_confidence: resolved.identifier_resolution_confidence,
      item_name: n(row.sku) ?? n(row.fnsku),
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
          source_table: "expected_packages",
          source_row_id: String(row.id),
          row: {
            sku: row.sku,
            fnsku: row.fnsku,
            asin,
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

  if (resolved.identifier_resolution_status === "ambiguous") {
    return { contract, source: "identifier_map" };
  }

  return { contract, source: "unresolved" };
}

export async function buildNedaExpectedPackageReadRow(
  supabase: SupabaseClient,
  row: ExpectedPackageDbRow,
  scannedQuantity: number,
  opts?: { asinFromDetail?: string | null },
): Promise<NedaExpectedPackageReadRow> {
  const expected = expectedQuantityFromRow(row);
  const { contract, source } = await resolveExpectedPackageProductLinkage(supabase, row, opts);
  return {
    expected_package_id: String(row.id),
    organization_id: String(row.organization_id),
    store_id: n(row.store_id),
    upload_id: n(row.upload_id),
    order_id: n(row.order_id) ?? "",
    order_type: n(row.order_type),
    tracking_number: n(row.tracking_number),
    sku: n(row.sku) ?? "",
    fnsku: n(row.fnsku),
    asin: n(row.asin) ?? n(opts?.asinFromDetail),
    disposition: n(row.disposition),
    expected_quantity: expected,
    scanned_quantity: scannedQuantity,
    variance_status: computeVarianceStatus(expected, scannedQuantity),
    build_source: n(row.build_source),
    build_status: n(row.build_status),
    product_linkage: contract,
    linkage_source: source,
  };
}

export function assessLinkageReadiness(
  schema: ExpectedPackagesSchemaProbe,
  sampleRows: NedaExpectedPackageReadRow[],
): NedaExpectedPackagesReadResponse["linkage_readiness"] {
  if (!schema.table_exists || !schema.has_identifiers) return "FAIL";
  if (!schema.has_store_id) return "PARTIAL";
  const resolved = sampleRows.filter((r) => r.product_linkage.is_resolved).length;
  const withIds = sampleRows.filter((r) => r.sku || r.fnsku).length;
  if (withIds === 0) return "PARTIAL";
  if (resolved === 0 && !schema.has_resolver_columns) return "PARTIAL";
  return "PASS";
}
