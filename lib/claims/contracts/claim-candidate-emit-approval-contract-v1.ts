/**
 * PHASE-CLAIM-CANDIDATE-EMIT-APPROVAL-CONTRACT-V1
 * Read-only approval gate — defines when deterministic preview results may write
 * into claim_candidates. No DB writes. No emitter implementation in this phase.
 *
 * Prerequisite phase: PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1
 * Staging evidence: phase-claim-first-safe-families-preview-generators-v1/20260614T090000Z/
 * Grouping readmodel: phase-claim-grouping-filters-manual-batch-readmodel-v1/20260614T091500Z/
 */
import { FAMILY_EDGE_REQUIREMENTS } from "./trid-edge-requirements-contract-v1";

export const EMIT_CONTRACT_VERSION = "claim-candidate-emit-approval-v1" as const;

/** V3 family keys approved for Wave-1 trusted emit (after operator sign-off). */
export const APPROVED_EMIT_V3_FAMILIES = [
  "removal_shipment_missing",
  "removal_order_discrepancy",
] as const;

export type ApprovedEmitV3Family = (typeof APPROVED_EMIT_V3_FAMILIES)[number];

export const LATEST_PREVIEW_GENERATOR_EVIDENCE_RUN_ID = "20260614T090000Z" as const;

/** V3 families with verified previews — Wave-1 emit NOT approved (preview-only). */
export const PREVIEW_ONLY_V3_FAMILIES = [
  "physical_return_scanner_issue",
  "partial_incorrect_reimbursement",
] as const;

export type PreviewOnlyV3Family = (typeof PREVIEW_ONLY_V3_FAMILIES)[number];

/** Which preview recommended_action values may write claim_candidates. */
export const EMIT_STATUS_RULES = {
  claim_ready: {
    may_emit: true,
    description: "Only status that may insert/update trusted claim_candidates rows.",
  },
  needs_review: {
    may_emit: false,
    review_signal_only: true,
    description: "115 preview rows in staging — UI/review queue signal only; never write.",
  },
  unavailable: {
    may_emit: false,
    review_signal_only: false,
    description: "Generator skipped or source unreliable — no emit.",
  },
} as const;

/** Money lanes on emit — NULL when unavailable; never coerce zero. */
export const MONEY_FIELD_RULES = {
  estimated_amazon_payout: "Preview/metadata optional; NULL when fee_payout_unavailable",
  observed_reimbursement: "Never overwrite amazon_reimbursements; optional metadata.money_lanes only",
  internal_cost_loss: "NULL when cogs_unavailable; sale price NEVER used as COGS",
  reimbursement_gap: "Preview display only; NULL unless both lanes present",
  expected_amount: "Column on claim_candidates; NULL when fee spine unavailable",
  recovery_value: "recovery_value ?? expected_amount on insert/update",
  zero_coercion_forbidden: true,
} as const;

/** Maps V3 preview family → trusted intake claim_family values that may emit. */
export const V3_TO_CLAIM_FAMILY_EMIT_MAP: Record<
  ApprovedEmitV3Family,
  { claim_families: string[]; source_kinds: string[] }
> = {
  removal_shipment_missing: {
    claim_families: ["shipment_not_received"],
    source_kinds: ["delayed_not_received"],
  },
  removal_order_discrepancy: {
    claim_families: ["shipment_quantity_mismatch", "removal_missing_units"],
    source_kinds: ["shipment_discrepancy", "amazon_removal_api"],
  },
};

export type EmitRule = {
  rule_id: string;
  description: string;
  required: boolean;
};

export type NoEmitRule = {
  rule_id: string;
  description: string;
  review_signal_only: boolean;
};

export type DedupeContract = {
  dedupe_key_format: string;
  dedupe_key_builder: "buildClaimDedupeKey";
  source_event_key_rules: Record<string, string>;
  insert_when: string[];
  update_when: string[];
  skip_when: string[];
  unique_indexes: string[];
  identity_conflict_key: string;
};

export type CandidatePayloadShape = {
  required_columns: string[];
  insert_defaults: Record<string, string>;
  update_mutable_columns: string[];
  metadata_required_keys: string[];
  metadata_optional_keys: string[];
  quantity_fields: Record<string, string>;
  amount_fields: Record<string, string>;
  trid_edges_storage: string;
};

export type AuditContract = {
  intake_run_id: string;
  run_summary_fields: string[];
  metadata_audit_keys: string[];
  postgres_audit_logs: string;
  pre_post_counts: string[];
  operator_approval_file: string;
  emit_origin_tag: string;
};

export type RollbackPlan = {
  scope_key: string;
  detection_query: string;
  rollback_actions: string[];
  forbidden_actions: string[];
  legacy_corroboration_reversal: string;
  verification: string[];
};

export type RlsRequirements = {
  organization_id: string;
  store_id: string;
  write_principal: string;
  read_principal: string;
  quarantine_visibility: string;
  staging_only_until: string;
};

export type ClaimCandidateEmitApprovalContractPayload = {
  contract_version: typeof EMIT_CONTRACT_VERSION;
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: true;
  prerequisite_phase: string;
  prerequisite_safe_to_approve_claim_candidate_emit: "yes" | "conditional_no" | "no";
  prerequisite_evidence_run_id: string;
  approved_families: typeof APPROVED_EMIT_V3_FAMILIES;
  preview_only_families: typeof PREVIEW_ONLY_V3_FAMILIES;
  v3_to_claim_family_map: typeof V3_TO_CLAIM_FAMILY_EMIT_MAP;
  emit_status_rules: typeof EMIT_STATUS_RULES;
  money_field_rules: typeof MONEY_FIELD_RULES;
  emit_rules: EmitRule[];
  no_emit_rules: NoEmitRule[];
  review_signal_only_statuses: string[];
  dedupe_contract: DedupeContract;
  candidate_payload_shape: CandidatePayloadShape;
  audit_contract: AuditContract;
  rollback_plan: RollbackPlan;
  RLS_requirements: RlsRequirements;
  product_story_hooks: string[];
  trid_edge_emit_requirements: Record<string, string[]>;
  migration_needed: "yes" | "no";
  migration_notes: string;
  approval_required: true;
  emit_blockers: string[];
  SAFE_TO_IMPLEMENT_EMITTER: "yes" | "conditional_no" | "no";
  NEXT_PROMPT: string;
};

const EMIT_RULES: EmitRule[] = [
  {
    rule_id: "preview_claim_ready",
    description:
      "Preview item recommended_action MUST be claim_ready (not needs_review or unavailable).",
    required: true,
  },
  {
    rule_id: "no_blocker_flags",
    description:
      "blocker_flags MUST be empty — especially no disputed_source_row and no defer_until_linkage.",
    required: true,
  },
  {
    rule_id: "resolved_product_id",
    description: "resolved_product_id MUST be non-null on the draft/product grain.",
    required: true,
  },
  {
    rule_id: "positive_clean_quantity",
    description:
      "expected_quantity (clean, non-disputed split) MUST be > 0; delta_quantity computed on draft.",
    required: true,
  },
  {
    rule_id: "approved_family_only",
    description:
      "V3 family_key MUST be in approved_families; claim_family MUST match v3_to_claim_family_map.",
    required: true,
  },
  {
    rule_id: "trusted_source_kind",
    description:
      "source_kind MUST be a registered trusted generator kind — never legacy_seed or customer_return_sql_preview.",
    required: true,
  },
  {
    rule_id: "operator_approval_file",
    description:
      "Operator approval file .cursor/operator-approvals/claim-candidate-emit-staging-pilot-v1-approval.md MUST exist with Maysam sign-off before first apply.",
    required: true,
  },
  {
    rule_id: "staging_pilot_cap",
    description:
      "First emit run MUST be staging-only with --max-rows<=50 and explicit intake_run_id logged.",
    required: true,
  },
  {
    rule_id: "intake_settings_gate",
    description:
      "claim_intake settings manual_run_enabled=true; source_kind not excluded; source_table not in excluded_source_tables.",
    required: true,
  },
  {
    rule_id: "candidate_status_detected",
    description: "New inserts land as candidate_status=detected, evidence_status=missing — no auto-promotion.",
    required: true,
  },
  {
    rule_id: "money_nullable",
    description:
      "fee_payout_unavailable / cogs_unavailable review_flags do NOT block emit; amount fields remain NULL until fee spine available.",
    required: false,
  },
  {
    rule_id: "source_edges_present",
    description:
      "Preview source_edges MUST include at least one {table, id} pointer to the trusted source row.",
    required: true,
  },
  {
    rule_id: "evidence_summary_present",
    description:
      "Preview evidence_summary MUST be non-null non-empty string before emit (human-readable claim reason context).",
    required: true,
  },
  {
    rule_id: "trid_edges_copied",
    description:
      "trid_gaps:* review_flags are advisory on emit; reference_edges copied to metadata from preview TRID_edges.",
    required: false,
  },
];

const NO_EMIT_RULES: NoEmitRule[] = [
  {
    rule_id: "needs_review_preview",
    description: "recommended_action=needs_review — review_signal_only; never write claim_candidates.",
    review_signal_only: true,
  },
  {
    rule_id: "unavailable_preview",
    description: "recommended_action=unavailable — generator skipped or source unreliable.",
    review_signal_only: false,
  },
  {
    rule_id: "disputed_expected_package",
    description:
      "disputed_source_row / non-clean build_status on expected_packages — quantity excluded; review_signal_only.",
    review_signal_only: true,
  },
  {
    rule_id: "unresolved_product_link",
    description: "product_linkage_unresolved / defer_until_linkage — blocked until resolver match.",
    review_signal_only: true,
  },
  {
    rule_id: "customer_return_family",
    description:
      "customer_return_not_reimbursed — SQL preview only in Wave-1; no trusted apply path until reimbursement generator wired.",
    review_signal_only: true,
  },
  {
    rule_id: "missing_reimbursement_family",
    description:
      "missing_reimbursement — blocked until ledger_draft_linkage >= 25% (staging linkage still critical).",
    review_signal_only: true,
  },
  {
    rule_id: "preview_only_families",
    description:
      "physical_return_scanner_issue and partial_incorrect_reimbursement — verified previews (6+300 claim_ready) but Wave-1 emit NOT approved.",
    review_signal_only: true,
  },
  {
    rule_id: "legacy_seed_target",
    description:
      "Existing row with source_kind=legacy_seed matching dedupe_key — skip insert/update; metadata corroboration only.",
    review_signal_only: false,
  },
  {
    rule_id: "quarantined_row",
    description:
      "Existing row with quarantined_at NOT NULL — never revive; new trusted row may insert if dedupe_key differs.",
    review_signal_only: false,
  },
  {
    rule_id: "rejected_row",
    description: "Existing row with rejected_at NOT NULL — skip update; operator must clear rejection first.",
    review_signal_only: false,
  },
  {
    rule_id: "identity_conflict",
    description:
      "Another row exists for (org, source_table, source_row_id, claim_family) with different dedupe_key — skip.",
    review_signal_only: false,
  },
  {
    rule_id: "terminal_candidate_status",
    description:
      "Do not overwrite rows in submitted/closed/superseded terminal states without explicit supersede workflow.",
    review_signal_only: false,
  },
];

const DEDUPE_CONTRACT: DedupeContract = {
  dedupe_key_format:
    "v1:{source_kind}:{organization_id}:{store_id|-}:{source_table}:{source_row_id}:{claim_family}",
  dedupe_key_builder: "buildClaimDedupeKey",
  source_event_key_rules: {
    shipment_not_received: "expected_packages.tracking_number (non-null)",
    shipment_quantity_mismatch: "expected_packages.tracking_number ?? order_id",
    removal_missing_units: "amazon_removals.order_id",
  },
  insert_when: [
    "No existing claim_candidates row with same organization_id + dedupe_key",
    "No identity conflict on (organization_id, source_table, source_row_id, claim_family)",
    "All emit_rules pass",
  ],
  update_when: [
    "Existing trusted row (source_kind != legacy_seed) matches dedupe_key",
    "Row is not quarantined and not rejected",
    "Quantities, amounts, metadata, intake_run_id refreshed — candidate_status unchanged unless operator promotes",
  ],
  skip_when: [
    "dedupe_key matches legacy_seed row",
    "identity conflict with different dedupe_key",
    "preview failed emit_rules or hit no_emit_rules",
  ],
  unique_indexes: [
    "uq_claim_candidates_dedupe_key (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL",
    "uq_claim_candidates_source_identity (organization_id, source_table, source_row_id, claim_family)",
  ],
  identity_conflict_key: "{source_table}:{claim_family}:{source_row_id}",
};

const CANDIDATE_PAYLOAD_SHAPE: CandidatePayloadShape = {
  required_columns: [
    "organization_id",
    "store_id",
    "source_kind",
    "source_table",
    "source_row_id",
    "claim_family",
    "claim_reason",
    "dedupe_key",
    "source_event_key",
    "sku",
    "fnsku",
    "asin",
    "resolved_product_id",
    "expected_quantity",
    "actual_quantity",
    "delta_quantity",
    "expected_units",
    "expected_amount",
    "currency",
    "event_date",
    "reference_id",
    "reference_type",
    "recovery_value",
    "candidate_status",
    "evidence_status",
    "confidence_score",
    "intake_run_id",
    "metadata",
  ],
  insert_defaults: {
    candidate_status: "detected",
    evidence_status: "missing",
    currency: "USD",
  },
  update_mutable_columns: [
    "source_event_key",
    "expected_quantity",
    "actual_quantity",
    "delta_quantity",
    "expected_amount",
    "event_date",
    "reference_id",
    "reference_type",
    "dispute_deadline",
    "days_remaining",
    "recovery_value",
    "cogs_unit",
    "claim_reason",
    "confidence_score",
    "intake_run_id",
    "metadata",
    "updated_at",
  ],
  metadata_required_keys: [
    "emit_contract_version",
    "preview_id",
    "emit_origin",
    "reference_key",
    "evidence_pointers",
    "reference_edges",
  ],
  metadata_optional_keys: [
    "evidence_summary",
    "build_status",
    "expected_package_id",
    "package_id",
    "pallet_id",
    "carrier",
    "corroborated_by_dedupe_key",
    "corroborated_at",
  ],
  quantity_fields: {
    expected_quantity: "Clean non-disputed units from splitExpectedQuantityByBuildStatus",
    actual_quantity: "Observed units (0 for shipment_not_received)",
    delta_quantity: "expected_quantity - actual_quantity when both set",
    expected_units: "Mirror of expected_quantity on insert (phase7b column)",
    quantity_claimed_preview: "Preview-only alias; maps to expected_quantity on emit",
  },
  amount_fields: {
    expected_amount: "From draft; may be NULL when fee spine unavailable",
    recovery_value: "recovery_value ?? expected_amount on insert/update",
    cogs_unit: "From fee-adjusted readmodel when available; NULL otherwise",
    estimated_amazon_payout: "Preview/money lane only — stored in metadata.money_lanes on emit optional",
    observed_reimbursement: "Never overwrite trusted reimbursement tables; preview lane → metadata optional",
    reimbursement_gap: "Preview display only unless future money contract requires column",
  },
  trid_edges_storage:
    "metadata.reference_edges (ClaimReferenceEdge[]) on insert/update; materialization to claim_reference_edges is PHASE-7H+ and NOT part of Wave-1 emit",
};

const AUDIT_CONTRACT: AuditContract = {
  intake_run_id: "UUID v4 per emit run; stamped on every inserted/updated row",
  run_summary_fields: [
    "organization_id",
    "store_id",
    "intake_run_id",
    "emit_contract_version",
    "pre_count",
    "post_count",
    "inserted",
    "updated_existing_trusted",
    "skipped_identity_conflict",
    "legacy_corroborated",
    "approved_families",
    "max_rows_cap",
  ],
  metadata_audit_keys: ["emit_contract_version", "preview_id", "emit_origin", "generator_phase"],
  postgres_audit_logs:
    "claim_candidates UPDATE/INSERT triggers → audit_logs (organization_id, table_name, record_id, action, old_data, new_data)",
  pre_post_counts: [
    "COUNT(*) claim_candidates WHERE organization_id = :org BEFORE run",
    "Same AFTER run; delta logged in run summary",
  ],
  operator_approval_file:
    ".cursor/operator-approvals/claim-candidate-emit-staging-pilot-v1-approval.md",
  emit_origin_tag: "preview_emit_v1",
};

const ROLLBACK_PLAN: RollbackPlan = {
  scope_key: "intake_run_id",
  detection_query:
    "SELECT id FROM claim_candidates WHERE intake_run_id = :run_id AND metadata->>'emit_origin' = 'preview_emit_v1'",
  rollback_actions: [
    "Soft-supersede: SET candidate_status='superseded', superseded_by_candidate_id=NULL, metadata = metadata || jsonb_build_object('rollback_run_id', :rollback_id, 'rollback_at', now())",
    "OR quarantine pilot rows: SET quarantined_at=now(), quarantine_reason='emit_pilot_rollback_v1' WHERE intake_run_id=:run_id",
    "Reverse legacy corroboration: REMOVE metadata.corroborated_by_dedupe_key on legacy_seed rows stamped in same run",
  ],
  forbidden_actions: [
    "Hard DELETE from claim_candidates",
    "Revive legacy_seed rows to active candidate_status",
    "Auto-create claim_cases or claim_lines",
  ],
  legacy_corroboration_reversal:
    "UPDATE claim_candidates SET metadata = metadata - 'corroborated_by_dedupe_key' - 'corroborated_at' WHERE source_kind='legacy_seed' AND metadata->>'corroborated_at' >= :run_started_at",
  verification: [
    "claim_candidates count returns to pre-run baseline ±0 for pilot scope",
    "Claim Center active queue excludes quarantined/superseded rows",
    "audit_logs show rollback actions",
  ],
};

const RLS_REQUIREMENTS: RlsRequirements = {
  organization_id: "NOT NULL on every row; emitter MUST pass explicit organization_id from session/settings — never infer from store alone",
  store_id: "NOT NULL for removal families; composite index (organization_id, store_id) used by Claim Center filters",
  write_principal:
    "Staging pilot: service_role via governed script/API with STAGING_SUPABASE_URL ref guard (eiqfaapyumhixxoeltgu). Production blocked until Maysam original approval.",
  read_principal:
    "Authenticated users via existing claim_candidates RLS org isolation; quarantined rows hidden from active queue readmodel",
  quarantine_visibility:
    "legacy_seed + quarantined_at rows excluded from emit upsert targets and active queue; visible in admin/audit views only",
  staging_only_until: "Original apply requires separate operator approval after staging pilot PASS",
};

function tridEmitRequirements(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const family of APPROVED_EMIT_V3_FAMILIES) {
    const req = FAMILY_EDGE_REQUIREMENTS.find((f) => f.family_key === family);
    out[family] =
      req?.edges
        .filter((e) => e.required_for_claim_ready || e.required_for_product_story)
        .map((e) => e.edge_kind_id) ?? [];
  }
  return out;
}

const PRODUCT_STORY_HOOKS = [
  "On emit: resolved_product_id enables product_story_href in Claim Center when linkage safe_for_product_story != no",
  "metadata.reference_edges must include tracking_number and/or removal_order_id for removal timeline sections",
  "product_link edge required before Product Story identity block — unresolved product blocks emit (not just story)",
  "Money section in Product Story stays empty when estimated_amazon_payout NULL — review_flag fee_payout_unavailable",
  "Disputed EP rows never emit — Product Story must not show disputed quantity as claim-ready",
  "Post-emit: Claim Center References tab reads metadata.reference_edges until TRID readmodel materialization phase",
] as const;

function buildEmitBlockers(prerequisiteSafe: "yes" | "conditional_no" | "no"): string[] {
  const blockers = [
    "Operator approval file not yet signed by Maysam",
    "Emitter implementation not built (contract-only phase)",
    "physical_return_scanner_issue and partial_incorrect_reimbursement are preview-only in Wave-1",
    "missing_reimbursement and customer_return families explicitly excluded from Wave-1",
  ];
  if (prerequisiteSafe !== "yes") {
    blockers.unshift(
      `Prerequisite SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT is ${prerequisiteSafe} (required yes)`,
    );
  }
  return blockers;
}

export function buildClaimCandidateEmitApprovalContractV1(
  prerequisiteSafe: "yes" | "conditional_no" | "no" = "yes",
  evidenceRunId: string = LATEST_PREVIEW_GENERATOR_EVIDENCE_RUN_ID,
): ClaimCandidateEmitApprovalContractPayload {
  const safeEmitter: ClaimCandidateEmitApprovalContractPayload["SAFE_TO_IMPLEMENT_EMITTER"] =
    prerequisiteSafe === "yes" ? "conditional_no" : "no";

  return {
    contract_version: EMIT_CONTRACT_VERSION,
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    prerequisite_phase: "PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1",
    prerequisite_safe_to_approve_claim_candidate_emit: prerequisiteSafe,
    prerequisite_evidence_run_id: evidenceRunId,
    approved_families: APPROVED_EMIT_V3_FAMILIES,
    preview_only_families: PREVIEW_ONLY_V3_FAMILIES,
    v3_to_claim_family_map: V3_TO_CLAIM_FAMILY_EMIT_MAP,
    emit_status_rules: EMIT_STATUS_RULES,
    money_field_rules: MONEY_FIELD_RULES,
    emit_rules: EMIT_RULES,
    no_emit_rules: NO_EMIT_RULES,
    review_signal_only_statuses: [
      "needs_review",
      "review_signal_only",
      "blocked_missing_linkage",
      "blocked_missing_source",
    ],
    dedupe_contract: DEDUPE_CONTRACT,
    candidate_payload_shape: CANDIDATE_PAYLOAD_SHAPE,
    audit_contract: AUDIT_CONTRACT,
    rollback_plan: ROLLBACK_PLAN,
    RLS_requirements: RLS_REQUIREMENTS,
    product_story_hooks: [...PRODUCT_STORY_HOOKS],
    trid_edge_emit_requirements: tridEmitRequirements(),
    migration_needed: "no",
    migration_notes:
      "Phase 7B migration 20260914120000 already provides dedupe_key, source_event_key, quantity columns, intake_run_id, quarantine/supersede columns, and unique indexes. Wave-1 emit uses existing applyDrafts shape.",
    approval_required: true,
    emit_blockers: buildEmitBlockers(prerequisiteSafe),
    SAFE_TO_IMPLEMENT_EMITTER: safeEmitter,
    NEXT_PROMPT:
      "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1\n\nMode: staging-only pilot emit (max 50 rows).\nPrerequisites:\n1. Maysam signs .cursor/operator-approvals/claim-candidate-emit-staging-pilot-v1-approval.md\n2. Implement preview→draft→applyDrafts bridge gated by this contract (lib/claims/intake/claim-preview-emit-v1.ts)\n3. Run with explicit intake_run_id; preimage COUNT + rollback SQL; verify claim_candidates delta <= 50\n4. Re-run preview generators; confirm emitted rows match top claim_ready previews by dedupe_key\n5. build + smoke; append memory\nNo claim_cases, no submissions, no scanner/RBAC/resolver changes.",
  };
}

/** Flat export for audit scripts and API read models. */
export const CLAIM_CANDIDATE_EMIT_APPROVAL_CONTRACT_V1 =
  buildClaimCandidateEmitApprovalContractV1("yes");
