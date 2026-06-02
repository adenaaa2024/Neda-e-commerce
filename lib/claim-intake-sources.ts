/** Claim intake source catalog — UI truth for what the backend supports today vs planned. */

export type ClaimIntakeSourceKind =
  | "physical_return"
  | "amazon_return"
  | "removal"
  | "reimbursement"
  | "settlement"
  | "manual"
  | "inventory";

export type ClaimIntakeSourceStatus = "live" | "partial" | "planned";

export type ClaimIntakeSourceDef = {
  kind: ClaimIntakeSourceKind;
  label: string;
  status: ClaimIntakeSourceStatus;
  detail: string;
  /** Primary table or API when live/partial */
  backend?: string;
};

export const CLAIM_INTAKE_SOURCES: ClaimIntakeSourceDef[] = [
  {
    kind: "physical_return",
    label: "Physical return",
    status: "live",
    detail: "Warehouse scans → return_items → Draft pool (not claim_candidates inbox).",
    backend: "return_items",
  },
  {
    kind: "amazon_return",
    label: "Amazon return",
    status: "live",
    detail: "Import rows surface as claim_candidates and import_source claim_lines (read-only in draft pool).",
    backend: "amazon_returns / claim_candidates",
  },
  {
    kind: "removal",
    label: "Removal",
    status: "live",
    detail: "Removal orders and shipments generate claim_candidates when import pipelines run.",
    backend: "amazon_removals / amazon_removal_shipments",
  },
  {
    kind: "reimbursement",
    label: "Reimbursement",
    status: "partial",
    detail: "Import via Reports API → amazon_reimbursements → claim_candidate_drafts generator (explicit dry-run/apply).",
    backend: "amazon_reimbursements / claim_candidate_drafts",
  },
  {
    kind: "settlement",
    label: "Settlement",
    status: "partial",
    detail: "Claimable settlement lines only → claim_candidate_drafts (isSettlementRowClaimableIntake filter).",
    backend: "amazon_settlements / claim_candidate_drafts",
  },
  {
    kind: "inventory",
    label: "Inventory",
    status: "partial",
    detail: "Warehouse QC / inventory discrepancy via scanner issues; full inventory connector TBD.",
    backend: "scanner_operator_issue / warehouse_qc_issue",
  },
  {
    kind: "manual",
    label: "Manual",
    status: "partial",
    detail: "Operator notes and manual draft cases from physical scans; no standalone manual intake form.",
    backend: "returns manual grouping",
  },
];

export function intakeSourcesLiveToday(): ClaimIntakeSourceDef[] {
  return CLAIM_INTAKE_SOURCES.filter((s) => s.status === "live");
}

export function intakeSourcesMissingBackend(): ClaimIntakeSourceDef[] {
  return CLAIM_INTAKE_SOURCES.filter((s) => s.status === "planned" || s.status === "partial");
}
