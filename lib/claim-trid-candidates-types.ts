/**
 * NEXT-CLAIM-TRID-03 — Shared types for TRID / FRR candidate projection (read-only contracts).
 * No I/O: safe to import from API routes, loaders, and UI in follow-up prompts.
 */

/** Mirrors TRID-02 dry-run outcome labels + operational gaps. */
export type TridCandidateOutcome =
  | "deterministic_single"
  | "ambiguous_multiple"
  | "missing_frr"
  | "no_order_id"
  | "missing_operational_row";

export type TridSelectionStatus =
  | "none"
  | "pending_operator"
  | "operator_selected"
  | "skipped_no_reference";

export const OPERATOR_TRID_SELECTION_RECORDED_EVENT = "operator_trid_selection_recorded" as const;

export type OperatorTridSelectionStatus = "operator_selected";

/** One row from `financial_reference_resolver` exposed to operators (subset). */
export type FinancialReferenceCandidate = {
  trid_key: string;
  source_table: string | null;
  source_row_id: string | null;
  settlement_id: string | null;
  order_id: string | null;
  sku: string | null;
  confidence_score: number | null;
  reference_group_key: string | null;
  transaction_type: string | null;
};

/** Read-only API / loader response for a single draft (and optional work item). */
export type TridCandidatesProjection = {
  draft_id: string;
  work_item_id: string | null;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  order_id: string | null;
  sku_hint: string | null;
  outcome: TridCandidateOutcome;
  frr_count_all_order: number;
  frr_count_after_sku_filter: number;
  trid_candidates: FinancialReferenceCandidate[];
  /** Highest resolver confidence among candidates, if any. */
  confidence: number | null;
  /** Provenance for debugging (e.g. TRID-02 run folder). */
  source_citations: {
    kind: "dry_run_artifact" | "live_query";
    ref: string;
  }[];
};

/** Nested under `claim_filing_requests.payload.trid` (see filing-payload-contract.md). */
export type TridFilingPayloadExtension = {
  trid_candidates?: FinancialReferenceCandidate[];
  trid_operator_selected?: FinancialReferenceCandidate | null;
  trid_selection_status?: TridSelectionStatus;
  trid_selected_by?: string | null;
  trid_selected_at?: string | null;
  trid_source_run_id?: string | null;
  reference_graph_generation?: number | null;
};

export type OperatorTridSelectionEventPayload = {
  action: typeof OPERATOR_TRID_SELECTION_RECORDED_EVENT;
  draft_id: string;
  work_item_id: string;
  selected_reference_value: string;
  selected_reference_kind: string;
  selected_source_table: string;
  selected_source_row_id: string;
  selected_confidence: number;
  selected_reason: string;
  candidate_count: number;
  selection_status: OperatorTridSelectionStatus;
  source_run_id: string;
};

function isUuidish(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function readStringField(obj: Record<string, unknown>, key: keyof OperatorTridSelectionEventPayload): string {
  return typeof obj[key] === "string" ? obj[key].trim() : "";
}

/**
 * Validates the compact append-only audit payload for operator-selected TRID references.
 * This intentionally does not query FRR or mutate state; callers should validate org/work-item scope separately.
 */
export function validateOperatorTridSelectionEventPayload(
  input: unknown,
  expected: { workItemId: string; draftId: string },
): { ok: true; payload: OperatorTridSelectionEventPayload } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "trid_selection must be an object." };
  }

  const obj = input as Record<string, unknown>;
  const draftId = readStringField(obj, "draft_id");
  const workItemId = readStringField(obj, "work_item_id");
  const selectedReferenceValue = readStringField(obj, "selected_reference_value");
  const selectedReferenceKind = readStringField(obj, "selected_reference_kind");
  const selectedSourceTable = readStringField(obj, "selected_source_table");
  const selectedSourceRowId = readStringField(obj, "selected_source_row_id");
  const selectedReason = readStringField(obj, "selected_reason").slice(0, 2000);
  const selectionStatus = readStringField(obj, "selection_status");
  const sourceRunId = readStringField(obj, "source_run_id").slice(0, 200);

  if (!isUuidish(draftId)) return { ok: false, error: "trid_selection.draft_id must be a UUID." };
  if (!isUuidish(workItemId)) return { ok: false, error: "trid_selection.work_item_id must be a UUID." };
  if (draftId !== expected.draftId) return { ok: false, error: "trid_selection.draft_id must match the work item draft." };
  if (workItemId !== expected.workItemId) return { ok: false, error: "trid_selection.work_item_id must match the route work item." };
  if (!selectedReferenceValue) return { ok: false, error: "trid_selection.selected_reference_value is required." };
  if (!selectedReferenceKind) return { ok: false, error: "trid_selection.selected_reference_kind is required." };
  if (!selectedSourceTable) return { ok: false, error: "trid_selection.selected_source_table is required." };
  if (!selectedSourceRowId) return { ok: false, error: "trid_selection.selected_source_row_id is required." };
  if (!selectedReason) return { ok: false, error: "trid_selection.selected_reason is required." };
  if (selectionStatus !== "operator_selected") {
    return { ok: false, error: "trid_selection.selection_status must be operator_selected." };
  }
  if (!sourceRunId) return { ok: false, error: "trid_selection.source_run_id is required." };

  const selectedConfidenceRaw = obj.selected_confidence;
  const selectedConfidence =
    typeof selectedConfidenceRaw === "number" ? selectedConfidenceRaw : Number(selectedConfidenceRaw);
  if (!Number.isFinite(selectedConfidence) || selectedConfidence < 0 || selectedConfidence > 1) {
    return { ok: false, error: "trid_selection.selected_confidence must be a number between 0 and 1." };
  }

  const candidateCountRaw = obj.candidate_count;
  const candidateCount = typeof candidateCountRaw === "number" ? candidateCountRaw : Number(candidateCountRaw);
  if (!Number.isInteger(candidateCount) || candidateCount < 1) {
    return { ok: false, error: "trid_selection.candidate_count must be a positive integer." };
  }

  return {
    ok: true,
    payload: {
      action: OPERATOR_TRID_SELECTION_RECORDED_EVENT,
      draft_id: draftId,
      work_item_id: workItemId,
      selected_reference_value: selectedReferenceValue.slice(0, 512),
      selected_reference_kind: selectedReferenceKind.slice(0, 120),
      selected_source_table: selectedSourceTable.slice(0, 120),
      selected_source_row_id: selectedSourceRowId.slice(0, 512),
      selected_confidence: selectedConfidence,
      selected_reason: selectedReason,
      candidate_count: candidateCount,
      selection_status: "operator_selected",
      source_run_id: sourceRunId,
    },
  };
}
