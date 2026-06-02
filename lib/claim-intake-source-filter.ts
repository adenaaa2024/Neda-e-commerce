import type { ClaimIntakeSourceKind } from "./claim-intake-sources";

/** Unified intake inbox source filter (UI tabs). */
export type IntakeSourceFilter =
  | "all"
  | "physical_return"
  | "amazon_return"
  | "removal"
  | "reimbursement"
  | "settlement"
  | "manual";

export const INTAKE_SOURCE_FILTER_TABS: { id: IntakeSourceFilter; label: string; kind: ClaimIntakeSourceKind }[] = [
  { id: "all", label: "All", kind: "amazon_return" },
  { id: "physical_return", label: "Physical return", kind: "physical_return" },
  { id: "amazon_return", label: "Amazon return", kind: "amazon_return" },
  { id: "removal", label: "Removal", kind: "removal" },
  { id: "reimbursement", label: "Reimbursement", kind: "reimbursement" },
  { id: "settlement", label: "Settlement", kind: "settlement" },
  { id: "manual", label: "Manual", kind: "manual" },
];

/** `physical_only` = no claim_candidates query; string[] = filter source_table IN (...); null = no table filter. */
export type IntakeSourceTableFilter = string[] | "physical_only" | null;

export function sourceTablesForIntakeFilter(filter: IntakeSourceFilter): IntakeSourceTableFilter {
  switch (filter) {
    case "all":
      return null;
    case "physical_return":
      return "physical_only";
    case "amazon_return":
      return ["amazon_returns"];
    case "removal":
      return ["amazon_removals", "amazon_removal_shipments"];
    case "reimbursement":
      return ["amazon_reimbursements"];
    case "settlement":
      return ["amazon_settlements"];
    case "manual":
      return ["return_items"];
    default:
      return null;
  }
}

export function draftSourceTablesForIntakeFilter(filter: IntakeSourceFilter): string[] | null {
  switch (filter) {
    case "reimbursement":
      return ["amazon_reimbursements"];
    case "settlement":
      return ["amazon_settlements"];
    case "all":
      return ["amazon_reimbursements", "amazon_settlements"];
    default:
      return null;
  }
}

export function intakeFilterShowsPhysicalSection(filter: IntakeSourceFilter): boolean {
  return filter === "all" || filter === "physical_return";
}

export function intakeFilterShowsClaimCandidates(filter: IntakeSourceFilter): boolean {
  return filter !== "physical_return";
}

export function intakeFilterShowsDraftCandidates(filter: IntakeSourceFilter): boolean {
  return (
    filter === "all" ||
    filter === "reimbursement" ||
    filter === "settlement"
  );
}

export function isValidIntakeSourceFilter(raw: string): raw is IntakeSourceFilter {
  return INTAKE_SOURCE_FILTER_TABS.some((t) => t.id === raw);
}
