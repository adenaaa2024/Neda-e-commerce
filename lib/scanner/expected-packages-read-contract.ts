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

/** COALESCE persisted resolver, optional legacy FK, optional expected_product_id column. */
export function deriveExpectedPackageEffectiveProductId(row: Record<string, unknown>): string | null {
  return (
    trimOrNull(row.resolved_product_id) ??
    trimOrNull(row.expected_product_id) ??
    trimOrNull(row.product_id) ??
    null
  );
}

function normStatus(v: unknown): string | null {
  const s = trimOrNull(v);
  return s ? s.toLowerCase() : null;
}

function epCatalogNameFromRow(row: Record<string, unknown>): string | null {
  const prod = row.products as { product_name?: string } | null | undefined;
  return trimOrNull(prod?.product_name);
}

function inventoryViewDisplayName(invRow: VInventoryStatusRow): string | null {
  return trimOrNull(invRow.product_display_name) ?? trimOrNull(invRow.product_name);
}

function normalizeDisplayLinkageStatus(
  status: string | null,
  effectiveId: string | null,
  displayName: string | null,
): string | null {
  const st = normStatus(status);
  if (!effectiveId) return st ?? "unresolved";
  if (st === "ambiguous" || st === "mismatch") return st;
  if (displayName || st === "resolved" || st === "matched") return "resolved";
  return st ?? "unresolved";
}

function expectedPackageProductId(row: Record<string, unknown>): string | null {
  return (
    trimOrNull(row.resolved_product_id) ??
    trimOrNull(row.product_id) ??
    trimOrNull(row.resolved_catalog_product_id)
  );
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
  const effectiveId = deriveExpectedPackageEffectiveProductId(row);
  const source: ProductLinkageSourceRow = {
    resolved_product_id: effectiveId,
    identifier_resolution_status: row.identifier_resolution_status as string | null | undefined,
    identifier_resolution_confidence: row.identifier_resolution_confidence as number | null | undefined,
    sku: row.sku as string | null | undefined,
    fnsku: row.fnsku as string | null | undefined,
    description: epCatalogNameFromRow(row) ?? undefined,
  };
  const linkage = buildProductLinkageDisplayContract(source, productNameById);
  if (!linkage.product_name?.trim() && effectiveId && productNameById.get(effectiveId)) {
    return { ...linkage, product_name: productNameById.get(effectiveId)! };
  }
  return linkage;
}

function mergeInventoryViewIntoLinkage(
  linkage: ProductLinkageDisplayContract,
  invRow: VInventoryStatusRow,
  productNameById: ReadonlyMap<string, string>,
): ProductLinkageDisplayContract {
  const invResolved = trimOrNull(invRow.resolved_product_id) ?? trimOrNull(invRow.product_id);
  const invName = inventoryViewDisplayName(invRow);
  const invStatus = normStatus(invRow.product_linkage_status);
  const effectiveId = trimOrNull(linkage.resolved_product_id) ?? invResolved;
  const nameMap = new Map(productNameById);
  if (effectiveId && invName) nameMap.set(effectiveId, invName);
  const merged = buildProductLinkageDisplayContract(
    {
      resolved_product_id: effectiveId,
      product_name: invName ?? undefined,
      product_display_name: trimOrNull(invRow.product_display_name) ?? undefined,
      identifier_resolution_status: normalizeDisplayLinkageStatus(
        linkage.identifier_resolution_status ?? invStatus,
        effectiveId,
        invName ?? trimOrNull(linkage.product_name),
      ),
      identifier_resolution_confidence:
        linkage.identifier_resolution_confidence ?? invRow.identifier_resolution_confidence,
      sku: invRow.sku ?? undefined,
      fnsku: invRow.fnsku ?? undefined,
      description: invName ?? undefined,
    },
    nameMap,
  );
  if (merged.product_name?.trim() && effectiveId) {
    return {
      ...merged,
      resolved_product_id: effectiveId,
      identifier_resolution_status: merged.identifier_resolution_status ?? "resolved",
    };
  }
  return merged;
}

/** Inventory view row + optional matching `expected_packages` detail for linkage. */
export function buildInventoryViewProductLinkage(
  invRow: VInventoryStatusRow,
  epRow: Record<string, unknown> | null | undefined,
  productNameById: ReadonlyMap<string, string>,
): ProductLinkageDisplayContract {
  const invResolved = trimOrNull(invRow.resolved_product_id) ?? trimOrNull(invRow.product_id);
  const invName = inventoryViewDisplayName(invRow);
  const invStatus = normStatus(invRow.product_linkage_status);
  const nameMap = new Map(productNameById);
  if (invResolved && invName) nameMap.set(invResolved, invName);

  if (epRow) {
    const linkage = buildExpectedPackageProductLinkage(epRow, nameMap);
    return mergeInventoryViewIntoLinkage(linkage, invRow, nameMap);
  }

  const effectiveId = invResolved;
  const status = normalizeDisplayLinkageStatus(invStatus, effectiveId, invName);
  return buildProductLinkageDisplayContract(
    {
      resolved_product_id: effectiveId,
      product_name: invName ?? undefined,
      product_display_name: trimOrNull(invRow.product_display_name) ?? undefined,
      identifier_resolution_status: status,
      identifier_resolution_confidence: invRow.identifier_resolution_confidence,
      description: invName ?? undefined,
      fnsku: invRow.fnsku,
      sku: invRow.sku,
    },
    nameMap,
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
    const rid = trimOrNull(r.resolved_product_id) ?? deriveExpectedPackageEffectiveProductId(r);
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
  const ids = rows
    .map((r) => deriveExpectedPackageEffectiveProductId(r))
    .filter(Boolean) as string[];
  return fetchProductNamesByResolvedIds(supabase, ids);
}

export function primaryLabelForExpectedPackageLinkage(linkage: ProductLinkageDisplayContract): string {
  return productLinkagePrimaryLabel(linkage);
}
