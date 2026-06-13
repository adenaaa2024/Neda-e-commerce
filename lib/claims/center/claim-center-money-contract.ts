import type { ClaimCenterV1Row, ClaimCenterV1StatusGroup } from "./claim-center-v1-types";
import { filterFindMoneyRows } from "./claim-center-queue-semantics";

/** Approved money display contract — PHASE-CLAIM-MONEY-RECOVERY-DATA-CONTRACT-AUDIT */
export type ClaimCenterExposureBasis = "cogs_formula" | "report_amount" | "zero_unpriced" | "unknown";

export type ClaimCenterMoneyKpis = {
  /** Sum of recovery_value where NOT NULL and > 0 (recoverable status groups). */
  potential_recovery_known_usd: number;
  /** Rows with null recovery_value in recoverable statuses. */
  potential_recovery_unknown_count: number;
  /** recovery_value = 0 and cogs_unit IS NULL — priced as zero but COGS missing. */
  zero_unpriced_count: number;
  /** Known expected amount not yet filed/reimbursed/rejected/expired. */
  open_exposure_known_usd: number;
  observed_filed_count: number;
  observed_reimbursed_count: number;
  /** Only set when observed rows carry a known reimbursement amount (future join). */
  observed_reimbursed_usd: number | null;
  financial_links_present: boolean;
};

export const CLAIM_CENTER_MONEY_TOOLTIPS = {
  potential_recovery:
    "Sum of expected recovery where intake resolved a positive amount. Excludes unknown COGS/report amounts.",
  open_exposure:
    "Known expected recovery still open — not observed filed, reimbursed, rejected, or expired.",
  observed_reimbursement:
    "Count from imported or external case status. Dollar total appears when reimbursement rows are linked.",
  unknown_review: "Opportunities without COGS or report amount at intake — review before trusting totals.",
} as const;

const RECOVERABLE_STATUSES = new Set<ClaimCenterV1StatusGroup>([
  "new",
  "needs_review",
  "evidence_ready",
  "blocked_product_link",
  "blocked_reference_conflict",
  "ready_to_file",
]);

const CLOSED_STATUSES = new Set<ClaimCenterV1StatusGroup>([
  "filed",
  "reimbursed",
  "rejected",
  "expired",
]);

const SOURCE_KIND_PRIORITY: Record<string, number> = {
  orbit_fra: 0,
  scanner_physical_review: 1,
};

export function classifyExposureBasis(row: ClaimCenterV1Row): ClaimCenterExposureBasis {
  if (row.recovery_value == null) return "unknown";
  if (row.recovery_value === 0 && (row.cogs_unit == null || row.cogs_unit === 0)) return "zero_unpriced";
  if (row.cogs_unit != null && row.cogs_unit > 0) return "cogs_formula";
  return "report_amount";
}

export function formatExposureLabel(row: ClaimCenterV1Row): string {
  if (row.money_display?.amount_display_label) return row.money_display.amount_display_label;
  const basis = classifyExposureBasis(row);
  if (basis === "unknown") return "Cost unknown";
  if (basis === "zero_unpriced") return "Unpriced — add cost to see recovery";
  const v = row.recovery_value;
  if (v == null) return "Amount needs review";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: row.currency ?? "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

export function formatKnownUsd(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function aggregateClaimCenterMoney(rows: ClaimCenterV1Row[]): ClaimCenterMoneyKpis {
  let potentialKnown = 0;
  let unknownCount = 0;
  let zeroUnpriced = 0;
  let openExposure = 0;
  let observedFiled = 0;
  let observedReimbursed = 0;

  for (const r of rows) {
    if (r.v1_status_group === "filed") observedFiled += 1;
    if (r.v1_status_group === "reimbursed") observedReimbursed += 1;

    if (!RECOVERABLE_STATUSES.has(r.v1_status_group)) continue;

    const rv = r.recovery_value;
    const basis = classifyExposureBasis(r);

    if (basis === "unknown") {
      unknownCount += 1;
    } else if (basis === "zero_unpriced") {
      zeroUnpriced += 1;
    } else if (rv != null && rv > 0) {
      potentialKnown += rv;
      if (!CLOSED_STATUSES.has(r.v1_status_group)) {
        openExposure += rv;
      }
    }
  }

  return {
    potential_recovery_known_usd: Math.round(potentialKnown * 100) / 100,
    potential_recovery_unknown_count: unknownCount,
    zero_unpriced_count: zeroUnpriced,
    open_exposure_known_usd: Math.round(openExposure * 100) / 100,
    observed_filed_count: observedFiled,
    observed_reimbursed_count: observedReimbursed,
    observed_reimbursed_usd: null,
    financial_links_present: observedFiled > 0 || observedReimbursed > 0,
  };
}

/** Prefer orbit_fra over scanner_physical_review per physical source row. */
export function dedupeCandidatesForDisplay(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  const byKey = new Map<string, ClaimCenterV1Row>();
  for (const row of rows) {
    const key = `${row.source_table}:${row.source_row_id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const a = SOURCE_KIND_PRIORITY[row.source_kind ?? ""] ?? 5;
    const b = SOURCE_KIND_PRIORITY[existing.source_kind ?? ""] ?? 5;
    if (a < b) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function blockerScore(row: ClaimCenterV1Row): number {
  if (row.v1_status_group === "blocked_reference_conflict") return 4;
  if (row.v1_status_group === "blocked_product_link") return 3;
  if (row.evidence_status === "missing") return 2;
  if (row.canonical_window.status === "closing_soon") return 5;
  if (row.canonical_window.status === "expired") return 1;
  return 0;
}

function deadlineSortKey(row: ClaimCenterV1Row): number {
  const days = row.canonical_window.days_remaining;
  if (days == null) return 99999;
  if (row.canonical_window.status === "expired") return 100000;
  return days;
}

/** Attention list: twin-grouped Find Money rows, ranked by deadline then exposure. */
export function buildAttentionList(rows: ClaimCenterV1Row[], limit = 8): ClaimCenterV1Row[] {
  const deduped = filterFindMoneyRows(rows);
  return [...deduped]
    .sort((a, b) => {
      const deadlineA = deadlineSortKey(a);
      const deadlineB = deadlineSortKey(b);
      if (deadlineA !== deadlineB) return deadlineA - deadlineB;
      const expA = a.recovery_value != null && a.recovery_value > 0 ? a.recovery_value : -1;
      const expB = b.recovery_value != null && b.recovery_value > 0 ? b.recovery_value : -1;
      if (expB !== expA) return expB - expA;
      return blockerScore(b) - blockerScore(a);
    })
    .slice(0, limit);
}

export function humanCandidateLabel(row: ClaimCenterV1Row): string {
  const id =
    row.product_linkage?.fallback_display_name ??
    row.fnsku ??
    row.sku ??
    row.asin ??
    row.claim_family?.replace(/_/g, " ");
  return id ?? "Recovery opportunity";
}

export function attentionNextStepLabel(row: ClaimCenterV1Row): string {
  if (row.v1_status_group === "blocked_product_link") return "Fix product match";
  if (row.v1_status_group === "blocked_reference_conflict") return "Review references";
  if (row.evidence_status === "missing") return "Check proof gaps";
  if (row.v1_status_group === "ready_to_file") return "Verify before filing";
  return "Open story";
}
