import type { ReturnsClaimQueueState } from "@/lib/returns-claims-work-queue";

/** Unified operator-facing claim flow stage (physical scan → case → submission → PDF). */
export type ClaimFlowStage =
  | "needs_product"
  | "needs_review"
  | "on_hold"
  | "ready_for_case"
  | "case_ready"
  | "case_built"
  | "ready_for_submission"
  | "pdf_ready"
  | "pre_cutoff"
  | "domain_disabled";

export const CLAIM_FLOW_STAGE_LABELS: Record<ClaimFlowStage, string> = {
  needs_product: "Needs product",
  needs_review: "Needs review",
  on_hold: "On hold",
  ready_for_case: "Ready for case",
  case_ready: "Case ready",
  case_built: "Case built",
  ready_for_submission: "Ready for submission",
  pdf_ready: "PDF ready",
  pre_cutoff: "Pre-cutoff",
  domain_disabled: "Returns disabled",
};

export const CLAIM_FLOW_STAGE_BADGE_CLASS: Record<ClaimFlowStage, string> = {
  needs_product: "claim-engine-chip claim-engine-chip--accent",
  needs_review: "claim-engine-chip claim-engine-chip--warning",
  on_hold: "claim-engine-chip claim-engine-chip--info",
  ready_for_case: "claim-engine-chip claim-engine-chip--success",
  case_ready: "claim-engine-chip claim-engine-chip--info",
  case_built: "claim-engine-chip claim-engine-chip--info",
  ready_for_submission: "claim-engine-chip claim-engine-chip--success",
  pdf_ready: "claim-engine-chip claim-engine-chip--success",
  pre_cutoff: "claim-engine-chip claim-engine-chip--neutral",
  domain_disabled: "claim-engine-chip claim-engine-chip--danger",
};

export function deriveClaimFlowStage(input: {
  queue_state: ReturnsClaimQueueState;
  claim_case_id?: string | null;
  claim_case_status?: string | null;
  claim_submission_id?: string | null;
  submission_has_pdf?: boolean;
}): ClaimFlowStage {
  if (input.queue_state === "domain_disabled") return "domain_disabled";
  if (input.queue_state === "pre_cutoff") return "pre_cutoff";
  if (input.submission_has_pdf && input.claim_submission_id) return "pdf_ready";
  if (input.claim_submission_id) return "ready_for_submission";
  if (input.claim_case_id) {
    const st = String(input.claim_case_status ?? "").trim().toLowerCase();
    return st === "open" ? "case_ready" : "case_built";
  }
  if (input.queue_state === "needs_product_resolution") return "needs_product";
  if (input.queue_state === "held_until_package_closed") return "on_hold";
  if (input.queue_state === "missing_evidence") return "needs_review";
  if (input.queue_state === "eligible") return "ready_for_case";
  return "needs_review";
}

export function claimFlowStageHint(stage: ClaimFlowStage): string {
  switch (stage) {
    case "needs_product":
      return "Resolve product via FNSKU, ASIN, or SKU before creating a case.";
    case "needs_review":
      return "Add scanner photos and/or an operator note for this issue type.";
    case "on_hold":
      return "Close the package before the claim can proceed.";
    case "ready_for_case":
      return "Eligible to create a claim case from this physical scan.";
    case "case_ready":
      return "Internal claim packet is ready — promote to submission queue for PDF.";
    case "case_built":
      return "Claim packet exists but may need investigation before submission.";
    case "ready_for_submission":
      return "In submission queue — generate PDF from Claim Engine.";
    case "pdf_ready":
      return "PDF stored on submission — ready for marketplace filing review.";
    default:
      return "";
  }
}
