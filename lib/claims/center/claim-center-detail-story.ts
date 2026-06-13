import type { ClaimCenterV1Row } from "./claim-center-v1-types";
import {
  moneyStatusSummary,
  physicalEventLabelFromRow,
  physicalFamilyDisplayLabel,
  referenceStatusSummary,
  buildPhysicalReturnMissingNext,
} from "./claim-center-physical-return-mvp";

export type ClaimCenterDetailBlockId =
  | "event"
  | "product"
  | "evidence"
  | "reference"
  | "policy"
  | "next_step";

export const CLAIM_CENTER_DETAIL_BLOCK_ORDER: ClaimCenterDetailBlockId[] = [
  "event",
  "product",
  "evidence",
  "reference",
  "policy",
  "next_step",
];

export type ClaimCenterDetailNextStep = {
  headline: string;
  reviewNow: string;
  lockedActions: string;
  afterBridge: string;
  safeHref: string | null;
  safeLabel: string | null;
  legacyHref: string;
  legacyLabel: string;
};

export function formatClaimCenterMoney(row: ClaimCenterV1Row): string {
  if (row.money_display?.amount_display_label) return row.money_display.amount_display_label;
  if (row.recovery_value == null) return "Cost unknown";
  if (row.recovery_value === 0 && (row.cogs_unit == null || row.cogs_unit === 0)) {
    return "Unpriced — add cost to see recovery";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: row.currency ?? "USD",
    maximumFractionDigits: 2,
  }).format(row.recovery_value);
}

export function claimCenterSourceTypeLabel(row: ClaimCenterV1Row): string {
  return row.badges.find((b) => b.kind === "source")?.label ?? row.source_kind ?? "Unknown source";
}

export function claimCenterEventSummary(row: ClaimCenterV1Row): string {
  if (row.physical_return_display?.physical_return_mvp) {
    const parts = [
      row.physical_return_display.physical_family_label,
      row.physical_return_display.physical_event_label,
    ].filter(Boolean);
    return parts.join(" · ");
  }
  const parts = [
    claimCenterSourceTypeLabel(row),
    physicalFamilyDisplayLabel(row.claim_family),
    row.claim_reason,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Physical return from warehouse scan";
}

export function resolveClaimCenterNextStep(row: ClaimCenterV1Row): ClaimCenterDetailNextStep {
  const legacyHref = "/claim-engine";
  const legacyLabel = "Claim Engine (legacy)";

  switch (row.v1_status_group) {
    case "blocked_product_link":
      return {
        headline: "Product not matched",
        reviewNow:
          "Match this scan to catalog by ASIN or FNSKU in Product Hub before trusting cost or filing.",
        lockedActions: "Promote, file, and submit stay locked until product match is resolved.",
        afterBridge: "After the filing bridge opens, you can promote and file once linkage is confirmed.",
        safeHref: "/claim-center/product-linkage",
        safeLabel: "Open product match queue",
        legacyHref,
        legacyLabel,
      };
    case "blocked_reference_conflict":
      return {
        headline: "Resolve reference conflict",
        reviewNow: "Review the reference block above. Note which Amazon IDs conflict and which event they tie to.",
        lockedActions: "Filing stays locked while a reference conflict is unresolved.",
        afterBridge: "Reference pick and filing will happen in Claim Center after the write bridge.",
        safeHref: "/claim-center/references",
        safeLabel: "Open references queue",
        legacyHref: "/claim-engine/review-ops",
        legacyLabel,
      };
    case "needs_review":
      return {
        headline: "Needs review",
        reviewNow:
          "Walk through product match, proof, and reference blocks. Confirm the event story matches warehouse records.",
        lockedActions: "Promote and submit stay locked until review is complete.",
        afterBridge: "Human approve and promote will open in Claim Center after the write bridge.",
        safeHref: "/claim-center/candidates?filter=needs_review",
        safeLabel: "Stay in review queue",
        legacyHref: "/claim-engine/review-ops",
        legacyLabel,
      };
    case "evidence_ready":
    case "new":
      return {
        headline: "Verify proof before filing",
        reviewNow: "Open the proof block and preview the packet. Confirm photos, notes, and imports are complete.",
        lockedActions: "File, submit, and PDF export stay locked in this release.",
        afterBridge: "Attach proof and file from Claim Center after the write bridge opens.",
        safeHref: "/claim-center/evidence",
        safeLabel: "Open proof queue",
        legacyHref,
        legacyLabel,
      };
    case "ready_to_file":
      return {
        headline: "Looks ready — filing still locked",
        reviewNow: "Use the six blocks to confirm product, proof, references, and policy window one last time.",
        lockedActions: "Submit, PDF export, and promote are disabled until the write bridge ships.",
        afterBridge: "One-click file and submission will happen here after the bridge — not in legacy UI.",
        safeHref: "/claim-center/opportunities",
        safeLabel: "Back to money queue",
        legacyHref,
        legacyLabel,
      };
    case "filed":
    case "reimbursed":
      return {
        headline: "Observed reimbursement outcome",
        reviewNow: "Compare observed status with imports and warehouse records. No action required in Claim Center.",
        lockedActions: "No further filing actions for observed outcomes in this release.",
        afterBridge: "Dispute or re-open flows may return here after the bridge if policy allows.",
        safeHref: "/claim-center/recovery",
        safeLabel: "Open recovery view",
        legacyHref: "/claim-engine/report-history",
        legacyLabel,
      };
    case "expired":
      return {
        headline: "Filing window expired",
        reviewNow: "Confirm the deadline in the policy block. Archive or note for audit — no filing path remains.",
        lockedActions: "Promote and file are not available after the window closes.",
        afterBridge: "Late filing or exception flows are out of scope until policy defines them.",
        safeHref: "/claim-center/opportunities",
        safeLabel: "Back to money queue",
        legacyHref,
        legacyLabel,
      };
    case "rejected":
      return {
        headline: "Closed or rejected",
        reviewNow: "Read the event and policy blocks for closure reason. Keep for audit reference.",
        lockedActions: "Re-open and dispute are locked in Claim Center V2.",
        afterBridge: "Exception handling may return after the write bridge if workspace policy allows.",
        safeHref: null,
        safeLabel: null,
        legacyHref,
        legacyLabel,
      };
    default:
      return {
        headline: "Read-only inspection",
        reviewNow: "Use all six blocks to understand the event before any filing action.",
        lockedActions: "Promote, file, and submit require the write bridge.",
        afterBridge: "Filing workflow will live in Claim Center after the bridge — not scattered legacy screens.",
        safeHref: "/claim-center/opportunities",
        safeLabel: "Back to money queue",
        legacyHref,
        legacyLabel,
      };
  }
}

export function claimCenterEvidenceGapSummary(row: ClaimCenterV1Row): string {
  const status = row.evidence_status ?? "unknown";
  if (status === "complete") return "Proof appears complete (preview-only check).";
  if (status === "partial") return "Some proof present — additional photos or notes may still be required.";
  if (status === "missing") return "Proof missing — photos or operator notes not linked yet.";
  return "Proof status unknown — check return item evidence after intake.";
}

export function claimCenterReferenceStatusSummary(row: ClaimCenterV1Row): string {
  return referenceStatusSummary(row);
}

export function claimCenterMoneyStatusSummary(row: ClaimCenterV1Row): string {
  return moneyStatusSummary(row);
}

export function claimCenterPhysicalEventLabel(row: ClaimCenterV1Row): string {
  return row.physical_return_display?.physical_event_label ?? physicalEventLabelFromRow(row);
}

export function claimCenterMissingNextSummary(row: ClaimCenterV1Row): string {
  const items = row.physical_return_display?.missing_next ?? buildPhysicalReturnMissingNext(row);
  if (!items.length) return "No blockers flagged — verify proof, product match, and references before filing.";
  return items.join(" · ");
}

export function claimCenterPolicyEligibilitySummary(row: ClaimCenterV1Row): string {
  if (row.eligibility_display?.label) {
    const detail = row.eligibility_display.detail;
    return detail ? `${row.eligibility_display.label} — ${detail}` : row.eligibility_display.label;
  }
  const window = row.canonical_window;
  if (window.status === "expired") return "Filing window expired under workspace rules.";
  if (window.status === "closing_soon") return "Filing window closing soon — prioritize review.";
  if (window.status === "open") return "Within the effective filing window for this claim type.";
  return "Policy status could not be determined from workspace rules.";
}
