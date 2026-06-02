import { claimEligibilityReasonLabel } from "./claim-eligibility-policy";
import type { ClaimEligibilityReason } from "./claim-policy-types";
import type {
  CreateCaseWhenSetting,
  EffectiveClaimSettingsSnapshot,
} from "./claim-effective-settings-shared";

/** Operator-facing reason codes aligned with Claims Settings. */
export type ClaimGateDisplayCode =
  | "eligible"
  | "on_hold"
  | "outside_claim_window"
  | "pre_cutoff"
  | "needs_product"
  | "needs_evidence"
  | "needs_note"
  | "mixed_product_blocked"
  | "mixed_issue_blocked"
  | "ready_for_case"
  | "ready_for_submission"
  | "domain_disabled"
  | "manual_review"
  | "create_case_manual_only"
  | "promote_disabled";

export const CLAIM_GATE_DISPLAY_LABELS: Record<ClaimGateDisplayCode, string> = {
  eligible: "Eligible",
  on_hold: "On hold",
  outside_claim_window: "Outside claim window",
  pre_cutoff: "Before claim cutoff",
  needs_product: "Needs product link",
  needs_evidence: "Needs evidence",
  needs_note: "Needs operator note",
  mixed_product_blocked: "Mixed product blocked",
  mixed_issue_blocked: "Mixed issue blocked",
  ready_for_case: "Ready for case",
  ready_for_submission: "Ready for submission",
  domain_disabled: "Returns claims disabled",
  manual_review: "Manual review required",
  create_case_manual_only: "Manual case only (settings)",
  promote_disabled: "Not ready for submission",
};

export type ClaimGateEvaluation = {
  allowed: boolean;
  reason: string;
  display_code: ClaimGateDisplayCode;
  display_label: string;
  display_hint: string;
};

function gate(
  allowed: boolean,
  reason: string,
  display_code: ClaimGateDisplayCode,
  display_hint: string,
): ClaimGateEvaluation {
  return {
    allowed,
    reason,
    display_code,
    display_label: CLAIM_GATE_DISPLAY_LABELS[display_code],
    display_hint,
  };
}

export function evaluateMixedProductGate(
  settings: EffectiveClaimSettingsSnapshot,
  distinctProductCount: number,
): ClaimGateEvaluation | null {
  if (distinctProductCount <= 1) return null;
  const allow =
    settings.workflow.allow_mixed_products === true || settings.allow_manual_override === true;
  if (allow) return null;
  return gate(
    false,
    "mixed_product_blocked",
    "mixed_product_blocked",
    "Claim settings disallow multiple products in one case — split by product or enable allow mixed products.",
  );
}

export function evaluateMixedIssueGate(
  settings: EffectiveClaimSettingsSnapshot,
  distinctIssueCount: number,
): ClaimGateEvaluation | null {
  if (distinctIssueCount <= 1) return null;
  if (settings.workflow.allow_mixed_issue_types === true) return null;
  return gate(
    false,
    "mixed_issue_blocked",
    "mixed_issue_blocked",
    "Claim settings disallow multiple issue types in one case — split by issue or enable allow mixed issue types.",
  );
}

export type SubmissionReadinessInput = {
  settings: EffectiveClaimSettingsSnapshot;
  hasResolvedProduct: boolean;
  hasScannerEvidence: boolean;
  hasOperatorNote: boolean;
  eligibilityAllowed: boolean;
  eligibilityReason: ClaimEligibilityReason | string;
  packageClosed?: boolean | null;
  alreadyHasSubmission?: boolean;
};

export function evaluateClaimSubmissionReadiness(
  input: SubmissionReadinessInput,
): ClaimGateEvaluation {
  if (input.alreadyHasSubmission) {
    return gate(true, "already_linked", "ready_for_submission", "Submission already linked to this case.");
  }

  if (!input.settings.workflow.require_product_link || input.settings.allow_manual_override) {
    /* allow missing product when override */
  } else if (!input.hasResolvedProduct) {
    return gate(
      false,
      "needs_product_resolution",
      "needs_product",
      "Resolve product link before promoting to submission.",
    );
  }

  if (input.settings.workflow.require_evidence !== false && !input.hasScannerEvidence) {
    return gate(
      false,
      "missing_scanner_evidence",
      "needs_evidence",
      "Scanner evidence is required per claim settings.",
    );
  }

  if (!input.eligibilityAllowed) {
    const reason = String(input.eligibilityReason);
    if (reason === "outside_window") {
      return gate(false, reason, "outside_claim_window", `Outside ${input.settings.claim_window_days}-day claim window.`);
    }
    if (reason === "hold_package_open" || reason === "hold_pallet_open" || reason === "hold_order_incomplete") {
      return gate(false, reason, "on_hold", claimEligibilityReasonLabel(reason as ClaimEligibilityReason));
    }
    if (reason === "manual_review_required") {
      return gate(false, reason, "manual_review", "Manual review required by organization policy.");
    }
    const label =
      reason === "scan_not_live" || reason === "import_pre_cutoff"
        ? "pre_cutoff"
        : "promote_disabled";
    return gate(
      false,
      reason,
      label,
      claimEligibilityReasonLabel(reason as ClaimEligibilityReason) || reason,
    );
  }

  return gate(
    true,
    "allowed",
    "ready_for_submission",
    input.settings.auto_generate_pdf_reports
      ? "Ready for submission — PDF will generate on promote."
      : "Ready for submission — PDF generation is off in claim agent settings.",
  );
}

export type AutoCaseCreationContext = {
  packageClosed?: boolean | null;
  palletClosed?: boolean | null;
  removalOrderClosed?: boolean | null;
};

function isAutoCaseCreationAllowedByWorkflow(
  when: CreateCaseWhenSetting,
  ctx: AutoCaseCreationContext,
): { allowed: boolean; reason?: string } {
  if (when === "manual_only") return { allowed: false, reason: "create_case_manual_only" };
  if (when === "package_closed" && ctx.packageClosed !== true) {
    return { allowed: false, reason: "create_case_awaiting_package_closed" };
  }
  if (when === "pallet_closed" && ctx.palletClosed !== true) {
    return { allowed: false, reason: "create_case_awaiting_pallet_closed" };
  }
  if (when === "removal_order_closed" && ctx.removalOrderClosed !== true) {
    return { allowed: false, reason: "create_case_awaiting_removal_order_closed" };
  }
  return { allowed: true };
}

export function evaluateAutoPromoteCaseGate(
  settings: EffectiveClaimSettingsSnapshot,
  ctx: AutoCaseCreationContext,
): ClaimGateEvaluation {
  const auto = isAutoCaseCreationAllowedByWorkflow(settings.workflow.create_case_when, ctx);
  if (!auto.allowed) {
    const code: ClaimGateDisplayCode =
      auto.reason === "create_case_manual_only" ? "create_case_manual_only" : "on_hold";
    const hints: Record<string, string> = {
      create_case_manual_only:
        "Auto case creation is disabled (manual only). Use Case Builder to open a claim case.",
      create_case_awaiting_package_closed: "Auto case creation waits until the package is closed.",
      create_case_awaiting_pallet_closed: "Auto case creation waits until the pallet is closed.",
      create_case_awaiting_removal_order_closed:
        "Auto case creation waits until the removal order is closed.",
    };
    return gate(
      false,
      auto.reason ?? "blocked",
      code,
      hints[auto.reason ?? ""] ?? "Auto case creation blocked by settings.",
    );
  }
  return gate(true, "allowed", "ready_for_case", "Auto case creation is allowed for this scan.");
}
