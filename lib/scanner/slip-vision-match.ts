import type { SlipVisionLine } from "./slip-extract-parse";

export type SlipVisionItemRow = SlipVisionLine & {
  match: "expected" | "unexpected";
  matchedHint?: string;
};

/** Trim, lowercase, remove all whitespace — for ID-style fields. */
function normCompact(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

/** Lowercase letters+digits only — useful when comparing titles vs codes. */
function alphanumericLower(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function rowAsin(row: Record<string, unknown>): string {
  return normCompact(String(row.asin ?? row.product_asin ?? row.ASIN ?? ""));
}

function identifiersRoughlyMatch(a: string, b: string, minLen: number): boolean {
  if (!a || !b || a.length < minLen || b.length < minLen) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * When Vision puts a product title in `description`, try to relate it to SKU/FNSKU
 * (exact/alphanumeric containment, min length to reduce false positives).
 */
function slipDescriptionMatchesRowSkuFnsku(descRaw: string | null | undefined, row: Record<string, unknown>): boolean {
  const desc = String(descRaw ?? "").trim();
  if (!desc) return false;

  const dCompact = normCompact(desc);
  const dAlpha = alphanumericLower(desc);
  const rSku = normCompact(String(row.sku ?? ""));
  const rFnsku = normCompact(String(row.fnsku ?? ""));
  const rSkuAlpha = alphanumericLower(row.sku);
  const rFnskuAlpha = alphanumericLower(row.fnsku);

  const MIN_ID = 4;

  if (rSku && dCompact && identifiersRoughlyMatch(dCompact, rSku, MIN_ID)) return true;
  if (rFnsku && dCompact && identifiersRoughlyMatch(dCompact, rFnsku, MIN_ID)) return true;

  if (rSkuAlpha.length >= MIN_ID && dAlpha.length >= MIN_ID && identifiersRoughlyMatch(dAlpha, rSkuAlpha, MIN_ID)) {
    return true;
  }
  if (rFnskuAlpha.length >= MIN_ID && dAlpha.length >= MIN_ID && identifiersRoughlyMatch(dAlpha, rFnskuAlpha, MIN_ID)) {
    return true;
  }

  return false;
}

/** True if this AI line corresponds to an expected_packages row. */
export function slipLineMatchesEpRow(item: SlipVisionLine, row: Record<string, unknown>): boolean {
  const sku = normCompact(item.sku);
  const asin = normCompact(item.asin);
  const bc = normCompact(item.barcode);
  const rSku = normCompact(String(row.sku ?? ""));
  const rFnsku = normCompact(String(row.fnsku ?? ""));
  const rAsin = rowAsin(row);

  if (sku && rSku && sku === rSku) return true;
  if (asin && rAsin && asin === rAsin) return true;
  if (bc && rSku && bc === rSku) return true;
  if (bc && rFnsku && bc === rFnsku) return true;

  if (slipDescriptionMatchesRowSkuFnsku(item.description, row)) return true;

  return false;
}

export function attachMatchStatusToSlipItems(
  items: SlipVisionLine[],
  epRows: Record<string, unknown>[],
): SlipVisionItemRow[] {
  return items.map((item) => {
    const hit = epRows.find((row) => slipLineMatchesEpRow(item, row));
    const skuHint = hit ? String(hit.sku ?? "").trim() : "";
    const fnskuHint = hit ? String(hit.fnsku ?? "").trim() : "";
    const matchedHint =
      skuHint || fnskuHint ? [skuHint && `SKU ${skuHint}`, fnskuHint && `FNSKU ${fnskuHint}`].filter(Boolean).join(" · ") : undefined;
    return {
      ...item,
      match: hit ? "expected" : "unexpected",
      matchedHint,
    };
  });
}
