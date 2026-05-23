/** Shown in duplicate-slip alert title (operator BOX intake). */
export const DUPLICATE_PACKING_SLIP_TITLE = "Duplicate Packing Slip";

/** User-facing body when `id_slip_contents` is already on another package in the org. */
export function formatDuplicatePackingSlipMessage(slipCode: string, otherBoxLabel: string): string {
  const slip = (slipCode ?? "").trim();
  const box = (otherBoxLabel ?? "").trim() || "—";
  return `This Slip Code (${slip}) has already been scanned in Box #${box}. Please use a unique slip or check the physical package.`;
}
