import type { ClaimCenterV1Row } from "./claim-center-v1-types";
import { classifyExposureBasis } from "./claim-center-money-contract";

export type ClaimCenterAmountBasis =
  | "cogs_formula"
  | "report_amount"
  | "unknown"
  | "zero_unpriced"
  | "observed_reimbursement";

export type ClaimCenterAmountConfidence = "high" | "medium" | "low" | "unknown";

export type ClaimCenterCandidateMoney = {
  expected_recovery_value: number | null;
  expected_amount_report: number | null;
  cogs_unit_snapshot: number | null;
  amount_basis: ClaimCenterAmountBasis;
  amount_confidence: ClaimCenterAmountConfidence;
  amount_display_label: string;
  amount_tooltip: string;
  cost_unknown: boolean;
  zero_unpriced: boolean;
  /** Latest listing/sale observation — context only, never used as cost. */
  latest_sale_price_context: number | null;
};

const TOOLTIP_UNKNOWN = "Unit cost was not available at intake — not $0 recovery.";
const TOOLTIP_ZERO = "Recovery is unpriced until unit cost is added — not confirmed zero.";
const TOOLTIP_COGS = "Expected recovery from units × COGS at intake.";
const TOOLTIP_REPORT = "Expected recovery from report amount at intake.";
const TOOLTIP_OBSERVED = "Observed reimbursement or external case status — not intake estimate.";

function formatUsd(v: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(v);
}

function confidenceForBasis(basis: ClaimCenterAmountBasis, row: ClaimCenterV1Row): ClaimCenterAmountConfidence {
  if (basis === "observed_reimbursement") return "high";
  if (basis === "unknown") return "unknown";
  if (basis === "zero_unpriced") return "low";
  if (basis === "cogs_formula") {
    return row.cogs_unit != null && row.cogs_unit > 0 ? "medium" : "low";
  }
  return row.recovery_value != null && row.recovery_value > 0 ? "medium" : "low";
}

export function buildCandidateMoneyProjection(row: ClaimCenterV1Row): ClaimCenterCandidateMoney {
  if (row.v1_status_group === "reimbursed" || row.v1_status_group === "filed") {
    const rv = row.recovery_value;
    return {
      expected_recovery_value: rv,
      expected_amount_report: rv,
      cogs_unit_snapshot: row.cogs_unit,
      amount_basis: "observed_reimbursement",
      amount_confidence: "high",
      amount_display_label: rv != null && rv > 0 ? formatUsd(rv, row.currency ?? "USD") : "Observed (no amount)",
      amount_tooltip: TOOLTIP_OBSERVED,
      cost_unknown: false,
      zero_unpriced: false,
      latest_sale_price_context: null,
    };
  }

  const basis = classifyExposureBasis(row);
  const currency = row.currency ?? "USD";
  const rv = row.recovery_value;

  let amount_basis: ClaimCenterAmountBasis = basis;
  let amount_display_label: string;
  let amount_tooltip: string;

  switch (basis) {
    case "unknown":
      amount_display_label = "Cost unknown";
      amount_tooltip = TOOLTIP_UNKNOWN;
      break;
    case "zero_unpriced":
      amount_display_label = "Unpriced — add cost to see recovery";
      amount_tooltip = TOOLTIP_ZERO;
      break;
    case "cogs_formula":
      amount_display_label = rv != null && rv > 0 ? formatUsd(rv, currency) : "Amount needs review";
      amount_tooltip = TOOLTIP_COGS;
      break;
    case "report_amount":
      amount_display_label = rv != null && rv > 0 ? formatUsd(rv, currency) : "Amount needs review";
      amount_tooltip = TOOLTIP_REPORT;
      break;
    default:
      amount_display_label = "Amount needs review";
      amount_tooltip = TOOLTIP_UNKNOWN;
  }

  return {
    expected_recovery_value: rv != null && rv > 0 ? rv : null,
    expected_amount_report: basis === "report_amount" && rv != null ? rv : null,
    cogs_unit_snapshot: row.cogs_unit,
    amount_basis,
    amount_confidence: confidenceForBasis(amount_basis, row),
    amount_display_label,
    amount_tooltip,
    cost_unknown: amount_basis === "unknown",
    zero_unpriced: amount_basis === "zero_unpriced",
    latest_sale_price_context: null,
  };
}

export function attachMoneyProjections(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  return rows.map((row) => ({
    ...row,
    money_display: buildCandidateMoneyProjection(row),
  }));
}
