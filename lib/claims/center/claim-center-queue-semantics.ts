import type {
  ClaimCenterQueueCounts,
  ClaimCenterV1Row,
  ClaimCenterV1StatusGroup,
} from "./claim-center-v1-types";
import { flattenTwinGroups, groupTwinCandidatesForDisplay } from "./claim-center-twin-grouping";

const RECOVERABLE: Set<ClaimCenterV1StatusGroup> = new Set([
  "new",
  "needs_review",
  "evidence_ready",
  "blocked_product_link",
  "blocked_reference_conflict",
  "ready_to_file",
]);

const OBSERVED_RECOVERY: Set<ClaimCenterV1StatusGroup> = new Set(["filed", "reimbursed"]);

export function isRecoverableStatus(group: ClaimCenterV1StatusGroup): boolean {
  return RECOVERABLE.has(group);
}

/** Find Money — all active recoverable rows including blocked product/reference. */
export function isFindMoneyRow(row: ClaimCenterV1Row): boolean {
  if (!isRecoverableStatus(row.v1_status_group)) return false;
  if (row.canonical_window.status === "expired") return false;
  return true;
}

export function isBlockedMoneyRow(row: ClaimCenterV1Row): boolean {
  return (
    isFindMoneyRow(row) &&
    (row.v1_status_group === "blocked_product_link" || row.v1_status_group === "blocked_reference_conflict")
  );
}

/** Review — human decision blockers (product, reference, general review — not proof-only). */
export function isReviewRow(row: ClaimCenterV1Row): boolean {
  if (row.v1_status_group === "blocked_product_link") return true;
  if (row.v1_status_group === "blocked_reference_conflict") return true;
  if (row.v1_status_group === "needs_review" && row.evidence_status !== "missing") return true;
  if (row.v1_status_group === "evidence_ready") return true;
  return false;
}

/** Proof — evidence missing (may overlap review; Proof page is evidence-specific). */
export function isProofRow(row: ClaimCenterV1Row): boolean {
  if (!isRecoverableStatus(row.v1_status_group)) return false;
  return row.evidence_status === "missing" || row.inbox_queue === "evidence_missing";
}

/** Product Match — unresolved catalog linkage. */
export function isProductLinkageRow(row: ClaimCenterV1Row): boolean {
  return !row.product_linkage?.is_resolved;
}

/** References — materialized edges with ambiguity or conflict only. */
export function isReferencesRow(row: ClaimCenterV1Row): boolean {
  if (row.reference_edge_count <= 0) return false;
  return row.ambiguity_pending || row.v1_status_group === "blocked_reference_conflict";
}

/** Recovery — observed filed/reimbursed only. */
export function isObservedRecoveryRow(row: ClaimCenterV1Row): boolean {
  return OBSERVED_RECOVERY.has(row.v1_status_group);
}

export function filterFindMoneyRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return flattenTwinGroups(groupTwinCandidatesForDisplay(rows.filter(isFindMoneyRow)));
}

export function filterBlockedMoneyRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return flattenTwinGroups(groupTwinCandidatesForDisplay(rows.filter(isBlockedMoneyRow)));
}

export function filterReviewRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return rows.filter(isReviewRow);
}

export function filterProofRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return rows.filter(isProofRow);
}

export function filterProductLinkageRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return rows.filter(isProductLinkageRow);
}

export function filterReferencesRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return rows.filter(isReferencesRow);
}

export function filterObservedRecoveryRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return rows.filter(isObservedRecoveryRow);
}

export function computeQueueCounts(rows: ClaimCenterV1Row[]): ClaimCenterQueueCounts {
  const findMoney = filterFindMoneyRows(rows);
  const blocked = filterBlockedMoneyRows(rows);
  return {
    find_money_count: findMoney.length,
    blocked_money_count: blocked.length,
    review_count: filterReviewRows(rows).length,
    proof_count: filterProofRows(rows).length,
    product_unlinked_count: filterProductLinkageRows(rows).length,
    references_materialized_count: filterReferencesRows(rows).length,
    observed_recovery_count: filterObservedRecoveryRows(rows).length,
  };
}

export const QUEUE_SEMANTICS_NOTES = {
  find_money:
    "Includes recoverable opportunities even when product or reference blockers exist. Blocked rows appear in a separate bucket when applicable.",
  review:
    "Human decision blockers — product match, reference conflict, or rows needing operator review. Proof-only gaps are listed under Proof.",
  proof:
    "Rows with missing evidence only. Complete proof does not appear here even if other blockers remain.",
  references:
    "Only candidates with materialized reference edges and ambiguity or conflict. Reference IDs without edges are not listed.",
  recovery:
    "Observed filed or reimbursed status only — not blocked intake candidates.",
} as const;
