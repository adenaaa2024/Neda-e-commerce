import type { ClaimCenterV1Badge } from "./claim-center-v1-types";

const SOURCE_LABELS: Record<string, string> = {
  scanner_physical_review: "Scanner",
  amazon_removal_api: "Removal API",
  reimbursement: "Reimbursement",
  settlement: "Settlement",
  transaction: "Transaction",
  inventory_ledger: "Inventory",
  safet: "SAFE-T",
  delayed_not_received: "Not received",
  shipment_discrepancy: "Shipment",
  inbound_shipment: "Inbound",
  manual_import: "Manual",
  orbit_fra: "ORBIT-FRA",
  legacy_seed: "Legacy",
};

export function sourceBadgeLabel(sourceKind: string | null): string {
  if (!sourceKind) return "Unknown source";
  return SOURCE_LABELS[sourceKind] ?? sourceKind.replace(/_/g, " ");
}

export function buildClaimCenterBadges(args: {
  source_kind: string | null;
  evidence_status: string | null;
  product_linked: boolean;
  product_proposed: boolean;
  reference_edge_count: number;
  ambiguity_pending: boolean;
  canonical_window_status: string;
  automation_allowed: boolean;
  has_conflict: boolean;
  orbit_external_case_status: string | null;
  orbit_import: boolean;
}): ClaimCenterV1Badge[] {
  const badges: ClaimCenterV1Badge[] = [];

  badges.push({
    kind: "source",
    label: sourceBadgeLabel(args.source_kind),
    tone: args.source_kind === "legacy_seed" ? "neutral" : "info",
  });

  if (args.orbit_import) {
    badges.push({ kind: "source", label: "ORBIT import", tone: "info" });
  }

  if (args.product_linked) {
    badges.push({ kind: "product", label: "Product linked", tone: "success" });
  } else if (args.product_proposed) {
    badges.push({ kind: "product", label: "Proposed link", tone: "warning" });
  } else {
    badges.push({ kind: "product", label: "Unlinked", tone: "warning" });
  }

  if (args.ambiguity_pending) {
    badges.push({ kind: "trid", label: "Reference conflict", tone: "danger" });
  } else if (args.reference_edge_count > 0) {
    badges.push({ kind: "trid", label: `References (${args.reference_edge_count})`, tone: "success" });
  } else {
    badges.push({ kind: "trid", label: "No references", tone: "neutral" });
  }

  const ev = args.evidence_status ?? "unknown";
  badges.push({
    kind: "evidence",
    label: ev === "complete" ? "Evidence ready" : ev === "partial" ? "Partial evidence" : "Evidence missing",
    tone: ev === "complete" ? "success" : ev === "partial" ? "warning" : "danger",
  });

  if (args.canonical_window_status === "expired") {
    badges.push({ kind: "deadline", label: "Deadline passed", tone: "danger" });
  } else if (args.canonical_window_status === "closing_soon") {
    badges.push({ kind: "deadline", label: "Closing soon", tone: "warning" });
  } else if (args.canonical_window_status === "open") {
    badges.push({ kind: "deadline", label: "Within deadline", tone: "success" });
  }

  if (args.has_conflict) {
    badges.push({ kind: "conflict", label: "Conflict", tone: "danger" });
  }

  if (args.automation_allowed) {
    badges.push({ kind: "automation", label: "Automation OK", tone: "info" });
  }

  if (args.orbit_external_case_status) {
    badges.push({
      kind: "external",
      label: `Observed externally: ${args.orbit_external_case_status}`,
      tone: "neutral",
    });
  }

  return badges;
}

export const V1_STATUS_LABELS: Record<string, string> = {
  new: "New opportunity",
  needs_review: "Needs review",
  evidence_ready: "Evidence ready",
  blocked_product_link: "Blocked — product",
  blocked_reference_conflict: "Blocked — reference",
  ready_to_file: "Ready to file (evidence + refs OK)",
  filed: "Observed filed (external)",
  reimbursed: "Observed reimbursed (external)",
  rejected: "Rejected",
  expired: "Expired",
};
