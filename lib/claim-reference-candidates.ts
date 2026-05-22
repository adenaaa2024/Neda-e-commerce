/**
 * TRID-REFERENCE-GRAPH-IMPLEMENT-V170 — Build canonical reference candidates for a claim draft.
 * Read-only: SELECT queries only from approved financial source tables.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildCandidateDedupeKey,
  buildCandidateKey,
  clampConfidence,
  type CanonicalReferenceCandidate,
  type ClaimCaseJoinReason,
  type ReferenceCandidateLineage,
  type ReferenceCandidatesResponse,
  type ReferenceType,
} from "./canonical-reference-candidate-types";
import type { ClaimEvidenceDraftRow } from "./claim-evidence-preview";
import { fetchDraftRow, resolveCandidateForDraft } from "./claim-evidence-preview";
import {
  OPERATOR_TRID_SELECTION_RECORDED_EVENT,
  type OperatorTridSelectionEventPayload,
  type TridCandidateOutcome,
  validateOperatorTridSelectionEventPayload,
} from "./claim-trid-candidates-types";

/** P0 financial sources approved for TRID candidate aggregation (V169). */
export const APPROVED_REFERENCE_SOURCE_TABLES = new Set([
  "financial_reference_resolver",
  "amazon_settlements",
  "amazon_transactions",
  "amazon_reimbursements",
  "amazon_finances_events",
]);

const FRR_SELECT =
  "trid_key, source_table, source_row_id, settlement_id, order_id, sku, asin, posted_date, amount, currency, confidence_score, reference_group_key, transaction_type";

const FINANCES_EVENT_SELECT =
  "id, event_group_id, order_id, removal_order_id, reimbursement_id, adjustment_id, shipment_id, event_type, posted_at, sku, amount, currency, source_run_id, amazon_event_id, reference_ids";

const REIMBURSEMENT_SELECT = "id, reimbursement_id, order_id, sku, amount_reimbursed, upload_id";

const MAX_CANDIDATES = 80;
const MAX_FRR = 48;
const MAX_FINANCES = 24;

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normSku(s: string | null | undefined): string | null {
  const t = nv(s);
  return t ? t.toLowerCase() : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v != null && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function numConf(v: unknown, fallback: number): number {
  return clampConfidence(numOrNull(v) ?? fallback);
}

export type OperationalContext = {
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  upload_id: string | null;
  removal_order_id: string | null;
};

export type ReferenceCandidatesBuildInput = {
  draft: ClaimEvidenceDraftRow;
  operational: OperationalContext | null;
  frrRows: Record<string, unknown>[];
  financeEvents: Record<string, unknown>[];
  reimbursementRows: Record<string, unknown>[];
  operatorSelection: OperatorTridSelectionEventPayload | null;
  operationalRowFound: boolean;
};

function defaultLineage(
  source_table: string,
  source_row_id: string,
  extras?: Partial<ReferenceCandidateLineage>,
): ReferenceCandidateLineage {
  return {
    source_table,
    source_row_id,
    source_upload_id: extras?.source_upload_id ?? null,
    source_run_id: extras?.source_run_id ?? null,
    report_kind: extras?.report_kind ?? null,
    source_citations: extras?.source_citations ?? [
      { kind: "live_query", table: source_table, row_id: source_row_id },
    ],
  };
}

function inferFinancesReferenceType(row: Record<string, unknown>): ReferenceType {
  if (nv(row.amazon_event_id)) return "amazon_event_id";
  if (nv(row.reimbursement_id)) return "reimbursement_id";
  if (nv(row.adjustment_id)) return "adjustment_id";
  if (nv(row.shipment_id)) return "shipment_id";
  if (nv(row.removal_order_id)) return "removal_order_id";
  return "unknown";
}

function inferFinancesReferenceValue(row: Record<string, unknown>, refType: ReferenceType): string {
  const id = nv(row.id) ?? "";
  switch (refType) {
    case "amazon_event_id":
      return nv(row.amazon_event_id) ?? id;
    case "reimbursement_id":
      return nv(row.reimbursement_id) ?? id;
    case "adjustment_id":
      return nv(row.adjustment_id) ?? id;
    case "shipment_id":
      return nv(row.shipment_id) ?? id;
    case "removal_order_id":
      return nv(row.removal_order_id) ?? id;
    default:
      return id;
  }
}

export type JoinScoreContext = {
  orderId: string | null;
  removalOrderId: string | null;
  skuHint: string | null;
  operationalUploadId: string | null;
};

export function scoreReferenceConfidence(
  base: number,
  candidate: Pick<
    CanonicalReferenceCandidate,
    | "order_id"
    | "removal_order_id"
    | "sku"
    | "settlement_id"
    | "amount"
    | "event_date"
    | "source_upload_id"
    | "claim_case_join_reason"
  >,
  ctx: JoinScoreContext,
): number {
  let score = base;

  if (candidate.claim_case_join_reason === "operator_selected") {
    return 1;
  }

  if (ctx.orderId && candidate.order_id === ctx.orderId) score += 0.12;
  if (ctx.removalOrderId && candidate.removal_order_id === ctx.removalOrderId) score += 0.12;

  const hint = normSku(ctx.skuHint);
  const cSku = normSku(candidate.sku);
  if (hint && cSku && hint === cSku) score += 0.1;

  if (
    ctx.operationalUploadId &&
    candidate.source_upload_id &&
    candidate.source_upload_id === ctx.operationalUploadId
  ) {
    score += 0.05;
  }

  if (candidate.settlement_id) score += 0.03;

  return clampConfidence(score);
}

function filterFrrBySku(rows: Record<string, unknown>[], skuHint: string | null): Record<string, unknown>[] {
  const hint = normSku(skuHint);
  if (!hint) return rows;
  const matched = rows.filter((r) => normSku(nv(r.sku)) === hint);
  return matched.length > 0 ? matched : rows;
}

export function frrRowToCandidate(
  row: Record<string, unknown>,
  draft: ClaimEvidenceDraftRow,
  ctx: JoinScoreContext,
  opts: { rank: number; ambKey: string | null; skuMatched: boolean },
): CanonicalReferenceCandidate | null {
  const trid = nv(row.trid_key);
  const srcTable = nv(row.source_table);
  const srcRowId = nv(row.source_row_id);
  if (!trid || !srcTable || !srcRowId) return null;
  if (!APPROVED_REFERENCE_SOURCE_TABLES.has(srcTable)) {
    return null;
  }

  const tableForCandidate = APPROVED_REFERENCE_SOURCE_TABLES.has(srcTable) ? srcTable : "financial_reference_resolver";
  const joinReason: ClaimCaseJoinReason = opts.skuMatched ? "order_id_and_sku" : "order_id_exact";
  const baseConf = numConf(row.confidence_score, opts.ambKey ? 0.78 : 0.92);

  const partial: CanonicalReferenceCandidate = {
    reference_value: trid,
    reference_type: "internal_trid_key",
    source_table: tableForCandidate,
    source_row_id: srcRowId,
    source_upload_id: null,
    source_run_id: null,
    report_kind:
      tableForCandidate === "amazon_settlements"
        ? "SETTLEMENT"
        : tableForCandidate === "amazon_transactions"
          ? "TRANSACTIONS"
          : tableForCandidate === "amazon_reimbursements"
            ? "REIMBURSEMENTS"
            : null,
    event_date: nv(row.posted_date),
    amount: numOrNull(row.amount),
    currency: nv(row.currency),
    transaction_type: nv(row.transaction_type),
    asin: nv(row.asin),
    fnsku: null,
    sku: nv(row.sku),
    product_id: null,
    order_id: nv(row.order_id),
    settlement_id: nv(row.settlement_id),
    shipment_id: null,
    removal_order_id: null,
    confidence: baseConf,
    ambiguity_group_key: opts.ambKey,
    ambiguity_rank: opts.ambKey ? opts.rank : null,
    claim_case_join_reason: joinReason,
    linked_draft_id: draft.id,
    linked_edge_id: null,
    enrichment_generation_id: null,
    reference_ids_extra: {},
    candidate_key: "",
    lineage: defaultLineage(tableForCandidate, srcRowId, {
      report_kind:
        tableForCandidate === "amazon_settlements"
          ? "SETTLEMENT"
          : tableForCandidate === "amazon_transactions"
            ? "TRANSACTIONS"
            : tableForCandidate === "amazon_reimbursements"
              ? "REIMBURSEMENTS"
              : null,
      source_citations: [
        { kind: "live_query", table: "financial_reference_resolver", row_id: trid },
        { kind: "live_query", table: tableForCandidate, row_id: srcRowId },
      ],
    }),
    operator_selected: false,
  };

  partial.confidence = scoreReferenceConfidence(baseConf, partial, ctx);
  partial.candidate_key = buildCandidateKey({
    reference_type: partial.reference_type,
    reference_value: partial.reference_value,
    source_table: partial.source_table,
    source_row_id: partial.source_row_id,
  });

  return partial;
}

export function financesEventToCandidate(
  row: Record<string, unknown>,
  draft: ClaimEvidenceDraftRow,
  ctx: JoinScoreContext,
  opts: { rank: number; ambKey: string | null },
): CanonicalReferenceCandidate | null {
  const srcRowId = nv(row.id);
  if (!srcRowId) return null;

  const refType = inferFinancesReferenceType(row);
  const refValue = inferFinancesReferenceValue(row, refType);
  if (!refValue) return null;

  const joinReason: ClaimCaseJoinReason =
    ctx.removalOrderId && nv(row.removal_order_id) === ctx.removalOrderId
      ? "removal_order_id"
      : nv(row.reimbursement_id)
        ? "reimbursement_id"
        : "order_id_exact";

  const extra: Record<string, string> = {};
  const refIds = row.reference_ids;
  if (refIds && typeof refIds === "object" && !Array.isArray(refIds)) {
    for (const [k, v] of Object.entries(refIds as Record<string, unknown>)) {
      const s = nv(v);
      if (s) extra[k] = s;
    }
  }

  const partial: CanonicalReferenceCandidate = {
    reference_value: refValue,
    reference_type: refType,
    source_table: "amazon_finances_events",
    source_row_id: srcRowId,
    source_upload_id: null,
    source_run_id: nv(row.source_run_id),
    report_kind: "FINANCES_API",
    event_date: nv(row.posted_at),
    amount: numOrNull(row.amount),
    currency: nv(row.currency),
    transaction_type: nv(row.event_type),
    asin: null,
    fnsku: null,
    sku: nv(row.sku),
    product_id: null,
    order_id: nv(row.order_id),
    settlement_id: null,
    shipment_id: nv(row.shipment_id),
    removal_order_id: nv(row.removal_order_id),
    confidence: 0.72,
    ambiguity_group_key: opts.ambKey,
    ambiguity_rank: opts.ambKey ? opts.rank : null,
    claim_case_join_reason: joinReason,
    linked_draft_id: draft.id,
    linked_edge_id: null,
    enrichment_generation_id: null,
    reference_ids_extra: extra,
    candidate_key: "",
    lineage: defaultLineage("amazon_finances_events", srcRowId, {
      source_run_id: nv(row.source_run_id),
      report_kind: "FINANCES_API",
      source_citations: [{ kind: "live_query", table: "amazon_finances_events", row_id: srcRowId }],
    }),
    operator_selected: false,
  };

  partial.confidence = scoreReferenceConfidence(0.72, partial, ctx);
  partial.candidate_key = buildCandidateKey({
    reference_type: partial.reference_type,
    reference_value: partial.reference_value,
    source_table: partial.source_table,
    source_row_id: partial.source_row_id,
  });

  return partial;
}

export function reimbursementRowToCandidate(
  row: Record<string, unknown>,
  draft: ClaimEvidenceDraftRow,
  ctx: JoinScoreContext,
): CanonicalReferenceCandidate | null {
  const srcRowId = nv(row.id);
  const reimbId = nv(row.reimbursement_id);
  if (!srcRowId || !reimbId) return null;

  const partial: CanonicalReferenceCandidate = {
    reference_value: reimbId,
    reference_type: "reimbursement_id",
    source_table: "amazon_reimbursements",
    source_row_id: srcRowId,
    source_upload_id: nv(row.upload_id),
    source_run_id: null,
    report_kind: "REIMBURSEMENTS",
    event_date: null,
    amount: numOrNull(row.amount_reimbursed),
    currency: null,
    transaction_type: "reimbursement",
    asin: null,
    fnsku: null,
    sku: nv(row.sku),
    product_id: null,
    order_id: nv(row.order_id),
    settlement_id: null,
    shipment_id: null,
    removal_order_id: null,
    confidence: 0.8,
    ambiguity_group_key: null,
    ambiguity_rank: null,
    claim_case_join_reason: "reimbursement_id",
    linked_draft_id: draft.id,
    linked_edge_id: null,
    enrichment_generation_id: null,
    reference_ids_extra: {},
    candidate_key: "",
    lineage: defaultLineage("amazon_reimbursements", srcRowId, {
      source_upload_id: nv(row.upload_id),
      report_kind: "REIMBURSEMENTS",
    }),
    operator_selected: false,
  };

  partial.confidence = scoreReferenceConfidence(0.8, partial, ctx);
  partial.candidate_key = buildCandidateKey({
    reference_type: partial.reference_type,
    reference_value: partial.reference_value,
    source_table: partial.source_table,
    source_row_id: partial.source_row_id,
  });

  return partial;
}

export function operatorSelectionToCandidate(
  payload: OperatorTridSelectionEventPayload,
  draft: ClaimEvidenceDraftRow,
): CanonicalReferenceCandidate {
  const table = payload.selected_source_table;
  const refType: ReferenceType = payload.selected_reference_kind === "internal_trid_key"
    ? "internal_trid_key"
    : (payload.selected_reference_kind as ReferenceType);

  const c: CanonicalReferenceCandidate = {
    reference_value: payload.selected_reference_value,
    reference_type: refType,
    source_table: table,
    source_row_id: payload.selected_source_row_id,
    source_upload_id: null,
    source_run_id: payload.source_run_id || null,
    report_kind: null,
    event_date: null,
    amount: null,
    currency: null,
    transaction_type: null,
    asin: null,
    fnsku: null,
    sku: null,
    product_id: null,
    order_id: null,
    settlement_id: null,
    shipment_id: null,
    removal_order_id: null,
    confidence: clampConfidence(payload.selected_confidence),
    ambiguity_group_key: null,
    ambiguity_rank: null,
    claim_case_join_reason: "operator_selected",
    linked_draft_id: draft.id,
    linked_edge_id: null,
    enrichment_generation_id: null,
    reference_ids_extra: {},
    candidate_key: "",
    lineage: defaultLineage(table, payload.selected_source_row_id, {
      source_citations: [
        {
          kind: "operator_event",
          table: "claim_review_work_item_events",
          row_id: payload.work_item_id,
        },
      ],
    }),
    operator_selected: true,
  };

  c.candidate_key = buildCandidateKey({
    reference_type: c.reference_type,
    reference_value: c.reference_value,
    source_table: c.source_table,
    source_row_id: c.source_row_id,
  });

  return c;
}

/** Deduplicate by reference_value + source_table + source_row_id (V170 spec). */
export function deduplicateReferenceCandidates(
  candidates: CanonicalReferenceCandidate[],
): CanonicalReferenceCandidate[] {
  const byKey = new Map<string, CanonicalReferenceCandidate>();
  for (const c of candidates) {
    const dk = buildCandidateDedupeKey({
      reference_value: c.reference_value,
      source_table: c.source_table,
      source_row_id: c.source_row_id,
    });
    const existing = byKey.get(dk);
    if (!existing || c.confidence > existing.confidence || c.operator_selected) {
      byKey.set(dk, c);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.operator_selected !== b.operator_selected) return a.operator_selected ? -1 : 1;
    return b.confidence - a.confidence;
  });
}

export function computeReferenceCandidatesOutcome(
  candidates: CanonicalReferenceCandidate[],
  input: Pick<ReferenceCandidatesBuildInput, "operational" | "operationalRowFound">,
): TridCandidateOutcome {
  if (!input.operationalRowFound && input.operational === null) {
    return "missing_operational_row";
  }
  const orderId = input.operational?.order_id ?? null;
  if (!orderId) return "no_order_id";

  const frrLike = candidates.filter(
    (c) =>
      c.reference_type === "internal_trid_key" &&
      APPROVED_REFERENCE_SOURCE_TABLES.has(c.source_table),
  );
  if (frrLike.length === 0) return "missing_frr";

  const ambKeys = new Set(frrLike.map((c) => c.ambiguity_group_key).filter(Boolean));
  if (frrLike.length > 1 || ambKeys.size > 0) return "ambiguous_multiple";

  const sole = frrLike[0]!;
  if (sole.confidence >= 0.9 || sole.operator_selected) return "deterministic_single";
  return "ambiguous_multiple";
}

/**
 * Pure builder: aggregate candidates from pre-fetched approved sources.
 */
export function buildReferenceCandidatesForClaim(
  input: ReferenceCandidatesBuildInput,
): { candidates: CanonicalReferenceCandidate[]; outcome: TridCandidateOutcome } {
  const { draft, operational, frrRows, financeEvents, reimbursementRows, operatorSelection } = input;

  const skuHint = draft.sku ?? operational?.sku ?? null;
  const ctx: JoinScoreContext = {
    orderId: operational?.order_id ?? null,
    removalOrderId: operational?.removal_order_id ?? operational?.order_id ?? null,
    skuHint,
    operationalUploadId: operational?.upload_id ?? null,
  };

  const raw: CanonicalReferenceCandidate[] = [];

  if (operatorSelection) {
    raw.push(operatorSelectionToCandidate(operatorSelection, draft));
  }

  const filteredFrr = filterFrrBySku(frrRows, skuHint)
    .sort((a, b) => numConf(b.confidence_score, 0) - numConf(a.confidence_score, 0))
    .slice(0, MAX_FRR);

  const skuMatched =
    Boolean(skuHint) && filteredFrr.some((r) => normSku(nv(r.sku)) === normSku(skuHint));
  const frrAmbKey =
    filteredFrr.length > 1 ? `frr:${ctx.orderId ?? "no_order"}:${normSku(skuHint) ?? "no_sku"}` : null;

  let frrRank = 0;
  for (const row of filteredFrr) {
    frrRank += 1;
    const c = frrRowToCandidate(row, draft, ctx, {
      rank: frrRank,
      ambKey: frrAmbKey,
      skuMatched,
    });
    if (c) raw.push(c);
  }

  const finSlice = financeEvents.slice(0, MAX_FINANCES);
  const finAmb = finSlice.length > 1 ? `fin:${ctx.orderId ?? "no_order"}` : null;
  let finRank = 0;
  for (const row of finSlice) {
    finRank += 1;
    const c = financesEventToCandidate(row, draft, ctx, { rank: finRank, ambKey: finAmb });
    if (c) raw.push(c);
  }

  for (const row of reimbursementRows.slice(0, 20)) {
    const c = reimbursementRowToCandidate(row, draft, ctx);
    if (c) raw.push(c);
  }

  const candidates = deduplicateReferenceCandidates(raw);
  const outcome = computeReferenceCandidatesOutcome(candidates, input);
  return { candidates, outcome };
}

async function fetchRemovalOperational(
  client: SupabaseClient,
  orgId: string,
  removalId: string,
): Promise<{ row: Record<string, unknown> | null; ctx: OperationalContext | null }> {
  const { data, error } = await client
    .from("amazon_removals")
    .select("id, order_id, sku, fnsku, upload_id")
    .eq("organization_id", orgId)
    .eq("id", removalId)
    .maybeSingle();
  if (error || !data) return { row: null, ctx: null };
  const r = data as Record<string, unknown>;
  const orderId = nv(r.order_id);
  return {
    row: r,
    ctx: {
      order_id: orderId,
      sku: nv(r.sku),
      fnsku: nv(r.fnsku),
      upload_id: nv(r.upload_id),
      removal_order_id: orderId,
    },
  };
}

async function fetchReturnsOperational(
  client: SupabaseClient,
  orgId: string,
  returnRowId: string,
): Promise<{ row: Record<string, unknown> | null; ctx: OperationalContext | null }> {
  const { data, error } = await client
    .from("amazon_returns")
    .select("id, order_id, sku, upload_id")
    .eq("organization_id", orgId)
    .eq("id", returnRowId)
    .maybeSingle();
  if (error || !data) return { row: null, ctx: null };
  const r = data as Record<string, unknown>;
  return {
    row: r,
    ctx: {
      order_id: nv(r.order_id),
      sku: nv(r.sku),
      fnsku: null,
      upload_id: nv(r.upload_id),
      removal_order_id: null,
    },
  };
}

async function fetchFrrByOrderId(
  client: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client
    .from("financial_reference_resolver")
    .select(FRR_SELECT)
    .eq("organization_id", orgId)
    .eq("order_id", orderId);
  if (error) throw new Error(`financial_reference_resolver: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

async function fetchFinancesEvents(
  client: SupabaseClient,
  orgId: string,
  orderId: string | null,
  removalOrderId: string | null,
): Promise<Record<string, unknown>[]> {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];

  const merge = (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const id = nv(row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(row);
    }
  };

  if (orderId) {
    const { data, error } = await client
      .from("amazon_finances_events")
      .select(FINANCES_EVENT_SELECT)
      .eq("organization_id", orgId)
      .eq("order_id", orderId)
      .limit(500);
    if (error) {
      if (!error.message.includes("does not exist") && error.code !== "42P01") {
        throw new Error(`amazon_finances_events: ${error.message}`);
      }
    } else {
      merge((data ?? []) as Record<string, unknown>[]);
    }
  }

  if (removalOrderId && removalOrderId !== orderId) {
    const { data, error } = await client
      .from("amazon_finances_events")
      .select(FINANCES_EVENT_SELECT)
      .eq("organization_id", orgId)
      .eq("removal_order_id", removalOrderId)
      .limit(200);
    if (!error) merge((data ?? []) as Record<string, unknown>[]);
  }

  return out;
}

async function fetchReimbursementsByOrderId(
  client: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client
    .from("amazon_reimbursements")
    .select(REIMBURSEMENT_SELECT)
    .eq("organization_id", orgId)
    .eq("order_id", orderId)
    .limit(50);
  if (error) {
    if (error.message.includes("does not exist") || error.code === "42P01") return [];
    throw new Error(`amazon_reimbursements: ${error.message}`);
  }
  return (data ?? []) as Record<string, unknown>[];
}

async function fetchLatestOperatorTridSelection(
  client: SupabaseClient,
  orgId: string,
  draftId: string,
): Promise<OperatorTridSelectionEventPayload | null> {
  const { data: wi, error: wiErr } = await client
    .from("claim_review_work_items")
    .select("id")
    .eq("organization_id", orgId)
    .eq("draft_id", draftId)
    .maybeSingle();
  if (wiErr || !wi?.id) return null;

  const workItemId = String(wi.id);
  const { data: events, error: evErr } = await client
    .from("claim_review_work_item_events")
    .select("payload, event_type")
    .eq("organization_id", orgId)
    .eq("work_item_id", workItemId)
    .eq("event_type", OPERATOR_TRID_SELECTION_RECORDED_EVENT)
    .order("created_at", { ascending: false })
    .limit(1);
  if (evErr || !events?.length) return null;

  const payload = (events[0] as { payload?: unknown }).payload;
  const parsed = validateOperatorTridSelectionEventPayload(payload, {
    workItemId,
    draftId,
  });
  return parsed.ok ? parsed.payload : null;
}

export function buildReferenceCandidatesWarnings(
  outcome: TridCandidateOutcome,
  candidates: CanonicalReferenceCandidate[],
): ReferenceCandidatesResponse["warnings"] {
  const warnings: ReferenceCandidatesResponse["warnings"] = [];
  if (outcome === "missing_frr") {
    warnings.push({
      code: "missing_frr",
      message: "No financial_reference_resolver candidates for this draft's order_id.",
      severity: "warn",
    });
  }
  if (outcome === "ambiguous_multiple") {
    warnings.push({
      code: "ambiguous_trid",
      message: "Multiple reference candidates — operator selection may be required.",
      severity: "info",
    });
  }
  if (outcome === "no_order_id") {
    warnings.push({
      code: "no_order_id",
      message: "Operational row has no order_id; financial joins skipped.",
      severity: "warn",
    });
  }
  const hasFin = candidates.some((c) => c.source_table === "amazon_finances_events");
  if (!hasFin) {
    warnings.push({
      code: "finances_archive_missing",
      message: "No amazon_finances_events candidates for this draft.",
      severity: "info",
    });
  }
  warnings.push({
    code: "read_only",
    message: "Reference candidates are read-only — does not submit claims.",
    severity: "info",
  });
  return warnings;
}

export async function loadAndBuildReferenceCandidatesForDraft(
  client: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
  opts?: { claim_candidate_id?: string | null; limit?: number },
): Promise<ReferenceCandidatesResponse> {
  let operational: OperationalContext | null = null;
  let operationalRowFound = false;

  if (draft.source_table === "amazon_removals") {
    const { ctx } = await fetchRemovalOperational(client, draft.organization_id, draft.source_row_id);
    operational = ctx;
    operationalRowFound = ctx != null;
  } else if (draft.source_table === "amazon_returns") {
    const { ctx } = await fetchReturnsOperational(client, draft.organization_id, draft.source_row_id);
    operational = ctx;
    operationalRowFound = ctx != null;
  }

  const orderId = operational?.order_id ?? null;
  const frrRows = orderId ? await fetchFrrByOrderId(client, draft.organization_id, orderId) : [];
  const financeEvents = await fetchFinancesEvents(
    client,
    draft.organization_id,
    orderId,
    operational?.removal_order_id ?? null,
  );
  const reimbursementRows = orderId
    ? await fetchReimbursementsByOrderId(client, draft.organization_id, orderId)
    : [];
  const operatorSelection = await fetchLatestOperatorTridSelection(
    client,
    draft.organization_id,
    draft.id,
  );

  const { candidates: all, outcome } = buildReferenceCandidatesForClaim({
    draft,
    operational,
    frrRows,
    financeEvents,
    reimbursementRows,
    operatorSelection,
    operationalRowFound,
  });

  const limit = opts?.limit ?? MAX_CANDIDATES;
  const truncated = all.length > limit;
  const candidates = all.slice(0, limit);

  let claimCandidateId = opts?.claim_candidate_id ?? null;
  if (!claimCandidateId) {
    const linked = await resolveCandidateForDraft(client, draft.organization_id, draft);
    claimCandidateId = linked?.id ?? null;
  }

  return {
    schema_version: "trid-reference-candidates-v1",
    draft_id: draft.id,
    organization_id: draft.organization_id,
    claim_candidate_id: claimCandidateId,
    outcome,
    candidate_count: all.length,
    candidate_count_returned: candidates.length,
    truncated,
    candidates,
    operational: operational
      ? {
          source_table: draft.source_table,
          source_row_id: draft.source_row_id,
          order_id: operational.order_id,
          sku: operational.sku,
          fnsku: operational.fnsku,
          operational_upload_id: operational.upload_id,
        }
      : null,
    warnings: buildReferenceCandidatesWarnings(outcome, candidates),
    does_not_submit: true,
  };
}

export async function buildReferenceCandidatesResponseForDraftId(
  client: SupabaseClient,
  organizationId: string,
  draftId: string,
  opts?: { claim_candidate_id?: string | null; limit?: number },
): Promise<ReferenceCandidatesResponse | null> {
  const draft = await fetchDraftRow(client, organizationId, draftId);
  if (!draft) return null;
  return loadAndBuildReferenceCandidatesForDraft(client, draft, opts);
}
