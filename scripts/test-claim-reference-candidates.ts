/**
 * TRID-REFERENCE-GRAPH-IMPLEMENT-V170 — Unit tests (no DB).
 * Run: npm run test:claim-reference-candidates
 */

import {
  buildCandidateDedupeKey,
  buildCandidateKey,
} from "../lib/canonical-reference-candidate-types";
import {
  buildReferenceCandidatesForClaim,
  computeReferenceCandidatesOutcome,
  deduplicateReferenceCandidates,
  financesEventToCandidate,
  frrRowToCandidate,
  scoreReferenceConfidence,
} from "../lib/claim-reference-candidates";
import type { ClaimEvidenceDraftRow } from "../lib/claim-evidence-preview";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const draft: ClaimEvidenceDraftRow = {
  id: "00000000-0000-4000-8000-000000000099",
  organization_id: "00000000-0000-4000-8000-000000000001",
  store_id: null,
  source_table: "amazon_removals",
  source_row_id: "00000000-0000-4000-8000-000000000010",
  sku: "SKU-1",
};

function testDedupeKey(): void {
  const a = buildCandidateDedupeKey({
    reference_value: "TRID-1",
    source_table: "amazon_settlements",
    source_row_id: "row-1",
  });
  const b = buildCandidateDedupeKey({
    reference_value: "TRID-1",
    source_table: "amazon_settlements",
    source_row_id: "row-1",
  });
  assert(a === b, "dedupe key stable");
}

function testCandidateKeyDiffersByType(): void {
  const a = buildCandidateKey({
    reference_type: "internal_trid_key",
    reference_value: "x",
    source_table: "amazon_settlements",
    source_row_id: "r1",
  });
  const b = buildCandidateKey({
    reference_type: "settlement_id",
    reference_value: "x",
    source_table: "amazon_settlements",
    source_row_id: "r1",
  });
  assert(a !== b, "candidate_key includes reference_type");
}

function testDeterministicSingle(): void {
  const { candidates, outcome } = buildReferenceCandidatesForClaim({
    draft,
    operational: {
      order_id: "ORDER-1",
      sku: "SKU-1",
      fnsku: null,
      upload_id: null,
      removal_order_id: "ORDER-1",
    },
    frrRows: [
      {
        trid_key: "trid:only",
        source_table: "amazon_settlements",
        source_row_id: "00000000-0000-4000-8000-000000000020",
        order_id: "ORDER-1",
        sku: "SKU-1",
        confidence_score: 0.95,
        settlement_id: "S-1",
        posted_date: "2026-01-01",
        amount: 10,
        currency: "USD",
        transaction_type: "Order",
      },
    ],
    financeEvents: [],
    reimbursementRows: [],
    operatorSelection: null,
    operationalRowFound: true,
  });
  assert(candidates.length === 1, "one candidate");
  assert(outcome === "deterministic_single", `outcome ${outcome}`);
}

function testAmbiguousMultiple(): void {
  const { outcome } = buildReferenceCandidatesForClaim({
    draft,
    operational: {
      order_id: "ORDER-1",
      sku: "SKU-1",
      fnsku: null,
      upload_id: null,
      removal_order_id: "ORDER-1",
    },
    frrRows: [
      {
        trid_key: "trid:a",
        source_table: "amazon_settlements",
        source_row_id: "r1",
        order_id: "ORDER-1",
        sku: "SKU-1",
        confidence_score: 0.9,
      },
      {
        trid_key: "trid:b",
        source_table: "amazon_settlements",
        source_row_id: "r2",
        order_id: "ORDER-1",
        sku: "SKU-1",
        confidence_score: 0.85,
      },
    ],
    financeEvents: [],
    reimbursementRows: [],
    operatorSelection: null,
    operationalRowFound: true,
  });
  assert(outcome === "ambiguous_multiple", `outcome ${outcome}`);
}

function testDedupeByValueTableRow(): void {
  const ctx = {
    orderId: "O1",
    removalOrderId: "O1",
    skuHint: "sku-1",
    operationalUploadId: null,
  };
  const c1 = frrRowToCandidate(
    {
      trid_key: "same",
      source_table: "amazon_settlements",
      source_row_id: "rid",
      order_id: "O1",
      sku: "sku-1",
      confidence_score: 0.8,
    },
    draft,
    ctx,
    { rank: 1, ambKey: null, skuMatched: true },
  )!;
  const c2 = frrRowToCandidate(
    {
      trid_key: "same",
      source_table: "amazon_settlements",
      source_row_id: "rid",
      order_id: "O1",
      sku: "sku-1",
      confidence_score: 0.95,
    },
    draft,
    ctx,
    { rank: 2, ambKey: null, skuMatched: true },
  )!;
  const merged = deduplicateReferenceCandidates([c1, c2]);
  assert(merged.length === 1, "deduped to one");
  assert(merged[0]!.confidence >= 0.95, "keeps higher confidence");
}

function testFinancesEventCandidate(): void {
  const c = financesEventToCandidate(
    {
      id: "ev-1",
      amazon_event_id: "AMZ-EV-1",
      order_id: "ORDER-1",
      event_type: "RefundEvent",
      posted_at: "2026-02-01T00:00:00Z",
      amount: -5,
      currency: "USD",
      source_run_id: "run-1",
    },
    draft,
    { orderId: "ORDER-1", removalOrderId: null, skuHint: null, operationalUploadId: null },
    { rank: 1, ambKey: null },
  );
  assert(c != null, "finances candidate");
  assert(c!.reference_type === "amazon_event_id", "type");
  assert(c!.source_table === "amazon_finances_events", "table");
}

function testScoreBoostsSku(): void {
  const base = 0.72;
  const low = scoreReferenceConfidence(
    base,
    {
      order_id: "O1",
      removal_order_id: null,
      sku: "other",
      settlement_id: null,
      amount: null,
      event_date: null,
      source_upload_id: null,
      claim_case_join_reason: "order_id_exact",
    },
    { orderId: "O1", removalOrderId: null, skuHint: "sku-1", operationalUploadId: null },
  );
  const high = scoreReferenceConfidence(
    base,
    {
      order_id: "O1",
      removal_order_id: null,
      sku: "SKU-1",
      settlement_id: null,
      amount: null,
      event_date: null,
      source_upload_id: null,
      claim_case_join_reason: "order_id_and_sku",
    },
    { orderId: "O1", removalOrderId: null, skuHint: "sku-1", operationalUploadId: null },
  );
  assert(high > low, "sku match boosts score");
}

function testMissingFrr(): void {
  const outcome = computeReferenceCandidatesOutcome([], {
    operational: { order_id: "O1", sku: null, fnsku: null, upload_id: null, removal_order_id: null },
    operationalRowFound: true,
  });
  assert(outcome === "missing_frr", outcome);
}

function main(): void {
  testDedupeKey();
  testCandidateKeyDiffersByType();
  testDeterministicSingle();
  testAmbiguousMultiple();
  testDedupeByValueTableRow();
  testFinancesEventCandidate();
  testScoreBoostsSku();
  testMissingFrr();
  console.log("test-claim-reference-candidates: all passed");
}

main();
