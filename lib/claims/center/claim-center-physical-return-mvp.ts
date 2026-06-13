import type { ClaimCenterV1Row } from "./claim-center-v1-types";

/** MVP slice — scanner-origin physical return families only. */
export const PHYSICAL_RETURN_MVP_SCANNER_FAMILIES = new Set([
  "physical_return_issue",
  "physical_return_off_manifest",
]);

/** ORBIT categories backed by return_items that are trustworthy for MVP display. */
export const PHYSICAL_RETURN_MVP_ORBIT_FAMILIES = new Set([
  "physical_return_off_manifest",
  "physical_return_damaged",
]);

export type ClaimCenterPhysicalReturnDisplay = {
  physical_return_mvp: boolean;
  physical_event_label: string;
  physical_family_label: string;
  missing_next: string[];
};

const FAMILY_LABELS: Record<string, string> = {
  physical_return_issue: "Physical return issue",
  physical_return_off_manifest: "Off-manifest item",
  physical_return_damaged: "Physical return issue",
};

export function physicalFamilyDisplayLabel(claimFamily: string | null): string {
  if (!claimFamily) return "Physical return issue";
  return FAMILY_LABELS[claimFamily] ?? claimFamily.replace(/_/g, " ");
}

export function physicalEventLabelFromRow(row: ClaimCenterV1Row): string {
  const family = row.claim_family ?? "";
  if (family === "physical_return_off_manifest") return "Off-manifest item";
  const reason = (row.claim_reason ?? "").toLowerCase();
  if (reason.includes("off_manifest") || reason.includes("unexpected")) return "Off-manifest item";
  if (reason.includes("damaged") || reason.includes("condition")) return "Damaged unit";
  if (reason.includes("wrong")) return "Wrong item";
  if (reason.includes("expired")) return "Expired unit";
  if (reason.includes("missing")) return "Missing unit";
  return physicalFamilyDisplayLabel(family);
}

/** True when row is in the physical-return MVP slice (display + queue scope). */
export function isPhysicalReturnMvpRow(row: ClaimCenterV1Row): boolean {
  if (row.source_table !== "return_items") return false;

  if (row.source_kind === "scanner_physical_review") {
    return PHYSICAL_RETURN_MVP_SCANNER_FAMILIES.has(row.claim_family ?? "physical_return_issue");
  }

  if (row.source_kind === "orbit_fra") {
    return PHYSICAL_RETURN_MVP_ORBIT_FAMILIES.has(row.claim_family ?? "");
  }

  return false;
}

export function buildPhysicalReturnMissingNext(row: ClaimCenterV1Row): string[] {
  const missing: string[] = [];
  if (!row.product_linkage?.is_resolved) missing.push("Product not matched");
  if (row.evidence_status === "missing" || row.inbox_queue === "evidence_missing") {
    missing.push("Proof missing");
  }
  if (row.reference_edge_count <= 0) missing.push("References not materialized yet");
  if (row.money_display?.amount_basis === "unknown") missing.push("Cost unknown");
  if (row.money_display?.amount_basis === "zero_unpriced") missing.push("Unpriced");
  if (row.lifecycle_status === "expired" || row.eligibility_display?.status === "expired") {
    missing.push("Filing window expired");
  }
  return missing;
}

export function buildPhysicalReturnDisplay(row: ClaimCenterV1Row): ClaimCenterPhysicalReturnDisplay {
  const mvp = isPhysicalReturnMvpRow(row);
  return {
    physical_return_mvp: mvp,
    physical_event_label: physicalEventLabelFromRow(row),
    physical_family_label: physicalFamilyDisplayLabel(row.claim_family),
    missing_next: buildPhysicalReturnMissingNext(row),
  };
}

export function attachPhysicalReturnMvpFields(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return rows.map((row) => ({
    ...row,
    physical_return_display: buildPhysicalReturnDisplay(row),
  }));
}

export function filterPhysicalReturnMvpRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return rows.filter(isPhysicalReturnMvpRow);
}

export function referenceStatusSummary(row: ClaimCenterV1Row): string {
  if (row.ambiguity_pending || row.v1_status_group === "blocked_reference_conflict") {
    return "Reference conflict — review TRID links.";
  }
  if (row.reference_edge_count > 0) {
    return `${row.reference_edge_count} materialized reference edge(s).`;
  }
  return "References not materialized yet";
}

export function moneyStatusSummary(row: ClaimCenterV1Row): string {
  const md = row.money_display;
  if (!md) return "Money status unknown.";
  if (md.amount_basis === "observed_reimbursement") {
    return md.amount_display_label;
  }
  if (md.cost_unknown) return "Cost unknown — add unit cost to estimate recovery.";
  if (md.zero_unpriced) return "Unpriced — add cost to see recovery.";
  if (md.expected_recovery_value != null && md.expected_recovery_value > 0) {
    return `Expected recovery ${md.amount_display_label}.`;
  }
  return md.amount_tooltip;
}
