/**
 * Unit checks for claim intake generators (no DB, no Amazon).
 *   npm run test:claim-intake-generators-phase1
 */
import assert from "node:assert/strict";

import {
  buildIntakeCandidateFromSourceRow,
  claimIntakeIdempotencyKey,
  isSettlementRowClaimableIntake,
} from "../lib/claim-intake-candidate-generators";

function main(): void {
  assert.equal(
    isSettlementRowClaimableIntake({ transaction_type: "Service Fee", amount_total: -5 }),
    false,
  );
  assert.equal(
    isSettlementRowClaimableIntake({ transaction_type: "FBA Inventory Reimbursement", order_id: "x" }),
    true,
  );

  const key1 = claimIntakeIdempotencyKey("org", "amazon_returns", "row1", "REASON");
  const key2 = claimIntakeIdempotencyKey("org", "amazon_returns", "row1", "REASON");
  assert.equal(key1, key2);
  assert.ok(key1.startsWith("cl:intake:"));

  const reimb = buildIntakeCandidateFromSourceRow(
    "amazon_reimbursements",
    {
      id: "00000000-0000-0000-0000-000000000099",
      organization_id: "00000000-0000-0000-0000-000000000001",
      store_id: "509ee1f6-622c-46a5-8110-7b889ba46c2c",
      reimbursement_id: "R-1",
      amount_reimbursed: 10.5,
      upload_id: "00000000-0000-0000-0000-000000000088",
    },
    "unit_test",
  );
  assert.ok(reimb);
  assert.equal(reimb!.claim_family, "AMAZON_REIMBURSEMENTS");
  assert.equal(reimb!.candidate_payload.source_type, "amazon_reimbursements");
  assert.equal(reimb!.candidate_payload.external_reference, "R-1");

  const settSkip = buildIntakeCandidateFromSourceRow(
    "amazon_settlements",
    {
      id: "1",
      organization_id: "00000000-0000-0000-0000-000000000001",
      transaction_type: "Service Fee",
    },
    "unit_test",
  );
  assert.equal(settSkip, null);

  console.log(JSON.stringify({ ok: true, prompt: "test:claim-intake-generators-phase1" }, null, 2));
}

main();
