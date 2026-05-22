/**
 * CLAIM-EVIDENCE-07 — Operator accept/reject/needs_review for persisted edges.
 * Updates claim_reference_edges review columns + append-only audit events only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const CLAIM_EVIDENCE_EDGE_REVIEW_STATUSES = [
  "accepted",
  "rejected",
  "needs_review",
] as const;

export type ClaimEvidenceEdgeReviewStatus = (typeof CLAIM_EVIDENCE_EDGE_REVIEW_STATUSES)[number];

export type ClaimEvidenceEdgeReviewSummary = {
  accepted: number;
  rejected: number;
  needs_review: number;
  total: number;
};

export type ApplyEdgeOperatorReviewInput = {
  organizationId: string;
  draftId: string;
  edgeId: string;
  status: ClaimEvidenceEdgeReviewStatus;
  note?: string | null;
  reviewedBy: string;
};

export type ApplyEdgeOperatorReviewResult = {
  edge_id: string;
  draft_id: string;
  previous_status: ClaimEvidenceEdgeReviewStatus | null;
  new_status: ClaimEvidenceEdgeReviewStatus;
  audit_event_id: string;
};

const NOTE_MAX_LEN = 500;

export function parseEdgeReviewStatus(v: unknown): ClaimEvidenceEdgeReviewStatus | null {
  const s = String(v ?? "").trim();
  return (CLAIM_EVIDENCE_EDGE_REVIEW_STATUSES as readonly string[]).includes(s)
    ? (s as ClaimEvidenceEdgeReviewStatus)
    : null;
}

export function normalizeReviewNote(note: unknown): string | null {
  if (note == null) return null;
  const t = String(note).trim();
  if (!t) return null;
  return t.length > NOTE_MAX_LEN ? t.slice(0, NOTE_MAX_LEN) : t;
}

export async function probeEdgeReviewSchema(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from("claim_reference_edges").select("operator_review_status").limit(1);
  if (!error) return true;
  const msg = error.message ?? "";
  return !(msg.includes("Could not find") || msg.includes("does not exist") || error.code === "42703");
}

export async function loadEdgeReviewSummary(
  client: SupabaseClient,
  organizationId: string,
  draftId: string,
  generationId?: string | null,
): Promise<ClaimEvidenceEdgeReviewSummary> {
  const empty: ClaimEvidenceEdgeReviewSummary = {
    accepted: 0,
    rejected: 0,
    needs_review: 0,
    total: 0,
  };
  if (!(await probeEdgeReviewSchema(client))) return empty;

  const statuses: ClaimEvidenceEdgeReviewStatus[] = ["accepted", "rejected", "needs_review"];
  const counts = { accepted: 0, rejected: 0, needs_review: 0 };

  for (const status of statuses) {
    let q = client
      .from("claim_reference_edges")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("draft_id", draftId)
      .eq("operator_review_status", status);
    if (generationId) q = q.eq("generation_id", generationId);
    const { count } = await q;
    counts[status] = count ?? 0;
  }

  const total = counts.accepted + counts.rejected + counts.needs_review;
  return { ...counts, total };
}

export type BulkEdgeReviewScope = "all" | "group";

export type ApplyBulkEdgeOperatorReviewInput = {
  organizationId: string;
  draftId: string;
  status: ClaimEvidenceEdgeReviewStatus;
  reviewedBy: string;
  scope: BulkEdgeReviewScope;
  /** When scope=group, matches persisted group_key (source_table). */
  groupKey?: string | null;
  generationId?: string | null;
  note?: string | null;
};

export type ApplyBulkEdgeOperatorReviewResult = {
  scope: BulkEdgeReviewScope;
  group_key: string | null;
  target_status: ClaimEvidenceEdgeReviewStatus;
  edges_updated: number;
  bulk_audit_event_id: string;
  edge_audit_event_ids: string[];
};

async function insertEdgeReviewAuditEvent(
  client: SupabaseClient,
  row: {
    organizationId: string;
    edgeId: string;
    draftId: string;
    generationId: string | null;
    previousStatus: ClaimEvidenceEdgeReviewStatus | null;
    newStatus: ClaimEvidenceEdgeReviewStatus;
    note: string | null;
    reviewedBy: string;
  },
): Promise<string> {
  const { data: audit, error: auditErr } = await client
    .from("claim_reference_edge_review_events")
    .insert({
      organization_id: row.organizationId,
      edge_id: row.edgeId,
      draft_id: row.draftId,
      generation_id: row.generationId,
      previous_status: row.previousStatus,
      new_status: row.newStatus,
      review_note: row.note,
      reviewed_by: row.reviewedBy,
    })
    .select("id")
    .single();

  if (auditErr) throw new Error(`claim_reference_edge_review_events insert: ${auditErr.message}`);
  return String((audit as { id: string }).id);
}

export async function applyBulkEdgeOperatorReview(
  client: SupabaseClient,
  input: ApplyBulkEdgeOperatorReviewInput,
): Promise<ApplyBulkEdgeOperatorReviewResult> {
  if (!(await probeEdgeReviewSchema(client))) {
    throw new Error(
      "Operator review columns missing — apply migration 20260821120000_claim_reference_edge_operator_review.sql",
    );
  }

  const status = parseEdgeReviewStatus(input.status);
  if (!status) {
    throw new Error(`Invalid review status. Use: ${CLAIM_EVIDENCE_EDGE_REVIEW_STATUSES.join(", ")}`);
  }

  if (input.scope === "group" && !String(input.groupKey ?? "").trim()) {
    throw new Error("group_key is required when scope is group.");
  }

  const note = normalizeReviewNote(input.note);
  const groupKey = input.scope === "group" ? String(input.groupKey).trim() : null;

  let q = client
    .from("claim_reference_edges")
    .select("id, generation_id, operator_review_status")
    .eq("organization_id", input.organizationId)
    .eq("draft_id", input.draftId);

  if (input.generationId) q = q.eq("generation_id", input.generationId);
  if (groupKey) q = q.eq("to_source_table", groupKey);

  const { data: rows, error: readErr } = await q;
  if (readErr) throw new Error(`claim_reference_edges bulk read: ${readErr.message}`);

  const edges = (rows ?? []) as Array<{
    id: string;
    generation_id?: string | null;
    operator_review_status?: string | null;
  }>;

  if (edges.length === 0) {
    throw new Error(groupKey ? `No persisted edges in group ${groupKey}.` : "No persisted edges for this draft.");
  }

  const generationId =
    input.generationId ?? (edges[0]?.generation_id != null ? String(edges[0].generation_id) : null);
  const now = new Date().toISOString();
  const ids = edges.map((e) => String(e.id));

  const { error: upErr } = await client
    .from("claim_reference_edges")
    .update({
      operator_review_status: status,
      operator_reviewed_at: now,
      operator_reviewed_by: input.reviewedBy,
      operator_review_note: note,
    })
    .eq("organization_id", input.organizationId)
    .in("id", ids);

  if (upErr) throw new Error(`claim_reference_edges bulk update: ${upErr.message}`);

  let bulkAuditId = "";
  const bulkProbe = await client.from("claim_reference_edge_bulk_review_events").select("id").limit(1);
  if (!bulkProbe.error) {
    const { data: bulkRow, error: bulkErr } = await client
      .from("claim_reference_edge_bulk_review_events")
      .insert({
        organization_id: input.organizationId,
        draft_id: input.draftId,
        generation_id: generationId,
        scope: input.scope,
        group_key: groupKey,
        target_status: status,
        edges_updated: ids.length,
        reviewed_by: input.reviewedBy,
        review_note: note,
      })
      .select("id")
      .single();
    if (bulkErr) throw new Error(`claim_reference_edge_bulk_review_events insert: ${bulkErr.message}`);
    bulkAuditId = String((bulkRow as { id: string }).id);
  }

  const edgeAuditIds: string[] = [];
  for (const edge of edges) {
    const previous = parseEdgeReviewStatus(edge.operator_review_status);
    const auditId = await insertEdgeReviewAuditEvent(client, {
      organizationId: input.organizationId,
      edgeId: String(edge.id),
      draftId: input.draftId,
      generationId,
      previousStatus: previous,
      newStatus: status,
      note,
      reviewedBy: input.reviewedBy,
    });
    edgeAuditIds.push(auditId);
  }

  return {
    scope: input.scope,
    group_key: groupKey,
    target_status: status,
    edges_updated: ids.length,
    bulk_audit_event_id: bulkAuditId,
    edge_audit_event_ids: edgeAuditIds,
  };
}

export async function applyEdgeOperatorReview(
  client: SupabaseClient,
  input: ApplyEdgeOperatorReviewInput,
): Promise<ApplyEdgeOperatorReviewResult> {
  if (!(await probeEdgeReviewSchema(client))) {
    throw new Error(
      "Operator review columns missing — apply migration 20260821120000_claim_reference_edge_operator_review.sql",
    );
  }

  const status = parseEdgeReviewStatus(input.status);
  if (!status) {
    throw new Error(`Invalid review status. Use: ${CLAIM_EVIDENCE_EDGE_REVIEW_STATUSES.join(", ")}`);
  }

  const note = normalizeReviewNote(input.note);

  const { data: edge, error: edgeErr } = await client
    .from("claim_reference_edges")
    .select("id, organization_id, draft_id, generation_id, operator_review_status")
    .eq("id", input.edgeId)
    .eq("organization_id", input.organizationId)
    .eq("draft_id", input.draftId)
    .maybeSingle();

  if (edgeErr) throw new Error(`claim_reference_edges read: ${edgeErr.message}`);
  if (!edge) throw new Error("Edge not found for this draft.");

  const previousRaw = (edge as { operator_review_status?: string }).operator_review_status;
  const previous = parseEdgeReviewStatus(previousRaw);

  const now = new Date().toISOString();
  const { error: upErr } = await client
    .from("claim_reference_edges")
    .update({
      operator_review_status: status,
      operator_reviewed_at: now,
      operator_reviewed_by: input.reviewedBy,
      operator_review_note: note,
    })
    .eq("id", input.edgeId)
    .eq("organization_id", input.organizationId);

  if (upErr) throw new Error(`claim_reference_edges update: ${upErr.message}`);

  const audit_event_id = await insertEdgeReviewAuditEvent(client, {
    organizationId: input.organizationId,
    edgeId: input.edgeId,
    draftId: input.draftId,
    generationId: (edge as { generation_id?: string }).generation_id ?? null,
    previousStatus: previous,
    newStatus: status,
    note,
    reviewedBy: input.reviewedBy,
  });

  return {
    edge_id: input.edgeId,
    draft_id: input.draftId,
    previous_status: previous,
    new_status: status,
    audit_event_id,
  };
}

export async function listEdgeReviewAuditEvents(
  client: SupabaseClient,
  organizationId: string,
  draftId: string,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client
    .from("claim_reference_edge_review_events")
    .select(
      "id, edge_id, previous_status, new_status, review_note, reviewed_by, created_at, generation_id",
    )
    .eq("organization_id", organizationId)
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as Record<string, unknown>[];
}
