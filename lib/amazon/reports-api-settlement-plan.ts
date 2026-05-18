/**
 * SP-API settlement flat file constants (NEXT-IMPORT-API-07 plan, IMPORT-API-08 worker).
 */

export const SP_API_REPORT_TYPE_SETTLEMENT_V2 =
  "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2" as const;

export const SETTLEMENT_PLAN_SUMMARY = {
  amazon_report_type: SP_API_REPORT_TYPE_SETTLEMENT_V2,
  canonical_sync_kind: "SETTLEMENT",
  sync_target_table: "amazon_settlements",
  crosswalk_id: "spapi.GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
  proposed_sub_flag: "ENABLE_AMAZON_REPORTS_API_SETTLEMENT",
  requires_flags: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_SETTLEMENT"],
  idempotency_operation_suffix: "reports.create_and_download.settlement_v2",
  synthetic_upload_report_type: "SETTLEMENT",
  pipeline:
    "getReports (scheduled) → poll → download → synthetic TSV upload → process/sync/generic — not createReport",
} as const;
