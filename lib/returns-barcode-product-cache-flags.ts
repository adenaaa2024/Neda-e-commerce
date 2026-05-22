/**
 * V165 — Governed optional insert into `products` from returns barcode Amazon mock/cache lane.
 * Default OFF. Does not affect display preview when disabled (lookup + UI still run).
 *
 * Env: ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT=true
 * Operator: .cursor/operator-approvals/product-auto-create-governance-v165-approval.md
 */

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** When false, returns wizard may not INSERT into products from barcode/Amazon cache path. */
export function isReturnsBarcodeProductCacheInsertEnabled(): boolean {
  return envFlag("ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT");
}

export type BarcodeProductCacheDisabledReason = "cache_insert_disabled";

export function barcodeProductCacheDisabledReason(): BarcodeProductCacheDisabledReason | null {
  return isReturnsBarcodeProductCacheInsertEnabled() ? null : "cache_insert_disabled";
}
