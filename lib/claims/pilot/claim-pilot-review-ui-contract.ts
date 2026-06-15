/**
 * PHASE-CLAIM-CANDIDATE-REVIEW-UI-ORIGINAL-PILOT-V1
 * Read-only UI contract for Claim Center original pilot review.
 */
import type { ClaimPilotReviewQuery, ClaimPilotReviewRow, ClaimPilotReviewSummary } from "./claim-pilot-review-readmodel";
import { DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID } from "./claim-pilot-review-readmodel";
import {
  FAMILY_FILTER_OPTIONS,
  SOURCE_KIND_FILTER_OPTIONS,
} from "@/lib/claims/grouping/claim-grouping-ui-contract";

export const CLAIM_PILOT_REVIEW_UI_VERSION = "claim-pilot-review-ui-v1" as const;

export type ClaimPilotReviewFilterState = {
  intake_run_id: string;
  family_key_v3: string;
  claim_family: string;
  source_kind: string;
  candidate_status: string;
  evidence_status: string;
  product_query: string;
  source_event_key: string;
  date_from: string;
  date_to: string;
};

export const DEFAULT_PILOT_REVIEW_FILTER_STATE: ClaimPilotReviewFilterState = {
  intake_run_id: DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
  family_key_v3: "",
  claim_family: "",
  source_kind: "",
  candidate_status: "",
  evidence_status: "",
  product_query: "",
  source_event_key: "",
  date_from: "",
  date_to: "",
};

export const PILOT_REVIEW_FAMILY_OPTIONS = FAMILY_FILTER_OPTIONS;
export const PILOT_REVIEW_SOURCE_OPTIONS = SOURCE_KIND_FILTER_OPTIONS;

export const PILOT_REVIEW_CANDIDATE_STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "detected", label: "Detected" },
  { value: "superseded", label: "Superseded" },
] as const;

export const PILOT_REVIEW_EVIDENCE_STATUS_OPTIONS = [
  { value: "", label: "All evidence" },
  { value: "missing", label: "Missing" },
  { value: "partial", label: "Partial" },
  { value: "complete", label: "Complete" },
] as const;

export const PILOT_REVIEW_DISABLED_ACTIONS = [
  { id: "approve", label: "Approve" },
  { id: "reject", label: "Reject" },
  { id: "create_case", label: "Create case" },
  { id: "build_pdf", label: "Build PDF" },
  { id: "submit_claim", label: "Submit claim" },
] as const;

export const PILOT_REVIEW_TABLE_COLUMNS = [
  "candidate_id",
  "family_key_v3",
  "claim_family",
  "source_kind",
  "source_event_key",
  "product_identifiers",
  "quantity",
  "amount_fields",
  "source_event_date",
  "effective_date",
  "date_gate_passed",
  "evidence_status",
  "reference_edges",
  "evidence_pointers",
  "review_flags",
] as const;

export const PILOT_REVIEW_DETAIL_DRAWER_FIELDS = [
  "source_row_pointers",
  "trid_reference_edges",
  "evidence_summary",
  "rollback_metadata",
  "dedupe_key",
  "emit_metadata",
  "money_lanes",
] as const;

export function pilotReviewApiParams(filters: ClaimPilotReviewFilterState): Record<string, string> {
  const params: Record<string, string> = {
    intake_run_id: filters.intake_run_id || DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: "100",
  };
  if (filters.family_key_v3) params.family_key_v3 = filters.family_key_v3;
  if (filters.claim_family) params.claim_family = filters.claim_family;
  if (filters.source_kind) params.source_kind = filters.source_kind;
  if (filters.candidate_status) params.candidate_status = filters.candidate_status;
  if (filters.evidence_status) params.evidence_status = filters.evidence_status;
  if (filters.product_query) params.product_query = filters.product_query;
  if (filters.source_event_key) params.source_event_key = filters.source_event_key;
  if (filters.date_from) params.date_from = filters.date_from;
  if (filters.date_to) params.date_to = filters.date_to;
  return params;
}

export function filterStateFromSearchParams(sp: URLSearchParams): ClaimPilotReviewFilterState {
  return {
    ...DEFAULT_PILOT_REVIEW_FILTER_STATE,
    intake_run_id: sp.get("intake_run_id")?.trim() || DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
    family_key_v3: sp.get("family_key_v3")?.trim() ?? "",
    claim_family: sp.get("claim_family")?.trim() ?? "",
  };
}

export function summarizePilotReviewRows(rows: ClaimPilotReviewRow[]): ClaimPilotReviewSummary {
  const by_family_key_v3: Record<string, number> = {};
  const by_claim_family: Record<string, number> = {};
  const by_evidence_status: Record<string, number> = {};
  const by_source_kind: Record<string, number> = {};
  let detected_count = 0;
  let date_gate_passed_count = 0;
  let missing_evidence_count = 0;

  for (const r of rows) {
    const fam = r.family_key_v3 ?? "unknown";
    by_family_key_v3[fam] = (by_family_key_v3[fam] ?? 0) + 1;
    const cf = r.claim_family ?? "unknown";
    by_claim_family[cf] = (by_claim_family[cf] ?? 0) + 1;
    const es = r.evidence_status ?? "unknown";
    by_evidence_status[es] = (by_evidence_status[es] ?? 0) + 1;
    const sk = r.source_kind ?? "unknown";
    by_source_kind[sk] = (by_source_kind[sk] ?? 0) + 1;
    if (r.candidate_status === "detected") detected_count += 1;
    if (r.date_gate_passed) date_gate_passed_count += 1;
    if (r.evidence_status === "missing") missing_evidence_count += 1;
  }

  return {
    total_pilot_candidates: rows.length,
    detected_count,
    by_family_key_v3,
    by_claim_family,
    by_evidence_status,
    date_gate_passed_count,
    missing_evidence_count,
    by_source_kind,
  };
}

export function familyDistributionMatchesExpected(summary: ClaimPilotReviewSummary): boolean {
  return (
    summary.by_family_key_v3.removal_shipment_missing === 30 &&
    summary.by_family_key_v3.removal_order_discrepancy === 20
  );
}

export function toReadmodelQuery(filters: ClaimPilotReviewFilterState): ClaimPilotReviewQuery {
  return {
    intake_run_id: filters.intake_run_id,
    family_key_v3: filters.family_key_v3 || null,
    claim_family: filters.claim_family || null,
    source_kind: filters.source_kind || null,
    candidate_status: filters.candidate_status || null,
    evidence_status: filters.evidence_status || null,
    product_query: filters.product_query || null,
    source_event_key: filters.source_event_key || null,
    date_from: filters.date_from || null,
    date_to: filters.date_to || null,
    limit: 100,
  };
}

export function productIdentifierLabel(row: ClaimPilotReviewRow): string {
  const parts = [row.asin, row.fnsku, row.sku].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (row.resolved_product_id) return row.resolved_product_id.slice(0, 8) + "…";
  return "—";
}

export function formatPilotMoney(value: number | null, currency: string | null): string {
  if (value == null) return "—";
  const cur = currency ?? "USD";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(value);
}
