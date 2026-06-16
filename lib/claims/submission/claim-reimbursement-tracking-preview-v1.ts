/**
 * PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1
 * Read-only financial / reimbursement tracking preview for pilot claim_submissions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimCaseReviewRow } from "../pilot/claim-case-review-readmodel";
import { buildClaimCaseReviewReadmodel } from "../pilot/claim-case-review-readmodel";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import {
  extractClaimCaseIdFromSubmission,
  loadExistingPilotSubmissions,
  SUBMISSION_RECORD_PILOT_ORIGIN,
  type ExistingPilotSubmission,
} from "./claim-submission-record-pilot-v1";

export const CLAIM_REIMBURSEMENT_TRACKING_PREVIEW_V1_VERSION =
  "claim-reimbursement-tracking-preview-v1" as const;

export const SUBMISSION_EXECUTE_EVIDENCE_GLOB =
  ".cursor/audit-reports/phase-claim-submission-record-pilot-execute-v1" as const;

export type ReimbursementTrackingStatus =
  | "draft_not_filed"
  | "ready_for_manual_filing"
  | "manually_filed_pending_external_id"
  | "filed_waiting_for_amazon"
  | "reimbursed"
  | "partially_reimbursed"
  | "rejected"
  | "evidence_requested"
  | "needs_follow_up"
  | "closed_no_reimbursement";

export type MatchConfidence = "high" | "medium" | "low" | "none";

export type LinkedFinancialRow = {
  id: string;
  source_table: "amazon_reimbursements" | "amazon_transactions" | "amazon_settlements";
  reference_key: string | null;
  order_id: string | null;
  amount: number | null;
  currency: string | null;
  posted_date: string | null;
  match_reason: string;
  matched: boolean;
};

export type ReimbursementMatchCandidate = LinkedFinancialRow & {
  claim_submission_id: string;
  claim_case_id: string;
  confidence: MatchConfidence;
};

export type ReimbursementTrackingPreviewRow = {
  claim_submission_id: string;
  claim_case_id: string;
  submission_mode: string | null;
  submission_status: string | null;
  claim_family: string | null;
  family_key_v3: string | null;
  source_event_key: string | null;
  source_event_date: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  product_identity: {
    asin: string | null;
    fnsku: string | null;
    sku: string | null;
    resolved_product_id: string | null;
  };
  clean_quantity: number | null;
  reference_edges_summary: Array<{ kind: string; value: string }>;
  estimated_amount: number | null;
  recovery_value: number | null;
  observed_reimbursement: number | null;
  financial_gap: number | null;
  money_warnings: string[];
  money_lanes: Record<string, unknown>;
  export_artifact_paths: Record<string, unknown> | null;
  future_amazon_case_id: string | null;
  reimbursement_tracking_status: ReimbursementTrackingStatus;
  linked_reimbursement_rows: LinkedFinancialRow[];
  linked_transaction_rows: LinkedFinancialRow[];
  linked_settlement_rows: LinkedFinancialRow[];
  linked_reimbursement_count: number;
  match_confidence: MatchConfidence;
  follow_up_needed: boolean;
  not_submitted_to_amazon: boolean;
  claim_lines: Array<{
    claim_line_id: string;
    claim_candidate_id: string | null;
    quantity_expected: number | null;
    status: string | null;
  }>;
  detail_preview: {
    reference_graph_lines: Array<{ kind: string; value: string; source: string }>;
    reimbursement_match_candidates: ReimbursementMatchCandidate[];
    financial_gap_explanation: string;
    warnings: string[];
    blockers: string[];
  };
};

export type LegacySubmissionVisibility = {
  count: number;
  excluded_from_pilot_preview: true;
  ids: string[];
  note: string;
};

export type TrackingSummaryCards = {
  pilot_submission_count: number;
  draft_submissions: number;
  ready_for_manual_filing: number;
  matched_reimbursements: number;
  unmatched_submissions: number;
  estimated_recoverable_total: number | null;
  observed_reimbursement_total: number | null;
  remaining_open_amount_total: number | null;
};

const REIMBURSEMENT_SELECT =
  "id, organization_id, store_id, order_id, reimbursement_id, case_id, sku, fnsku, asin, amount_total, currency_unit, approval_date, reason";

const TRANSACTION_SELECT =
  "id, organization_id, store_id, order_id, amount, currency, posted_date, transaction_type";

const SETTLEMENT_SELECT =
  "id, organization_id, store_id, order_id, amount, currency, posted_date, settlement_id";

const MONEY_LANE_KEYS = [
  "estimated_amazon_payout",
  "expected_amount",
  "recovery_value",
  "observed_reimbursement",
  "internal_cost_loss",
  "sale_price_display_only",
  "currency",
] as const;

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normId(v: unknown): string | null {
  const s = str(v);
  return s || null;
}

function identifierGuard(args: {
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  joinKeys: ReturnType<typeof extractJoinKeys>;
}): boolean {
  const hasSecondary =
    (args.sku && args.joinKeys.skus.has(args.sku)) ||
    (args.fnsku && args.joinKeys.fnskus.has(args.fnsku)) ||
    (args.asin && args.joinKeys.asins.has(args.asin));
  if (!hasSecondary) return false;
  return args.joinKeys.skus.size > 0 || args.joinKeys.fnskus.size > 0 || args.joinKeys.asins.size > 0;
}

export function findLatestSubmissionExecuteEvidence(cwd: string, fs: {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory: () => boolean };
  readFileSync: (p: string, enc: BufferEncoding) => string;
}): { path: string; safe_pilot: string; safe_reimbursement_preview: string } {
  const base = `${cwd}/${SUBMISSION_EXECUTE_EVIDENCE_GLOB}`;
  if (!fs.existsSync(base)) {
    return {
      path: `${SUBMISSION_EXECUTE_EVIDENCE_GLOB}/missing/results.json`,
      safe_pilot: "missing",
      safe_reimbursement_preview: "missing",
    };
  }
  const runs = fs
    .readdirSync(base)
    .filter((d) => fs.statSync(`${base}/${d}`).isDirectory())
    .sort()
    .reverse();
  if (runs.length === 0) {
    return {
      path: `${SUBMISSION_EXECUTE_EVIDENCE_GLOB}/missing/results.json`,
      safe_pilot: "missing",
      safe_reimbursement_preview: "missing",
    };
  }
  const rel = `${SUBMISSION_EXECUTE_EVIDENCE_GLOB}/${runs[0]}/results.json`;
  const data = JSON.parse(fs.readFileSync(`${cwd}/${rel}`, "utf8")) as Record<string, unknown>;
  return {
    path: rel,
    safe_pilot: str(data.SAFE_CLAIM_SUBMISSION_RECORD_PILOT),
    safe_reimbursement_preview: str(data.SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_PREVIEW),
  };
}

export function isPilotSubmissionRecord(
  row: ExistingPilotSubmission,
  pilotCaseRunId: string,
  intakeRunId: string,
): boolean {
  const payload = metaRecord(row.source_payload);
  if (str(payload.submission_record_origin) !== SUBMISSION_RECORD_PILOT_ORIGIN) return false;
  if (str(payload.pilot_case_run_id) && str(payload.pilot_case_run_id) !== pilotCaseRunId) return false;
  if (str(payload.intake_run_id) && str(payload.intake_run_id) !== intakeRunId) return false;
  return Boolean(extractClaimCaseIdFromSubmission(row));
}

export function extractJoinKeys(args: {
  submission: ExistingPilotSubmission;
  caseRow: ClaimCaseReviewRow | null;
}): {
  claim_case_ids: Set<string>;
  claim_submission_ids: Set<string>;
  order_ids: Set<string>;
  removal_order_ids: Set<string>;
  removal_shipment_ids: Set<string>;
  tracking_numbers: Set<string>;
  reimbursement_ids: Set<string>;
  skus: Set<string>;
  fnskus: Set<string>;
  asins: Set<string>;
  amazon_case_ids: Set<string>;
} {
  const payload = metaRecord(args.submission.source_payload);
  const refGraph = metaRecord(payload.trid_reference_graph_verification);
  const graphLines = Array.isArray(refGraph.reference_graph_lines)
    ? (refGraph.reference_graph_lines as Array<Record<string, unknown>>)
    : [];

  const keys = {
    claim_case_ids: new Set<string>(),
    claim_submission_ids: new Set<string>(),
    order_ids: new Set<string>(),
    removal_order_ids: new Set<string>(),
    removal_shipment_ids: new Set<string>(),
    tracking_numbers: new Set<string>(),
    reimbursement_ids: new Set<string>(),
    skus: new Set<string>(),
    fnskus: new Set<string>(),
    asins: new Set<string>(),
    amazon_case_ids: new Set<string>(),
  };

  const add = (set: Set<string>, v: unknown) => {
    const s = normId(v);
    if (s) set.add(s);
  };

  add(keys.claim_case_ids, extractClaimCaseIdFromSubmission(args.submission));
  add(keys.claim_submission_ids, args.submission.id);
  add(keys.tracking_numbers, payload.source_event_key);
  add(keys.tracking_numbers, refGraph.tracking_reference);
  add(keys.amazon_case_ids, args.submission.submission_id);

  for (const line of graphLines) {
    const kind = str(line.kind).toLowerCase();
    const value = str(line.value);
    if (!value) continue;
    if (kind.includes("removal_order") || kind === "amazon_removals") keys.removal_order_ids.add(value);
    if (kind.includes("removal_shipment") || kind === "amazon_removal_shipments") {
      keys.removal_shipment_ids.add(value);
    }
    if (kind.includes("tracking")) keys.tracking_numbers.add(value);
    if (kind.includes("reimbursement")) keys.reimbursement_ids.add(value);
    if (kind.includes("order_id")) keys.order_ids.add(value);
    if (kind === "sku") keys.skus.add(value);
    if (kind === "fnsku") keys.fnskus.add(value);
    if (kind === "asin") keys.asins.add(value);
  }

  if (args.caseRow) {
    add(keys.tracking_numbers, args.caseRow.source_event_key);
    add(keys.skus, args.caseRow.sku);
    add(keys.fnskus, args.caseRow.fnsku);
    add(keys.asins, args.caseRow.asin);
    for (const edge of args.caseRow.reference_edges) {
      const kind = str(edge.reference_kind).toLowerCase();
      const value = str(edge.reference_value);
      if (!value) continue;
      if (kind.includes("removal_order") || kind === "amazon_removals") keys.removal_order_ids.add(value);
      if (kind.includes("removal_shipment") || kind === "amazon_removal_shipments") {
        keys.removal_shipment_ids.add(value);
      }
      if (kind.includes("tracking")) keys.tracking_numbers.add(value);
      if (kind.includes("order_id")) keys.order_ids.add(value);
    }
  }

  for (const id of keys.removal_order_ids) keys.order_ids.add(id);
  for (const id of keys.tracking_numbers) keys.order_ids.add(id);

  return keys;
}

function matchReasonForReimbursement(
  row: Record<string, unknown>,
  joinKeys: ReturnType<typeof extractJoinKeys>,
): string | null {
  const reimbursementId = normId(row.reimbursement_id);
  const caseId = normId(row.case_id);
  const orderId = normId(row.order_id);
  const sku = normId(row.sku);
  const fnsku = normId(row.fnsku);
  const asin = normId(row.asin);

  if (caseId && joinKeys.amazon_case_ids.has(caseId)) return "exact_amazon_case_id";
  if (reimbursementId && joinKeys.reimbursement_ids.has(reimbursementId)) {
    return "exact_reimbursement_id";
  }
  if (orderId && joinKeys.order_ids.has(orderId) && identifierGuard({ sku, fnsku, asin, joinKeys })) {
    return "exact_order_id_with_identifier_guard";
  }
  if (
    orderId &&
    (joinKeys.tracking_numbers.has(orderId) ||
      joinKeys.removal_order_ids.has(orderId) ||
      joinKeys.removal_shipment_ids.has(orderId)) &&
    identifierGuard({ sku, fnsku, asin, joinKeys })
  ) {
    return "reference_key_with_identifier_guard";
  }
  return null;
}

export function matchReimbursementRows(args: {
  rows: Record<string, unknown>[];
  joinKeys: ReturnType<typeof extractJoinKeys>;
}): LinkedFinancialRow[] {
  const matched: LinkedFinancialRow[] = [];
  const seen = new Set<string>();

  for (const row of args.rows) {
    const id = str(row.id);
    if (!id || seen.has(id)) continue;
    const matchReason = matchReasonForReimbursement(row, args.joinKeys);
    if (!matchReason) continue;
    seen.add(id);
    matched.push({
      id,
      source_table: "amazon_reimbursements",
      reference_key: normId(row.reimbursement_id) ?? normId(row.order_id),
      order_id: normId(row.order_id),
      amount: num(row.amount_total),
      currency: normId(row.currency_unit),
      posted_date: normId(row.approval_date),
      match_reason: matchReason,
      matched: true,
    });
  }
  return matched;
}

function matchOrderLinkedRows(args: {
  rows: Record<string, unknown>[];
  joinKeys: ReturnType<typeof extractJoinKeys>;
  source_table: "amazon_transactions" | "amazon_settlements";
  amountField: string;
  dateField: string;
}): LinkedFinancialRow[] {
  const matched: LinkedFinancialRow[] = [];
  const seen = new Set<string>();
  for (const row of args.rows) {
    const id = str(row.id);
    if (!id || seen.has(id)) continue;
    const orderId = normId(row.order_id);
    if (!orderId || !args.joinKeys.order_ids.has(orderId)) continue;
    seen.add(id);
    matched.push({
      id,
      source_table: args.source_table,
      reference_key: orderId,
      order_id: orderId,
      amount: num(row[args.amountField]),
      currency: normId(row.currency),
      posted_date: normId(row[args.dateField]),
      match_reason: "exact_order_id_reference",
      matched: true,
    });
  }
  return matched;
}

export function deriveMatchConfidence(linked: LinkedFinancialRow[]): MatchConfidence {
  if (linked.length === 0) return "none";
  if (linked.some((r) => r.match_reason === "exact_amazon_case_id" || r.match_reason === "exact_reimbursement_id")) {
    return "high";
  }
  if (linked.some((r) => r.match_reason.includes("identifier_guard") || r.match_reason.includes("reference_key"))) {
    return "medium";
  }
  return "low";
}

export function deriveReimbursementTrackingStatus(args: {
  submissionStatus: string | null;
  submissionId: string | null;
  notSubmittedToAmazon: boolean;
  linkedReimbursements: LinkedFinancialRow[];
  estimatedAmount: number | null;
  recoveryValue: number | null;
}): ReimbursementTrackingStatus {
  const st = str(args.submissionStatus).toLowerCase();
  const linkedTotal = args.linkedReimbursements.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const target = args.recoveryValue ?? args.estimatedAmount;

  if (st === "rejected") return "rejected";
  if (st === "evidence_requested") return "evidence_requested";
  if (linkedTotal > 0 && target != null && linkedTotal + 0.0001 < target) return "partially_reimbursed";
  if (linkedTotal > 0) return "reimbursed";
  if (st === "accepted") return "needs_follow_up";
  if (st === "submitted" || st === "investigating") {
    return args.submissionId ? "filed_waiting_for_amazon" : "manually_filed_pending_external_id";
  }
  if (st === "ready_to_send" && args.notSubmittedToAmazon) return "ready_for_manual_filing";
  if ((st === "draft" || st === "ready_to_send") && args.notSubmittedToAmazon) return "draft_not_filed";
  if (st === "cancelled" || st === "closed") return "closed_no_reimbursement";
  return "draft_not_filed";
}

export function computeFinancialGap(args: {
  estimatedAmount: number | null;
  recoveryValue: number | null;
  observedReimbursement: number | null;
  linkedReimbursementTotal: number | null;
}): number | null {
  const target = args.recoveryValue ?? args.estimatedAmount;
  const observed = args.linkedReimbursementTotal ?? args.observedReimbursement;
  if (target == null || observed == null) return null;
  return target - observed;
}

export function extractMoneyWarnings(moneyLanes: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  if (moneyLanes.estimated_amazon_payout == null && moneyLanes.expected_amount == null) {
    warnings.push("missing_estimated_amount");
  }
  if (moneyLanes.recovery_value == null) warnings.push("missing_recovery_value");
  if (moneyLanes.observed_reimbursement == null) warnings.push("missing_observed_reimbursement_lane_null");
  if (moneyLanes.internal_cost_loss == null) warnings.push("missing_internal_cost_loss");
  if (moneyLanes.sale_price_display_only != null && moneyLanes.internal_cost_loss == null) {
    warnings.push("sale_price_present_cogs_null_ok");
  }
  return warnings;
}

export function verifyMoneyNullPreservationTracking(
  previews: ReimbursementTrackingPreviewRow[],
): { pass: boolean; coerced_non_null: number; null_preserved: boolean } {
  let coerced = 0;
  for (const p of previews) {
    for (const key of MONEY_LANE_KEYS) {
      if (key === "currency") continue;
      if (p.money_lanes[key] == null) continue;
      const projected =
        key === "expected_amount" || key === "estimated_amazon_payout"
          ? p.estimated_amount
          : key === "recovery_value"
            ? p.recovery_value
            : key === "observed_reimbursement"
              ? p.observed_reimbursement
              : p.money_lanes[key];
      if (projected == null && p.money_lanes[key] === 0) coerced += 1;
    }
  }
  const nullPreserved = previews.every(
    (p) => p.estimated_amount == null || p.money_lanes.expected_amount != null || p.money_lanes.estimated_amazon_payout != null,
  );
  return { pass: coerced === 0 && nullPreserved, coerced_non_null: coerced, null_preserved: nullPreserved };
}

function summarizeReferenceEdges(caseRow: ClaimCaseReviewRow | null): Array<{ kind: string; value: string }> {
  if (!caseRow) return [];
  return caseRow.reference_edges.slice(0, 12).map((e) => ({
    kind: str(e.reference_kind) || str(e.edge_type) || "edge",
    value: str(e.reference_value),
  }));
}

function buildReferenceGraphLines(
  submission: ExistingPilotSubmission,
  caseRow: ClaimCaseReviewRow | null,
): Array<{ kind: string; value: string; source: string }> {
  const payload = metaRecord(submission.source_payload);
  const refGraph = metaRecord(payload.trid_reference_graph_verification);
  const lines = Array.isArray(refGraph.reference_graph_lines)
    ? (refGraph.reference_graph_lines as Array<Record<string, unknown>>)
    : [];
  const out = lines.map((l) => ({
    kind: str(l.kind),
    value: str(l.value),
    source: str(l.source) || "source_payload.reference_graph",
  }));
  if (caseRow) {
    for (const e of caseRow.reference_edges) {
      out.push({
        kind: str(e.reference_kind) || str(e.edge_type) || "edge",
        value: str(e.reference_value),
        source: "claim_reference_edges",
      });
    }
  }
  return out;
}

export function buildReimbursementTrackingPreviewRow(args: {
  submission: ExistingPilotSubmission;
  caseRow: ClaimCaseReviewRow | null;
  linkedReimbursements: LinkedFinancialRow[];
  linkedTransactions: LinkedFinancialRow[];
  linkedSettlements: LinkedFinancialRow[];
  reimbursementCandidates: LinkedFinancialRow[];
}): ReimbursementTrackingPreviewRow {
  const payload = metaRecord(args.submission.source_payload);
  const moneyLanes = metaRecord(payload.money_lanes);
  const caseRow = args.caseRow;

  const estimated =
    num(moneyLanes.estimated_amazon_payout) ??
    num(moneyLanes.expected_amount) ??
    num(caseRow?.money_lanes?.expected_amount);
  const recovery = num(moneyLanes.recovery_value) ?? num(caseRow?.money_lanes?.recovery_value);
  const observed =
    num(moneyLanes.observed_reimbursement) ?? num(caseRow?.money_lanes?.observed_reimbursement);
  const linkedReimbTotal =
    args.linkedReimbursements.length > 0
      ? args.linkedReimbursements.reduce((s, r) => s + (r.amount ?? 0), 0)
      : null;
  const gap = computeFinancialGap({
    estimatedAmount: estimated,
    recoveryValue: recovery,
    observedReimbursement: observed,
    linkedReimbursementTotal: linkedReimbTotal,
  });

  const product = {
    asin: normId(caseRow?.asin),
    fnsku: normId(caseRow?.fnsku),
    sku: normId(caseRow?.sku),
    resolved_product_id: normId(caseRow?.resolved_product_id),
  };

  const notSubmitted = payload.not_submitted_to_amazon === true;
  const trackingStatus = deriveReimbursementTrackingStatus({
    submissionStatus: args.submission.status,
    submissionId: args.submission.submission_id,
    notSubmittedToAmazon: notSubmitted,
    linkedReimbursements: args.linkedReimbursements,
    estimatedAmount: estimated,
    recoveryValue: recovery,
  });
  const matchConfidence = deriveMatchConfidence(args.linkedReimbursements);
  const warnings = extractMoneyWarnings(moneyLanes);
  const blockers = Array.isArray(payload.blockers) ? (payload.blockers as string[]) : [];

  const claimCaseId = extractClaimCaseIdFromSubmission(args.submission) ?? "";
  const matchCandidates: ReimbursementMatchCandidate[] = args.reimbursementCandidates
    .slice(0, 25)
    .map((c) => ({
      ...c,
      claim_submission_id: args.submission.id,
      claim_case_id: claimCaseId,
      confidence: deriveMatchConfidence([c]),
    }));

  return {
    claim_submission_id: args.submission.id,
    claim_case_id: claimCaseId,
    submission_mode: normId(payload.submission_mode),
    submission_status: args.submission.status,
    claim_family: normId(payload.claim_family) ?? normId(caseRow?.claim_family),
    family_key_v3: normId(payload.family_key_v3) ?? normId(caseRow?.family_key_v3),
    source_event_key: normId(payload.source_event_key) ?? normId(caseRow?.source_event_key),
    source_event_date: normId(caseRow?.source_event_date),
    asin: product.asin,
    fnsku: product.fnsku,
    sku: product.sku,
    product_identity: product,
    clean_quantity: caseRow?.clean_quantity ?? null,
    reference_edges_summary: summarizeReferenceEdges(caseRow),
    estimated_amount: estimated,
    recovery_value: recovery,
    observed_reimbursement: observed,
    financial_gap: gap,
    money_warnings: warnings,
    money_lanes: moneyLanes,
    export_artifact_paths: metaRecord(payload.draft_artifact_paths),
    future_amazon_case_id: normId(args.submission.submission_id),
    reimbursement_tracking_status: trackingStatus,
    linked_reimbursement_rows: args.linkedReimbursements,
    linked_transaction_rows: args.linkedTransactions,
    linked_settlement_rows: args.linkedSettlements,
    linked_reimbursement_count: args.linkedReimbursements.length,
    match_confidence: matchConfidence,
    follow_up_needed:
      trackingStatus === "needs_follow_up" ||
      trackingStatus === "filed_waiting_for_amazon" ||
      trackingStatus === "draft_not_filed" ||
      trackingStatus === "ready_for_manual_filing",
    not_submitted_to_amazon: notSubmitted,
    claim_lines: (caseRow?.lines ?? []).map((l) => ({
      claim_line_id: l.id,
      claim_candidate_id: l.claim_candidate_id,
      quantity_expected: l.quantity_expected,
      status: l.status,
    })),
    detail_preview: {
      reference_graph_lines: buildReferenceGraphLines(args.submission, caseRow),
      reimbursement_match_candidates: matchCandidates,
      financial_gap_explanation:
        gap == null
          ? "Financial gap unavailable — estimated/recovery or observed reimbursement lane is NULL (not inferred)."
          : `Open amount = (recovery_or_estimated ${recovery ?? estimated}) - (observed_or_linked ${linkedReimbTotal ?? observed}) = ${gap}`,
      warnings,
      blockers,
    },
  };
}

async function loadByOrderIds(
  client: SupabaseClient,
  table: string,
  select: string,
  organizationId: string,
  storeId: string,
  orderIds: string[],
  limit: number,
): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(orderIds.filter(Boolean))].slice(0, 40);
  if (ids.length === 0) return [];
  const { data, error } = await client
    .from(table)
    .select(select)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .in("order_id", ids)
    .limit(limit);
  if (error) {
    if (error.message.includes("does not exist") || error.message.includes("schema cache")) return [];
    throw new Error(`${table}: ${error.message}`);
  }
  return (data ?? []) as unknown as Record<string, unknown>[];
}

export async function composeReimbursementTrackingPreviewV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: {
    pilot_case_run_id?: string;
    intake_run_id?: string;
  } = {},
): Promise<{
  pilot_case_run_id: string;
  intake_run_id: string;
  pilot_submissions: ExistingPilotSubmission[];
  legacy_submissions: ExistingPilotSubmission[];
  previews: ReimbursementTrackingPreviewRow[];
  legacy_visibility: LegacySubmissionVisibility;
  reimbursement_candidates_loaded: number;
  transaction_candidates_loaded: number;
  settlement_candidates_loaded: number;
  reimbursement_match_candidates: ReimbursementMatchCandidate[];
}> {
  const pilotCaseRunId = str(options.pilot_case_run_id) || PILOT_CASE_RUN_ID;
  const intakeRunId = str(options.intake_run_id) || PILOT_INTAKE_RUN_ID;

  const all = await loadExistingPilotSubmissions(client, organizationId);
  const pilot_submissions = all.filter((r) =>
    isPilotSubmissionRecord(r, pilotCaseRunId, intakeRunId),
  );
  const legacy_submissions = all.filter(
    (r) => !isPilotSubmissionRecord(r, pilotCaseRunId, intakeRunId),
  );

  const review = await buildClaimCaseReviewReadmodel(client, organizationId, storeId, {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    status: "open",
    limit: 100,
  });
  const caseById = new Map(review.rows.map((r) => [r.id, r]));

  const orderIds: string[] = [];
  for (const sub of pilot_submissions) {
    const caseRow = caseById.get(extractClaimCaseIdFromSubmission(sub) ?? "") ?? null;
    orderIds.push(...extractJoinKeys({ submission: sub, caseRow }).order_ids);
  }

  const [reimbursementRows, transactionRows, settlementRows] = await Promise.all([
    loadByOrderIds(client, "amazon_reimbursements", REIMBURSEMENT_SELECT, organizationId, storeId, orderIds, 500),
    loadByOrderIds(client, "amazon_transactions", TRANSACTION_SELECT, organizationId, storeId, orderIds, 200),
    loadByOrderIds(client, "amazon_settlements", SETTLEMENT_SELECT, organizationId, storeId, orderIds, 200),
  ]);

  const previews = pilot_submissions.map((submission) => {
    const claimCaseId = extractClaimCaseIdFromSubmission(submission) ?? "";
    const caseRow = caseById.get(claimCaseId) ?? null;
    const joinKeys = extractJoinKeys({ submission, caseRow });
    const linkedReimb = matchReimbursementRows({ rows: reimbursementRows, joinKeys });
    const linkedTx = matchOrderLinkedRows({
      rows: transactionRows,
      joinKeys,
      source_table: "amazon_transactions",
      amountField: "amount",
      dateField: "posted_date",
    });
    const linkedSettlements = matchOrderLinkedRows({
      rows: settlementRows,
      joinKeys,
      source_table: "amazon_settlements",
      amountField: "amount",
      dateField: "posted_date",
    });
    const candidates = reimbursementRows
      .map((row) => {
        const reason = matchReasonForReimbursement(row, joinKeys);
        if (!reason) return null;
        return {
          id: str(row.id),
          source_table: "amazon_reimbursements" as const,
          reference_key: normId(row.reimbursement_id) ?? normId(row.order_id),
          order_id: normId(row.order_id),
          amount: num(row.amount_total),
          currency: normId(row.currency_unit),
          posted_date: normId(row.approval_date),
          match_reason: reason,
          matched: linkedReimb.some((l) => l.id === str(row.id)),
        };
      })
      .filter(Boolean) as LinkedFinancialRow[];

    return buildReimbursementTrackingPreviewRow({
      submission,
      caseRow,
      linkedReimbursements: linkedReimb,
      linkedTransactions: linkedTx,
      linkedSettlements,
      reimbursementCandidates: candidates,
    });
  });

  const reimbursement_match_candidates = previews.flatMap((p) => p.detail_preview.reimbursement_match_candidates);

  return {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    pilot_submissions,
    legacy_submissions,
    previews,
    legacy_visibility: {
      count: legacy_submissions.length,
      excluded_from_pilot_preview: true,
      ids: legacy_submissions.map((r) => r.id),
      note: "Legacy return-linked submissions excluded from pilot tracking preview matrix",
    },
    reimbursement_candidates_loaded: reimbursementRows.length,
    transaction_candidates_loaded: transactionRows.length,
    settlement_candidates_loaded: settlementRows.length,
    reimbursement_match_candidates,
  };
}

export function summarizeMoney(previews: ReimbursementTrackingPreviewRow[]): {
  estimated_amount_summary: { non_null_count: number; total: number | null };
  recovery_value_summary: { non_null_count: number; total: number | null };
  observed_reimbursement_summary: { non_null_count: number; total: number | null };
  remaining_open_amount_summary: { non_null_count: number; total: number | null };
} {
  const sumLane = (pick: (p: ReimbursementTrackingPreviewRow) => number | null) => {
    const vals = previews.map(pick).filter((v): v is number => v != null);
    return {
      non_null_count: vals.length,
      total: vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null,
    };
  };
  return {
    estimated_amount_summary: sumLane((p) => p.estimated_amount),
    recovery_value_summary: sumLane((p) => p.recovery_value),
    observed_reimbursement_summary: sumLane((p) => p.observed_reimbursement),
    remaining_open_amount_summary: sumLane((p) => p.financial_gap),
  };
}

export function buildSummaryCards(previews: ReimbursementTrackingPreviewRow[]): TrackingSummaryCards {
  const money = summarizeMoney(previews);
  return {
    pilot_submission_count: previews.length,
    draft_submissions: previews.filter((p) => p.reimbursement_tracking_status === "draft_not_filed").length,
    ready_for_manual_filing: previews.filter((p) => p.reimbursement_tracking_status === "ready_for_manual_filing")
      .length,
    matched_reimbursements: previews.filter((p) => p.linked_reimbursement_count > 0).length,
    unmatched_submissions: previews.filter((p) => p.linked_reimbursement_count === 0).length,
    estimated_recoverable_total: money.recovery_value_summary.total ?? money.estimated_amount_summary.total,
    observed_reimbursement_total: money.observed_reimbursement_summary.total,
    remaining_open_amount_total: money.remaining_open_amount_summary.total,
  };
}

export function buildPerSubmissionTable(previews: ReimbursementTrackingPreviewRow[]) {
  return previews.map((p) => ({
    claim_case_id: p.claim_case_id,
    claim_submission_id: p.claim_submission_id,
    family_key_v3: p.family_key_v3,
    submission_status: p.submission_status,
    reimbursement_tracking_status: p.reimbursement_tracking_status,
    clean_quantity: p.clean_quantity,
    estimated_amount: p.estimated_amount,
    observed_reimbursement: p.observed_reimbursement,
    financial_gap: p.financial_gap,
    match_confidence: p.match_confidence,
    follow_up_needed: p.follow_up_needed,
  }));
}

export function summarizeMatchConfidence(previews: ReimbursementTrackingPreviewRow[]): Record<MatchConfidence, number> {
  const out: Record<MatchConfidence, number> = { high: 0, medium: 0, low: 0, none: 0 };
  for (const p of previews) out[p.match_confidence] += 1;
  return out;
}

export const REIMBURSEMENT_TRACKING_DEFAULTS = {
  pilot_case_run_id: PILOT_CASE_RUN_ID,
  intake_run_id: PILOT_INTAKE_RUN_ID,
  expected_pilot_submission_count: 10,
  expected_legacy_submission_count: 3,
  expected_total_submissions_after_pilot: 13,
} as const;
