/**
 * Item Scan UI — merge Shipment Expected + Packing Slip reference rows for display bucketing.
 * Display-only; does not mutate allocation, return_items, claims, or DB schema.
 */

import type { TrackingOperatorLine } from "@/lib/scanner/operator-tracking-expectations";
import {
  expectedPackageRowToProductGrain,
  productGrainKey,
  productGrainsMatch,
  returnItemRowToProductGrain,
  slipRowToProductGrain,
  type ProductGrain,
} from "@/lib/scanner/product-grain-match";
import { computeSlipLineExpectedVsReceived } from "@/lib/scanner/slip-contents-missing-expected";
import type { ShipmentExpectedLine } from "@/lib/scanner/shipment-expected-context";
import type { SlipShipmentValidationPreview } from "@/lib/scanner/slip-shipment-validation-types";

export type ItemScanReferenceSourceBadge = "only_shipment" | "only_slip" | "confirmed";

export type ItemScanReferenceDisplayRow = {
  key: string;
  grainKey: string;
  label: string | null;
  grain: ProductGrain;
  sourceBadge: ItemScanReferenceSourceBadge | null;
  slipQty: number;
  shipmentExpectedQty: number;
  expectedQty: number;
  scannedQty: number;
  slipContentIds: string[];
  expectedPackageIds: string[];
  returnItemIds: string[];
  /** Best-effort slip row id for missing-review / edit hooks. */
  primarySlipContentId: string | null;
};

export type ItemScanOffManifestDisplayRow = {
  key: string;
  grainKey: string | null;
  label: string | null;
  grain: ProductGrain;
  scannedQty: number;
  returnItemIds: string[];
  barcodes: string[];
};

export type ItemScanReferenceBuckets = {
  topRows: ItemScanReferenceDisplayRow[];
  offManifestRows: ItemScanOffManifestDisplayRow[];
};

export type ItemScanReferencePackageItem = {
  id: string;
  quantity: number;
  scanned_barcode?: string | null;
  slip_content_id?: string | null;
  operator_notes?: string | null;
  notes?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  upc?: string | null;
  product_identifier?: string | null;
  asin?: string | null;
  match_kind?: "fnsku" | "upc" | "unexpected";
  product_linkage?: { resolved_product_id?: string | null; product_name?: string | null };
};

export type ItemScanReferenceSlipRow = {
  id?: string | null;
  upc?: string | null;
  fnsku?: string | null;
  description?: string | null;
  quantity?: number | null;
  parsed_asin?: string | null;
  parsed_sku?: string | null;
  resolved_product_id?: string | null;
};

export function itemScanReferenceSourceBadgeLabel(
  badge: ItemScanReferenceSourceBadge | null,
): string | null {
  switch (badge) {
    case "only_shipment":
      return "ONLY SHIPMENT";
    case "only_slip":
      return "ONLY SLIP";
    case "confirmed":
      return "CONFIRMED";
    default:
      return null;
  }
}

export function sourceBadgeForReferenceRow(
  hasSlip: boolean,
  hasShipment: boolean,
): ItemScanReferenceSourceBadge | null {
  if (hasSlip && hasShipment) return null;
  if (hasShipment) return "only_shipment";
  if (hasSlip) return "only_slip";
  return null;
}

/** Convert persisted Shipment Expected context line to expected_packages row shape for merge. */
export function shipmentExpectedLineToEpRow(
  line: ShipmentExpectedLine,
): Record<string, unknown> {
  return {
    id: `ctx:${line.lineKey}`,
    fnsku: line.fnsku,
    sku: line.sku ?? line.upc,
    asin: line.asin,
    expected_scan_quantity: line.expectedQty,
    resolved_product_id: line.resolvedProductId,
    products: line.title ? { product_name: line.title } : undefined,
  };
}

/** Convert aggregated tracking operator line to expected_packages row shape for merge. */
export function trackingOperatorLineToEpRow(line: TrackingOperatorLine): Record<string, unknown> {
  return {
    id: `trk:${line.groupKey}`,
    fnsku: line.fnsku,
    sku: line.sku,
    asin: line.asin,
    disposition: line.disposition,
    expected_scan_quantity: line.expectedQty,
    resolved_product_id: line.expected_product_id ?? line.product_linkage?.resolved_product_id ?? null,
    products: line.productLabel ? { product_name: line.productLabel } : undefined,
  };
}

/** Shipment expected qty when present; otherwise packing-slip qty. */
export function referenceExpectedQty(shipmentExpectedQty: number, slipQty: number): number {
  const shipment = Math.max(0, Math.floor(shipmentExpectedQty));
  const slip = Math.max(0, Math.floor(slipQty));
  return shipment > 0 ? shipment : slip;
}

function floorQty(v: unknown): number {
  const n = Math.floor(Number(v ?? 0));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function tokenNorm(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function packageItemUnitQty(row: ItemScanReferencePackageItem): number {
  return Math.max(1, floorQty(row.quantity));
}

function packageItemNotes(row: ItemScanReferencePackageItem): string | null {
  const notes = row.operator_notes ?? row.notes;
  return typeof notes === "string" ? notes : null;
}

function lineLabel(grain: ProductGrain): string | null {
  return (
    grain.fnsku ??
    grain.sku ??
    grain.asin ??
    grain.upc ??
    grain.gtin ??
    (grain.title ? grain.title.slice(0, 80) : null)
  );
}

function slipRowToRecord(row: ItemScanReferenceSlipRow): Record<string, unknown> {
  return {
    id: row.id,
    upc: row.upc,
    fnsku: row.fnsku,
    description: row.description,
    quantity: row.quantity,
    parsed_asin: row.parsed_asin,
    parsed_sku: row.parsed_sku,
    resolved_product_id: row.resolved_product_id,
  };
}

function packageItemToRecord(row: ItemScanReferencePackageItem): Record<string, unknown> {
  return {
    id: row.id,
    fnsku: row.fnsku,
    sku: row.sku,
    asin: row.asin,
    product_identifier: row.product_identifier ?? row.upc,
    item_name: row.product_linkage?.product_name,
    notes: packageItemNotes(row),
    scanned_quantity: row.quantity,
    quantity: row.quantity,
    resolved_product_id: row.product_linkage?.resolved_product_id,
  };
}

function packageItemGrain(row: ItemScanReferencePackageItem): ProductGrain {
  const fromRow = returnItemRowToProductGrain(packageItemToRecord(row));
  const bc = String(row.scanned_barcode ?? "").trim();
  if (row.match_kind === "fnsku" && bc && !fromRow.fnsku) {
    return { ...fromRow, fnsku: bc };
  }
  if ((row.match_kind === "upc" || row.match_kind === "unexpected") && bc && !fromRow.sku && !fromRow.upc) {
    return { ...fromRow, sku: bc, upc: bc };
  }
  return fromRow;
}

function epExpectedQtyFromRow(row: Record<string, unknown>): number {
  return floorQty(row.expected_scan_quantity ?? row.expected_qty ?? row.quantity);
}

function dedupeEpRowsByGrain(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const grain = expectedPackageRowToProductGrain(row);
    const key = productGrainKey(grain) ?? `ep:${String(row.id ?? "")}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...row });
      continue;
    }
    const prevQty = epExpectedQtyFromRow(prev);
    const nextQty = epExpectedQtyFromRow(row);
    byKey.set(key, {
      ...prev,
      expected_scan_quantity: prevQty + nextQty,
    });
  }
  return Array.from(byKey.values());
}

/**
 * Prefer raw expected_packages detail rows; fall back to Shipment Expected context or tracking snapshot lines.
 */
export function coalesceShipmentExpectedRowsForReferenceMerge(
  primaryRows: Record<string, unknown>[] | null | undefined,
  contextLines: ShipmentExpectedLine[] | null | undefined,
  trackingLines: TrackingOperatorLine[] | null | undefined,
): Record<string, unknown>[] {
  const primary = Array.isArray(primaryRows) ? primaryRows : [];
  if (primary.length > 0) return primary;

  const fromContext = (contextLines ?? []).map(shipmentExpectedLineToEpRow);
  if (fromContext.length > 0) return dedupeEpRowsByGrain(fromContext);

  const fromTracking = (trackingLines ?? []).map(trackingOperatorLineToEpRow);
  if (fromTracking.length > 0) return dedupeEpRowsByGrain(fromTracking);

  return [];
}

/** Same cross-lane token matching as operator EP allocation helpers. */
export function packageItemMatchesEpRow(
  item: ItemScanReferencePackageItem,
  ep: Record<string, unknown>,
): boolean {
  const bc = tokenNorm(item.scanned_barcode);
  const itemFnsku = tokenNorm(item.fnsku ?? (item.match_kind === "fnsku" ? item.scanned_barcode : ""));
  const itemSku = tokenNorm(
    item.sku ?? item.product_identifier ?? item.upc ?? (item.match_kind === "upc" ? item.scanned_barcode : ""),
  );
  const epFnsku = tokenNorm(ep.fnsku);
  const epSku = tokenNorm(ep.sku);
  const epAsin = tokenNorm(ep.asin);
  const itemAsin = tokenNorm(item.asin);
  const resolvedItem = String(item.product_linkage?.resolved_product_id ?? "").trim();
  const resolvedEp = String(ep.resolved_product_id ?? ep.expected_product_id ?? ep.product_id ?? "").trim();

  if (resolvedItem && resolvedEp && resolvedItem === resolvedEp) return true;
  if (bc && epFnsku && bc === epFnsku) return true;
  if (bc && epSku && bc === epSku) return true;
  if (itemFnsku && epFnsku && itemFnsku === epFnsku) return true;
  if (itemSku && epSku && itemSku === epSku) return true;
  if (itemFnsku && epSku && itemFnsku === epSku) return true;
  if (itemSku && epFnsku && itemSku === epFnsku) return true;
  if (itemAsin && epAsin && itemAsin === epAsin) return true;
  return productGrainsMatch(packageItemGrain(item), expectedPackageRowToProductGrain(ep));
}

type SlipAgg = {
  qty: number;
  slip_content_ids: string[];
  grain: ProductGrain;
  label: string | null;
};

type EpAgg = {
  qty: number;
  expected_package_ids: string[];
  grain: ProductGrain;
  label: string | null;
};

type ScanAgg = {
  qty: number;
  return_item_ids: string[];
  grain: ProductGrain;
  barcodes: Set<string>;
};

function aggregateSlipRows(slipRows: ItemScanReferenceSlipRow[]): {
  byKey: Map<string, SlipAgg>;
  slipIdToKey: Map<string, string>;
} {
  const byKey = new Map<string, SlipAgg>();
  const slipIdToKey = new Map<string, string>();
  for (const row of slipRows) {
    const grain = slipRowToProductGrain(slipRowToRecord(row));
    const key = productGrainKey(grain) ?? `slip:${String(row.id ?? "")}`;
    const qty = floorQty(row.quantity);
    const slipId = String(row.id ?? "").trim();
    if (slipId) slipIdToKey.set(slipId, key);
    const prev = byKey.get(key);
    if (prev) {
      prev.qty += qty;
      if (slipId) prev.slip_content_ids.push(slipId);
    } else {
      byKey.set(key, {
        qty,
        slip_content_ids: slipId ? [slipId] : [],
        grain,
        label: lineLabel(grain),
      });
    }
  }
  return { byKey, slipIdToKey };
}

function aggregateEpRows(epRows: Record<string, unknown>[]): Map<string, EpAgg> {
  const byKey = new Map<string, EpAgg>();
  for (const row of epRows) {
    const grain = expectedPackageRowToProductGrain(row);
    const key = productGrainKey(grain) ?? `ep:${String(row.id ?? "")}`;
    const qty = epExpectedQtyFromRow(row);
    const epId = String(row.id ?? "").trim();
    const prev = byKey.get(key);
    if (prev) {
      prev.qty += qty;
      if (epId) prev.expected_package_ids.push(epId);
    } else {
      byKey.set(key, {
        qty,
        expected_package_ids: epId ? [epId] : [],
        grain,
        label: lineLabel(grain),
      });
    }
  }
  return byKey;
}

function epKeyForRawRow(epRow: Record<string, unknown>, epByKey: Map<string, EpAgg>): string | null {
  const grain = expectedPackageRowToProductGrain(epRow);
  const key = productGrainKey(grain) ?? `ep:${String(epRow.id ?? "")}`;
  if (epByKey.has(key)) return key;
  const epId = String(epRow.id ?? "").trim();
  for (const [candidateKey, agg] of epByKey) {
    if (epId && agg.expected_package_ids.includes(epId)) return candidateKey;
  }
  return epByKey.has(key) ? key : null;
}

/**
 * Resolve the canonical reference bucket key for a scanned package item.
 * Always returns the slip/EP aggregation key — never the scan-only grain key.
 */
export function resolveReferenceKeyForPackageItem(input: {
  item: ItemScanReferencePackageItem;
  slipIdToKey: Map<string, string>;
  slipByKey: Map<string, SlipAgg>;
  epByKey: Map<string, EpAgg>;
  shipmentExpectedRows: Record<string, unknown>[];
}): string | null {
  const { item, slipIdToKey, slipByKey, epByKey, shipmentExpectedRows } = input;
  const slipId = String(item.slip_content_id ?? "").trim();
  if (slipId && slipIdToKey.has(slipId)) {
    return slipIdToKey.get(slipId)!;
  }

  const scanGrain = packageItemGrain(item);

  for (const [key, ep] of epByKey) {
    if (productGrainsMatch(scanGrain, ep.grain)) return key;
  }
  for (const [key, slip] of slipByKey) {
    if (productGrainsMatch(scanGrain, slip.grain)) return key;
  }

  for (const epRow of shipmentExpectedRows) {
    if (!packageItemMatchesEpRow(item, epRow)) continue;
    const epKey = epKeyForRawRow(epRow, epByKey);
    if (epKey) return epKey;
  }

  return null;
}

function aggregatePackageItems(input: {
  packageItems: ItemScanReferencePackageItem[];
  slipIdToKey: Map<string, string>;
  slipByKey: Map<string, SlipAgg>;
  epByKey: Map<string, EpAgg>;
  shipmentExpectedRows: Record<string, unknown>[];
}): { byKey: Map<string, ScanAgg>; offManifest: ScanAgg[] } {
  const byKey = new Map<string, ScanAgg>();
  const offManifest: ScanAgg[] = [];

  for (const row of input.packageItems) {
    const qty = packageItemUnitQty(row);
    const grain = packageItemGrain(row);
    const referenceKey = resolveReferenceKeyForPackageItem({
      item: row,
      slipIdToKey: input.slipIdToKey,
      slipByKey: input.slipByKey,
      epByKey: input.epByKey,
      shipmentExpectedRows: input.shipmentExpectedRows,
    });

    const riId = String(row.id ?? "").trim();
    const bc = String(row.scanned_barcode ?? "").trim();

    if (!referenceKey) {
      offManifest.push({
        qty,
        return_item_ids: riId ? [riId] : [],
        grain,
        barcodes: bc ? new Set([bc]) : new Set(),
      });
      continue;
    }

    const prev = byKey.get(referenceKey);
    if (prev) {
      prev.qty += qty;
      if (riId) prev.return_item_ids.push(riId);
      if (bc) prev.barcodes.add(bc);
    } else {
      byKey.set(referenceKey, {
        qty,
        return_item_ids: riId ? [riId] : [],
        grain,
        barcodes: bc ? new Set([bc]) : new Set(),
      });
    }
  }

  return { byKey, offManifest };
}

function collapseOffManifestRows(rows: ScanAgg[]): ItemScanOffManifestDisplayRow[] {
  const grouped = new Map<string, ItemScanOffManifestDisplayRow>();
  for (const row of rows) {
    const grainKey = productGrainKey(row.grain);
    const key = grainKey ?? `off:${row.return_item_ids[0] ?? "unknown"}`;
    const prev = grouped.get(key);
    if (prev) {
      prev.scannedQty += row.qty;
      prev.returnItemIds.push(...row.return_item_ids);
      prev.barcodes.push(...Array.from(row.barcodes));
    } else {
      grouped.set(key, {
        key,
        grainKey,
        label: lineLabel(row.grain),
        grain: row.grain,
        scannedQty: row.qty,
        returnItemIds: [...row.return_item_ids],
        barcodes: Array.from(row.barcodes),
      });
    }
  }
  return Array.from(grouped.values());
}

function filterOffManifestDuplicates(
  topRows: ItemScanReferenceDisplayRow[],
  offManifestRows: ItemScanOffManifestDisplayRow[],
): ItemScanOffManifestDisplayRow[] {
  const matchedIds = new Set(topRows.flatMap((row) => row.returnItemIds));
  if (matchedIds.size === 0) return offManifestRows;

  const filtered: ItemScanOffManifestDisplayRow[] = [];
  for (const row of offManifestRows) {
    const remainingIds = row.returnItemIds.filter((id) => !matchedIds.has(id));
    if (remainingIds.length === 0) continue;
    const removedCount = row.returnItemIds.length - remainingIds.length;
    const perIdQty = row.returnItemIds.length > 0 ? row.scannedQty / row.returnItemIds.length : row.scannedQty;
    const scannedQty = Math.max(0, Math.floor(row.scannedQty - removedCount * perIdQty));
    if (scannedQty <= 0) continue;
    filtered.push({
      ...row,
      returnItemIds: remainingIds,
      scannedQty,
    });
  }
  return filtered;
}

function logReferenceBucketDebug(input: {
  topRows: ItemScanReferenceDisplayRow[];
  offManifestRows: ItemScanOffManifestDisplayRow[];
  matchedScanIdsOrKeys: string[];
}): void {
  if (process.env.NODE_ENV === "production") return;
  const matchedScanIds = new Set(input.topRows.flatMap((row) => row.returnItemIds));
  const bottomIds = input.offManifestRows.flatMap((row) => row.returnItemIds);
  const duplicateKeys = bottomIds.filter((id) => matchedScanIds.has(id));
  console.debug("[item-scan-reference-buckets]", {
    referenceRows: input.topRows.map((row) => ({
      key: row.key,
      label: row.label,
      sourceBadge: row.sourceBadge,
      expectedQty: row.expectedQty,
      scannedQty: row.scannedQty,
      returnItemIds: row.returnItemIds,
    })),
    matchedScanIdsOrKeys: input.matchedScanIdsOrKeys,
    bottomRows: input.offManifestRows.map((row) => ({
      key: row.key,
      label: row.label,
      scannedQty: row.scannedQty,
      returnItemIds: row.returnItemIds,
    })),
    duplicateKeys,
    topRows: input.topRows.length,
  });
  if (duplicateKeys.length > 0) {
    console.warn("[item-scan-reference-buckets] duplicate scan ids in top and bottom buckets", duplicateKeys);
  }
}

export function buildItemScanReferenceBucketsClientSide(input: {
  slipRows: ItemScanReferenceSlipRow[];
  shipmentExpectedRows: Record<string, unknown>[];
  packageItems: ItemScanReferencePackageItem[];
  draftExtraByGrainKey?: Record<string, number>;
}): ItemScanReferenceBuckets {
  const { byKey: slipByKey, slipIdToKey } = aggregateSlipRows(input.slipRows);
  const epByKey = aggregateEpRows(input.shipmentExpectedRows);

  const { byKey: scanByKey, offManifest: rawOffManifest } = aggregatePackageItems({
    packageItems: input.packageItems,
    slipIdToKey,
    slipByKey,
    epByKey,
    shipmentExpectedRows: input.shipmentExpectedRows,
  });

  const allKeys = new Set([...slipByKey.keys(), ...epByKey.keys(), ...scanByKey.keys()]);
  const topRows: ItemScanReferenceDisplayRow[] = [];
  const matchedScanIdsOrKeys: string[] = [];

  for (const grainKey of allKeys) {
    const slip = slipByKey.get(grainKey);
    const ep = epByKey.get(grainKey);
    const scan = scanByKey.get(grainKey);
    const hasSlip = Boolean(slip);
    const hasShipment = Boolean(ep);
    if (!hasSlip && !hasShipment) continue;

    const slipQty = slip?.qty ?? 0;
    const shipmentExpectedQty = ep?.qty ?? 0;
    const draftExtra = Math.max(0, floorQty(input.draftExtraByGrainKey?.[grainKey] ?? 0));
    const scannedQty = Math.max(0, (scan?.qty ?? 0) + draftExtra);
    const expectedQty = referenceExpectedQty(shipmentExpectedQty, slipQty);
    const grain = slip?.grain ?? ep?.grain ?? scan?.grain ?? {
      resolved_product_id: null,
      fnsku: null,
      asin: null,
      sku: null,
      upc: null,
      gtin: null,
      title: null,
    };

    if (scan?.return_item_ids.length) {
      matchedScanIdsOrKeys.push(...scan.return_item_ids);
    }

    topRows.push({
      key: grainKey,
      grainKey,
      label: slip?.label ?? ep?.label ?? lineLabel(grain),
      grain,
      sourceBadge: sourceBadgeForReferenceRow(hasSlip, hasShipment),
      slipQty,
      shipmentExpectedQty,
      expectedQty,
      scannedQty,
      slipContentIds: slip?.slip_content_ids ?? [],
      expectedPackageIds: ep?.expected_package_ids ?? [],
      returnItemIds: scan?.return_item_ids ?? [],
      primarySlipContentId: slip?.slip_content_ids[0] ?? null,
    });
  }

  topRows.sort((a, b) => (a.label ?? a.grainKey).localeCompare(b.label ?? b.grainKey));

  const offManifestRows = filterOffManifestDuplicates(topRows, collapseOffManifestRows(rawOffManifest));

  logReferenceBucketDebug({ topRows, offManifestRows, matchedScanIdsOrKeys });

  return {
    topRows,
    offManifestRows,
  };
}

export function buildItemScanReferenceBucketsFromPreview(
  preview: SlipShipmentValidationPreview,
): ItemScanReferenceBuckets {
  const topRows: ItemScanReferenceDisplayRow[] = [];
  const offManifestRows: ItemScanOffManifestDisplayRow[] = [];

  for (const line of preview.lines) {
    const hasSlip = line.sources_present.includes("packing_slip");
    const hasShipment = line.sources_present.includes("shipment_expected");
    const slipQty = Math.max(0, floorQty(line.slip_qty));
    const shipmentExpectedQty = Math.max(0, floorQty(line.shipment_expected_qty));
    const expectedQty = referenceExpectedQty(shipmentExpectedQty, slipQty);
    const scannedQty = Math.max(0, floorQty(line.scanned_qty));

    if (line.bucket === "scanned_off_manifest") {
      offManifestRows.push({
        key: line.grain_key,
        grainKey: line.grain_key,
        label: line.label,
        grain: line.grain,
        scannedQty: Math.max(scannedQty, Math.max(0, floorQty(line.off_manifest_scanned_qty))),
        returnItemIds: [...line.return_item_ids],
        barcodes: [],
      });
      continue;
    }

    if (!hasSlip && !hasShipment && scannedQty <= 0) continue;

    topRows.push({
      key: line.grain_key,
      grainKey: line.grain_key,
      label: line.label,
      grain: line.grain,
      sourceBadge: sourceBadgeForReferenceRow(hasSlip, hasShipment),
      slipQty,
      shipmentExpectedQty,
      expectedQty,
      scannedQty,
      slipContentIds: [...line.slip_content_ids],
      expectedPackageIds: [...line.expected_package_ids],
      returnItemIds: [...line.return_item_ids],
      primarySlipContentId: line.slip_content_ids[0] ?? null,
    });
  }

  topRows.sort((a, b) => (a.label ?? a.grainKey).localeCompare(b.label ?? b.grainKey));
  const dedupedOffManifest = filterOffManifestDuplicates(topRows, offManifestRows);
  dedupedOffManifest.sort((a, b) => (a.label ?? a.key).localeCompare(b.label ?? b.key));

  logReferenceBucketDebug({
    topRows,
    offManifestRows: dedupedOffManifest,
    matchedScanIdsOrKeys: topRows.flatMap((row) => row.returnItemIds),
  });

  return { topRows, offManifestRows: dedupedOffManifest };
}

export function qtyLineForReferenceRow(
  row: Pick<ItemScanReferenceDisplayRow, "expectedQty" | "scannedQty">,
  manifestRecordedMissingQty = 0,
) {
  return computeSlipLineExpectedVsReceived({
    expectedQty: row.expectedQty,
    receivedQty: row.scannedQty,
    manifestRecordedMissingQty,
  });
}

export function itemScanReferenceBucketsUseMergedTop(
  buckets: ItemScanReferenceBuckets | null,
): boolean {
  return Boolean(buckets && buckets.topRows.length > 0);
}

/** Item Scan Expected Items list — only rows scanned in this box (not full shipment/slip manifest). */
export function itemScanReferenceTopRowsWithScans(
  topRows: ItemScanReferenceDisplayRow[],
): ItemScanReferenceDisplayRow[] {
  return topRows.filter((row) => row.scannedQty > 0);
}

/** Whether this box has packing-slip reference lines (not shipment-only). */
export function itemScanReferenceHasSlipSources(slipRows: ItemScanReferenceSlipRow[]): boolean {
  return slipRows.length > 0;
}

/**
 * Per-row expected qty for box UI. Shipment expected is used for matching/badges only when
 * this box has no slip line for the grain — shortage is not tracked vs shipment at box level.
 */
export function boxScopedExpectedQtyForReferenceRow(
  row: Pick<ItemScanReferenceDisplayRow, "slipQty" | "expectedQty" | "scannedQty">,
  hasSlipOnBox: boolean,
): number {
  if (hasSlipOnBox && row.slipQty > 0) return row.expectedQty;
  if (row.slipQty > 0) return row.expectedQty;
  return Math.max(0, row.scannedQty);
}

/** Box-level expected total for merged panel + stat cards. */
export function mergedReferenceBoxScopedExpectedQty(input: {
  topRows: ItemScanReferenceDisplayRow[];
  slipRows: ItemScanReferenceSlipRow[];
  offManifestScannedQty?: number;
}): number {
  const slipTotal = input.slipRows.reduce((sum, row) => sum + Math.max(0, floorQty(row.quantity)), 0);
  if (slipTotal > 0) {
    return slipTotal + Math.max(0, floorQty(input.offManifestScannedQty ?? 0));
  }
  const topScanned = itemScanReferenceTopRowsWithScans(input.topRows).reduce((sum, row) => sum + row.scannedQty, 0);
  return topScanned + Math.max(0, floorQty(input.offManifestScannedQty ?? 0));
}

/** True when merged reference UI should drive Expected Items + off-manifest panels. */
export function itemScanReferenceBucketsUseMergedDisplay(
  buckets: ItemScanReferenceBuckets | null,
  hasSlipOrShipmentSources: boolean,
): boolean {
  if (!buckets) return false;
  if (itemScanReferenceTopRowsWithScans(buckets.topRows).length > 0) return true;
  if (buckets.offManifestRows.length > 0) return true;
  return hasSlipOrShipmentSources;
}

export function itemScanReferenceUsesMergedRender(
  renderSource: string | null | undefined,
): boolean {
  return renderSource === "merged_reference_cells";
}
