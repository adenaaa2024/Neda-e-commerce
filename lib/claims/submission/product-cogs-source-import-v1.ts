/**
 * COGS import parsers — CSV/XLSX preview-first; rejects sale/list price columns.
 */
import * as XLSX from "xlsx";

import {
  detectForbiddenImportHeaders,
  REJECTED_SOURCE_FIELDS,
} from "@/lib/products/contracts/product-cogs-source-build-v1";
import type { ImportRowInputV1 } from "@/lib/claims/submission/product-cogs-manual-entry-ui-v1";

export type ImportParseResultV1 = {
  rows: ImportRowInputV1[];
  rejectedHeaders: string[];
  format: "csv" | "xlsx" | "rows";
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

function rowFromSimpleObject(obj: Record<string, unknown>): ImportRowInputV1 | null {
  const keys = Object.keys(obj).reduce<Record<string, string>>((acc, k) => {
    acc[normalizeHeader(k)] = String(obj[k] ?? "").trim();
    return acc;
  }, {});

  const fnsku = keys.fnsku ?? "";
  const sku = keys.sku ?? "";
  const asin = keys.asin ?? "";
  const cost = keys.cost ?? keys.unit_cost ?? keys.cogs_unit ?? "";

  let identifier_type = "";
  let identifier_value = "";
  if (fnsku) {
    identifier_type = "FNSKU";
    identifier_value = fnsku;
  } else if (sku) {
    identifier_type = "SKU";
    identifier_value = sku;
  } else if (asin) {
    identifier_type = "ASIN";
    identifier_value = asin;
  } else if (keys.identifier_type && keys.identifier_value) {
    identifier_type = keys.identifier_type.toUpperCase();
    identifier_value = keys.identifier_value;
  }

  if (!identifier_type || !identifier_value || !cost) return null;

  return {
    identifier_type,
    identifier_value,
    unit_cost: cost,
    currency: keys.currency || "USD",
    effective_date: keys.effective_date ?? "",
    source_note: keys.source ?? keys.source_note ?? keys.notes ?? "",
    approved_by: keys.approved_by,
    source_type: keys.source_type ?? "csv_import",
  };
}

export function parseImportRowsFromObjects(objects: Record<string, unknown>[]): ImportParseResultV1 {
  if (objects.length === 0) {
    return { rows: [], rejectedHeaders: [], format: "rows" };
  }
  const headers = Object.keys(objects[0] ?? {});
  const rejectedHeaders = detectForbiddenImportHeaders(headers);
  const rows = objects
    .map(rowFromSimpleObject)
    .filter((r): r is ImportRowInputV1 => r != null);
  return { rows, rejectedHeaders, format: "rows" };
}

export function parseCogsImportXlsxBufferV1(buffer: ArrayBuffer): ImportParseResultV1 {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], rejectedHeaders: [], format: "xlsx" };
  const sheet = workbook.Sheets[sheetName];
  const objects = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const result = parseImportRowsFromObjects(objects);
  return { ...result, format: "xlsx" };
}

export function parseCogsImportCsvTextV1(text: string): ImportParseResultV1 {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { rows: [], rejectedHeaders: [], format: "csv" };

  const headerCells = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rejectedHeaders = detectForbiddenImportHeaders(headerCells);

  const objects: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const obj: Record<string, unknown> = {};
    headerCells.forEach((h, i) => {
      obj[h] = cells[i] ?? "";
    });
    objects.push(obj);
  }

  const rows = objects
    .map(rowFromSimpleObject)
    .filter((r): r is ImportRowInputV1 => r != null);

  return { rows, rejectedHeaders, format: "csv" };
}

export { REJECTED_SOURCE_FIELDS };
