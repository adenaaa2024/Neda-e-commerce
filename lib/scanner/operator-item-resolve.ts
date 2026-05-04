/**
 * Smart resolver for operator item scan: exact match priority against `expected_packages`-style rows.
 * Priority: FNSKU → UPC → SKU → ASIN (first tier with ≥1 match wins; caller handles ambiguity).
 */

export type ItemResolveTier = "fnsku" | "upc" | "sku" | "asin";

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function cell(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
}

/** Reads optional catalog columns if present on the row. */
function rowUpc(row: Record<string, unknown>): string {
  return cell(row, "upc") || cell(row, "product_upc") || cell(row, "gtin") || "";
}

function rowAsin(row: Record<string, unknown>): string {
  return cell(row, "asin") || cell(row, "product_asin") || "";
}

export type ItemResolveOutcome =
  | { kind: "none"; barcode: string }
  | { kind: "single"; tier: ItemResolveTier; barcode: string; row: Record<string, unknown> }
  | { kind: "ambiguous"; tier: ItemResolveTier; barcode: string; candidates: Record<string, unknown>[] };

/**
 * Returns matches at the highest-priority tier only (no cross-tier merging).
 */
export function resolveItemBarcodeAgainstExpectedRows(
  rawBarcode: string,
  rows: Record<string, unknown>[],
): ItemResolveOutcome {
  const barcode = rawBarcode.trim();
  if (!barcode) return { kind: "none", barcode };

  const tiers: { tier: ItemResolveTier; pick: (r: Record<string, unknown>) => string }[] = [
    { tier: "fnsku", pick: (r) => cell(r, "fnsku") },
    { tier: "upc", pick: (r) => rowUpc(r) },
    { tier: "sku", pick: (r) => cell(r, "sku") },
    { tier: "asin", pick: (r) => rowAsin(r) },
  ];

  const bc = norm(barcode);

  for (const { tier, pick } of tiers) {
    const candidates = rows.filter((r) => {
      const v = pick(r);
      return v.length > 0 && norm(v) === bc;
    });
    if (candidates.length === 1) return { kind: "single", tier, barcode, row: candidates[0]! };
    if (candidates.length > 1) return { kind: "ambiguous", tier, barcode, candidates };
  }

  return { kind: "none", barcode };
}
