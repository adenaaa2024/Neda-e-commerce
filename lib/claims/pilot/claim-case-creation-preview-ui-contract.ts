/**
 * PHASE-CLAIM-CASE-CREATION-PREVIEW-UI-V1
 * Read-only UI contract for pilot review case creation preview.
 */
import type { ClaimCasePreviewV1 } from "@/lib/claims/case-creation/claim-case-creation-preview-v1";
import { DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID } from "./claim-pilot-review-readmodel";
import { EVIDENCE_PACKET_SECTION_ID } from "./claim-evidence-packet-ui-contract";

export const CLAIM_CASE_CREATION_PREVIEW_UI_VERSION = "claim-case-creation-preview-ui-v1" as const;

export const CASE_CREATION_PREVIEW_API_PATH = "/api/claims/center/case-creation-preview" as const;

export const CASE_PREVIEW_SECTION_ID = "pilot-case-preview-section" as const;
export { EVIDENCE_PACKET_SECTION_ID };

export const CASE_PREVIEW_BUTTON_LABEL = "Preview case creation" as const;
export const BULK_CASE_PREVIEW_BUTTON_LABEL = "Load case previews" as const;

export const CASE_PREVIEW_DRAWER_FIELDS = [
  "proposed_case_type",
  "proposed_case_family",
  "source_event_key",
  "included_candidate_ids",
  "clean_quantity",
  "estimated_amount",
  "recovery_value",
  "observed_reimbursement",
  "evidence_packet_readiness",
  "warnings",
  "blockers",
  "duplicate_risk",
  "recommended_action",
] as const;

export type CasePreviewBulkMode = "selected" | "all_pilot" | "grouped";

export const CASE_PREVIEW_BULK_MODE_LABELS: Record<CasePreviewBulkMode, string> = {
  selected: "Selected candidates",
  all_pilot: "All pilot candidates",
  grouped: "Grouped cases",
};

export const CASE_PREVIEW_RECOMMENDED_ACTION_LABELS: Record<
  ClaimCasePreviewV1["recommended_action"],
  string
> = {
  create_case_preview_ready: "Ready for case creation (preview)",
  needs_operator_review: "Needs operator review",
  blocked: "Blocked",
};

export function casePreviewApiParams(args: {
  candidateId?: string | null;
  candidateIds?: string[];
  intakeRunId?: string | null;
  limit?: number;
}): Record<string, string> {
  const params: Record<string, string> = {
    intake_run_id: args.intakeRunId?.trim() || DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: String(args.limit ?? 50),
  };
  if (args.candidateId) params.candidate_id = args.candidateId;
  if (args.candidateIds?.length) params.candidate_ids = args.candidateIds.join(",");
  return params;
}

export function deriveCasePreviewActionTone(
  action: ClaimCasePreviewV1["recommended_action"],
): "success" | "warning" | "danger" {
  if (action === "create_case_preview_ready") return "success";
  if (action === "needs_operator_review") return "warning";
  return "danger";
}

export function verifyCasePreviewDisplay(preview: ClaimCasePreviewV1): {
  identity: boolean;
  amounts: boolean;
  readiness: boolean;
  action: boolean;
} {
  return {
    identity: !!preview.case_preview_id && !!preview.proposed_case_family,
    amounts:
      preview.estimated_amount == null &&
      preview.recovery_value == null &&
      preview.observed_reimbursement == null,
    readiness: preview.evidence_packet_readiness.ready_for_case_creation === "yes",
    action: !!preview.recommended_action,
  };
}

export function productIdentifiersLabel(
  ids: ClaimCasePreviewV1["product_identifiers"],
): string {
  const parts = [ids.asin, ids.fnsku, ids.sku].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (ids.product_id) return ids.product_id.slice(0, 8) + "…";
  return "—";
}
