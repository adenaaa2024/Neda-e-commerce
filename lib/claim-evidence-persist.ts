/**
 * NEXT-CLAIM-EVIDENCE-04 — Gated one-draft evidence graph writer.
 * Writes only: claim_enrichment_generations, claim_evidence_lineage_events, claim_reference_edges.
 */

import * as crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildClaimEvidencePreview,
  type ClaimEvidenceDraftRow,
  type ClaimEvidencePreviewEdge,
} from "./claim-evidence-preview";
import { enrichmentDiffSchemaAvailable } from "./claim-enrichment-diff";

export const EVIDENCE_04_RULES_VERSION = "cce.v1";
export const EVIDENCE_04_GENERATION_IDEMPOTENCY_PREFIX = "claim-evidence-04";
export const EVIDENCE_04_MAX_EDGES_PER_RUN = 500;

export type PersistEvidence04Input = {
  organizationId: string;
  draftId: string;
  claimCandidateId?: string | null;
  dryRun?: boolean;
  /** When true, skip approval check (unit tests only). */
  skipApproval?: boolean;
};

export type PersistEvidence04Result = {
  dry_run: boolean;
  organization_id: string;
  draft_id: string;
  claim_candidate_id: string | null;
  generation_id: string | null;
  generation_number: number | null;
  idempotency_key: string;
  preview_edge_count: number;
  lineage_inserted: number;
  lineage_skipped: number;
  edges_inserted: number;
  edges_skipped: number;
  evidence_hash: string;
};

export function generationIdempotencyKey(draftId: string): string {
  return `${EVIDENCE_04_GENERATION_IDEMPOTENCY_PREFIX}:${draftId}`;
}

export function edgeNaturalKey(parts: {
  edge_type: string;
  to_source_table: string;
  to_source_row_id: string;
  reference_kind: string | null;
  reference_value: string | null;
}): string {
  return [
    parts.edge_type,
    parts.to_source_table,
    parts.to_source_row_id,
    parts.reference_kind ?? "",
    parts.reference_value ?? "",
  ].join("\0");
}

export function edgeNaturalKeyFromPreview(edge: ClaimEvidencePreviewEdge): string {
  return edgeNaturalKey(edge);
}

export function lineagePayloadSha256(edge: ClaimEvidencePreviewEdge): string {
  const body = {
    edge_id: edge.edge_id,
    edge_type: edge.edge_type,
    to_source_table: edge.to_source_table,
    to_source_row_id: edge.to_source_row_id,
    reference_kind: edge.reference_kind,
    reference_value: edge.reference_value,
    source_table: edge.source_table,
  };
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function evidenceHashFromEdgeIds(edgeIds: string[]): string {
  const sorted = [...edgeIds].sort();
  return crypto.createHash("sha256").update(sorted.join("|")).digest("hex");
}

export function lineageEventTypeForEdge(edge: ClaimEvidencePreviewEdge): string {
  switch (edge.edge_type) {
    case "claim_to_trid":
      return "trid_candidate_seen";
    case "operational_to_financial":
      return "financial_reference_seen";
    case "claim_to_shipment":
      return "shipment_evidence_seen";
    case "claim_to_settlement":
      return "finances_archive_event_seen";
    case "claim_to_removal":
      return "initial_snapshot";
    default:
      return "source_import_seen";
  }
}

type GenerationRow = {
  id: string;
  generation_number: number;
};

async function getOrCreateGeneration(
  client: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
  idempotencyKey: string,
  evidenceHash: string,
  dryRun: boolean,
): Promise<GenerationRow> {
  const { data: existing, error: exErr } = await client
    .from("claim_enrichment_generations")
    .select("id, generation_number")
    .eq("organization_id", draft.organization_id)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (exErr) throw new Error(`claim_enrichment_generations lookup: ${exErr.message}`);
  if (existing?.id) {
    return {
      id: String(existing.id),
      generation_number: Number(existing.generation_number) || 1,
    };
  }

  const { data: maxGen } = await client
    .from("claim_enrichment_generations")
    .select("generation_number")
    .eq("draft_id", draft.id)
    .order("generation_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const generationNumber = (Number(maxGen?.generation_number) || 0) + 1;

  if (dryRun) {
    return { id: "00000000-0000-4000-8000-0000000000a1", generation_number: generationNumber };
  }

  const now = new Date().toISOString();
  const { data: inserted, error: insErr } = await client
    .from("claim_enrichment_generations")
    .insert({
      organization_id: draft.organization_id,
      store_id: draft.store_id,
      draft_id: draft.id,
      source_table: draft.source_table,
      source_row_id: draft.source_row_id,
      generation_number: generationNumber,
      idempotency_key: idempotencyKey,
      status: "computed",
      trigger_kind: "initial_snapshot",
      rules_version: EVIDENCE_04_RULES_VERSION,
      evidence_hash: evidenceHash,
      diff_summary: { writer: "claim-evidence-04", edge_source: "live_query_preview" },
      computed_at: now,
    })
    .select("id, generation_number")
    .single();
  if (insErr) {
    if (insErr.code === "23505") {
      const { data: race } = await client
        .from("claim_enrichment_generations")
        .select("id, generation_number")
        .eq("organization_id", draft.organization_id)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (race?.id) {
        return {
          id: String(race.id),
          generation_number: Number(race.generation_number) || generationNumber,
        };
      }
    }
    throw new Error(`claim_enrichment_generations insert: ${insErr.message}`);
  }
  return {
    id: String(inserted.id),
    generation_number: Number(inserted.generation_number) || generationNumber,
  };
}

async function loadExistingLineageHashes(
  client: SupabaseClient,
  organizationId: string,
  generationId: string,
): Promise<Map<string, string>> {
  const { data, error } = await client
    .from("claim_evidence_lineage_events")
    .select("id, payload_sha256")
    .eq("organization_id", organizationId)
    .eq("generation_id", generationId)
    .not("payload_sha256", "is", null);
  if (error) throw new Error(`claim_evidence_lineage_events load: ${error.message}`);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const hash = (row as { payload_sha256?: string }).payload_sha256;
    const id = (row as { id?: string }).id;
    if (hash && id) map.set(hash, id);
  }
  return map;
}

async function loadExistingEdgeKeys(
  client: SupabaseClient,
  organizationId: string,
  generationId: string,
): Promise<Set<string>> {
  const { data, error } = await client
    .from("claim_reference_edges")
    .select("edge_type, to_source_table, to_source_row_id, reference_kind, reference_value")
    .eq("organization_id", organizationId)
    .eq("generation_id", generationId);
  if (error) throw new Error(`claim_reference_edges load: ${error.message}`);
  const keys = new Set<string>();
  for (const row of data ?? []) {
    const r = row as unknown as Record<string, unknown>;
    keys.add(
      edgeNaturalKey({
        edge_type: String(r.edge_type ?? ""),
        to_source_table: String(r.to_source_table ?? ""),
        to_source_row_id: String(r.to_source_row_id ?? ""),
        reference_kind: r.reference_kind != null ? String(r.reference_kind) : null,
        reference_value: r.reference_value != null ? String(r.reference_value) : null,
      }),
    );
  }
  return keys;
}

/**
 * Persist preview edges for a single draft (idempotent). Does not touch filing, FRR, or products.
 */
export async function persistClaimEvidence04ForDraft(
  client: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
  input: PersistEvidence04Input,
): Promise<PersistEvidence04Result> {
  if (draft.id !== input.draftId || draft.organization_id !== input.organizationId) {
    throw new Error("draft scope mismatch — one draft per run only.");
  }

  const schemaOk = await enrichmentDiffSchemaAvailable(client);
  if (!schemaOk) {
    throw new Error("CCE graph tables missing — apply claim_enrichment_continuous_graph migration first.");
  }

  const preview = await buildClaimEvidencePreview(client, draft, {
    claim_candidate_id: input.claimCandidateId ?? null,
    edgeLimit: EVIDENCE_04_MAX_EDGES_PER_RUN,
  });

  if (preview.truncated) {
    throw new Error(
      `Preview truncated at ${EVIDENCE_04_MAX_EDGES_PER_RUN} edges (${preview.edge_count_total} total) — narrow scope or raise cap.`,
    );
  }

  const edges = preview.edges;
  if (edges.length === 0) {
    throw new Error("No preview edges to persist for this draft.");
  }

  const idempotencyKey = generationIdempotencyKey(draft.id);
  const evidenceHash = evidenceHashFromEdgeIds(edges.map((e) => e.edge_id));
  const dryRun = input.dryRun === true;

  const generation = await getOrCreateGeneration(client, draft, idempotencyKey, evidenceHash, dryRun);

  let lineageInserted = 0;
  let lineageSkipped = 0;
  let edgesInserted = 0;
  let edgesSkipped = 0;

  const lineageByHash = dryRun
    ? new Map<string, string>()
    : await loadExistingLineageHashes(client, draft.organization_id, generation.id);
  const edgeKeys = dryRun
    ? new Set<string>()
    : await loadExistingEdgeKeys(client, draft.organization_id, generation.id);

  for (const edge of edges) {
    const payloadSha = lineagePayloadSha256(edge);
    let lineageEventId: string | null = lineageByHash.get(payloadSha) ?? null;

    if (!lineageEventId) {
      if (!dryRun) {
        const { data: lev, error: levErr } = await client
          .from("claim_evidence_lineage_events")
          .insert({
            organization_id: draft.organization_id,
            generation_id: generation.id,
            draft_id: draft.id,
            event_type: lineageEventTypeForEdge(edge),
            producer: "replay_job",
            source_table: edge.source_table,
            source_row_id: edge.to_source_row_id,
            payload: {
              preview_edge_id: edge.edge_id,
              edge_type: edge.edge_type,
              edge_reason: edge.edge_reason,
              source_citations: edge.source_citations,
            },
            payload_sha256: payloadSha,
          })
          .select("id")
          .single();
        if (levErr) {
          if (levErr.code === "23505") {
            const { data: dup } = await client
              .from("claim_evidence_lineage_events")
              .select("id")
              .eq("organization_id", draft.organization_id)
              .eq("generation_id", generation.id)
              .eq("payload_sha256", payloadSha)
              .maybeSingle();
            lineageEventId = dup?.id ? String(dup.id) : null;
            lineageSkipped += 1;
          } else {
            throw new Error(`claim_evidence_lineage_events insert: ${levErr.message}`);
          }
        } else {
          lineageEventId = String(lev.id);
          lineageInserted += 1;
        }
        if (lineageEventId) lineageByHash.set(payloadSha, lineageEventId);
      } else {
        lineageInserted += 1;
        lineageEventId = "dry-run-lineage";
      }
    } else {
      lineageSkipped += 1;
    }

    const nKey = edgeNaturalKeyFromPreview(edge);
    if (edgeKeys.has(nKey)) {
      edgesSkipped += 1;
      continue;
    }

    if (dryRun) {
      edgesInserted += 1;
      edgeKeys.add(nKey);
      continue;
    }

    const { error: edgeErr } = await client.from("claim_reference_edges").insert({
      organization_id: draft.organization_id,
      generation_id: generation.id,
      draft_id: draft.id,
      edge_type: edge.edge_type,
      from_node_kind: edge.from_node_kind,
      from_source_table: edge.from_source_table,
      from_source_row_id: edge.from_source_row_id,
      to_node_kind: edge.to_node_kind,
      to_source_table: edge.to_source_table,
      to_source_row_id: edge.to_source_row_id,
      reference_kind: edge.reference_kind,
      reference_value: edge.reference_value,
      confidence_score: edge.confidence_score,
      ambiguity_group_key: edge.ambiguity_group_key,
      ambiguity_rank: edge.ambiguity_rank,
      edge_reason: edge.edge_reason,
      evidence_event_id: lineageEventId,
      source_citations: edge.source_citations,
    });
    if (edgeErr) {
      throw new Error(`claim_reference_edges insert: ${edgeErr.message}`);
    }
    edgesInserted += 1;
    edgeKeys.add(nKey);
  }

  if (!dryRun) {
    const { error: updErr } = await client
      .from("claim_enrichment_generations")
      .update({
        status: "computed",
        evidence_hash: evidenceHash,
        computed_at: new Date().toISOString(),
        diff_summary: {
          writer: "claim-evidence-04",
          edges_inserted: edgesInserted,
          edges_skipped: edgesSkipped,
          lineage_inserted: lineageInserted,
          lineage_skipped: lineageSkipped,
        },
      })
      .eq("id", generation.id)
      .eq("organization_id", draft.organization_id);
    if (updErr) throw new Error(`claim_enrichment_generations update: ${updErr.message}`);
  }

  return {
    dry_run: dryRun,
    organization_id: draft.organization_id,
    draft_id: draft.id,
    claim_candidate_id: input.claimCandidateId ?? null,
    generation_id: generation.id,
    generation_number: generation.generation_number,
    idempotency_key: idempotencyKey,
    preview_edge_count: edges.length,
    lineage_inserted: lineageInserted,
    lineage_skipped: lineageSkipped,
    edges_inserted: edgesInserted,
    edges_skipped: edgesSkipped,
    evidence_hash: evidenceHash,
  };
}

export type RollbackEvidence04Input = {
  organizationId: string;
  draftId: string;
  generationId?: string | null;
  dryRun?: boolean;
};

export type RollbackEvidence04Result = {
  dry_run: boolean;
  organization_id: string;
  draft_id: string;
  generation_id: string;
  edges_deleted: number;
  lineage_deleted: number;
  generation_deleted: boolean;
};

export async function rollbackClaimEvidence04ForDraft(
  client: SupabaseClient,
  input: RollbackEvidence04Input,
): Promise<RollbackEvidence04Result> {
  let generationId = input.generationId?.trim() || null;
  if (!generationId) {
    const idempotencyKey = generationIdempotencyKey(input.draftId);
    const { data, error } = await client
      .from("claim_enrichment_generations")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("draft_id", input.draftId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`generation lookup: ${error.message}`);
    generationId = data?.id ? String(data.id) : null;
  }
  if (!generationId) {
    throw new Error("No claim-evidence-04 generation found for this draft.");
  }

  const dryRun = input.dryRun === true;

  const { count: edgeCount } = await client
    .from("claim_reference_edges")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", input.organizationId)
    .eq("generation_id", generationId);

  const { count: lineageCount } = await client
    .from("claim_evidence_lineage_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", input.organizationId)
    .eq("generation_id", generationId);

  if (!dryRun) {
    const { error: e1 } = await client
      .from("claim_reference_edges")
      .delete()
      .eq("organization_id", input.organizationId)
      .eq("generation_id", generationId);
    if (e1) throw new Error(`claim_reference_edges delete: ${e1.message}`);

    const { error: e2 } = await client
      .from("claim_evidence_lineage_events")
      .delete()
      .eq("organization_id", input.organizationId)
      .eq("generation_id", generationId);
    if (e2) throw new Error(`claim_evidence_lineage_events delete: ${e2.message}`);

    const { error: e3 } = await client
      .from("claim_enrichment_generations")
      .delete()
      .eq("organization_id", input.organizationId)
      .eq("id", generationId);
    if (e3) throw new Error(`claim_enrichment_generations delete: ${e3.message}`);
  }

  return {
    dry_run: dryRun,
    organization_id: input.organizationId,
    draft_id: input.draftId,
    generation_id: generationId,
    edges_deleted: edgeCount ?? 0,
    lineage_deleted: lineageCount ?? 0,
    generation_deleted: !dryRun,
  };
}
