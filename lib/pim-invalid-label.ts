/**
 * Vendor / category *names* that look like spreadsheet errors or bare identifiers,
 * not real taxonomy labels. Used for PIM filter dropdowns vs audit lists.
 */
const INVALID_LOWER = new Set([
  "unknown",
  "n/a",
  "na",
  "-",
  "--",
  "none",
  "null",
  "tbd",
  "pending",
  "misc",
  "other",
  "sku",
  "asin",
  "upc",
  "fnsku",
]);

const EXCEL_ERROR = /^(#\s*value!\s*|#\s*n\/?a\s*|#\s*ref!\s*|#\s*num!\s*|#\s*div\/0!\s*)$/i;

export function isPimInvalidVendorCategoryLabel(name: string): boolean {
  const t = name.trim();
  if (!t) return true;
  if (INVALID_LOWER.has(t.toLowerCase())) return true;
  if (EXCEL_ERROR.test(t)) return true;
  if (/^[0-9]+$/.test(t)) return true;
  if (/^[0-9]{8,14}$/.test(t)) return true;
  if (/^B0[A-Z0-9]{8}$/i.test(t)) return true;
  if (t.length === 10 && /^[A-Z0-9]{10}$/.test(t)) return true;
  if (/^X[A-Z0-9]{9,}$/i.test(t)) return true;
  return false;
}
