import { isUuidString } from "@/lib/uuid";

/** Mirror canonical resolver output to legacy `return_items.product_id` when resolved. */
export function legacyProductIdFromResolved(
  resolvedProductId: string | null | undefined,
): string | null {
  const id = String(resolvedProductId ?? "").trim();
  return isUuidString(id) ? id : null;
}

export function withLegacyProductIdPatch(
  patch: Record<string, unknown>,
  resolvedProductId: string | null | undefined,
): Record<string, unknown> {
  const productId = legacyProductIdFromResolved(resolvedProductId);
  if (productId) patch.product_id = productId;
  return patch;
}
