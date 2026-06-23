/**
 * Phase 1 — Returns & Logistics PDF report (printable summary).
 *
 * Pure, client-safe presentation helpers only. No backend, no DB schema, no
 * data logic, no company-scope decisions. The caller (a data table) decides
 * which rows (already filtered + scoped) and which columns (visible only) to
 * pass in; this module only shapes the export matrix for a readable PDF,
 * formats the header/summary metadata, and builds the file name.
 *
 * Rendering and the actual `.pdf` download live in the client-only
 * `app/returns/returns-report-pdf-document.tsx` and
 * `app/returns/returns-report-pdf-download.tsx` (they import `@react-pdf/renderer`).
 */

import type { ReturnsExportMatrix, ReturnsExportTab } from "./returns-report-export";

/** Brand wordmark shown in the PDF header. */
export const RETURNS_PDF_BRAND = "MENORIX";

/** Max rows rendered into a PDF before truncation (CSV/Excel stay full). */
export const RETURNS_PDF_MAX_ROWS = 100;

/** User-facing report title per active tab. */
export const RETURNS_PDF_REPORT_TITLE: Record<ReturnsExportTab, string> = {
  items: "Returns Items Report",
  boxes: "Returns Boxes Report",
  pallets: "Returns Pallets Report",
};

/** Report-scope metadata shown in the PDF header band. */
export type ReturnsPdfHeaderMeta = {
  /** Company scope, e.g. "All companies" or a single company display name. */
  companyScope: string;
  /** Store filter scope, e.g. "All stores" or a single store name. */
  storeScope: string;
  /** Active saved view name, when one is applied. */
  activeViewName?: string | null;
  /** ISO timestamp the report was generated (defaults to now at render time). */
  generatedAt?: string;
};

/** One labeled stat in the PDF summary band. */
export type ReturnsPdfSummaryStat = {
  label: string;
  value: string;
};

/**
 * Trim an export matrix to at most `RETURNS_PDF_MAX_ROWS` rows for PDF
 * readability. Returns the (possibly trimmed) matrix plus the original total
 * and a flag/note for the caller to render. CSV/Excel never use this — they
 * always export the full matrix.
 */
export function limitMatrixRowsForPdf(
  matrix: ReturnsExportMatrix,
  max: number = RETURNS_PDF_MAX_ROWS,
): { matrix: ReturnsExportMatrix; totalRows: number; truncated: boolean; note: string | null } {
  const totalRows = matrix.rows.length;
  if (totalRows <= max) {
    return { matrix, totalRows, truncated: false, note: null };
  }
  return {
    matrix: { headers: matrix.headers, rows: matrix.rows.slice(0, max) },
    totalRows,
    truncated: true,
    note: `Showing first ${max} rows. Use CSV/Excel for full export.`,
  };
}

/** Format a numeric stat value; null/undefined become an en dash. */
export function formatPdfStatValue(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return String(value);
}

/**
 * `returns-items-report-2026-06-23.pdf` style file name for the active tab.
 * Distinct from the CSV/Excel naming (which omits the "-report" segment).
 */
export function buildReturnsPdfReportFilename(
  tab: ReturnsExportTab,
  date: Date = new Date(),
): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `returns-${tab}-report-${year}-${month}-${day}.pdf`;
}
