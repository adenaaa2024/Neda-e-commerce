import type { SupabaseClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE } from "@/app/returns/returns-constants";
import { shouldExcludeReturnItemFromScannerCounts } from "@/lib/scanner/return-items-test-data-guard";
import type {
  ProductLinkageDisplayContract,
  ProductsLookupClient,
} from "@/lib/scanner/product-linkage-display-contract";
import {
  deriveExpectedPackageEffectiveProductId,
  fetchResolvedProductNamesForExpectedRows,
  mergeExpectedPackageRowsProductLinkage,
  primaryLabelForExpectedPackageLinkage,
  scanQuantityVariance,
} from "@/lib/scanner/expected-packages-read-contract";
import { normalizeScannerProductLinkageDisplay } from "@/lib/scanner/normalize-scanner-product-linkage-display";
import { isUuidString } from "@/lib/uuid";
import { findPackageIdsByTrackingForStore } from "@/lib/scanner/package-tracking-lookup";
import {
  isLikelyShipmentTrackingCode,
  resolveExpectedPackagesByTracking,
  type TrackingResolveOptions,
} from "@/lib/search/tracking-resolve";
import { normalizeTrackingKey } from "./tracking-normalize";

function formatLoadErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Scanned-unit merge is best-effort; RLS or schema drift on `return_items`/`packages` must not blank expected lines. */
function emptyScannedMapAfterWarn(scope: string, err: unknown): Map<string, number> {
  console.warn(`[operator-tracking-expectations] ${scope} — scanned counts skipped:`, formatLoadErrorMessage(err));
  return new Map();
}

/** One aggregated row per (SKU, FNSKU, Disposition) from `expected_packages`. */
export type TrackingExpectedGroup = {
  groupKey: string;
  sku: string;
  fnsku: string;
  asin: string;
  disposition: string;
  productLabel: string;
  expectedQty: number;
  /** Populated when `expected_packages` carries NEXT-SCANNER-02 resolution columns. */
  identifier_resolution_status?: string | null;
  product_match_status?: string | null;
  product_review_required?: boolean;
  /** When present on `expected_packages`, preferred for scanned-unit merge (product_id-first). */
  expected_product_id?: string | null;
};

/** Display row after merging scanned counts from `return_items`. */
export type TrackingOperatorLine = TrackingExpectedGroup & {
  scannedQty: number;
  remainingQty: number;
  /** Scanned − expected (signed). */
  varianceQty: number;
  /** Neda product linkage read contract (null-safe; never requires `product_id`). */
  product_linkage: ProductLinkageDisplayContract;
};

export type TrackingExpectationTotals = {
  expectedUnits: number;
  scannedUnits: number;
  remainingUnits: number;
};

function normSkuFnskuDisposition(row: Record<string, unknown>): { sku: string; fnsku: string; disposition: string; key: string } {
  const sku = String(row.sku ?? "").trim();
  const fnsku = String(row.fnsku ?? "").trim();
  const disposition = String(row.disposition ?? "").trim();
  const key = `${sku.toLowerCase()}\u0000${fnsku.toLowerCase()}\u0000${disposition.toLowerCase()}`;
  return { sku, fnsku, disposition, key };
}

function sfKey(sku: string, fnsku: string): string {
  return `${sku.toLowerCase()}\u0000${fnsku.toLowerCase()}`;
}

function productIdFromExpectedRow(raw: Record<string, unknown>): string | null {
  const id = deriveExpectedPackageEffectiveProductId(raw);
  if (id && isUuidString(id)) return id;
  const catalog = String(raw.resolved_catalog_product_id ?? "").trim();
  if (isUuidString(catalog)) return catalog;
  return null;
}

export type ReturnItemsScannedCountMaps = {
  bySkuFnsku: Map<string, number>;
  byProductId: Map<string, number>;
};

function accumulateReturnItemScannedCounts(
  retRows:
    | {
        sku?: string | null;
        fnsku?: string | null;
        resolved_product_id?: string | null;
        scanned_quantity?: number | null;
        item_name?: string | null;
        product_identifier?: string | null;
        notes?: string | null;
      }[]
    | null
    | undefined,
): ReturnItemsScannedCountMaps {
  const bySkuFnsku = new Map<string, number>();
  const byProductId = new Map<string, number>();
  for (const r of retRows ?? []) {
    if (
      shouldExcludeReturnItemFromScannerCounts({
        item_name: r.item_name,
        sku: r.sku,
        fnsku: r.fnsku,
        product_identifier: r.product_identifier,
        notes: r.notes,
      })
    ) {
      continue;
    }
    const sku = String(r.sku ?? "").trim();
    const fnsku = String(r.fnsku ?? "").trim();
    const k = sfKey(sku, fnsku);
    const qtyRaw = Number(r.scanned_quantity ?? 1);
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.trunc(qtyRaw) : 1;
    bySkuFnsku.set(k, (bySkuFnsku.get(k) ?? 0) + qty);
    const pid = String(r.resolved_product_id ?? "").trim();
    if (isUuidString(pid)) {
      byProductId.set(pid, (byProductId.get(pid) ?? 0) + qty);
    }
  }
  return { bySkuFnsku, byProductId };
}

/** Strip LIKE wildcards from user/scanned input so ilike patterns stay safe. */
export function sanitizeTrackingForIlikePattern(raw: string): string {
  return raw.trim().replace(/%/g, "").replace(/_/g, "");
}

function trackingRowMatchesScanned(
  row: { tracking_number?: string | null },
  scannedNormalizedKey: string,
): "exact" | "fuzzy" | "none" {
  const h = normalizeTrackingKey(String(row.tracking_number ?? ""));
  if (!h || !scannedNormalizedKey) return "none";
  if (h === scannedNormalizedKey) return "exact";
  if (scannedNormalizedKey.length >= 4 && (h.includes(scannedNormalizedKey) || scannedNormalizedKey.includes(h))) {
    return "fuzzy";
  }
  return "none";
}

/**
 * Fetch `expected_packages` for org + store + tracking (case-insensitive tracking match).
 */
/** Live DB: `expected_packages.asin` is absent — do not select it (PostgREST 42703). */
const EP_SELECT =
  "sku, fnsku, disposition, expected_scan_quantity, order_id, tracking_number";

/**
 * Lightweight EP list select including scanner linkage columns (for tracking/pallet snapshots).
 * Use only after `20260717120000_scanner_product_linkage_columns.sql` is applied.
 */
export const EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT =
  EP_SELECT +
  ", identifier_resolution_status, identifier_resolution_confidence, product_match_status, product_review_required, " +
  "expected_product_id, product_id, resolved_product_id, resolved_catalog_product_id";

/** Full rows for operator item scan (includes PK + warehouse scan counters when present). */
export const EP_DETAIL_SELECT =
  "id, sku, fnsku, disposition, expected_scan_quantity, actual_scanned_count, order_id, tracking_number, id_slip_contents";

/**
 * After `20260717120000_scanner_product_linkage_columns.sql`, use this select in detail fetches
 * so scanner UI receives resolution columns on `expected_packages`.
 */
export const EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT =
  EP_DETAIL_SELECT +
  ", identifier_resolution_status, identifier_resolution_confidence, product_match_status, product_review_required, " +
  "expected_product_id, product_id, resolved_product_id, resolved_catalog_product_id";

/**
 * Attach optional nested `products` from catalog lookup (expected_packages has no product_name).
 * UI should use: row.products?.product_name || row.sku || row.fnsku
 */
async function enrichExpectedPackageDetailRowsWithCatalogLabels(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const base = rows ?? [];
  const safeIn = Array.isArray(base) ? base : [];
  if (!safeIn.length) return [];

  const ids = [...new Set(safeIn.map((r) => productIdFromExpectedRow(r)).filter(Boolean))] as string[];
  if (!ids.length) {
    return safeIn.map((r) => (r && typeof r === "object" ? { ...r, products: null } : {}));
  }

  const nameById = new Map<string, string>();
  const chunkSize = 80;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const primary = await supabase
      .from("products")
      .select("id, product_name")
      .in("id", chunk);

    const res = primary.error
      ? await supabase
          .from("products")
          .select("id, name")
          .in("id", chunk)
      : primary;

    if (res.error) break;

    const pdata = res.data ?? [];
    const safeP = Array.isArray(pdata) ? pdata : [];
    for (const p of safeP) {
      const row = p as Record<string, unknown>;
      const id = String(row.id ?? "").trim();
      const nm = String(row.product_name ?? row.name ?? "").trim();
      if (id && nm) nameById.set(id, nm);
    }
  }

  return safeIn.map((r) => {
    if (!r || typeof r !== "object") return {};
    const id = productIdFromExpectedRow(r);
    const nm = id ? nameById.get(id) : undefined;
    return {
      ...r,
      products: nm ? { product_name: nm } : null,
    };
  });
}

function asSafeRowArray(data: unknown): Record<string, unknown>[] {
  const rows = data ?? [];
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function isMissingColumnError(err: unknown): boolean {
  const msg = formatLoadErrorMessage(err).toLowerCase();
  return (
    msg.includes("42703") ||
    (msg.includes("column") &&
      (msg.includes("does not exist") || msg.includes("undefined column") || msg.includes("schema cache")))
  );
}

/** When NEXT-SCANNER-02 migration is not applied, fall back to base EP selects. */
function expectedPackageSelectFallback(selectColumns: string): string | null {
  if (selectColumns === EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT) return EP_DETAIL_SELECT;
  if (selectColumns === EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT) return EP_SELECT;
  return null;
}

export { isLikelyShipmentTrackingCode };

export type FetchExpectedPackagesOptions = {
  /**
   * When true and the exact indexed lookup returns no rows, skip the expensive
   * ILIKE / 14 000-row fallback scan for codes that match shipment tracking formats.
   * The caller should surface "No exact match — run deep search for unusual formatting."
   * Defaults to false (existing full-scan behavior preserved).
   */
  skipExpensiveFallback?: boolean;
  /**
   * Phase 9H — Shipment Entry gate: after RPC miss, skip legacy multi-query identity
   * fallback in {@link fetchIdentityStatusForScanCode}. Deep search passes false.
   */
  gateFastNegative?: boolean;
};

function toTrackingResolveOptions(options?: FetchExpectedPackagesOptions): TrackingResolveOptions {
  const fast = Boolean(options?.skipExpensiveFallback || options?.gateFastNegative);
  return {
    deepSearch: !fast,
    skipExpensiveFallback: fast,
  };
}

async function fetchExpectedPackagesForTrackingWithSelect(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  selectColumns: string,
  options?: FetchExpectedPackagesOptions,
): Promise<Record<string, unknown>[]> {
  return resolveExpectedPackagesByTracking(
    supabase,
    organizationId,
    storeId,
    trackingNumber,
    selectColumns,
    toTrackingResolveOptions(options),
  );
}

export async function fetchExpectedPackagesForTracking(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  selectColumns: string = EP_SELECT,
  options?: FetchExpectedPackagesOptions,
): Promise<Record<string, unknown>[]> {
  try {
    return await fetchExpectedPackagesForTrackingWithSelect(
      supabase,
      organizationId,
      storeId,
      trackingNumber,
      selectColumns,
      options,
    );
  } catch (err) {
    const fallback = expectedPackageSelectFallback(selectColumns);
    if (!fallback || !isMissingColumnError(err)) throw err;
    console.warn(
      `[operator-tracking-expectations] expected_packages select missing columns; retrying with base select.`,
      formatLoadErrorMessage(err),
    );
    return fetchExpectedPackagesForTrackingWithSelect(
      supabase,
      organizationId,
      storeId,
      trackingNumber,
      fallback,
      options,
    );
  }
}

/** Distinct non-empty tracking numbers from packages on a pallet. */
export async function fetchDistinctTrackingNumbersForPallet(
  supabase: SupabaseClient,
  organizationId: string,
  palletId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("packages")
    .select("tracking_number")
    .eq("organization_id", organizationId)
    .eq("pallet_id", palletId)
    .is("deleted_at", null);

  if (error) throw error;
  const set = new Set<string>();
  for (const row of data ?? []) {
    const t = String((row as { tracking_number?: string | null }).tracking_number ?? "").trim();
    if (t) set.add(t);
  }
  return [...set];
}

/**
 * All `expected_packages` rows for any of the given tracking numbers (exact match per package snapshot).
 */
export async function fetchExpectedPackagesForTrackingNumbers(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumbers: string[],
  selectColumns: string = EP_SELECT,
): Promise<Record<string, unknown>[]> {
  const uniq = [...new Set(trackingNumbers.map((t) => t.trim()).filter(Boolean))];
  if (!uniq.length) return [];

  const merged: Record<string, unknown>[] = [];
  const seenId = new Set<string>();

  for (const tn of uniq) {
    const fetched = await fetchExpectedPackagesForTracking(supabase, organizationId, storeId, tn, selectColumns);
    const rows = Array.isArray(fetched) ? fetched : [];
    for (const r of rows) {
      const id = String((r as { id?: string }).id ?? "");
      const dedupe = id || `${(r as { sku?: string }).sku}-${(r as { fnsku?: string }).fnsku}-${(r as { order_id?: string }).order_id}`;
      if (seenId.has(dedupe)) continue;
      seenId.add(dedupe);
      merged.push(r);
    }
  }

  return merged;
}

/**
 * Raw `expected_packages` rows (with `id`) for smart resolver + `actual_scanned_count` bumps.
 */
/**
 * Load full `expected_packages` detail rows by primary key for the active store.
 * Used after `v_inventory_status` matches so the gate can reuse EP catalog enrichment.
 */
export async function fetchExpectedPackageDetailRowsByIds(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  const uniq = [...new Set(ids.map((i) => String(i ?? "").trim()).filter(Boolean))];
  if (!uniq.length) return [];

  const merged: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const CHUNK = 120;

  let detailSelect = EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT;

  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    let { data, error } = await supabase
      .from("expected_packages")
      .select(detailSelect)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .in("id", chunk);
    if (error && isMissingColumnError(error)) {
      const fallback = expectedPackageSelectFallback(detailSelect);
      if (fallback) {
        console.warn(
          `[operator-tracking-expectations] expected_packages detail select missing columns; retrying with base select.`,
          formatLoadErrorMessage(error),
        );
        detailSelect = fallback;
        ({ data, error } = await supabase
          .from("expected_packages")
          .select(detailSelect)
          .eq("organization_id", organizationId)
          .eq("store_id", storeId)
          .in("id", chunk));
      }
    }
    if (error) throw error;
    for (const r of asSafeRowArray(data)) {
      const id = String((r as { id?: string }).id ?? "");
      if (id && !seen.has(id)) {
        seen.add(id);
        merged.push(r);
      }
    }
  }

  return enrichExpectedPackageDetailRowsWithCatalogLabels(supabase, organizationId, storeId, merged);
}

export async function fetchExpectedPackageDetailRowsForParent(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  ctx: { trackingNumber: string | null; palletId: string | null },
): Promise<Record<string, unknown>[]> {
  let data: unknown = null;

  const tn = ctx.trackingNumber?.trim();
  if (tn) {
    data = await fetchExpectedPackagesForTracking(
      supabase,
      organizationId,
      storeId,
      tn,
      EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT,
    );
  } else {
    const palletId = ctx.palletId?.trim();
    if (!palletId) {
      return [];
    }
    const trackings = await fetchDistinctTrackingNumbersForPallet(supabase, organizationId, palletId);
    if (!Array.isArray(trackings) || !trackings.length) {
      return [];
    }
    data = await fetchExpectedPackagesForTrackingNumbers(
      supabase,
      organizationId,
      storeId,
      trackings,
      EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT,
    );
  }

  const rows = data ?? [];
  const safeRows = Array.isArray(rows) ? rows : [];

  const enriched = await enrichExpectedPackageDetailRowsWithCatalogLabels(
    supabase,
    organizationId,
    storeId,
    safeRows as Record<string, unknown>[],
  );
  const out = enriched ?? [];
  return Array.isArray(out) ? out : [];
}

/** Demo EP detail rows (IDs are synthetic — inserts use live IDs only with Supabase). */
export function mockExpectedPackageDetailRows(): Record<string, unknown>[] {
  return [
    {
      id: "00000000-0000-4000-8000-000000000001",
      sku: "DEMO-SKU-A",
      fnsku: "X003ZN3TJT",
      disposition: "Sellable",
      expected_scan_quantity: 15,
      actual_scanned_count: 4,
      order_id: "DEMO-ORDER",
      tracking_number: "PALLET-DEMO-TRK",
      id_slip_contents: "DEMO-SLIP-001",
      products: { product_name: "Milk Chocolate Bar 6.35 oz" },
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      sku: "DEMO-SKU-A",
      fnsku: "X003ZN3TJT",
      disposition: "Defective",
      expected_scan_quantity: 5,
      actual_scanned_count: 0,
      order_id: "DEMO-ORDER",
      tracking_number: "PALLET-DEMO-TRK",
      id_slip_contents: "DEMO-SLIP-001",
      products: { product_name: "Milk Chocolate Bar 6.35 oz" },
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      sku: "DEMO-SKU-B",
      fnsku: "X009AB12CDE",
      disposition: "Sellable",
      expected_scan_quantity: 33,
      actual_scanned_count: 0,
      order_id: "DEMO-ORDER",
      tracking_number: "PALLET-DEMO-TRK",
      id_slip_contents: "DEMO-SLIP-001",
      products: { product_name: "Dark Chocolate 12 oz" },
    },
  ];
}

/** Scanned-unit counts grouped by sku+fnsku for all `return_items` under packages on this pallet. */
export async function fetchReturnItemsScannedBySkuFnskuForPallet(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  palletId: string,
): Promise<Map<string, number>> {
  const maps = await fetchReturnItemsScannedCountsForPallet(supabase, organizationId, storeId, palletId);
  return maps.bySkuFnsku;
}

export async function fetchReturnItemsScannedCountsForPallet(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  palletId: string,
): Promise<ReturnItemsScannedCountMaps> {
  const empty = (): ReturnItemsScannedCountMaps => ({
    bySkuFnsku: new Map(),
    byProductId: new Map(),
  });

  const { data: pkgs, error: pkgErr } = await supabase
    .from("packages")
    .select("id, store_id")
    .eq("organization_id", organizationId)
    .eq("pallet_id", palletId)
    .is("deleted_at", null);

  if (pkgErr) throw pkgErr;

  const pkgIds = (pkgs ?? [])
    .filter((p) => {
      const sid = (p as { store_id?: string | null }).store_id;
      return sid == null || sid === storeId;
    })
    .map((p) => String((p as { id: string }).id));

  if (!pkgIds.length) return empty();

  const { data: retRows, error: retErr } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("sku, fnsku, resolved_product_id, item_name, product_identifier, notes")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .in("package_id", pkgIds);

  if (retErr) throw retErr;

  return accumulateReturnItemScannedCounts(retRows ?? []);
}

function normSkuFnskuDispositionKey(raw: Record<string, unknown>): string {
  const sku = String(raw.sku ?? "").trim();
  const fnsku = String(raw.fnsku ?? "").trim();
  const disposition = String(raw.disposition ?? "").trim();
  return `${sku.toLowerCase()}\u0000${fnsku.toLowerCase()}\u0000${disposition.toLowerCase()}`;
}

/** Attach merged `expected_packages` product linkage + display label per grouped line. */
export async function enrichTrackingOperatorLinesWithProductLinkage(
  supabase: SupabaseClient,
  lines: TrackingOperatorLine[],
  rawExpectedRows: Record<string, unknown>[],
  organizationId: string,
  storeId: string | null,
): Promise<TrackingOperatorLine[]> {
  const nameMap = await fetchResolvedProductNamesForExpectedRows(
    supabase as unknown as ProductsLookupClient,
    rawExpectedRows,
  );
  const rowsByKey = new Map<string, Record<string, unknown>[]>();
  for (const r of rawExpectedRows) {
    const key = normSkuFnskuDispositionKey(r);
    const arr = rowsByKey.get(key) ?? [];
    arr.push(r);
    rowsByKey.set(key, arr);
  }
  const org = String(organizationId ?? "").trim();
  return Promise.all(
    lines.map(async (line) => {
      const bucket = rowsByKey.get(line.groupKey) ?? [];
      const merged = mergeExpectedPackageRowsProductLinkage(bucket, nameMap);
      const head = bucket[0] ?? {};
      const product_linkage =
        org && isUuidString(org)
          ? await normalizeScannerProductLinkageDisplay(supabase, {
              organizationId: org,
              storeId: (storeId ?? String(head.store_id ?? "").trim()) || null,
              sourceTable: "expected_packages",
              sourceRowId: typeof head.id === "string" ? head.id : null,
              row: {
                resolved_product_id: merged.resolved_product_id,
                product_id: deriveExpectedPackageEffectiveProductId(head),
                identifier_resolution_status: merged.identifier_resolution_status,
                identifier_resolution_confidence: merged.identifier_resolution_confidence,
                product_name: merged.product_name,
                fnsku: typeof head.fnsku === "string" ? head.fnsku : null,
                sku: typeof head.sku === "string" ? head.sku : null,
                asin: typeof head.asin === "string" ? head.asin : null,
                description: merged.fallback_display_name,
              },
            })
          : merged;
      const label = primaryLabelForExpectedPackageLinkage(product_linkage);
      return {
        ...line,
        product_linkage,
        productLabel: label && label !== "Line item" ? label : line.productLabel,
      };
    }),
  );
}

export async function loadPalletExpectationSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  palletId: string,
): Promise<{
  lines: TrackingOperatorLine[];
  totals: TrackingExpectationTotals;
  rawRowCount: number;
  expectedTrackingNumbers: string[];
}> {
  const trackings = await fetchDistinctTrackingNumbersForPallet(supabase, organizationId, palletId);
  if (!trackings.length) {
    return {
      lines: [],
      totals: { expectedUnits: 0, scannedUnits: 0, remainingUnits: 0 },
      rawRowCount: 0,
      expectedTrackingNumbers: [],
    };
  }

  const raw = await fetchExpectedPackagesForTrackingNumbers(
    supabase,
    organizationId,
    storeId,
    trackings,
    EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT,
  );
  const groups = aggregateExpectedPackagesBySkuFnskuDisposition(raw);
  let scannedMaps: ReturnItemsScannedCountMaps;
  try {
    scannedMaps = await fetchReturnItemsScannedCountsForPallet(supabase, organizationId, storeId, palletId);
  } catch (e) {
    scannedMaps = { bySkuFnsku: emptyScannedMapAfterWarn("loadPalletExpectationSnapshot", e), byProductId: new Map() };
  }
  const { lines: baseLines, totals } = mergeExpectedWithScannedCounts(
    groups,
    scannedMaps.bySkuFnsku,
    scannedMaps.byProductId,
  );
  const lines = await enrichTrackingOperatorLinesWithProductLinkage(
    supabase,
    baseLines,
    raw,
    organizationId,
    storeId,
  );
  return {
    lines,
    totals,
    rawRowCount: raw.length,
    expectedTrackingNumbers: distinctTrackingNumbersFromExpectedPackageRows(raw),
  };
}

/** Demo EP snapshot when pallet is locked without Supabase. */
export function mockPalletExpectationSnapshot(): {
  lines: TrackingOperatorLine[];
  totals: TrackingExpectationTotals;
  rawRowCount: number;
  expectedTrackingNumbers: string[];
} {
  return mockTrackingExpectationSnapshot("PALLET-DEMO-TRK");
}

/** Distinct non-empty `tracking_number` values from raw `expected_packages` rows (for scan validation). */
export function distinctTrackingNumbersFromExpectedPackageRows(rows: Record<string, unknown>[]): string[] {
  const set = new Set<string>();
  for (const raw of rows) {
    const t = String((raw as { tracking_number?: string | null }).tracking_number ?? "").trim();
    if (t) set.add(t);
  }
  return [...set];
}

/**
 * SUM `expected_scan_quantity` for each distinct SKU / FNSKU / Disposition group.
 */
function worseIdentifierResolution(a: string | null | undefined, b: string | null | undefined): string | null {
  const order = ["resolved", "unresolved", "ambiguous"];
  const score = (s: string | null | undefined) => {
    const i = order.indexOf(String(s ?? "").trim().toLowerCase());
    return i < 0 ? -1 : i;
  };
  return score(b) > score(a) ? (b ?? null) : (a ?? null);
}

function mergeProductMatchStatus(a: string | null | undefined, b: string | null | undefined): string | null {
  const x = String(a ?? "").trim().toLowerCase();
  const y = String(b ?? "").trim().toLowerCase();
  if (x === "mismatch" || y === "mismatch") return "mismatch";
  if (x === "match" || y === "match") return "match";
  return (a as string | null) ?? (b as string | null) ?? null;
}

export function aggregateExpectedPackagesBySkuFnskuDisposition(rows: Record<string, unknown>[]): TrackingExpectedGroup[] {
  const map = new Map<
    string,
    {
      sku: string;
      fnsku: string;
      asin: string;
      disposition: string;
      expectedQty: number;
      orderHint: string;
      identifier_resolution_status: string | null;
      product_match_status: string | null;
      product_review_required: boolean;
      expected_product_id: string | null;
    }
  >();

  for (const raw of rows) {
    const { sku, fnsku, disposition, key } = normSkuFnskuDisposition(raw);
    const qty = Number(raw.expected_scan_quantity ?? 0);
    const safeQty = Number.isFinite(qty) ? qty : 0;
    const orderId = String(raw.order_id ?? "").trim();
    const asin = String((raw as { asin?: string | null }).asin ?? "").trim();
    const idRes = String((raw as { identifier_resolution_status?: string | null }).identifier_resolution_status ?? "").trim();
    const pm = String((raw as { product_match_status?: string | null }).product_match_status ?? "").trim();
    const pr = Boolean((raw as { product_review_required?: boolean | null }).product_review_required);
    const rowPid = productIdFromExpectedRow(raw);

    const prev = map.get(key);
    if (prev) {
      prev.expectedQty += safeQty;
      if (!prev.orderHint && orderId) prev.orderHint = orderId;
      if (!prev.asin && asin) prev.asin = asin;
      prev.identifier_resolution_status = worseIdentifierResolution(prev.identifier_resolution_status, idRes || null);
      prev.product_match_status = mergeProductMatchStatus(prev.product_match_status, pm || null);
      prev.product_review_required = prev.product_review_required || pr;
      if (rowPid && prev.expected_product_id && prev.expected_product_id !== rowPid) {
        prev.expected_product_id = null;
      } else if (rowPid && !prev.expected_product_id) {
        prev.expected_product_id = rowPid;
      }
    } else {
      map.set(key, {
        sku,
        fnsku,
        asin,
        disposition,
        expectedQty: safeQty,
        orderHint: orderId,
        identifier_resolution_status: idRes || null,
        product_match_status: pm || null,
        product_review_required: pr,
        expected_product_id: rowPid,
      });
    }
  }

  const out: TrackingExpectedGroup[] = [];
  for (const [groupKey, v] of map) {
    const productLabel = v.sku || v.fnsku || v.orderHint || "Item";
    out.push({
      groupKey,
      sku: v.sku,
      fnsku: v.fnsku,
      asin: v.asin,
      disposition: v.disposition,
      productLabel,
      expectedQty: v.expectedQty,
      identifier_resolution_status: v.identifier_resolution_status,
      product_match_status: v.product_match_status,
      product_review_required: v.product_review_required,
      expected_product_id: v.expected_product_id,
    });
  }

  out.sort((a, b) => (a.fnsku || a.sku).localeCompare(b.fnsku || b.sku, undefined, { sensitivity: "base" }));
  return out;
}

/**
 * Count `return_items` rows (units) tied to packages sharing this tracking, scoped org + store.
 * Grouped by SKU + FNSKU (`return_items` has no disposition — attribution is done proportionally later).
 */
export async function fetchReturnItemsScannedBySkuFnskuForTracking(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): Promise<Map<string, number>> {
  const maps = await fetchReturnItemsScannedCountsForTracking(supabase, organizationId, storeId, trackingNumber);
  return maps.bySkuFnsku;
}

export async function fetchReturnItemsScannedCountsForPackageIds(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  packageIds: string[],
): Promise<ReturnItemsScannedCountMaps> {
  const empty = (): ReturnItemsScannedCountMaps => ({
    bySkuFnsku: new Map(),
    byProductId: new Map(),
  });
  const pkgIds = [...new Set(packageIds.filter(Boolean))];
  if (!pkgIds.length) return empty();

  const { data: retRows, error: retErr } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("sku, fnsku, resolved_product_id, scanned_quantity, item_name, product_identifier, notes")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .in("package_id", pkgIds);

  if (retErr) throw retErr;
  return accumulateReturnItemScannedCounts(retRows ?? []);
}

export async function fetchReturnItemsScannedCountsForTracking(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): Promise<ReturnItemsScannedCountMaps> {
  const empty = (): ReturnItemsScannedCountMaps => ({
    bySkuFnsku: new Map(),
    byProductId: new Map(),
  });

  const pkgIds = await findPackageIdsByTrackingForStore(
    supabase,
    organizationId,
    storeId,
    trackingNumber,
  );
  if (!pkgIds.length) return empty();

  return fetchReturnItemsScannedCountsForPackageIds(supabase, organizationId, storeId, pkgIds);
}

/**
 * Split SKU+FNSKU scanned totals across disposition rows proportionally by expected qty.
 * When `expected_product_id` is set on a group, uses `scannedByProductId` first (product_id-first model).
 */
export function mergeExpectedWithScannedCounts(
  groups: TrackingExpectedGroup[],
  scannedBySkuFnsku: Map<string, number>,
  scannedByProductId: Map<string, number> = new Map(),
): { lines: TrackingOperatorLine[]; totals: TrackingExpectationTotals } {
  /** sku+fnsku → list of group indexes */
  const bySf = new Map<string, number[]>();
  groups.forEach((g, i) => {
    const k = sfKey(g.sku, g.fnsku);
    const arr = bySf.get(k) ?? [];
    arr.push(i);
    bySf.set(k, arr);
  });

  const scannedAllocated = new Map<number, number>();
  for (let i = 0; i < groups.length; i++) scannedAllocated.set(i, 0);

  for (const [, idxs] of bySf) {
    const k0 = sfKey(groups[idxs[0]].sku, groups[idxs[0]].fnsku);
    const productIds = new Set(
      idxs
        .map((i) => groups[i].expected_product_id?.trim())
        .filter((id): id is string => Boolean(id && isUuidString(id))),
    );
    const totalScanned =
      productIds.size === 1
        ? (scannedByProductId.get([...productIds][0]!) ?? scannedBySkuFnsku.get(k0) ?? 0)
        : (scannedBySkuFnsku.get(k0) ?? 0);
    let sumExpected = 0;
    for (const i of idxs) sumExpected += Math.max(0, groups[i].expectedQty);

    if (totalScanned <= 0) continue;

    if (sumExpected <= 0) {
      scannedAllocated.set(idxs[0], (scannedAllocated.get(idxs[0]) ?? 0) + totalScanned);
      continue;
    }

    const parts = idxs.map((i) => {
      const exp = Math.max(0, groups[i].expectedQty);
      const exact = (totalScanned * exp) / sumExpected;
      return { i, exp, exact, floor: Math.floor(exact) };
    });

    let rem = totalScanned - parts.reduce((s, p) => s + p.floor, 0);
    parts.forEach((p) => scannedAllocated.set(p.i, p.floor));

    const order = [...parts].sort((a, b) => {
      const fracA = a.exact - Math.floor(a.exact);
      const fracB = b.exact - Math.floor(b.exact);
      return fracB - fracA;
    });
    let o = 0;
    while (rem > 0 && order.length > 0) {
      const p = order[o % order.length];
      scannedAllocated.set(p.i, (scannedAllocated.get(p.i) ?? 0) + 1);
      rem -= 1;
      o += 1;
    }
  }

  let expectedUnits = 0;
  let scannedUnits = 0;

  const lines: TrackingOperatorLine[] = groups.map((g, i) => {
    const scannedQty = scannedAllocated.get(i) ?? 0;
    expectedUnits += Math.max(0, g.expectedQty);
    scannedUnits += scannedQty;
    const remainingQty = Math.max(0, g.expectedQty - scannedQty);
    const varianceQty = scanQuantityVariance(g.expectedQty, scannedQty);
    const emptyLinkage = mergeExpectedPackageRowsProductLinkage([], new Map());
    return {
      ...g,
      scannedQty,
      remainingQty,
      varianceQty,
      product_linkage: emptyLinkage,
    };
  });

  const totals: TrackingExpectationTotals = {
    expectedUnits,
    scannedUnits,
    remainingUnits: Math.max(0, expectedUnits - scannedUnits),
  };

  return { lines, totals };
}

/** Re-merge expected groups with live scanned maps while preserving enriched linkage labels. */
export function remergeTrackingOperatorLineScannedQty(
  enrichedLines: TrackingOperatorLine[],
  scannedMaps: ReturnItemsScannedCountMaps,
): TrackingOperatorLine[] {
  if (!enrichedLines.length) return [];
  const groups: TrackingExpectedGroup[] = enrichedLines.map(
    ({ scannedQty: _s, remainingQty: _r, varianceQty: _v, product_linkage: _p, ...group }) => group,
  );
  const { lines } = mergeExpectedWithScannedCounts(
    groups,
    scannedMaps.bySkuFnsku,
    scannedMaps.byProductId,
  );
  const prevByKey = new Map(enrichedLines.map((line) => [line.groupKey, line]));
  return lines.map((line) => {
    const prev = prevByKey.get(line.groupKey);
    if (!prev) return line;
    return {
      ...line,
      product_linkage: prev.product_linkage,
      productLabel: prev.productLabel,
    };
  });
}

/** Build sku/fnsku/product_id scanned maps from hydrated operator package item rows. */
export function scannedCountMapsFromOperatorPackageHydratedRows(
  rows: {
    scanned_barcode: string;
    match_kind: "fnsku" | "upc" | "unexpected";
    quantity: number;
    product_linkage: { resolved_product_id?: string | null };
  }[],
): ReturnItemsScannedCountMaps {
  const units: { sku?: string | null; fnsku?: string | null; resolved_product_id?: string | null }[] = [];
  for (const row of rows) {
    const q = Math.max(1, Math.floor(Number(row.quantity ?? 1)));
    const bc = String(row.scanned_barcode ?? "").trim();
    const sku = row.match_kind === "upc" || row.match_kind === "unexpected" ? bc : null;
    const fnsku = row.match_kind === "fnsku" ? bc : null;
    const pid = String(row.product_linkage?.resolved_product_id ?? "").trim();
    for (let i = 0; i < q; i++) {
      units.push({
        sku: sku || null,
        fnsku: fnsku || null,
        resolved_product_id: pid && isUuidString(pid) ? pid : null,
      });
    }
  }
  return accumulateReturnItemScannedCounts(units);
}

export async function loadTrackingExpectationSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): Promise<{
  lines: TrackingOperatorLine[];
  totals: TrackingExpectationTotals;
  rawRowCount: number;
  expectedTrackingNumbers: string[];
}> {
  const raw = await fetchExpectedPackagesForTracking(
    supabase,
    organizationId,
    storeId,
    trackingNumber,
    EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT,
  );
  const groups = aggregateExpectedPackagesBySkuFnskuDisposition(raw);
  let scannedMaps: ReturnItemsScannedCountMaps;
  try {
    scannedMaps = await fetchReturnItemsScannedCountsForTracking(
      supabase,
      organizationId,
      storeId,
      trackingNumber,
    );
  } catch (e) {
    scannedMaps = {
      bySkuFnsku: emptyScannedMapAfterWarn("loadTrackingExpectationSnapshot", e),
      byProductId: new Map(),
    };
  }
  const { lines: baseLines, totals } = mergeExpectedWithScannedCounts(
    groups,
    scannedMaps.bySkuFnsku,
    scannedMaps.byProductId,
  );
  const lines = await enrichTrackingOperatorLinesWithProductLinkage(
    supabase,
    baseLines,
    raw,
    organizationId,
    storeId,
  );
  return {
    lines,
    totals,
    rawRowCount: raw.length,
    expectedTrackingNumbers: distinctTrackingNumbersFromExpectedPackageRows(raw),
  };
}

/** Offline demo snapshot (no DB). */
export function mockTrackingExpectationSnapshot(trackingNumber: string): {
  lines: TrackingOperatorLine[];
  totals: TrackingExpectationTotals;
  rawRowCount: number;
  expectedTrackingNumbers: string[];
} {
  const tn = trackingNumber.trim();
  const groups: TrackingExpectedGroup[] = [
    {
      groupKey: "demo1",
      sku: "DEMO-SKU-A",
      fnsku: "X003ZN3TJT",
      asin: "B00DEMOCH1",
      disposition: "Sellable",
      productLabel: "Milk Chocolate Bar 6.35 oz",
      expectedQty: 15,
    },
    {
      groupKey: "demo2",
      sku: "DEMO-SKU-A",
      fnsku: "X003ZN3TJT",
      asin: "B00DEMOCH1",
      disposition: "Defective",
      productLabel: "Milk Chocolate Bar 6.35 oz",
      expectedQty: 5,
    },
    {
      groupKey: "demo3",
      sku: "DEMO-SKU-B",
      fnsku: "X009AB12CDE",
      asin: "B00DEMOCH2",
      disposition: "Sellable",
      productLabel: "Dark Chocolate 12 oz",
      expectedQty: 33,
    },
  ];
  const scanned = new Map<string, number>([[`${"demo-sku-a".toLowerCase()}\u0000${"x003zn3tjt".toLowerCase()}`, 4]]);
  const { lines: baseLines, totals } = mergeExpectedWithScannedCounts(groups, scanned);
  const lines: TrackingOperatorLine[] = baseLines.map((line) => ({
    ...line,
    product_linkage: mergeExpectedPackageRowsProductLinkage([], new Map()),
  }));
  return {
    lines,
    totals,
    rawRowCount: 3,
    expectedTrackingNumbers: tn ? [tn] : [],
  };
}
