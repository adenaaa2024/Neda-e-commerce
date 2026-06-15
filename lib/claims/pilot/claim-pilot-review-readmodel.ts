/**
 * PHASE-CLAIM-CANDIDATE-REVIEW-UI-ORIGINAL-PILOT-V1
 * Read-only Claim Center pilot review read model over emitted claim_candidates.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isCleanExpectedPackageBuildStatus } from "@/lib/expected-packages-conflict-status";

export const CLAIM_PILOT_REVIEW_READMODEL_VERSION = "claim-pilot-review-readmodel-v1" as const;

/** Original emit pilot intake run (cap 50). */
export const DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID = "a8a892fe-37d5-4d74-9ea2-02af8fd095ce";

export type ClaimPilotReviewReferenceEdge = {
  reference_kind: string;
  reference_value: string;
};

export type ClaimPilotReviewEvidencePointer = {
  kind?: string;
  table?: string;
  row_id?: string;
  label?: string;
  [key: string]: unknown;
};

export type ClaimPilotReviewRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  intake_run_id: string | null;
  source_kind: string | null;
  source_table: string;
  source_row_id: string;
  claim_family: string | null;
  family_key_v3: string | null;
  candidate_status: string | null;
  evidence_status: string | null;
  dedupe_key: string | null;
  source_event_key: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  expected_quantity: number | null;
  recovery_value: number | null;
  cogs_unit: number | null;
  currency: string | null;
  event_date: string | null;
  source_event_date: string | null;
  effective_date_source: string | null;
  effective_date_value: string | null;
  date_gate_passed: boolean;
  pre_cutoff: boolean;
  missing_event_date: boolean;
  evidence_summary: string | null;
  preview_id: string | null;
  emit_origin: string | null;
  reference_edges: ClaimPilotReviewReferenceEdge[];
  evidence_pointers: ClaimPilotReviewEvidencePointer[];
  review_flags: string[];
  rollback_mode: string | null;
  rollback_run_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
};

export type ClaimPilotReviewSummary = {
  total_pilot_candidates: number;
  detected_count: number;
  by_family_key_v3: Record<string, number>;
  by_claim_family: Record<string, number>;
  by_evidence_status: Record<string, number>;
  date_gate_passed_count: number;
  missing_evidence_count: number;
  by_source_kind: Record<string, number>;
};

export type ClaimPilotReviewPayload = {
  version: typeof CLAIM_PILOT_REVIEW_READMODEL_VERSION;
  intake_run_id: string;
  read_only: true;
  rows: ClaimPilotReviewRow[];
  summary: ClaimPilotReviewSummary;
  family_distribution_expected: {
    removal_shipment_missing: number;
    removal_order_discrepancy: number;
  };
  claim_cases_count: number;
};

export type ClaimPilotReviewQuery = {
  intake_run_id?: string | null;
  family_key_v3?: string | null;
  claim_family?: string | null;
  source_kind?: string | null;
  candidate_status?: string | null;
  evidence_status?: string | null;
  product_query?: string | null;
  source_event_key?: string | null;
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

function parseEdges(meta: Record<string, unknown>): ClaimPilotReviewReferenceEdge[] {
  const raw = meta.reference_edges;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => {
      const o = e as Record<string, unknown>;
      const kind = str(o.reference_kind);
      const value = str(o.reference_value);
      if (!kind || !value) return null;
      return { reference_kind: kind, reference_value: value };
    })
    .filter((x): x is ClaimPilotReviewReferenceEdge => x !== null);
}

function parsePointers(meta: Record<string, unknown>): ClaimPilotReviewEvidencePointer[] {
  const raw = meta.evidence_pointers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => x && typeof x === "object") as ClaimPilotReviewEvidencePointer[];
}

function reviewFlags(meta: Record<string, unknown>): string[] {
  const flags: string[] = [];
  if (meta.pre_cutoff === true) flags.push("pre_cutoff");
  if (meta.date_gate_passed !== true) flags.push("date_gate_failed");
  const action = str(meta.recommended_action ?? meta.preview_status);
  if (action === "needs_review" || action === "unavailable") flags.push(action);
  if (Array.isArray(meta.review_flags)) {
    for (const f of meta.review_flags) {
      const s = str(f);
      if (s) flags.push(s);
    }
  }
  return [...new Set(flags)];
}

function mapRow(row: Record<string, unknown>): ClaimPilotReviewRow {
  const meta = metaRecord(row.metadata);
  const sourceEventDate = str(meta.source_event_date ?? row.event_date);
  const dateGatePassed = meta.date_gate_passed === true;
  return {
    id: str(row.id),
    organization_id: str(row.organization_id),
    store_id: str(row.store_id) || null,
    intake_run_id: str(row.intake_run_id) || null,
    source_kind: str(row.source_kind) || null,
    source_table: str(row.source_table),
    source_row_id: str(row.source_row_id),
    claim_family: str(row.claim_family) || null,
    family_key_v3: str(meta.family_key_v3) || str(row.claim_family) || null,
    candidate_status: str(row.candidate_status) || null,
    evidence_status: str(row.evidence_status) || null,
    dedupe_key: str(row.dedupe_key) || null,
    source_event_key: str(row.source_event_key) || null,
    sku: str(row.sku) || null,
    fnsku: str(row.fnsku) || null,
    asin: str(row.asin) || null,
    resolved_product_id: str(row.resolved_product_id) || null,
    expected_quantity: num(row.expected_quantity),
    recovery_value: num(row.recovery_value),
    cogs_unit: num(row.cogs_unit),
    currency: str(row.currency) || null,
    event_date: str(row.event_date) || null,
    source_event_date: sourceEventDate || null,
    effective_date_source: str(meta.effective_date_source) || null,
    effective_date_value: str(meta.effective_date_value) || null,
    date_gate_passed: dateGatePassed,
    pre_cutoff: meta.pre_cutoff === true || (!!sourceEventDate && sourceEventDate < "2026-01-15"),
    missing_event_date: !sourceEventDate,
    evidence_summary: str(meta.evidence_summary) || null,
    preview_id: str(meta.preview_id) || null,
    emit_origin: str(meta.emit_origin) || null,
    reference_edges: parseEdges(meta),
    evidence_pointers: parsePointers(meta),
    review_flags: reviewFlags(meta),
    rollback_mode: str(meta.rollback_mode) || null,
    rollback_run_id: str(meta.rollback_run_id) || null,
    metadata: meta,
    created_at: str(row.created_at) || null,
    updated_at: str(row.updated_at) || null,
  };
}

function summarize(rows: ClaimPilotReviewRow[]): ClaimPilotReviewSummary {
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

function matchesProductQuery(row: ClaimPilotReviewRow, q: string): boolean {
  const needle = q.toLowerCase();
  return [row.sku, row.fnsku, row.asin, row.resolved_product_id]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

export function filterPilotReviewRows(
  rows: ClaimPilotReviewRow[],
  filters: ClaimPilotReviewQuery,
): ClaimPilotReviewRow[] {
  return rows.filter((r) => {
    if (filters.family_key_v3 && r.family_key_v3 !== filters.family_key_v3) return false;
    if (filters.claim_family && r.claim_family !== filters.claim_family) return false;
    if (filters.source_kind && r.source_kind !== filters.source_kind) return false;
    if (filters.candidate_status && r.candidate_status !== filters.candidate_status) return false;
    if (filters.evidence_status && r.evidence_status !== filters.evidence_status) return false;
    if (filters.source_event_key) {
      const key = filters.source_event_key.toLowerCase();
      if (!str(r.source_event_key).toLowerCase().includes(key)) return false;
    }
    if (filters.product_query && !matchesProductQuery(r, filters.product_query)) return false;
    if (filters.date_from) {
      const d = r.source_event_date ?? r.event_date ?? "";
      if (!d || d < filters.date_from) return false;
    }
    if (filters.date_to) {
      const d = r.source_event_date ?? r.event_date ?? "";
      if (!d || d > filters.date_to) return false;
    }
    return true;
  });
}

const PILOT_SELECT =
  "id, organization_id, store_id, intake_run_id, source_kind, source_table, source_row_id, claim_family, candidate_status, evidence_status, dedupe_key, source_event_key, sku, fnsku, asin, resolved_product_id, expected_quantity, recovery_value, cogs_unit, currency, event_date, metadata, created_at, updated_at, quarantined_at, rejected_at";

export async function buildClaimPilotReviewReadmodel(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  query: ClaimPilotReviewQuery = {},
): Promise<ClaimPilotReviewPayload> {
  const intakeRunId = str(query.intake_run_id) || DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID;
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);

  const { data, error } = await client
    .from("claim_candidates")
    .select(PILOT_SELECT)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("intake_run_id", intakeRunId)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);

  const rawRows = (data ?? []) as Record<string, unknown>[];
  const mapped = rawRows.map(mapRow);
  const filtered = filterPilotReviewRows(mapped, query);

  const epIds = [
    ...new Set(
      filtered.filter((r) => r.source_table === "expected_packages").map((r) => r.source_row_id),
    ),
  ];
  const epBuild = new Map<string, string>();
  for (let i = 0; i < epIds.length; i += 100) {
    const chunk = epIds.slice(i, i + 100);
    const { data: eps, error: epErr } = await client
      .from("expected_packages")
      .select("id, build_status")
      .eq("organization_id", organizationId)
      .in("id", chunk);
    if (epErr) throw new Error(epErr.message);
    for (const ep of eps ?? []) {
      epBuild.set(String((ep as { id: string }).id), String((ep as { build_status?: string }).build_status ?? ""));
    }
  }

  const rows = filtered.filter((r) => {
    if (r.source_table !== "expected_packages") return true;
    const bs = epBuild.get(r.source_row_id) ?? str(r.metadata.build_status);
    return !bs || isCleanExpectedPackageBuildStatus(bs);
  });

  const casesCount = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", organizationId)
  ).count;

  return {
    version: CLAIM_PILOT_REVIEW_READMODEL_VERSION,
    intake_run_id: intakeRunId,
    read_only: true,
    rows,
    summary: summarize(rows),
    family_distribution_expected: {
      removal_shipment_missing: 30,
      removal_order_discrepancy: 20,
    },
    claim_cases_count: casesCount ?? 0,
  };
}
