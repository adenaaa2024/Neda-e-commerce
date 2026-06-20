import {
  SOURCE_RUN_OPERATION,
  SP_API_REPORT_TYPE_FBA_RETURNS,
  SP_API_REPORT_TYPE_FEE_PREVIEW,
  SP_API_REPORT_TYPE_INBOUND_PERFORMANCE,
  SP_API_REPORT_TYPE_INVENTORY_LEDGER,
  SP_API_REPORT_TYPE_REIMBURSEMENTS,
  SP_API_REPORT_TYPE_REMOVAL_ORDER,
  SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
} from "./reports-api-source-run";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "./reports-api-settlement-plan";

/** How the worker obtains a report_id before poll/download. */
export type ReportsApiAcquisitionMode = "on_demand_create" | "scheduled_list";

/** Canonical upload `report_type` for Reports API synthetic uploads. */
export type ReportsApiUploadReportType =
  | "REIMBURSEMENTS"
  | "SETTLEMENT"
  | "REMOVAL_ORDER"
  | "REMOVAL_SHIPMENT"
  | "FBA_RETURNS"
  | "INVENTORY_LEDGER"
  | "FEE_PREVIEW"
  | "INBOUND_PERFORMANCE";

/** Canonical upload `report_type` + SP-API report type for one Reports API pull worker. */
export type ReportsApiPullProfile = {
  spReportType: string;
  uploadReportType: ReportsApiUploadReportType;
  acquisitionMode: ReportsApiAcquisitionMode;
  sourceRunOperation: string;
  importDescriptorId: string;
  syntheticFileName: (reportDocumentId: string | null) => string;
};

export const REIMBURSEMENTS_PULL_PROFILE: ReportsApiPullProfile = {
  spReportType: SP_API_REPORT_TYPE_REIMBURSEMENTS,
  uploadReportType: "REIMBURSEMENTS",
  acquisitionMode: "on_demand_create",
  sourceRunOperation: SOURCE_RUN_OPERATION,
  importDescriptorId: "amazon.reimbursements.file.v1",
  syntheticFileName: (reportDocumentId) =>
    `spapi://reports/${SP_API_REPORT_TYPE_REIMBURSEMENTS}/${reportDocumentId?.trim() || "pending"}.tsv`,
};

export const SETTLEMENT_PULL_PROFILE: ReportsApiPullProfile = {
  spReportType: SP_API_REPORT_TYPE_SETTLEMENT_V2,
  uploadReportType: "SETTLEMENT",
  acquisitionMode: "scheduled_list",
  sourceRunOperation: "reports.list_and_download.settlement_v2",
  importDescriptorId: "amazon.settlement.file.v1",
  syntheticFileName: (reportDocumentId) =>
    `spapi://reports/${SP_API_REPORT_TYPE_SETTLEMENT_V2}/${reportDocumentId?.trim() || "pending"}.tsv`,
};

export const REMOVAL_ORDER_PULL_PROFILE: ReportsApiPullProfile = {
  spReportType: SP_API_REPORT_TYPE_REMOVAL_ORDER,
  uploadReportType: "REMOVAL_ORDER",
  acquisitionMode: "on_demand_create",
  sourceRunOperation: SOURCE_RUN_OPERATION,
  importDescriptorId: "amazon.removal_order.file.v1",
  syntheticFileName: (reportDocumentId) =>
    `spapi://reports/${SP_API_REPORT_TYPE_REMOVAL_ORDER}/${reportDocumentId?.trim() || "pending"}.tsv`,
};

export const REMOVAL_SHIPMENT_PULL_PROFILE: ReportsApiPullProfile = {
  spReportType: SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
  uploadReportType: "REMOVAL_SHIPMENT",
  acquisitionMode: "on_demand_create",
  sourceRunOperation: SOURCE_RUN_OPERATION,
  importDescriptorId: "amazon.removal_shipment.file.v1",
  syntheticFileName: (reportDocumentId) =>
    `spapi://reports/${SP_API_REPORT_TYPE_REMOVAL_SHIPMENT}/${reportDocumentId?.trim() || "pending"}.tsv`,
};

// Live-source sync workers (PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1):
export const FBA_RETURNS_PULL_PROFILE: ReportsApiPullProfile = {
  spReportType: SP_API_REPORT_TYPE_FBA_RETURNS,
  uploadReportType: "FBA_RETURNS",
  acquisitionMode: "on_demand_create",
  sourceRunOperation: SOURCE_RUN_OPERATION,
  importDescriptorId: "amazon.fba_returns.file.v1",
  syntheticFileName: (reportDocumentId) =>
    `spapi://reports/${SP_API_REPORT_TYPE_FBA_RETURNS}/${reportDocumentId?.trim() || "pending"}.tsv`,
};

export const INVENTORY_LEDGER_PULL_PROFILE: ReportsApiPullProfile = {
  spReportType: SP_API_REPORT_TYPE_INVENTORY_LEDGER,
  uploadReportType: "INVENTORY_LEDGER",
  acquisitionMode: "on_demand_create",
  sourceRunOperation: SOURCE_RUN_OPERATION,
  importDescriptorId: "amazon.inventory_ledger.file.v1",
  syntheticFileName: (reportDocumentId) =>
    `spapi://reports/${SP_API_REPORT_TYPE_INVENTORY_LEDGER}/${reportDocumentId?.trim() || "pending"}.tsv`,
};

export const FEE_PREVIEW_PULL_PROFILE: ReportsApiPullProfile = {
  spReportType: SP_API_REPORT_TYPE_FEE_PREVIEW,
  uploadReportType: "FEE_PREVIEW",
  acquisitionMode: "on_demand_create",
  sourceRunOperation: SOURCE_RUN_OPERATION,
  importDescriptorId: "amazon.fee_preview.file.v1",
  syntheticFileName: (reportDocumentId) =>
    `spapi://reports/${SP_API_REPORT_TYPE_FEE_PREVIEW}/${reportDocumentId?.trim() || "pending"}.tsv`,
};

export const INBOUND_PERFORMANCE_PULL_PROFILE: ReportsApiPullProfile = {
  spReportType: SP_API_REPORT_TYPE_INBOUND_PERFORMANCE,
  uploadReportType: "INBOUND_PERFORMANCE",
  acquisitionMode: "on_demand_create",
  sourceRunOperation: SOURCE_RUN_OPERATION,
  importDescriptorId: "amazon.inbound_performance.file.v1",
  syntheticFileName: (reportDocumentId) =>
    `spapi://reports/${SP_API_REPORT_TYPE_INBOUND_PERFORMANCE}/${reportDocumentId?.trim() || "pending"}.tsv`,
};
