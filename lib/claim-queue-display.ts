import { claimEligibilityReasonLabel } from "./claim-eligibility-policy";
import type { ClaimEligibilityReason } from "./claim-policy-types";
import type { EffectiveClaimSettingsSnapshot } from "./claim-effective-settings-shared";
import type { ClaimFlowStage } from "./claim-flow-status-badges";
import type { ReturnsClaimQueueState } from "./returns-claims-work-queue";

export type ClaimQueueDisplayReason =
  | "eligible"
  | "on_hold"
  | "needs_product"
  | "needs_evidence"
  | "needs_note"
  | "outside_claim_window"
  | "pre_cutoff"
  | "ready_for_case"
  | "ready_for_submission"
  | "domain_disabled"
  | "manual_review";

export const CLAIM_QUEUE_DISPLAY_LABELS: Record<ClaimQueueDisplayReason, string> = {
  eligible: "Eligible",
  on_hold: "On hold",
  needs_product: "Needs product link",
  needs_evidence: "Needs evidence",
  needs_note: "Needs operator note",
  outside_claim_window: "Outside claim window",
  pre_cutoff: "Before claim cutoff",
  ready_for_case: "Ready for case",
  ready_for_submission: "Ready for submission",
  domain_disabled: "Returns claims disabled",
  manual_review: "Manual review required",
};

export function resolveClaimQueueDisplayReason(input: {
  queue_state: ReturnsClaimQueueState;
  eligibility_reason: ClaimEligibilityReason;
  has_resolved_product: boolean;
  has_scanner_evidence: boolean;
  has_operator_note: boolean;
  settings: EffectiveClaimSettingsSnapshot;
  flow_stage?: ClaimFlowStage | null;
  claim_submission_id?: string | null;
}): { code: ClaimQueueDisplayReason; label: string; hint: string } {
  const { settings, flow_stage } = input;

  if (input.claim_submission_id || flow_stage === "ready_for_submission" || flow_stage === "pdf_ready") {
    return {
      code: "ready_for_submission",
      label: CLAIM_QUEUE_DISPLAY_LABELS.ready_for_submission,
      hint: "Submission queue — PDF and filing review in Claim Engine.",
    };
  }

  if (flow_stage === "ready_for_case" || input.queue_state === "eligible") {
    const caseWhen = settings.workflow.create_case_when;
    const caseHint =
      caseWhen === "manual_only"
        ? "Eligible — use Case Builder to open a claim case (auto case creation is manual-only)."
        : "Eligible — ready to build or promote a claim case.";
    return {
      code: "ready_for_case",
      label: CLAIM_QUEUE_DISPLAY_LABELS.ready_for_case,
      hint: caseHint,
    };
  }

  if (input.queue_state === "domain_disabled" || input.eligibility_reason === "module_scope_disabled") {
    return {
      code: "domain_disabled",
      label: CLAIM_QUEUE_DISPLAY_LABELS.domain_disabled,
      hint: "Enable Returns in organization claim settings.",
    };
  }

  if (input.eligibility_reason === "outside_window") {
    return {
      code: "outside_claim_window",
      label: CLAIM_QUEUE_DISPLAY_LABELS.outside_claim_window,
      hint: `Scan date is outside the ${settings.claim_window_days}-day eligibility window.`,
    };
  }

  if (
    input.eligibility_reason === "scan_not_live" ||
    input.eligibility_reason === "import_pre_cutoff"
  ) {
    const date =
      input.eligibility_reason === "import_pre_cutoff"
        ? settings.claim_cutoff_date
        : settings.claim_from_date;
    return {
      code: "pre_cutoff",
      label: CLAIM_QUEUE_DISPLAY_LABELS.pre_cutoff,
      hint: date
        ? `Event date is before policy cutoff (${date}).`
        : "Claim cutoff dates are not configured — set go-live / start dates in Claim Settings.",
    };
  }

  if (
    input.eligibility_reason === "hold_package_open" ||
    input.eligibility_reason === "hold_pallet_open" ||
    input.eligibility_reason === "hold_order_incomplete" ||
    input.queue_state === "held_until_package_closed"
  ) {
    return {
      code: "on_hold",
      label: CLAIM_QUEUE_DISPLAY_LABELS.on_hold,
      hint: claimEligibilityReasonLabel(input.eligibility_reason),
    };
  }

  if (input.eligibility_reason === "manual_review_required") {
    return {
      code: "manual_review",
      label: CLAIM_QUEUE_DISPLAY_LABELS.manual_review,
      hint: "Organization policy requires manual review before claims proceed.",
    };
  }

  if (
    !input.has_resolved_product &&
    (settings.workflow.require_product_link || input.queue_state === "needs_product_resolution")
  ) {
    return {
      code: "needs_product",
      label: CLAIM_QUEUE_DISPLAY_LABELS.needs_product,
      hint: settings.allow_manual_override
        ? "Resolve product link — manual override may allow draft without link."
        : "Resolve product via FNSKU, ASIN, or SKU before claiming.",
    };
  }

  if (!input.has_operator_note && settings.workflow.require_operator_note) {
    return {
      code: "needs_note",
      label: CLAIM_QUEUE_DISPLAY_LABELS.needs_note,
      hint: "Operator note is required for this issue type per claim settings.",
    };
  }

  if (
    (!input.has_scanner_evidence && settings.workflow.require_evidence) ||
    input.eligibility_reason === "missing_scanner_evidence" ||
    input.queue_state === "missing_evidence"
  ) {
    return {
      code: "needs_evidence",
      label: CLAIM_QUEUE_DISPLAY_LABELS.needs_evidence,
      hint: "Scanner photos or configured evidence slots are required.",
    };
  }

  return {
    code: "pre_cutoff",
    label: input.queue_state.replace(/_/g, " "),
    hint: claimEligibilityReasonLabel(input.eligibility_reason),
  };
}
