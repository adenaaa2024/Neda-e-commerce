/**
 * PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1
 * Read-only UI contract for Claim Center preview generator list.
 */
import type {
  FirstSafeFamiliesPreviewGeneratorsPayload,
  PreviewGeneratorItem,
  PreviewRecommendedAction,
} from "@/lib/claims/center/claim-first-safe-families-preview-generators-v1";
import type { ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";
import {
  FAMILY_FILTER_OPTIONS,
  SOURCE_KIND_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
} from "@/lib/claims/grouping/claim-grouping-ui-contract";

export const CLAIM_PREVIEW_GENERATORS_UI_VERSION = "claim-preview-generators-ui-v1" as const;

export type ClaimPreviewGeneratorsFilterState = {
  family_key: string;
  status: PreviewRecommendedAction | "";
  product_query: string;
  source_kind: string;
  date_from: string;
  date_to: string;
  claim_ready_only: boolean;
  needs_review_only: boolean;
};

export const DEFAULT_PREVIEW_GENERATORS_FILTER_STATE: ClaimPreviewGeneratorsFilterState = {
  family_key: "",
  status: "",
  product_query: "",
  source_kind: "",
  date_from: "",
  date_to: "",
  claim_ready_only: false,
  needs_review_only: false,
};

export const PREVIEW_GENERATORS_FAMILY_OPTIONS = FAMILY_FILTER_OPTIONS;
export const PREVIEW_GENERATORS_STATUS_OPTIONS = STATUS_FILTER_OPTIONS;
export const PREVIEW_GENERATORS_SOURCE_OPTIONS = SOURCE_KIND_FILTER_OPTIONS;

export const PREVIEW_GENERATORS_DISABLED_ACTIONS = [
  { id: "emit_candidates", label: "Emit candidates" },
  { id: "create_case", label: "Create case" },
  { id: "submit_claim", label: "Submit claim" },
] as const;

export type PreviewGeneratorBadgeId =
  | "date_gated"
  | "needs_review"
  | "disputed_excluded"
  | "missing_fee"
  | "missing_cost";

export const PREVIEW_GENERATOR_BADGE_LABELS: Record<PreviewGeneratorBadgeId, string> = {
  date_gated: "Date gated",
  needs_review: "Needs review",
  disputed_excluded: "Disputed excluded",
  missing_fee: "Missing fee",
  missing_cost: "Missing cost",
};

export function previewGeneratorBadges(item: PreviewGeneratorItem): PreviewGeneratorBadgeId[] {
  const badges: PreviewGeneratorBadgeId[] = [];
  if (!item.date_gate_passed || item.pre_cutoff || item.missing_event_date) {
    badges.push("date_gated");
  }
  if (item.recommended_action === "needs_review") badges.push("needs_review");
  if (item.review_flags.includes("disputed_source_row")) badges.push("disputed_excluded");
  if (item.review_flags.includes("fee_payout_unavailable")) badges.push("missing_fee");
  if (item.review_flags.includes("cogs_unavailable")) badges.push("missing_cost");
  return badges;
}

function str(v: string | null | undefined): string {
  return String(v ?? "").trim();
}

function eventDate(item: PreviewGeneratorItem): string {
  return str(item.source_event_date ?? item.event_date);
}

function matchesProductQuery(item: PreviewGeneratorItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    item.product_id,
    item.asin,
    item.fnsku,
    item.sku,
    item.identifiers?.asin,
    item.identifiers?.fnsku,
    item.identifiers?.sku,
  ]
    .map((v) => str(v).toLowerCase())
    .filter(Boolean);
  return hay.some((h) => h.includes(q));
}

function matchesDateRange(item: PreviewGeneratorItem, from: string, to: string): boolean {
  const d = eventDate(item);
  if (!d) return !from && !to;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

export function filterPreviewGeneratorItems(
  items: PreviewGeneratorItem[],
  filters: ClaimPreviewGeneratorsFilterState,
): PreviewGeneratorItem[] {
  return items.filter((item) => {
    if (filters.family_key && item.family_key !== filters.family_key) return false;
    if (filters.source_kind && item.source_kind !== (filters.source_kind as ClaimSourceKind)) return false;

    if (filters.claim_ready_only && item.recommended_action !== "claim_ready") return false;
    if (filters.needs_review_only && item.recommended_action !== "needs_review") return false;
    if (filters.status && item.recommended_action !== filters.status) return false;

    if (!matchesProductQuery(item, filters.product_query)) return false;
    if (!matchesDateRange(item, filters.date_from, filters.date_to)) return false;
    return true;
  });
}

export function summarizeFilteredPreviews(items: PreviewGeneratorItem[]) {
  const byFamily: Record<string, { total: number; claim_ready: number; needs_review: number; unavailable: number }> =
    {};
  let claim_ready = 0;
  let needs_review = 0;
  let unavailable = 0;

  for (const item of items) {
    const fam = item.family_key;
    if (!byFamily[fam]) {
      byFamily[fam] = { total: 0, claim_ready: 0, needs_review: 0, unavailable: 0 };
    }
    byFamily[fam]!.total += 1;
    if (item.recommended_action === "claim_ready") {
      claim_ready += 1;
      byFamily[fam]!.claim_ready += 1;
    } else if (item.recommended_action === "needs_review") {
      needs_review += 1;
      byFamily[fam]!.needs_review += 1;
    } else {
      unavailable += 1;
      byFamily[fam]!.unavailable += 1;
    }
  }

  return {
    total_previews: items.length,
    claim_ready,
    needs_review,
    unavailable,
    by_family: byFamily,
  };
}

export function buildGroupBuilderHref(previewIds: string[]): string {
  if (!previewIds.length) return "/claim-center/group-builder";
  const params = new URLSearchParams();
  params.set("preview_ids", previewIds.join(","));
  params.set("grouping_mode", "manual_selection_preview");
  params.set("include_needs_review", "true");
  return `/claim-center/group-builder?${params.toString()}`;
}

export function previewGeneratorsApiParams(filters: ClaimPreviewGeneratorsFilterState): Record<string, string> {
  const params: Record<string, string> = { limit: "200" };
  if (filters.date_from) params.from = filters.date_from;
  if (filters.date_to) params.to = filters.date_to;
  return params;
}

export function formatPreviewMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function actionLabel(action: PreviewRecommendedAction): string {
  if (action === "claim_ready") return "Claim ready";
  if (action === "needs_review") return "Needs review";
  return "Unavailable";
}

export type PreviewGeneratorsTableColumn =
  | "preview_id"
  | "family_key"
  | "recommended_action"
  | "product"
  | "source_kind"
  | "source_event_key"
  | "quantity"
  | "observed_reimbursement"
  | "estimated_amazon_payout"
  | "internal_cost_loss"
  | "source_event_date"
  | "date_gate_passed"
  | "confidence"
  | "review_flags";

export const PREVIEW_GENERATORS_TABLE_COLUMNS: PreviewGeneratorsTableColumn[] = [
  "preview_id",
  "family_key",
  "recommended_action",
  "product",
  "source_kind",
  "source_event_key",
  "quantity",
  "observed_reimbursement",
  "estimated_amazon_payout",
  "internal_cost_loss",
  "source_event_date",
  "date_gate_passed",
  "confidence",
  "review_flags",
];

export function extractPayloadSummary(payload: FirstSafeFamiliesPreviewGeneratorsPayload | null) {
  if (!payload) return null;
  return {
    api_family_counts: payload.family_counts,
    api_generator_results: payload.preview_generator_results,
    date_gate_summary: payload.date_gate_summary,
    read_only: payload.read_only,
    no_db_writes: payload.no_db_writes,
    generated_at: payload.generated_at,
  };
}
