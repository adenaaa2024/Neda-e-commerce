/** Operator Item Scan — over-limit confirmation before save (slip qty or shipment EP qty). */

export type ItemScanOverLimitScope = "slip" | "shipment" | "none";

export type ItemScanOverLimitContext = {
  scope: ItemScanOverLimitScope;
  expectedLimit: number;
  currentReceived: number;
  slipId: string | null;
  expectedPackageHintId: string | null;
};

function normToken(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

function floorQty(value: unknown): number {
  return Math.max(0, Math.floor(Number(value ?? 0)));
}

/** True when saving `incomingQty` would exceed `expectedLimit` (strictly greater). */
export function wouldExceedItemScanExpectedLimit(input: {
  currentReceived: number;
  incomingQty: number;
  expectedLimit: number;
}): boolean {
  const limit = floorQty(input.expectedLimit);
  if (limit <= 0) return false;
  const current = floorQty(input.currentReceived);
  const incoming = Math.max(1, floorQty(input.incomingQty));
  return current + incoming > limit;
}

export function shouldRequireItemScanOverLimitConfirmation(input: {
  currentReceived: number;
  incomingQty: number;
  expectedLimit: number;
  overLimitConfirmed?: boolean;
}): boolean {
  if (input.overLimitConfirmed) return false;
  return wouldExceedItemScanExpectedLimit(input);
}

function sumEpExpected(epRows: Record<string, unknown>[]): number {
  return epRows.reduce((s, r) => s + floorQty(r.expected_scan_quantity), 0);
}

function sumEpActualScanned(epRows: Record<string, unknown>[]): number {
  return epRows.reduce((s, r) => s + floorQty(r.actual_scanned_count), 0);
}

function epRowsMatchingBarcode(
  barcode: string,
  matchKind: "fnsku" | "upc" | "unexpected",
  epRows: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (matchKind === "unexpected") return [];
  const code = normToken(barcode);
  if (!code) return [];
  return epRows.filter((r) => {
    const f = normToken(String(r.fnsku ?? ""));
    const sku = normToken(String(r.sku ?? ""));
    if (matchKind === "fnsku") return Boolean(f && f === code);
    if (matchKind === "upc") return Boolean(sku && sku === code);
    return false;
  });
}

function pickPrimaryEpRow(epRows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (epRows.length === 0) return null;
  const withRemaining = epRows.find((r) => {
    const exp = floorQty(r.expected_scan_quantity);
    const act = floorQty(r.actual_scanned_count);
    return exp - act > 0;
  });
  return withRemaining ?? epRows[0] ?? null;
}

/**
 * Resolve expected limit + current received for over-limit confirmation.
 * Slip row wins when allocated; shipment-only when no slip but EP matches barcode.
 */
export function resolveItemScanOverLimitContext(input: {
  saveAsOffSlip: boolean;
  matchKind: "fnsku" | "upc" | "unexpected";
  scannedBarcode: string;
  slipContentId: string | null;
  slipExpectedQty: number;
  scannedForSlipQty: number;
  expectedPkgDetailRows: Record<string, unknown>[];
}): ItemScanOverLimitContext {
  const none: ItemScanOverLimitContext = {
    scope: "none",
    expectedLimit: 0,
    currentReceived: 0,
    slipId: null,
    expectedPackageHintId: null,
  };
  if (input.saveAsOffSlip || input.matchKind === "unexpected") return none;

  const slipId = String(input.slipContentId ?? "").trim();
  if (slipId) {
    const expectedLimit = floorQty(input.slipExpectedQty);
    if (expectedLimit <= 0) return none;
    return {
      scope: "slip",
      expectedLimit,
      currentReceived: floorQty(input.scannedForSlipQty),
      slipId,
      expectedPackageHintId: null,
    };
  }

  const epRows = Array.isArray(input.expectedPkgDetailRows) ? input.expectedPkgDetailRows : [];
  const matched = epRowsMatchingBarcode(input.scannedBarcode, input.matchKind, epRows);
  if (matched.length === 0) return none;

  const expectedLimit = sumEpExpected(matched);
  if (expectedLimit <= 0) return none;

  const primary = pickPrimaryEpRow(matched);
  const hintId = primary ? String(primary.id ?? "").trim() : "";
  return {
    scope: "shipment",
    expectedLimit,
    currentReceived: sumEpActualScanned(matched),
    slipId: null,
    expectedPackageHintId: hintId || null,
  };
}
