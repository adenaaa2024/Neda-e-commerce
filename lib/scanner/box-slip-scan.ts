/**
 * Printed packing-slip id on warehouse paper (barcode value starting with "S").
 */
export function isPrintedSlipIdScan(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 3 || s.length > 80) return false;
  return /^S[A-Za-z0-9_-]+$/.test(s);
}
