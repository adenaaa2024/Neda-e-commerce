/**
 * PHASE-CLAIM-CASE-REVIEW-UI-V1
 * Read-only UI contract for Claim Center pilot case review.
 */
import type {
  ClaimCaseReviewQuery,
  ClaimCaseReviewRow,
  ClaimCaseReviewSummary,
} from "./claim-case-review-readmodel";
import { FAMILY_FILTER_OPTIONS } from "@/lib/claims/grouping/claim-grouping-ui-contract";

export const CLAIM_CASE_REVIEW_UI_VERSION = "claim-case-review-ui-v1" as const;

/** Pilot execute run from PHASE-CLAIM-CASE-CREATION-PILOT-V1. */
export const DEFAULT_PILOT_CASE_RUN_ID = "pilot-20260615T190000Z";

/** Original emit pilot intake run (cap 50). */
export const DEFAULT_CASE_REVIEW_INTAKE_RUN_ID = "a8a892fe-37d5-4d74-9ea2-02af8fd095ce";

export type ClaimCaseReviewFilterState = {
  pilot_case_run_id: string;
  intake_run_id: string;
  family_key_v3: string;
  claim_family: string;
  source_event_key: string;
  status: string;
  product_query: string;
  date_from: string;
  date_to: string;
};

export const DEFAULT_CASE_REVIEW_FILTER_STATE: ClaimCaseReviewFilterState = {
  pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
  intake_run_id: DEFAULT_CASE_REVIEW_INTAKE_RUN_ID,
  family_key_v3: "",
  claim_family: "",
  source_event_key: "",
  status: "open",
  product_query: "",
  date_from: "",
  date_to: "",
};

export const CASE_REVIEW_FAMILY_OPTIONS = FAMILY_FILTER_OPTIONS;

export const CASE_REVIEW_STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
] as const;

export const CASE_REVIEW_DISABLED_ACTIONS = [
  { id: "submit_claim", label: "Submit claim" },
  { id: "generate_pdf", label: "Generate PDF" },
  { id: "create_submission", label: "Create submission" },
  { id: "mark_as_filed", label: "Mark as filed" },
  { id: "upload_evidence", label: "Upload evidence" },
  { id: "close_case", label: "Close case" },
  { id: "cancel_case", label: "Cancel case" },
  { id: "edit_case", label: "Edit case" },
] as const;

export const CASE_REVIEW_TABLE_COLUMNS = [
  "case_id",
  "idempotency_key",
  "claim_family",
  "source_event_key",
  "candidate_ids",
  "product_identifiers",
  "quantity",
  "money_lanes",
  "status",
  "created_at",
] as const;

export const CASE_REVIEW_SUMMARY_CARDS = [
  "total_pilot_cases",
  "family_distribution",
  "open_cases",
  "total_clean_quantity",
  "money_lane_availability",
  "warnings",
] as const;

export const CASE_REVIEW_DETAIL_DRAWER_FIELDS = [
  "case_metadata",
  "lines",
  "candidate_link",
  "evidence_packet_snapshot",
  "reference_edges",
  "operator_attestation",
  "filing_packet",
  "manual_filing_handoff",
  "rollback_metadata",
] as const;

export const CASE_REVIEW_FILING_PACKET_API_PATH = "/api/claims/center/filing-packet-preview" as const;

export const CASE_REVIEW_API_PATH = "/api/claims/center/case-review" as const;

export function caseReviewApiParams(
  filters: ClaimCaseReviewFilterState,
): Record<string, string> {
  const params: Record<string, string> = {
    pilot_case_run_id: filters.pilot_case_run_id,
    intake_run_id: filters.intake_run_id,
  };
  if (filters.family_key_v3) params.family_key_v3 = filters.family_key_v3;
  if (filters.claim_family) params.claim_family = filters.claim_family;
  if (filters.source_event_key) params.source_event_key = filters.source_event_key;
  if (filters.status) params.status = filters.status;
  if (filters.product_query) params.product_query = filters.product_query;
  if (filters.date_from) params.date_from = filters.date_from;
  if (filters.date_to) params.date_to = filters.date_to;
  return params;
}

export function summarizeCaseReviewRows(rows: ClaimCaseReviewRow[]): ClaimCaseReviewSummary {
  const by_family_key_v3: Record<string, number> = {};
  let open_cases = 0;
  let total_clean_quantity = 0;
  let warning_count = 0;
  const money_lane_availability = {
    estimated_amazon_payout: 0,
    observed_reimbursement: 0,
    internal_cost_loss: 0,
    recovery_value: 0,
  };

  for (const r of rows) {
    const fam = r.family_key_v3 ?? "unknown";
    by_family_key_v3[fam] = (by_family_key_v3[fam] ?? 0) + 1;
    if (r.status === "open") open_cases += 1;
    total_clean_quantity += r.clean_quantity ?? r.quantity_expected ?? 0;
    warning_count += r.warnings.length;
    for (const key of Object.keys(money_lane_availability) as Array<
      keyof typeof money_lane_availability
    >) {
      if (r.money_lanes[key] != null) money_lane_availability[key] += 1;
    }
  }

  return {
    total_pilot_cases: rows.length,
    open_cases,
    by_family_key_v3,
    total_clean_quantity,
    money_lane_availability,
    warning_count,
  };
}

export function formatCaseReviewMoney(value: unknown, currency = "USD"): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

export function verifyCaseReviewDisplay(row: ClaimCaseReviewRow): {
  pass: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!row.id) missing.push("case_id");
  if (!row.idempotency_key) missing.push("idempotency_key");
  if (!row.family_key_v3) missing.push("family_key_v3");
  if (!row.source_event_key) missing.push("source_event_key");
  if (row.candidate_ids.length === 0) missing.push("candidate_ids");
  if (!row.evidence_packet_snapshot) missing.push("evidence_packet_snapshot");
  if (!row.operator_review_attested) missing.push("operator_review_attested");
  return { pass: missing.length === 0, missing };
}

export function caseReviewFiltersSupported(): string[] {
  return [
    "pilot_case_run_id",
    "intake_run_id",
    "family_key_v3",
    "claim_family",
    "source_event_key",
    "status",
    "product_query",
    "date_from",
    "date_to",
  ];
}

export type { ClaimCaseReviewQuery };
