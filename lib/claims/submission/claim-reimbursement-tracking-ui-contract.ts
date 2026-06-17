/**
 * PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1
 * Client-side filters, labels, and formatting for read-only reimbursement tracking UI.
 */
import {
  REIMBURSEMENT_TRACKING_DEFAULTS,
  type LegacySubmissionVisibility,
  type MatchConfidence,
  type ReimbursementTrackingPreviewRow,
  type ReimbursementTrackingStatus,
  type TrackingSummaryCards,
  buildSummaryCards,
  summarizeMatchConfidence,
  summarizeMoney,
} from "./claim-reimbursement-tracking-preview-v1";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import type { MoneyLaneUiBundle } from "./claim-money-lane-profit-loss-ui-contract";

export const REIMBURSEMENT_TRACKING_UI_VERSION = "claim-reimbursement-tracking-ui-v1" as const;

export const DEFAULT_PILOT_CASE_RUN_ID = REIMBURSEMENT_TRACKING_DEFAULTS.pilot_case_run_id;
export const DEFAULT_INTAKE_RUN_ID = REIMBURSEMENT_TRACKING_DEFAULTS.intake_run_id;

export type ReimbursementTrackingUiPayload = {
  version: typeof REIMBURSEMENT_TRACKING_UI_VERSION;
  generated_at: string;
  pilot_case_run_id: string;
  intake_run_id: string;
  preview_run_reference: string;
  summary_cards: TrackingSummaryCards;
  family_split: {
    removal_shipment_missing: number;
    removal_order_discrepancy: number;
    other: number;
  };
  workflow_counts: WorkflowStageCounts;
  needs_attention: { count: number; top_reason: string };
  match_confidence_summary: Record<MatchConfidence, number>;
  money_summary: ReturnType<typeof summarizeMoney>;
  legacy_visibility: LegacySubmissionVisibility;
  previews: ReimbursementTrackingPreviewRow[];
  money_lane: MoneyLaneUiBundle | null;
  read_only: true;
  not_submitted_to_amazon: true;
};

export type WorkflowStageId =
  | "draft"
  | "ready_for_manual_filing"
  | "filed"
  | "waiting_for_amazon"
  | "reimbursed"
  | "rejected";

export type WorkflowStageCounts = Record<WorkflowStageId, number>;

export const WORKFLOW_STAGES: Array<{
  id: WorkflowStageId;
  label: string;
  description: string;
}> = [
  { id: "draft", label: "Draft", description: "Recorded internally, not filed with Amazon yet." },
  {
    id: "ready_for_manual_filing",
    label: "Ready for manual filing",
    description: "Packet ready — operator files in Seller Central.",
  },
  { id: "filed", label: "Filed", description: "Marked filed; Amazon case ID may still be pending." },
  { id: "waiting_for_amazon", label: "Waiting for Amazon", description: "Submitted — awaiting Amazon response." },
  { id: "reimbursed", label: "Reimbursed", description: "Reimbursement observed or linked." },
  { id: "rejected", label: "Rejected", description: "Amazon rejected or case closed without payout." },
];

export type ReimbursementTrackingFilterState = {
  pilot_case_run_id: string;
  intake_run_id: string;
  family_key_v3: string;
  submission_status: string;
  matched: "" | "matched" | "unmatched";
  needs_follow_up: "" | "yes" | "no";
  money_known: "" | "known" | "unknown";
  match_confidence: MatchConfidence | "";
  date_from: string;
  date_to: string;
  search: string;
};

export const DEFAULT_REIMBURSEMENT_TRACKING_FILTERS: ReimbursementTrackingFilterState = {
  pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
  intake_run_id: DEFAULT_INTAKE_RUN_ID,
  family_key_v3: "",
  submission_status: "",
  matched: "",
  needs_follow_up: "",
  money_known: "",
  match_confidence: "",
  date_from: "",
  date_to: "",
  search: "",
};

export const REIMBURSEMENT_TRACKING_DISABLED_ACTIONS = [
  { id: "submit_amazon", label: "Submit to Amazon" },
  { id: "mark_reimbursed", label: "Mark reimbursed" },
  { id: "edit_submission", label: "Edit submission" },
  { id: "close_case", label: "Close case" },
  { id: "upload", label: "Upload evidence" },
] as const;

export const REIMBURSEMENT_TRACKING_READ_ONLY_TOOLTIP =
  "Disabled in read-only financial tracking preview." as const;

const STATUS_LABELS: Record<ReimbursementTrackingStatus, string> = {
  draft_not_filed: "Draft — not filed",
  ready_for_manual_filing: "Ready for manual filing",
  manually_filed_pending_external_id: "Filed — pending case ID",
  filed_waiting_for_amazon: "Waiting for Amazon",
  reimbursed: "Reimbursed",
  partially_reimbursed: "Partially reimbursed",
  rejected: "Rejected",
  evidence_requested: "Evidence requested",
  needs_follow_up: "Needs follow-up",
  closed_no_reimbursement: "Closed — no reimbursement",
};

const STATUS_TONES: Record<ReimbursementTrackingStatus, string> = {
  draft_not_filed: "neutral",
  ready_for_manual_filing: "info",
  manually_filed_pending_external_id: "info",
  filed_waiting_for_amazon: "warning",
  reimbursed: "success",
  partially_reimbursed: "success",
  rejected: "danger",
  evidence_requested: "warning",
  needs_follow_up: "warning",
  closed_no_reimbursement: "neutral",
};

const FAMILY_TONES: Record<string, string> = {
  removal_shipment_missing: "violet",
  removal_order_discrepancy: "sky",
};

export function reimbursementTrackingStatusLabel(status: ReimbursementTrackingStatus): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

export function reimbursementTrackingStatusTone(status: ReimbursementTrackingStatus): string {
  return STATUS_TONES[status] ?? "neutral";
}

export function familyTone(family: string | null | undefined): string {
  if (!family) return "neutral";
  return FAMILY_TONES[family] ?? "neutral";
}

export function formatTrackingMoney(value: number | null | undefined, currency = "USD"): string {
  if (value == null) return "Unknown";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(
    value,
  );
}

export function shortId(id: string | null | undefined, len = 8): string {
  const s = (id ?? "").trim();
  if (!s) return "—";
  return s.length <= len ? s : `${s.slice(0, len)}…`;
}

export function mapTrackingStatusToWorkflowStage(status: ReimbursementTrackingStatus): WorkflowStageId {
  switch (status) {
    case "draft_not_filed":
      return "draft";
    case "ready_for_manual_filing":
      return "ready_for_manual_filing";
    case "manually_filed_pending_external_id":
      return "filed";
    case "filed_waiting_for_amazon":
    case "evidence_requested":
    case "needs_follow_up":
      return "waiting_for_amazon";
    case "reimbursed":
    case "partially_reimbursed":
      return "reimbursed";
    case "rejected":
    case "closed_no_reimbursement":
      return "rejected";
    default:
      return "draft";
  }
}

export function buildWorkflowStageCounts(previews: ReimbursementTrackingPreviewRow[]): WorkflowStageCounts {
  const out: WorkflowStageCounts = {
    draft: 0,
    ready_for_manual_filing: 0,
    filed: 0,
    waiting_for_amazon: 0,
    reimbursed: 0,
    rejected: 0,
  };
  for (const p of previews) {
    out[mapTrackingStatusToWorkflowStage(p.reimbursement_tracking_status)] += 1;
  }
  return out;
}

export function pickHighlightedWorkflowStage(counts: WorkflowStageCounts): WorkflowStageId {
  const order: WorkflowStageId[] = [
    "draft",
    "ready_for_manual_filing",
    "filed",
    "waiting_for_amazon",
    "reimbursed",
    "rejected",
  ];
  for (const stage of order) {
    if (counts[stage] > 0) return stage;
  }
  return "draft";
}

export function buildFamilySplit(previews: ReimbursementTrackingPreviewRow[]) {
  let removal_shipment_missing = 0;
  let removal_order_discrepancy = 0;
  let other = 0;
  for (const p of previews) {
    const fam = (p.family_key_v3 ?? p.claim_family ?? "").toLowerCase();
    if (fam.includes("removal_shipment_missing")) removal_shipment_missing += 1;
    else if (fam.includes("removal_order_discrepancy")) removal_order_discrepancy += 1;
    else other += 1;
  }
  return { removal_shipment_missing, removal_order_discrepancy, other };
}

export function buildNeedsAttentionSummary(previews: ReimbursementTrackingPreviewRow[]): {
  count: number;
  top_reason: string;
} {
  const reasons = new Map<string, number>();
  let count = 0;
  for (const p of previews) {
    if (!p.follow_up_needed && p.money_warnings.length === 0 && p.linked_reimbursement_count > 0) continue;
    count += 1;
    if (p.linked_reimbursement_count === 0) {
      reasons.set("No reimbursement match", (reasons.get("No reimbursement match") ?? 0) + 1);
    }
    if (p.money_warnings.length > 0) {
      reasons.set("Missing money lanes", (reasons.get("Missing money lanes") ?? 0) + 1);
    }
    if (p.reimbursement_tracking_status === "draft_not_filed") {
      reasons.set("Not filed yet", (reasons.get("Not filed yet") ?? 0) + 1);
    }
    if (p.reimbursement_tracking_status === "ready_for_manual_filing") {
      reasons.set("Ready for manual filing", (reasons.get("Ready for manual filing") ?? 0) + 1);
    }
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
  return { count, top_reason: top?.[0] ?? "None" };
}

export function deriveNextAction(row: ReimbursementTrackingPreviewRow): string {
  if (row.money_warnings.length > 0 && (row.estimated_amount == null || row.recovery_value == null)) {
    return "Money data incomplete — review COGS/fees";
  }
  switch (row.reimbursement_tracking_status) {
    case "ready_for_manual_filing":
      return "Ready for manual filing";
    case "manually_filed_pending_external_id":
      return "Enter Amazon case ID after filing";
    case "filed_waiting_for_amazon":
    case "evidence_requested":
      return "Waiting for reimbursement match";
    case "needs_follow_up":
      return "Needs follow-up";
    case "reimbursed":
    case "partially_reimbursed":
      return "No action needed";
    case "rejected":
    case "closed_no_reimbursement":
      return "Needs follow-up";
    case "draft_not_filed":
      return row.linked_reimbursement_count === 0
        ? "Waiting for reimbursement match"
        : "Ready for manual filing";
    default:
      return "Needs follow-up";
  }
}

export function extractSourceTrackingLabel(row: ReimbursementTrackingPreviewRow): string {
  const lines = row.detail_preview.reference_graph_lines;
  const tracking = lines.find((l) => l.kind.toLowerCase().includes("tracking"))?.value;
  const removalShipment = lines.find((l) => l.kind.toLowerCase().includes("removal_shipment"))?.value;
  const removalOrder = lines.find((l) => l.kind.toLowerCase().includes("removal_order"))?.value;
  return tracking ?? removalShipment ?? removalOrder ?? row.source_event_key ?? "—";
}

export function moneyLanesKnown(row: ReimbursementTrackingPreviewRow): boolean {
  return row.estimated_amount != null || row.recovery_value != null;
}

export function hasPartialMoneyData(previews: ReimbursementTrackingPreviewRow[]): boolean {
  const withEst = previews.filter((p) => p.estimated_amount != null || p.recovery_value != null).length;
  return withEst > 0 && withEst < previews.length;
}

export function referenceGraphVerified(row: ReimbursementTrackingPreviewRow): boolean {
  const lines = row.detail_preview.reference_graph_lines;
  return lines.length > 0;
}

export function referenceGraphTridWarning(row: ReimbursementTrackingPreviewRow): string | null {
  const tridLine = row.detail_preview.reference_graph_lines.find((l) =>
    l.kind.toLowerCase().includes("trid"),
  );
  const epLine = row.detail_preview.reference_graph_lines.find((l) =>
    l.kind.toLowerCase().includes("expected_package"),
  );
  if (!tridLine && epLine) {
    return "Product-link TRID is absent — EP anchor is used for reference graph.";
  }
  return null;
}

export function reimbursementTrackingApiParams(
  filters: ReimbursementTrackingFilterState,
): Record<string, string> {
  const params: Record<string, string> = {
    pilot_case_run_id: filters.pilot_case_run_id,
    intake_run_id: filters.intake_run_id,
  };
  return params;
}

export function filterReimbursementTrackingRows(
  rows: ReimbursementTrackingPreviewRow[],
  filters: ReimbursementTrackingFilterState,
): ReimbursementTrackingPreviewRow[] {
  const q = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.family_key_v3 && (row.family_key_v3 ?? row.claim_family) !== filters.family_key_v3) {
      return false;
    }
    if (filters.submission_status && (row.submission_status ?? "") !== filters.submission_status) {
      return false;
    }
    if (filters.matched === "matched" && row.linked_reimbursement_count === 0) return false;
    if (filters.matched === "unmatched" && row.linked_reimbursement_count > 0) return false;
    if (filters.needs_follow_up === "yes" && !row.follow_up_needed) return false;
    if (filters.needs_follow_up === "no" && row.follow_up_needed) return false;
    if (filters.money_known === "known" && !moneyLanesKnown(row)) return false;
    if (filters.money_known === "unknown" && moneyLanesKnown(row)) return false;
    if (filters.match_confidence && row.match_confidence !== filters.match_confidence) return false;
    if (filters.date_from && (row.source_event_date ?? "") < filters.date_from) return false;
    if (filters.date_to && (row.source_event_date ?? "") > filters.date_to) return false;
    if (!q) return true;
    const hay = [
      row.claim_case_id,
      row.claim_submission_id,
      row.asin,
      row.fnsku,
      row.sku,
      row.source_event_key,
      extractSourceTrackingLabel(row),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function buildReimbursementTrackingUiPayload(args: {
  pilot_case_run_id: string;
  intake_run_id: string;
  previews: ReimbursementTrackingPreviewRow[];
  legacy_visibility: LegacySubmissionVisibility;
  preview_run_reference?: string;
  money_lane?: MoneyLaneUiBundle | null;
}): ReimbursementTrackingUiPayload {
  const previews = args.previews;
  return {
    version: REIMBURSEMENT_TRACKING_UI_VERSION,
    generated_at: new Date().toISOString(),
    pilot_case_run_id: args.pilot_case_run_id,
    intake_run_id: args.intake_run_id,
    preview_run_reference: args.preview_run_reference ?? "phase-claim-reimbursement-tracking-preview-v1",
    summary_cards: buildSummaryCards(previews),
    family_split: buildFamilySplit(previews),
    workflow_counts: buildWorkflowStageCounts(previews),
    needs_attention: buildNeedsAttentionSummary(previews),
    match_confidence_summary: summarizeMatchConfidence(previews),
    money_summary: summarizeMoney(previews),
    legacy_visibility: args.legacy_visibility,
    previews,
    money_lane: args.money_lane ?? null,
    read_only: true,
    not_submitted_to_amazon: true,
  };
}

export function activeFilterChips(
  filters: ReimbursementTrackingFilterState,
): Array<{ key: keyof ReimbursementTrackingFilterState; label: string }> {
  const chips: Array<{ key: keyof ReimbursementTrackingFilterState; label: string }> = [];
  if (filters.family_key_v3) chips.push({ key: "family_key_v3", label: `Family: ${filters.family_key_v3}` });
  if (filters.submission_status) {
    chips.push({ key: "submission_status", label: `Status: ${filters.submission_status}` });
  }
  if (filters.matched) chips.push({ key: "matched", label: filters.matched === "matched" ? "Matched" : "Unmatched" });
  if (filters.needs_follow_up === "yes") chips.push({ key: "needs_follow_up", label: "Needs follow-up" });
  if (filters.money_known) {
    chips.push({
      key: "money_known",
      label: filters.money_known === "known" ? "Money known" : "Money unknown",
    });
  }
  if (filters.match_confidence) {
    chips.push({ key: "match_confidence", label: `Confidence: ${filters.match_confidence}` });
  }
  if (filters.date_from) chips.push({ key: "date_from", label: `From ${filters.date_from}` });
  if (filters.date_to) chips.push({ key: "date_to", label: `To ${filters.date_to}` });
  if (filters.search.trim()) chips.push({ key: "search", label: `Search: ${filters.search.trim()}` });
  return chips;
}

export const REIMBURSEMENT_TRACKING_PAGE_CONTRACT = getClaimCenterV2Page("reimbursement_tracking");
