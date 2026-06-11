import type { SupabaseClient } from "@supabase/supabase-js";

import { projectClaimCandidatesBatch } from "../../claim-inbox-projection";
import type { ClaimDiscoverySourceKind, DiscoveryEligibilityRow } from "./claim-discovery-types";

const ELIGIBLE_QUEUES = new Set<string>(["ready_for_review"]);

/**
 * Loads candidates produced by a discovery run and projects inbox eligibility.
 * Read-only — never promotes or submits.
 */
export async function loadDiscoveryEligibilityQueue(
  client: SupabaseClient,
  organizationId: string,
  runId: string,
  opts?: {
    sourceKinds?: ClaimDiscoverySourceKind[];
    limit?: number;
    storeId?: string | null;
  },
): Promise<{ queue: DiscoveryEligibilityRow[]; total_scanned: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);

  let q = client
    .from("claim_candidates")
    .select(
      "id, organization_id, store_id, source_kind, claim_family, confidence_score, recovery_value, reference_id, event_date, candidate_status, evidence_status, quarantined_at",
    )
    .eq("organization_id", organizationId)
    .eq("intake_run_id", runId)
    .neq("source_kind", "legacy_seed")
    .is("quarantined_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (opts?.storeId) q = q.eq("store_id", opts.storeId);
  if (opts?.sourceKinds?.length) q = q.in("source_kind", opts.sourceKinds);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return { queue: [], total_scanned: 0 };

  const proj = await projectClaimCandidatesBatch(client, rows, organizationId);
  const queue: DiscoveryEligibilityRow[] = [];

  for (const row of rows) {
    const id = String(row.id ?? "");
    const projection = proj.get(id);
    if (!projection) continue;

    const inboxQueue = projection.inbox_queue;
    const eligible =
      ELIGIBLE_QUEUES.has(inboxQueue) ||
      (projection.automation_allowed && inboxQueue !== "ineligible_pre_cutoff");

    if (!eligible) continue;

    queue.push({
      candidate_id: id,
      source_kind: String(row.source_kind ?? "") as DiscoveryEligibilityRow["source_kind"],
      claim_family: typeof row.claim_family === "string" ? row.claim_family : null,
      inbox_queue: inboxQueue,
      automation_allowed: projection.automation_allowed,
      confidence_score:
        row.confidence_score === null || row.confidence_score === undefined
          ? null
          : Number(row.confidence_score),
      recovery_value:
        row.recovery_value === null || row.recovery_value === undefined
          ? null
          : Number(row.recovery_value),
      reference_id: typeof row.reference_id === "string" ? row.reference_id : null,
      event_date: typeof row.event_date === "string" ? row.event_date : null,
      projection,
    });
  }

  return { queue, total_scanned: rows.length };
}
