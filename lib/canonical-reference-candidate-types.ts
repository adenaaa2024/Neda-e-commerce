/**
 * TRID-REFERENCE-GRAPH-IMPLEMENT-V170 — Canonical reference candidate types (V169 contract).
 */

import * as crypto from "node:crypto";

import type { TridCandidateOutcome } from "./claim-trid-candidates-types";

export type ReferenceType =
  | "internal_trid_key"
  | "settlement_id"
  | "settlement_line"
  | "transaction_id"
  | "reimbursement_id"
  | "amazon_event_id"
  | "event_group_id"
  | "adjustment_id"
  | "shipment_id"
  | "removal_order_id"
  | "order_id"
  | "ledger_reference_id"
  | "safet_claim_id"
  | "lpn"
  | "unknown";

export type ClaimCaseJoinReason =
  | "draft_source_anchor"
  | "order_id_exact"
  | "order_id_and_sku"
  | "removal_order_id"
  | "reimbursement_id"
  | "amount_date_window"
  | "settlement_id_group"
  | "shipment_tracking"
  | "product_identifier"
  | "report_lineage_upload"
  | "operator_selected"
  | "manual_unlinked";

export type ReferenceCandidateLineage = {
  source_upload_id: string | null;
  source_run_id: string | null;
  report_kind: string | null;
  source_table: string;
  source_row_id: string;
  source_citations: { kind: string; table: string; row_id?: string }[];
};

export type CanonicalReferenceCandidate = {
  reference_value: string;
  reference_type: ReferenceType;
  source_table: string;
  source_row_id: string;
  source_upload_id: string | null;
  source_run_id: string | null;
  report_kind: string | null;
  event_date: string | null;
  amount: number | null;
  currency: string | null;
  transaction_type: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  product_id: string | null;
  order_id: string | null;
  settlement_id: string | null;
  shipment_id: string | null;
  removal_order_id: string | null;
  confidence: number;
  ambiguity_group_key: string | null;
  ambiguity_rank: number | null;
  claim_case_join_reason: ClaimCaseJoinReason;
  linked_draft_id: string | null;
  linked_edge_id: string | null;
  enrichment_generation_id: string | null;
  reference_ids_extra: Record<string, string>;
  candidate_key: string;
  lineage: ReferenceCandidateLineage;
  operator_selected: boolean;
};

export type ReferenceCandidatesResponse = {
  schema_version: "trid-reference-candidates-v1";
  draft_id: string;
  organization_id: string;
  claim_candidate_id: string | null;
  outcome: TridCandidateOutcome;
  candidate_count: number;
  candidate_count_returned: number;
  truncated: boolean;
  candidates: CanonicalReferenceCandidate[];
  operational: {
    source_table: string;
    source_row_id: string;
    order_id: string | null;
    sku: string | null;
    fnsku: string | null;
    operational_upload_id: string | null;
  } | null;
  warnings: { code: string; message: string; severity: "info" | "warn" | "error" }[];
  does_not_submit: true;
};

export function buildCandidateDedupeKey(parts: {
  reference_value: string;
  source_table: string;
  source_row_id: string;
}): string {
  return `${parts.reference_value}\0${parts.source_table}\0${parts.source_row_id}`;
}

export function buildCandidateKey(parts: {
  reference_type: ReferenceType;
  reference_value: string;
  source_table: string;
  source_row_id: string;
}): string {
  const body = [parts.reference_type, parts.reference_value, parts.source_table, parts.source_row_id].join("\0");
  return crypto.createHash("sha256").update(body).digest("hex").slice(0, 32);
}

export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
