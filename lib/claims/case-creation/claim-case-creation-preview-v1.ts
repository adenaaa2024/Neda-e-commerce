/**
 * PHASE-CLAIM-CASE-CREATION-PREVIEW-V1
 * Read-only case creation preview from evidence packets + contract rules.
 * No DB writes. No claim_cases / claim_lines / submissions INSERT.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildCaseIdempotencyKey,
  buildLineIdempotencyKey,
  evaluateCaseCreationEligibility,
  GROUPING_RULES,
} from "@/lib/claims/contracts/claim-case-creation-contract-v1";
import {
  composeClaimEvidencePacketV1,
  type ClaimEvidencePacketV1,
  type EvidencePacketV1Readiness,
} from "@/lib/claims/evidence/claim-evidence-packet-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "@/lib/claims/evidence/claim-evidence-packet-v1-plan-contract";

export const CLAIM_CASE_CREATION_PREVIEW_V1_VERSION = "claim-case-creation-preview-v1" as const;

export type CaseCreationRecommendedAction =
  | "create_case_preview_ready"
  | "needs_operator_review"
  | "blocked";

export const CASE_PREVIEW_SHAPE = [
  "case_preview_id",
  "proposed_case_type",
  "proposed_case_family",
  "source_event_key",
  "included_candidate_ids",
  "family_key_v3",
  "claim_family",
  "source_kind",
  "product_identifiers",
  "clean_quantity",
  "estimated_amount",
  "recovery_value",
  "observed_reimbursement",
  "money_warnings",
  "evidence_packet_readiness",
  "warnings",
  "blockers",
  "duplicate_risk",
  "recommended_action",
  "grouping_mode",
  "case_idempotency_key",
] as const;

const ACTIVE_CASE_STATUSES = new Set(["open", "investigating", "waiting_amazon"]);

const MONEY_WARNING_FLAGS = new Set([
  "missing_fee",
  "missing_cost",
  "fee_payout_unavailable",
  "cost_unavailable",
  "missing_reimbursement_lane",
]);

export type ClaimCasePreviewV1ProductIdentifiers = {
  product_id: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  linkage_status: string;
};

export type ClaimCasePreviewV1DuplicateRisk = {
  has_risk: boolean;
  reasons: string[];
  existing_case_id: string | null;
  existing_case_status: string | null;
};

export type ClaimCasePreviewV1 = {
  case_preview_id: string;
  proposed_case_type: string;
  proposed_case_family: string;
  source_event_key: string | null;
  included_candidate_ids: string[];
  family_key_v3: string | null;
  claim_family: string | null;
  source_kind: string | null;
  product_identifiers: ClaimCasePreviewV1ProductIdentifiers;
  clean_quantity: number | null;
  estimated_amount: number | null;
  recovery_value: number | null;
  observed_reimbursement: number | null;
  money_warnings: string[];
  evidence_packet_readiness: EvidencePacketV1Readiness;
  warnings: string[];
  blockers: string[];
  duplicate_risk: ClaimCasePreviewV1DuplicateRisk;
  recommended_action: CaseCreationRecommendedAction;
  grouping_mode: typeof GROUPING_RULES.default_mode;
  case_idempotency_key: string;
  line_idempotency_keys: string[];
};

export type ClaimCasePreviewCandidateEvaluation = {
  candidate_id: string;
  family_key_v3: string | null;
  recommended_action: CaseCreationRecommendedAction;
  structural_ready: boolean;
  operator_review_satisfied: boolean;
  duplicate_risk: boolean;
  blockers: string[];
  warnings: string[];
  case_preview: ClaimCasePreviewV1 | null;
};

export type ClaimCaseCreationPreviewV1Summary = {
  evaluated_candidate_count: number;
  eligible_candidate_count: number;
  proposed_case_count: number;
  needs_operator_review_count: number;
  blocked_count: number;
  duplicate_risk_count: number;
  family_distribution: Record<string, number>;
  warning_counts: Record<string, number>;
  blocker_counts: Record<string, number>;
  grouping_mode: typeof GROUPING_RULES.default_mode;
  proposed_grouping_summary: {
    mode: string;
    single_candidate_cases: number;
    grouped_cases: number;
    candidates_per_case_avg: number;
  };
};

export type ClaimCaseCreationPreviewV1Payload = {
  version: typeof CLAIM_CASE_CREATION_PREVIEW_V1_VERSION;
  read_only: true;
  intake_run_id: string;
  grouping_mode: typeof GROUPING_RULES.default_mode;
  evaluations: ClaimCasePreviewCandidateEvaluation[];
  case_previews: ClaimCasePreviewV1[];
  summary: ClaimCaseCreationPreviewV1Summary;
};

export type ComposeCaseCreationPreviewV1Query = {
  intake_run_id?: string | null;
  limit?: number;
  /** When set, only these candidate IDs are evaluated (pilot bulk selected mode). */
  candidate_ids?: string[];
  /** Simulated operator attestation — does not persist. */
  operator_reviewed_candidate_ids?: string[];
  /** Include case preview even when duplicate risk (pilot idempotent re-execute). */
  force_case_preview_candidate_ids?: string[];
};

type DuplicateIndex = {
  byIdempotencyKey: Map<string, { id: string; status: string }>;
  byCandidateId: Map<string, { case_id: string; status: string }>;
};

function buildCasePreviewId(candidateId: string): string {
  return `ccp:v1:${candidateId}`;
}

function buildMoneyWarnings(packet: ClaimEvidencePacketV1): string[] {
  const warnings: string[] = [];
  for (const flag of packet.review_flags) {
    if (MONEY_WARNING_FLAGS.has(flag)) warnings.push(flag);
  }
  const m = packet.money_lanes;
  if (m.estimated_amazon_payout == null && !warnings.includes("missing_fee")) {
    warnings.push("missing_fee");
  }
  if (m.internal_cost_loss == null && !warnings.includes("missing_cost")) {
    warnings.push("missing_cost");
  }
  if (m.observed_reimbursement == null) warnings.push("missing_observed_reimbursement");
  if (m.recovery_value == null) warnings.push("missing_recovery_value");
  return [...new Set(warnings)];
}

function assessDuplicateRisk(
  packet: ClaimEvidencePacketV1,
  organizationId: string,
  storeId: string,
  index: DuplicateIndex,
): ClaimCasePreviewV1DuplicateRisk {
  const reasons: string[] = [];
  let existingCaseId: string | null = null;
  let existingCaseStatus: string | null = null;

  const caseKey = buildCaseIdempotencyKey({
    organizationId,
    storeId,
    sourceEventKey: packet.source_event_key ?? "",
    claimFamily: packet.claim_family ?? "",
  });
  const existingByKey = index.byIdempotencyKey.get(caseKey);
  if (existingByKey && ACTIVE_CASE_STATUSES.has(existingByKey.status)) {
    reasons.push("active_case_idempotency_collision");
    existingCaseId = existingByKey.id;
    existingCaseStatus = existingByKey.status;
  }

  const existingByCandidate = index.byCandidateId.get(packet.candidate_id);
  if (existingByCandidate && ACTIVE_CASE_STATUSES.has(existingByCandidate.status)) {
    reasons.push("candidate_already_on_active_case");
    if (!existingCaseId) {
      existingCaseId = existingByCandidate.case_id;
      existingCaseStatus = existingByCandidate.status;
    }
  }

  return {
    has_risk: reasons.length > 0,
    reasons,
    existing_case_id: existingCaseId,
    existing_case_status: existingCaseStatus,
  };
}

function resolveRecommendedAction(args: {
  structural_ready: boolean;
  operator_review_satisfied: boolean;
  duplicate_risk: boolean;
}): CaseCreationRecommendedAction {
  if (!args.structural_ready || args.duplicate_risk) return "blocked";
  if (!args.operator_review_satisfied) return "needs_operator_review";
  return "create_case_preview_ready";
}

function buildCasePreview(
  packet: ClaimEvidencePacketV1,
  organizationId: string,
  storeId: string,
  duplicate: ClaimCasePreviewV1DuplicateRisk,
  eligibility: ReturnType<typeof evaluateCaseCreationEligibility>,
  recommended_action: CaseCreationRecommendedAction,
): ClaimCasePreviewV1 {
  const caseKey = buildCaseIdempotencyKey({
    organizationId,
    storeId,
    sourceEventKey: packet.source_event_key ?? "",
    claimFamily: packet.claim_family ?? "",
  });

  return {
    case_preview_id: buildCasePreviewId(packet.candidate_id),
    proposed_case_type: "delayed_not_received",
    proposed_case_family: packet.claim_family ?? "unknown",
    source_event_key: packet.source_event_key,
    included_candidate_ids: [packet.candidate_id],
    family_key_v3: packet.family_key_v3,
    claim_family: packet.claim_family,
    source_kind: packet.source_kind,
    product_identifiers: {
      product_id: packet.product_identity.product_id,
      asin: packet.product_identity.asin,
      fnsku: packet.product_identity.fnsku,
      sku: packet.product_identity.sku,
      linkage_status: packet.product_identity.linkage_status,
    },
    clean_quantity: packet.quantity.clean_quantity,
    estimated_amount: packet.money_lanes.expected_amount ?? packet.money_lanes.estimated_amazon_payout,
    recovery_value: packet.money_lanes.recovery_value,
    observed_reimbursement: packet.money_lanes.observed_reimbursement,
    money_warnings: buildMoneyWarnings(packet),
    evidence_packet_readiness: packet.readiness,
    warnings: eligibility.warnings,
    blockers: eligibility.blockers,
    duplicate_risk: duplicate,
    recommended_action,
    grouping_mode: GROUPING_RULES.default_mode,
    case_idempotency_key: caseKey,
    line_idempotency_keys: [buildLineIdempotencyKey(packet.candidate_id)],
  };
}

async function loadDuplicateIndex(
  client: SupabaseClient,
  organizationId: string,
  packets: ClaimEvidencePacketV1[],
  storeId: string,
): Promise<DuplicateIndex> {
  const byIdempotencyKey = new Map<string, { id: string; status: string }>();
  const byCandidateId = new Map<string, { case_id: string; status: string }>();

  const keys = [
    ...new Set(
      packets.map((p) =>
        buildCaseIdempotencyKey({
          organizationId,
          storeId,
          sourceEventKey: p.source_event_key ?? "",
          claimFamily: p.claim_family ?? "",
        }),
      ),
    ),
  ];

  if (keys.length > 0) {
    const { data: cases } = await client
      .from("claim_cases")
      .select("id, idempotency_key, status")
      .eq("organization_id", organizationId)
      .in("idempotency_key", keys);
    for (const row of cases ?? []) {
      const key = String(row.idempotency_key ?? "");
      if (key) byIdempotencyKey.set(key, { id: String(row.id), status: String(row.status) });
    }
  }

  const candidateIds = packets.map((p) => p.candidate_id);
  if (candidateIds.length > 0) {
    const { data: lines } = await client
      .from("claim_lines")
      .select("claim_candidate_id, claim_case_id, claim_cases!inner(id, status)")
      .eq("organization_id", organizationId)
      .in("claim_candidate_id", candidateIds)
      .not("claim_case_id", "is", null);

    for (const row of lines ?? []) {
      const candidateId = String(row.claim_candidate_id ?? "");
      const caseJoin = row.claim_cases as { id: string; status: string } | { id: string; status: string }[] | null;
      const caseRow = Array.isArray(caseJoin) ? caseJoin[0] : caseJoin;
      if (!candidateId || !caseRow?.id) continue;
      byCandidateId.set(candidateId, { case_id: String(caseRow.id), status: String(caseRow.status) });
    }
  }

  return { byIdempotencyKey, byCandidateId };
}

function summarizePreview(
  evaluations: ClaimCasePreviewCandidateEvaluation[],
  casePreviews: ClaimCasePreviewV1[],
): ClaimCaseCreationPreviewV1Summary {
  const family_distribution: Record<string, number> = {};
  const warning_counts: Record<string, number> = {};
  const blocker_counts: Record<string, number> = {};

  let eligible = 0;
  let needsReview = 0;
  let blocked = 0;
  let duplicateRisk = 0;

  for (const ev of evaluations) {
    const fam = ev.family_key_v3 ?? "unknown";
    family_distribution[fam] = (family_distribution[fam] ?? 0) + 1;
    if (ev.recommended_action === "create_case_preview_ready") eligible += 1;
    if (ev.recommended_action === "needs_operator_review") needsReview += 1;
    if (ev.recommended_action === "blocked") blocked += 1;
    if (ev.duplicate_risk) duplicateRisk += 1;
    for (const w of ev.warnings) warning_counts[w] = (warning_counts[w] ?? 0) + 1;
    for (const b of ev.blockers) blocker_counts[b] = (blocker_counts[b] ?? 0) + 1;
  }

  const proposed_case_count = casePreviews.length;

  return {
    evaluated_candidate_count: evaluations.length,
    eligible_candidate_count: eligible,
    proposed_case_count,
    needs_operator_review_count: needsReview,
    blocked_count: blocked,
    duplicate_risk_count: duplicateRisk,
    family_distribution,
    warning_counts,
    blocker_counts,
    grouping_mode: GROUPING_RULES.default_mode,
    proposed_grouping_summary: {
      mode: GROUPING_RULES.default_mode,
      single_candidate_cases: casePreviews.length,
      grouped_cases: 0,
      candidates_per_case_avg:
        casePreviews.length > 0 ? evaluations.length / casePreviews.length : 0,
    },
  };
}

export async function composeClaimCaseCreationPreviewV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  query: ComposeCaseCreationPreviewV1Query = {},
): Promise<ClaimCaseCreationPreviewV1Payload> {
  const intakeRunId = (query.intake_run_id?.trim() || ORIGINAL_PILOT_INTAKE_RUN_ID) as string;
  const operatorReviewed = new Set(query.operator_reviewed_candidate_ids ?? []);
  const forcePreview = new Set(query.force_case_preview_candidate_ids ?? []);

  const packetPayload = await composeClaimEvidencePacketV1(client, organizationId, storeId, {
    intake_run_id: intakeRunId,
    limit: query.limit ?? 50,
  });

  const candidateFilter = query.candidate_ids?.length
    ? new Set(query.candidate_ids.map((id) => id.trim()).filter(Boolean))
    : null;
  const packets = [...packetPayload.packets];
  if (candidateFilter) {
    const present = new Set(packets.map((p) => p.candidate_id));
    for (const cid of candidateFilter) {
      if (present.has(cid)) continue;
      const extra = await composeClaimEvidencePacketV1(client, organizationId, storeId, {
        intake_run_id: intakeRunId,
        candidate_id: cid,
        limit: 1,
      });
      const packet = extra.packets[0];
      if (packet) packets.push(packet);
    }
  }
  const filteredPackets = candidateFilter
    ? packets.filter((p) => candidateFilter.has(p.candidate_id))
    : packets;

  const duplicateIndex = await loadDuplicateIndex(
    client,
    organizationId,
    filteredPackets,
    storeId,
  );

  const evaluations: ClaimCasePreviewCandidateEvaluation[] = [];
  const casePreviews: ClaimCasePreviewV1[] = [];

  for (const packet of filteredPackets) {
    const eligibility = evaluateCaseCreationEligibility({
      packet,
      candidate_status: "detected",
      evidence_status: "missing",
      quarantined_at: null,
      rejected_at: null,
      source_kind: packet.source_kind,
      operator_reviewed_packet: operatorReviewed.has(packet.candidate_id),
    });

    const duplicate = assessDuplicateRisk(packet, organizationId, storeId, duplicateIndex);
    const duplicateBlocks = duplicate.has_risk;
    const recommended_action = resolveRecommendedAction({
      structural_ready: eligibility.structural_ready,
      operator_review_satisfied: eligibility.operator_review_satisfied,
      duplicate_risk: duplicateBlocks,
    });

    let case_preview: ClaimCasePreviewV1 | null = null;
    const forceInclude = forcePreview.has(packet.candidate_id);
    if (eligibility.structural_ready && (!duplicateBlocks || forceInclude)) {
      case_preview = buildCasePreview(
        packet,
        organizationId,
        storeId,
        duplicate,
        eligibility,
        recommended_action,
      );
      casePreviews.push(case_preview);
    }

    evaluations.push({
      candidate_id: packet.candidate_id,
      family_key_v3: packet.family_key_v3,
      recommended_action,
      structural_ready: eligibility.structural_ready,
      operator_review_satisfied: eligibility.operator_review_satisfied,
      duplicate_risk: duplicate.has_risk,
      blockers: eligibility.blockers,
      warnings: eligibility.warnings,
      case_preview,
    });
  }

  return {
    version: CLAIM_CASE_CREATION_PREVIEW_V1_VERSION,
    read_only: true,
    intake_run_id: intakeRunId,
    grouping_mode: GROUPING_RULES.default_mode,
    evaluations,
    case_previews: casePreviews,
    summary: summarizePreview(evaluations, casePreviews),
  };
}

export function sampleCasePreviewForReport(preview: ClaimCasePreviewV1) {
  return {
    case_preview_id: preview.case_preview_id,
    proposed_case_type: preview.proposed_case_type,
    proposed_case_family: preview.proposed_case_family,
    source_event_key: preview.source_event_key,
    included_candidate_ids: preview.included_candidate_ids,
    family_key_v3: preview.family_key_v3,
    claim_family: preview.claim_family,
    source_kind: preview.source_kind,
    product_identifiers: preview.product_identifiers,
    clean_quantity: preview.clean_quantity,
    estimated_amount: preview.estimated_amount,
    recovery_value: preview.recovery_value,
    observed_reimbursement: preview.observed_reimbursement,
    money_warnings: preview.money_warnings,
    evidence_packet_readiness: preview.evidence_packet_readiness,
    warnings: preview.warnings,
    blockers: preview.blockers,
    duplicate_risk: preview.duplicate_risk,
    recommended_action: preview.recommended_action,
    grouping_mode: preview.grouping_mode,
    case_idempotency_key: preview.case_idempotency_key,
  };
}
