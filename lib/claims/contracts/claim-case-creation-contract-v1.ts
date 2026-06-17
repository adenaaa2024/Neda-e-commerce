/**
 * PHASE-CLAIM-CASE-CREATION-CONTRACT-V1
 * Read-only planning contract: claim_candidates → claim_cases bridge (not implemented).
 * No DB writes. No case creation in this phase.
 */
import type { ClaimEvidencePacketV1 } from "@/lib/claims/evidence/claim-evidence-packet-v1";
import { APPROVED_EMIT_V3_FAMILIES } from "@/lib/claims/contracts/claim-candidate-emit-approval-contract-v1";
import { GROUPING_MODES } from "@/lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "@/lib/claims/evidence/claim-evidence-packet-v1-plan-contract";

export const CLAIM_CASE_CREATION_CONTRACT_VERSION = "claim-case-creation-contract-v1" as const;

export const PILOT_CASE_CREATION_INTAKE_RUN_ID = ORIGINAL_PILOT_INTAKE_RUN_ID;

/** V3 families approved for Wave-1 pilot case creation (matches emit approval). */
export const CASE_CREATION_APPROVED_FAMILIES = [...APPROVED_EMIT_V3_FAMILIES] as const;

export type CaseCreationApprovedFamily = (typeof CASE_CREATION_APPROVED_FAMILIES)[number];

/** Families that may preview but must NOT create cases in Wave-1. */
export const CASE_CREATION_PREVIEW_ONLY_FAMILIES = [
  "physical_return_scanner_issue",
  "partial_incorrect_reimbursement",
] as const;

export const ELIGIBLE_CANDIDATE_RULES = {
  approved_families_only: CASE_CREATION_APPROVED_FAMILIES,
  active_pool: {
    quarantined_at: "must be null",
    rejected_at: "must be null",
    superseded_by_candidate_id: "must be null",
    source_kind: "must not be legacy_seed",
  },
  candidate_status: ["detected", "reviewed_ready"] as const,
  date_gate_passed: true,
  source_event_date: "required (metadata.source_event_date or event_date)",
  quantity: "clean_quantity only; disputed EP rows excluded",
  evidence_packet: {
    composed: true,
    readiness_ready_for_case_creation: "yes",
    operator_reviewed_packet: "required attestation (UI flag — not auto on preview load)",
  },
  intake_run_scope: `pilot rows scoped to ${PILOT_CASE_CREATION_INTAKE_RUN_ID} for Wave-1`,
} as const;

export const INELIGIBLE_CANDIDATE_RULES = {
  preview_recommended_action: ["needs_review", "unavailable"],
  preview_only_families: CASE_CREATION_PREVIEW_ONLY_FAMILIES,
  physical_return_scanner_issue: "scanner-origin families — separate promote path",
  partial_incorrect_reimbursement: "financial spine incomplete — preview only",
  lifecycle: ["quarantined", "superseded", "rejected", "legacy_seed"],
  date: ["missing_source_event_date", "pre_cutoff", "date_gate_failed"],
  source: ["disputed_expected_package_row", "missing_source_edges", "missing_reference_edges"],
  identity: ["identity_conflict", "ambiguous_product_link_without_exception"],
  evidence: ["missing_evidence_summary"],
  packet_blockers: "any blocker_flags on evidence packet V1",
} as const;

export const EVIDENCE_RULES = {
  evidence_status_missing: {
    auto_create_allowed: false,
    pilot_exception:
      "missing_photo_evidence warning only for removal/API families — does not block case creation preview when structural readiness passes",
  },
  missing_fee: { role: "warning", blocker_unless_policy: false },
  missing_cost: { role: "warning", blocker_unless_policy: false },
  missing_photo_evidence: {
    role: "warning",
    families: ["removal_shipment_missing", "removal_order_discrepancy"],
    blocker_for_removal_api_emit: false,
  },
  ai_amazon_facing_text: "forbidden — use metadata.evidence_summary human/internal only",
  human_evidence_summary: "allowed from claim_candidates.metadata.evidence_summary",
  evidence_status_transition:
    "missing → partial requires explicit evidence attach bridge before submission (not preview alone)",
} as const;

export const GROUPING_RULES = {
  default_mode: "single_candidate_one_case" as const,
  supported_modes: GROUPING_MODES,
  one_case_per_source_event_key: {
    default: true,
    idempotency_scope: "organization_id + store_id + source_event_key + claim_family",
  },
  group_by_tracking_removal_shipment_reference: {
    allowed: true,
    requires: "grouping_confirmation_resolved === true",
  },
  mixed_family_groups: { allowed: false, requires: "explicit confirmMixed + policy approval" },
  mixed_product_groups: { allowed: false, requires: "explicit confirmMixed + policy approval" },
  manual_grouping: {
    must_preserve: "included_candidate_ids[] in case metadata and line grain",
    defer_until: "operator confirms manual batch preview",
  },
} as const;

export const CASE_SCHEMA_PLAN = {
  tables: {
    header: "claim_cases",
    lines: "claim_lines",
    evidence: "claim_evidence (deferred until evidence attach bridge)",
    events: "claim_case_events (case_opened audit)",
    submissions: "claim_submissions (deferred — promote bridge only after case exists)",
  },
  claim_cases_required: {
    organization_id: "uuid NOT NULL",
    store_id: "uuid",
    claim_source: "delayed_not_received for pilot financial emit (maps source_kind)",
    claim_subtype: "family_key_v3 (removal_shipment_missing | removal_order_discrepancy)",
    status: "open (initial)",
    priority: "normal",
    idempotency_key: "see duplicate_prevention_contract",
    metadata: [
      "candidate_ids",
      "intake_run_id",
      "family_key_v3",
      "claim_family",
      "source_event_key",
      "evidence_packet_snapshot",
      "grouping_mode",
      "grouping_confirmation_resolved",
      "operator_reviewed_at",
      "operator_reviewed_by",
      "money_lanes",
      "pilot_wave",
    ],
    primary_resolved_product_id: "from packet product_identity.product_id",
    primary_order_id: "from source_event_key when order-scoped",
    primary_sku: "from packet sku",
    opened_by: "operator profile id",
  },
  claim_lines_required: {
    organization_id: "uuid NOT NULL",
    store_id: "uuid",
    claim_case_id: "FK after case insert",
    claim_candidate_id: "uuid — anchor to pool row",
    source_table: "from candidate",
    source_row_id: "from candidate",
    expected_package_id: "when source_table=expected_packages",
    resolved_product_id: "from candidate",
    sku: "from candidate",
    fnsku: "from candidate",
    asin: "from candidate",
    quantity_expected: "clean_quantity from packet",
    status: "claim_ready (initial line status)",
    idempotency_key: "cc:line:candidate:{candidate_id}",
    metadata: ["family_key_v3", "evidence_summary", "reference_edges"],
  },
  audit_fields: {
    created_at: "default now()",
    updated_at: "trigger",
    claim_case_events: "case_opened payload with candidate_ids + packet_id",
  },
} as const;

export const CANDIDATE_TO_CASE_MAPPING = {
  default_grain: "1 candidate → 1 claim_case → 1 claim_line",
  grouped_grain: "N candidates (same source_event_key + confirmed group) → 1 claim_case → N claim_lines",
  pilot_wave1: "50 candidates → 50 cases (single_candidate_one_case) unless operator groups with confirmation",
  claim_source_map: {
    delayed_not_received: "claim_cases.claim_source = delayed_not_received",
    removal_shipment_missing: "claim_subtype = removal_shipment_missing; claim_family maps shipment_not_received",
    removal_order_discrepancy: "claim_subtype = removal_order_discrepancy; claim_family maps shipment_quantity_mismatch",
  },
  amounts_quantities: {
    quantity: "packet.quantity.clean_quantity on claim_lines.quantity_expected",
    money: "NULL lanes preserved on case.metadata.money_lanes — never coerced",
  },
} as const;

export const DUPLICATE_PREVENTION_CONTRACT = {
  case_natural_key: "organization_id + store_id + source_event_key + claim_family",
  case_idempotency_key_format: "cc:pool:v1:{organization_id}:{store_id}:{source_event_key}:{claim_family}",
  line_idempotency_key_format: "cc:line:candidate:{candidate_id}",
  candidate_single_active_case:
    "candidate_id may attach to at most one active claim_case (status not in closed|rejected|superseded)",
  dedupe_key_alignment: "reuse claim_candidates.dedupe_key context in metadata; do not collide with emit dedupe",
  existing_unique_indexes: [
    "claim_cases.idempotency_key UNIQUE",
    "claim_lines.idempotency_key UNIQUE",
    "uq_claim_candidates_dedupe_key (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL",
  ],
  on_conflict: "ON CONFLICT (idempotency_key) DO NOTHING — return existing case id",
} as const;

export const ROLLBACK_CONTRACT = {
  hard_delete: "forbidden",
  case_cancel: "status → closed; status_reason → operator_cancelled | pilot_rollback",
  case_supersede: "metadata.superseded_at + superseded_by_case_id when replanning",
  candidate_detach: "only via explicit rollback action — never auto on preview",
  legacy_seed: "never revive legacy_seed rows",
  claim_candidates_on_rollback: "do not mutate candidate_status on case cancel unless explicit detach bridge",
  audit: "claim_case_events case_closed with rollback payload",
} as const;

export const UI_PREREQUISITES = {
  evidence_packet_review: "operator must open Preview evidence packet and attest review (future flag)",
  approve_reject: "remain disabled until Maysam-approved bridge phase",
  create_case_button: "remain disabled until PHASE-CLAIM-CASE-CREATION-PREVIEW-V1 implements dry-run",
  submit_pdf: "remain disabled",
  pilot_surface: "/claim-center/pilot-review detail drawer",
} as const;

export const APPROVAL_REQUIRED = {
  maysam_signoff: true,
  gates: [
    "SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED=yes",
    "SAFE_TO_REVIEW_EVIDENCE_PACKET_UI=yes",
    "SAFE_TO_BUILD_CASE_CREATION_PREVIEW=yes (this phase)",
    "SAFE_TO_APPLY_CASE_CREATION_PILOT=no until controlled pilot after preview dry-run",
  ],
  bridge_scaffold: "PHASE-CLAIM-CANDIDATE-CASE-SUBMISSION-BRIDGE-01 (future)",
} as const;

export const NEXT_PHASE_PLAN = {
  phase_1: "PHASE-CLAIM-CASE-CREATION-PREVIEW-V1 — dry-run compose case payloads; no DB INSERT",
  phase_2: "PHASE-CLAIM-CASE-CREATION-PILOT-V1 — controlled INSERT after Maysam approval on original pilot only",
  phase_3: "PHASE-CLAIM-CASE-SUBMISSION-BRIDGE — reuse claim-case-promote-submission.ts (separate track)",
  forbidden_in_preview: ["claim_submissions INSERT", "PDF generation", "Amazon submit"],
} as const;

export const MIGRATION_NEEDED = {
  answer: "no" as const,
  rationale:
    "Original DB already has claim_cases (2 rows) and claim_lines with claim_candidate_id; pilot uses metadata JSONB + idempotency_key patterns — no new columns required for preview dry-run",
  optional_future:
    "Dedicated partial index on claim_lines(claim_candidate_id) WHERE claim_candidate_id IS NOT NULL if performance requires",
} as const;

export const RISK_NOTES = [
  "50/50 pilot rows have evidence_status=missing — contract allows case preview with missing_photo_evidence warning only",
  "Money lanes NULL on all 50 — case metadata must preserve NULL; UI must not display $0 as recovery",
  "source_event_key collision could merge candidates — default single_candidate_one_case avoids accidental grouping",
  "claim_cases.claim_source CHECK must include delayed_not_received (verified in foundation migration)",
  "No candidate→case bridge code exists yet — scanner and returns-manual paths are separate",
  "Operator review attestation not persisted — preview load alone must not flip eligibility",
] as const;

export type CaseCreationEligibilityInput = {
  packet: ClaimEvidencePacketV1;
  candidate_status: string | null;
  evidence_status: string | null;
  quarantined_at: string | null;
  rejected_at: string | null;
  source_kind: string | null;
  operator_reviewed_packet?: boolean;
};

export type CaseCreationEligibilityResult = {
  eligible: boolean;
  structural_ready: boolean;
  operator_review_satisfied: boolean;
  blockers: string[];
  warnings: string[];
};

export function buildCaseIdempotencyKey(args: {
  organizationId: string;
  storeId: string;
  sourceEventKey: string;
  claimFamily: string;
}): string {
  return `cc:pool:v1:${args.organizationId}:${args.storeId}:${args.sourceEventKey}:${args.claimFamily}`;
}

export function buildLineIdempotencyKey(candidateId: string): string {
  return `cc:line:candidate:${candidateId}`;
}

export function evaluateCaseCreationEligibility(
  input: CaseCreationEligibilityInput,
): CaseCreationEligibilityResult {
  const blockers: string[] = [];
  const warnings: string[] = [...input.packet.review_flags];

  const family = input.packet.family_key_v3;
  if (!family || !CASE_CREATION_APPROVED_FAMILIES.includes(family as CaseCreationApprovedFamily)) {
    blockers.push("family_not_approved");
  }
  if (input.quarantined_at) blockers.push("quarantined");
  if (input.rejected_at) blockers.push("rejected");
  if (input.source_kind === "legacy_seed") blockers.push("legacy_seed");
  const status = (input.candidate_status ?? "").trim();
  if (status && status !== "detected" && status !== "reviewed_ready") {
    blockers.push(`candidate_status_${status}`);
  }
  if (!input.packet.date_gate.date_gate_passed) blockers.push("date_gate_failed");
  if (!input.packet.date_gate.source_event_date) blockers.push("missing_source_event_date");
  if (input.packet.date_gate.pre_cutoff) blockers.push("pre_cutoff");
  if (input.packet.source_edges.length === 0) blockers.push("missing_source_edges");
  if (input.packet.reference_edges.length === 0) blockers.push("missing_reference_edges");
  if (!input.packet.evidence_summary) blockers.push("missing_evidence_summary");
  if (input.packet.quantity.disputed_context) blockers.push("disputed_source_row");
  if (input.packet.readiness.ready_for_case_creation !== "yes") {
    blockers.push(...input.packet.readiness.blockers);
    for (const b of input.packet.blocker_flags) {
      if (!blockers.includes(b)) blockers.push(b);
    }
  }

  if (
    input.packet.product_identity.linkage_status === "unlinked" ||
    input.packet.product_identity.linkage_status === "ambiguous"
  ) {
    warnings.push("missing_product_link");
  }

  if (input.evidence_status === "missing") {
    warnings.push("evidence_status_missing");
  }

  const structuralBlockers = [...new Set(blockers)];
  const structural_ready = structuralBlockers.length === 0;
  const operatorReviewSatisfied = input.operator_reviewed_packet === true;
  const allBlockers = operatorReviewSatisfied
    ? structuralBlockers
    : [...structuralBlockers, "operator_review_pending"];

  const eligible = structural_ready && operatorReviewSatisfied;

  return {
    eligible,
    structural_ready,
    operator_review_satisfied: operatorReviewSatisfied,
    blockers: [...new Set(allBlockers)],
    warnings: [...new Set(warnings)],
  };
}

export function summarizeCaseCreationDryRun(packets: ClaimEvidencePacketV1[]): {
  total: number;
  structural_ready_count: number;
  operator_review_pending_count: number;
  fully_eligible_count: number;
  by_family: Record<string, number>;
  blocker_counts: Record<string, number>;
} {
  const by_family: Record<string, number> = {};
  const blocker_counts: Record<string, number> = {};
  let structural = 0;
  let operatorPending = 0;
  let fullyEligible = 0;

  for (const p of packets) {
    const fam = p.family_key_v3 ?? "unknown";
    by_family[fam] = (by_family[fam] ?? 0) + 1;
    const r = evaluateCaseCreationEligibility({
      packet: p,
      candidate_status: "detected",
      evidence_status: "missing",
      quarantined_at: null,
      rejected_at: null,
      source_kind: p.source_kind,
      operator_reviewed_packet: false,
    });
    if (r.structural_ready) structural += 1;
    if (!r.operator_review_satisfied) operatorPending += 1;
    if (r.eligible) fullyEligible += 1;
    for (const b of r.blockers) blocker_counts[b] = (blocker_counts[b] ?? 0) + 1;
  }

  return {
    total: packets.length,
    structural_ready_count: structural,
    operator_review_pending_count: operatorPending,
    fully_eligible_count: fullyEligible,
    by_family,
    blocker_counts,
  };
}
