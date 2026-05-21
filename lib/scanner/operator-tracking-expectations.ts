import type { SupabaseClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE } from "@/app/returns/returns-constants";
import type {
  ProductLinkageDisplayContract,
  ProductsLookupClient,
} from "@/lib/scanner/product-linkage-display-contract";
import {
  fetchResolvedProductNamesForExpectedRows,
  mergeExpectedPackageRowsProductLinkage,
  primaryLabelForExpectedPackageLinkage,
  scanQuantityVariance,
} from "@/lib/scanner/expected-packages-read-contract";
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
  ", identifier_resolution_status, product_match_status, product_review_required, " +
  "expected_product_id, resolved_product_id, resolved_catalog_product_id";

/** Full rows for operator item scan (includes PK + warehouse scan counters when present). */
export const EP_DETAIL_SELECT =
  "id, sku, fnsku, disposition, expected_scan_quantity, actual_scanned_count, order_id, tracking_number, id_slip_contents";

/**
 * After `20260717120000_scanner_product_linkage_columns.sql`, use this select in detail fetches
 * so scanner UI receives resolution columns on `expected_packages`.
 */
export const EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT =
  EP_DETAIL_SELECT +
  ", identifier_resolution_status, product_match_status, product_review_required, " +
  "expected_product_id, resolved_product_id, resolved_catalog_product_id";

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

  const skus = [...new Set(safeIn.map((r) => String(r?.sku ?? "").trim()).filter(Boolean))];
  if (!skus.length) {
    return safeIn.map((r) => (r && typeof r === "object" ? { ...r, products: null } : {}));
  }

  const nameBySku = new Map<string, string>();
  const chunkSize = 80;
  for (let i = 0; i < skus.length; i += chunkSize) {
    const chunk = skus.slice(i, i + chunkSize);
    const primary = await supabase
      .from("products")
      .select("sku, product_name, name")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .in("sku", chunk);

    const res = primary.error
      ? await supabase
          .from("products")
          .select("sku, name")
          .eq("organization_id", organizationId)
          .eq("store_id", storeId)
          .in("sku", chunk)
      : primary;

    if (res.error) break;

    const pdata = res.data ?? [];
    const safeP = Array.isArray(pdata) ? pdata : [];
    for (const p of safeP) {
      const row = p as Record<string, unknown>;
      const sku = String(row.sku ?? "").trim();
      const nm = String(row.product_name ?? row.name ?? "").trim();
      if (sku && nm) nameBySku.set(sku.toLowerCase(), nm);
    }
  }

  return safeIn.map((r) => {
    if (!r || typeof r !== "object") return {};
    const sku = String(r.sku ?? "").trim();
    const nm = sku ? nameBySku.get(sku.toLowerCase()) : undefined;
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

async function fetchExpectedPackagesForTrackingWithSelect(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  selectColumns: string,
): Promise<Record<string, unknown>[]> {
  const scannedCode = String(trackingNumber ?? "").trim();
  if (!scannedCode) return [];

  const cleanCode = scannedCode.replace(/[^a-zA-Z0-9]/g, "");
  /** LIKE-safe form of the scanned string (still reflects original scan, minus % / _). */
  const patternOriginal = sanitizeTrackingForIlikePattern(scannedCode);
  const key = normalizeTrackingKey(trackingNumber);

  const matchesExact = (row: { tracking_number?: string | null }) =>
    key ? trackingRowMatchesScanned(row, key) === "exact" : false;

  const matchesFlexible = (row: { tracking_number?: string | null }) =>
    key ? trackingRowMatchesScanned(row, key) !== "none" : false;

  const BASE_LIMIT = 800;

  let qb = supabase
    .from("expected_packages")
    .select(selectColumns)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .limit(BASE_LIMIT);

  if (cleanCode.length > 0 && patternOriginal.length > 0 && cleanCode !== patternOriginal) {
    qb = qb.or(
      `tracking_number.ilike.%${cleanCode}%,tracking_number.ilike.%${patternOriginal}%`,
    );
  } else if (cleanCode.length > 0) {
    qb = qb.ilike("tracking_number", `%${cleanCode}%`);
  } else if (patternOriginal.length > 0) {
    qb = qb.ilike("tracking_number", `%${patternOriginal}%`);
  } else {
    return [];
  }

  const { data, error } = await qb;
  if (error) throw error;

  const rows0 = asSafeRowArray(data);

  let filtered = rows0.filter((r) => matchesExact(r as { tracking_number?: string | null }));
  if (!filtered.length) {
    filtered = rows0.filter((r) => matchesFlexible(r as { tracking_number?: string | null }));
  }
  if (filtered.length) return filtered;

  const PAGE = 450;
  for (let off = 0; off < 14000; off += PAGE) {
    const { data: page, error: pageErr } = await supabase
      .from("expected_packages")
      .select(selectColumns)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .not("tracking_number", "is", null)
      .order("id", { ascending: true })
      .range(off, off + PAGE - 1);

    if (pageErr) throw pageErr;
    const pageRows = asSafeRowArray(page);
    let hits = pageRows.filter((r) => matchesExact(r as { tracking_number?: string | null }));
    if (!hits.length) hits = pageRows.filter((r) => matchesFlexible(r as { tracking_number?: string | null }));
    if (hits.length) return hits;
    if (!page?.length || page.length < PAGE) break;
  }

  return [];
}

export async function fetchExpectedPackagesForTracking(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  selectColumns: string = EP_SELECT,
): Promise<Record<string, unknown>[]> {
  try {
    return await fetchExpectedPackagesForTrackingWithSelect(
      supabase,
      organizationId,
      storeId,
      trackingNumber,
      selectColumns,
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
    data = await fetchExpectedPackagesForTracking(supabase, organizationId, storeId, tn, EP_DETAIL_SELECT);
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
      EP_DETAIL_SELECT,
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
  const counts = new Map<string, number>();

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

  if (!pkgIds.length) return counts;

  const { data: retRows, error: retErr } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("sku, fnsku")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .in("package_id", pkgIds);

  if (retErr) throw retErr;

  for (const r of retRows ?? []) {
    const sku = String((r as { sku?: string | null }).sku ?? "").trim();
    const fnsku = String((r as { fnsku?: string | null }).fnsku ?? "").trim();
    const k = sfKey(sku, fnsku);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  return counts;
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
  return lines.map((line) => {
    const bucket = rowsByKey.get(line.groupKey) ?? [];
    const product_linkage = mergeExpectedPackageRowsProductLinkage(bucket, nameMap);
    const label = primaryLabelForExpectedPackageLinkage(product_linkage);
    return {
      ...line,
      product_linkage,
      productLabel: label && label !== "Line item" ? label : line.productLabel,
    };
  });
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
  let scannedMap: Map<string, number>;
  try {
    scannedMap = await fetchReturnItemsScannedBySkuFnskuForPallet(supabase, organizationId, storeId, palletId);
  } catch (e) {
    scannedMap = emptyScannedMapAfterWarn("loadPalletExpectationSnapshot", e);
  }
  const { lines: baseLines, totals } = mergeExpectedWithScannedCounts(groups, scannedMap);
  const lines = await enrichTrackingOperatorLinesWithProductLinkage(supabase, baseLines, raw);
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

    const prev = map.get(key);
    if (prev) {
      prev.expectedQty += safeQty;
      if (!prev.orderHint && orderId) prev.orderHint = orderId;
      if (!prev.asin && asin) prev.asin = asin;
      prev.identifier_resolution_status = worseIdentifierResolution(prev.identifier_resolution_status, idRes || null);
      prev.product_match_status = mergeProductMatchStatus(prev.product_match_status, pm || null);
      prev.product_review_required = prev.product_review_required || pr;
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
  const key = normalizeTrackingKey(trackingNumber);
  const counts = new Map<string, number>();
  if (!key) return counts;

  const pkgIds: string[] = [];
  const PAGE = 250;
  for (let off = 0; off < 8000; off += PAGE) {
    const { data: page, error: pkgErr } = await supabase
      .from("packages")
      .select("id, store_id, tracking_number")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .not("tracking_number", "is", null)
      .order("id", { ascending: true })
      .range(off, off + PAGE - 1);

    if (pkgErr) throw pkgErr;
    for (const p of page ?? []) {
      const sid = (p as { store_id?: string | null }).store_id;
      if (sid != null && sid !== storeId) continue;
      if (normalizeTrackingKey(String((p as { tracking_number?: string | null }).tracking_number ?? "")) === key) {
        pkgIds.push(String((p as { id: string }).id));
      }
    }
    if (!page?.length || page.length < PAGE) break;
  }

  if (!pkgIds.length) return counts;

  const { data: retRows, error: retErr } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("sku, fnsku")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .in("package_id", pkgIds);

  if (retErr) throw retErr;

  for (const r of retRows ?? []) {
    const sku = String((r as { sku?: string | null }).sku ?? "").trim();
    const fnsku = String((r as { fnsku?: string | null }).fnsku ?? "").trim();
    const k = sfKey(sku, fnsku);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  return counts;
}

/**
 * Split SKU+FNSKU scanned totals across disposition rows proportionally by expected qty.
 */
export function mergeExpectedWithScannedCounts(
  groups: TrackingExpectedGroup[],
  scannedBySkuFnsku: Map<string, number>,
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
    const totalScanned = scannedBySkuFnsku.get(k0) ?? 0;
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
  let scannedMap: Map<string, number>;
  try {
    scannedMap = await fetchReturnItemsScannedBySkuFnskuForTracking(supabase, organizationId, storeId, trackingNumber);
  } catch (e) {
    scannedMap = emptyScannedMapAfterWarn("loadTrackingExpectationSnapshot", e);
  }
  const { lines: baseLines, totals } = mergeExpectedWithScannedCounts(groups, scannedMap);
  const lines = await enrichTrackingOperatorLinesWithProductLinkage(supabase, baseLines, raw);
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
