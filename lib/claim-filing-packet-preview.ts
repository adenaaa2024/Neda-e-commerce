/**
 * CLAIM-EVIDENCE-09 — Read-only filing packet preview (no claim submission).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { listEdgeReviewAuditEvents } from "./claim-evidence-edge-review";
import {
  filterActionableWarnings,
  type ClaimEvidenceDraftOperatorState,
  type FilingReadinessGate,
} from "./claim-evidence-filing-readiness";
import {
  buildClaimEvidenceGraphResponse,
  SOURCE_TABLE_LABELS,
  type ClaimEvidenceDraftRow,
  type ClaimEvidencePreviewEdge,
  type ClaimEvidencePreviewGroup,
  type ClaimEvidenceWarning,
} from "./claim-evidence-preview";

export const CLAIM_FILING_PACKET_PREVIEW_SCHEMA_VERSION = "claim-filing-packet-preview-v1" as const;

export type ClaimFilingPacketEvidenceGroup = {
  group_key: string;
  label: string;
  source_table: string;
  edge_count: number;
  review: { accepted: number; rejected: number; needs_review: number };
  edges: Array<{
    reference_edge_id: string | null;
    edge_type: string;
    to_source_table: string;
    to_source_row_id: string;
    reference_kind: string | null;
    reference_value: string | null;
    operator_review_status: string | null;
    confidence_score: number;
  }>;
};

export type ClaimFilingPacketLineageLink = {
  id: string;
  event_type: string;
  producer: string;
  source_table: string | null;
  source_row_id: string | null;
  report_kind: string | null;
  generation_id: string;
  created_at: string;
};

export type ClaimFilingPacketTridReference = {
  trid_key: string;
  source_table: string;
  source_row_id: string;
  confidence_score: number;
  ambiguity_group_key: string | null;
  ambiguity_rank: number | null;
  linked_edge_ids: string[];
};

export type ClaimFilingPacketPreview = {
  schema_version: typeof CLAIM_FILING_PACKET_PREVIEW_SCHEMA_VERSION;
  generated_at: string;
  does_not_submit: true;
  draft_id: string;
  organization_id: string;
  claim_candidate_id: string | null;
  ready_for_preview: boolean;
  claim_summary: {
    source_table: string;
    source_row_id: string;
    sku: string | null;
    store_id: string | null;
    generation_id: string | null;
    generation_number: number | null;
    generation_status: string | null;
    evidence_hash: string | null;
    persisted_edge_count: number;
    lineage_event_count: number;
    preview_edge_count: number;
  };
  evidence_groups: ClaimFilingPacketEvidenceGroup[];
  lineage_links: ClaimFilingPacketLineageLink[];
  trid_references: ClaimFilingPacketTridReference[];
  unresolved_warnings: ClaimEvidenceWarning[];
  filing_readiness: FilingReadinessGate;
  operator_state: ClaimEvidenceDraftOperatorState | null;
  audit_tail: {
    recent_edge_review_event_ids: string[];
    recent_bulk_review_event_ids: string[];
    preview_event_id: string | null;
  };
};

function summarizeGroupReview(items: ClaimEvidencePreviewEdge[]): {
  accepted: number;
  rejected: number;
  needs_review: number;
} {
  let accepted = 0;
  let rejected = 0;
  let needs_review = 0;
  for (const e of items) {
    const s = e.operator_review_status ?? "needs_review";
    if (s === "accepted") accepted++;
    else if (s === "rejected") rejected++;
    else needs_review++;
  }
  return { accepted, rejected, needs_review };
}

function mapGroup(g: ClaimEvidencePreviewGroup): ClaimFilingPacketEvidenceGroup {
  return {
    group_key: g.group_key,
    label: g.label,
    source_table: g.source_table,
    edge_count: g.edge_count,
    review: summarizeGroupReview(g.items),
    edges: g.items.map((e) => ({
      reference_edge_id: e.reference_edge_id ?? null,
      edge_type: e.edge_type,
      to_source_table: e.to_source_table,
      to_source_row_id: e.to_source_row_id,
      reference_kind: e.reference_kind,
      reference_value: e.reference_value,
      operator_review_status: e.operator_review_status ?? null,
      confidence_score: e.confidence_score,
    })),
  };
}

function buildTridFromGraph(
  tridCandidates: {
    trid_key: string;
    source_table: string;
    source_row_id: string;
    confidence_score: number;
    ambiguity_group_key: string | null;
    ambiguity_rank: number | null;
  }[],
  persistedEdges: ClaimEvidencePreviewEdge[],
): ClaimFilingPacketTridReference[] {
  const edgeByRef = new Map<string, string[]>();
  for (const e of persistedEdges) {
    if (e.edge_type !== "claim_to_trid" && e.reference_kind !== "trid") continue;
    const key = e.reference_value ?? e.to_source_row_id;
    if (!key) continue;
    const ids = edgeByRef.get(key) ?? [];
    if (e.reference_edge_id) ids.push(e.reference_edge_id);
    edgeByRef.set(key, ids);
  }

  return tridCandidates.map((t) => ({
    trid_key: t.trid_key,
    source_table: t.source_table,
    source_row_id: t.source_row_id,
    confidence_score: t.confidence_score,
    ambiguity_group_key: t.ambiguity_group_key,
    ambiguity_rank: t.ambiguity_rank,
    linked_edge_ids: edgeByRef.get(t.trid_key) ?? edgeByRef.get(t.source_row_id) ?? [],
  }));
}

export async function probePacketPreviewAuditSchema(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from("claim_filing_packet_preview_events").select("id").limit(1);
  if (!error) return true;
  const msg = error.message ?? "";
  return !(msg.includes("Could not find") || msg.includes("does not exist") || error.code === "42P01");
}

export async function loadLineageLinks(
  client: SupabaseClient,
  organizationId: string,
  draftId: string,
  generationId: string | null,
  limit = 40,
): Promise<ClaimFilingPacketLineageLink[]> {
  let q = client
    .from("claim_evidence_lineage_events")
    .select("id, event_type, producer, source_table, source_row_id, report_kind, generation_id, created_at")
    .eq("organization_id", organizationId)
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (generationId) q = q.eq("generation_id", generationId);

  const { data, error } = await q;
  if (error) return [];

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      event_type: String(r.event_type ?? ""),
      producer: String(r.producer ?? ""),
      source_table: r.source_table != null ? String(r.source_table) : null,
      source_row_id: r.source_row_id != null ? String(r.source_row_id) : null,
      report_kind: r.report_kind != null ? String(r.report_kind) : null,
      generation_id: String(r.generation_id ?? ""),
      created_at: String(r.created_at ?? ""),
    };
  });
}

export async function logPacketPreviewView(
  client: SupabaseClient,
  input: {
    organizationId: string;
    draftId: string;
    generationId: string | null;
    viewedBy: string | null;
    readyForPreview: boolean;
  },
): Promise<string | null> {
  if (!(await probePacketPreviewAuditSchema(client))) return null;

  const { data, error } = await client
    .from("claim_filing_packet_preview_events")
    .insert({
      organization_id: input.organizationId,
      draft_id: input.draftId,
      generation_id: input.generationId,
      viewed_by: input.viewedBy,
      ready_for_preview: input.readyForPreview,
    })
    .select("id")
    .single();

  if (error) return null;
  return String((data as { id: string }).id);
}

export async function buildClaimFilingPacketPreview(
  client: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
  opts?: { logView?: { viewedBy: string | null } },
): Promise<ClaimFilingPacketPreview> {
  const graphBody = await buildClaimEvidenceGraphResponse(client, draft, {
    includePersistedEdgeList: true,
  });
  const graph = graphBody.graph_preview;
  const persisted = graphBody.persisted_edges;
  const filingReadiness = graphBody.filing_readiness!;
  const generationId = graph.enrichment.latest_generation_id;

  const persistedGroups = persisted?.groups ?? [];
  const persistedEdges = persisted?.edges ?? [];

  const lineage_links = await loadLineageLinks(
    client,
    draft.organization_id,
    draft.id,
    generationId,
  );

  const trid_references = buildTridFromGraph(graph.trid_candidates, persistedEdges);
  const unresolved_warnings = filterActionableWarnings(graph.warnings);

  const edgeAudit = await listEdgeReviewAuditEvents(client, draft.organization_id, draft.id, 10);
  let bulkAuditIds: string[] = [];
  const bulkProbe = await client
    .from("claim_reference_edge_bulk_review_events")
    .select("id")
    .eq("organization_id", draft.organization_id)
    .eq("draft_id", draft.id)
    .order("created_at", { ascending: false })
    .limit(5);
  if (!bulkProbe.error) {
    bulkAuditIds = (bulkProbe.data ?? []).map((r) => String((r as { id: string }).id));
  }

  let preview_event_id: string | null = null;
  if (opts?.logView) {
    preview_event_id = await logPacketPreviewView(client, {
      organizationId: draft.organization_id,
      draftId: draft.id,
      generationId,
      viewedBy: opts.logView.viewedBy,
      readyForPreview: filingReadiness.ready,
    });
  }

  return {
    schema_version: CLAIM_FILING_PACKET_PREVIEW_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    does_not_submit: true,
    draft_id: draft.id,
    organization_id: draft.organization_id,
    claim_candidate_id: graphBody.claim_candidate_id ?? null,
    ready_for_preview: filingReadiness.ready,
    claim_summary: {
      source_table: draft.source_table,
      source_row_id: draft.source_row_id,
      sku: draft.sku,
      store_id: draft.store_id,
      generation_id: generationId,
      generation_number: graph.enrichment.latest_generation_number,
      generation_status: graph.enrichment.latest_status,
      evidence_hash: graph.enrichment.evidence_hash,
      persisted_edge_count: graph.enrichment.persisted_edge_count,
      lineage_event_count: graph.enrichment.lineage_event_count,
      preview_edge_count: graph.edge_count_returned,
    },
    evidence_groups: persistedGroups.map(mapGroup),
    lineage_links,
    trid_references,
    unresolved_warnings,
    filing_readiness: filingReadiness,
    operator_state: graphBody.operator_state ?? null,
    audit_tail: {
      recent_edge_review_event_ids: edgeAudit.map((e) => String(e.id)),
      recent_bulk_review_event_ids: bulkAuditIds,
      preview_event_id,
    },
  };
}

/** Human label for claim source table in packet summary. */
export function packetSourceLabel(sourceTable: string): string {
  return SOURCE_TABLE_LABELS[sourceTable] ?? sourceTable;
}
