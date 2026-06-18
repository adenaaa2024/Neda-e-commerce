/**
 * Display helpers for box/shipment close review issue rows (UI only).
 */

import type { ProductGrain } from "@/lib/scanner/product-grain-match";

export type CloseReviewIdentifierFields = {
  fnsku?: string | null;
  asin?: string | null;
  sku?: string | null;
};

export type CloseReviewTitleInput = CloseReviewIdentifierFields & {
  title?: string | null;
  itemName?: string | null;
  productName?: string | null;
  /** Expected-line label — often FNSKU; used only as title fallback. */
  label?: string | null;
  grain?: ProductGrain | null;
};

function cell(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

function primaryIdentifier(input: CloseReviewTitleInput): string | null {
  return (
    cell(input.fnsku) ??
    cell(input.grain?.fnsku) ??
    cell(input.asin) ??
    cell(input.grain?.asin) ??
    cell(input.sku) ??
    cell(input.grain?.sku) ??
    cell(input.grain?.upc) ??
    cell(input.grain?.gtin) ??
    null
  );
}

/** Resolve a human-readable primary line; never returns blank. */
export function resolveCloseReviewLineTitle(input: CloseReviewTitleInput): string {
  const namedCandidates = [
    input.title,
    input.itemName,
    input.productName,
    input.grain?.title,
  ]
    .map(cell)
    .filter(Boolean) as string[];

  if (namedCandidates.length > 0) return namedCandidates[0];

  const label = cell(input.label);
  const identifier = primaryIdentifier(input);
  if (label && identifier && label.toUpperCase() !== identifier.toUpperCase()) {
    return label;
  }

  return identifier ?? label ?? "Unknown item";
}

export function resolveCloseReviewIdentifiers(
  input: CloseReviewTitleInput,
): CloseReviewIdentifierFields {
  return {
    fnsku: cell(input.fnsku) ?? cell(input.grain?.fnsku),
    asin: cell(input.asin) ?? cell(input.grain?.asin),
    sku: cell(input.sku) ?? cell(input.grain?.sku),
  };
}

/** Secondary identifier line — FNSKU first, then optional ASIN/SKU. */
export function formatCloseReviewIdentifierLine(ids: CloseReviewIdentifierFields): string | null {
  const fnsku = cell(ids.fnsku);
  const asin = cell(ids.asin);
  const sku = cell(ids.sku);

  const parts: string[] = [];
  if (fnsku) parts.push(`FNSKU: ${fnsku}`);
  if (asin) parts.push(`ASIN: ${asin}`);
  if (sku) parts.push(`SKU: ${sku}`);

  return parts.length > 0 ? parts.join(" · ") : null;
}
