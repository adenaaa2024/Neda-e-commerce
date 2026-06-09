/** Shown when DB migration / Phase 3B batch quantity is not applied yet. */
export const BATCH_QUANTITY_BACKEND_NOT_ENABLED_MESSAGE =
  "Batch quantity backend not enabled yet";

function isScannedQuantityColumnMissingError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("42703") ||
    (m.includes("column") &&
      m.includes("scanned_quantity") &&
      (m.includes("does not exist") ||
        m.includes("undefined column") ||
        m.includes("schema cache")))
  );
}

/**
 * When quantity > 1 insert fails because `return_items.scanned_quantity` is unavailable,
 * return the operator-facing guard message instead of falling back to N single-row inserts.
 */
export function guardBatchQuantityBackendError(
  quantity: number,
  rawError: string | null | undefined,
): string | null {
  if (quantity <= 1) return null;
  const err = String(rawError ?? "").trim();
  if (!err) return BATCH_QUANTITY_BACKEND_NOT_ENABLED_MESSAGE;
  if (isScannedQuantityColumnMissingError(err)) {
    return BATCH_QUANTITY_BACKEND_NOT_ENABLED_MESSAGE;
  }
  return null;
}
