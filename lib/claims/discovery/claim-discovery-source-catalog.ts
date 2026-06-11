import type { ClaimDiscoverySourceKind } from "./claim-discovery-types";

/** Maps discovery source kinds to primary source tables (for index bookkeeping). */
export const DISCOVERY_SOURCE_TABLE: Record<ClaimDiscoverySourceKind, string> = {
  reimbursement: "amazon_reimbursements",
  transaction: "amazon_transactions",
  inventory_ledger: "amazon_inventory_ledger",
  safet: "amazon_safet_claims",
  delayed_not_received: "expected_packages",
  shipment_discrepancy: "expected_packages",
  amazon_removal_api: "amazon_removals",
  inbound_shipment: "amazon_inbound_performance",
  scanner_physical_review: "return_items",
};

/** Event date column used for watermark advancement per source. */
export const DISCOVERY_SOURCE_DATE_COLUMN: Record<ClaimDiscoverySourceKind, string> = {
  reimbursement: "approval_date",
  transaction: "posted_date",
  inventory_ledger: "event_date",
  safet: "claim_date",
  delayed_not_received: "shipment_date",
  shipment_discrepancy: "shipment_date",
  amazon_removal_api: "order_date",
  inbound_shipment: "issue_reported_date",
  scanner_physical_review: "created_at",
};

export function discoverySourceLabel(kind: ClaimDiscoverySourceKind): string {
  const labels: Record<ClaimDiscoverySourceKind, string> = {
    reimbursement: "Reimbursements",
    transaction: "Transactions",
    inventory_ledger: "Inventory ledger",
    safet: "SAFE-T",
    delayed_not_received: "Delayed / not received",
    shipment_discrepancy: "Shipment discrepancy",
    amazon_removal_api: "Removals",
    inbound_shipment: "Inbound shipments",
    scanner_physical_review: "Scanner review events",
  };
  return labels[kind];
}
