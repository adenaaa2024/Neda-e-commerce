/**
 * Values allowed for `raw_report_uploads.report_type` on PIM (non-Amazon) imports.
 * Must stay in sync with `raw_report_uploads_report_type_check` (Supabase migration).
 */
export const PIM_RAW_REPORT_TYPES = [
  /** Legacy / Python ETL seed-products audit rows */
  "PIM_CATALOG_SEED",
  "pim_catalog_seed",
  "pim_product_master",
  "pim_price_history",
  "pim_identifier_map",
  "pim_vendor_reference",
  "pim_category_reference",
] as const;

export type PimRawReportType = (typeof PIM_RAW_REPORT_TYPES)[number];

export function isPimRawReportType(reportType: string | null | undefined): boolean {
  const s = String(reportType ?? "").trim();
  return (PIM_RAW_REPORT_TYPES as readonly string[]).includes(s);
}
