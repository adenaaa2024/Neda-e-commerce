/**
 * Claim family algorithm matrix read-model — contract only, no DB writes.
 * PHASE-CLAIM-FAMILY-ALGORITHM-READMODEL-IMPLEMENT-V1
 */
import {
  CLAIM_ALGORITHM_HARD_RULES,
  CLAIM_FAMILY_ALGORITHM_MATRIX,
  CONFIDENCE_RULES,
  CREATE_CANDIDATE_VS_REVIEW_SIGNAL_RULES,
  DISPUTED_DATA_RULES,
  IMPLEMENTATION_PRIORITY_ORDER,
  type ClaimFamilyAlgorithmEntry,
  type ClaimFamilyAlgorithmKey,
  type ImplementationStatus,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v1";

export type ClaimFamilyAlgorithmApiEntry = {
  claim_family: ClaimFamilyAlgorithmKey;
  display_name: string;
  lifecycle_states: string[];
  support_status: ImplementationStatus;
  priority: ClaimFamilyAlgorithmEntry["implementation_priority"];
  quantity_formula: string;
  money_formula: {
    amount: string;
    expected_recovery: string;
    observed_reimbursement: string;
    actual_loss: string;
    cost_source: string;
    sale_price_display_only: boolean;
  };
  required_sources: string[];
  required_identifiers: string[];
  product_linkage_requirement: ClaimFamilyAlgorithmEntry["product_linkage_requirement"];
  TRID_edge_requirements: string[];
  evidence_requirements: string[];
  confidence_rules: ClaimFamilyAlgorithmEntry["confidence_levels"];
  create_candidate_vs_review_signal_rules: {
    create_candidate: string;
    review_signal_only: string;
    exclude: string;
  };
  blockers: string;
  implementation_next_step: string;
  existing_code_mapping: string | null;
  event_date: string;
  deadline_window: string;
  disputed_source_conflict_handling: string;
};

export type ClaimFamilyAlgorithmMatrixPayload = {
  read_only: true;
  no_db_writes: true;
  no_generator_implementation: true;
  generated_at: string;
  family_count: number;
  status_counts: Record<string, number>;
  hard_rules: readonly string[];
  disputed_data_rules: typeof DISPUTED_DATA_RULES;
  global_confidence_rules: typeof CONFIDENCE_RULES;
  global_create_candidate_vs_review_signal_rules: typeof CREATE_CANDIDATE_VS_REVIEW_SIGNAL_RULES;
  priority_order: readonly ClaimFamilyAlgorithmKey[];
  first_implement_order: readonly ClaimFamilyAlgorithmKey[];
  families: ClaimFamilyAlgorithmApiEntry[];
};

function mapEntry(entry: ClaimFamilyAlgorithmEntry): ClaimFamilyAlgorithmApiEntry {
  const nextStep =
    entry.current_implementation_status === "live"
      ? "Monitor generator output; no new implementation required."
      : entry.current_implementation_status === "partial"
        ? `Complete partial path: ${entry.missing_blocker}`
        : entry.current_implementation_status === "review_signal_only"
          ? `Keep review-signal only until evidence spine ready: ${entry.missing_blocker}`
          : `Implement generator/read-model (${entry.implementation_priority}): ${entry.missing_blocker}`;

  return {
    claim_family: entry.family_key,
    display_name: entry.display_name,
    lifecycle_states: [...entry.lifecycle_states],
    support_status: entry.current_implementation_status,
    priority: entry.implementation_priority,
    quantity_formula: entry.quantity_formula,
    money_formula: {
      amount: entry.amount_formula,
      expected_recovery: entry.expected_recovery_formula,
      observed_reimbursement: entry.observed_reimbursement_formula,
      actual_loss: entry.actual_loss_formula,
      cost_source: entry.cost_source_requirement,
      sale_price_display_only: entry.sale_price_display_only,
    },
    required_sources: [...entry.source_tables_files_api],
    required_identifiers: [...entry.required_identifiers],
    product_linkage_requirement: entry.product_linkage_requirement,
    TRID_edge_requirements: [...entry.trid_edges_required],
    evidence_requirements: [...entry.evidence_requirements],
    confidence_rules: { ...entry.confidence_levels },
    create_candidate_vs_review_signal_rules: {
      create_candidate: entry.when_create_candidate,
      review_signal_only: entry.when_review_signal_only,
      exclude: entry.when_exclude,
    },
    blockers: entry.missing_blocker,
    implementation_next_step: nextStep,
    existing_code_mapping: entry.existing_code_mapping,
    event_date: entry.event_date,
    deadline_window: entry.deadline_window,
    disputed_source_conflict_handling: entry.disputed_source_conflict_handling,
  };
}

function countByStatus(): Record<string, number> {
  const counts: Record<string, number> = {
    live: 0,
    partial: 0,
    gap: 0,
    review_signal_only: 0,
    planned: 0,
  };
  for (const entry of CLAIM_FAMILY_ALGORITHM_MATRIX) {
    counts[entry.current_implementation_status] =
      (counts[entry.current_implementation_status] ?? 0) + 1;
  }
  return counts;
}

/** Build read-only algorithm matrix payload (no DB). */
export function buildClaimFamilyAlgorithmMatrixPayload(): ClaimFamilyAlgorithmMatrixPayload {
  const order = new Map(IMPLEMENTATION_PRIORITY_ORDER.map((k, i) => [k, i]));
  const families = [...CLAIM_FAMILY_ALGORITHM_MATRIX]
    .sort((a, b) => (order.get(a.family_key) ?? 99) - (order.get(b.family_key) ?? 99))
    .map(mapEntry);

  return {
    read_only: true,
    no_db_writes: true,
    no_generator_implementation: true,
    generated_at: new Date().toISOString(),
    family_count: families.length,
    status_counts: countByStatus(),
    hard_rules: CLAIM_ALGORITHM_HARD_RULES,
    disputed_data_rules: DISPUTED_DATA_RULES,
    global_confidence_rules: CONFIDENCE_RULES,
    global_create_candidate_vs_review_signal_rules: CREATE_CANDIDATE_VS_REVIEW_SIGNAL_RULES,
    priority_order: IMPLEMENTATION_PRIORITY_ORDER,
    first_implement_order: IMPLEMENTATION_PRIORITY_ORDER.slice(0, 5),
    families,
  };
}
