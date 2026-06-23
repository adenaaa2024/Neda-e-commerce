/**
 * Phase 1 — Returns & Logistics report export (CSV / Excel).
 *
 * Pure, client-safe presentation helpers. No backend, no DB schema, no data
 * logic, no company-scope decisions. The caller (a data table) decides which
 * rows (already filtered + scoped) and which columns (visible only) to export,
 * and supplies a per-column value getter. This file only formats and triggers
 * the browser download, so it can never widen data scope.
 *
 * Excel uses the already-installed `xlsx` dependency, imported lazily so it is
 * only bundled where an export actually runs (client tables).
 */

/** Placeholder for empty/blank cells — matches the "—" the tables render. */
export const RETURNS_EXPORT_EMPTY_CELL = "—";

export type ReturnsExportColumnLabel<TColId extends string = string> = {
  id: TColId;
  label: string;
};

/** A fully materialized export grid: header row + body rows, all strings. */
export type ReturnsExportMatrix = {
  headers: string[];
  rows: string[][];
};

/** "items" → file/sheet "items", "packages" → "boxes", "pallets" → "pallets". */
export type ReturnsExportTab = "items" | "boxes" | "pallets";

/**
 * Normalize any raw cell value to a consistent export string.
 * `null` / `undefined` / empty become the shared "—" placeholder so exports
 * never contain the literal text "undefined" or "null".
 */
export function normalizeExportCell(value: unknown): string {
  if (value === null || value === undefined) return RETURNS_EXPORT_EMPTY_CELL;
  const text = typeof value === "string" ? value : String(value);
  const trimmed = text.trim();
  return trimmed === "" ? RETURNS_EXPORT_EMPTY_CELL : trimmed;
}

/**
 * Build the export grid from a set of *visible* column ids, a label registry,
 * and a per-cell value getter.
 *
 * - `visibleColumnIds` must already be the visible columns in display order;
 *   hidden columns are simply never passed in, so they can never be exported.
 * - Columns not present in `columnLabels` are dropped (defensive).
 * - Header labels are the user-facing labels from the registry, never DB field
 *   names.
 */
export function buildExportRowsFromVisibleColumns<TRow, TColId extends string>(params: {
  rows: readonly TRow[];
  visibleColumnIds: readonly TColId[];
  columnLabels: ReadonlyArray<ReturnsExportColumnLabel<TColId>>;
  getCellValue: (row: TRow, columnId: TColId) => unknown;
}): ReturnsExportMatrix {
  const labelById = new Map<TColId, string>();
  for (const c of params.columnLabels) labelById.set(c.id, c.label);

  const columns = params.visibleColumnIds.filter((id) => labelById.has(id));
  const headers = columns.map((id) => labelById.get(id) ?? id);
  const rows = params.rows.map((row) =>
    columns.map((id) => normalizeExportCell(params.getCellValue(row, id))),
  );
  return { headers, rows };
}

/** RFC 4180 cell escaping — quote when the value has a comma, quote, CR or LF. */
function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serialize a matrix to a CSV string (header row first). */
export function toCsv(matrix: ReturnsExportMatrix): string {
  return [matrix.headers, ...matrix.rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n");
}

/** Trigger a browser download for an in-memory blob. No-op on the server. */
function triggerDownload(blob: Blob, filename: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Download the matrix as a UTF-8 CSV file. A BOM is prepended so Excel opens
 * accented characters and the "—" placeholder correctly.
 */
export function exportRowsToCsv(filename: string, matrix: ReturnsExportMatrix): void {
  const csv = `\uFEFF${toCsv(matrix)}`;
  triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8;" }), filename);
}

/** Auto column widths (in characters), capped to a sane min/max. */
function computeColumnWidths(matrix: ReturnsExportMatrix): { wch: number }[] {
  return matrix.headers.map((header, columnIndex) => {
    let max = header.length;
    for (const row of matrix.rows) {
      const len = (row[columnIndex] ?? "").length;
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 8), 60) };
  });
}

/**
 * Download the matrix as an `.xlsx` workbook with a frozen header row and
 * auto-sized columns. `xlsx` is imported lazily so it only loads on demand.
 */
export async function exportRowsToXlsx(
  filename: string,
  matrix: ReturnsExportMatrix,
  sheetName = "Report",
): Promise<void> {
  const XLSX = await import("xlsx");
  const worksheet = XLSX.utils.aoa_to_sheet([matrix.headers, ...matrix.rows]);
  worksheet["!cols"] = computeColumnWidths(matrix);
  // Freeze the header row (best-effort; ignored by readers that don't support it).
  (worksheet as Record<string, unknown>)["!freeze"] = {
    xSplit: 0,
    ySplit: 1,
    topLeftCell: "A2",
    activePane: "bottomLeft",
    state: "frozen",
  };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  triggerDownload(
    new Blob([output], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
}

/** `returns-items-2026-06-23.csv` style filename for the active report tab. */
export function buildReturnsExportFilename(
  tab: ReturnsExportTab,
  ext: "csv" | "xlsx",
  date: Date = new Date(),
): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `returns-${tab}-${year}-${month}-${day}.${ext}`;
}
