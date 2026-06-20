/**
 * PHASE-CLAIM_CENTER_UNIFIED_OPPORTUNITIES_UI_V1 — opportunity family grouping (client-safe, pure).
 *
 * Buckets the 17 claim families into the 8 operator-facing groups used on the
 * Opportunities page. No DB, no Amazon, no claim math.
 */

export type OpportunityFamilyGroupId =
  | "damaged"
  | "lost"
  | "disposed"
  | "removal"
  | "reimbursement_error"
  | "customer_return"
  | "fee_overcharge"
  | "inbound_discrepancy";

export type OpportunityFamilyGroup = {
  id: OpportunityFamilyGroupId;
  label: string;
  description: string;
};

export const OPPORTUNITY_FAMILY_GROUPS: OpportunityFamilyGroup[] = [
  { id: "damaged", label: "Damaged", description: "Warehouse or outbound damage events." },
  { id: "lost", label: "Lost", description: "Warehouse or outbound lost-inventory events." },
  { id: "disposed", label: "Disposed", description: "Disposed without reimbursement." },
  { id: "removal", label: "Removal", description: "Removal shipment / order discrepancies." },
  {
    id: "reimbursement_error",
    label: "Reimbursement error",
    description: "Reversed, missing, or partial reimbursements.",
  },
  {
    id: "customer_return",
    label: "Customer return",
    description: "Returns not received, refunds without return, wrong / empty-box returns.",
  },
  { id: "fee_overcharge", label: "Fee overcharge", description: "Fulfilment or storage fee overcharges." },
  {
    id: "inbound_discrepancy",
    label: "Inbound discrepancy",
    description: "Inbound shipment receiving discrepancies.",
  },
];

const FAMILY_TO_GROUP: Record<string, OpportunityFamilyGroupId> = {
  damaged_warehouse: "damaged",
  damaged_outbound: "damaged",
  lost_warehouse: "lost",
  lost_outbound: "lost",
  disposed_without_reimbursement: "disposed",
  removal_shipment_missing: "removal",
  removal_order_discrepancy: "removal",
  reimbursement_reversal: "reimbursement_error",
  missing_reimbursement: "reimbursement_error",
  partial_reimbursement: "reimbursement_error",
  customer_return_not_received: "customer_return",
  refund_without_return: "customer_return",
  wrong_item_returned: "customer_return",
  empty_box_return: "customer_return",
  fulfillment_fee_overcharge: "fee_overcharge",
  storage_fee_overcharge: "fee_overcharge",
  inbound_shipment_discrepancy: "inbound_discrepancy",
};

export function opportunityGroupForFamily(family: string | null | undefined): OpportunityFamilyGroupId | null {
  if (!family) return null;
  return FAMILY_TO_GROUP[family] ?? null;
}

export function getOpportunityFamilyGroup(id: OpportunityFamilyGroupId): OpportunityFamilyGroup {
  return OPPORTUNITY_FAMILY_GROUPS.find((g) => g.id === id)!;
}
