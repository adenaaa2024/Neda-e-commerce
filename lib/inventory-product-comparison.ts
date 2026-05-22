/**
 * Canonical expected-vs-scanned product comparison keys for Neda inventory reads.
 * Prefers product identity when present, then falls back to deterministic identifiers.
 */

import type { ProductLinkageDisplayContract } from "./product-linkage-display-contract";

export type ProductComparisonStatus =
  | "matched"
  | "shortage"
  | "overage"
  | "unexpected"
  | "unresolved";

export type ProductComparisonKeyBundle = {
  product_key: string | null;
  identifier_fallback_key: string | null;
  resolved_product_id: string | null;
};

export type ExpectedScannedProductComparison = {
  expected_product_key: string | null;
  scanned_product_key: string | null;
  resolved_product_id: string | null;
  identifier_fallback_key: string | null;
  expected_qty: number;
  scanned_qty: number;
  variance_qty: number;
  status: ProductComparisonStatus;
};

export type ProductComparisonIdentifiers = {
  resolved_product_id?: string | null;
  product_id?: string | null;
  fnsku?: string | null;
  asin?: string | null;
  sku?: string | null;
  product_identifier?: string | null;
};

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function key(prefix: string, value: string): string {
  return `${prefix}:${value.trim().toLowerCase()}`;
}

function identifierFallbackKey(input: ProductComparisonIdentifiers): string | null {
  const fnsku = n(input.fnsku);
  if (fnsku) return key("fnsku", fnsku);

  const asin = n(input.asin);
  const sku = n(input.sku);
  if (asin && sku) return key("asin_sku", `${asin}|${sku}`);
  if (asin) return key("asin", asin);
  if (sku) return key("sku", sku);

  const productIdentifier = n(input.product_identifier);
  if (productIdentifier) return key("product_identifier", productIdentifier);

  return null;
}

export function buildProductComparisonKeyBundle(
  input: ProductComparisonIdentifiers,
): ProductComparisonKeyBundle {
  const resolvedProductId = n(input.resolved_product_id);
  const legacyProductId = n(input.product_id);
  const productKey = resolvedProductId
    ? key("product", resolvedProductId)
    : legacyProductId
      ? key("product", legacyProductId)
      : null;

  return {
    product_key: productKey,
    identifier_fallback_key: identifierFallbackKey(input),
    resolved_product_id: resolvedProductId ?? legacyProductId,
  };
}

export function productComparisonBundlesMatch(
  expected: ProductComparisonKeyBundle,
  scanned: ProductComparisonKeyBundle,
): boolean {
  if (expected.product_key && scanned.product_key) {
    return expected.product_key === scanned.product_key;
  }

  if (expected.identifier_fallback_key && scanned.identifier_fallback_key) {
    return expected.identifier_fallback_key === scanned.identifier_fallback_key;
  }

  return false;
}

function comparisonStatus(
  expectedQty: number,
  scannedQty: number,
  hasComparisonKey: boolean,
): ProductComparisonStatus {
  if (!hasComparisonKey) return "unresolved";
  if (expectedQty <= 0 && scannedQty > 0) return "unexpected";
  if (expectedQty > 0 && scannedQty === expectedQty) return "matched";
  if (expectedQty > 0 && scannedQty < expectedQty) return "shortage";
  if (expectedQty > 0 && scannedQty > expectedQty) return "overage";
  return "unresolved";
}

export function buildExpectedScannedProductComparison(input: {
  expected: ProductComparisonIdentifiers | ProductLinkageDisplayContract;
  scanned?: ProductComparisonIdentifiers | ProductLinkageDisplayContract | null;
  expectedQty: number;
  scannedQty: number;
}): ExpectedScannedProductComparison {
  const expected = buildProductComparisonKeyBundle(input.expected);
  const scanned = buildProductComparisonKeyBundle(input.scanned ?? input.expected);
  const expectedProductKey = input.expectedQty > 0
    ? expected.product_key ?? expected.identifier_fallback_key
    : null;
  const scannedProductKey = input.scannedQty > 0
    ? scanned.product_key ?? scanned.identifier_fallback_key
    : null;
  const hasComparisonKey = !!(
    expected.product_key ||
    scanned.product_key ||
    expected.identifier_fallback_key ||
    scanned.identifier_fallback_key
  );

  return {
    expected_product_key: expectedProductKey,
    scanned_product_key: scannedProductKey,
    resolved_product_id: expected.resolved_product_id ?? scanned.resolved_product_id,
    identifier_fallback_key: expected.identifier_fallback_key ?? scanned.identifier_fallback_key,
    expected_qty: input.expectedQty,
    scanned_qty: input.scannedQty,
    variance_qty: input.scannedQty - input.expectedQty,
    status: comparisonStatus(input.expectedQty, input.scannedQty, hasComparisonKey),
  };
}
