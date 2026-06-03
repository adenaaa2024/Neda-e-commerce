import type { ClaimIntakeSourceKind } from "./claim-intake-sources";

/** Map operational source_table / claim source to unified intake badge. */
export function resolveClaimSourceKind(input: {
  source_table?: string | null;
  claim_source?: string | null;
}): ClaimIntakeSourceKind {
  const st = String(input.source_table ?? "").trim().toLowerCase();
  const cs = String(input.claim_source ?? "").trim().toLowerCase();

  if (st === "return_items" || st === "returns" || cs.includes("scanner") || cs === "ready_for_claim") {
    return "physical_return";
  }
  if (st === "amazon_returns") return "amazon_return";
  if (st === "amazon_removals" || st === "amazon_removal_shipments") return "removal";
  if (st.includes("reimburse") || cs.includes("reimburse")) return "reimbursement";
  if (st.includes("settlement") || cs.includes("settlement")) return "settlement";
  if (cs === "warehouse_qc_issue" || st.includes("inventory")) return "inventory";
  if (cs === "import_candidate" || st === "claim_candidates") return "amazon_return";
  if (cs.includes("manual") || cs === "operator_other") return "manual";
  return "physical_return";
}

export const CLAIM_SOURCE_BADGE_CLASS: Record<ClaimIntakeSourceKind, string> = {
  physical_return: "claim-engine-chip claim-engine-chip--info",
  amazon_return: "claim-engine-chip claim-engine-chip--warning",
  removal: "claim-engine-chip claim-engine-chip--warning",
  reimbursement: "claim-engine-chip claim-engine-chip--success",
  settlement: "claim-engine-chip claim-engine-chip--accent",
  manual: "claim-engine-chip claim-engine-chip--accent",
  inventory: "claim-engine-chip claim-engine-chip--danger",
};

export const CLAIM_SOURCE_LABEL: Record<ClaimIntakeSourceKind, string> = {
  physical_return: "Physical return",
  amazon_return: "Amazon return",
  removal: "Removal",
  reimbursement: "Reimbursement",
  settlement: "Settlement",
  manual: "Manual",
  inventory: "Inventory",
};
