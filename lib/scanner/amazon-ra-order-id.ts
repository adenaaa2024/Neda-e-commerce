/**
 * Amazon-style RA / return labels often embed the marketplace order id as the segment
 * between the **first** and **second** hyphen (not the full hyphenated token).
 *
 * The middle segment may include characters such as `/`, `.`, or `_` (not only alphanumerics).
 *
 * @example `8A0N3-N1gwF72i6S-CLE2-1` → `N1gwF72i6S`
 * @example `8A0N3-/x5UTzvZZK-IND8-1` → `/x5UTzvZZK`
 */
const MAX_EMBEDDED_ORDER_TOKEN_LEN = 128;

export function extractOrderIdFromAmazonStyleRa(raRaw: string): string | null {
  const ra = String(raRaw ?? "").trim();
  if (!ra) return null;
  const first = ra.indexOf("-");
  if (first < 0) return null;
  const second = ra.indexOf("-", first + 1);
  if (second <= first) return null;
  const mid = ra.slice(first + 1, second).trim();
  if (!mid || mid.length > MAX_EMBEDDED_ORDER_TOKEN_LEN) return null;
  return mid;
}

/**
 * Token from slip/RMA text for pallet order comparison.
 * Prefer Amazon-style middle segment when two hyphens exist; otherwise use the full trimmed string
 * (e.g. plain order tokens like `XYZ` from OCR).
 */
export function extractSlipOrderTokenForPalletCompare(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const fromHyphens = extractOrderIdFromAmazonStyleRa(trimmed);
  if (fromHyphens) return fromHyphens;
  if (trimmed.length > MAX_EMBEDDED_ORDER_TOKEN_LEN) {
    return trimmed.slice(0, MAX_EMBEDDED_ORDER_TOKEN_LEN);
  }
  return trimmed;
}
