/**
 * NEXT-CLAIM-18 — Read-only Claim Inbox projection (server-side).
 *
 * Thin adapters over [`./claim-artifact-projection-core`](./claim-artifact-projection-core.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  projectClaimArtifactsBatchCore,
  fetchCandidateSourceContextMap,
  fetchSourceRowsByIds,
  claimArtifactStr,
  type ClaimArtifactCoreProjection,
  type InboxProjectionRow,
  type InboxQueue,
  type ResolverFinalBucket,
} from "./claim-artifact-projection-core";

export type { InboxProjectionRow, InboxQueue, ResolverFinalBucket };

export const claimInboxStr = claimArtifactStr;

export {
  computeFinalBucket,
  computeInboxQueueMeta,
  extractIdentifierHints,
  fetchCandidateSourceContextMap,
  fetchSourceRowsByIds,
} from "./claim-artifact-projection-core";

export type ProjectedCandidate = InboxProjectionRow & {
  claim_candidate_id: string;
  source_found: boolean;
  proposed_resolved_product_id: string | null;
};

export type ProjectedClaimDraft = InboxProjectionRow & {
  claim_candidate_draft_id: string;
  source_found: boolean;
  proposed_resolved_product_id: string | null;
};

function toProjectedCandidate(artifactId: string, row: ClaimArtifactCoreProjection): ProjectedCandidate {
  return {
    claim_candidate_id: artifactId,
    final_bucket: row.final_bucket,
    inbox_queue: row.inbox_queue,
    badges: row.badges,
    lineage_warning_code: row.lineage_warning_code,
    automation_allowed: row.automation_allowed,
    proposal_from: row.proposal_from,
    confidence: row.confidence,
    reason_codes: row.reason_codes,
    source_found: row.source_found,
    proposed_resolved_product_id: row.proposed_resolved_product_id,
  };
}

function toProjectedDraft(artifactId: string, row: ClaimArtifactCoreProjection): ProjectedClaimDraft {
  return {
    claim_candidate_draft_id: artifactId,
    final_bucket: row.final_bucket,
    inbox_queue: row.inbox_queue,
    badges: row.badges,
    lineage_warning_code: row.lineage_warning_code,
    automation_allowed: row.automation_allowed,
    proposal_from: row.proposal_from,
    confidence: row.confidence,
    reason_codes: row.reason_codes,
    source_found: row.source_found,
    proposed_resolved_product_id: row.proposed_resolved_product_id,
  };
}

/**
 * Full resolver-aligned projection for a batch of claim_candidates (same org).
 */
export async function projectClaimCandidatesBatch(
  client: SupabaseClient,
  batch: Record<string, unknown>[],
  organizationId: string,
): Promise<Map<string, ProjectedCandidate>> {
  const core = await projectClaimArtifactsBatchCore(client, batch, organizationId, fetchCandidateSourceContextMap);
  const out = new Map<string, ProjectedCandidate>();
  for (const [id, row] of core) {
    out.set(id, toProjectedCandidate(id, row));
  }
  return out;
}

/**
 * Same projection rules as claim_candidates, with **no** `v_claim_candidate_source_context` join
 * (draft ids do not appear in that view). Operational hints merge from artifact row + source row only.
 */
export async function projectClaimCandidateDraftsBatch(
  client: SupabaseClient,
  batch: Record<string, unknown>[],
  organizationId: string,
): Promise<Map<string, ProjectedClaimDraft>> {
  const core = await projectClaimArtifactsBatchCore(client, batch, organizationId, null);
  const out = new Map<string, ProjectedClaimDraft>();
  for (const [id, row] of core) {
    out.set(id, toProjectedDraft(id, row));
  }
  return out;
}
