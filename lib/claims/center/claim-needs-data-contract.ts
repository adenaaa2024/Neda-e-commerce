/**
 * PHASE-CLAIM_CENTER_UNIFIED_OPPORTUNITIES_UI_V1 — Needs Data taxonomy (client-safe, pure).
 *
 * Maps hardened-gate / queue blocker keys to the seven operator-facing "Needs Data"
 * groups so blocked candidates are explained, not just hidden. No DB, no claim math.
 */

export type NeedsDataGroupId =
  | "missing_live_source"
  | "missing_sale_price"
  | "missing_reimbursement_check"
  | "missing_trid_reference"
  | "missing_product_linkage"
  | "physical_receiving"
  | "waiting_threshold"
  | "needs_review";

export type NeedsDataGroup = {
  id: NeedsDataGroupId;
  label: string;
  description: string;
  /** What unblocks rows in this group. */
  unblockHint: string;
};

export const NEEDS_DATA_GROUPS: NeedsDataGroup[] = [
  {
    id: "missing_live_source",
    label: "Missing live source",
    description: "The Amazon source row / live delivery proof for this event is not loaded.",
    unblockHint: "Enable the live source sync (e.g. removal delivery / SP-API report) for this family.",
  },
  {
    id: "missing_sale_price",
    label: "Missing sale price",
    description: "Latest sale price source is not loaded, so the Amazon claim amount stays UNKNOWN.",
    unblockHint: "Import the settlement / Order sale rows. No COGS fallback is used.",
  },
  {
    id: "missing_reimbursement_check",
    label: "Missing reimbursement check",
    description: "Cannot confirm the event was not already reimbursed.",
    unblockHint: "Run the live GET_FBA_REIMBURSEMENTS_DATA sync to confirm not-reimbursed.",
  },
  {
    id: "missing_trid_reference",
    label: "Missing TRID / reference",
    description: "Required Amazon reference or quantity basis is not resolved.",
    unblockHint: "Resolve the reference graph / quantity basis in References.",
  },
  {
    id: "missing_product_linkage",
    label: "Missing product linkage",
    description: "Product identity (FNSKU / SKU / ASIN) is not resolved.",
    unblockHint: "Link the product in Product Match / PIM.",
  },
  {
    id: "physical_receiving",
    label: "Physical receiving not started",
    description: "No physical receiving/scanning occurred and no live delivery confirmation exists.",
    unblockHint: "Start the receiving/scan workflow, or wait for live delivery proof.",
  },
  {
    id: "waiting_threshold",
    label: "Waiting threshold",
    description: "Event age has not yet exceeded the configured delayed_not_received_days threshold.",
    unblockHint: "No action — the row becomes eligible once the threshold elapses.",
  },
  {
    id: "needs_review",
    label: "Needs manual review",
    description: "Blocked by a cross-family / classification issue that needs an operator decision.",
    unblockHint: "Review the candidate and reclassify or escalate.",
  },
];

const BLOCKER_TO_GROUP: Record<string, NeedsDataGroupId> = {
  // live source
  missing_removal_source: "missing_live_source",
  missing_live_delivery_proof: "missing_live_source",
  missing_live_source: "missing_live_source",
  // sale price
  missing_sale_price_source: "missing_sale_price",
  // reimbursement
  live_reimbursement_check_missing: "missing_reimbursement_check",
  missing_live_reimbursement_check: "missing_reimbursement_check",
  // reference / basis
  missing_quantity: "missing_trid_reference",
  missing_trid_reference: "missing_trid_reference",
  reference_conflict: "missing_trid_reference",
  // product
  missing_product_identity: "missing_product_linkage",
  missing_product_linkage: "missing_product_linkage",
  blocked_product_link: "missing_product_linkage",
  // receiving
  physical_receiving_not_started: "physical_receiving",
  waiting_physical_receiving: "physical_receiving",
  // threshold
  waiting_threshold: "waiting_threshold",
  // review
  cross_family_pollution: "needs_review",
  seller_central_copy_polluted: "needs_review",
  wrong_family: "needs_review",
  needs_manual_review: "needs_review",
};

export function needsDataGroupForBlocker(blockerKey: string): NeedsDataGroupId {
  return BLOCKER_TO_GROUP[blockerKey] ?? "needs_review";
}

export function needsDataBlockerLabel(blockerKey: string): string {
  return blockerKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getNeedsDataGroup(id: NeedsDataGroupId): NeedsDataGroup {
  return NEEDS_DATA_GROUPS.find((g) => g.id === id) ?? NEEDS_DATA_GROUPS[NEEDS_DATA_GROUPS.length - 1]!;
}
