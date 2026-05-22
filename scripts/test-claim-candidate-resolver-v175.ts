/**
 * CLAIM-CANDIDATE-RESOLVER-V175 — Unit tests (no DB).
 */

import {
  buildBlockerInventory,
  isEligibleMaterializeProposal,
  type ResolverPassMetrics,
} from "../lib/claim-candidate-resolver-materialize";
import type { ClaimArtifactCoreProjection } from "../lib/claim-artifact-projection-core";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function proj(partial: Partial<ClaimArtifactCoreProjection>): ClaimArtifactCoreProjection {
  return {
    final_bucket: "safe_update_candidate",
    inbox_queue: "ready_for_review",
    badges: [],
    lineage_warning_code: null,
    automation_allowed: false,
    proposal_from: "identifier_map",
    confidence: 1,
    reason_codes: [],
    source_found: true,
    proposed_resolved_product_id: "00000000-0000-0000-0000-000000000099",
    ...partial,
  };
}

function testEligible(): void {
  assert(isEligibleMaterializeProposal(proj({})), "identifier_map safe");
  assert(
    isEligibleMaterializeProposal(proj({ proposal_from: "source_resolved" })),
    "source_resolved safe",
  );
  assert(!isEligibleMaterializeProposal(proj({ proposal_from: "source_product_id" })), "no trust pid");
  assert(!isEligibleMaterializeProposal(proj({ final_bucket: "ambiguous" })), "no ambiguous");
  assert(
    isEligibleMaterializeProposal(proj({ final_bucket: "resolvable_from_source" })),
    "resolvable_from_source",
  );
}

function testBlockers(): void {
  const m: ResolverPassMetrics = {
    table: "claim_candidates",
    rows_scanned: 10,
    rows_already_resolved: 0,
    bucket_counts: { ambiguous: 2 },
    eligible_safe_update: 1,
    applied: 0,
    skipped_ambiguous: 2,
    skipped_unsupported: 0,
    skipped_missing_source: 1,
  };
  const inv = buildBlockerInventory(m, { ...m, table: "claim_candidate_drafts", skipped_ambiguous: 0 });
  assert(inv.some((b) => b.code.includes("ambiguous")), "ambiguous listed");
}

async function main(): Promise<void> {
  const tests: [string, () => void][] = [
    ["eligible policy", testEligible],
    ["blocker inventory", testBlockers],
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`ok ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
