"use client";

/**
 * Returns & Logistics — PDF report download (Phase 1, client-only).
 *
 * Generates the printable report PDF entirely in the browser via
 * `@react-pdf/renderer` (already a project dependency, also used by the Claim
 * Engine) and triggers a file download. No server rendering, no backend, no DB
 * schema. The caller supplies an already-built export matrix (visible columns +
 * filtered rows), report metadata, and summary stats.
 */

import { pdf } from "@react-pdf/renderer";
import type { ReturnsExportMatrix, ReturnsExportTab } from "../../lib/returns-report-export";
import {
  buildReturnsPdfReportFilename,
  limitMatrixRowsForPdf,
  type ReturnsPdfHeaderMeta,
  type ReturnsPdfSummaryStat,
} from "../../lib/returns-report-pdf";
import { ReturnsReportPdfDocument } from "./returns-report-pdf-document";

export async function downloadReturnsReportPdf(opts: {
  tab: ReturnsExportTab;
  meta: ReturnsPdfHeaderMeta;
  summary: ReturnsPdfSummaryStat[];
  /** Full export matrix (visible columns + filtered rows). Trimmed here for PDF. */
  matrix: ReturnsExportMatrix;
  filename?: string;
  date?: Date;
}): Promise<void> {
  const { matrix, totalRows, note } = limitMatrixRowsForPdf(opts.matrix);
  const blob = await pdf(
    <ReturnsReportPdfDocument
      tab={opts.tab}
      meta={opts.meta}
      summary={opts.summary}
      matrix={matrix}
      totalRows={totalRows}
      truncationNote={note}
    />,
  ).toBlob();

  if (typeof window === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = opts.filename ?? buildReturnsPdfReportFilename(opts.tab, opts.date);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
