/**
 * Static Amazon reportType / Seller Central label → pipeline routing metadata.
 * Used for deterministic routing (API automation, upload metadata) alongside
 * header-based detection in `lib/csv-import-detected-type.ts`.
 *
 * No runtime Amazon calls — data is curated from SP-API docs + repo audits.
 * Verify enum strings against current Amazon documentation before production automation.
 */

import type { AmazonSyncKind } from "../pipeline/amazon-report-registry";
import { AMAZON_REPORT_REGISTRY, resolveAmazonImportSyncKind } from "../pipeline/amazon-report-registry";

/** SP-API report type string (or internal label) → sync kind for flat reports we ingest today. */
export const SP_API_REPORT_TYPE_TO_SYNC_KIND: Record<string, AmazonSyncKind> = {
  GET_FBA_REIMBURSEMENTS_DATA: "REIMBURSEMENTS",
  GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2: "SETTLEMENT",
  GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA: "REMOVAL_ORDER",
  GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA: "REMOVAL_SHIPMENT",
  GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA: "FBA_RETURNS",
  GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA: "MONTHLY_STORAGE_FEES",
  GET_FBA_STORAGE_FEE_CHARGES_DATA: "MONTHLY_STORAGE_FEES",
};

/** Seller Central / internal export labels → canonical `raw_report_uploads.report_type` string. */
export const SELLER_CENTRAL_LABEL_TO_REPORT_TYPE: Record<string, AmazonSyncKind> = {
  "transaction payment detail": "SETTLEMENT",
  "simple transactions summary": "TRANSACTIONS",
  "reports repository": "REPORTS_REPOSITORY",
  "safe-t claims": "SAFET_CLAIMS",
  "fulfilled shipments": "ALL_ORDERS",
};

export type AmazonReportGraphRole =
  | "financial_spine"
  | "operational_evidence"
  | "repository_archive"
  | "identity_bridge"
  | "planned_archive";

export type AmazonReportCrosswalkRow = {
  crosswalk_id: string;
  amazon_report_type: string | null;
  seller_central_labels: string[];
  amazon_sync_kind: AmazonSyncKind;
  sync_target_table: string | null;
  detector_rule_hint: string;
  reference_fields: string[];
  graph_role: AmazonReportGraphRole;
  implementation_status: "live" | "planned";
};

function tableForKind(kind: AmazonSyncKind): string | null {
  return AMAZON_REPORT_REGISTRY[kind]?.sync_target_table ?? null;
}

/** Curated rows for high-value Amazon flat reports (live ingestion today). */
export const AMAZON_REPORT_CROSSWALK_LIVE: AmazonReportCrosswalkRow[] = [
  {
    crosswalk_id: "spapi.GET_FBA_REIMBURSEMENTS_DATA",
    amazon_report_type: "GET_FBA_REIMBURSEMENTS_DATA",
    seller_central_labels: ["FBA Reimbursements"],
    amazon_sync_kind: "REIMBURSEMENTS",
    sync_target_table: tableForKind("REIMBURSEMENTS"),
    detector_rule_hint: "reimbursement id + quantity reimbursed total",
    reference_fields: ["reimbursement_id", "order_id", "sku", "amount_reimbursed"],
    graph_role: "financial_spine",
    implementation_status: "live",
  },
  {
    crosswalk_id: "spapi.GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
    amazon_report_type: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
    seller_central_labels: ["Settlement Flat File V2"],
    amazon_sync_kind: "SETTLEMENT",
    sync_target_table: tableForKind("SETTLEMENT"),
    detector_rule_hint: "settlement id + transaction type (flat TSV) OR settlement id + transaction status (CSV)",
    reference_fields: ["settlement_id", "order_id", "sku", "amazon_line_key", "transaction_type", "amount_total"],
    graph_role: "financial_spine",
    implementation_status: "live",
  },
  {
    crosswalk_id: "sc.transaction_payment_detail",
    amazon_report_type: null,
    seller_central_labels: ["Transaction / Payment Detail"],
    amazon_sync_kind: "SETTLEMENT",
    sync_target_table: tableForKind("SETTLEMENT"),
    detector_rule_hint: "settlement id + transaction status/release date (not Reports Repository)",
    reference_fields: ["settlement_id", "order_id", "transaction_status", "transaction_release_date"],
    graph_role: "financial_spine",
    implementation_status: "live",
  },
  {
    crosswalk_id: "sc.simple_transactions_summary",
    amazon_report_type: null,
    seller_central_labels: ["Simple Transactions Summary"],
    amazon_sync_kind: "TRANSACTIONS",
    sync_target_table: tableForKind("TRANSACTIONS"),
    detector_rule_hint: "Simple Transactions Summary fingerprint",
    reference_fields: ["order_id", "transaction_type", "amount", "posted_date"],
    graph_role: "financial_spine",
    implementation_status: "live",
  },
  {
    crosswalk_id: "sc.reports_repository_csv",
    amazon_report_type: null,
    seller_central_labels: ["Reports Repository"],
    amazon_sync_kind: "REPORTS_REPOSITORY",
    sync_target_table: tableForKind("REPORTS_REPOSITORY"),
    detector_rule_hint: "date/time + settlement id + type + order id + sku + description + total",
    reference_fields: ["settlement_id", "order_id", "sku", "total_amount", "transaction_type"],
    graph_role: "repository_archive",
    implementation_status: "live",
  },
  {
    crosswalk_id: "spapi.GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
    amazon_report_type: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
    seller_central_labels: ["Removal Order Detail"],
    amazon_sync_kind: "REMOVAL_ORDER",
    sync_target_table: tableForKind("REMOVAL_ORDER"),
    detector_rule_hint: "removal order id OR requested quantity + disposed quantity",
    reference_fields: ["order_id", "sku", "fnsku", "disposition"],
    graph_role: "operational_evidence",
    implementation_status: "live",
  },
  {
    crosswalk_id: "spapi.GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
    amazon_report_type: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
    seller_central_labels: ["Removal Shipment Detail"],
    amazon_sync_kind: "REMOVAL_SHIPMENT",
    sync_target_table: tableForKind("REMOVAL_SHIPMENT"),
    detector_rule_hint: "tracking number + carrier/shipment date",
    reference_fields: ["order_id", "tracking_number", "carrier", "shipment_date", "sku"],
    graph_role: "operational_evidence",
    implementation_status: "live",
  },
  {
    crosswalk_id: "sc.safe_t_claims_export",
    amazon_report_type: null,
    seller_central_labels: ["SAFE-T Claims"],
    amazon_sync_kind: "SAFET_CLAIMS",
    sync_target_table: tableForKind("SAFET_CLAIMS"),
    detector_rule_hint: "safe + claim + reimbursement/amount",
    reference_fields: ["safet_claim_id", "order_id"],
    graph_role: "operational_evidence",
    implementation_status: "live",
  },
  {
    crosswalk_id: "amazon.inventory_ledger_exports",
    amazon_report_type: null,
    seller_central_labels: ["Inventory Ledger Detail", "Inventory Ledger Summary"],
    amazon_sync_kind: "INVENTORY_LEDGER",
    sync_target_table: tableForKind("INVENTORY_LEDGER"),
    detector_rule_hint: "fnsku + event type + fulfillment center + disposition OR fnsku + ending warehouse balance OR ledger_pos_*",
    reference_fields: ["reference_id", "fnsku", "event_type", "event_timestamp", "order_id"],
    graph_role: "operational_evidence",
    implementation_status: "live",
  },
  {
    crosswalk_id: "spapi.GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
    amazon_report_type: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
    seller_central_labels: ["FBA Customer Returns"],
    amazon_sync_kind: "FBA_RETURNS",
    sync_target_table: tableForKind("FBA_RETURNS"),
    detector_rule_hint: "license plate number + detailed disposition",
    reference_fields: ["order_id", "lpn", "sku", "asin"],
    graph_role: "operational_evidence",
    implementation_status: "live",
  },
  {
    crosswalk_id: "amazon.fulfilled_shipments_all_orders",
    amazon_report_type: null,
    seller_central_labels: ["Fulfilled Shipments"],
    amazon_sync_kind: "ALL_ORDERS",
    sync_target_table: tableForKind("ALL_ORDERS"),
    detector_rule_hint: "amazon order id + shipped quantity + shipment id/date",
    reference_fields: ["amazon_order_id", "shipment_id", "sku", "shipped_quantity"],
    graph_role: "operational_evidence",
    implementation_status: "live",
  },
];

/** Not yet a single `AmazonSyncKind` — TRID / graph / future tables (see audit artifacts). */
export const AMAZON_REPORT_CROSSWALK_PLACEHOLDERS: Array<{
  crosswalk_id: string;
  placeholder_kind:
    | "FINANCES_EVENT_ARCHIVE"
    | "INVENTORY_ADJUSTMENT_VIRTUAL"
    | "FULFILLMENT_SHIPMENT_ITEM_GRAIN"
    | "REPORTS_REPOSITORY_FINANCIAL_PROMOTION";
  notes: string;
  related_sync_kinds: AmazonSyncKind[];
}> = [
  {
    crosswalk_id: "spapi.finances.listFinancialEvents",
    placeholder_kind: "FINANCES_EVENT_ARCHIVE",
    notes:
      "Append-only Finances API events (eventGroupId, event ids). No CSV header classifier; not mapped to AmazonSyncKind until archive + reconciler exist.",
    related_sync_kinds: ["SETTLEMENT", "TRANSACTIONS", "REIMBURSEMENTS"],
  },
  {
    crosswalk_id: "virtual.inventory_adjustment_bundle",
    placeholder_kind: "INVENTORY_ADJUSTMENT_VIRTUAL",
    notes:
      "Cross-report bundle: INVENTORY_LEDGER + SETTLEMENT/TRANSACTIONS/REIMBURSEMENTS + removals — no single detector outcome.",
    related_sync_kinds: ["INVENTORY_LEDGER", "SETTLEMENT", "TRANSACTIONS", "REIMBURSEMENTS", "REMOVAL_ORDER"],
  },
  {
    crosswalk_id: "amazon.fulfillment_shipment_line_items",
    placeholder_kind: "FULFILLMENT_SHIPMENT_ITEM_GRAIN",
    notes:
      "Shipment line items often share ALL_ORDERS row grain today; dedicated item-level kind or API projection TBD.",
    related_sync_kinds: ["ALL_ORDERS"],
  },
  {
    crosswalk_id: "amazon.reports_repository_financial_promotion",
    placeholder_kind: "REPORTS_REPOSITORY_FINANCIAL_PROMOTION",
    notes: "Optional promotion of repository fee/detail rows to financial resolver — policy TBD; not a sync kind.",
    related_sync_kinds: ["REPORTS_REPOSITORY", "SETTLEMENT", "TRANSACTIONS"],
  },
];

/** Resolve SP-API `reportType` string to sync kind when present in static map. */
export function resolveSpApiReportTypeToSyncKind(reportType: string | null | undefined): AmazonSyncKind | null {
  const k = String(reportType ?? "").trim();
  if (!k) return null;
  return SP_API_REPORT_TYPE_TO_SYNC_KIND[k] ?? null;
}

/** Resolve curated Seller Central label (lowercased) to sync kind when present. */
export function resolveSellerCentralLabelToSyncKind(label: string | null | undefined): AmazonSyncKind | null {
  const key = String(label ?? "").trim().toLowerCase();
  if (!key) return null;
  return SELLER_CENTRAL_LABEL_TO_REPORT_TYPE[key] ?? null;
}

/** Same as pipeline `resolveAmazonImportSyncKind` — exposed for tests that assert crosswalk ↔ registry alignment. */
export { resolveAmazonImportSyncKind };
