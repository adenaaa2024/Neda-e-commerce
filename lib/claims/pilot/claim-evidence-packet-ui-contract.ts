/**
 * PHASE-CLAIM-EVIDENCE-PACKET-UI-V1
 * Read-only UI contract for pilot review evidence packet preview.
 */
import type { ClaimEvidencePacketV1 } from "@/lib/claims/evidence/claim-evidence-packet-v1";
import { DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID } from "./claim-pilot-review-readmodel";

export const CLAIM_EVIDENCE_PACKET_UI_VERSION = "claim-evidence-packet-ui-v1" as const;

export const EVIDENCE_PACKET_API_PATH = "/api/claims/center/evidence-packet" as const;

export const EVIDENCE_PACKET_SECTION_ID = "pilot-evidence-packet-section" as const;

export const EVIDENCE_PACKET_PREVIEW_BUTTON_LABEL = "Preview evidence packet" as const;
export const EVIDENCE_PACKET_HTML_PREVIEW_BUTTON_LABEL = "View HTML preview" as const;

export const EVIDENCE_PACKET_DRAWER_FIELDS = [
  "candidate_identity",
  "intake_run_id",
  "product_identity",
  "claim_family",
  "source_kind",
  "source_event_key",
  "clean_quantity",
  "source_event_date",
  "effective_date_source",
  "effective_date_value",
  "date_gate_passed",
  "evidence_summary",
  "source_row_pointers",
  "reference_edges",
  "evidence_pointers",
  "money_lanes",
  "warnings",
  "blockers",
  "ready_for_case_creation",
] as const;

export type EvidencePacketReadinessBadge =
  | "ready_for_case_planning"
  | "needs_evidence_review"
  | "blocked";

export const EVIDENCE_PACKET_READINESS_BADGE_LABELS: Record<EvidencePacketReadinessBadge, string> = {
  ready_for_case_planning: "Ready for case planning",
  needs_evidence_review: "Needs evidence review",
  blocked: "Blocked",
};

export function evidencePacketApiParams(candidateId: string, intakeRunId?: string | null) {
  return {
    candidate_id: candidateId,
    intake_run_id: intakeRunId?.trim() || DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: "1",
  };
}

export function deriveEvidencePacketReadinessBadge(
  packet: Pick<ClaimEvidencePacketV1, "blocker_flags" | "review_flags" | "readiness">,
): EvidencePacketReadinessBadge {
  if (packet.blocker_flags.length > 0 || packet.readiness.ready_for_case_creation === "no") {
    return "blocked";
  }
  if (packet.review_flags.length > 0) {
    return "needs_evidence_review";
  }
  return "ready_for_case_planning";
}

export function productIdentityLabel(
  identity: ClaimEvidencePacketV1["product_identity"],
): string {
  const parts = [identity.asin, identity.fnsku, identity.sku].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (identity.product_id) return identity.product_id.slice(0, 8) + "…";
  return "—";
}

export function verifyEvidencePacketDisplay(packet: ClaimEvidencePacketV1): {
  identity: boolean;
  product: boolean;
  date_gate: boolean;
  edges: boolean;
  evidence: boolean;
  readiness: boolean;
} {
  return {
    identity: !!packet.candidate_id && !!packet.family_key_v3,
    product: !!packet.product_identity,
    date_gate: packet.date_gate.date_gate_passed && !!packet.date_gate.source_event_date,
    edges: packet.reference_edges.length > 0 && packet.source_edges.length > 0,
    evidence: !!packet.evidence_summary,
    readiness: packet.readiness.ready_for_case_creation === "yes" || packet.readiness.ready_for_case_creation === "no",
  };
}
