import {
  SOURCE_RUN_OPERATION,
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
  | "REMOVAL_SHIPMENT";

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
