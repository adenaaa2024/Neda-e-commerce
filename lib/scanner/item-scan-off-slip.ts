/** Operator Item Scan: off-slip / extra units (warehouse truth — no open expected allocation). */

export const ITEM_SCAN_OFF_SLIP_NOTE_MARKER = "Not on packing slip";

export function returnItemNotesMarkOffSlip(notes: string | null | undefined): boolean {
  return new RegExp(ITEM_SCAN_OFF_SLIP_NOTE_MARKER, "i").test(String(notes ?? ""));
}

export function appendOffSlipAuditNote(existing: string | null | undefined): string {
  const base = String(existing ?? "").trim();
  if (returnItemNotesMarkOffSlip(base)) return base.slice(0, 2000);
  const suffix = ITEM_SCAN_OFF_SLIP_NOTE_MARKER;
  if (!base) return suffix;
  return `${base} · ${suffix}`.slice(0, 2000);
}

export const ITEM_SCAN_OFF_SLIP_MODAL_WARNING = {
  title: "Not on packing slip",
  message:
    "This item was not found on the packing slip or has no remaining expected quantity. It will be saved as an off-slip item.",
} as const;

/**
 * Item Scan insert path: off-slip / unexpected when barcode does not map to a slip line
 * on this box (and no EP-only allocatable hint). Matched slip rows always stay on-slip;
 * OVER is a quantity UI state, not unexpected.
 */
export function itemScanSaveShouldTreatAsOffSlip(input: {
  matchKindPreset: "fnsku" | "upc" | "unexpected" | null;
  slipContentId: string | null;
  slipExpectedQty: number;
  scannedForSlipQty: number;
  hasAllocatableExpectedPackageHint: boolean;
}): boolean {
  if (input.matchKindPreset === "unexpected") return true;
  const slipId = String(input.slipContentId ?? "").trim();
  if (slipId) return false;
  if (input.hasAllocatableExpectedPackageHint) return false;
  return true;
}
