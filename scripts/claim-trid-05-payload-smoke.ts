import { validateOperatorTridSelectionEventPayload } from "../lib/claim-trid-candidates-types";

const workItemId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";

const validPayload = {
  draft_id: draftId,
  work_item_id: workItemId,
  selected_reference_value: "reimb|ORDER-1|SKU-1|rid:abc",
  selected_reference_kind: "internal_composite",
  selected_source_table: "amazon_reimbursements",
  selected_source_row_id: "33333333-3333-4333-8333-333333333333",
  selected_confidence: 0.8,
  selected_reason: "Matched order, SKU, and reimbursement amount.",
  candidate_count: 3,
  selection_status: "operator_selected",
  source_run_id: "claim-trid-02-real-org",
};

const ok = validateOperatorTridSelectionEventPayload(validPayload, { workItemId, draftId });
if (!ok.ok) {
  throw new Error(`Expected valid payload, got: ${ok.error}`);
}

const missingReason = validateOperatorTridSelectionEventPayload(
  { ...validPayload, selected_reason: "" },
  { workItemId, draftId },
);
if (missingReason.ok) {
  throw new Error("Expected missing selected_reason to fail.");
}

const wrongDraft = validateOperatorTridSelectionEventPayload(
  { ...validPayload, draft_id: "44444444-4444-4444-8444-444444444444" },
  { workItemId, draftId },
);
if (wrongDraft.ok) {
  throw new Error("Expected draft mismatch to fail.");
}

console.log("NEXT-CLAIM-TRID-05 payload smoke passed.");
