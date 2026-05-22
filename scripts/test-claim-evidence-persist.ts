/**
 * NEXT-CLAIM-EVIDENCE-04 — Unit tests (no DB).
 * Run: npm run test:claim-evidence-persist
 */

import {
  edgeNaturalKey,
  edgeNaturalKeyFromPreview,
  evidenceHashFromEdgeIds,
  generationIdempotencyKey,
  lineageEventTypeForEdge,
  lineagePayloadSha256,
} from "../lib/claim-evidence-persist";
import type { ClaimEvidencePreviewEdge } from "../lib/claim-evidence-preview";
import { isClaimEvidence04WriteApproved } from "../lib/claim-evidence-persist-approval";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sampleEdge: ClaimEvidencePreviewEdge = {
  edge_id: "preview:abc:111",
  draft_id: "00000000-0000-4000-8000-000000000099",
  organization_id: "00000000-0000-4000-8000-000000000001",
  edge_type: "claim_to_trid",
  from_node_kind: "claim_draft",
  from_source_table: "claim_candidate_drafts",
  from_source_row_id: "00000000-0000-4000-8000-000000000099",
  to_node_kind: "internal_trid_key",
  to_source_table: "financial_reference_resolver",
  to_source_row_id: "row-1",
  reference_kind: "internal_trid_key",
  reference_value: "TRID-XYZ",
  confidence_score: 0.9,
  ambiguity_group_key: "frr:order:sku",
  ambiguity_rank: 1,
  edge_reason: "test",
  source_table: "financial_reference_resolver",
  source_citations: [],
};

function testIdempotencyKey(): void {
  const k = generationIdempotencyKey("draft-uuid");
  assert(k === "claim-evidence-04:draft-uuid", "generation key");
}

function testNaturalKeyStable(): void {
  const a = edgeNaturalKeyFromPreview(sampleEdge);
  const b = edgeNaturalKeyFromPreview({ ...sampleEdge });
  assert(a === b, "natural key stable");
  assert(edgeNaturalKey(sampleEdge) === a, "alias");
}

function testLineageShaStable(): void {
  const h1 = lineagePayloadSha256(sampleEdge);
  const h2 = lineagePayloadSha256({ ...sampleEdge });
  assert(h1 === h2 && h1.length === 64, "sha256 hex");
}

function testEvidenceHash(): void {
  const h = evidenceHashFromEdgeIds(["b", "a", "c"]);
  const h2 = evidenceHashFromEdgeIds(["a", "b", "c"]);
  assert(h === h2, "sorted hash");
}

function testLineageEventType(): void {
  assert(lineageEventTypeForEdge(sampleEdge) === "trid_candidate_seen", "trid type");
  assert(
    lineageEventTypeForEdge({ ...sampleEdge, edge_type: "claim_to_settlement" }) ===
      "finances_archive_event_seen",
    "finances type",
  );
}

function testApprovalFileReadable(): void {
  assert(typeof isClaimEvidence04WriteApproved() === "boolean", "approval boolean");
}

function main(): void {
  const tests: [string, () => void][] = [
    ["idempotency key", testIdempotencyKey],
    ["natural key", testNaturalKeyStable],
    ["lineage sha", testLineageShaStable],
    ["evidence hash", testEvidenceHash],
    ["lineage event type", testLineageEventType],
    ["approval readable", testApprovalFileReadable],
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
  if (failed > 0) process.exit(1);
  console.log(`\n${tests.length}/${tests.length} passed`);
}

main();
