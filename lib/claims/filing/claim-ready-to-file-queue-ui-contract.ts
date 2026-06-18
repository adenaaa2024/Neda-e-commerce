/**
 * PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1 — client-safe UI contract.
 *
 * Types, constants, and PURE helpers for the Ready-to-File queue. Imported by the
 * client components (`ReadyToFileView`, `ReadyToFileDetailDrawer`).
 *
 * HARD RULE — this module is FULLY SELF-CONTAINED and client-safe. It imports
 * NOTHING: no server composer, no `claim-ready-to-file-queue-v1.ts`, no server
 * reference/money/filing modules, no `node:fs`, no `playwright`, not even an
 * `import type` from a server module (so there is zero chance the bundler follows
 * an edge into server code). The server composer imports its shared types FROM
 * here. The seller-central packet/group shapes are duplicated here as plain,
 * structurally-compatible types; the server composer assigns the real values to
 * them by structural typing.
 */

export const CLAIM_READY_TO_FILE_QUEUE_V1 = "claim-ready-to-file-queue-v1" as const;

/** Families eligible for the Ready-to-File pilot queue. */
export const READY_TO_FILE_ELIGIBLE_FAMILIES = [
  "removal_shipment_missing",
  "removal_order_discrepancy",
] as const;

// ---- Seller Central packet/group shapes (client-safe duplicates) ----

export type ReadyToFileRecordBackFields = {
  amazon_case_id: string | null;
  filed_at: string | null;
  filed_by: string | null;
  external_case_url: string | null;
  notes: string | null;
};

export type ReadyToFileCopyIntoFields = {
  subject: string;
  message_body: string;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  removal_order_id: string | null;
  removal_shipment_id: string | null;
  quantity_affected: number | null;
  requested_reimbursement_amount: number | null;
  currency: string;
};

export type ReadyToFileSellerCentralPacket = {
  claim_submission_id: string;
  claim_case_id: string | null;
  claim_family: string | null;

  recommended_filing_group_id: string;
  file_individually: boolean;
  grouping_reason: string;

  seller_central_case_subject: string;
  seller_central_message_body: string;

  requested_reimbursement_amount: number | null;
  quantity_affected: number | null;
  approved_cogs_unit: number | null;
  recovery_formula: string;

  fnsku: string | null;
  sku: string | null;
  asin: string | null;

  trid: string | null;
  expected_package_id: string | null;
  product_link_resolved_product_id: string | null;

  removal_order_id: string | null;
  removal_shipment_id: string | null;

  source_table: string | null;
  source_row_ids: {
    claim_candidate_id: string | null;
    claim_line_ids: string[];
    source_row_id: string | null;
  };

  evidence_packet_path: string;
  attachments_to_include: string[];

  human_review_checklist: string[];
  fields_to_copy_into_seller_central: ReadyToFileCopyIntoFields;
  fields_to_record_back: ReadyToFileRecordBackFields;

  ready_to_file: boolean;
  blockers: string[];
  human_review_required: boolean;
};

export type ReadyToFileFilingGroup = {
  filing_group_id: string;
  group_basis: string;
  shared_reference_value: string | null;
  claim_submission_ids: string[];
  claim_case_ids: string[];
  recommendation: string;
  reason: string;
};

// ---- Ready-to-File row + payload types ----

export type ReadyToFileAuditItem = {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
};

export type ReadyToFileMoneyLane = {
  latest_sold_price: number | null;
  amazon_fees_total: number | null;
  net_settlement_amount: number | null;
  approved_cogs_unit: number | null;
  recovery_value: number | null;
  observed_reimbursement: number | null;
  observed_reimbursement_status: string;
  currency: string;
};

export type ReadyToFileReferenceEdge = {
  id: string;
  edge_type: string | null;
  reference_kind: string | null;
  reference_value: string | null;
  source_table: string | null;
  source_row_id: string | null;
  confidence_score: number | null;
  operator_review_status: string | null;
};

export type ReadyToFileReferenceHealth = {
  primary_trid: string | null;
  trid_source: string;
  trid_confidence: string;
  expected_package_id: string | null;
  product_link_resolved_product_id: string | null;
  event_datetime_used_as_filter: boolean;
  event_datetime_note: string;
  reference_edge_count: number;
  ambiguous_reference_count: number;
  edges: ReadyToFileReferenceEdge[];
};

// ---- Event Reference Ledger (PHASE-CLAIM-EVENT-REFERENCE-LEDGER-AND-TRID-CORRECTION-V1) ----

export type EventReferenceConfidence = "high" | "medium" | "low";

/** One REAL external Amazon event/report reference (never an internal DB UUID). */
export type EventReferenceRow = {
  source: string;
  source_label: string;
  reference_kind: string;
  reference_id: string;
  event_type: string | null;
  event_date: string | null;
  quantity: number | null;
  amount: number | null;
  source_row_id: string | null;
  match_reason: string[];
  confidence: EventReferenceConfidence;
  is_external_amazon_reference: true;
};

/** Internal DB anchor (UUID / product link) — debug/provenance only, never Amazon proof. */
export type InternalAnchorRow = {
  label: string;
  value: string;
  kind: string;
  note: string;
};

export type PrimaryReferenceAnchor = {
  label: string;
  value: string | null;
  kind: string;
  is_external_amazon_reference: boolean;
};

// ---- Deep Amazon reference ledger (PHASE-CLAIM-DEEP-AMAZON-REFERENCE-LEDGER-V1) ----

export type DeepReferenceSourceStatus =
  | "found"
  | "found_but_not_materialized"
  | "found_weak_ambiguous"
  | "not_found_in_loaded_reports"
  | "source_table_empty"
  | "source_table_missing";

/** One source group (removal / shipment / ledger / transaction / reimbursement / return / report) with deep-search status. */
export type DeepReferenceSourceGroup = {
  group: string;
  source_label: string;
  status: DeepReferenceSourceStatus;
  references: EventReferenceRow[];
  candidate_count: number;
  candidate_samples: EventReferenceRow[];
  note: string;
};

export type DeepReferenceFilingSufficiency =
  | "complete"
  | "sufficient_for_manual_filing"
  | "needs_reference_review";

export type DeepReferenceTableCensus = {
  table: string;
  group: string;
  exists: boolean;
  org_row_count: number | null;
  status: "populated" | "empty" | "missing";
};

export type DeepReferenceCensus = {
  source_tables_checked: DeepReferenceTableCensus[];
  source_tables_empty_or_missing: string[];
  date_window_days: number;
  event_date_time_filter_used: boolean;
  totals: {
    external_references: number;
    removal_order_refs: number;
    removal_shipment_refs: number;
    tracking_refs: number;
    inventory_ledger_refs: number;
    transaction_refs: number;
    reimbursement_refs: number;
    customer_return_refs: number;
    report_metadata_refs: number;
  };
  claims_total: number;
  claims_complete: number;
  claims_filing_sufficient: number;
  claims_needs_reference_review: number;
};

export type ClaimEventReferenceLedger = {
  claim_submission_id: string;
  claim_case_id: string | null;
  claim_family: string | null;
  product_identity: {
    resolved_product_id: string | null;
    fnsku: string | null;
    sku: string | null;
    asin: string | null;
  };
  quantity: number | null;
  event_datetime: string | null;
  event_time_window_used: boolean;
  event_datetime_note: string;

  primary_reference_anchor: PrimaryReferenceAnchor;
  external_references: EventReferenceRow[];
  internal_anchors: InternalAnchorRow[];

  removal_order_refs: string[];
  removal_shipment_refs: string[];
  tracking_refs: string[];
  inventory_ledger_refs: string[];
  transaction_refs: string[];
  reimbursement_refs: string[];

  external_reference_count: number;
  internal_anchor_count: number;

  match_reasons: string[];
  confidence: EventReferenceConfidence;
  ambiguity_flag: boolean;
  missing_reference: boolean;
  needs_reference_review: boolean;

  seller_central_reference_block: string;

  // ---- Deep multi-source search (PHASE-CLAIM-DEEP-AMAZON-REFERENCE-LEDGER-V1) ----
  source_groups: DeepReferenceSourceGroup[];
  customer_return_refs: string[];
  report_metadata_refs: string[];
  matched_by: string[];
  date_window_used: boolean;
  date_window_days: number;
  date_window_candidate_count: number;
  not_found_sources: string[];
  ambiguous_sources: string[];
  filing_sufficiency: DeepReferenceFilingSufficiency;
};

export type ReadyToFileRow = {
  // ---- Table columns ----
  claim_submission_id: string;
  claim_case_id: string | null;
  claim_family: string | null;
  filing_status: string;
  recovery_value: number | null;
  clean_quantity: number | null;
  approved_cogs_unit: number | null;
  fnsku: string | null;
  sku: string | null;
  asin: string | null;
  trid_or_expected_package: string | null;
  removal_order_id: string | null;
  removal_shipment_id: string | null;
  evidence_status: "present" | "missing";
  filing_packet_status: "ready" | "blocked";
  amazon_case_id_status: "recorded" | "not_recorded";

  // ---- Classification ----
  ready_to_file: boolean;
  blockers: string[];
  audit: ReadyToFileAuditItem[];
  scanner_only: boolean;
  uses_fake_scan_code: boolean;
  uses_simulated_case_id: boolean;
  uses_sale_price_as_amount: boolean;

  // ---- Detail (drawer) ----
  recovery_formula: string;
  money_lane: ReadyToFileMoneyLane;
  reference_health: ReadyToFileReferenceHealth;
  event_reference_ledger: ClaimEventReferenceLedger;
  product_identity: {
    fnsku: string | null;
    sku: string | null;
    asin: string | null;
    resolved_product_id: string | null;
  };
  packet: ReadyToFileSellerCentralPacket;

  /** Confirmed operator amount-basis policy overlay (from governed workspace_settings). */
  amount_basis_policy_overlay?: AmountBasisPolicyOverlay | null;
};

// ---- Confirmed amount-basis policy overlay (PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1) ----

export type ConfirmedFamilyAmountPolicy = {
  family_key: string;
  basis: AmountBasis;
  use_as_seller_central_amount: boolean;
  informational_only: string[];
  confirmed_by: string;
  confirmed_at: string;
  approval_key: string;
  note: string | null;
};

export type AmountBasisPolicyOverlay = {
  version: string;
  confirmed_by: string;
  confirmed_at: string;
  approval_key: string;
  families: Record<string, ConfirmedFamilyAmountPolicy>;
};

export type ReadyToFileSummaryCards = {
  ready_to_file_count: number;
  total_recovery_value: number | null;
  families_count: number;
  family_counts: Record<string, number>;
  missing_blockers_count: number;
  not_submitted_to_amazon_count: number;
};

export type ReadyToFileCaseIdRecordingConfig = {
  enabled_by_default: false;
  unlock_label: string;
  fields: Array<{ key: string; label: string; required: boolean }>;
  does_not_submit_to_amazon: true;
  write_phase_required: string;
  write_guarded: true;
};

export type ReadyToFileQueuePayload = {
  version: typeof CLAIM_READY_TO_FILE_QUEUE_V1;
  route: "/claim-center/ready-to-file";
  pilot_case_run_id: string;
  intake_run_id: string;
  read_only: true;
  does_not_submit: true;

  summary_cards: ReadyToFileSummaryCards;
  ready_rows: ReadyToFileRow[];
  blocked_rows: ReadyToFileRow[];
  filing_group_matrix: ReadyToFileFilingGroup[];

  scanner_only_claims_detected: number;
  simulated_case_ids_used: number;
  fake_scan_codes_detected: number;
  sale_price_used_as_amount_detected: number;

  event_reference_ledger_summary: {
    built: boolean;
    event_datetime_filter_used: boolean;
    event_datetime_note: string;
    claims_with_external_references: number;
    claims_needs_reference_review: number;
  };

  deep_reference_census: DeepReferenceCensus;

  case_id_recording: ReadyToFileCaseIdRecordingConfig;

  prerequisites: {
    SAFE_MONEY_LANE_PREVIEW_READY: boolean;
    recovery_value_coverage: string;
    trid_coverage_count: string;
    reference_edges_total: number;
  };
};

// ---- UI filter helpers (pure) ----

export type ReadyToFileFilterState = {
  family: string;
  status: "all" | "ready" | "blocked";
  reimbursement_status: "all" | "not_reimbursed" | "partially_reimbursed" | "fully_reimbursed" | "unknown_unmatched";
  has_weak_candidates: boolean;
  has_trid: boolean;
  has_cogs: boolean;
  has_evidence: boolean;
  has_amazon_case_id: boolean;
};

export const DEFAULT_READY_TO_FILE_FILTERS: ReadyToFileFilterState = {
  family: "all",
  status: "all",
  reimbursement_status: "all",
  has_weak_candidates: false,
  has_trid: false,
  has_cogs: false,
  has_evidence: false,
  has_amazon_case_id: false,
};

export function filterReadyToFileRows(
  rows: ReadyToFileRow[],
  filters: ReadyToFileFilterState,
): ReadyToFileRow[] {
  return rows.filter((r) => {
    if (filters.family !== "all" && r.claim_family !== filters.family) return false;
    if (filters.status === "ready" && !r.ready_to_file) return false;
    if (filters.status === "blocked" && r.ready_to_file) return false;
    if (filters.has_trid && !r.trid_or_expected_package) return false;
    if (filters.has_cogs && r.approved_cogs_unit == null) return false;
    if (filters.has_evidence && r.evidence_status !== "present") return false;
    if (filters.has_amazon_case_id && r.amazon_case_id_status !== "recorded") return false;
    if (filters.reimbursement_status !== "all" || filters.has_weak_candidates) {
      const gap = computeRecoveryGap(r);
      if (filters.reimbursement_status !== "all" && gap.reimbursement_status !== filters.reimbursement_status) {
        return false;
      }
      if (filters.has_weak_candidates && !gap.has_weak_candidates) return false;
    }
    return true;
  });
}

/**
 * Build the Seller Central copy "reference block" text for one row.
 *
 * Uses ONLY real external/source references from the Event Reference Ledger — no
 * internal DB UUIDs, and never labels expected_package_id as a "TRID".
 */
export function buildReferenceBlockText(row: ReadyToFileRow): string {
  const block = row.event_reference_ledger?.seller_central_reference_block;
  if (block && block.trim()) return block;

  // Fallback (ledger unavailable): identity + quantity + amount only, no UUIDs.
  const lines: string[] = [];
  if (row.asin) lines.push(`ASIN: ${row.asin}`);
  if (row.fnsku) lines.push(`FNSKU: ${row.fnsku}`);
  if (row.sku) lines.push(`SKU: ${row.sku}`);
  lines.push(`Quantity affected: ${row.clean_quantity ?? "—"}`);
  lines.push(
    `Requested reimbursement: ${row.recovery_value == null ? "—" : `$${row.recovery_value.toFixed(2)}`}`,
  );
  return lines.join("\n");
}

// ---- Filing decision matrix (PHASE-CLAIM-FILING-DECISION-MATRIX-V1) ----

export type FilingDecisionStatus = "safe_to_file" | "needs_reference_review" | "do_not_file";

export type FilingDecision = {
  decision: FilingDecisionStatus;
  label: string;
  tone: "success" | "warning" | "danger";
  reason: string;
  high_confidence_refs: string[];
  weak_refs_excluded: string[];
  internal_anchors_excluded: string[];
  human_review_checklist: string[];
};

const FILING_DECISION_LABEL: Record<FilingDecisionStatus, { label: string; tone: FilingDecision["tone"] }> = {
  safe_to_file: { label: "Safe to file", tone: "success" },
  needs_reference_review: { label: "Needs reference review", tone: "warning" },
  do_not_file: { label: "Do not file", tone: "danger" },
};

/**
 * Deterministic, read-only filing decision for one row. Pure (no I/O, no AI).
 *
 * Rules (Maysam, PHASE-CLAIM-FILING-DECISION-MATRIX-V1):
 *  1. safe_to_file ONLY with >=1 strong external Amazon reference
 *     (removal_order_id OR removal_shipment_id OR tracking) AND product identity
 *     present AND affected quantity > 0 AND recovery based on approved COGS.
 *  2. Weak/advisory FNSKU+date-window ledger/reimbursement candidates never make a
 *     claim safe by themselves (they are excluded from the decision proof).
 *  3. Only internal DB UUIDs → do_not_file.
 *  4. No strong removal/shipment/tracking reference → needs_reference_review.
 */
export function computeFilingDecision(row: ReadyToFileRow): FilingDecision {
  const led = row.event_reference_ledger;

  const removalOrders = led?.removal_order_refs ?? [];
  const removalShipments = led?.removal_shipment_refs ?? [];
  const tracking = led?.tracking_refs ?? [];
  const orderLinkedSettlement = led?.transaction_refs ?? [];
  const orderLinkedReport = led?.report_metadata_refs ?? [];

  const highConfidence: string[] = [];
  for (const v of removalOrders) highConfidence.push(`Removal Order ID: ${v}`);
  for (const v of removalShipments) highConfidence.push(`Removal Shipment reference: ${v}`);
  for (const v of tracking) highConfidence.push(`Tracking / shipment reference: ${v}`);
  for (const v of orderLinkedSettlement) highConfidence.push(`Order-linked settlement/transaction: ${v}`);
  for (const v of orderLinkedReport) highConfidence.push(`Order-linked report row: ${v}`);

  // Weak/advisory references — surfaced to the operator but EXCLUDED from proof.
  const weakExcluded: string[] = [];
  for (const g of led?.source_groups ?? []) {
    if (g.status === "found_weak_ambiguous" && g.candidate_count > 0) {
      weakExcluded.push(
        `${g.source_label}: ${g.candidate_count} FNSKU/SKU + date-window candidate(s) — advisory only, excluded from Seller Central proof`,
      );
    }
  }

  const internalExcluded = (led?.internal_anchors ?? []).map((a) => `${a.label} (${a.kind})`);

  const hasStrong = removalOrders.length > 0 || removalShipments.length > 0 || tracking.length > 0;
  const onlyInternal = (led?.external_reference_count ?? 0) === 0;
  const identityOk = !!(row.fnsku || row.sku || row.asin);
  const qty = row.clean_quantity ?? 0;
  const qtyOk = qty > 0;
  const cogs = row.approved_cogs_unit ?? 0;
  const recovery = row.recovery_value ?? 0;
  const cogsOk = cogs > 0 && recovery > 0 && !row.uses_sale_price_as_amount;

  let decision: FilingDecisionStatus;
  let reason: string;
  if (onlyInternal) {
    decision = "do_not_file";
    reason =
      "Only internal DB UUID anchors resolved — no external Amazon report/event reference. Filing with internal IDs is not permitted.";
  } else if (!hasStrong) {
    decision = "needs_reference_review";
    reason =
      "No high-confidence removal order / removal shipment / tracking reference; only weak/advisory FNSKU+date-window candidates exist. Resolve a strong external reference before filing.";
  } else {
    const missing: string[] = [];
    if (!identityOk) missing.push("product identity (FNSKU/SKU/ASIN)");
    if (!qtyOk) missing.push("a positive affected quantity");
    if (!cogsOk) missing.push("a COGS-based recovery value (clean_quantity × approved COGS/unit, not sale price)");
    if (missing.length === 0) {
      decision = "safe_to_file";
      const refKind =
        removalOrders.length > 0
          ? "Removal Order ID"
          : removalShipments.length > 0
            ? "Removal Shipment reference"
            : "Tracking reference";
      reason = `Strong external reference (${refKind}) + matching product identity + affected quantity ${qty} + recovery $${recovery.toFixed(
        2,
      )} = ${qty} × $${cogs.toFixed(2)} COGS/unit. Weak/advisory candidates excluded from proof.`;
    } else {
      decision = "needs_reference_review";
      reason = `Has a strong external reference but is missing ${missing.join(", ")}. Resolve before filing.`;
    }
  }

  const checklist: string[] = [
    "Confirm the removal order / shipment / tracking reference matches the affected unit in Seller Central.",
    `Confirm affected quantity = ${row.clean_quantity ?? "—"} and recovery = quantity × approved COGS/unit ($${
      row.approved_cogs_unit == null ? "—" : row.approved_cogs_unit.toFixed(2)
    }); sale price is NOT the claim amount.`,
    "Do NOT paste internal DB UUIDs, expected_package_id/product_link as a TRID, or weak FNSKU/date-window candidates as proof.",
  ];
  if (weakExcluded.length > 0) {
    checklist.push(
      "Inventory-ledger / reimbursement window candidates are advisory only — verify the real event before citing any of them.",
    );
  }
  if (decision !== "safe_to_file") {
    checklist.push("Do not submit until the filing decision is Safe to file.");
  }

  const meta = FILING_DECISION_LABEL[decision];
  return {
    decision,
    label: meta.label,
    tone: meta.tone,
    reason,
    high_confidence_refs: highConfidence,
    weak_refs_excluded: weakExcluded,
    internal_anchors_excluded: internalExcluded,
    human_review_checklist: checklist,
  };
}

// ---- Recovery gap + reimbursement matching engine (PHASE-CLAIM-RECOVERY-GAP-AND-REIMBURSEMENT-MATCHING-V1) ----

export type ReimbursementStatus =
  | "not_reimbursed"
  | "partially_reimbursed"
  | "fully_reimbursed"
  | "over_reimbursed"
  | "unknown_unmatched";

export type RecoveryGapMatchKind =
  | "reimbursement"
  | "settlement_credit"
  | "transaction"
  | "inventory_ledger";

export type RecoveryGapMatch = {
  kind: RecoveryGapMatchKind;
  source_label: string;
  reference_id: string;
  reason: string | null;
  amount: number | null;
  quantity: number | null;
  event_date: string | null;
  counted: boolean;
};

export type RecoveryGap = {
  expected_recovery_value: number | null;
  confirmed_reimbursed: number;
  matched_reimbursement_amount: number;
  matched_reimbursement_quantity: number | null;
  open_recovery_gap: number | null;
  recovery_requested_amount: number | null;
  reimbursement_status: ReimbursementStatus;
  status_label: string;
  status_tone: "success" | "warning" | "danger" | "neutral";
  match_confidence: "high" | "medium" | "low" | "none";
  match_reason: string;
  strong_reimbursement_matches: RecoveryGapMatch[];
  weak_reimbursement_candidates: RecoveryGapMatch[];
  strong_transaction_matches: RecoveryGapMatch[];
  weak_transaction_candidates: RecoveryGapMatch[];
  settlement_credit_matches: RecoveryGapMatch[];
  inventory_ledger_candidates: RecoveryGapMatch[];
  excluded_candidates_and_reason: string[];
  exact_rows_to_review_manually: string[];
  has_weak_candidates: boolean;
  /** Source groups actually searched, with their deep-search status (for "files checked"). */
  files_checked: string[];
  /** Sources/APIs needed to turn Unknown → confirmed (for "missing files / API"). */
  missing_files_or_api: string[];
};

/** SP-API/report needed to authoritatively confirm a missing financial source group. */
const SOURCE_GROUP_MISSING_API: Record<string, string> = {
  reimbursement: "GET_FBA_REIMBURSEMENTS_DATA (order-linked reimbursements sync)",
  transaction_settlement: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 (settlement schedule sync)",
  inventory_ledger: "GET_LEDGER_DETAIL_VIEW_DATA (Inventory Ledger Detail View ingest)",
};

const REIMBURSEMENT_STATUS_META: Record<ReimbursementStatus, { label: string; tone: RecoveryGap["status_tone"] }> = {
  fully_reimbursed: { label: "Fully reimbursed", tone: "success" },
  partially_reimbursed: { label: "Partially reimbursed", tone: "warning" },
  over_reimbursed: { label: "Over-reimbursed", tone: "warning" },
  not_reimbursed: { label: "Not reimbursed", tone: "danger" },
  unknown_unmatched: { label: "Unknown / unmatched", tone: "neutral" },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Classifies a settlement/transaction row as a reimbursement CREDIT (countable)
 * vs a fee/sale line (never countable). Fees ("FBA Inventory Fee", storage,
 * commission, advertising, subscription) are explicitly excluded even if some
 * other keyword matches.
 */
function isReimbursementCreditType(eventType: string | null): boolean {
  const t = (eventType ?? "").toLowerCase();
  if (!t) return false;
  if (/fee|storage|commission|subscription|advertis|service charge/.test(t)) return false;
  return /reimburs|reversal|compensat|credit|warehouse|lost|damaged|customerreturn/.test(t);
}

/**
 * Deterministic, read-only recovery-gap + reimbursement matching for one row.
 * Pure (no I/O, no AI). Reads ONLY the already-resolved Event Reference Ledger.
 *
 * Rules (Maysam, PHASE-CLAIM-RECOVERY-GAP-AND-REIMBURSEMENT-MATCHING-V1):
 *  - Only STRONG matches (order-linked reimbursement rows, or order-linked
 *    settlement/transaction rows classified as reimbursement/credit) count toward
 *    observed reimbursement.
 *  - Weak FNSKU/SKU + date-window candidates are shown but NEVER reduce the open gap.
 *  - Fees (e.g. "FBA Inventory Fee") are never counted as reimbursement.
 *  - No confirmed reimbursement → unknown_unmatched (never "$0 paid" without proof).
 *  - Seller Central requested amount = open_recovery_gap when confirmed > 0, else
 *    expected_recovery_value.
 */
export function computeRecoveryGap(row: ReadyToFileRow): RecoveryGap {
  const led = row.event_reference_ledger;
  const expected = row.recovery_value;
  const groups = led?.source_groups ?? [];
  const findGroup = (name: string) => groups.find((x) => x.group === name);

  const reimGroup = findGroup("reimbursement");
  const txnGroup = findGroup("transaction_settlement");
  const ledgerGroup = findGroup("inventory_ledger");

  const toMatch = (kind: RecoveryGapMatchKind, r: EventReferenceRow, counted: boolean): RecoveryGapMatch => ({
    kind,
    source_label: r.source_label,
    reference_id: r.reference_id,
    reason: r.event_type,
    amount: r.amount,
    quantity: r.quantity,
    event_date: r.event_date,
    counted,
  });

  // STRONG: order-linked reimbursement rows (materialized references in the group).
  const strongReimbursement = (reimGroup?.references ?? []).map((r) => toMatch("reimbursement", r, true));

  // Order-linked settlement/transaction rows: split into reimbursement CREDITS
  // (counted) vs ordinary transaction/fee lines (shown, NOT counted).
  const txnRefs = txnGroup?.references ?? [];
  const settlementCredits = txnRefs
    .filter((r) => isReimbursementCreditType(r.event_type) && (r.amount ?? 0) > 0)
    .map((r) => toMatch("settlement_credit", r, true));
  const strongTransactions = txnRefs
    .filter((r) => !(isReimbursementCreditType(r.event_type) && (r.amount ?? 0) > 0))
    .map((r) => toMatch("transaction", r, false));

  // WEAK: FNSKU/SKU + date-window candidates (never counted).
  const weakReimbursement = (reimGroup?.candidate_samples ?? []).map((r) => toMatch("reimbursement", r, false));
  const weakTransactions = (txnGroup?.candidate_samples ?? []).map((r) => toMatch("transaction", r, false));
  const ledgerCandidates = (ledgerGroup?.candidate_samples ?? []).map((r) => toMatch("inventory_ledger", r, false));

  const countedMatches = [...strongReimbursement, ...settlementCredits];
  const matchedAmount = round2(countedMatches.reduce((s, m) => s + Math.max(m.amount ?? 0, 0), 0));
  const qtySum = countedMatches.reduce((s, m) => s + (m.quantity ?? 0), 0);
  const matchedQuantity = countedMatches.some((m) => m.quantity != null) ? qtySum : null;
  const confirmed = matchedAmount;

  let status: ReimbursementStatus;
  let openGap: number | null;
  if (confirmed > 0 && expected != null) {
    const tol = 0.01;
    if (confirmed >= expected - tol && confirmed <= expected + tol) status = "fully_reimbursed";
    else if (confirmed > expected + tol) status = "over_reimbursed";
    else status = "partially_reimbursed";
    openGap = Math.max(round2(expected - confirmed), 0);
  } else if (confirmed > 0) {
    status = "partially_reimbursed";
    openGap = null;
  } else {
    // No confirmed reimbursement in loaded reports → preserve uncertainty.
    status = "unknown_unmatched";
    openGap = expected;
  }

  const hasWeak =
    weakReimbursement.length > 0 ||
    weakTransactions.length > 0 ||
    ledgerCandidates.length > 0 ||
    (reimGroup?.candidate_count ?? 0) > 0 ||
    (ledgerGroup?.candidate_count ?? 0) > 0;

  let confidence: RecoveryGap["match_confidence"];
  if (strongReimbursement.length > 0 || settlementCredits.length > 0) confidence = "high";
  else if (hasWeak) confidence = "low";
  else confidence = "none";

  const excluded: string[] = [];
  if ((reimGroup?.candidate_count ?? 0) > 0) {
    excluded.push(
      `${reimGroup?.candidate_count} reimbursement FNSKU/SKU + date-window candidate(s) — not order/shipment linked; excluded from claim amount (advisory only).`,
    );
  }
  if ((ledgerGroup?.candidate_count ?? 0) > 0) {
    excluded.push(
      `${ledgerGroup?.candidate_count} inventory-ledger FNSKU + date-window candidate(s) — not order-linked; excluded.`,
    );
  }
  if (strongTransactions.length > 0) {
    excluded.push(
      `${strongTransactions.length} order-linked settlement/transaction row(s) classified as fee/non-credit (e.g. "${strongTransactions[0].reason ?? "fee"}") — excluded from reimbursement total.`,
    );
  }

  const reviewRows: string[] = [];
  for (const m of [...strongReimbursement, ...settlementCredits, ...weakReimbursement.slice(0, 5)]) {
    reviewRows.push(`${m.source_label}: ${m.reference_id}${m.reason ? ` (${m.reason})` : ""}${m.amount != null ? ` $${m.amount.toFixed(2)}` : ""}`);
  }

  let reason: string;
  if (confidence === "high") {
    reason = `Confirmed reimbursement of $${confirmed.toFixed(2)} from ${countedMatches.length} order-linked reimbursement/credit row(s); open gap $${(openGap ?? 0).toFixed(2)}.`;
  } else if (hasWeak) {
    reason =
      "No order-linked reimbursement or credit found in loaded reports. FNSKU/date-window reimbursement candidates exist but are not tied to this removal order/shipment, so they are excluded — reimbursement status cannot be confirmed (Unknown / unmatched).";
  } else {
    reason =
      "No reimbursement, credit, or candidate found in loaded reports for this claim — status Unknown / unmatched (absence in loaded reports is not proof of non-reimbursement).";
  }

  const requested = confirmed > 0 ? openGap : expected;
  const meta = REIMBURSEMENT_STATUS_META[status];

  // Files checked + missing files/API (PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE-AND-CLAIM-FAMILY-MAP-V1).
  const STATUS_LABEL: Record<DeepReferenceSourceStatus, string> = {
    found: "found",
    found_but_not_materialized: "found (not materialized)",
    found_weak_ambiguous: "weak/ambiguous",
    not_found_in_loaded_reports: "not found in loaded reports",
    source_table_empty: "source empty",
    source_table_missing: "table missing",
  };
  const filesChecked: string[] = groups.map((g) => `${g.source_label}: ${STATUS_LABEL[g.status]}`);
  const missingFilesOrApi: string[] = [];
  for (const g of groups) {
    const needsApi = SOURCE_GROUP_MISSING_API[g.group];
    if (!needsApi) continue;
    if (
      g.status === "not_found_in_loaded_reports" ||
      g.status === "source_table_empty" ||
      g.status === "source_table_missing" ||
      g.status === "found_weak_ambiguous"
    ) {
      missingFilesOrApi.push(`${g.source_label}: need ${needsApi} to confirm reimbursement status.`);
    }
  }

  return {
    expected_recovery_value: expected,
    confirmed_reimbursed: confirmed,
    matched_reimbursement_amount: matchedAmount,
    matched_reimbursement_quantity: matchedQuantity,
    open_recovery_gap: openGap,
    recovery_requested_amount: requested,
    reimbursement_status: status,
    status_label: meta.label,
    status_tone: meta.tone,
    match_confidence: confidence,
    match_reason: reason,
    strong_reimbursement_matches: strongReimbursement,
    weak_reimbursement_candidates: weakReimbursement,
    strong_transaction_matches: strongTransactions,
    weak_transaction_candidates: weakTransactions,
    settlement_credit_matches: settlementCredits,
    inventory_ledger_candidates: ledgerCandidates,
    excluded_candidates_and_reason: excluded,
    exact_rows_to_review_manually: reviewRows,
    has_weak_candidates: hasWeak,
    files_checked: filesChecked,
    missing_files_or_api: missingFilesOrApi,
  };
}

export type RecoveryGapSummary = {
  total_claims: number;
  total_expected_recovery: number;
  total_confirmed_reimbursed: number;
  total_open_recovery_gap: number;
  fully_reimbursed_count: number;
  partially_reimbursed_count: number;
  over_reimbursed_count: number;
  not_reimbursed_count: number;
  unknown_unmatched_count: number;
  weak_candidate_count: number;
  needs_reimbursement_review_count: number;
  unreimbursed_claims_count: number;
};

export function summarizeRecoveryGap(rows: ReadyToFileRow[]): RecoveryGapSummary {
  const s: RecoveryGapSummary = {
    total_claims: rows.length,
    total_expected_recovery: 0,
    total_confirmed_reimbursed: 0,
    total_open_recovery_gap: 0,
    fully_reimbursed_count: 0,
    partially_reimbursed_count: 0,
    over_reimbursed_count: 0,
    not_reimbursed_count: 0,
    unknown_unmatched_count: 0,
    weak_candidate_count: 0,
    needs_reimbursement_review_count: 0,
    unreimbursed_claims_count: 0,
  };
  for (const row of rows) {
    const g = computeRecoveryGap(row);
    s.total_expected_recovery += g.expected_recovery_value ?? 0;
    s.total_confirmed_reimbursed += g.confirmed_reimbursed;
    s.total_open_recovery_gap += g.open_recovery_gap ?? 0;
    if (g.reimbursement_status === "fully_reimbursed") s.fully_reimbursed_count += 1;
    else if (g.reimbursement_status === "partially_reimbursed") s.partially_reimbursed_count += 1;
    else if (g.reimbursement_status === "over_reimbursed") s.over_reimbursed_count += 1;
    else if (g.reimbursement_status === "not_reimbursed") s.not_reimbursed_count += 1;
    else s.unknown_unmatched_count += 1;
    if (g.has_weak_candidates) s.weak_candidate_count += 1;
    if (g.confirmed_reimbursed <= 0) s.unreimbursed_claims_count += 1;
    if (g.reimbursement_status === "unknown_unmatched" || g.match_confidence !== "high") {
      s.needs_reimbursement_review_count += 1;
    }
  }
  s.total_expected_recovery = round2(s.total_expected_recovery);
  s.total_confirmed_reimbursed = round2(s.total_confirmed_reimbursed);
  s.total_open_recovery_gap = round2(s.total_open_recovery_gap);
  return s;
}

/* ============================================================================
 * PHASE-CLAIM-FAMILY-AWARE-RECOVERY-MATCHING-V2
 * Family-aware classification + amount-basis policy. Pure, zero-import.
 * ========================================================================== */

export type AmountBasis =
  | "cogs_recovery"
  | "latest_sale_net"
  | "fee_delta"
  | "reimbursement_reinstatement"
  | "refund_amount"
  | "configurable_needs_policy_confirmation";

export type ClaimAmountKind = "amazon_claim_amount" | "internal_business_loss" | "configurable";

export type ClaimAmountPolicy = {
  family_key: string;
  display_name: string;
  default_claim_amount_basis: AmountBasis;
  formula: string;
  required_source_fields: string[];
  amount_kind: ClaimAmountKind;
  sale_price_allowed: boolean;
  amazon_fees_included: boolean;
  inbound_removal_handling_included: boolean;
  current_implementation_formula: string;
  recommended_correction: string;
  /** false → operator policy not confirmed → claim must be marked needs_policy_confirmation. */
  policy_resolved: boolean;
};

const COGS_FORMULA = "clean_quantity × approved_cogs_unit";
const COGS_IMPL = "recovery_value = clean_quantity × approved_cogs_unit (implemented)";

function policy(
  family_key: string,
  display_name: string,
  basis: AmountBasis,
  formula: string,
  fields: string[],
  kind: ClaimAmountKind,
  salePriceAllowed: boolean,
  feesIncluded: boolean,
  handlingIncluded: boolean,
  recommended: string,
  resolved: boolean,
): ClaimAmountPolicy {
  return {
    family_key,
    display_name,
    default_claim_amount_basis: basis,
    formula,
    required_source_fields: fields,
    amount_kind: kind,
    sale_price_allowed: salePriceAllowed,
    amazon_fees_included: feesIncluded,
    inbound_removal_handling_included: handlingIncluded,
    current_implementation_formula: basis === "cogs_recovery" ? COGS_IMPL : "not implemented (preview only)",
    recommended_correction: recommended,
    policy_resolved: resolved,
  };
}

/**
 * Read-only amount-basis policy per claim family. Physical-loss families default
 * to COGS recovery (project spec) but are marked policy_resolved=false because
 * operator (Maysam) has not confirmed COGS vs latest-sale-net vs business loss —
 * those claims are surfaced as needs_policy_confirmation, never silently chosen.
 */
export const CLAIM_AMOUNT_POLICY_MATRIX: Record<string, ClaimAmountPolicy> = {
  removal_shipment_missing: policy("removal_shipment_missing", "Removal shipment missing", "cogs_recovery", COGS_FORMULA, ["clean_quantity", "approved_cogs_unit", "removal_order_id", "removal_shipment_id"], "configurable", false, false, false, "Confirm COGS vs latest-sale-net vs business loss (COGS + inbound/removal/handling) with operator before filing.", false),
  removal_order_discrepancy: policy("removal_order_discrepancy", "Removal order discrepancy / short-shipped", "cogs_recovery", COGS_FORMULA, ["clean_quantity", "approved_cogs_unit", "removal_order_id"], "configurable", false, false, false, "Confirm amount basis; default COGS, alternative latest-sale-net.", false),
  removal_short_shipped: policy("removal_short_shipped", "Removal short shipped", "cogs_recovery", COGS_FORMULA, ["clean_quantity", "approved_cogs_unit", "removal_order_id"], "configurable", false, false, false, "Confirm amount basis.", false),
  damaged_warehouse: policy("damaged_warehouse", "Damaged in warehouse", "cogs_recovery", COGS_FORMULA, ["clean_quantity", "approved_cogs_unit", "ledger_reference_id", "reimbursement_reason"], "configurable", false, false, false, "Amazon typically reimburses at their valuation; confirm COGS vs Amazon valuation vs business loss.", false),
  lost_warehouse: policy("lost_warehouse", "Lost in warehouse", "cogs_recovery", COGS_FORMULA, ["clean_quantity", "approved_cogs_unit", "ledger_reference_id"], "configurable", false, false, false, "Confirm COGS vs Amazon valuation vs business loss.", false),
  lost_outbound: policy("lost_outbound", "Lost outbound", "cogs_recovery", COGS_FORMULA, ["clean_quantity", "approved_cogs_unit", "order_id"], "configurable", false, false, false, "Confirm basis (outbound loss often reimbursed at sale value).", false),
  damaged_outbound: policy("damaged_outbound", "Damaged outbound", "cogs_recovery", COGS_FORMULA, ["clean_quantity", "approved_cogs_unit", "order_id"], "configurable", false, false, false, "Confirm basis.", false),
  reimbursement_reversal: policy("reimbursement_reversal", "Reimbursement reversal / clawback", "reimbursement_reinstatement", "reinstated_amount = reversed_reimbursement_amount", ["reimbursement_id", "reversal_reimbursement_id", "amount"], "amazon_claim_amount", false, false, false, "Reinstate the exact reversed amount; not COGS-based.", true),
  refund_without_return: policy("refund_without_return", "Refund without return", "refund_amount", "claim_amount = refunded_amount - returned_value", ["order_id", "refund_transaction_id", "return_id"], "amazon_claim_amount", true, true, false, "Use refund/settlement amount; requires return anti-match.", true),
  customer_return_not_restocked: policy("customer_return_not_restocked", "Customer return not restocked", "cogs_recovery", COGS_FORMULA, ["return_id", "lpn", "clean_quantity", "approved_cogs_unit"], "configurable", false, false, false, "Confirm COGS vs Amazon valuation.", false),
  customer_return_not_received: policy("customer_return_not_received", "Customer return not received", "cogs_recovery", COGS_FORMULA, ["order_id", "return_id", "clean_quantity", "approved_cogs_unit"], "configurable", false, false, false, "Confirm COGS vs Amazon valuation.", false),
  fulfillment_fee_overcharge: policy("fulfillment_fee_overcharge", "Fulfillment fee overcharge", "fee_delta", "fee_overcharge = charged_fee - expected_fee", ["transaction_id", "settlement_id", "fee_type", "charged_fee", "expected_fee"], "amazon_claim_amount", false, true, false, "Requires Fee Preview / Product Fees API for expected fee; settlement for charged fee.", true),
  storage_fee_overcharge: policy("storage_fee_overcharge", "Storage fee overcharge", "fee_delta", "storage_overcharge = charged_storage - expected_storage", ["storage_fee_row", "cubic_feet", "storage_month"], "amazon_claim_amount", false, true, false, "Requires Monthly Storage Fees + PC04 volume; storage table empty.", true),
  expiration_misclassification: policy("expiration_misclassification", "Expiration misclassification", "configurable_needs_policy_confirmation", "policy TBD", ["ledger_reference_id", "expiry_date"], "configurable", false, false, false, "Basis undefined; needs operator policy.", false),
  disposed_without_authorization: policy("disposed_without_authorization", "Disposed without authorization", "cogs_recovery", COGS_FORMULA, ["ledger_reference_id", "disposition", "clean_quantity", "approved_cogs_unit"], "configurable", false, false, false, "Confirm COGS vs business loss.", false),
  inbound_discrepancy: policy("inbound_discrepancy", "Inbound discrepancy / shipment shortage", "cogs_recovery", COGS_FORMULA, ["shipment_id", "sent_qty", "received_qty", "approved_cogs_unit"], "configurable", false, false, false, "Confirm COGS vs business loss; requires Inbound Performance.", false),
  other: policy("other", "Other / unmapped", "configurable_needs_policy_confirmation", "policy TBD", [], "configurable", false, false, false, "Map to a known family and confirm policy.", false),
};

export function getClaimAmountPolicy(family: string | null): ClaimAmountPolicy {
  return CLAIM_AMOUNT_POLICY_MATRIX[family ?? "other"] ?? CLAIM_AMOUNT_POLICY_MATRIX.other;
}

/** Family groups — candidates only "belong" to a claim whose family is in the same group. */
const FAMILY_GROUP: Record<string, string> = {
  removal_shipment_missing: "removal",
  removal_order_discrepancy: "removal",
  removal_short_shipped: "removal",
  damaged_warehouse: "warehouse",
  lost_warehouse: "warehouse",
  lost_outbound: "outbound",
  damaged_outbound: "outbound",
  reimbursement_reversal: "reimbursement_adj",
  refund_without_return: "refund",
  customer_return_not_restocked: "refund",
  customer_return_not_received: "refund",
  fulfillment_fee_overcharge: "fee",
  storage_fee_overcharge: "fee",
  expiration_misclassification: "ledger_adj",
  disposed_without_authorization: "ledger_adj",
  inbound_discrepancy: "inbound",
  other: "other",
};

function familyGroupOf(family: string | null): string {
  return FAMILY_GROUP[family ?? "other"] ?? "other";
}

/**
 * Classifies a claim_family from the reason/event_type text ALONE (no group
 * fallback). Returns null when the text carries no family signal — used for
 * order-linked (strong) rows where linkage already implies the claim's family
 * unless the reason explicitly names a different one.
 */
export function classifyFamilyByReason(eventType: string | null, reason?: string | null): string | null {
  const t = `${eventType ?? ""} ${reason ?? ""}`.toLowerCase();
  if (/reversal/.test(t)) return "reimbursement_reversal";
  if (/lost.*outbound|outbound.*lost/.test(t)) return "lost_outbound";
  if (/damaged.*outbound|outbound.*damaged/.test(t)) return "damaged_outbound";
  if (/lost.*warehouse|warehouse.*lost|warehouse_lost/.test(t)) return "lost_warehouse";
  if (/damaged.*warehouse|warehouse.*damaged|warehouse_damaged/.test(t)) return "damaged_warehouse";
  if (/customer.?return/.test(t)) return "customer_return_not_received";
  if (/refund/.test(t)) return "refund_without_return";
  if (/storage/.test(t)) return "storage_fee_overcharge";
  if (/fulfil|fba.*fee|weight|dimension/.test(t)) return "fulfillment_fee_overcharge";
  if (/dispos|destroy/.test(t)) return "disposed_without_authorization";
  if (/expir/.test(t)) return "expiration_misclassification";
  if (/removal/.test(t)) return "removal_shipment_missing";
  return null;
}

/**
 * Deterministically classifies one event/candidate row into a claim_family from
 * its reason/event_type + source group. Used to detect candidates that belong to
 * a DIFFERENT family than the claim they were surfaced under.
 */
export function classifyCandidateFamily(eventType: string | null, group: string, reason?: string | null): string {
  const kw = classifyFamilyByReason(eventType, reason);
  if (kw) return kw;
  switch (group) {
    case "removal":
      return "removal_order_discrepancy";
    case "shipment_tracking":
      return "removal_shipment_missing";
    case "inventory_ledger":
      return "lost_warehouse";
    case "transaction_settlement":
      return "fulfillment_fee_overcharge";
    case "reimbursement":
      return "reimbursement_reversal";
    case "customer_return":
      return "customer_return_not_received";
    default:
      return "other";
  }
}

export type FamilyAwareAmountEstimate = {
  basis: AmountBasis;
  label: string;
  amount: number | null;
  note: string;
};

export type FamilyCandidateClassification = {
  source_label: string;
  reference_id: string;
  reason: string | null;
  amount: number | null;
  quantity: number | null;
  event_date: string | null;
  kind: RecoveryGapMatchKind;
  source_group: string;
  classified_family: string;
  belongs_to_this_claim: boolean;
  why_not: string | null;
  should_create_separate_claim: boolean;
};

export type SeparateClaimSuggestion = {
  recommended_claim_family: string;
  basis: AmountBasis;
  candidate_count: number;
  example_reference_id: string | null;
  reason: string;
};

export type ClaimFilingStatusV2 =
  | "safe_to_file"
  | "needs_policy_confirmation"
  | "needs_reference_review"
  | "do_not_file";

export type FamilyAwareRecovery = {
  claim_family: string;
  policy: ClaimAmountPolicy;
  policy_confirmed: boolean;
  policy_confirmation: { confirmed_by: string; confirmed_at: string; approval_key: string } | null;
  informational_only_bases: AmountBasis[];
  current_cogs_expected_recovery: number | null;
  latest_sold_price: number | null;
  amazon_fees: number | null;
  settlement_net: number | null;
  alternative_latest_sale_net_estimate: number | null;
  business_total_loss_estimate: number | null;
  amount_estimates: FamilyAwareAmountEstimate[];
  seller_central_amount_basis: AmountBasis;
  seller_central_amount: number | null;
  seller_central_amount_reason: string;
  confirmed_reimbursed_strong: number;
  open_gap_under_current_policy: number | null;
  open_gap_under_alternative_policy: number | null;
  candidate_classifications: FamilyCandidateClassification[];
  misclassified_candidates: FamilyCandidateClassification[];
  separate_claim_suggestions: SeparateClaimSuggestion[];
  filing_status: ClaimFilingStatusV2;
  filing_status_label: string;
  filing_status_tone: "success" | "warning" | "danger" | "neutral";
  filing_status_reason: string;
  gap: RecoveryGap;
};

const FILING_STATUS_V2_META: Record<ClaimFilingStatusV2, { label: string; tone: FamilyAwareRecovery["filing_status_tone"] }> = {
  safe_to_file: { label: "Safe to file", tone: "success" },
  needs_policy_confirmation: { label: "Needs policy confirmation", tone: "warning" },
  needs_reference_review: { label: "Needs reference review", tone: "warning" },
  do_not_file: { label: "Do not file", tone: "danger" },
};

/**
 * Family-aware recovery + amount-basis policy for one claim. Reuses the strict
 * recovery-gap engine for strong/weak matching, then (a) classifies every weak
 * candidate into its true family, (b) flags candidates that belong to a DIFFERENT
 * family (must not reduce this claim's gap; suggest a separate claim), and
 * (c) computes COGS / latest-sale-net / business-loss amount estimates without
 * silently choosing a basis.
 */
export function computeFamilyAwareRecovery(row: ReadyToFileRow): FamilyAwareRecovery {
  const gap = computeRecoveryGap(row);
  const family = row.claim_family ?? "other";
  const basePolicy = getClaimAmountPolicy(family);

  // A confirmed operator policy overlay (governed workspace_settings) supersedes the
  // static default: it resolves the basis and unblocks needs_policy_confirmation.
  const overlay = row.amount_basis_policy_overlay ?? null;
  const confirmedFamily = overlay?.families?.[family] ?? null;
  const pol: ClaimAmountPolicy = confirmedFamily
    ? {
        ...basePolicy,
        default_claim_amount_basis: confirmedFamily.basis,
        policy_resolved: true,
        current_implementation_formula:
          confirmedFamily.basis === "cogs_recovery" ? COGS_IMPL : basePolicy.current_implementation_formula,
        recommended_correction: `Confirmed by operator (${confirmedFamily.approval_key}) on ${confirmedFamily.confirmed_at}. ${confirmedFamily.note ?? ""}`.trim(),
      }
    : basePolicy;
  const policyConfirmed = confirmedFamily != null;
  const informationalOnlyBases: AmountBasis[] = confirmedFamily
    ? (confirmedFamily.informational_only.filter((b): b is AmountBasis =>
        b === "cogs_recovery" ||
        b === "latest_sale_net" ||
        b === "fee_delta" ||
        b === "reimbursement_reinstatement" ||
        b === "refund_amount" ||
        b === "configurable_needs_policy_confirmation",
      ))
    : [];
  const claimGroup = familyGroupOf(family);
  const ml = row.money_lane;
  const qty = row.clean_quantity ?? 0;

  const cogs = row.recovery_value;
  const perUnitNet =
    ml.net_settlement_amount != null
      ? ml.net_settlement_amount
      : ml.latest_sold_price != null
        ? round2(ml.latest_sold_price - (ml.amazon_fees_total ?? 0))
        : null;
  // Only a POSITIVE per-unit net is a meaningful sale-based recovery basis; negative
  // settlement nets (fee/return rows) are not estimable → null, not a negative amount.
  const altSaleNet = perUnitNet != null && perUnitNet > 0 ? round2(perUnitNet * (qty > 0 ? qty : 1)) : null;
  // Business loss floor = COGS replacement cost (inbound/removal/handling not loaded).
  const businessLoss = cogs;

  const amountEstimates: FamilyAwareAmountEstimate[] = [
    { basis: "cogs_recovery", label: "COGS recovery", amount: cogs, note: COGS_IMPL },
    {
      basis: "latest_sale_net",
      label: "Latest sale net estimate",
      amount: altSaleNet,
      note:
        altSaleNet == null
          ? "No positive latest sale net available (no sale loaded, or settlement net ≤ 0)."
          : "Estimate = (latest_sold_price − amazon_fees) × qty (or net settlement × qty). Not used unless operator policy allows sale-based recovery.",
    },
    {
      basis: "cogs_recovery",
      label: "Business total loss estimate",
      amount: businessLoss,
      note: "Floor = COGS replacement cost. Inbound/removal/handling costs not in loaded sources — true business loss may be higher.",
    },
  ];

  // Seller Central selected amount follows the policy default basis (never silently sale price).
  let scAmount: number | null;
  let scReason: string;
  switch (pol.default_claim_amount_basis) {
    case "cogs_recovery":
      scAmount = cogs;
      scReason = policyConfirmed
        ? `Operator-confirmed amount basis = COGS recovery (clean_quantity × approved COGS/unit; sale price not used). Confirmed by ${confirmedFamily?.confirmed_by ?? "operator"} (${confirmedFamily?.approval_key ?? "approved"}).`
        : "Project spec: recovery = clean_quantity × approved COGS/unit (sale price not used). Operator has not confirmed COGS vs latest-sale-net vs business loss.";
      break;
    case "latest_sale_net":
      scAmount = altSaleNet;
      scReason = "Policy basis = latest sale net.";
      break;
    default:
      scAmount = null;
      scReason = `Amount basis '${pol.default_claim_amount_basis}' requires source fields/policy not yet available (${pol.required_source_fields.join(", ") || "n/a"}).`;
  }

  const classifications: FamilyCandidateClassification[] = [];

  // Counted (order-linked / strong) matches: linkage implies this claim's family
  // UNLESS the reason explicitly names a DIFFERENT family (e.g. a Damaged_Warehouse
  // reimbursement on a removal claim). Cross-family counted rows are excluded from
  // confirmed and become separate-claim opportunities.
  const countedSources: Array<{ list: RecoveryGapMatch[]; group: string }> = [
    { list: gap.strong_reimbursement_matches, group: "reimbursement" },
    { list: gap.settlement_credit_matches, group: "transaction_settlement" },
  ];
  let confirmed = 0;
  for (const { list, group } of countedSources) {
    for (const m of list) {
      const kw = classifyFamilyByReason(m.reason, m.reason);
      const belongs = kw == null || familyGroupOf(kw) === claimGroup;
      const classified = kw ?? family;
      if (belongs) {
        confirmed += Math.max(m.amount ?? 0, 0);
      }
      classifications.push({
        source_label: m.source_label,
        reference_id: m.reference_id,
        reason: m.reason,
        amount: m.amount,
        quantity: m.quantity,
        event_date: m.event_date,
        kind: m.kind,
        source_group: group,
        classified_family: classified,
        belongs_to_this_claim: belongs,
        why_not: belongs
          ? null
          : `Order-linked ${m.source_label.toLowerCase()} ${m.reference_id} reads as '${classified}', a different family than '${family}' — it reimburses a different event and must NOT reduce this claim's gap.`,
        should_create_separate_claim: !belongs,
      });
    }
  }
  confirmed = round2(confirmed);
  const openCurrent = scAmount != null ? Math.max(round2(scAmount - confirmed), 0) : gap.open_recovery_gap;
  const openAlt = altSaleNet != null ? Math.max(round2(altSaleNet - confirmed), 0) : null;

  // Weak candidates (FNSKU/date-window only): classify into true family; never counted.
  const weakSources: Array<{ list: RecoveryGapMatch[]; group: string }> = [
    { list: gap.weak_reimbursement_candidates, group: "reimbursement" },
    { list: gap.weak_transaction_candidates, group: "transaction_settlement" },
    { list: gap.inventory_ledger_candidates, group: "inventory_ledger" },
    { list: gap.strong_transaction_matches, group: "transaction_settlement" },
  ];
  for (const { list, group } of weakSources) {
    for (const m of list) {
      const classified = classifyCandidateFamily(m.reason, group, m.reason);
      const belongs = familyGroupOf(classified) === claimGroup;
      classifications.push({
        source_label: m.source_label,
        reference_id: m.reference_id,
        reason: m.reason,
        amount: m.amount,
        quantity: m.quantity,
        event_date: m.event_date,
        kind: m.kind,
        source_group: group,
        classified_family: classified,
        belongs_to_this_claim: belongs,
        why_not: belongs
          ? `Weak FNSKU/date-window candidate — same family ('${classified}') but not tied to this removal order/shipment/tracking event; shown only, never counted.`
          : `${m.reason ?? m.source_label} classifies as '${classified}', a different family than '${family}', and is not tied to this event — excluded from this claim.`,
        should_create_separate_claim: !belongs,
      });
    }
  }
  const misclassified = classifications.filter((c) => !c.belongs_to_this_claim);

  // Group misclassified candidates into separate-claim suggestions.
  const byFamily = new Map<string, FamilyCandidateClassification[]>();
  for (const c of misclassified) {
    const arr = byFamily.get(c.classified_family) ?? [];
    arr.push(c);
    byFamily.set(c.classified_family, arr);
  }
  const separateSuggestions: SeparateClaimSuggestion[] = [];
  for (const [fam, items] of byFamily) {
    separateSuggestions.push({
      recommended_claim_family: fam,
      basis: getClaimAmountPolicy(fam).default_claim_amount_basis,
      candidate_count: items.length,
      example_reference_id: items[0]?.reference_id ?? null,
      reason: `${items.length} candidate(s) (${items[0]?.reason ?? "—"}) belong to '${fam}', not '${family}'. Generate a separate claim opportunity instead of reducing this claim's gap.`,
    });
  }

  // Filing status: policy gate first, then reference decision.
  const decision = computeFilingDecision(row);
  let status: ClaimFilingStatusV2;
  let statusReason: string;
  if (!pol.policy_resolved) {
    status = "needs_policy_confirmation";
    statusReason = `Amount basis for '${family}' not confirmed by operator (default ${pol.default_claim_amount_basis}). ${pol.recommended_correction}`;
  } else if (decision.decision === "do_not_file") {
    status = "do_not_file";
    statusReason = decision.reason;
  } else if (decision.decision === "needs_reference_review") {
    status = "needs_reference_review";
    statusReason = decision.reason;
  } else {
    status = "safe_to_file";
    statusReason = decision.reason;
  }
  const statusMeta = FILING_STATUS_V2_META[status];

  return {
    claim_family: family,
    policy: pol,
    policy_confirmed: policyConfirmed,
    policy_confirmation: confirmedFamily
      ? {
          confirmed_by: confirmedFamily.confirmed_by,
          confirmed_at: confirmedFamily.confirmed_at,
          approval_key: confirmedFamily.approval_key,
        }
      : null,
    informational_only_bases: informationalOnlyBases,
    current_cogs_expected_recovery: cogs,
    latest_sold_price: ml.latest_sold_price,
    amazon_fees: ml.amazon_fees_total,
    settlement_net: ml.net_settlement_amount,
    alternative_latest_sale_net_estimate: altSaleNet,
    business_total_loss_estimate: businessLoss,
    amount_estimates: amountEstimates,
    seller_central_amount_basis: pol.default_claim_amount_basis,
    seller_central_amount: scAmount,
    seller_central_amount_reason: scReason,
    confirmed_reimbursed_strong: confirmed,
    open_gap_under_current_policy: openCurrent,
    open_gap_under_alternative_policy: openAlt,
    candidate_classifications: classifications,
    misclassified_candidates: misclassified,
    separate_claim_suggestions: separateSuggestions,
    filing_status: status,
    filing_status_label: statusMeta.label,
    filing_status_tone: statusMeta.tone,
    filing_status_reason: statusReason,
    gap,
  };
}

export type FamilyAwareRecoverySummary = {
  total_claims: number;
  total_cogs_recovery: number;
  total_latest_sale_net_estimate: number;
  total_business_loss_estimate: number;
  confirmed_reimbursed_total: number;
  weak_candidates_total: number;
  weak_candidates_excluded_total: number;
  separate_claim_candidate_suggestions: number;
  safe_to_file_count: number;
  needs_policy_confirmation_count: number;
  needs_reference_review_count: number;
  do_not_file_count: number;
};

export function summarizeFamilyAwareRecovery(rows: ReadyToFileRow[]): FamilyAwareRecoverySummary {
  const s: FamilyAwareRecoverySummary = {
    total_claims: rows.length,
    total_cogs_recovery: 0,
    total_latest_sale_net_estimate: 0,
    total_business_loss_estimate: 0,
    confirmed_reimbursed_total: 0,
    weak_candidates_total: 0,
    weak_candidates_excluded_total: 0,
    separate_claim_candidate_suggestions: 0,
    safe_to_file_count: 0,
    needs_policy_confirmation_count: 0,
    needs_reference_review_count: 0,
    do_not_file_count: 0,
  };
  for (const row of rows) {
    const fa = computeFamilyAwareRecovery(row);
    s.total_cogs_recovery += fa.current_cogs_expected_recovery ?? 0;
    s.total_latest_sale_net_estimate += fa.alternative_latest_sale_net_estimate ?? 0;
    s.total_business_loss_estimate += fa.business_total_loss_estimate ?? 0;
    s.confirmed_reimbursed_total += fa.confirmed_reimbursed_strong;
    s.weak_candidates_total += fa.candidate_classifications.length;
    s.weak_candidates_excluded_total += fa.misclassified_candidates.length;
    s.separate_claim_candidate_suggestions += fa.separate_claim_suggestions.length;
    if (fa.filing_status === "safe_to_file") s.safe_to_file_count += 1;
    else if (fa.filing_status === "needs_policy_confirmation") s.needs_policy_confirmation_count += 1;
    else if (fa.filing_status === "needs_reference_review") s.needs_reference_review_count += 1;
    else s.do_not_file_count += 1;
  }
  s.total_cogs_recovery = round2(s.total_cogs_recovery);
  s.total_latest_sale_net_estimate = round2(s.total_latest_sale_net_estimate);
  s.total_business_loss_estimate = round2(s.total_business_loss_estimate);
  s.confirmed_reimbursed_total = round2(s.confirmed_reimbursed_total);
  return s;
}
