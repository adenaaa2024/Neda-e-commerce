/**
 * NEXT-CLAIM-EVIDENCE-03 — Live-query evidence graph preview (read-only).
 * Does NOT insert claim_reference_edges or lineage events.
 */

import * as crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const CHUNK = 150;
const ORDER_CHUNK = 40;
const FRR_SELECT =
  "trid_key, source_table, source_row_id, settlement_id, order_id, sku, confidence_score, reference_group_key, transaction_type";
const FINANCES_EVENT_SELECT =
  "id, event_group_id, order_id, removal_order_id, reimbursement_id, event_type, posted_at, sku, amount, currency";
export const MAX_FRR_EDGES_PER_DRAFT = 24;
export const MAX_PREVIEW_EDGES = 80;
/** Max persisted rows returned to browser (pilot draft has 51). */
export const MAX_PERSISTED_EDGES_LIST = 120;
const RETURN_ITEM_SELECT =
  "id, package_id, order_id, sku, fnsku, resolved_product_id, identifier_resolution_status, identifier_resolution_confidence";
const SLIP_SELECT =
  "id, package_id, slip_code, resolved_product_id, identifier_resolution_status, identifier_resolution_confidence";
const ALLOC_SELECT =
  "id, removal_id, shipment_box_item_id, order_id, sku, fnsku, allocated_quantity, scanned_quantity, status";

export type ClaimEvidenceDraftRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  sku: string | null;
};

export type ClaimEvidencePreviewEdge = {
  edge_id: string;
  draft_id: string;
  organization_id: string;
  edge_type: string;
  from_node_kind: string;
  from_source_table: string;
  from_source_row_id: string;
  to_node_kind: string;
  to_source_table: string;
  to_source_row_id: string;
  reference_kind: string | null;
  reference_value: string | null;
  confidence_score: number;
  ambiguity_group_key: string | null;
  ambiguity_rank: number | null;
  edge_reason: string;
  source_table: string;
  source_citations: { kind: string; table: string; row_id?: string }[];
};

export type ClaimEvidencePreviewGroup = {
  group_key: string;
  label: string;
  source_table: string;
  edge_count: number;
  items: ClaimEvidencePreviewEdge[];
};

export type ClaimEvidenceWarning = {
  code: string;
  message: string;
  severity: "info" | "warn" | "error";
};

export type ClaimPersistedEvidenceSummary = {
  persisted_edge_count: number;
  lineage_event_count: number;
  generation_count: number;
  latest_generation_id: string | null;
  latest_generation_number: number | null;
  latest_idempotency_key: string | null;
  latest_status: string | null;
  evidence_hash: string | null;
};

export type ClaimEvidenceDisplayMode = "preview_only" | "persisted" | "persisted_with_live_preview";

export type ClaimPersistedEdgesPayload = {
  generation_id: string | null;
  edge_count_total: number;
  edge_count_returned: number;
  truncated: boolean;
  groups: ClaimEvidencePreviewGroup[];
  edges: ClaimEvidencePreviewEdge[];
};

export type ClaimEvidencePreview = {
  mode: "live_query_preview";
  /** True when `claim_reference_edges` has rows for this draft. */
  persisted_edges: boolean;
  evidence_display_mode: ClaimEvidenceDisplayMode;
  draft_id: string;
  claim_candidate_id: string | null;
  organization_id: string;
  source_table: string;
  source_row_id: string;
  edge_count_total: number;
  edge_count_returned: number;
  truncated: boolean;
  groups: ClaimEvidencePreviewGroup[];
  edges: ClaimEvidencePreviewEdge[];
  trid_candidates: {
    trid_key: string;
    source_table: string;
    source_row_id: string;
    confidence_score: number;
    ambiguity_group_key: string | null;
    ambiguity_rank: number | null;
  }[];
  warnings: ClaimEvidenceWarning[];
  enrichment: ClaimPersistedEvidenceSummary & {
    graph_tables_configured: boolean;
  };
};

export const EDGE_TYPE_LABELS: Record<string, string> = {
  claim_to_removal: "Removal anchor",
  claim_to_shipment: "Shipment / expected packages",
  operational_to_financial: "Operational → financial",
  claim_to_trid: "TRID / FRR reference",
  claim_to_settlement: "Finances archive",
  operational_to_slip_line: "Return item path",
  slip_line_to_product: "Slip line → product",
};

export const SOURCE_TABLE_LABELS: Record<string, string> = {
  amazon_removals: "Amazon removals",
  expected_packages: "Expected packages",
  removal_item_allocations: "Removal allocations",
  shipment_box_items: "Shipment box items",
  financial_reference_resolver: "Financial reference resolver",
  amazon_finances_events: "Amazon finances events",
  return_items: "Return items",
  slip_contents: "Slip contents",
  claim_candidate_drafts: "Claim draft",
};

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normSku(s: string | null | undefined): string | null {
  const t = nv(s);
  return t ? t.toLowerCase() : null;
}

export function previewEdgeId(draftId: string, parts: string[]): string {
  const h = crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `preview:${draftId.slice(0, 8)}:${h}`;
}

function numConf(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  if (v != null && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  }
  return fallback;
}

type RemovalRow = { id: string; order_id: string | null; sku: string | null; fnsku: string | null };

async function fetchRemoval(
  client: SupabaseClient,
  orgId: string,
  id: string,
): Promise<RemovalRow | null> {
  const { data, error } = await client
    .from("amazon_removals")
    .select("id, order_id, sku, fnsku")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  const rid = nv(r.id);
  if (!rid) return null;
  return { id: rid, order_id: nv(r.order_id), sku: nv(r.sku), fnsku: nv(r.fnsku) };
}

async function fetchExpected(
  client: SupabaseClient,
  orgId: string,
  detailId: string,
): Promise<{ count: number; sample_id: string | null } | undefined> {
  const { data, error } = await client
    .from("expected_packages")
    .select("id, source_detail_row_id")
    .eq("organization_id", orgId)
    .eq("source_detail_row_id", detailId);
  if (error) {
    if (error.message.includes("does not exist") || error.code === "42P01") return undefined;
    throw new Error(`expected_packages: ${error.message}`);
  }
  let count = 0;
  let sample_id: string | null = null;
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    count += 1;
    if (!sample_id) sample_id = nv(r.id);
  }
  return count > 0 ? { count, sample_id } : undefined;
}

async function fetchAllocations(
  client: SupabaseClient,
  orgId: string,
  removalId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client
    .from("removal_item_allocations")
    .select(ALLOC_SELECT)
    .eq("organization_id", orgId)
    .eq("removal_id", removalId);
  if (error) {
    if (error.message.includes("does not exist") || error.code === "42P01") return [];
    throw new Error(`removal_item_allocations: ${error.message}`);
  }
  return (data ?? []) as Record<string, unknown>[];
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
  orderId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client
    .from("amazon_finances_events")
    .select(FINANCES_EVENT_SELECT)
    .eq("organization_id", orgId)
    .eq("order_id", orderId)
    .limit(500);
  if (error) {
    if (error.message.includes("does not exist") || error.code === "42P01") return [];
    throw new Error(`amazon_finances_events: ${error.message}`);
  }
  return (data ?? []) as Record<string, unknown>[];
}

async function fetchReturnItemsByOrder(
  client: SupabaseClient,
  orgId: string,
  orderId: string,
  skuHint: string | null,
): Promise<Record<string, unknown>[]> {
  let q = client
    .from("return_items")
    .select(RETURN_ITEM_SELECT)
    .eq("organization_id", orgId)
    .eq("order_id", orderId)
    .limit(400);
  const hint = normSku(skuHint);
  if (hint) q = q.ilike("sku", hint);
  const { data, error } = await q;
  if (error) {
    if (error.message.includes("does not exist") || error.code === "42P01") return [];
    throw new Error(`return_items: ${error.message}`);
  }
  return (data ?? []) as Record<string, unknown>[];
}

async function fetchSlipsByPackageIds(
  client: SupabaseClient,
  orgId: string,
  packageIds: string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const byPkg = new Map<string, Record<string, unknown>[]>();
  for (let i = 0; i < packageIds.length; i += CHUNK) {
    const slice = packageIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("slip_contents")
      .select(SLIP_SELECT)
      .eq("organization_id", orgId)
      .in("package_id", slice)
      .limit(800);
    if (error) {
      if (error.message.includes("does not exist") || error.code === "42P01") return byPkg;
      throw new Error(`slip_contents: ${error.message}`);
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const pid = nv(row.package_id);
      if (!pid) continue;
      const arr = byPkg.get(pid) ?? [];
      arr.push(row);
      byPkg.set(pid, arr);
    }
  }
  return byPkg;
}

function filterFrrBySku(rows: Record<string, unknown>[], skuHint: string | null): Record<string, unknown>[] {
  const hint = normSku(skuHint);
  if (!hint) return rows;
  const matched = rows.filter((r) => normSku(nv(r.sku)) === hint);
  return matched.length > 0 ? matched : rows;
}

export function buildPreviewEdgesForDraft(
  draft: ClaimEvidenceDraftRow,
  removal: RemovalRow | null,
  expected: { count: number; sample_id: string | null } | undefined,
  allocations: Record<string, unknown>[],
  frrRows: Record<string, unknown>[],
  financeEvents: Record<string, unknown>[],
  returnItems: Record<string, unknown>[],
  slipsByPkg: Map<string, Record<string, unknown>[]>,
): ClaimEvidencePreviewEdge[] {
  const edges: ClaimEvidencePreviewEdge[] = [];
  const orgId = draft.organization_id;

  if (draft.source_table === "amazon_removals" && removal) {
    edges.push({
      edge_id: previewEdgeId(draft.id, ["claim_to_removal", draft.source_row_id]),
      draft_id: draft.id,
      organization_id: orgId,
      edge_type: "claim_to_removal",
      from_node_kind: "claim_draft",
      from_source_table: "claim_candidate_drafts",
      from_source_row_id: draft.id,
      to_node_kind: "removal",
      to_source_table: "amazon_removals",
      to_source_row_id: removal.id,
      reference_kind: null,
      reference_value: null,
      confidence_score: 1,
      ambiguity_group_key: null,
      ambiguity_rank: null,
      edge_reason: "draft.source_row_id anchors operational removal row",
      source_table: "amazon_removals",
      source_citations: [
        { kind: "live_query", table: "claim_candidate_drafts" },
        { kind: "live_query", table: "amazon_removals", row_id: removal.id },
      ],
    });

    if (expected && expected.count > 0) {
      edges.push({
        edge_id: previewEdgeId(draft.id, ["claim_to_shipment", "expected_packages", removal.id]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "claim_to_shipment",
        from_node_kind: "claim_draft",
        from_source_table: "claim_candidate_drafts",
        from_source_row_id: draft.id,
        to_node_kind: "shipment",
        to_source_table: "expected_packages",
        to_source_row_id: expected.sample_id ?? `aggregate:${removal.id}`,
        reference_kind: "expected_package_count",
        reference_value: String(expected.count),
        confidence_score: 0.85,
        ambiguity_group_key: null,
        ambiguity_rank: null,
        edge_reason: `expected_packages.source_detail_row_id = removal.id (${expected.count} rows)`,
        source_table: "expected_packages",
        source_citations: [{ kind: "live_query", table: "expected_packages" }],
      });
    }

    let rank = 0;
    for (const alloc of allocations) {
      const allocId = nv(alloc.id);
      const sbiId = nv(alloc.shipment_box_item_id);
      if (!allocId || !sbiId) continue;
      rank += 1;
      edges.push({
        edge_id: previewEdgeId(draft.id, ["claim_to_shipment", "allocation", allocId]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "claim_to_shipment",
        from_node_kind: "claim_draft",
        from_source_table: "claim_candidate_drafts",
        from_source_row_id: draft.id,
        to_node_kind: "shipment",
        to_source_table: "removal_item_allocations",
        to_source_row_id: allocId,
        reference_kind: "shipment_box_item_id",
        reference_value: sbiId,
        confidence_score: 0.9,
        ambiguity_group_key: `alloc:${removal.id}`,
        ambiguity_rank: rank,
        edge_reason: "removal_item_allocations.removal_id matches draft operational row",
        source_table: "removal_item_allocations",
        source_citations: [
          { kind: "live_query", table: "removal_item_allocations", row_id: allocId },
          { kind: "live_query", table: "shipment_box_items", row_id: sbiId },
        ],
      });
    }
  }

  const orderId = removal?.order_id ?? null;
  const skuHint = draft.sku ?? removal?.sku ?? null;

  if (orderId) {
    const filtered = filterFrrBySku(frrRows, skuHint)
      .sort((a, b) => numConf(b.confidence_score, 0) - numConf(a.confidence_score, 0))
      .slice(0, MAX_FRR_EDGES_PER_DRAFT);
    const ambKey =
      filtered.length > 1 ? `frr:${orderId}:${normSku(skuHint) ?? "no_sku"}` : null;
    let frrRank = 0;
    for (const row of filtered) {
      frrRank += 1;
      const trid = nv(row.trid_key) ?? "";
      const srcTable = nv(row.source_table) ?? "financial_reference_resolver";
      const srcRowId = nv(row.source_row_id) ?? trid;
      const conf = numConf(row.confidence_score, filtered.length === 1 ? 0.92 : 0.75);
      edges.push({
        edge_id: previewEdgeId(draft.id, ["operational_to_financial", trid, srcRowId]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "operational_to_financial",
        from_node_kind: "removal",
        from_source_table: draft.source_table,
        from_source_row_id: draft.source_row_id,
        to_node_kind: "financial_reference_resolver_row",
        to_source_table: srcTable,
        to_source_row_id: srcRowId,
        reference_kind: "internal_trid_key",
        reference_value: trid,
        confidence_score: conf,
        ambiguity_group_key: ambKey,
        ambiguity_rank: ambKey ? frrRank : null,
        edge_reason:
          filtered.length === 1
            ? "single FRR row for order_id (+ sku filter when matched)"
            : "multiple FRR rows for order_id; parallel candidates preserved",
        source_table: "financial_reference_resolver",
        source_citations: [{ kind: "live_query", table: "financial_reference_resolver", row_id: srcRowId }],
      });
      edges.push({
        edge_id: previewEdgeId(draft.id, ["claim_to_trid", trid, srcRowId]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "claim_to_trid",
        from_node_kind: "claim_draft",
        from_source_table: "claim_candidate_drafts",
        from_source_row_id: draft.id,
        to_node_kind: "internal_trid_key",
        to_source_table: "financial_reference_resolver",
        to_source_row_id: srcRowId,
        reference_kind: "internal_trid_key",
        reference_value: trid,
        confidence_score: conf,
        ambiguity_group_key: ambKey,
        ambiguity_rank: ambKey ? frrRank : null,
        edge_reason: "TRID candidate from FRR order_id join (preview only — not persisted)",
        source_table: "financial_reference_resolver",
        source_citations: [{ kind: "live_query", table: "financial_reference_resolver", row_id: srcRowId }],
      });
    }

    let finRank = 0;
    const finAmb = financeEvents.length > 1 ? `fin:${orderId}` : null;
    for (const ev of financeEvents.slice(0, 12)) {
      finRank += 1;
      const eid = nv(ev.id);
      if (!eid) continue;
      edges.push({
        edge_id: previewEdgeId(draft.id, ["finances_archive", eid]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "claim_to_settlement",
        from_node_kind: "claim_draft",
        from_source_table: "claim_candidate_drafts",
        from_source_row_id: draft.id,
        to_node_kind: "finances_archive_event",
        to_source_table: "amazon_finances_events",
        to_source_row_id: eid,
        reference_kind: "event_type",
        reference_value: nv(ev.event_type),
        confidence_score: 0.72,
        ambiguity_group_key: finAmb,
        ambiguity_rank: finAmb ? finRank : null,
        edge_reason: "amazon_finances_events matched order_id (citation layer)",
        source_table: "amazon_finances_events",
        source_citations: [{ kind: "live_query", table: "amazon_finances_events", row_id: eid }],
      });
    }
  }

  const skuNorm = normSku(skuHint);
  for (const ri of returnItems) {
    const riSku = normSku(nv(ri.sku));
    if (skuNorm && riSku && riSku !== skuNorm) continue;
    const riId = nv(ri.id);
    if (!riId) continue;
    edges.push({
      edge_id: previewEdgeId(draft.id, ["return_item", riId]),
      draft_id: draft.id,
      organization_id: orgId,
      edge_type: "operational_to_slip_line",
      from_node_kind: "claim_draft",
      from_source_table: "claim_candidate_drafts",
      from_source_row_id: draft.id,
      to_node_kind: "return_item",
      to_source_table: "return_items",
      to_source_row_id: riId,
      reference_kind: "identifier_resolution_status",
      reference_value: nv(ri.identifier_resolution_status),
      confidence_score: numConf(ri.identifier_resolution_confidence, 0.65),
      ambiguity_group_key: null,
      ambiguity_rank: null,
      edge_reason: "return_items matched by order_id" + (skuNorm ? " and sku" : ""),
      source_table: "return_items",
      source_citations: [{ kind: "live_query", table: "return_items", row_id: riId }],
    });
    const pkgId = nv(ri.package_id);
    if (!pkgId) continue;
    const slips = slipsByPkg.get(pkgId) ?? [];
    let slipRank = 0;
    for (const slip of slips) {
      slipRank += 1;
      const slipId = nv(slip.id);
      if (!slipId) continue;
      edges.push({
        edge_id: previewEdgeId(draft.id, ["slip", slipId]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "slip_line_to_product",
        from_node_kind: "slip_line",
        from_source_table: "slip_contents",
        from_source_row_id: slipId,
        to_node_kind: "product",
        to_source_table: "products",
        to_source_row_id: nv(slip.resolved_product_id) ?? "unresolved",
        reference_kind: "identifier_resolution_status",
        reference_value: nv(slip.identifier_resolution_status),
        confidence_score: numConf(slip.identifier_resolution_confidence, nv(slip.resolved_product_id) ? 0.88 : 0.4),
        ambiguity_group_key: slips.length > 1 ? `slip:${pkgId}` : null,
        ambiguity_rank: slips.length > 1 ? slipRank : null,
        edge_reason: "slip_contents.package_id from return_items.package_id",
        source_table: "slip_contents",
        source_citations: [
          { kind: "live_query", table: "return_items", row_id: riId },
          { kind: "live_query", table: "slip_contents", row_id: slipId },
        ],
      });
    }
  }

  return edges;
}

export function groupPreviewEdges(edges: ClaimEvidencePreviewEdge[]): ClaimEvidencePreviewGroup[] {
  const bySource = new Map<string, ClaimEvidencePreviewEdge[]>();
  for (const e of edges) {
    const key = e.source_table;
    const arr = bySource.get(key) ?? [];
    arr.push(e);
    bySource.set(key, arr);
  }
  return [...bySource.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([source_table, items]) => ({
      group_key: source_table,
      label: SOURCE_TABLE_LABELS[source_table] ?? source_table,
      source_table,
      edge_count: items.length,
      items: items.sort((x, y) => y.confidence_score - x.confidence_score),
    }));
}

export function extractTridCandidates(edges: ClaimEvidencePreviewEdge[]): ClaimEvidencePreview["trid_candidates"] {
  const seen = new Set<string>();
  const out: ClaimEvidencePreview["trid_candidates"] = [];
  for (const e of edges) {
    if (e.edge_type !== "claim_to_trid" || !e.reference_value) continue;
    const k = `${e.reference_value}:${e.to_source_row_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      trid_key: e.reference_value,
      source_table: e.to_source_table,
      source_row_id: e.to_source_row_id,
      confidence_score: e.confidence_score,
      ambiguity_group_key: e.ambiguity_group_key,
      ambiguity_rank: e.ambiguity_rank,
    });
  }
  return out.sort((a, b) => b.confidence_score - a.confidence_score);
}

export function resolveEvidenceDisplayMode(
  persistedEdgeCount: number,
  previewEdgeCount: number,
): ClaimEvidenceDisplayMode {
  if (persistedEdgeCount > 0 && previewEdgeCount > 0) return "persisted_with_live_preview";
  if (persistedEdgeCount > 0) return "persisted";
  return "preview_only";
}

export async function loadPersistedEvidenceSummary(
  client: SupabaseClient,
  organizationId: string,
  draftId: string,
): Promise<ClaimPersistedEvidenceSummary> {
  const empty: ClaimPersistedEvidenceSummary = {
    persisted_edge_count: 0,
    lineage_event_count: 0,
    generation_count: 0,
    latest_generation_id: null,
    latest_generation_number: null,
    latest_idempotency_key: null,
    latest_status: null,
    evidence_hash: null,
  };

  const graphConfigured = await probeGraphTables(client);
  if (!graphConfigured) return empty;

  const { count: edgeCount } = await client
    .from("claim_reference_edges")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("draft_id", draftId);

  const { count: genCount } = await client
    .from("claim_enrichment_generations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("draft_id", draftId);

  const { data: latestGen } = await client
    .from("claim_enrichment_generations")
    .select("id, generation_number, idempotency_key, status, evidence_hash")
    .eq("organization_id", organizationId)
    .eq("draft_id", draftId)
    .order("generation_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const generationId = latestGen?.id ? String(latestGen.id) : null;
  let lineageCount = 0;
  if (generationId) {
    const { count } = await client
      .from("claim_evidence_lineage_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("generation_id", generationId);
    lineageCount = count ?? 0;
  }

  return {
    persisted_edge_count: edgeCount ?? 0,
    lineage_event_count: lineageCount,
    generation_count: genCount ?? 0,
    latest_generation_id: generationId,
    latest_generation_number:
      typeof latestGen?.generation_number === "number" ? latestGen.generation_number : null,
    latest_idempotency_key:
      latestGen?.idempotency_key != null ? String(latestGen.idempotency_key) : null,
    latest_status: latestGen?.status != null ? String(latestGen.status) : null,
    evidence_hash: latestGen?.evidence_hash != null ? String(latestGen.evidence_hash) : null,
  };
}

function mapPersistedRowToPreviewEdge(
  draft: ClaimEvidenceDraftRow,
  row: Record<string, unknown>,
): ClaimEvidencePreviewEdge {
  const id = nv(row.id) ?? crypto.randomUUID();
  const toTable = nv(row.to_source_table) ?? "unknown";
  const confRaw = row.confidence_score;
  const confidence_score =
    typeof confRaw === "number" && Number.isFinite(confRaw) ? confRaw : Number(confRaw) || 0;
  return {
    edge_id: `persisted:${id}`,
    draft_id: draft.id,
    organization_id: draft.organization_id,
    edge_type: String(row.edge_type ?? "unknown"),
    from_node_kind: String(row.from_node_kind ?? ""),
    from_source_table: nv(row.from_source_table) ?? draft.source_table,
    from_source_row_id: nv(row.from_source_row_id) ?? draft.source_row_id,
    to_node_kind: String(row.to_node_kind ?? ""),
    to_source_table: toTable,
    to_source_row_id: nv(row.to_source_row_id) ?? "",
    reference_kind: nv(row.reference_kind),
    reference_value: nv(row.reference_value),
    confidence_score,
    ambiguity_group_key: nv(row.ambiguity_group_key),
    ambiguity_rank: typeof row.ambiguity_rank === "number" ? row.ambiguity_rank : null,
    edge_reason: nv(row.edge_reason) ?? "Persisted in claim_reference_edges",
    source_table: toTable,
    source_citations: Array.isArray(row.source_citations)
      ? (row.source_citations as { kind: string; table: string; row_id?: string }[])
      : [],
  };
}

/** Read-only list from claim_reference_edges (latest generation when scoped). */
export async function loadPersistedReferenceEdges(
  client: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
  opts?: { generationId?: string | null; limit?: number },
): Promise<ClaimPersistedEdgesPayload> {
  const empty: ClaimPersistedEdgesPayload = {
    generation_id: opts?.generationId ?? null,
    edge_count_total: 0,
    edge_count_returned: 0,
    truncated: false,
    groups: [],
    edges: [],
  };

  if (!(await probeGraphTables(client))) return empty;

  let generationId = opts?.generationId ?? null;
  if (!generationId) {
    const summary = await loadPersistedEvidenceSummary(client, draft.organization_id, draft.id);
    generationId = summary.latest_generation_id;
  }
  empty.generation_id = generationId;

  const limit = opts?.limit ?? MAX_PERSISTED_EDGES_LIST;

  let countQ = client
    .from("claim_reference_edges")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", draft.organization_id)
    .eq("draft_id", draft.id);
  if (generationId) countQ = countQ.eq("generation_id", generationId);
  const { count: totalCount, error: countErr } = await countQ;
  if (countErr) return empty;

  let q = client
    .from("claim_reference_edges")
    .select(
      "id, edge_type, from_node_kind, from_source_table, from_source_row_id, to_node_kind, to_source_table, to_source_row_id, reference_kind, reference_value, confidence_score, ambiguity_group_key, ambiguity_rank, edge_reason, source_citations",
    )
    .eq("organization_id", draft.organization_id)
    .eq("draft_id", draft.id)
    .order("edge_type", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (generationId) q = q.eq("generation_id", generationId);

  const { data, error } = await q;
  if (error) return empty;

  const rows = (data ?? []) as Record<string, unknown>[];
  const total = totalCount ?? rows.length;
  const truncated = total > limit;
  const slice = rows;
  const edges = slice.map((r) => mapPersistedRowToPreviewEdge(draft, r));

  return {
    generation_id: generationId,
    edge_count_total: total,
    edge_count_returned: edges.length,
    truncated,
    groups: groupPreviewEdges(edges),
    edges,
  };
}

/** Find legacy inbox candidate for a V2 draft (read-only). */
export async function resolveCandidateForDraft(
  client: SupabaseClient,
  organizationId: string,
  draft: Pick<ClaimEvidenceDraftRow, "source_table" | "source_row_id" | "sku" | "store_id">,
): Promise<{ id: string } | null> {
  const st = nv(draft.source_table);
  const sid = nv(draft.source_row_id);
  if (!st || !sid) return null;

  const { data, error } = await client
    .from("claim_candidates")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_table", st)
    .eq("source_row_id", sid)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const id = nv((data as { id?: unknown }).id);
  return id ? { id } : null;
}

export function buildPreviewWarnings(
  draft: ClaimEvidenceDraftRow,
  edges: ClaimEvidencePreviewEdge[],
  opts?: {
    lineage_warning_code?: string | null;
    inbox_queue?: string | null;
    persisted_edge_count?: number;
  },
): ClaimEvidenceWarning[] {
  const warnings: ClaimEvidenceWarning[] = [];
  if (edges.length === 0) {
    warnings.push({
      code: "no_evidence_edges",
      message: "No evidence edges resolved from live sources for this draft.",
      severity: "warn",
    });
  }
  const hasRemoval = edges.some((e) => e.edge_type === "claim_to_removal");
  if (draft.source_table === "amazon_removals" && !hasRemoval) {
    warnings.push({
      code: "removal_anchor_missing",
      message: "Operational removal row not found for draft source_row_id.",
      severity: "error",
    });
  }
  const trids = edges.filter((e) => e.edge_type === "claim_to_trid");
  const ambGroups = new Set(trids.map((e) => e.ambiguity_group_key).filter(Boolean));
  if (ambGroups.size > 0) {
    warnings.push({
      code: "ambiguous_trid",
      message: `${trids.length} TRID candidate(s) in ${ambGroups.size} ambiguity group(s) — selection not persisted.`,
      severity: "info",
    });
  }
  const hasFrr = edges.some((e) => e.source_table === "financial_reference_resolver");
  const hasFin = edges.some((e) => e.source_table === "amazon_finances_events");
  if (!hasFrr) {
    warnings.push({
      code: "frr_missing",
      message: "No financial_reference_resolver edges for this draft (order_id or table absent).",
      severity: "warn",
    });
  }
  if (!hasFin) {
    warnings.push({
      code: "finances_archive_missing",
      message: "No amazon_finances_events citations for this draft.",
      severity: "info",
    });
  }
  const hasReturn = edges.some((e) => e.source_table === "return_items");
  if (!hasReturn && draft.source_table === "amazon_removals") {
    warnings.push({
      code: "return_path_missing",
      message: "No return_items / slip_contents path resolved for order.",
      severity: "info",
    });
  }
  if (opts?.inbox_queue === "evidence_missing" || opts?.lineage_warning_code) {
    warnings.push({
      code: "inbox_evidence_missing",
      message: opts.lineage_warning_code
        ? `Inbox lineage: ${opts.lineage_warning_code}`
        : "Inbox queue: evidence_missing",
      severity: "warn",
    });
  }
  const persisted = opts?.persisted_edge_count ?? 0;
  if (persisted > 0) {
    warnings.push({
      code: "persisted_edges_available",
      message: `${persisted} edge(s) stored in claim_reference_edges — live preview below is for comparison only.`,
      severity: "info",
    });
  } else {
    warnings.push({
      code: "preview_only",
      message: "Live-query preview only — edges are NOT stored in claim_reference_edges.",
      severity: "info",
    });
  }
  return warnings;
}

async function probeGraphTables(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from("claim_reference_edges").select("id").limit(1);
  if (!error) return true;
  const msg = error.message ?? "";
  return !(msg.includes("Could not find") || msg.includes("does not exist") || error.code === "42P01");
}

export async function resolveDraftForCandidate(
  client: SupabaseClient,
  organizationId: string,
  candidate: {
    id: string;
    source_table?: string | null;
    source_row_id?: string | null;
    sku?: string | null;
    store_id?: string | null;
  },
): Promise<ClaimEvidenceDraftRow | null> {
  const st = nv(candidate.source_table);
  const sid = nv(candidate.source_row_id);
  if (st && sid) {
    const { data, error } = await client
      .from("claim_candidate_drafts")
      .select("id, organization_id, store_id, source_table, source_row_id, sku")
      .eq("organization_id", organizationId)
      .eq("source_table", st)
      .eq("source_row_id", sid)
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      const r = data as Record<string, unknown>;
      const id = nv(r.id);
      if (id) {
        return {
          id,
          organization_id: organizationId,
          store_id: nv(r.store_id),
          source_table: st,
          source_row_id: sid,
          sku: nv(r.sku) ?? nv(candidate.sku),
        };
      }
    }
  }
  if (!st || !sid) return null;
  return {
    id: candidate.id,
    organization_id: organizationId,
    store_id: nv(candidate.store_id),
    source_table: st,
    source_row_id: sid,
    sku: nv(candidate.sku),
  };
}

export async function fetchDraftRow(
  client: SupabaseClient,
  organizationId: string,
  draftId: string,
): Promise<ClaimEvidenceDraftRow | null> {
  const { data, error } = await client
    .from("claim_candidate_drafts")
    .select("id, organization_id, store_id, source_table, source_row_id, sku")
    .eq("organization_id", organizationId)
    .eq("id", draftId)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  const id = nv(r.id);
  const st = nv(r.source_table);
  const sid = nv(r.source_row_id);
  if (!id || !st || !sid) return null;
  return {
    id,
    organization_id: organizationId,
    store_id: nv(r.store_id),
    source_table: st,
    source_row_id: sid,
    sku: nv(r.sku),
  };
}

export async function buildClaimEvidencePreview(
  client: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
  opts?: {
    claim_candidate_id?: string | null;
    lineage_warning_code?: string | null;
    inbox_queue?: string | null;
    edgeLimit?: number;
    includePersistedEdgeList?: boolean;
  },
): Promise<ClaimEvidencePreview> {
  const orgId = draft.organization_id;
  let removal: RemovalRow | null = null;
  let expected: { count: number; sample_id: string | null } | undefined;
  let allocations: Record<string, unknown>[] = [];

  if (draft.source_table === "amazon_removals") {
    removal = await fetchRemoval(client, orgId, draft.source_row_id);
    if (removal) {
      expected = await fetchExpected(client, orgId, removal.id);
      allocations = await fetchAllocations(client, orgId, removal.id);
    }
  }

  const orderId = removal?.order_id ?? null;
  const frrRows = orderId ? await fetchFrrByOrderId(client, orgId, orderId) : [];
  const financeEvents = orderId ? await fetchFinancesEvents(client, orgId, orderId) : [];
  const returnItems = orderId
    ? await fetchReturnItemsByOrder(client, orgId, orderId, draft.sku ?? removal?.sku ?? null)
    : [];
  const packageIds = [...new Set(returnItems.map((r) => nv(r.package_id)).filter(Boolean) as string[])];
  const slipsByPkg = packageIds.length
    ? await fetchSlipsByPackageIds(client, orgId, packageIds)
    : new Map<string, Record<string, unknown>[]>();

  const allEdges = buildPreviewEdgesForDraft(
    draft,
    removal,
    expected,
    allocations,
    frrRows,
    financeEvents,
    returnItems,
    slipsByPkg,
  );

  const limit = opts?.edgeLimit ?? MAX_PREVIEW_EDGES;
  const truncated = allEdges.length > limit;
  const edges = allEdges.slice(0, limit);
  const graphConfigured = await probeGraphTables(client);
  const persistedSummary = graphConfigured
    ? await loadPersistedEvidenceSummary(client, orgId, draft.id)
    : {
        persisted_edge_count: 0,
        lineage_event_count: 0,
        generation_count: 0,
        latest_generation_id: null,
        latest_generation_number: null,
        latest_idempotency_key: null,
        latest_status: null,
        evidence_hash: null,
      };

  const displayMode = resolveEvidenceDisplayMode(
    persistedSummary.persisted_edge_count,
    edges.length,
  );

  let claimCandidateId = opts?.claim_candidate_id ?? null;
  if (!claimCandidateId) {
    const linked = await resolveCandidateForDraft(client, orgId, draft);
    claimCandidateId = linked?.id ?? null;
  }

  return {
    mode: "live_query_preview",
    persisted_edges: persistedSummary.persisted_edge_count > 0,
    evidence_display_mode: displayMode,
    draft_id: draft.id,
    claim_candidate_id: claimCandidateId,
    organization_id: orgId,
    source_table: draft.source_table,
    source_row_id: draft.source_row_id,
    edge_count_total: allEdges.length,
    edge_count_returned: edges.length,
    truncated,
    groups: groupPreviewEdges(edges),
    edges,
    trid_candidates: extractTridCandidates(allEdges),
    warnings: buildPreviewWarnings(draft, allEdges, {
      lineage_warning_code: opts?.lineage_warning_code,
      inbox_queue: opts?.inbox_queue,
      persisted_edge_count: persistedSummary.persisted_edge_count,
    }),
    enrichment: {
      graph_tables_configured: graphConfigured,
      ...persistedSummary,
    },
  };
}

export type ClaimEvidenceGraphResponse = {
  graph_preview: ClaimEvidencePreview;
  persisted_edges?: ClaimPersistedEdgesPayload;
  claim_candidate_id?: string | null;
  draft_id: string;
  inbox_deep_link?: string | null;
};

export async function buildClaimEvidenceGraphResponse(
  client: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
  opts?: Parameters<typeof buildClaimEvidencePreview>[2],
): Promise<ClaimEvidenceGraphResponse> {
  const includeList = opts?.includePersistedEdgeList !== false;
  const graph = await buildClaimEvidencePreview(client, draft, opts);
  const persisted_edges =
    includeList && graph.enrichment.persisted_edge_count > 0
      ? await loadPersistedReferenceEdges(client, draft, {
          generationId: graph.enrichment.latest_generation_id,
        })
      : undefined;

  const candidateId = graph.claim_candidate_id;
  const inbox_deep_link = candidateId
    ? `/claim-engine/inbox?candidate_id=${encodeURIComponent(candidateId)}`
    : null;

  return {
    graph_preview: graph,
    persisted_edges,
    claim_candidate_id: candidateId,
    draft_id: draft.id,
    inbox_deep_link,
  };
}
