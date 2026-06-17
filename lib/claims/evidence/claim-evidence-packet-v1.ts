/**
 * PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1
 * Read-only evidence packet preview composer for original pilot claim_candidates.
 * No DB writes. No status updates. No PDF. No AI.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isCleanExpectedPackageBuildStatus } from "@/lib/expected-packages-conflict-status";
import { loadMaterializedCandidateEdges } from "@/lib/claims/edges/claim-reference-edge-materializer";
import { mapRowToProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import { DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID } from "@/lib/claims/pilot/claim-pilot-review-readmodel";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "./claim-evidence-packet-v1-plan-contract";

export const CLAIM_EVIDENCE_PACKET_V1_VERSION = "claim-evidence-packet-v1" as const;
export const CLAIM_START_DATE = "2026-01-15";

export type EvidencePacketV1ProductIdentity = {
  product_id: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  title: string | null;
  linkage_status: "linked" | "unlinked" | "ambiguous" | "unknown";
  linkage_warnings: string[];
};

export type EvidencePacketV1Quantity = {
  clean_quantity: number | null;
  disputed_quantity_excluded: true;
  quantity_source: "expected_quantity" | "actual_quantity" | "metadata";
  disputed_context: string | null;
};

export type EvidencePacketV1DateGate = {
  source_event_date: string | null;
  effective_date_source: string | null;
  effective_date_value: string | null;
  date_gate_passed: boolean;
  pre_cutoff: boolean;
  claim_eligibility_window: { from: string | null; to: string | null };
};

export type EvidencePacketV1SourceEdge = {
  kind: string;
  table: string | null;
  row_id: string | null;
  label: string | null;
};

export type EvidencePacketV1ReferenceEdge = {
  reference_kind: string;
  reference_value: string;
  edge_source?: "metadata" | "materialized";
  edge_type?: string | null;
};

export type EvidencePacketV1MoneyLanes = {
  estimated_amazon_payout: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
  reimbursement_gap: number | null;
  recovery_value: number | null;
  expected_amount: number | null;
  currency: string | null;
  /** Display-only — never used as COGS substitute. */
  sale_price_display_only: number | null;
};

export type EvidencePacketV1Readiness = {
  ready_for_case_creation: "yes" | "no";
  blockers: string[];
};

export type ClaimEvidencePacketV1 = {
  version: typeof CLAIM_EVIDENCE_PACKET_V1_VERSION;
  packet_id: string;
  composed_at: string;
  candidate_id: string;
  intake_run_id: string | null;
  family_key_v3: string | null;
  claim_family: string | null;
  source_kind: string | null;
  source_table: string;
  source_row_id: string;
  source_event_key: string | null;
  dedupe_key: string | null;
  product_identity: EvidencePacketV1ProductIdentity;
  quantity: EvidencePacketV1Quantity;
  date_gate: EvidencePacketV1DateGate;
  source_edges: EvidencePacketV1SourceEdge[];
  evidence_pointers: Array<Record<string, unknown>>;
  reference_edges: EvidencePacketV1ReferenceEdge[];
  money_lanes: EvidencePacketV1MoneyLanes;
  review_flags: string[];
  blocker_flags: string[];
  evidence_summary: string | null;
  readiness: EvidencePacketV1Readiness;
};

export type ClaimEvidencePacketV1BatchSummary = {
  total_packets: number;
  ready_for_case_creation_count: number;
  blocker_counts: Record<string, number>;
  warning_counts: Record<string, number>;
  family_distribution: Record<string, number>;
  date_gate_passed_count: number;
  source_edges_present_count: number;
  evidence_summary_present_count: number;
  money_lane_null_counts: {
    estimated_amazon_payout_null: number;
    observed_reimbursement_null: number;
    internal_cost_loss_null: number;
    cogs_null: number;
  };
};

export type ClaimEvidencePacketV1Payload = {
  version: typeof CLAIM_EVIDENCE_PACKET_V1_VERSION;
  read_only: true;
  intake_run_id: string;
  packets: ClaimEvidencePacketV1[];
  summary: ClaimEvidencePacketV1BatchSummary;
};

export type ComposeEvidencePacketV1Query = {
  intake_run_id?: string | null;
  candidate_id?: string | null;
  limit?: number;
};

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function optStr(v: unknown): string | null {
  const s = str(v);
  return s || null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

function meta(row: Row): Record<string, unknown> {
  const m = row.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

function parseMetadataEdges(m: Record<string, unknown>): EvidencePacketV1ReferenceEdge[] {
  const raw = m.reference_edges;
  if (!Array.isArray(raw)) return [];
  const out: EvidencePacketV1ReferenceEdge[] = [];
  for (const e of raw) {
    const o = e as Row;
    const kind = str(o.reference_kind);
    const value = str(o.reference_value);
    if (!kind || !value) continue;
    out.push({ reference_kind: kind, reference_value: value, edge_source: "metadata" });
  }
  return out;
}

function parseEvidencePointers(m: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = m.evidence_pointers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
}

function parseSourceEdges(
  m: Record<string, unknown>,
  sourceTable: string,
  sourceRowId: string,
  pointers: Array<Record<string, unknown>>,
): EvidencePacketV1SourceEdge[] {
  const edges: EvidencePacketV1SourceEdge[] = [];
  if (sourceTable && sourceRowId) {
    edges.push({
      kind: "primary_source",
      table: sourceTable,
      row_id: sourceRowId,
      label: `${sourceTable}:${sourceRowId}`,
    });
  }
  const epId = str(m.expected_package_id);
  if (epId && !edges.some((e) => e.table === "expected_packages" && e.row_id === epId)) {
    edges.push({ kind: "expected_package", table: "expected_packages", row_id: epId, label: epId });
  }
  for (const ptr of pointers) {
    const table = str(ptr.table);
    const rowId = str(ptr.id ?? ptr.row_id);
    if (!table || !rowId) continue;
    if (edges.some((e) => e.table === table && e.row_id === rowId)) continue;
    edges.push({
      kind: str(ptr.kind) || "evidence_pointer",
      table,
      row_id: rowId,
      label: str(ptr.label) || `${table}:${rowId}`,
    });
  }
  return edges;
}

function mergeReferenceEdges(
  metadataEdges: EvidencePacketV1ReferenceEdge[],
  materialized: Array<Record<string, unknown>>,
): EvidencePacketV1ReferenceEdge[] {
  const out: EvidencePacketV1ReferenceEdge[] = [];
  const seen = new Set<string>();
  const push = (e: EvidencePacketV1ReferenceEdge) => {
    const k = `${e.edge_type ?? ""}:${e.reference_kind}:${e.reference_value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const row of materialized) {
    const kind = str(row.reference_kind) ?? str(row.edge_type) ?? "edge";
    const value = str(row.reference_value) ?? str(row.to_source_row_id);
    if (!value) continue;
    push({
      reference_kind: kind,
      reference_value: value,
      edge_source: "materialized",
      edge_type: str(row.edge_type) || null,
    });
  }
  for (const e of metadataEdges) push(e);
  return out;
}

function moneyLanesFromRow(row: Row, m: Record<string, unknown>): EvidencePacketV1MoneyLanes {
  const lanes = (m.money_lanes ?? {}) as Record<string, unknown>;
  const saleCtx = (m.sale_context ?? {}) as Record<string, unknown>;
  return {
    estimated_amazon_payout: num(lanes.estimated_amazon_payout),
    observed_reimbursement: num(lanes.observed_reimbursement),
    internal_cost_loss: num(lanes.internal_cost_loss),
    reimbursement_gap: num(lanes.reimbursement_gap),
    recovery_value: num(row.recovery_value),
    expected_amount: num(row.expected_amount),
    currency: str(row.currency) || null,
    sale_price_display_only: num(saleCtx.list_price ?? saleCtx.sale_price),
  };
}

function deriveReviewAndBlockerFlags(input: {
  m: Record<string, unknown>;
  referenceEdges: EvidencePacketV1ReferenceEdge[];
  sourceEdges: EvidencePacketV1SourceEdge[];
  evidenceSummary: string | null;
  sourceEventDate: string | null;
  dateGatePassed: boolean;
  preCutoff: boolean;
  disputed: boolean;
  linkageStatus: EvidencePacketV1ProductIdentity["linkage_status"];
  money: EvidencePacketV1MoneyLanes;
}): { review_flags: string[]; blocker_flags: string[]; blockers: string[] } {
  const review_flags: string[] = [];
  const blocker_flags: string[] = [];

  if (!input.sourceEventDate) blocker_flags.push("missing_source_event_date");
  if (input.preCutoff) blocker_flags.push("pre_cutoff");
  if (!input.dateGatePassed) blocker_flags.push("date_gate_failed");
  if (input.referenceEdges.length === 0) blocker_flags.push("missing_reference_edges");
  if (input.sourceEdges.length === 0) blocker_flags.push("missing_source_edges");
  if (!input.evidenceSummary) blocker_flags.push("missing_evidence_summary");
  if (input.disputed) blocker_flags.push("disputed_source_row");

  const lanes = (input.m.money_lanes ?? {}) as Record<string, unknown>;
  if (lanes.fee_payout_unavailable === true || input.money.estimated_amazon_payout == null) {
    review_flags.push("missing_fee");
  }
  if (lanes.cogs_unavailable === true || input.money.internal_cost_loss == null) {
    review_flags.push("missing_cost");
  }
  if (input.linkageStatus === "unlinked" || input.linkageStatus === "ambiguous") {
    review_flags.push("missing_product_link");
  }
  if (Array.isArray(input.m.review_flags)) {
    for (const f of input.m.review_flags) {
      const s = str(f);
      if (s) review_flags.push(s);
    }
  }
  if (input.m.policy_hold === true) review_flags.push("policy_hold");
  if (num(input.m.confidence_score) != null && num(input.m.confidence_score)! < 0.5) {
    review_flags.push("low_confidence");
  }
  review_flags.push("missing_photo_evidence");

  const blockers = [...new Set(blocker_flags)];
  return {
    review_flags: [...new Set(review_flags)],
    blocker_flags: blockers,
    blockers,
  };
}

function summarizePackets(packets: ClaimEvidencePacketV1[]): ClaimEvidencePacketV1BatchSummary {
  const blocker_counts: Record<string, number> = {};
  const warning_counts: Record<string, number> = {};
  const family_distribution: Record<string, number> = {};
  let ready = 0;
  let date_gate_passed_count = 0;
  let source_edges_present_count = 0;
  let evidence_summary_present_count = 0;
  let estimated_null = 0;
  let observed_null = 0;
  let cost_null = 0;
  let cogs_null = 0;

  for (const p of packets) {
    const fam = p.family_key_v3 ?? "unknown";
    family_distribution[fam] = (family_distribution[fam] ?? 0) + 1;
    if (p.readiness.ready_for_case_creation === "yes") ready += 1;
    if (p.date_gate.date_gate_passed) date_gate_passed_count += 1;
    if (p.source_edges.length > 0) source_edges_present_count += 1;
    if (p.evidence_summary) evidence_summary_present_count += 1;
    if (p.money_lanes.estimated_amazon_payout == null) estimated_null += 1;
    if (p.money_lanes.observed_reimbursement == null) observed_null += 1;
    if (p.money_lanes.internal_cost_loss == null) cost_null += 1;
    if (p.money_lanes.recovery_value == null && p.money_lanes.expected_amount == null) cogs_null += 1;
    for (const b of p.blocker_flags) blocker_counts[b] = (blocker_counts[b] ?? 0) + 1;
    for (const w of p.review_flags) warning_counts[w] = (warning_counts[w] ?? 0) + 1;
  }

  return {
    total_packets: packets.length,
    ready_for_case_creation_count: ready,
    blocker_counts,
    warning_counts,
    family_distribution,
    date_gate_passed_count,
    source_edges_present_count,
    evidence_summary_present_count,
    money_lane_null_counts: {
      estimated_amazon_payout_null: estimated_null,
      observed_reimbursement_null: observed_null,
      internal_cost_loss_null: cost_null,
      cogs_null,
    },
  };
}

async function resolveProductIdentity(
  client: SupabaseClient,
  organizationId: string,
  row: Row,
): Promise<EvidencePacketV1ProductIdentity> {
  const productId = optStr(row.resolved_product_id);
  let productRow: Record<string, unknown> | null = null;
  if (productId) {
    const { data, error } = await client
      .from("products")
      .select("id, name, product_name, asin, fnsku, seller_sku")
      .eq("organization_id", organizationId)
      .eq("id", productId)
      .maybeSingle();
    if (!error) {
      productRow = (data as Record<string, unknown> | null) ?? null;
    }
  }
  const contract = mapRowToProductLinkageDisplayContract({
    source_table: str(row.source_table),
    source_row_id: str(row.source_row_id),
    row,
    product: productRow
      ? {
          id: optStr(productRow.id),
          name: optStr(productRow.name) || optStr(productRow.product_name),
          product_name: optStr(productRow.product_name),
        }
      : null,
  });
  const resolvedId = productId || contract.resolved_product_id || null;
  const linkageStatus: EvidencePacketV1ProductIdentity["linkage_status"] = contract.is_resolved
    ? "linked"
    : contract.identifier_resolution_status === "ambiguous"
      ? "ambiguous"
      : resolvedId
        ? "linked"
        : "unlinked";
  return {
    product_id: resolvedId,
    asin: optStr(row.asin) || contract.asin,
    fnsku: optStr(row.fnsku) || contract.fnsku,
    sku: optStr(row.sku) || contract.sku,
    title: contract.product_name,
    linkage_status: linkageStatus,
    linkage_warnings:
      contract.identifier_resolution_status === "ambiguous"
        ? ["ambiguous_identifier"]
        : !contract.is_resolved
          ? ["unresolved_identifier"]
          : [],
  };
}

const CANDIDATE_SELECT =
  "id, organization_id, store_id, intake_run_id, source_kind, source_table, source_row_id, claim_family, candidate_status, evidence_status, dedupe_key, source_event_key, sku, fnsku, asin, resolved_product_id, expected_quantity, actual_quantity, recovery_value, cogs_unit, expected_amount, currency, event_date, metadata, quarantined_at, rejected_at";

async function loadCandidateRows(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  query: ComposeEvidencePacketV1Query,
): Promise<Row[]> {
  const intakeRunId = str(query.intake_run_id) || ORIGINAL_PILOT_INTAKE_RUN_ID;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 50);
  const candidateId = str(query.candidate_id);

  let q = client
    .from("claim_candidates")
    .select(CANDIDATE_SELECT)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("intake_run_id", intakeRunId)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed")
    .order("created_at", { ascending: true });

  if (candidateId) q = q.eq("id", candidateId);
  else q = q.limit(limit);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

async function composeOnePacket(
  client: SupabaseClient,
  organizationId: string,
  row: Row,
  materializedEdges: Array<Record<string, unknown>>,
  linkage: EvidencePacketV1ProductIdentity,
  epBuildStatus: string | null,
): Promise<ClaimEvidencePacketV1> {
  const m = meta(row);
  const sourceEventDate = str(m.source_event_date ?? row.event_date);
  const dateGatePassed = m.date_gate_passed === true;
  const preCutoff =
    m.pre_cutoff === true || (!!sourceEventDate && sourceEventDate < CLAIM_START_DATE);
  const evidenceSummary = str(m.evidence_summary) || null;
  const pointers = parseEvidencePointers(m);
  const metadataEdges = parseMetadataEdges(m);
  const referenceEdges = mergeReferenceEdges(metadataEdges, materializedEdges);
  const sourceTable = str(row.source_table);
  const sourceRowId = str(row.source_row_id);
  const sourceEdges = parseSourceEdges(m, sourceTable, sourceRowId, pointers);
  const money = moneyLanesFromRow(row, m);

  const disputed =
    sourceTable === "expected_packages" &&
    !!epBuildStatus &&
    !isCleanExpectedPackageBuildStatus(epBuildStatus);

  const cleanQty = disputed ? null : num(row.expected_quantity) ?? num(row.actual_quantity);
  const window = (m.window ?? {}) as Record<string, unknown>;

  const { review_flags, blocker_flags, blockers } = deriveReviewAndBlockerFlags({
    m,
    referenceEdges,
    sourceEdges,
    evidenceSummary,
    sourceEventDate: sourceEventDate || null,
    dateGatePassed,
    preCutoff,
    disputed,
    linkageStatus: linkage.linkage_status,
    money,
  });

  return {
    version: CLAIM_EVIDENCE_PACKET_V1_VERSION,
    packet_id: crypto.randomUUID(),
    composed_at: new Date().toISOString(),
    candidate_id: str(row.id),
    intake_run_id: str(row.intake_run_id) || null,
    family_key_v3: str(m.family_key_v3) || str(row.claim_family) || null,
    claim_family: str(row.claim_family) || null,
    source_kind: str(row.source_kind) || null,
    source_table: sourceTable,
    source_row_id: sourceRowId,
    source_event_key: str(row.source_event_key) || null,
    dedupe_key: str(row.dedupe_key) || null,
    product_identity: linkage,
    quantity: {
      clean_quantity: cleanQty,
      disputed_quantity_excluded: true,
      quantity_source: num(row.expected_quantity) != null ? "expected_quantity" : "actual_quantity",
      disputed_context: disputed ? `expected_packages.build_status=${epBuildStatus}` : null,
    },
    date_gate: {
      source_event_date: sourceEventDate || null,
      effective_date_source: str(m.effective_date_source) || null,
      effective_date_value: str(m.effective_date_value) || null,
      date_gate_passed: dateGatePassed,
      pre_cutoff: preCutoff,
      claim_eligibility_window: {
        from: str(window.from) || CLAIM_START_DATE,
        to: str(window.to) || null,
      },
    },
    source_edges: sourceEdges,
    evidence_pointers: pointers,
    reference_edges: referenceEdges,
    money_lanes: money,
    review_flags,
    blocker_flags,
    evidence_summary: evidenceSummary,
    readiness: {
      ready_for_case_creation: blockers.length === 0 ? "yes" : "no",
      blockers,
    },
  };
}

export async function composeClaimEvidencePacketV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  query: ComposeEvidencePacketV1Query = {},
): Promise<ClaimEvidencePacketV1Payload> {
  const intakeRunId = str(query.intake_run_id) || DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID;
  const rows = await loadCandidateRows(client, organizationId, storeId, {
    ...query,
    intake_run_id: intakeRunId,
  });

  const candidateIds = rows.map((r) => str(r.id)).filter(Boolean);
  const materializedByCandidate = await loadMaterializedCandidateEdges(
    client,
    organizationId,
    candidateIds,
  );

  const linkages = await Promise.all(    rows.map((r) => resolveProductIdentity(client, organizationId, r)),
  );

  const epIds = rows
    .filter((r) => str(r.source_table) === "expected_packages")
    .map((r) => str(r.source_row_id));
  const epBuild = new Map<string, string>();
  for (let i = 0; i < epIds.length; i += 100) {
    const chunk = epIds.slice(i, i + 100);
    const { data, error } = await client
      .from("expected_packages")
      .select("id, build_status")
      .eq("organization_id", organizationId)
      .in("id", chunk);
    if (error) throw new Error(error.message);
    for (const ep of data ?? []) {
      epBuild.set(String((ep as { id: string }).id), String((ep as { build_status?: string }).build_status ?? ""));
    }
  }

  const packets: ClaimEvidencePacketV1[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const linkage = linkages[i]!;
    const epStatus =
      str(row.source_table) === "expected_packages"
        ? epBuild.get(str(row.source_row_id)) ?? str(meta(row).build_status)
        : null;
    packets.push(
      await composeOnePacket(
        client,
        organizationId,
        row,
        materializedByCandidate.get(str(row.id)) ?? [],
        linkage,
        epStatus,
      ),
    );
  }

  return {
    version: CLAIM_EVIDENCE_PACKET_V1_VERSION,
    read_only: true,
    intake_run_id: intakeRunId,
    packets,
    summary: summarizePackets(packets),
  };
}

export async function composeClaimEvidencePacketV1Single(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  candidateId: string,
  intakeRunId?: string | null,
): Promise<ClaimEvidencePacketV1 | null> {
  const payload = await composeClaimEvidencePacketV1(client, organizationId, storeId, {
    candidate_id: candidateId,
    intake_run_id: intakeRunId ?? ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 1,
  });
  return payload.packets[0] ?? null;
}
