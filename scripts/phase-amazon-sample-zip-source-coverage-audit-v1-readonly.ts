/**
 * PHASE-AMAZON-SAMPLE-ZIP-SOURCE-COVERAGE-AUDIT-V1
 * Read-only inspection of Maysam sample zip — no DB writes, no imports.
 *
 *   npx tsx scripts/phase-amazon-sample-zip-source-coverage-audit-v1-readonly.ts
 *   npx tsx scripts/phase-amazon-sample-zip-source-coverage-audit-v1-readonly.ts "C:\path\to\test.zip"
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  AMAZON_REPORT_CROSSWALK_LIVE,
  SP_API_REPORT_TYPE_TO_SYNC_KIND,
} from "../lib/amazon/amazon-report-type-crosswalk";
import {
  buildColumnMappingFromHeaders,
  CANONICAL_FIELDS_PER_TYPE,
  classifyCsvHeadersRuleBased,
  mappingHasRequiredGaps,
} from "../lib/csv-import-detected-type";
import { AMAZON_REPORT_REGISTRY, type AmazonSyncKind } from "../lib/pipeline/amazon-report-registry";
import type { RawReportType } from "../lib/raw-report-types";
import { CLASSIFIED_REPORT_TYPES } from "../lib/csv-import-detected-type";

const DEFAULT_ZIP = String.raw`c:\Maysam\Automation\Refund & Claim\Reports\MVP FILES\test.zip`;
const OUT_BASE = ".cursor/audit-reports/phase-amazon-sample-zip-source-coverage-audit-v1";

type ColumnBuckets = {
  identifiers: string[];
  quantity: string[];
  amount: string[];
  date: string[];
  dimensions_weight: string[];
  fee: string[];
  product_price: string[];
};

type FileAudit = {
  filename: string;
  zip_entry: string;
  size_bytes: number;
  encoding: string;
  delimiter: string;
  header_row_index: number;
  header_columns: string[];
  data_row_count: number;
  report_family_label: string;
  detected_report_type: RawReportType;
  detection_method: string;
  date_range_from_filename: string | null;
  date_range_from_content: string | null;
  column_buckets: ColumnBuckets;
  core_identifiers_present: Record<string, boolean>;
  required_columns_expected: string[];
  missing_required_columns: string[];
  extra_columns_not_in_canonical: string[];
  existing_normalized_table: string | null;
  missing_normalized_table: boolean;
  universal_importer_support: "yes" | "no" | "partial";
  api_sync_support: "yes" | "no" | "partial";
  sp_api_report_type: string | null;
  source_health_page_support: "yes" | "no" | "partial";
  coverage: {
    product_linkage: "yes" | "no" | "partial";
    lifecycle_quantities: string[];
    claim_candidates: string[];
    trid_reference_edges: "frr" | "graph_only" | "none" | "ledger_pim";
    product_story: "yes" | "no" | "partial";
    money_cost_recovery: "yes" | "no" | "partial";
    fee_dimension_claims: "yes" | "no" | "partial";
  };
  priority: "required_now" | "required_next" | "later" | "optional" | "unsupported";
  notes: string[];
};

const SOURCE_HEALTH_KEYS = new Set([
  "fba_customer_returns",
  "inventory_ledger",
  "reimbursements",
  "transactions",
  "settlements",
  "removal_order_detail",
  "removal_shipment_detail",
  "safet",
  "inbound_performance",
]);

const API_LIVE: Partial<Record<AmazonSyncKind, "yes" | "partial">> = {
  REMOVAL_ORDER: "yes",
  REMOVAL_SHIPMENT: "yes",
  REIMBURSEMENTS: "partial",
  SETTLEMENT: "partial",
};

const LIFECYCLE_BY_KIND: Partial<Record<AmazonSyncKind, string[]>> = {
  FBA_RETURNS: ["customer_returned", "damaged"],
  INVENTORY_LEDGER: ["lost", "disposed", "damaged", "unreimbursed_gap"],
  REIMBURSEMENTS: ["reimbursed"],
  SETTLEMENT: ["sold", "refunded_or_canceled"],
  TRANSACTIONS: ["sold", "refunded_or_canceled"],
  SAFET_CLAIMS: ["unreimbursed_gap"],
  REMOVAL_ORDER: ["removed_created", "disposed"],
  REMOVAL_SHIPMENT: ["removed_shipped"],
  ALL_ORDERS: ["sold"],
  REPLACEMENTS: ["replacement_shipped"],
  FBA_GRADE_AND_RESELL: ["graded_resell"],
  MANAGE_FBA_INVENTORY: ["available_fba"],
  FBA_INVENTORY: ["available_fba", "reserved_fba", "expired"],
  INBOUND_PERFORMANCE: ["sent_to_amazon", "received_by_amazon"],
  RESERVED_INVENTORY: ["reserved_fba"],
  FEE_PREVIEW: ["fee_or_dimension_issue"],
  MONTHLY_STORAGE_FEES: ["fee_or_dimension_issue"],
};

const CLAIM_BY_KIND: Partial<Record<AmazonSyncKind, string[]>> = {
  FBA_RETURNS: ["customer_return_not_reimbursed", "delayed_not_received"],
  INVENTORY_LEDGER: ["inventory_lost_damaged", "disposed_without_reimbursement"],
  REIMBURSEMENTS: ["reimbursement_verification", "reimbursement_reversal"],
  SETTLEMENT: ["settlement_refund_anomaly"],
  TRANSACTIONS: ["settlement_refund_anomaly", "transaction_negative_adjustment"],
  SAFET_CLAIMS: ["safet_claims", "safet_followup"],
  REMOVAL_ORDER: ["removal_discrepancy", "removal_missing_units"],
  REMOVAL_SHIPMENT: ["removal_shipped_vs_detail_mismatch", "shipment_discrepancy"],
  INBOUND_PERFORMANCE: ["inbound_shipment_shortage", "inbound_shipment_discrepancy"],
  FBA_INVENTORY: ["fba_available_reserved_stranded_inventory", "expired_inventory"],
  RESERVED_INVENTORY: ["fba_available_reserved_stranded_inventory"],
  FEE_PREVIEW: ["fee_dimension_overcharge"],
  MONTHLY_STORAGE_FEES: ["storage_fee_issue"],
};

const PRIORITY_BY_KIND: Partial<Record<AmazonSyncKind, FileAudit["priority"]>> = {
  INVENTORY_LEDGER: "required_now",
  REIMBURSEMENTS: "required_now",
  SETTLEMENT: "required_now",
  SAFET_CLAIMS: "required_now",
  FBA_RETURNS: "required_next",
  REMOVAL_ORDER: "required_next",
  REMOVAL_SHIPMENT: "required_next",
  TRANSACTIONS: "required_next",
  INBOUND_PERFORMANCE: "required_next",
  FBA_INVENTORY: "required_next",
  ALL_ORDERS: "later",
  REPLACEMENTS: "later",
  FBA_GRADE_AND_RESELL: "later",
  MANAGE_FBA_INVENTORY: "later",
  RESERVED_INVENTORY: "later",
  FEE_PREVIEW: "later",
  MONTHLY_STORAGE_FEES: "later",
  REPORTS_REPOSITORY: "optional",
  ALL_LISTINGS: "later",
  ACTIVE_LISTINGS: "later",
  CATEGORY_LISTINGS: "later",
};

const MISSING_SOURCES_CHECKLIST = [
  "Stranded Inventory",
  "Inventory Adjustments (Ledger subset — filter, not separate file)",
  "Daily Inventory History / Amazon Fulfilled Inventory",
  "Inbound Shipment Detail / Received Inventory (standalone)",
  "Shipment Reconciliation",
  "SellerSnap COGS",
  "Catalog UPC / Product Identity CSV",
  "SAFE-T non-empty export (zip has header-only file)",
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function norm(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[_\s]+/g, " ")
    .replace(/-+/g, "-");
}

function detectEncoding(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf-8-bom";
  const sample = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf8");
  if (sample.includes("\ufffd")) return "latin1";
  return "utf-8";
}

function decodeBuffer(buf: Buffer, encoding: string): string {
  if (encoding === "utf-8-bom") return buf.subarray(3).toString("utf8");
  if (encoding === "latin1") return buf.toString("latin1");
  return buf.toString("utf8");
}

function detectDelimiter(line: string): string {
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  const pipes = (line.match(/\|/g) ?? []).length;
  if (tabs >= commas && tabs >= pipes && tabs > 0) return "\t";
  if (pipes > commas && pipes > tabs) return "|";
  return ",";
}

function splitRow(line: string, delimiter: string): string[] {
  if (delimiter === "\t") return line.split("\t").map((c) => c.trim());
  if (delimiter === "|") return line.split("|").map((c) => c.trim());
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function findHeaderRow(lines: string[]): { index: number; headers: string[]; delimiter: string } {
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    const delimiter = detectDelimiter(line);
    const headers = splitRow(line, delimiter);
    const ds = new Set(headers.map(norm));
    if (
      ds.has("settlement id") &&
      (ds.has("transaction type") || ds.has("transaction status")) &&
      headers.length >= 6
    ) {
      return { index: i, headers, delimiter };
    }
    if (
      ds.has("date time") &&
      ds.has("settlement id") &&
      ds.has("order id") &&
      ds.has("sku")
    ) {
      return { index: i, headers, delimiter };
    }
    if (headers.length >= 4 && !line.startsWith('"Includes')) {
      const classified = classifyCsvHeadersRuleBased(headers);
      if (classified.reportType !== "UNKNOWN") {
        return { index: i, headers, delimiter };
      }
      const joined = headers.map(norm).join(" ");
      if (
        joined.includes("asin") ||
        joined.includes("fnsku") ||
        joined.includes("sku") ||
        joined.includes("order") ||
        joined.includes("shipment")
      ) {
        return { index: i, headers, delimiter };
      }
    }
  }
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  const delimiter = detectDelimiter(first);
  return { index: 0, headers: splitRow(first, delimiter), delimiter };
}

function countDataRows(filePath: string, headerIndex: number): number {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]?.trim()) count++;
  }
  return count;
}

function parseDateRangeFromFilename(name: string): string | null {
  const base = path.basename(name);
  const m =
    base.match(/(\d{2})(\d{4})-(\d{2})(\d{4})/) ??
    base.match(/(\d{2})(\d{2})(\d{4})-(\d{2})(\d{2})(\d{4})/) ??
    base.match(/(\d{1,2})[_/](\d{1,2})[_/](\d{4})\s*-\s*(\d{1,2})[_/](\d{1,2})[_/](\d{4})/) ??
    base.match(/(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (m) return m[0];
  const month = base.match(/(\d{2})(\d{4})\.csv/i);
  if (month) return `month ${month[1]}/${month[2]}`;
  return null;
}

function reportFamilyFromFilename(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("customer shipment")) return "Customer Shipment Sales / Fulfilled Shipments";
  if (n.includes("fba customer returns")) return "FBA Customer Returns";
  if (n.includes("grade and resell")) return "FBA Grade and Resell";
  if (n.includes("inbound placement")) return "Inbound Placement Service Fees";
  if (n.includes("fee preview")) return "Fee Preview";
  if (n.includes("inbound performance")) return "Inbound Performance";
  if (n.includes("inventory ledger")) return "Inventory Ledger";
  if (n.includes("low-inventory")) return "Low-Inventory-Level Fee Report";
  if (n.includes("manage fba inventory")) return "Manage FBA Inventory";
  if (n.includes("monthly storage")) return "Monthly Storage Fees";
  if (n.includes("open") && n.includes("listing")) return "Open Listings Report Lite";
  if (n.includes("reimbursement")) return "Reimbursements";
  if (n.includes("removal order")) return "Removal Order Detail";
  if (n.includes("removal shipment")) return "Removal Shipment Detail";
  if (n.includes("replacement")) return "Replacements";
  if (n.includes("reports repository")) return "Reports Repository";
  if (n.includes("reserved inventory")) return "Reserved Inventory";
  if (n.includes("returns processing fee")) return "Returns Processing Fee";
  if (n.includes("safe-t")) return "SAFE-T Report";
  if (n.includes("settelment") || n.includes("settlement")) return "Settlement Flat File";
  if (n.includes("transaction")) return "Transactions";
  return path.basename(name);
}

function heuristicReportType(filename: string, headers: string[]): RawReportType | null {
  const n = filename.toLowerCase();
  const ds = new Set(headers.map(norm));
  const h = headers.map(norm).join(" ");

  if (n.includes("customer shipment") || (ds.has("amazon order id") && ds.has("shipped quantity")))
    return "ALL_ORDERS";
  if (n.includes("grade and resell") || (h.includes("grade") && (ds.has("fnsku") || ds.has("asin"))))
    return "FBA_GRADE_AND_RESELL";
  if (n.includes("replacement") || ds.has("replacement amazon order id")) return "REPLACEMENTS";
  if (n.includes("reserved inventory") || ds.has("reserved fc transfers")) return "RESERVED_INVENTORY";
  if (n.includes("fee preview") || h.includes("estimated referral fee")) return "FEE_PREVIEW";
  if (n.includes("monthly storage") || h.includes("monthly storage fee")) return "MONTHLY_STORAGE_FEES";
  if (n.includes("manage fba inventory")) return "MANAGE_FBA_INVENTORY";
  if (n.includes("open") && n.includes("listing")) return "ALL_LISTINGS";
  if (n.includes("returns processing fee")) return "UNKNOWN";
  if (n.includes("inbound placement") || n.includes("placement service")) return "UNKNOWN";
  if (n.includes("low-inventory")) return "UNKNOWN";
  return null;
}

function bucketColumns(headers: string[]): ColumnBuckets {
  const buckets: ColumnBuckets = {
    identifiers: [],
    quantity: [],
    amount: [],
    date: [],
    dimensions_weight: [],
    fee: [],
    product_price: [],
  };
  for (const h of headers) {
    const n = norm(h);
    if (
      n.includes("asin") ||
      n.includes("fnsku") ||
      n.includes("sku") ||
      n.includes("order id") ||
      n.includes("shipment id") ||
      n.includes("tracking") ||
      n.includes("reimbursement id") ||
      n.includes("settlement id") ||
      n.includes("license plate") ||
      n.includes("lpn") ||
      n.includes("reference id")
    ) {
      buckets.identifiers.push(h);
    }
    if (n.includes("quantity") || n.includes("qty") || n.includes("units")) buckets.quantity.push(h);
    if (
      n.includes("amount") ||
      n.includes("total") ||
      n.includes("charge") ||
      n.includes("reimbursement") ||
      n.includes("price") && !n.includes("product price")
    ) {
      if (n.includes("fee")) buckets.fee.push(h);
      else if (n.includes("price") || n.includes("product sales") || n.includes("item price"))
        buckets.product_price.push(h);
      else buckets.amount.push(h);
    }
    if (n.includes("date") || n.includes("time") || n.includes("month")) buckets.date.push(h);
    if (
      n.includes("dimension") ||
      n.includes("weight") ||
      n.includes("length") ||
      n.includes("width") ||
      n.includes("height") ||
      n.includes("volume")
    ) {
      buckets.dimensions_weight.push(h);
    }
    if (n.includes("fee") && !buckets.fee.includes(h)) buckets.fee.push(h);
  }
  return buckets;
}

function coreIdentifiers(headers: string[]): Record<string, boolean> {
  const ds = new Set(headers.map(norm));
  const has = (tokens: string[]) => tokens.some((t) => ds.has(t) || [...ds].some((d) => d.includes(t)));
  return {
    asin: has(["asin", "asin1"]),
    fnsku: has(["fnsku", "fulfillment network sku"]),
    sku_msku: has(["sku", "seller sku", "merchant sku", "msku"]),
    order_id: has(["order id", "amazon order id", "order-id"]),
    shipment_id: has(["shipment id", "fba shipment id"]),
    tracking: has(["tracking number", "tracking-number", "tracking id"]),
    reimbursement_id: has(["reimbursement id"]),
    settlement_id: has(["settlement id"]),
  };
}

function spApiForKind(kind: AmazonSyncKind): string | null {
  for (const [sp, sync] of Object.entries(SP_API_REPORT_TYPE_TO_SYNC_KIND)) {
    if (sync === kind) return sp;
  }
  const row = AMAZON_REPORT_CROSSWALK_LIVE.find((r) => r.amazon_sync_kind === kind);
  return row?.amazon_report_type ?? null;
}

function sourceHealthForKind(kind: AmazonSyncKind): "yes" | "no" | "partial" {
  const keyMap: Partial<Record<AmazonSyncKind, string>> = {
    FBA_RETURNS: "fba_customer_returns",
    INVENTORY_LEDGER: "inventory_ledger",
    REIMBURSEMENTS: "reimbursements",
    TRANSACTIONS: "transactions",
    SETTLEMENT: "settlements",
    REMOVAL_ORDER: "removal_order_detail",
    REMOVAL_SHIPMENT: "removal_shipment_detail",
    SAFET_CLAIMS: "safet",
    INBOUND_PERFORMANCE: "inbound_performance",
  };
  const k = keyMap[kind];
  if (k && SOURCE_HEALTH_KEYS.has(k)) return "yes";
  if (kind === "UNKNOWN") return "no";
  return "partial";
}

function tridStrategy(kind: AmazonSyncKind): FileAudit["coverage"]["trid_reference_edges"] {
  if (kind === "SETTLEMENT" || kind === "TRANSACTIONS" || kind === "REIMBURSEMENTS") return "frr";
  if (kind === "INVENTORY_LEDGER") return "ledger_pim";
  if (kind === "PRODUCT_IDENTITY") return "none";
  if (kind === "UNKNOWN") return "none";
  return "graph_only";
}

function auditFile(filePath: string, zipEntry: string): FileAudit {
  const buf = fs.readFileSync(filePath);
  const encoding = detectEncoding(buf);
  const text = decodeBuffer(buf, encoding);
  const lines = text.split(/\r?\n/).filter((_, i, arr) => i < arr.length);
  const { index: headerIndex, headers, delimiter } = findHeaderRow(lines);
  const rule = classifyCsvHeadersRuleBased(headers);
  const heuristic = heuristicReportType(path.basename(filePath), headers);
  let detected = rule.reportType;
  let method = `rule:${rule.matchedRule}`;
  if (detected === "UNKNOWN" && heuristic) {
    detected = heuristic;
    method = `filename/heuristic:${heuristic}`;
  }

  const kind = detected as AmazonSyncKind;
  const registry = AMAZON_REPORT_REGISTRY[kind];
  const table = registry?.sync_target_table ?? null;
  const classified = (CLASSIFIED_REPORT_TYPES as readonly string[]).includes(detected);
  const mapping = buildColumnMappingFromHeaders(headers, detected);
  const hasGaps = mappingHasRequiredGaps(mapping, detected);
  const canonical = CANONICAL_FIELDS_PER_TYPE[detected] ?? [];
  const requiredExpected = canonical.filter((f) => f.required).map((f) => f.label);
  const missingRequired = canonical
    .filter((f) => f.required && !mapping[f.key])
    .map((f) => f.label);
  const mappedHeaderSet = new Set(Object.values(mapping));
  const extra = headers.filter((h) => h && !mappedHeaderSet.has(h));

  const dataRows = countDataRows(filePath, headerIndex);
  const ids = coreIdentifiers(headers);
  const buckets = bucketColumns(headers);
  const notes: string[] = [];

  if (detected === "SAFET_CLAIMS" && dataRows === 0) {
    notes.push("SAFE-T file has headers only — source unavailable, not zero claims");
  }
  if (detected === "UNKNOWN") {
    notes.push("No registry table — file useful for schema design only until importer added");
  }
  if (hasGaps && detected !== "UNKNOWN") {
    notes.push("UniversalImporter would route to needs_mapping or GPT fallback");
  }
  if (
    path.basename(filePath).toLowerCase().includes("customer shipment") &&
    buckets.product_price.length > 0
  ) {
    notes.push("Sale/shipment price columns present — NOT COGS; do not use as unit cost");
  }

  const importerSupport: FileAudit["universal_importer_support"] =
    detected === "UNKNOWN"
      ? "no"
      : classified && table
        ? hasGaps
          ? "partial"
          : "yes"
        : "partial";

  const apiSupport: FileAudit["api_sync_support"] = API_LIVE[kind] ?? "no";

  const productLinkage: FileAudit["coverage"]["product_linkage"] =
    ids.asin || ids.fnsku || ids.sku_msku ? (ids.asin && ids.fnsku ? "yes" : "partial") : "no";

  const listingKinds = new Set<AmazonSyncKind>(["ALL_LISTINGS", "ACTIVE_LISTINGS", "CATEGORY_LISTINGS"]);
  const productStory: FileAudit["coverage"]["product_story"] =
    detected === "PRODUCT_IDENTITY" || listingKinds.has(kind)
      ? "yes"
      : ids.asin && ids.sku_msku
        ? "partial"
        : "no";

  const moneyKinds = new Set<AmazonSyncKind>([
    "REIMBURSEMENTS",
    "SETTLEMENT",
    "TRANSACTIONS",
    "SAFET_CLAIMS",
  ]);

  return {
    filename: path.basename(filePath),
    zip_entry: zipEntry,
    size_bytes: buf.length,
    encoding,
    delimiter: delimiter === "\t" ? "tab" : delimiter === "|" ? "pipe" : "comma",
    header_row_index: headerIndex,
    header_columns: headers,
    data_row_count: dataRows,
    report_family_label: reportFamilyFromFilename(filePath),
    detected_report_type: detected,
    detection_method: method,
    date_range_from_filename: parseDateRangeFromFilename(filePath),
    date_range_from_content: null,
    column_buckets: buckets,
    core_identifiers_present: ids,
    required_columns_expected: requiredExpected,
    missing_required_columns: missingRequired,
    extra_columns_not_in_canonical: extra.slice(0, 30),
    existing_normalized_table: table,
    missing_normalized_table: !table,
    universal_importer_support: importerSupport,
    api_sync_support: apiSupport,
    sp_api_report_type: spApiForKind(kind),
    source_health_page_support: sourceHealthForKind(kind),
    coverage: {
      product_linkage: productLinkage,
      lifecycle_quantities: LIFECYCLE_BY_KIND[kind] ?? [],
      claim_candidates: CLAIM_BY_KIND[kind] ?? [],
      trid_reference_edges: tridStrategy(kind),
      product_story: productStory,
      money_cost_recovery: moneyKinds.has(kind) ? "yes" : buckets.amount.length ? "partial" : "no",
      fee_dimension_claims:
        kind === "FEE_PREVIEW" || kind === "MONTHLY_STORAGE_FEES" || buckets.fee.length > 0
          ? kind === "UNKNOWN"
            ? "partial"
            : "yes"
          : "no",
    },
    priority:
      detected === "UNKNOWN"
        ? "unsupported"
        : PRIORITY_BY_KIND[kind] ?? "later",
    notes,
  };
}

function extractZip(zipPath: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amazon-zip-audit-"));
  const dest = path.join(tempDir, "extracted");
  fs.mkdirSync(dest, { recursive: true });
  const quotedZip = zipPath.replace(/'/g, "''");
  const quotedDest = dest.replace(/'/g, "''");
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${quotedZip}' -DestinationPath '${quotedDest}' -Force"`,
    { stdio: "pipe" },
  );
  return dest;
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectFiles(p));
    else if (/\.(csv|txt|tsv)$/i.test(ent.name)) out.push(p);
  }
  return out.sort();
}

function renderMarkdown(payload: Record<string, unknown>): string {
  const inv = payload.sample_zip_file_inventory as FileAudit[];
  let md = `# PHASE-AMAZON-SAMPLE-ZIP-SOURCE-COVERAGE-AUDIT-V1\n\n`;
  md += `Run: \`${payload.run_id}\`\n\n`;
  md += `Zip: \`${payload.zip_path}\`\n\n`;
  md += `Files: ${inv.length}\n\n`;
  md += `## SAFE_TO_STOP_RANDOM_FILE_REQUESTS: **${payload.SAFE_TO_STOP_RANDOM_FILE_REQUESTS}**\n\n`;
  md += `## Per-file inventory\n\n`;
  for (const f of inv) {
    md += `### ${f.filename}\n`;
    md += `- Report family: ${f.report_family_label}\n`;
    md += `- Detected type: \`${f.detected_report_type}\` (${f.detection_method})\n`;
    md += `- Encoding/delimiter: ${f.encoding} / ${f.delimiter}\n`;
    md += `- Data rows: ${f.data_row_count}\n`;
    md += `- Table: ${f.existing_normalized_table ?? "MISSING"}\n`;
    md += `- Importer: ${f.universal_importer_support} | API: ${f.api_sync_support} | Health page: ${f.source_health_page_support}\n`;
    md += `- Identifiers: ${JSON.stringify(f.core_identifiers_present)}\n`;
    md += `- Missing required: ${f.missing_required_columns.join(", ") || "none"}\n`;
    if (f.notes.length) md += `- Notes: ${f.notes.join("; ")}\n`;
    md += `\n`;
  }
  md += `## Missing sources after zip\n\n`;
  for (const s of payload.missing_sources_after_zip as string[]) md += `- ${s}\n`;
  md += `\n## NEXT_EXACT_PROMPT\n\n\`${payload.NEXT_EXACT_PROMPT}\`\n`;
  return md;
}

async function main(): Promise<void> {
  const zipPath = process.argv[2]?.trim() || DEFAULT_ZIP;
  if (!fs.existsSync(zipPath)) throw new Error(`Zip not found: ${zipPath}`);

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const extractRoot = extractZip(zipPath);
  const files = collectFiles(extractRoot);
  const sample_zip_file_inventory = files.map((fp) => {
    const rel = path.relative(extractRoot, fp).replace(/\\/g, "/");
    return auditFile(fp, rel);
  });

  const file_to_table_mapping = sample_zip_file_inventory.map((f) => ({
    filename: f.filename,
    report_type: f.detected_report_type,
    table: f.existing_normalized_table,
    missing_table: f.missing_normalized_table,
  }));

  const file_to_api_mapping = sample_zip_file_inventory.map((f) => ({
    filename: f.filename,
    report_family: f.report_family_label,
    sp_api_report_type: f.sp_api_report_type,
    api_sync_support: f.api_sync_support,
  }));

  const importer_gap_matrix = sample_zip_file_inventory.map((f) => ({
    filename: f.filename,
    report_type: f.detected_report_type,
    universal_importer: f.universal_importer_support,
    missing_required_columns: f.missing_required_columns,
    priority: f.priority,
  }));

  const api_sync_gap_matrix = sample_zip_file_inventory.map((f) => ({
    filename: f.filename,
    report_type: f.detected_report_type,
    api_sync: f.api_sync_support,
    sp_api: f.sp_api_report_type,
  }));

  const source_coverage_matrix = sample_zip_file_inventory.map((f) => ({
    report_family: f.report_family_label,
    filename: f.filename,
    table: f.existing_normalized_table,
    importer: f.universal_importer_support,
    api: f.api_sync_support,
    health_page: f.source_health_page_support,
    data_rows: f.data_row_count,
    priority: f.priority,
  }));

  const claim_family_coverage = [
    ...new Set(sample_zip_file_inventory.flatMap((f) => f.coverage.claim_candidates)),
  ].map((family) => ({
    claim_family: family,
    supported_by_zip_files: sample_zip_file_inventory
      .filter((f) => f.coverage.claim_candidates.includes(family))
      .map((f) => f.filename),
  }));

  const lifecycle_state_coverage = [
    ...new Set(sample_zip_file_inventory.flatMap((f) => f.coverage.lifecycle_quantities)),
  ].map((state) => ({
    lifecycle_state: state,
    zip_files: sample_zip_file_inventory
      .filter((f) => f.coverage.lifecycle_quantities.includes(state))
      .map((f) => f.filename),
  }));

  const product_linkage_coverage = sample_zip_file_inventory.map((f) => ({
    filename: f.filename,
    product_linkage: f.coverage.product_linkage,
    asin: f.core_identifiers_present.asin,
    fnsku: f.core_identifiers_present.fnsku,
    sku: f.core_identifiers_present.sku_msku,
    table: f.existing_normalized_table,
  }));

  const zipFamilies = new Set(sample_zip_file_inventory.map((f) => f.report_family_label.toLowerCase()));
  const missing_sources_after_zip = MISSING_SOURCES_CHECKLIST.filter((label) => {
    const l = label.toLowerCase();
    if (l.includes("stranded")) return true;
    if (l.includes("inventory adjustments")) return !zipFamilies.has("inventory ledger");
    if (l.includes("daily inventory")) return !sample_zip_file_inventory.some((f) =>
      f.detected_report_type === "AMAZON_FULFILLED_INVENTORY",
    );
    if (l.includes("inbound shipment detail")) return !zipFamilies.has("inbound performance");
    if (l.includes("shipment reconciliation")) return true;
    if (l.includes("sellersnap")) return true;
    if (l.includes("product identity") || l.includes("upc"))
      return !sample_zip_file_inventory.some((f) => f.detected_report_type === "PRODUCT_IDENTITY");
    if (l.includes("safe-t")) {
      const safet = sample_zip_file_inventory.find((f) => f.detected_report_type === "SAFET_CLAIMS");
      return !safet || safet.data_row_count === 0;
    }
    return true;
  });

  const exact_next_files_needed_if_any = missing_sources_after_zip.filter(
    (s) =>
      !s.includes("Inventory Adjustments") &&
      !s.includes("Inbound Shipment Detail") &&
      !s.includes("Shipment Reconciliation"),
  );

  const hasClaimCore =
    sample_zip_file_inventory.some((f) => f.detected_report_type === "INVENTORY_LEDGER" && f.data_row_count > 0) &&
    sample_zip_file_inventory.some((f) => f.detected_report_type === "REIMBURSEMENTS" && f.data_row_count > 0) &&
    sample_zip_file_inventory.some((f) => f.detected_report_type === "SETTLEMENT" && f.data_row_count > 0);

  const safetEmpty =
    sample_zip_file_inventory.find((f) => f.detected_report_type === "SAFET_CLAIMS")?.data_row_count === 0;

  const SAFE_TO_STOP_RANDOM_FILE_REQUESTS =
    hasClaimCore && sample_zip_file_inventory.length >= 20 && !safetEmpty ? "yes" : "partial";

  const NEXT_EXACT_PROMPT =
    SAFE_TO_STOP_RANDOM_FILE_REQUESTS === "yes"
      ? "PHASE-MAYSAM-SOURCE-ACQUISITION-EXECUTE-V1 — upload zip samples via UniversalImporter dry-run matrix; enable Reimbursements+Settlements API Run Now; then PHASE-CLAIM-POOL-EMIT-DRYRUN-V2"
      : "PHASE-MAYSAM-TARGETED-SOURCE-GAP-FILL-V1 — obtain: (1) non-empty SAFE-T alternate window; (2) Stranded Inventory export; (3) SellerSnap COGS CSV; (4) Product Identity/UPC CSV if Open Listings lacks UPC; then re-run zip audit";

  const summary = {
    prompt: "PHASE-AMAZON-SAMPLE-ZIP-SOURCE-COVERAGE-AUDIT-V1",
    run_id: rid,
    mode: "read_only",
    zip_path: zipPath,
    extract_root: extractRoot,
    file_count: sample_zip_file_inventory.length,
    sample_zip_file_inventory,
    source_coverage_matrix,
    file_to_table_mapping,
    file_to_api_mapping,
    importer_gap_matrix,
    api_sync_gap_matrix,
    claim_family_coverage,
    lifecycle_state_coverage,
    product_linkage_coverage,
    missing_sources_after_zip,
    exact_next_files_needed_if_any,
    unsupported_in_zip: sample_zip_file_inventory
      .filter((f) => f.detected_report_type === "UNKNOWN")
      .map((f) => ({ filename: f.filename, family: f.report_family_label, headers: f.header_columns.slice(0, 15) })),
    safet_special: {
      data_rows:
        sample_zip_file_inventory.find((f) => f.detected_report_type === "SAFET_CLAIMS")?.data_row_count ?? null,
      interpretation: "header-only — source unavailable not zero claims",
    },
    SAFE_TO_STOP_RANDOM_FILE_REQUESTS,
    NEXT_EXACT_PROMPT,
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "coverage-audit.md"), renderMarkdown(summary), "utf8");
  fs.writeFileSync(path.join(outDir, "NEXT_EXACT_PROMPT.txt"), NEXT_EXACT_PROMPT);

  console.log(JSON.stringify(summary, null, 2));

  try {
    fs.rmSync(path.dirname(extractRoot), { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
