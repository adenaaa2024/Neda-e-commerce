/**
 * Phase 7H — claim reference edge materializer (unified pool anchor).
 *
 * Materializes candidate reference context into `claim_reference_edges`
 * anchored on `claim_candidates.candidate_id`. Edge vocabulary:
 *   * source_evidence      — candidate -> its source-of-truth row
 *   * financial_reference  — candidate order -> FRR (per FRR source table; ambiguity preserved)
 *   * resolves             — candidate order -> the single FRR row when resolution is deterministic
 *   * corroborates         — trusted candidate -> legacy_seed candidate (metadata corroboration stamp)
 *   * supersedes           — trusted candidate -> legacy_seed candidate sharing the same source row
 *   * duplicates           — same source row + claim_family pairs (constraint-blocked; supported, expected 0)
 *
 * Hard rules: never writes claim_cases/claim_lines, never files claims, never
 * promotes candidates. Legacy draft edges (draft_id-anchored) stay readable but
 * are never used as pool truth. Dedupe is enforced by the partial unique index
 * uq_claim_reference_edges_candidate_natural (ON CONFLICT DO NOTHING).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { emitOrderResolvedCandidates, type LiveEmitResult } from "../intake/claim-live-trigger-emitters";

export const PHASE_7H_EDGE_TYPES = [
  "corroborates",
  "resolves",
  "supersedes",
  "duplicates",
  "source_evidence",
  "financial_reference",
] as const;

export type Phase7hEdgeType = (typeof PHASE_7H_EDGE_TYPES)[number];

export type MaterializedEdgeRow = {
  organization_id: string;
  candidate_id: string;
  edge_type: Phase7hEdgeType;
  from_node_kind: string;
  from_source_table: string;
  from_source_row_id: string;
  to_node_kind: string;
  to_source_table: string | null;
  to_source_row_id: string | null;
  reference_kind: string | null;
  reference_value: string | null;
  confidence_score: number;
  ambiguity_group_key: string | null;
  ambiguity_rank: number | null;
  edge_reason: string;
  source_citations: Array<Record<string, unknown>>;
};

export type OrderResolvedHookResult =
  | { emitted: true; order_id: string; result: LiveEmitResult }
  | { emitted: false; order_id: string; reason: "ambiguous_requires_operator_selection" | "no_order" };

/**
 * Phase 7H order_resolved hook — safe wiring only.
 * Emits live `order_resolved` candidates ONLY when the order's financial
 * reference resolution is deterministic (exactly one FRR match). Ambiguous
 * orders are never auto-emitted: their edges carry ambiguity_group_key and
 * operator_review_status='needs_review', requiring operator selection first.
 * The emitter itself remains policy-gated (claim_candidate_trigger).
 */
export async function emitOrderResolvedIfDeterministic(
  client: SupabaseClient,
  args: { organizationId: string; orderId: string | null; frrMatchCount: number },
): Promise<OrderResolvedHookResult> {
  const orderId = (args.orderId ?? "").trim();
  if (!orderId) return { emitted: false, order_id: "", reason: "no_order" };
  if (args.frrMatchCount !== 1) {
    return { emitted: false, order_id: orderId, reason: "ambiguous_requires_operator_selection" };
  }
  const result = await emitOrderResolvedCandidates(client, {
    organizationId: args.organizationId,
    orderId,
  });
  return { emitted: true, order_id: orderId, result };
}

/** Read materialized pool edges for a set of candidates (packet composer / review). */
export async function loadMaterializedCandidateEdges(
  client: SupabaseClient,
  organizationId: string,
  candidateIds: string[],
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  if (!candidateIds.length) return out;

  const { data, error } = await client
    .from("claim_reference_edges")
    .select(
      "candidate_id, edge_type, reference_kind, reference_value, to_source_table, to_source_row_id, confidence_score, ambiguity_group_key, operator_review_status",
    )
    .eq("organization_id", organizationId)
    .in("candidate_id", candidateIds)
    .limit(2000);

  // Graceful degradation: candidate_id column absent (migration not applied) -> empty map.
  if (error) return out;

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const cid = String(row.candidate_id ?? "");
    if (!cid) continue;
    const list = out.get(cid) ?? [];
    list.push(row);
    out.set(cid, list);
  }
  return out;
}
