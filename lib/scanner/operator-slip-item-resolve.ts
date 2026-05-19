/**
 * Match operator-scanned barcodes against packing-slip lines (`slip_contents` / vision rows).
 * Priority: FNSKU tier first, then UPC (no SKU/ASIN on slip-only matching).
 */

export type SlipItemResolveTier = "fnsku" | "upc";

export type SlipBarcodeMatchRow = {
  id: string | null;
  upc: string | null;
  fnsku: string | null;
  description: string | null;
  quantity: number;
  sort_index: number;
};

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function cell(s: string | null | undefined): string {
  return typeof s === "string" ? s.trim() : "";
}

export type SlipItemResolveOutcome =
  | { kind: "none"; barcode: string }
  | { kind: "single"; tier: SlipItemResolveTier; barcode: string; slip: SlipBarcodeMatchRow }
  | { kind: "ambiguous"; tier: SlipItemResolveTier; barcode: string; candidates: SlipBarcodeMatchRow[] };

/**
 * Returns matches at the highest-priority tier only (FNSKU before UPC).
 */
export function resolveItemBarcodeAgainstSlipRows(
  rawBarcode: string,
  rows: SlipBarcodeMatchRow[],
): SlipItemResolveOutcome {
  const barcode = rawBarcode.trim();
  if (!barcode) return { kind: "none", barcode };

  const tiers: { tier: SlipItemResolveTier; pick: (r: SlipBarcodeMatchRow) => string }[] = [
    { tier: "fnsku", pick: (r) => cell(r.fnsku) },
    { tier: "upc", pick: (r) => cell(r.upc) },
  ];

  const bc = norm(barcode);

  for (const { tier, pick } of tiers) {
    const candidates = rows.filter((r) => {
      const v = pick(r);
      return v.length > 0 && norm(v) === bc;
    });
    if (candidates.length === 1) return { kind: "single", tier, barcode, slip: candidates[0]! };
    if (candidates.length > 1) return { kind: "ambiguous", tier, barcode, candidates };
  }

  return { kind: "none", barcode };
}
