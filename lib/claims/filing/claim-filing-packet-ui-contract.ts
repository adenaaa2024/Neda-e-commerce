/**
 * PHASE-CLAIM-FILING-PACKET-UI-V1
 * Read-only UI contract for Case Review filing packet preview.
 */
import type { ClaimCaseReviewRow } from "@/lib/claims/pilot/claim-case-review-readmodel";
import {
  DEFAULT_CASE_REVIEW_INTAKE_RUN_ID,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "@/lib/claims/pilot/claim-case-review-ui-contract";
import type { ClaimFilingPacketPreviewV1 } from "./claim-filing-packet-preview-v1";

export const CLAIM_FILING_PACKET_UI_VERSION = "claim-filing-packet-ui-v1" as const;

export const FILING_PACKET_API_PATH = "/api/claims/center/filing-packet-preview" as const;

export const FILING_PACKET_SECTION_ID = "case-review-filing-packet-section" as const;

export const FILING_PACKET_PREVIEW_BUTTON_LABEL = "Preview filing packet" as const;

export const FILING_PACKET_DRAWER_FIELDS = [
  "case_identity",
  "pilot_case_run_id",
  "intake_run_id",
  "claim_family",
  "claim_source",
  "claim_subtype",
  "case_status",
  "candidate_ids",
  "claim_lines",
  "product_identity",
  "clean_quantity",
  "source_event_key",
  "source_event_date",
  "evidence_summary",
  "source_edges",
  "reference_edges",
  "operator_attestation",
  "money_lanes",
  "warnings",
  "blockers",
  "ready_for_pdf_preview",
  "ready_for_manual_filing",
] as const;

export type FilingPacketReadinessBadge =
  | "ready_for_pdf_preview"
  | "ready_for_manual_filing"
  | "needs_review"
  | "blocked";

export const FILING_PACKET_READINESS_BADGE_LABELS: Record<FilingPacketReadinessBadge, string> = {
  ready_for_pdf_preview: "Ready for PDF preview",
  ready_for_manual_filing: "Ready for manual filing",
  needs_review: "Needs review",
  blocked: "Blocked",
};

export function filingPacketApiParams(args: {
  caseId: string;
  pilotCaseRunId?: string | null;
  intakeRunId?: string | null;
  status?: string | null;
}) {
  return {
    case_id: args.caseId,
    pilot_case_run_id: args.pilotCaseRunId?.trim() || DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: args.intakeRunId?.trim() || DEFAULT_CASE_REVIEW_INTAKE_RUN_ID,
    status: args.status?.trim() || "open",
    limit: "1",
  };
}

function metaBool(meta: Record<string, unknown>, key: string): boolean {
  return meta[key] === true;
}

export function isRemediatedDuplicateCase(row: ClaimCaseReviewRow): boolean {
  const meta = row.metadata ?? {};
  return (
    row.status === "closed" ||
    metaBool(meta, "remediation_duplicate") ||
    row.rollback_metadata != null
  );
}

export function deriveFilingPacketReadinessBadges(
  preview: Pick<ClaimFilingPacketPreviewV1, "blockers" | "warnings" | "readiness">,
  rowRemediated: boolean,
): FilingPacketReadinessBadge[] {
  if (rowRemediated || preview.blockers.length > 0) {
    return ["blocked"];
  }
  const badges: FilingPacketReadinessBadge[] = [];
  if (preview.warnings.length > 0) badges.push("needs_review");
  if (preview.readiness.ready_for_pdf_preview) badges.push("ready_for_pdf_preview");
  if (preview.readiness.ready_for_manual_filing) badges.push("ready_for_manual_filing");
  return badges.length > 0 ? badges : ["blocked"];
}

export function filingPacketPreviewDisabled(row: ClaimCaseReviewRow): boolean {
  return isRemediatedDuplicateCase(row);
}

export function productIdentityLabel(
  identity: ClaimFilingPacketPreviewV1["product_identity"],
): string {
  const parts = [identity.asin, identity.fnsku, identity.sku].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (identity.resolved_product_id) return identity.resolved_product_id;
  return "—";
}

export function remediationStatusLabel(row: ClaimCaseReviewRow): string {
  const meta = row.metadata ?? {};
  if (metaBool(meta, "remediation_duplicate")) return "Remediated duplicate (soft-closed)";
  if (row.rollback_metadata) return "Rollback / remediation metadata present";
  if (row.status === "closed") return "Case closed";
  return "—";
}
