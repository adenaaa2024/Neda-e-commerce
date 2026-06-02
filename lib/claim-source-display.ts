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
  physical_return: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200",
  amazon_return: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  removal: "border-orange-200 bg-orange-50 text-orange-900 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-200",
  reimbursement: "border-teal-200 bg-teal-50 text-teal-900 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200",
  settlement: "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200",
  manual: "border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
  inventory: "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
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
