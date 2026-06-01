/**
 * Stable product linkage display contract (V169) for Neda, scanner, returns, claims, imports.
 * Client-safe — pure mapping only; no DB access.
 */

import {
  normalizeResolutionStatus,
  pickProductRowDisplayName,
  resolveLinkageDisplayTitle,
  type ProductLinkageFields,
  type ProductNameFields,
} from "./scanner-product-linkage-ui";

export type ProductLinkageDisplayContract = {
  source_row_id: string;
  source_table: string;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  upc: string | null;
  /** Legacy catalog FK on operational rows (mismatch guard only — not canonical). */
  product_id: string | null;
  /** Canonical `products.id` when resolver status is resolved. */
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  product_name: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
  is_resolved: boolean;
  fallback_display_name: string;
};

export type ProductLinkageMapperInput = {
  source_table: string;
  source_row_id: string;
  row: Record<string, unknown>;
  /** Optional joined `products` row for canonical title. */
  product?: ProductNameFields | null;
};

function str(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  }
  return null;
}

function num(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (v == null) return null;
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function linkageFieldsFromRow(row: Record<string, unknown>): ProductLinkageFields {
  return {
    item_name: str(row, "item_name", "description", "slip_code"),
    sku: str(row, "sku", "seller_sku", "msku"),
    asin: str(row, "asin"),
    fnsku: str(row, "fnsku"),
    product_identifier: str(row, "product_identifier"),
    resolved_product_id: str(row, "resolved_product_id"),
    resolved_catalog_product_id: str(row, "resolved_catalog_product_id"),
    identifier_resolution_status: str(row, "identifier_resolution_status"),
    identifier_resolution_confidence: num(row, "identifier_resolution_confidence"),
    catalog_product_name: str(row, "catalog_product_name"),
  };
}

/**
 * Map a DB/API row to the stable display contract without schema changes.
 */
export function mapRowToProductLinkageDisplayContract(
  input: ProductLinkageMapperInput,
): ProductLinkageDisplayContract {
  const { source_table, source_row_id, row, product } = input;
  const fields = linkageFieldsFromRow(row);
  const status = normalizeResolutionStatus(fields.identifier_resolution_status ?? null);
  const resolvedId = fields.resolved_product_id ?? null;
  const productName =
    (product ? pickProductRowDisplayName(product) : null) ??
    str(row, "catalog_product_name");
  const isResolved = !!resolvedId && status === "resolved";

  return {
    source_row_id,
    source_table,
    asin: fields.asin ?? null,
    fnsku: fields.fnsku ?? null,
    sku: fields.sku ?? null,
    upc: str(row, "upc", "upc_code", "product_identifier"),
    product_id: str(row, "product_id"),
    resolved_product_id: resolvedId,
    resolved_catalog_product_id: fields.resolved_catalog_product_id ?? null,
    product_name: productName,
    identifier_resolution_status: typeof status === "string" ? status : null,
    identifier_resolution_confidence: fields.identifier_resolution_confidence ?? null,
    is_resolved: isResolved,
    fallback_display_name: resolveLinkageDisplayTitle(productName, fields),
  };
}

/** Manifest / expected_items JSON line → contract (no source_row_id until persisted). */
export function mapExpectedItemToProductLinkageDisplayContract(input: {
  source_table: "packages.manifest_data";
  source_row_id: string;
  line: Record<string, unknown>;
}): ProductLinkageDisplayContract {
  return mapRowToProductLinkageDisplayContract({
    source_table: input.source_table,
    source_row_id: input.source_row_id,
    row: input.line,
  });
}
