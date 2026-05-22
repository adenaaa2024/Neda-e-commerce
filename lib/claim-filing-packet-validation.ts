/**
 * CLAIM-EVIDENCE-10 — Filing packet integrity validation (no submission).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { FilingReadinessGate } from "./claim-evidence-filing-readiness";
import {
  buildClaimFilingPacketPreview,
  type ClaimFilingPacketPreview,
} from "./claim-filing-packet-preview";
import type { ClaimEvidenceDraftRow } from "./claim-evidence-preview";

export const CLAIM_FILING_PACKET_VALIDATION_SCHEMA_VERSION =
  "claim-filing-packet-validation-v1" as const;

export type FilingPacketValidationStatus = "pass" | "fail" | "warn";

export type FilingPacketValidationCheck = {
  id: string;
  category:
    | "lineage"
    | "trid"
    | "warnings"
    | "grouping"
    | "attachments"
    | "operator_review"
    | "filing_gate";
  label: string;
  status: FilingPacketValidationStatus;
  message: string;
};

export type FilingPacketBlocker = {
  code: string;
  severity: "blocker" | "warn";
  message: string;
  source_check: string;
};

export type FilingPacketValidationResult = {
  schema_version: typeof CLAIM_FILING_PACKET_VALIDATION_SCHEMA_VERSION;
  validated_at: string;
  does_not_submit: true;
  draft_id: string;
  organization_id: string;
  /** All checks are pass (warns allowed). */
  overall_valid: boolean;
  /** Integrity valid and existing filing readiness gate is ready. */
  ready_for_future_submission_layer: boolean;
  matrix: FilingPacketValidationCheck[];
  blocker_inventory: FilingPacketBlocker[];
  filing_readiness: FilingReadinessGate;
  packet_generated_at: string;
};

const LINEAGE_ANCHOR_EVENTS = new Set([
  "initial_snapshot",
  "financial_reference_seen",
  "trid_candidate_seen",
]);

function pushBlocker(
  inventory: FilingPacketBlocker[],
  check: FilingPacketValidationCheck,
  code: string,
  severity: FilingPacketBlocker["severity"],
  message: string,
): void {
  inventory.push({ code, severity, message, source_check: check.id });
}

function checkLineage(packet: ClaimFilingPacketPreview): FilingPacketValidationCheck[] {
  const checks: FilingPacketValidationCheck[] = [];
  const { claim_summary, lineage_links } = packet;
  const hasPersisted = claim_summary.persisted_edge_count > 0;

  const lineageCountOk =
    !hasPersisted ||
    (claim_summary.lineage_event_count > 0 && lineage_links.length > 0);
  checks.push({
    id: "lineage_events_present",
    category: "lineage",
    label: "Lineage events recorded",
    status: lineageCountOk ? "pass" : "fail",
    message: lineageCountOk
      ? `${claim_summary.lineage_event_count} lineage event(s) for generation.`
      : "Persisted edges exist but no lineage events on latest generation.",
  });

  const hasGeneration = claim_summary.generation_id != null;
  checks.push({
    id: "lineage_generation_linked",
    category: "lineage",
    label: "Generation linked",
    status: hasGeneration ? "pass" : hasPersisted ? "fail" : "warn",
    message: hasGeneration
      ? `generation_id ${claim_summary.generation_id}`
      : "No enrichment generation linked to persisted evidence.",
  });

  const eventTypes = new Set(lineage_links.map((l) => l.event_type));
  const hasAnchor = [...LINEAGE_ANCHOR_EVENTS].some((t) => eventTypes.has(t));
  checks.push({
    id: "lineage_anchor_event",
    category: "lineage",
    label: "Lineage anchor event",
    status: hasAnchor ? "pass" : hasPersisted ? "warn" : "pass",
    message: hasAnchor
      ? `Anchor event present (${[...eventTypes].filter((t) => LINEAGE_ANCHOR_EVENTS.has(t)).join(", ")}).`
      : "No initial_snapshot / financial_reference_seen / trid_candidate_seen in recent lineage sample.",
  });

  return checks;
}

function checkTrid(packet: ClaimFilingPacketPreview): FilingPacketValidationCheck[] {
  const checks: FilingPacketValidationCheck[] = [];
  const trids = packet.trid_references;
  const tridEdges = packet.evidence_groups
    .flatMap((g) => g.edges)
    .filter((e) => e.edge_type === "claim_to_trid" || e.reference_kind === "trid");

  const hasTridKeys = trids.filter((t) => t.trid_key.trim() !== "").length;
  checks.push({
    id: "trid_candidates_present",
    category: "trid",
    label: "TRID / reference candidates",
    status: hasTridKeys > 0 || tridEdges.length > 0 ? "pass" : "warn",
    message:
      hasTridKeys > 0
        ? `${hasTridKeys} TRID candidate(s) in packet.`
        : tridEdges.length > 0
          ? `${tridEdges.length} TRID edge(s) without preview TRID list.`
          : "No TRID candidates or claim_to_trid edges (may be valid for non-FRR drafts).",
  });

  const unlinked = trids.filter((t) => t.trid_key && t.linked_edge_ids.length === 0);
  checks.push({
    id: "trid_edge_linkage",
    category: "trid",
    label: "TRID edge linkage",
    status: unlinked.length === 0 ? "pass" : "warn",
    message:
      unlinked.length === 0
        ? "All TRID candidates link to persisted edges."
        : `${unlinked.length} TRID candidate(s) without linked persisted edge ids.`,
  });

  const missingKeys = trids.filter((t) => !t.trid_key.trim());
  checks.push({
    id: "trid_key_non_empty",
    category: "trid",
    label: "TRID keys non-empty",
    status: missingKeys.length === 0 ? "pass" : "fail",
    message:
      missingKeys.length === 0
        ? "All TRID entries have keys."
        : `${missingKeys.length} TRID row(s) with empty trid_key.`,
  });

  return checks;
}

function checkWarnings(packet: ClaimFilingPacketPreview): FilingPacketValidationCheck[] {
  const unresolved = packet.unresolved_warnings;
  const acked = packet.operator_state?.warnings_acknowledged_at != null;

  return [
    {
      id: "unresolved_warnings",
      category: "warnings",
      label: "Unresolved warnings",
      status: unresolved.length === 0 ? "pass" : acked ? "warn" : "fail",
      message:
        unresolved.length === 0
          ? "No actionable unresolved warnings."
          : acked
            ? `${unresolved.length} warning(s) acknowledged by operator.`
            : `${unresolved.length} actionable warning(s) require acknowledgement.`,
    },
  ];
}

function checkGrouping(packet: ClaimFilingPacketPreview): FilingPacketValidationCheck[] {
  const checks: FilingPacketValidationCheck[] = [];
  const groups = packet.evidence_groups;
  const persisted = packet.claim_summary.persisted_edge_count;
  const groupedTotal = groups.reduce((n, g) => n + g.edge_count, 0);

  checks.push({
    id: "evidence_groups_present",
    category: "grouping",
    label: "Evidence groups present",
    status: persisted === 0 ? "warn" : groups.length > 0 ? "pass" : "fail",
    message:
      groups.length > 0
        ? `${groups.length} evidence group(s).`
        : persisted > 0
          ? "Persisted edges exist but no groups returned."
          : "No persisted edges.",
  });

  checks.push({
    id: "evidence_group_count_match",
    category: "grouping",
    label: "Group edge count matches persisted total",
    status: groupedTotal === persisted ? "pass" : "fail",
    message:
      groupedTotal === persisted
        ? `${persisted} edges across groups.`
        : `Group sum ${groupedTotal} ≠ persisted count ${persisted}.`,
  });

  const groupsWithRejected = groups.filter((g) => g.review.rejected > 0);
  checks.push({
    id: "evidence_groups_no_rejected",
    category: "grouping",
    label: "No rejected edges in groups",
    status: groupsWithRejected.length === 0 ? "pass" : "fail",
    message:
      groupsWithRejected.length === 0
        ? "No rejected edges in any group."
        : `Rejected edges in: ${groupsWithRejected.map((g) => g.group_key).join(", ")}.`,
  });

  return checks;
}

function checkAttachments(packet: ClaimFilingPacketPreview): FilingPacketValidationCheck[] {
  const { claim_summary } = packet;
  const hasPersisted = claim_summary.persisted_edge_count > 0;

  const hashOk = claim_summary.evidence_hash != null && claim_summary.evidence_hash.length > 0;
  const edgesWithTargets = packet.evidence_groups
    .flatMap((g) => g.edges)
    .filter((e) => e.to_source_row_id.trim() !== "").length;
  const totalEdges = packet.evidence_groups.flatMap((g) => g.edges).length;

  return [
    {
      id: "attachment_evidence_hash",
      category: "attachments",
      label: "Evidence hash (generation fingerprint)",
      status: hashOk ? "pass" : hasPersisted ? "warn" : "pass",
      message: hashOk
        ? `evidence_hash present (${claim_summary.evidence_hash!.slice(0, 12)}…).`
        : "No evidence_hash on latest generation — packet export not fingerprinted.",
    },
    {
      id: "attachment_row_references",
      category: "attachments",
      label: "Edge row references",
      status:
        totalEdges === 0
          ? "warn"
          : edgesWithTargets === totalEdges
            ? "pass"
            : "fail",
      message:
        totalEdges === 0
          ? "No edges to validate."
          : `${edgesWithTargets}/${totalEdges} edges have to_source_row_id.`,
    },
    {
      id: "attachment_generation_status",
      category: "attachments",
      label: "Generation status",
      status: claim_summary.generation_status ? "pass" : hasPersisted ? "warn" : "pass",
      message: claim_summary.generation_status
        ? `status: ${claim_summary.generation_status}`
        : "Generation status missing on enrichment row.",
    },
  ];
}

function checkOperatorReview(packet: ClaimFilingPacketPreview): FilingPacketValidationCheck[] {
  const rs = packet.filing_readiness.review_summary;
  const checks: FilingPacketValidationCheck[] = [];

  checks.push({
    id: "operator_all_reviewed",
    category: "operator_review",
    label: "All edges reviewed",
    status: rs.total > 0 && rs.needs_review === 0 ? "pass" : rs.total === 0 ? "fail" : "fail",
    message:
      rs.needs_review === 0 && rs.total > 0
        ? `All ${rs.total} edges have operator status (none needs_review).`
        : `${rs.needs_review} of ${rs.total} edge(s) still need review.`,
  });

  checks.push({
    id: "operator_no_rejected",
    category: "operator_review",
    label: "No rejected edges",
    status: rs.rejected === 0 ? "pass" : "fail",
    message:
      rs.rejected === 0 ? "No operator-rejected edges." : `${rs.rejected} edge(s) rejected.`,
  });

  checks.push({
    id: "operator_acceptance_coverage",
    category: "operator_review",
    label: "Accepted edge coverage",
    status: rs.accepted === rs.total && rs.total > 0 ? "pass" : rs.total === 0 ? "fail" : "warn",
    message: `${rs.accepted} accepted · ${rs.rejected} rejected · ${rs.needs_review} needs review (total ${rs.total}).`,
  });

  return checks;
}

function checkFilingGate(packet: ClaimFilingPacketPreview): FilingPacketValidationCheck[] {
  const g = packet.filing_readiness;
  return [
    {
      id: "filing_readiness_gate",
      category: "filing_gate",
      label: "Filing readiness gate (08)",
      status: g.ready ? "pass" : "fail",
      message: g.ready
        ? "Filing readiness gate passes."
        : `Gate blocked: ${g.blockers.join(", ") || "unknown"}.`,
    },
  ];
}

export function validateClaimFilingPacket(
  packet: ClaimFilingPacketPreview,
): FilingPacketValidationResult {
  const matrix: FilingPacketValidationCheck[] = [
    ...checkLineage(packet),
    ...checkTrid(packet),
    ...checkWarnings(packet),
    ...checkGrouping(packet),
    ...checkAttachments(packet),
    ...checkOperatorReview(packet),
    ...checkFilingGate(packet),
  ];

  const blocker_inventory: FilingPacketBlocker[] = [];
  for (const check of matrix) {
    if (check.status === "fail") {
      pushBlocker(blocker_inventory, check, check.id, "blocker", check.message);
    } else if (check.status === "warn") {
      pushBlocker(blocker_inventory, check, `${check.id}_warn`, "warn", check.message);
    }
  }

  const overall_valid = matrix.every((c) => c.status !== "fail");
  const ready_for_future_submission_layer = overall_valid && packet.filing_readiness.ready;

  return {
    schema_version: CLAIM_FILING_PACKET_VALIDATION_SCHEMA_VERSION,
    validated_at: new Date().toISOString(),
    does_not_submit: true,
    draft_id: packet.draft_id,
    organization_id: packet.organization_id,
    overall_valid,
    ready_for_future_submission_layer,
    matrix,
    blocker_inventory,
    filing_readiness: packet.filing_readiness,
    packet_generated_at: packet.generated_at,
  };
}

export async function buildClaimFilingPacketValidation(
  client: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
): Promise<FilingPacketValidationResult> {
  const packet = await buildClaimFilingPacketPreview(client, draft, { logView: undefined });
  return validateClaimFilingPacket(packet);
}
