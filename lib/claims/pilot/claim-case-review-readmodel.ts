/**
 * PHASE-CLAIM-CASE-REVIEW-UI-V1
 * Read-only Claim Center case review read model over pilot-created claim_cases.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID } from "./claim-pilot-review-readmodel";

export const CLAIM_CASE_REVIEW_READMODEL_VERSION = "claim-case-review-readmodel-v1" as const;

export const CASE_CREATION_PILOT_ORIGIN = "case_creation_pilot_v1" as const;

/** Pilot execute run from PHASE-CLAIM-CASE-CREATION-PILOT-V1. */
export const DEFAULT_PILOT_CASE_RUN_ID = "pilot-20260615T190000Z";

export type ClaimCaseReviewReferenceEdge = {
  id: string;
  edge_type: string | null;
  reference_kind: string | null;
  reference_value: string | null;
  candidate_id: string | null;
};

export type ClaimCaseReviewLine = {
  id: string;
  claim_case_id: string;
  claim_candidate_id: string | null;
  quantity_expected: number | null;
  status: string | null;
  idempotency_key: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  line_grain: string | null;
  discrepancy_kind: string | null;
  metadata: Record<string, unknown>;
};

export type ClaimCaseReviewRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  claim_source: string | null;
  claim_subtype: string | null;
  claim_family: string | null;
  family_key_v3: string | null;
  status: string | null;
  idempotency_key: string | null;
  source_event_key: string | null;
  candidate_ids: string[];
  intake_run_id: string | null;
  pilot_case_run_id: string | null;
  case_creation_origin: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  quantity_expected: number | null;
  clean_quantity: number | null;
  money_lanes: Record<string, unknown>;
  operator_review_attested: boolean;
  operator_review_attested_by: string | null;
  operator_review_attested_at: string | null;
  evidence_packet_snapshot: Record<string, unknown> | null;
  source_event_date: string | null;
  date_gate_passed: boolean;
  rollback_metadata: Record<string, unknown> | null;
  lines: ClaimCaseReviewLine[];
  reference_edges: ClaimCaseReviewReferenceEdge[];
  warnings: string[];
  metadata: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
};

export type ClaimCaseReviewSummary = {
  total_pilot_cases: number;
  open_cases: number;
  by_family_key_v3: Record<string, number>;
  total_clean_quantity: number;
  money_lane_availability: {
    estimated_amazon_payout: number;
    observed_reimbursement: number;
    internal_cost_loss: number;
    recovery_value: number;
  };
  warning_count: number;
};

export type ClaimCaseReviewPayload = {
  version: typeof CLAIM_CASE_REVIEW_READMODEL_VERSION;
  pilot_case_run_id: string;
  intake_run_id: string;
  case_creation_origin: string;
  read_only: true;
  rows: ClaimCaseReviewRow[];
  summary: ClaimCaseReviewSummary;
  expected_pilot_cap: number;
  expected_family_distribution: {
    removal_shipment_missing: number;
    removal_order_discrepancy: number;
  };
  claim_submissions_count: number;
};

export type ClaimCaseReviewQuery = {
  pilot_case_run_id?: string | null;
  intake_run_id?: string | null;
  family_key_v3?: string | null;
  claim_family?: string | null;
  source_event_key?: string | null;
  status?: string | null;
  product_query?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  limit?: number;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseCandidateIds(meta: Record<string, unknown>): string[] {
  const raw = meta.candidate_ids;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => str(x)).filter(Boolean);
}

function packetSnapshot(meta: Record<string, unknown>): Record<string, unknown> | null {
  const snap =
    meta.evidence_packet_snapshot ?? meta.packet_snapshot;
  return snap && typeof snap === "object" && !Array.isArray(snap)
    ? (snap as Record<string, unknown>)
    : null;
}

function rollbackMeta(meta: Record<string, unknown>): Record<string, unknown> | null {
  const keys = [
    "pilot_rollback_at",
    "pilot_rollback_run_id",
    "detached_via_rollback",
    "superseded_at",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (meta[k] != null) out[k] = meta[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildWarnings(row: ClaimCaseReviewRow): string[] {
  const flags: string[] = [];
  if (!row.operator_review_attested) flags.push("operator_not_attested");
  if (!row.date_gate_passed) flags.push("date_gate_failed");
  if (!row.source_event_date) flags.push("missing_source_event_date");
  if (row.lines.length !== 1) flags.push("line_count_not_one");
  if (row.candidate_ids.length === 0) flags.push("missing_candidate_ids");
  if (row.rollback_metadata) flags.push("rollback_metadata_present");
  return flags;
}

function mapLine(row: Record<string, unknown>): ClaimCaseReviewLine {
  return {
    id: str(row.id),
    claim_case_id: str(row.claim_case_id),
    claim_candidate_id: str(row.claim_candidate_id) || null,
    quantity_expected: num(row.quantity_expected),
    status: str(row.status) || null,
    idempotency_key: str(row.idempotency_key) || null,
    sku: str(row.sku) || null,
    fnsku: str(row.fnsku) || null,
    asin: str(row.asin) || null,
    resolved_product_id: str(row.resolved_product_id) || null,
    line_grain: str(row.line_grain) || null,
    discrepancy_kind: str(row.discrepancy_kind) || null,
    metadata: metaRecord(row.metadata),
  };
}

function mapCaseRow(
  row: Record<string, unknown>,
  lines: ClaimCaseReviewLine[],
  edges: ClaimCaseReviewReferenceEdge[],
): ClaimCaseReviewRow {
  const meta = metaRecord(row.metadata);
  const packet = packetSnapshot(meta);
  const dateGate = packet?.date_gate as Record<string, unknown> | undefined;
  const qty = packet?.quantity as Record<string, unknown> | undefined;
  const cleanQty = num(qty?.clean_quantity);
  const primaryLine = lines[0];
  const moneyLanes = (meta.money_lanes as Record<string, unknown> | undefined) ?? {};

  const mapped: ClaimCaseReviewRow = {
    id: str(row.id),
    organization_id: str(row.organization_id),
    store_id: str(row.store_id) || null,
    claim_source: str(row.claim_source) || null,
    claim_subtype: str(row.claim_subtype) || null,
    claim_family: str(meta.claim_family) || null,
    family_key_v3: str(meta.family_key_v3) || str(row.claim_subtype) || null,
    status: str(row.status) || null,
    idempotency_key: str(row.idempotency_key) || null,
    source_event_key: str(meta.source_event_key) || null,
    candidate_ids: parseCandidateIds(meta),
    intake_run_id: str(meta.intake_run_id) || null,
    pilot_case_run_id: str(meta.pilot_case_run_id) || null,
    case_creation_origin: str(meta.case_creation_origin) || null,
    sku: str(row.primary_sku) || primaryLine?.sku || null,
    fnsku: primaryLine?.fnsku || null,
    asin: primaryLine?.asin || null,
    resolved_product_id: str(row.primary_resolved_product_id) || primaryLine?.resolved_product_id || null,
    quantity_expected: primaryLine?.quantity_expected ?? null,
    clean_quantity: cleanQty,
    money_lanes: moneyLanes,
    operator_review_attested: meta.operator_review_attested === true,
    operator_review_attested_by: str(meta.operator_review_attested_by) || null,
    operator_review_attested_at: str(meta.operator_review_attested_at) || null,
    evidence_packet_snapshot: packet,
    source_event_date: str(dateGate?.source_event_date) || null,
    date_gate_passed: dateGate?.date_gate_passed === true,
    rollback_metadata: rollbackMeta(meta),
    lines,
    reference_edges: edges,
    warnings: [],
    metadata: meta,
    created_at: str(row.created_at) || null,
    updated_at: str(row.updated_at) || null,
  };
  mapped.warnings = buildWarnings(mapped);
  return mapped;
}

function summarize(rows: ClaimCaseReviewRow[]): ClaimCaseReviewSummary {
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

function matchesProductQuery(row: ClaimCaseReviewRow, q: string): boolean {
  const needle = q.toLowerCase();
  return [row.sku, row.fnsku, row.asin, row.resolved_product_id]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

export function filterCaseReviewRows(
  rows: ClaimCaseReviewRow[],
  filters: ClaimCaseReviewQuery,
): ClaimCaseReviewRow[] {
  return rows.filter((r) => {
    if (filters.family_key_v3 && r.family_key_v3 !== filters.family_key_v3) return false;
    if (filters.claim_family && r.claim_family !== filters.claim_family) return false;
    if (filters.status && r.status !== filters.status) return false;
    if (filters.source_event_key) {
      const key = filters.source_event_key.toLowerCase();
      if (!str(r.source_event_key).toLowerCase().includes(key)) return false;
    }
    if (filters.product_query && !matchesProductQuery(r, filters.product_query)) return false;
    if (filters.date_from) {
      const d = r.source_event_date ?? "";
      if (!d || d < filters.date_from) return false;
    }
    if (filters.date_to) {
      const d = r.source_event_date ?? "";
      if (!d || d > filters.date_to) return false;
    }
    return true;
  });
}

const CASE_SELECT =
  "id, organization_id, store_id, claim_source, claim_subtype, status, idempotency_key, primary_sku, primary_resolved_product_id, metadata, created_at, updated_at";

export async function buildClaimCaseReviewReadmodel(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  query: ClaimCaseReviewQuery = {},
): Promise<ClaimCaseReviewPayload> {
  const pilotCaseRunId = str(query.pilot_case_run_id) || DEFAULT_PILOT_CASE_RUN_ID;
  const intakeRunId = str(query.intake_run_id) || DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID;
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);

  const { data: caseData, error: caseErr } = await client
    .from("claim_cases")
    .select(CASE_SELECT)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .filter("metadata->>case_creation_origin", "eq", CASE_CREATION_PILOT_ORIGIN)
    .filter("metadata->>pilot_case_run_id", "eq", pilotCaseRunId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (caseErr) throw new Error(caseErr.message);

  const rawCases = (caseData ?? []) as Record<string, unknown>[];
  const caseIds = rawCases.map((c) => str(c.id)).filter(Boolean);

  const linesByCase = new Map<string, ClaimCaseReviewLine[]>();
  const candidateIds = new Set<string>();

  if (caseIds.length > 0) {
    const { data: lineData, error: lineErr } = await client
      .from("claim_lines")
      .select(
        "id, claim_case_id, claim_candidate_id, quantity_expected, status, idempotency_key, sku, fnsku, asin, resolved_product_id, line_grain, discrepancy_kind, metadata",
      )
      .eq("organization_id", organizationId)
      .in("claim_case_id", caseIds);
    if (lineErr) throw new Error(lineErr.message);
    for (const row of lineData ?? []) {
      const line = mapLine(row as Record<string, unknown>);
      const bucket = linesByCase.get(line.claim_case_id) ?? [];
      bucket.push(line);
      linesByCase.set(line.claim_case_id, bucket);
      if (line.claim_candidate_id) candidateIds.add(line.claim_candidate_id);
    }
  }

  const edgesByCandidate = new Map<string, ClaimCaseReviewReferenceEdge[]>();
  const candList = [...candidateIds];
  for (let i = 0; i < candList.length; i += 50) {
    const chunk = candList.slice(i, i + 50);
    const { data: edgeData, error: edgeErr } = await client
      .from("claim_reference_edges")
      .select("id, edge_type, reference_kind, reference_value, candidate_id")
      .eq("organization_id", organizationId)
      .in("candidate_id", chunk);
    if (edgeErr) {
      if (!edgeErr.message.includes("does not exist")) throw new Error(edgeErr.message);
      break;
    }
    for (const row of edgeData ?? []) {
      const r = row as Record<string, unknown>;
      const cid = str(r.candidate_id);
      const edge: ClaimCaseReviewReferenceEdge = {
        id: str(r.id),
        edge_type: str(r.edge_type) || null,
        reference_kind: str(r.reference_kind) || null,
        reference_value: str(r.reference_value) || null,
        candidate_id: cid || null,
      };
      const bucket = edgesByCandidate.get(cid) ?? [];
      bucket.push(edge);
      edgesByCandidate.set(cid, bucket);
    }
  }

  const mapped = rawCases.map((c) => {
    const id = str(c.id);
    const lines = linesByCase.get(id) ?? [];
    const edges = lines.flatMap((l) =>
      l.claim_candidate_id ? edgesByCandidate.get(l.claim_candidate_id) ?? [] : [],
    );
    return mapCaseRow(c, lines, edges);
  });

  const filtered = filterCaseReviewRows(mapped, query).filter(
    (r) => !query.intake_run_id || r.intake_run_id === intakeRunId,
  );

  const submissionsCount = (
    await client
      .from("claim_submissions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
  ).count;

  return {
    version: CLAIM_CASE_REVIEW_READMODEL_VERSION,
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    case_creation_origin: CASE_CREATION_PILOT_ORIGIN,
    read_only: true,
    rows: filtered,
    summary: summarize(filtered),
    expected_pilot_cap: 10,
    expected_family_distribution: {
      removal_shipment_missing: 6,
      removal_order_discrepancy: 4,
    },
    claim_submissions_count: submissionsCount ?? 0,
  };
}
