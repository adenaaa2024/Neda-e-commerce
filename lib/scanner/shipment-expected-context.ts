/**
 * Shipment expected reference context — persisted through operator receive flow for review/compare UI.
 * Source of truth: expected_packages / v_inventory_item_status gate reads (not slip OCR).
 */

import type { TrackingOperatorLine } from "@/lib/scanner/operator-tracking-expectations";
import { resolveCarrierFromExpectedPackageRows } from "@/lib/scanner/operator-tracking-expectations";
import type { VInventoryStatusRow } from "@/lib/scanner/v-inventory-status";

export type ShipmentExpectedLineStatus =
  | "pending"
  | "partial"
  | "received"
  | "over"
  | "missing";

export type ShipmentExpectedLine = {
  lineKey: string;
  title: string;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  upc: string | null;
  expectedQty: number;
  scannedQty: number;
  resolvedProductId: string | null;
};

export type ShipmentExpectedContext = {
  tracking_number: string;
  carrier: string | null;
  order_id: string | null;
  expected_item_types: number;
  expected_total_units: number;
  lines: ShipmentExpectedLine[];
  captured_at: string;
  organization_id: string;
  store_id: string;
};

export type ShipmentExpectedContextSummary = {
  scannedUnits: number;
  remainingUnits: number;
  missingUnits: number;
  overUnits: number;
};

const SESSION_KEY_PREFIX = "operator-shipment-expected:";

const CARRIER_RECORD_KEYS = [
  "carrier",
  "carrier_name",
  "carrier_name_snapshot",
  "carrier_code",
  "carrier_code_snapshot",
  "shipping_carrier",
  "ship_carrier",
  "carrier_service",
  "fulfillment_carrier",
] as const;

export function carrierFromExpectedRecord(
  record: Record<string, unknown> | null | undefined,
): string | null {
  if (!record || typeof record !== "object") return null;
  for (const key of CARRIER_RECORD_KEYS) {
    const value = String(record[key] ?? "").trim();
    if (value) return value;
  }
  return null;
}

/** Resolve carrier from explicit value, inventory view lines, then expected_packages rows. */
export function resolveCarrierFromExpectedRecords(args: {
  explicit?: string | null;
  inventoryLines?: VInventoryStatusRow[];
  epRows?: Record<string, unknown>[];
}): string | null {
  const explicit = args.explicit?.trim();
  if (explicit) return explicit;

  for (const row of args.inventoryLines ?? []) {
    const fromView = row.carrier?.trim();
    if (fromView) return fromView;
  }

  const fromEp = resolveCarrierFromExpectedPackageRows(args.epRows);
  if (fromEp) return fromEp;

  for (const raw of args.epRows ?? []) {
    const fromRecord = carrierFromExpectedRecord(raw);
    if (fromRecord) return fromRecord;
  }

  return null;
}

export function enrichShipmentExpectedContextCarrier(
  ctx: ShipmentExpectedContext,
  carrier: string | null | undefined,
): ShipmentExpectedContext {
  const resolved = resolveCarrierFromExpectedRecords({
    explicit: carrier,
    inventoryLines: undefined,
    epRows: undefined,
  });
  if (!resolved || ctx.carrier?.trim()) return ctx;
  return { ...ctx, carrier: resolved };
}

function coerceQty(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function lineKeyFromParts(sku: string, fnsku: string, disposition = ""): string {
  return `${sku.toLowerCase()}\u0000${fnsku.toLowerCase()}\u0000${disposition.toLowerCase()}`;
}

function titleFromTrackingLine(line: TrackingOperatorLine): string {
  const fromLinkage = line.product_linkage?.product_name?.trim();
  if (fromLinkage) return fromLinkage;
  const label = line.productLabel?.trim();
  if (label) return label;
  const sku = line.sku?.trim();
  const fnsku = line.fnsku?.trim();
  if (sku && fnsku) return `${sku} · ${fnsku}`;
  return sku || fnsku || line.asin?.trim() || line.groupKey;
}

function lineFromTrackingOperatorLine(line: TrackingOperatorLine): ShipmentExpectedLine {
  return {
    lineKey: line.groupKey || lineKeyFromParts(line.sku, line.fnsku, line.disposition),
    title: titleFromTrackingLine(line),
    asin: line.asin?.trim() || null,
    fnsku: line.fnsku?.trim() || null,
    sku: line.sku?.trim() || null,
    upc: null,
    expectedQty: coerceQty(line.expectedQty),
    scannedQty: coerceQty(line.scannedQty),
    resolvedProductId: line.product_linkage?.resolved_product_id?.trim() || line.expected_product_id?.trim() || null,
  };
}

function lineFromInventoryStatusRow(row: VInventoryStatusRow): ShipmentExpectedLine {
  const sku = row.sku?.trim() ?? "";
  const fnsku = row.fnsku?.trim() ?? "";
  const title =
    row.product_display_name?.trim() ||
    row.product_name?.trim() ||
    (sku && fnsku ? `${sku} · ${fnsku}` : sku || fnsku || row.asin?.trim() || "Expected item");
  return {
    lineKey: row.expected_package_id || lineKeyFromParts(sku, fnsku, row.order_id ?? ""),
    title,
    asin: row.asin?.trim() || null,
    fnsku: fnsku || null,
    sku: sku || null,
    upc: null,
    expectedQty: coerceQty(row.total_expected),
    scannedQty: coerceQty(row.total_scanned),
    resolvedProductId:
      row.resolved_product_id?.trim() || row.product_id?.trim() || row.resolved_catalog_product_id?.trim() || null,
  };
}

function dedupeLines(lines: ShipmentExpectedLine[]): ShipmentExpectedLine[] {
  const map = new Map<string, ShipmentExpectedLine>();
  for (const line of lines) {
    const existing = map.get(line.lineKey);
    if (!existing) {
      map.set(line.lineKey, { ...line });
      continue;
    }
    map.set(line.lineKey, {
      ...existing,
      expectedQty: Math.max(existing.expectedQty, line.expectedQty),
      scannedQty: Math.max(existing.scannedQty, line.scannedQty),
      title: existing.title.length >= line.title.length ? existing.title : line.title,
    });
  }
  return [...map.values()];
}

function summarizeLines(lines: ShipmentExpectedLine[]): Pick<
  ShipmentExpectedContext,
  "expected_item_types" | "expected_total_units"
> {
  return {
    expected_item_types: lines.length,
    expected_total_units: lines.reduce((s, l) => s + l.expectedQty, 0),
  };
}

export function deriveShipmentExpectedLineStatus(
  line: Pick<ShipmentExpectedLine, "expectedQty" | "scannedQty">,
  atFinalReview: boolean,
): ShipmentExpectedLineStatus {
  const expected = coerceQty(line.expectedQty);
  const scanned = coerceQty(line.scannedQty);
  if (expected <= 0) return "pending";
  if (scanned <= 0) return atFinalReview ? "missing" : "pending";
  if (scanned > expected) return "over";
  if (scanned === expected) return "received";
  return atFinalReview ? "missing" : "partial";
}

export function summarizeShipmentExpectedContext(ctx: ShipmentExpectedContext): ShipmentExpectedContextSummary {
  let scannedUnits = 0;
  let missingUnits = 0;
  let overUnits = 0;
  for (const line of ctx.lines) {
    scannedUnits += line.scannedQty;
    if (line.scannedQty < line.expectedQty) {
      missingUnits += line.expectedQty - line.scannedQty;
    } else if (line.scannedQty > line.expectedQty) {
      overUnits += line.scannedQty - line.expectedQty;
    }
  }
  return {
    scannedUnits,
    remainingUnits: Math.max(0, ctx.expected_total_units - scannedUnits),
    missingUnits,
    overUnits,
  };
}

export function shipmentExpectedContextStorageKey(
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): string {
  return `${SESSION_KEY_PREFIX}${organizationId.trim()}:${storeId.trim()}:${trackingNumber.trim().toLowerCase()}`;
}

export function persistShipmentExpectedContext(ctx: ShipmentExpectedContext): void {
  if (typeof window === "undefined") return;
  try {
    const key = shipmentExpectedContextStorageKey(ctx.organization_id, ctx.store_id, ctx.tracking_number);
    window.sessionStorage.setItem(key, JSON.stringify(ctx));
  } catch {
    /* ignore quota / private mode */
  }
}

export function loadShipmentExpectedContext(
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): ShipmentExpectedContext | null {
  if (typeof window === "undefined") return null;
  try {
    const key = shipmentExpectedContextStorageKey(organizationId, storeId, trackingNumber);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ShipmentExpectedContext;
    if (!parsed?.tracking_number?.trim() || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearShipmentExpectedContext(
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = shipmentExpectedContextStorageKey(organizationId, storeId, trackingNumber);
    window.sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function buildShipmentExpectedContextFromGate(args: {
  organizationId: string;
  storeId: string;
  trackingNumber: string;
  carrier: string | null;
  orderId: string | null;
  expectationLines: TrackingOperatorLine[];
  shipmentLines: VInventoryStatusRow[];
  epRows?: Record<string, unknown>[];
}): ShipmentExpectedContext | null {
  const tracking = args.trackingNumber.trim();
  if (!tracking) return null;

  const fromExpectation = args.expectationLines.map(lineFromTrackingOperatorLine);
  const fromShipment =
    fromExpectation.length === 0 ? args.shipmentLines.map(lineFromInventoryStatusRow) : [];
  const lines = dedupeLines([...fromExpectation, ...fromShipment]);
  if (lines.length === 0) return null;

  const totals = summarizeLines(lines);
  if (totals.expected_total_units <= 0) return null;

  const carrier = resolveCarrierFromExpectedRecords({
    explicit: args.carrier,
    inventoryLines: args.shipmentLines,
    epRows: args.epRows,
  });

  return {
    tracking_number: tracking,
    carrier,
    order_id: args.orderId?.trim() || null,
    ...totals,
    lines,
    captured_at: new Date().toISOString(),
    organization_id: args.organizationId.trim(),
    store_id: args.storeId.trim(),
  };
}

export function buildShipmentExpectedContextFromTrackingLines(args: {
  organizationId: string;
  storeId: string;
  trackingNumber: string;
  carrier: string | null;
  orderId: string | null;
  lines: TrackingOperatorLine[];
  epRows?: Record<string, unknown>[];
}): ShipmentExpectedContext | null {
  const tracking = args.trackingNumber.trim();
  if (!tracking || args.lines.length === 0) return null;

  const mapped = dedupeLines(args.lines.map(lineFromTrackingOperatorLine));
  const totals = summarizeLines(mapped);
  if (totals.expected_total_units <= 0) return null;

  const carrier = resolveCarrierFromExpectedRecords({
    explicit: args.carrier,
    epRows: args.epRows,
  });

  return {
    tracking_number: tracking,
    carrier,
    order_id: args.orderId?.trim() || null,
    ...totals,
    lines: mapped,
    captured_at: new Date().toISOString(),
    organization_id: args.organizationId.trim(),
    store_id: args.storeId.trim(),
  };
}

/** Refresh scanned counts from live tracking expectation lines (expected_packages merge). */
export function mergeLiveTrackingLinesIntoContext(
  ctx: ShipmentExpectedContext,
  liveLines: TrackingOperatorLine[],
  carrierPatch?: string | null,
): ShipmentExpectedContext {
  if (liveLines.length === 0) {
    return enrichShipmentExpectedContextCarrier(ctx, carrierPatch);
  }

  const liveByKey = new Map<string, TrackingOperatorLine>();
  for (const line of liveLines) {
    liveByKey.set(line.groupKey, line);
    liveByKey.set(lineKeyFromParts(line.sku, line.fnsku, line.disposition), line);
  }

  const mergedLines = ctx.lines.map((line) => {
    const live =
      liveByKey.get(line.lineKey) ??
      (line.sku && line.fnsku
        ? liveByKey.get(lineKeyFromParts(line.sku, line.fnsku, ""))
        : undefined);
    if (!live) return line;
    return {
      ...line,
      expectedQty: Math.max(line.expectedQty, coerceQty(live.expectedQty)),
      scannedQty: coerceQty(live.scannedQty),
      title: titleFromTrackingLine(live) || line.title,
      asin: line.asin || live.asin?.trim() || null,
      fnsku: line.fnsku || live.fnsku?.trim() || null,
      sku: line.sku || live.sku?.trim() || null,
      resolvedProductId:
        line.resolvedProductId || live.product_linkage?.resolved_product_id?.trim() || live.expected_product_id?.trim() || null,
    };
  });

  const knownKeys = new Set(mergedLines.map((l) => l.lineKey));
  for (const live of liveLines) {
    const key = live.groupKey || lineKeyFromParts(live.sku, live.fnsku, live.disposition);
    if (knownKeys.has(key)) continue;
    mergedLines.push(lineFromTrackingOperatorLine(live));
  }

  const deduped = dedupeLines(mergedLines);
  const totals = summarizeLines(deduped);

  return enrichShipmentExpectedContextCarrier(
    {
      ...ctx,
      ...totals,
      lines: deduped,
    },
    carrierPatch,
  );
}

export function formatShipmentExpectedLineStatusLabel(status: ShipmentExpectedLineStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "partial":
      return "Partial";
    case "received":
      return "Received";
    case "over":
      return "Over";
    case "missing":
      return "Missing";
    default:
      return status;
  }
}
