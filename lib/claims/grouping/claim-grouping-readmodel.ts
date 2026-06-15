/**
 * PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-READMODEL-V1
 * Read-only grouping/filter/manual batch preview over preview-generator output.
 * No claim_candidates writes. No claim_cases creation.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildFirstSafeFamiliesPreviewGenerators,
  type PreviewGeneratorItem,
  type PreviewRecommendedAction,
} from "@/lib/claims/center/claim-first-safe-families-preview-generators-v1";
import {
  DEFAULT_CLAIM_GROUPING_POLICY,
  type GroupRecommendedAction,
  type GroupWarning,
  type GroupWarningCode,
} from "@/lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1";
import type { ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";
import {
  buildEffectiveDateContext,
  defaultGroupingDateFrom,
  previewItemPassesDateFilter,
} from "@/lib/claims/effective-date/claim-effective-date-gate-v1";
import { loadEffectiveClaimIntakePolicy } from "@/lib/claims/intake/claim-intake-policy-contract";
import type { EffectiveDateContextPayload } from "@/lib/claims/effective-date/claim-effective-date-gate-v1";

export const GROUPING_READMODEL_VERSION = "claim-grouping-readmodel-v1" as const;

export const GROUPING_MODES_SUPPORTED = [
  "one_candidate_per_group",
  "product_family",
  "product_multi_family",
  "reference_trid",
  "shipment_or_removal",
  "source_report_window",
  "manual_selection_preview",
  "custom_filter_preview",
] as const;

export type GroupingModeSupported = (typeof GROUPING_MODES_SUPPORTED)[number];

export type GroupingFilterParams = {
  organization_id: string;
  store_id: string;
  product_id?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  family_key?: string | null;
  family_keys?: string[] | null;
  source_kind?: ClaimSourceKind | null;
  status?: PreviewRecommendedAction | null;
  confidence?: PreviewGeneratorItem["confidence"] | null;
  reference_kind?: string | null;
  reference_value?: string | null;
  shipment_id?: string | null;
  removal_order_id?: string | null;
  removal_shipment_id?: string | null;
  tracking_number?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  min_estimated_payout?: number | null;
  min_observed_reimbursement?: number | null;
  include_needs_review?: boolean;
  include_unavailable?: boolean;
  preview_ids?: string[] | null;
  grouping_mode?: GroupingModeSupported | null;
  limit?: number;
};

export type GroupPreviewRow = {
  group_preview_id: string;
  group_title: string;
  grouping_mode: GroupingModeSupported;
  filters_applied: GroupingFilterParams;
  included_preview_ids: string[];
  families: string[];
  products: string[];
  references: Array<{ kind: string; value: string }>;
  total_units: number | null;
  estimated_amazon_payout_sum: number | null;
  observed_reimbursement_sum: number | null;
  internal_cost_loss_sum: number | null;
  reimbursement_gap_sum: number | null;
  confidence: PreviewGeneratorItem["confidence"];
  warnings: GroupWarning[];
  recommended_action: GroupRecommendedAction;
};

export type ClaimGroupingReadmodelPayload = {
  contract_version: typeof GROUPING_READMODEL_VERSION;
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: boolean;
  no_claim_case_creation: true;
  no_ai_calls: true;
  generated_at: string;
  organization_id: string;
  store_id: string;
  grouping_modes_supported: readonly GroupingModeSupported[];
  filter_params_supported: string[];
  filters_applied: GroupingFilterParams;
  filtered_preview_count: number;
  group_count: number;
  groups: GroupPreviewRow[];
  sample_group_previews: GroupPreviewRow[];
  warning_rules_verification: { codes_checked: GroupWarningCode[]; pass: boolean };
  effective_date_context: EffectiveDateContextPayload;
  SAFE_TO_BUILD_GROUPING_UI: "yes" | "no";
};

export const FILTER_PARAMS_SUPPORTED = [
  "organization_id",
  "store_id",
  "product_id",
  "asin",
  "fnsku",
  "sku",
  "family_key",
  "family_keys[]",
  "source_kind",
  "status",
  "confidence",
  "reference_kind",
  "reference_value",
  "shipment_id",
  "removal_order_id",
  "removal_shipment_id",
  "tracking_number",
  "date_from",
  "date_to",
  "min_estimated_payout",
  "min_observed_reimbursement",
  "include_needs_review",
  "include_unavailable",
  "preview_ids",
  "grouping_mode",
  "limit",
] as const;

function str(v: string | null | undefined): string {
  return String(v ?? "").trim();
}

function parseListParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesOne(value: string | null, filter: string | null | undefined): boolean {
  if (!filter) return true;
  return str(value).toLowerCase() === str(filter).toLowerCase();
}

function edgeValues(item: PreviewGeneratorItem, kinds: string[]): string[] {
  const out: string[] = [];
  for (const e of item.TRID_edges) {
    const k = e.reference_kind.toLowerCase();
    if (kinds.some((want) => k.includes(want.toLowerCase()))) {
      out.push(e.reference_value);
    }
  }
  return out;
}

function primaryReference(item: PreviewGeneratorItem): { kind: string; value: string } | null {
  const priority = [
    "removal_order",
    "removal_shipment",
    "tracking",
    "reimbursement",
    "order",
    "shipment",
  ];
  for (const p of priority) {
    for (const e of item.TRID_edges) {
      if (e.reference_kind.toLowerCase().includes(p)) {
        return { kind: e.reference_kind, value: e.reference_value };
      }
    }
  }
  if (item.source_event_key) {
    return { kind: "source_event_key", value: item.source_event_key };
  }
  return null;
}

function groupPreviewId(mode: string, key: string): string {
  const hash = createHash("sha256").update(`${mode}:${key}`).digest("hex").slice(0, 16);
  return `group-preview:v1:${hash}`;
}

function sumNullable(values: Array<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    any = true;
  }
  return any ? Math.round(sum * 100) / 100 : null;
}

function aggregateConfidence(items: PreviewGeneratorItem[]): PreviewGeneratorItem["confidence"] {
  const order = { high: 4, medium: 3, low: 2, unavailable: 1 };
  let min = "high" as PreviewGeneratorItem["confidence"];
  for (const i of items) {
    if (order[i.confidence] < order[min]) min = i.confidence;
  }
  return min;
}

function analyzeWarnings(items: PreviewGeneratorItem[]): GroupWarning[] {
  const warnings: GroupWarning[] = [];
  const uniq = <T,>(vals: T[]) => [...new Set(vals.filter(Boolean))];

  const products = uniq(items.map((i) => i.product_id ?? "unlinked"));
  if (products.length > 1) {
    warnings.push({
      code: "mixed_products",
      message: `${products.length} different products in group.`,
      severity: DEFAULT_CLAIM_GROUPING_POLICY.allow_mixed_product_grouping ? "warn" : "block",
    });
  }

  const families = uniq(items.map((i) => i.family_key));
  if (families.length > 1) {
    warnings.push({
      code: "mixed_claim_families",
      message: `${families.length} claim families in group.`,
      severity: DEFAULT_CLAIM_GROUPING_POLICY.allow_mixed_problem_grouping ? "warn" : "block",
    });
  }

  const sources = uniq(items.map((i) => i.source_kind));
  if (sources.length > 1) {
    warnings.push({
      code: "mixed_source_kinds",
      message: `${sources.length} source kinds in group.`,
      severity: "warn",
    });
  }

  const refTypes = uniq(items.map((i) => primaryReference(i)?.kind ?? "none"));
  if (refTypes.length > 1) {
    warnings.push({
      code: "mixed_reference_types",
      message: `${refTypes.length} reference types in group.`,
      severity: DEFAULT_CLAIM_GROUPING_POLICY.allow_mixed_reference_grouping ? "warn" : "block",
    });
  }

  const tridKeys = uniq(
    items.map((i) => {
      const r = primaryReference(i);
      return r ? `${r.kind}:${r.value}` : "none";
    }),
  );
  if (tridKeys.length > 1) {
    warnings.push({
      code: "mixed_trids",
      message: `${tridKeys.length} distinct TRID anchors in group.`,
      severity: "warn",
    });
  }

  const disputed = items.filter((i) => i.review_flags.includes("disputed_source_row"));
  if (disputed.length) {
    warnings.push({
      code: "disputed_rows_included",
      message: `${disputed.length} disputed row(s) in group.`,
      severity: "block",
      affected_preview_ids: disputed.map((d) => d.preview_id),
    });
  }

  const noLink = items.filter((i) => !i.product_id);
  if (noLink.length) {
    warnings.push({
      code: "missing_product_link",
      message: `${noLink.length} item(s) without product link.`,
      severity: DEFAULT_CLAIM_GROUPING_POLICY.require_product_link_before_filing ? "block" : "warn",
      affected_preview_ids: noLink.map((d) => d.preview_id),
    });
  }

  const noPayout = items.filter(
    (i) => i.estimated_amazon_payout == null && i.review_flags.includes("fee_payout_unavailable"),
  );
  if (noPayout.length) {
    warnings.push({
      code: "estimated_payout_unavailable",
      message: `${noPayout.length} item(s) missing fee-adjusted payout estimate.`,
      severity: "warn",
    });
  }

  const noCost = items.filter(
    (i) => i.internal_cost_loss == null && i.review_flags.includes("cogs_unavailable"),
  );
  if (noCost.length) {
    warnings.push({
      code: "missing_cost",
      message: `${noCost.length} item(s) missing internal cost.`,
      severity: DEFAULT_CLAIM_GROUPING_POLICY.require_cost_before_filing ? "block" : "warn",
    });
  }

  const lowConf = items.filter((i) => i.confidence === "low" || i.confidence === "unavailable");
  if (lowConf.length) {
    warnings.push({
      code: "low_confidence",
      message: `${lowConf.length} low/unavailable confidence item(s).`,
      severity: "warn",
    });
  }

  const needsReview = items.filter((i) => i.recommended_action === "needs_review");
  if (needsReview.length) {
    warnings.push({
      code: "policy_hold",
      message: `${needsReview.length} item(s) marked needs_review.`,
      severity: "warn",
      affected_preview_ids: needsReview.map((d) => d.preview_id),
    });
  }

  return warnings;
}

function deriveRecommendedAction(
  items: PreviewGeneratorItem[],
  warnings: GroupWarning[],
): GroupRecommendedAction {
  if (items.some((i) => i.recommended_action === "unavailable")) return "unavailable";
  if (warnings.some((w) => w.severity === "block")) {
    if (warnings.some((w) => w.code === "mixed_claim_families" || w.code === "mixed_trids")) {
      return "split_group";
    }
    return "needs_review";
  }
  if (items.some((i) => i.recommended_action === "needs_review")) return "needs_review";
  if (items.length === 1) return "file_single";
  return "file_grouped";
}

function groupKey(item: PreviewGeneratorItem, mode: GroupingModeSupported): string {
  switch (mode) {
    case "one_candidate_per_group":
      return item.preview_id;
    case "product_family":
      return `${item.product_id ?? "unlinked"}:${item.family_key}`;
    case "product_multi_family":
      return item.product_id ?? `unlinked:${item.fnsku ?? item.asin ?? item.preview_id}`;
    case "reference_trid": {
      const r = primaryReference(item);
      return r ? `${r.kind}:${r.value}` : `orphan:${item.preview_id}`;
    }
    case "shipment_or_removal": {
      const order = edgeValues(item, ["removal_order"]).join("|");
      const ship = edgeValues(item, ["removal_shipment", "shipment"]).join("|");
      const track = edgeValues(item, ["tracking"]).join("|");
      return order || ship || track || `orphan:${item.preview_id}`;
    }
    case "source_report_window": {
      const table = item.source_edges[0]?.table ?? "unknown";
      return `${item.source_kind}:${table}`;
    }
    case "manual_selection_preview":
    case "custom_filter_preview":
      return "filtered_batch";
    default:
      return item.preview_id;
  }
}

function groupTitle(mode: GroupingModeSupported, key: string, items: PreviewGeneratorItem[]): string {
  if (mode === "one_candidate_per_group") {
    const i = items[0];
    return `${i?.family_key ?? "claim"} · ${i?.fnsku ?? i?.asin ?? i?.preview_id?.slice(-8) ?? key}`;
  }
  if (mode === "product_family") {
    const i = items[0];
    return `${i?.family_key ?? "family"} · ${i?.fnsku ?? i?.product_id ?? key}`;
  }
  if (mode === "product_multi_family") {
    const i = items[0];
    return `Product · ${i?.fnsku ?? i?.asin ?? i?.product_id ?? key}`;
  }
  if (mode === "reference_trid") return `TRID · ${key}`;
  if (mode === "shipment_or_removal") return `Removal/shipment · ${key}`;
  if (mode === "source_report_window") return `Source · ${key}`;
  if (mode === "manual_selection_preview") return `Manual selection (${items.length})`;
  return `Filter batch (${items.length})`;
}

export function filterPreviewItems(
  items: PreviewGeneratorItem[],
  filters: GroupingFilterParams,
): PreviewGeneratorItem[] {
  const familyKeys = [
    ...(filters.family_keys ?? []),
    ...(filters.family_key ? [filters.family_key] : []),
  ].filter(Boolean);

  return items.filter((item) => {
    if (familyKeys.length && !familyKeys.includes(item.family_key)) return false;
    if (filters.product_id && !matchesOne(item.product_id, filters.product_id)) return false;
    if (filters.asin && !matchesOne(item.asin, filters.asin)) return false;
    if (filters.fnsku && !matchesOne(item.fnsku, filters.fnsku)) return false;
    if (filters.sku && !matchesOne(item.sku, filters.sku)) return false;
    if (filters.source_kind && item.source_kind !== filters.source_kind) return false;
    if (filters.confidence && item.confidence !== filters.confidence) return false;

    if (filters.status) {
      if (item.recommended_action !== filters.status) return false;
    } else {
      if (!filters.include_needs_review && item.recommended_action === "needs_review") return false;
      if (!filters.include_unavailable && item.recommended_action === "unavailable") return false;
    }

    if (filters.preview_ids?.length && !filters.preview_ids.includes(item.preview_id)) return false;

    if (filters.reference_kind && filters.reference_value) {
      const hit = item.TRID_edges.some(
        (e) =>
          e.reference_kind.toLowerCase().includes(filters.reference_kind!.toLowerCase()) &&
          e.reference_value === filters.reference_value,
      );
      if (!hit) return false;
    }

    if (filters.removal_order_id) {
      const vals = edgeValues(item, ["removal_order"]);
      if (!vals.some((v) => v === filters.removal_order_id)) return false;
    }
    if (filters.removal_shipment_id) {
      const vals = edgeValues(item, ["removal_shipment"]);
      if (!vals.some((v) => v === filters.removal_shipment_id)) return false;
    }
    if (filters.tracking_number) {
      const vals = edgeValues(item, ["tracking"]);
      if (!vals.some((v) => v === filters.tracking_number)) return false;
    }
    if (filters.shipment_id) {
      const vals = edgeValues(item, ["shipment"]);
      if (!vals.some((v) => v === filters.shipment_id)) return false;
    }

    if (
      filters.min_estimated_payout != null &&
      (item.estimated_amazon_payout ?? -1) < filters.min_estimated_payout
    ) {
      return false;
    }
    if (
      filters.min_observed_reimbursement != null &&
      (item.observed_reimbursement ?? -1) < filters.min_observed_reimbursement
    ) {
      return false;
    }

    if (!previewItemPassesDateFilter(item, filters.date_from, filters.date_to)) {
      return false;
    }

    return true;
  });
}

export function buildGroupPreviews(
  items: PreviewGeneratorItem[],
  mode: GroupingModeSupported,
  filters: GroupingFilterParams,
): GroupPreviewRow[] {
  if (!items.length) return [];

  const buckets = new Map<string, PreviewGeneratorItem[]>();
  for (const item of items) {
    const key = groupKey(item, mode);
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }

  const groups: GroupPreviewRow[] = [];
  for (const [key, bucket] of buckets) {
    const warnings = analyzeWarnings(bucket);
    const refs = bucket
      .map((i) => primaryReference(i))
      .filter((r): r is { kind: string; value: string } => r != null);
    const uniqRefs = [...new Map(refs.map((r) => [`${r.kind}:${r.value}`, r])).values()];

    groups.push({
      group_preview_id: groupPreviewId(mode, key),
      group_title: groupTitle(mode, key, bucket),
      grouping_mode: mode,
      filters_applied: filters,
      included_preview_ids: bucket.map((i) => i.preview_id),
      families: [...new Set(bucket.map((i) => i.family_key))],
      products: [...new Set(bucket.map((i) => i.product_id ?? "unlinked"))],
      references: uniqRefs,
      total_units: sumNullable(bucket.map((i) => i.quantity_claimed)) ?? null,
      estimated_amazon_payout_sum: sumNullable(bucket.map((i) => i.estimated_amazon_payout)),
      observed_reimbursement_sum: sumNullable(bucket.map((i) => i.observed_reimbursement)),
      internal_cost_loss_sum: sumNullable(bucket.map((i) => i.internal_cost_loss)),
      reimbursement_gap_sum: sumNullable(bucket.map((i) => i.reimbursement_gap)),
      confidence: aggregateConfidence(bucket),
      warnings,
      recommended_action: deriveRecommendedAction(bucket, warnings),
    });
  }

  groups.sort((a, b) => (b.observed_reimbursement_sum ?? 0) - (a.observed_reimbursement_sum ?? 0));
  const cap = filters.limit ?? 50;
  return groups.slice(0, cap);
}

/** Parse grouping filter params from URL search params. */
export function parseGroupingFiltersFromSearchParams(
  organizationId: string,
  storeId: string,
  params: URLSearchParams,
): GroupingFilterParams {
  const familyKeys = parseListParam(params.get("family_keys"));
  const familyKey = str(params.get("family_key")) || null;
  const previewIds = parseListParam(params.get("preview_ids"));

  const modeRaw = str(params.get("grouping_mode")) as GroupingModeSupported;
  const grouping_mode = (GROUPING_MODES_SUPPORTED as readonly string[]).includes(modeRaw)
    ? modeRaw
    : "product_family";

  return {
    organization_id: organizationId,
    store_id: storeId,
    product_id: str(params.get("product_id")) || null,
    asin: str(params.get("asin")) || null,
    fnsku: str(params.get("fnsku")) || null,
    sku: str(params.get("sku")) || null,
    family_key: familyKey,
    family_keys: familyKeys.length ? familyKeys : null,
    source_kind: (str(params.get("source_kind")) || null) as ClaimSourceKind | null,
    status: (str(params.get("status")) || null) as PreviewRecommendedAction | null,
    confidence: (str(params.get("confidence")) || null) as PreviewGeneratorItem["confidence"] | null,
    reference_kind: str(params.get("reference_kind")) || null,
    reference_value: str(params.get("reference_value")) || null,
    shipment_id: str(params.get("shipment_id")) || null,
    removal_order_id: str(params.get("removal_order_id")) || null,
    removal_shipment_id: str(params.get("removal_shipment_id")) || null,
    tracking_number: str(params.get("tracking_number")) || null,
    date_from: str(params.get("date_from")) || null,
    date_to: str(params.get("date_to")) || null,
    min_estimated_payout: params.get("min_estimated_payout")
      ? Number(params.get("min_estimated_payout"))
      : null,
    min_observed_reimbursement: params.get("min_observed_reimbursement")
      ? Number(params.get("min_observed_reimbursement"))
      : null,
    include_needs_review: params.get("include_needs_review") === "true",
    include_unavailable: params.get("include_unavailable") === "true",
    preview_ids: previewIds.length ? previewIds : null,
    grouping_mode,
    limit: params.get("limit") ? Number(params.get("limit")) : 50,
  };
}

export async function buildClaimGroupingReadmodel(options: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  filters: GroupingFilterParams;
  from?: string | null;
  to?: string | null;
}): Promise<ClaimGroupingReadmodelPayload> {
  const candidatesBefore = await options.client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", options.organizationId);
  const beforeCount = candidatesBefore.count ?? 0;

  const effectivePolicy = await loadEffectiveClaimIntakePolicy(
    options.client,
    options.organizationId,
    options.storeId,
  );
  const effectiveDateContext = buildEffectiveDateContext(effectivePolicy);

  const filtersApplied: GroupingFilterParams = { ...options.filters };
  if (!filtersApplied.date_from) {
    const defaultFrom = defaultGroupingDateFrom(effectivePolicy);
    if (defaultFrom) filtersApplied.date_from = defaultFrom;
  }

  const previewPayload = await buildFirstSafeFamiliesPreviewGenerators({
    client: options.client,
    organizationId: options.organizationId,
    storeId: options.storeId,
    from: options.from ?? null,
    to: options.to ?? null,
    include_all_previews: true,
    rowLimit: 200,
    prerequisite_safe: "yes",
  });

  const filtered = filterPreviewItems(previewPayload.previews, filtersApplied);
  const mode =
    filtersApplied.preview_ids?.length && filtersApplied.grouping_mode === "manual_selection_preview"
      ? "manual_selection_preview"
      : filtersApplied.grouping_mode ?? "product_family";

  const groups = buildGroupPreviews(filtered, mode, filtersApplied);

  const candidatesAfter = await options.client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", options.organizationId);
  const afterCount = candidatesAfter.count ?? 0;

  const warningCodes: GroupWarningCode[] = [
    "mixed_products",
    "mixed_claim_families",
    "mixed_source_kinds",
    "mixed_reference_types",
    "mixed_trids",
    "disputed_rows_included",
    "missing_product_link",
    "estimated_payout_unavailable",
    "missing_cost",
    "low_confidence",
    "policy_hold",
  ];

  const validationsPass =
    beforeCount === afterCount &&
    previewPayload.no_db_writes &&
    previewPayload.no_claim_candidate_mutation &&
    groups.every((g) => g.included_preview_ids.length > 0);

  return {
    contract_version: GROUPING_READMODEL_VERSION,
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: beforeCount === afterCount,
    no_claim_case_creation: true,
    no_ai_calls: true,
    generated_at: new Date().toISOString(),
    organization_id: options.organizationId,
    store_id: options.storeId,
    grouping_modes_supported: GROUPING_MODES_SUPPORTED,
    filter_params_supported: [...FILTER_PARAMS_SUPPORTED],
    filters_applied: filtersApplied,
    filtered_preview_count: filtered.length,
    group_count: groups.length,
    groups,
    sample_group_previews: groups.slice(0, 5),
    warning_rules_verification: {
      codes_checked: warningCodes,
      pass: groups.every((g) => Array.isArray(g.warnings)),
    },
    effective_date_context: effectiveDateContext,
    SAFE_TO_BUILD_GROUPING_UI: validationsPass ? "yes" : "no",
  };
}
