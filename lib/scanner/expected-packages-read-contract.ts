/**
 * Neda read contract — `expected_packages` + `v_inventory_item_status` display helpers.
 * Scanner UI consumes linkage fields from DB rows only; no client product creation.
 */

import {
  buildProductLinkageDisplayContract,
  buildProductLinkageFallbackName,
  fetchProductNamesByResolvedIds,
  productLinkagePrimaryLabel,
  type ProductLinkageDisplayContract,
  type ProductLinkageSourceRow,
  type ProductsLookupClient,
} from "@/lib/scanner/product-linkage-display-contract";
import type { VInventoryStatusRow } from "@/lib/scanner/v-inventory-status";

function trimOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function normStatus(v: unknown): string | null {
  const s = trimOrNull(v);
  return s ? s.toLowerCase() : null;
}

function epCatalogNameFromRow(row: Record<string, unknown>): string | null {
  const prod = row.products as { product_name?: string } | null | undefined;
  return trimOrNull(prod?.product_name);
}

/** Signed scan delta: scanned − expected (negative = short, positive = over). */
export function scanQuantityVariance(expected: number, scanned: number): number {
  const exp = Math.max(0, Math.floor(Number(expected) || 0));
  const scn = Math.max(0, Math.floor(Number(scanned) || 0));
  return scn - exp;
}

/** Compact variance label for tables (e.g. +2 over, −3 short, 0). */
export function formatScanVarianceLabel(expected: number, scanned: number): string {
  const v = scanQuantityVariance(expected, scanned);
  if (v === 0) return "0";
  if (v > 0) return `+${v}`;
  return String(v);
}

export function buildExpectedPackageProductLinkage(
  row: Record<string, unknown>,
  productNameById: ReadonlyMap<string, string>,
): ProductLinkageDisplayContract {
  const source: ProductLinkageSourceRow = {
    resolved_product_id: row.resolved_product_id as string | null | undefined,
    identifier_resolution_status: row.identifier_resolution_status as string | null | undefined,
    identifier_resolution_confidence: row.identifier_resolution_confidence as number | null | undefined,
    sku: row.sku as string | null | undefined,
    fnsku: row.fnsku as string | null | undefined,
    description: epCatalogNameFromRow(row) ?? undefined,
  };
  return buildProductLinkageDisplayContract(source, productNameById);
}

/** Inventory view row + optional matching `expected_packages` detail for linkage. */
export function buildInventoryViewProductLinkage(
  invRow: VInventoryStatusRow,
  epRow: Record<string, unknown> | null | undefined,
  productNameById: ReadonlyMap<string, string>,
): ProductLinkageDisplayContract {
  if (epRow) return buildExpectedPackageProductLinkage(epRow, productNameById);
  return buildProductLinkageDisplayContract(
    {
      description: invRow.product_name,
      fnsku: invRow.fnsku,
      sku: invRow.sku,
    },
    productNameById,
  );
}

function worseIdentifierResolution(a: string | null, b: string | null): string | null {
  const order = ["resolved", "unresolved", "ambiguous"];
  const score = (s: string | null) => {
    const i = order.indexOf(String(s ?? "").trim().toLowerCase());
    return i < 0 ? -1 : i;
  };
  return score(b) > score(a) ? b : a;
}

/** Merge linkage across grouped `expected_packages` rows (SKU/FNSKU/disposition bucket). */
export function mergeExpectedPackageRowsProductLinkage(
  rows: Record<string, unknown>[],
  productNameById: ReadonlyMap<string, string>,
): ProductLinkageDisplayContract {
  if (!rows.length) {
    return buildProductLinkageDisplayContract({}, productNameById);
  }

  let status: string | null = null;
  let confidence: number | null = null;
  const resolvedIds = new Set<string>();
  const fallbacks: string[] = [];

  for (const r of rows) {
    const st = normStatus(r.identifier_resolution_status);
    status = worseIdentifierResolution(status, st);
    const conf = r.identifier_resolution_confidence;
    if (conf !== null && conf !== undefined && conf !== "") {
      const n = Number(conf);
      if (Number.isFinite(n)) confidence = confidence == null ? n : Math.max(confidence, n);
    }
    const rid = trimOrNull(r.resolved_product_id);
    if (rid) resolvedIds.add(rid);
    const fb = buildProductLinkageFallbackName({
      sku: r.sku as string | null | undefined,
      fnsku: r.fnsku as string | null | undefined,
      description: epCatalogNameFromRow(r) ?? undefined,
    });
    if (fb) fallbacks.push(fb);
  }

  let resolvedId: string | null = null;
  if (resolvedIds.size === 1) resolvedId = [...resolvedIds][0]!;
  else if (resolvedIds.size > 1) status = "ambiguous";

  const merged: ProductLinkageSourceRow = {
    resolved_product_id: resolvedId,
    identifier_resolution_status: status,
    identifier_resolution_confidence: confidence,
    sku: trimOrNull(rows[0]?.sku),
    fnsku: trimOrNull(rows[0]?.fnsku),
    description: epCatalogNameFromRow(rows[0]!) ?? fallbacks[0],
  };
  return buildProductLinkageDisplayContract(merged, productNameById);
}

export async function fetchResolvedProductNamesForExpectedRows(
  supabase: ProductsLookupClient,
  rows: Record<string, unknown>[],
): Promise<Map<string, string>> {
  const ids = rows.map((r) => trimOrNull(r.resolved_product_id)).filter(Boolean) as string[];
  return fetchProductNamesByResolvedIds(supabase, ids);
}

export function primaryLabelForExpectedPackageLinkage(linkage: ProductLinkageDisplayContract): string {
  return productLinkagePrimaryLabel(linkage);
}
