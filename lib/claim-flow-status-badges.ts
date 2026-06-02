import type { ReturnsClaimQueueState } from "@/lib/returns-claims-work-queue";

/** Unified operator-facing claim flow stage (physical scan → case → submission → PDF). */
export type ClaimFlowStage =
  | "needs_product"
  | "needs_review"
  | "on_hold"
  | "ready_for_case"
  | "case_created"
  | "ready_for_submission"
  | "pdf_ready"
  | "pre_cutoff"
  | "domain_disabled";

export const CLAIM_FLOW_STAGE_LABELS: Record<ClaimFlowStage, string> = {
  needs_product: "Needs product",
  needs_review: "Needs review",
  on_hold: "On hold",
  ready_for_case: "Ready for case",
  case_created: "Case created",
  ready_for_submission: "Ready for submission",
  pdf_ready: "PDF ready",
  pre_cutoff: "Pre-cutoff",
  domain_disabled: "Returns disabled",
};

export const CLAIM_FLOW_STAGE_BADGE_CLASS: Record<ClaimFlowStage, string> = {
  needs_product: "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
  needs_review: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  on_hold: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200",
  ready_for_case: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
  case_created: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200",
  ready_for_submission: "bg-teal-100 text-teal-800 dark:bg-teal-950/40 dark:text-teal-200",
  pdf_ready: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100",
  pre_cutoff: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  domain_disabled: "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
};

export function deriveClaimFlowStage(input: {
  queue_state: ReturnsClaimQueueState;
  claim_case_id?: string | null;
  claim_submission_id?: string | null;
  submission_has_pdf?: boolean;
}): ClaimFlowStage {
  if (input.queue_state === "domain_disabled") return "domain_disabled";
  if (input.queue_state === "pre_cutoff") return "pre_cutoff";
  if (input.submission_has_pdf && input.claim_submission_id) return "pdf_ready";
  if (input.claim_submission_id) return "ready_for_submission";
  if (input.claim_case_id) return "case_created";
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
    case "case_created":
      return "Claim case exists — promote to submission queue when ready.";
    case "ready_for_submission":
      return "In submission queue — generate PDF from Claim Engine.";
    case "pdf_ready":
      return "PDF stored on submission — ready for marketplace filing review.";
    default:
      return "";
  }
}
