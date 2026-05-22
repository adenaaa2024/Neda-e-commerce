/**
 * Feature flags for Amazon Reports API worker (NEXT-IMPORT-API-05).
 * Defaults off — never enable via NEXT_PUBLIC_*.
 */

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Master switch: no Reports API outbound calls when false. */
export function isAmazonReportsApiWorkerEnabled(): boolean {
  return envFlag("ENABLE_AMAZON_REPORTS_API_WORKER");
}

/** Sub-flag: GET_FBA_REIMBURSEMENTS_DATA — requires master flag. */
export function isAmazonReportsApiReimbursementsEnabled(): boolean {
  return isAmazonReportsApiWorkerEnabled() && envFlag("ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS");
}

/** Sub-flag: GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 — requires master flag (IMPORT-API-08). */
export function isAmazonReportsApiSettlementEnabled(): boolean {
  return isAmazonReportsApiWorkerEnabled() && envFlag("ENABLE_AMAZON_REPORTS_API_SETTLEMENT");
}

export type ReportsApiDisabledReason =
  | "worker_disabled"
  | "reimbursements_disabled"
  | "settlement_disabled";

export function reportsApiDisabledReasonForReimbursements(): ReportsApiDisabledReason | null {
  if (!isAmazonReportsApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonReportsApiReimbursementsEnabled()) return "reimbursements_disabled";
  return null;
}

export function reportsApiDisabledReasonForSettlement(): ReportsApiDisabledReason | null {
  if (!isAmazonReportsApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonReportsApiSettlementEnabled()) return "settlement_disabled";
  return null;
}
