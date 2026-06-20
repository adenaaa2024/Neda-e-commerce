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

/** Sub-flag: GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA — requires master flag. */
export function isAmazonReportsApiRemovalOrderEnabled(): boolean {
  return isAmazonReportsApiWorkerEnabled() && envFlag("ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER");
}

/** Sub-flag: GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA — requires master flag. */
export function isAmazonReportsApiRemovalShipmentEnabled(): boolean {
  return isAmazonReportsApiWorkerEnabled() && envFlag("ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT");
}

// Live-source sync workers (PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1):
/** Sub-flag: GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA — requires master flag. */
export function isAmazonReportsApiFbaReturnsEnabled(): boolean {
  return isAmazonReportsApiWorkerEnabled() && envFlag("ENABLE_AMAZON_REPORTS_API_FBA_RETURNS");
}

/** Sub-flag: GET_LEDGER_DETAIL_VIEW_DATA — requires master flag. */
export function isAmazonReportsApiInventoryLedgerEnabled(): boolean {
  return isAmazonReportsApiWorkerEnabled() && envFlag("ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER");
}

/** Sub-flag: GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA — requires master flag. */
export function isAmazonReportsApiFeePreviewEnabled(): boolean {
  return isAmazonReportsApiWorkerEnabled() && envFlag("ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW");
}

/** Sub-flag: GET_FBA_FULFILLMENT_INBOUND_PERFORMANCE_DATA — requires master flag. */
export function isAmazonReportsApiInboundPerformanceEnabled(): boolean {
  return (
    isAmazonReportsApiWorkerEnabled() && envFlag("ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE")
  );
}

export type ReportsApiDisabledReason =
  | "worker_disabled"
  | "reimbursements_disabled"
  | "settlement_disabled"
  | "removal_order_disabled"
  | "removal_shipment_disabled"
  | "fba_returns_disabled"
  | "inventory_ledger_disabled"
  | "fee_preview_disabled"
  | "inbound_performance_disabled";

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

export function reportsApiDisabledReasonForRemovalOrder(): ReportsApiDisabledReason | null {
  if (!isAmazonReportsApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonReportsApiRemovalOrderEnabled()) return "removal_order_disabled";
  return null;
}

export function reportsApiDisabledReasonForRemovalShipment(): ReportsApiDisabledReason | null {
  if (!isAmazonReportsApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonReportsApiRemovalShipmentEnabled()) return "removal_shipment_disabled";
  return null;
}

export function reportsApiDisabledReasonForFbaReturns(): ReportsApiDisabledReason | null {
  if (!isAmazonReportsApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonReportsApiFbaReturnsEnabled()) return "fba_returns_disabled";
  return null;
}

export function reportsApiDisabledReasonForInventoryLedger(): ReportsApiDisabledReason | null {
  if (!isAmazonReportsApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonReportsApiInventoryLedgerEnabled()) return "inventory_ledger_disabled";
  return null;
}

export function reportsApiDisabledReasonForFeePreview(): ReportsApiDisabledReason | null {
  if (!isAmazonReportsApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonReportsApiFeePreviewEnabled()) return "fee_preview_disabled";
  return null;
}

export function reportsApiDisabledReasonForInboundPerformance(): ReportsApiDisabledReason | null {
  if (!isAmazonReportsApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonReportsApiInboundPerformanceEnabled()) return "inbound_performance_disabled";
  return null;
}

/** Full worker flags snapshot (no secrets). */
export function allReportsApiWorkerFlags() {
  return {
    worker_enabled: isAmazonReportsApiWorkerEnabled(),
    reimbursements_enabled: isAmazonReportsApiReimbursementsEnabled(),
    settlement_enabled: isAmazonReportsApiSettlementEnabled(),
    removal_order_enabled: isAmazonReportsApiRemovalOrderEnabled(),
    removal_shipment_enabled: isAmazonReportsApiRemovalShipmentEnabled(),
    fba_returns_enabled: isAmazonReportsApiFbaReturnsEnabled(),
    inventory_ledger_enabled: isAmazonReportsApiInventoryLedgerEnabled(),
    fee_preview_enabled: isAmazonReportsApiFeePreviewEnabled(),
    inbound_performance_enabled: isAmazonReportsApiInboundPerformanceEnabled(),
  };
}
