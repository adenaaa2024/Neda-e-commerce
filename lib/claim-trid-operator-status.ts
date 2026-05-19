/**
 * CLAIM-TRID-READ-PATH-FINALIZE-V171 — Operator workflow statuses (read/display).
 */

import type { ClaimEvidenceEdgeReviewSummary } from "./claim-evidence-edge-review";
import type { TridCandidateOutcome } from "./claim-trid-candidates-types";

/** Persisted on claim_reference_edges (migration 20260821120000). */
export type ClaimEdgeReviewStatus = "accepted" | "rejected" | "needs_review";

/** Operator workflow labels including non-persisted copy step (session until DDL approved). */
export type ClaimTridWorkflowStatus = ClaimEdgeReviewStatus | "copied_to_amazon_form";

export const CLAIM_EDGE_REVIEW_STATUSES: ClaimEdgeReviewStatus[] = [
  "accepted",
  "rejected",
  "needs_review",
];

export const CLAIM_TRID_WORKFLOW_STATUSES: ClaimTridWorkflowStatus[] = [
  ...CLAIM_EDGE_REVIEW_STATUSES,
  "copied_to_amazon_form",
];

export const OPERATOR_STATUS_LABELS: Record<ClaimTridWorkflowStatus, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  needs_review: "Needs review",
  copied_to_amazon_form: "Copied to Amazon form",
};

export type ClaimTridOperatorStatusSummary = {
  edge_review: ClaimEvidenceEdgeReviewSummary;
  trid_outcome: TridCandidateOutcome | null;
  reference_candidate_count: number;
  copied_to_amazon_form_at: string | null;
  workflow_statuses_available: ClaimTridWorkflowStatus[];
};

const COPIED_STORAGE_PREFIX = "claim-trid-copied:";

export function copiedToAmazonFormStorageKey(draftId: string): string {
  return `${COPIED_STORAGE_PREFIX}${draftId}`;
}

/** Browser-only: read whether operator marked TRID copied to Amazon form. */
export function readCopiedToAmazonFormAt(draftId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(copiedToAmazonFormStorageKey(draftId));
  } catch {
    return null;
  }
}

export function writeCopiedToAmazonFormAt(draftId: string, at?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(copiedToAmazonFormStorageKey(draftId), at ?? new Date().toISOString());
  } catch {
    /* ignore */
  }
}

export function buildOperatorStatusSummary(input: {
  edgeReview: ClaimEvidenceEdgeReviewSummary;
  tridOutcome: TridCandidateOutcome | null;
  referenceCandidateCount: number;
  copiedToAmazonFormAt?: string | null;
}): ClaimTridOperatorStatusSummary {
  return {
    edge_review: input.edgeReview,
    trid_outcome: input.tridOutcome,
    reference_candidate_count: input.referenceCandidateCount,
    copied_to_amazon_form_at: input.copiedToAmazonFormAt ?? null,
    workflow_statuses_available: CLAIM_TRID_WORKFLOW_STATUSES,
  };
}
