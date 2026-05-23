/**
 * Heuristic extraction for packing-slip barcodes (GPT-Vision OCR placeholder uses same shapes).
 */

export type SlipExtractResult = {
  vretId: string | null;
  shipmentId: string | null;
};

export function extractSlipIdsFromScan(raw: string): SlipExtractResult {
  const s = raw.trim();
  const vret = s.match(/\b(VRET\d{8,})\b/i)?.[1]?.toUpperCase() ?? null;
  const ups = s.match(/\b(1Z[A-Z0-9]{12,})\b/i)?.[1]?.toUpperCase() ?? null;
  const track = s.match(/\b(TRACK[-A-Z0-9]+)\b/i)?.[1] ?? null;
  return { vretId: vret, shipmentId: ups ?? track };
}

/** True when scan should run slip / OCR preview flow instead of carton package intake. */
export function looksLikePackingSlipScan(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (/^SLIP/i.test(s)) return true;
  if (/^PS-/i.test(s)) return true;
  if (/\bVRET\d{6,}\b/i.test(s)) return true;
  if (/\b1Z[A-Z0-9]{12,}\b/i.test(s)) return true;
  return false;
}
