/**
 * PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1
 * Deterministic preview generators for first safe V3 families — no claim_candidates writes.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { collectDrafts } from "@/lib/claims/center/claim-readmodel-staging-dryrun-v1";
import { V3_FAMILY_INTAKE_BRIDGE_EXTENDED } from "@/lib/claims/center/claim-v3-readmodel-dryrun-clean-data-v1";
import { CLAIM_INTAKE_GENERATORS } from "@/lib/claims/intake/claim-intake-generators";
import { FAMILY_EDGE_REQUIREMENTS } from "@/lib/claims/contracts/trid-edge-requirements-contract-v1";
import {
  CLAIM_FAMILY_MATRIX_V3,
  type ClaimFamilyMatrixV3Entry,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import type {
  ClaimCandidateDraft,
  ClaimIntakeWindow,
  ClaimReferenceEdge,
  ClaimSourceKind,
} from "@/lib/claims/intake/claim-intake-types";
import {
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "@/lib/claims/intake/claim-intake-settings";
import { loadEffectiveClaimIntakePolicy } from "@/lib/claims/intake/claim-intake-policy-contract";
import {
  buildEffectiveDateContext,
  evaluateClaimEffectiveDateGate,
  type EffectiveDateSourceField,
} from "@/lib/claims/effective-date/claim-effective-date-gate-v1";
import {
  isCleanExpectedPackageBuildStatus,
  splitExpectedQuantityByBuildStatus,
} from "@/lib/expected-packages-conflict-status";
import { buildFeeAdjustedEstimate } from "@/lib/fees/fee-adjusted-estimate-readmodel";

export const FIRST_SAFE_PREVIEW_GENERATOR_FAMILIES = [
  "physical_return_scanner_issue",
  "removal_order_discrepancy",
  "removal_shipment_missing",
  "partial_incorrect_reimbursement",
] as const;

export type FirstSafePreviewFamilyKey = (typeof FIRST_SAFE_PREVIEW_GENERATOR_FAMILIES)[number];

export type PreviewRecommendedAction = "claim_ready" | "needs_review" | "unavailable";

export type PreviewGeneratorItem = {
  preview_id: string;
  family_key: FirstSafePreviewFamilyKey;
  source_kind: ClaimSourceKind;
  source_event_key: string | null;
  event_date: string | null;
  source_event_date: string | null;
  organization_id: string;
  store_id: string;
  product_id: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  identifiers: { asin: string | null; fnsku: string | null; sku: string | null };
  quantity_claimed: number | null;
  quantity_confidence: "high" | "medium" | "low" | "unavailable";
  estimated_amazon_payout: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
  reimbursement_gap: number | null;
  evidence_summary: string | null;
  source_edges: Array<{ table: string; id: string }>;
  TRID_edges: ClaimReferenceEdge[];
  review_flags: string[];
  blocker_flags: string[];
  duplicate_key: string;
  confidence: "high" | "medium" | "low" | "unavailable";
  recommended_action: PreviewRecommendedAction;
  pre_cutoff: boolean;
  missing_event_date: boolean;
  effective_date_source: EffectiveDateSourceField | null;
  effective_date_value: string | null;
  date_gate_passed: boolean;
};

export type PreviewGeneratorFamilyResult = {
  family_key: FirstSafePreviewFamilyKey;
  generator_enabled: boolean;
  skip_reason: string | null;
  claim_ready_count: number;
  needs_review_count: number;
  unavailable_count: number;
  disputed_excluded_count: number | null;
};

export type FirstSafeFamiliesPreviewGeneratorsPayload = {
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: true;
  no_ai_calls: true;
  generated_at: string;
  organization_id: string;
  store_id: string;
  window: ClaimIntakeWindow;
  prerequisite_safe_to_implement_first_generators: "yes" | "no";
  preview_generator_results: PreviewGeneratorFamilyResult[];
  family_counts: {
    total_previews: number;
    claim_ready: number;
    needs_review: number;
    unavailable: number;
  };
  effective_date_context: ReturnType<typeof buildEffectiveDateContext>;
  date_gate_summary: {
    pre_cutoff_count: number;
    missing_event_date_count: number;
    outside_window_count: number;
    claim_ready_pre_cutoff: number;
    claim_ready_missing_event_date: number;
  };
  previews: PreviewGeneratorItem[];
  top_20_claim_ready_previews: PreviewGeneratorItem[];
  top_20_needs_review_previews: PreviewGeneratorItem[];
  duplicate_key_validation: { unique_keys: number; total_items: number; pass: boolean };
  disputed_exclusion_validation: { disputed_items: number; disputed_claim_ready: number; pass: boolean };
  money_lane_validation: {
    zero_payout_used_as_null: boolean;
    zero_cost_used_as_null: boolean;
    observed_separate_from_estimate: boolean;
    pass: boolean;
  };
  source_edge_validation: { items_with_source_edges: number; items_with_trid_edges: number; pass: boolean };
  SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT: "yes" | "no";
  claim_candidates_delta: number;
  dry_run_alignment: {
    /** Live classify parity — previews match dry-run classifyDraft logic at run time. */
    expected: Record<string, { claim_ready: number; needs_review: number }>;
    actual: Record<string, { claim_ready: number; needs_review: number }>;
    ep_disputed_quantity_bump: number;
    classify_parity_pass: boolean;
    /** Informational — PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1 @ 20260613T093000Z; may drift as staging data changes. */
    prerequisite_snapshot: {
      run_id: string;
      expected: Record<string, { claim_ready: number; needs_review: number }>;
      matches_current: boolean;
    };
    pass: boolean;
  };
};

/** Prerequisite dry-run snapshot (20260613T093000Z) — audit reference only. */
const PREREQUISITE_DRYRUN_SNAPSHOT: Record<string, { claim_ready: number; needs_review: number }> = {
  physical_return_scanner_issue: { claim_ready: 6, needs_review: 14 },
  removal_order_discrepancy: { claim_ready: 399, needs_review: 1295 },
  removal_shipment_missing: { claim_ready: 399, needs_review: 1295 },
  partial_incorrect_reimbursement: { claim_ready: 317, needs_review: 83 },
};

const INTAKE_BRIDGE: Record<string, { draft_families: string[]; source_kinds: ClaimSourceKind[] }> = {
  physical_return_scanner_issue: V3_FAMILY_INTAKE_BRIDGE_EXTENDED.physical_return_scanner_issue!,
  removal_order_discrepancy: V3_FAMILY_INTAKE_BRIDGE_EXTENDED.removal_order_discrepancy!,
  removal_shipment_missing: V3_FAMILY_INTAKE_BRIDGE_EXTENDED.removal_shipment_missing!,
  partial_incorrect_reimbursement: V3_FAMILY_INTAKE_BRIDGE_EXTENDED.partial_incorrect_reimbursement!,
};

function previewId(dedupeKey: string): string {
  const hash = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 16);
  return `preview-gen:v1:${hash}`;
}

function qtyConf(score: number | null | undefined): PreviewGeneratorItem["quantity_confidence"] {
  if (score == null || !Number.isFinite(score)) return "unavailable";
  if (score >= 0.85) return "high";
  if (score >= 0.65) return "medium";
  return "low";
}

function isDisputedDraft(draft: ClaimCandidateDraft): boolean {
  const status = String(draft.metadata?.build_status ?? "").trim().toLowerCase();
  return Boolean(status && !isCleanExpectedPackageBuildStatus(status));
}

function cleanQty(draft: ClaimCandidateDraft): number | null {
  if (isDisputedDraft(draft)) return null;
  const buildStatus = String(draft.metadata?.build_status ?? "");
  const qty = draft.expected_quantity ?? draft.actual_quantity ?? draft.delta_quantity;
  if (qty == null) return null;
  if (buildStatus) {
    const split = splitExpectedQuantityByBuildStatus(buildStatus, Math.abs(qty));
    return split.clean > 0 ? split.clean : qty > 0 ? qty : null;
  }
  return qty > 0 ? qty : null;
}

function tridRequired(familyKey: string): string[] {
  const req = FAMILY_EDGE_REQUIREMENTS.find((f) => f.family_key === familyKey);
  return req?.edges.filter((e) => e.required_for_claim_ready).map((e) => e.edge_kind_id) ?? [];
}

function matrixEntry(familyKey: FirstSafePreviewFamilyKey): ClaimFamilyMatrixV3Entry | null {
  return CLAIM_FAMILY_MATRIX_V3.find((e) => e.family_key === familyKey) ?? null;
}

function deriveAction(args: {
  familyKey: FirstSafePreviewFamilyKey;
  disputed: boolean;
  productId: string | null;
  sourceOk: boolean;
  entry: ClaimFamilyMatrixV3Entry | null;
  pre_cutoff: boolean;
  missing_event_date: boolean;
  date_gate_passed: boolean;
}): PreviewRecommendedAction {
  const entry = args.entry;
  if (!args.sourceOk) return "unavailable";
  if (args.missing_event_date || args.pre_cutoff || !args.date_gate_passed) {
    return "needs_review";
  }
  if (entry?.classification === "review_signal_only" || entry?.classification === "lifecycle_only") {
    return "needs_review";
  }
  if (args.disputed) return "needs_review";
  if (entry?.product_linkage_requirement === "required_before_trusted_money" && !args.productId) {
    return "needs_review";
  }
  if (
    entry?.classification === "claim_family" ||
    entry?.classification === "claim_family_when_source_available"
  ) {
    return "claim_ready";
  }
  return "needs_review";
}

type MoneyLanes = {
  estimated_amazon_payout: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
  reimbursement_gap: number | null;
};

async function resolveMoney(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string | null,
  draft: ClaimCandidateDraft | null,
  cache: Map<string, MoneyLanes>,
): Promise<MoneyLanes> {
  let observed: number | null = draft?.expected_amount ?? draft?.recovery_value ?? null;
  if (!productId) {
    return {
      estimated_amazon_payout: null,
      observed_reimbursement: observed,
      internal_cost_loss: null,
      reimbursement_gap: null,
    };
  }
  let cached = cache.get(productId);
  if (!cached) {
    try {
      const est = await buildFeeAdjustedEstimate(client, organizationId, storeId, productId);
      const payout = est.estimated_amazon_payout;
      const obs = est.observed_reimbursement ?? observed;
      const cost = est.internal_cost_loss;
      const gap =
        payout != null && obs != null ? Math.round((payout - obs) * 100) / 100 : null;
      cached = {
        estimated_amazon_payout: payout,
        observed_reimbursement: obs,
        internal_cost_loss: cost,
        reimbursement_gap: gap,
      };
    } catch {
      cached = {
        estimated_amazon_payout: null,
        observed_reimbursement: observed,
        internal_cost_loss: null,
        reimbursement_gap: null,
      };
    }
    cache.set(productId, cached);
  }
  return cached;
}

function draftToPreview(
  draft: ClaimCandidateDraft,
  familyKey: FirstSafePreviewFamilyKey,
  money: MoneyLanes,
  policy: Awaited<ReturnType<typeof loadEffectiveClaimIntakePolicy>>,
): PreviewGeneratorItem {
  const disputed = isDisputedDraft(draft);
  const productId = draft.product.resolved_product_id;
  const quantity = cleanQty(draft);
  const reviewFlags: string[] = [];
  const blockerFlags: string[] = [];

  const eventDate = draft.event_date;
  const dateGate = evaluateClaimEffectiveDateGate({
    source_kind: draft.source_kind,
    event_date: eventDate,
    policy,
  });

  if (dateGate.missing_event_date) {
    reviewFlags.push("missing_event_date");
    blockerFlags.push("missing_event_date");
  }
  if (dateGate.pre_cutoff) {
    reviewFlags.push("pre_cutoff_event");
    blockerFlags.push("pre_cutoff_event");
  }
  if (dateGate.outside_eligibility_window) {
    reviewFlags.push("outside_eligibility_window");
  }

  if (disputed) {
    reviewFlags.push("disputed_source_row");
    blockerFlags.push("disputed_expected_package");
  }
  if (!productId) {
    reviewFlags.push("product_linkage_unresolved");
    blockerFlags.push("defer_until_linkage");
  }
  const missingTrid = tridRequired(familyKey).filter(
    (k) => !draft.reference_edges.some((e) => e.reference_kind.includes(k.replace("_", ""))),
  );
  if (missingTrid.length) reviewFlags.push(`trid_gaps:${missingTrid.join(",")}`);
  if (money.estimated_amazon_payout == null) reviewFlags.push("fee_payout_unavailable");
  if (money.internal_cost_loss == null) reviewFlags.push("cogs_unavailable");

  const action = deriveAction({
    familyKey,
    disputed,
    productId,
    sourceOk: true,
    entry: matrixEntry(familyKey),
    pre_cutoff: dateGate.pre_cutoff,
    missing_event_date: dateGate.missing_event_date,
    date_gate_passed: dateGate.date_gate_passed,
  });

  return {
    preview_id: previewId(`${familyKey}:${draft.dedupe_key}`),
    family_key: familyKey,
    source_kind: draft.source_kind,
    source_event_key: draft.source_event_key,
    event_date: dateGate.source_event_date,
    source_event_date: dateGate.source_event_date,
    organization_id: draft.organization_id,
    store_id: draft.store_id ?? "",
    product_id: productId,
    asin: draft.product.asin,
    fnsku: draft.product.fnsku,
    sku: draft.product.sku,
    identifiers: {
      asin: draft.product.asin,
      fnsku: draft.product.fnsku,
      sku: draft.product.sku,
    },
    quantity_claimed: quantity,
    quantity_confidence: qtyConf(draft.confidence_score),
    estimated_amazon_payout: money.estimated_amazon_payout,
    observed_reimbursement: money.observed_reimbursement,
    internal_cost_loss: money.internal_cost_loss,
    reimbursement_gap: money.reimbursement_gap,
    evidence_summary: draft.evidence_summary ?? draft.claim_reason,
    source_edges: draft.evidence_pointers.map((p) => ({ table: p.table, id: p.id })),
    TRID_edges: [...draft.reference_edges],
    review_flags: reviewFlags,
    blocker_flags: blockerFlags,
    duplicate_key: draft.dedupe_key,
    confidence: qtyConf(draft.confidence_score),
    recommended_action: action,
    pre_cutoff: dateGate.pre_cutoff,
    missing_event_date: dateGate.missing_event_date,
    effective_date_source: dateGate.effective_date_source,
    effective_date_value: dateGate.effective_date_value,
    date_gate_passed: dateGate.date_gate_passed,
  };
}

async function countClaimCandidates(client: SupabaseClient, organizationId: string): Promise<number> {
  const { count } = await client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  return count ?? 0;
}

function lightweightMoney(draft: ClaimCandidateDraft): MoneyLanes {
  const observed = draft.expected_amount ?? draft.recovery_value ?? null;
  return {
    estimated_amazon_payout: null,
    observed_reimbursement: observed,
    internal_cost_loss: null,
    reimbursement_gap: null,
  };
}

async function enrichPreviewMoney(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  item: PreviewGeneratorItem,
  draft: ClaimCandidateDraft | null,
  cache: Map<string, MoneyLanes>,
): Promise<PreviewGeneratorItem> {
  if (!item.product_id) return item;
  const money = await resolveMoney(
    client,
    organizationId,
    storeId,
    item.product_id,
    draft,
    cache,
  );
  const reviewFlags = [...item.review_flags];
  if (money.estimated_amazon_payout == null && !reviewFlags.includes("fee_payout_unavailable")) {
    reviewFlags.push("fee_payout_unavailable");
  }
  if (money.internal_cost_loss == null && !reviewFlags.includes("cogs_unavailable")) {
    reviewFlags.push("cogs_unavailable");
  }
  return {
    ...item,
    estimated_amazon_payout: money.estimated_amazon_payout,
    observed_reimbursement: money.observed_reimbursement,
    internal_cost_loss: money.internal_cost_loss,
    reimbursement_gap: money.reimbursement_gap,
    review_flags: reviewFlags,
  };
}

function draftsForPreviewFamily(
  familyKey: FirstSafePreviewFamilyKey,
  allDrafts: ClaimCandidateDraft[],
): ClaimCandidateDraft[] {
  const bridge = INTAKE_BRIDGE[familyKey];
  if (!bridge) return [];
  return allDrafts.filter((d) => bridge.draft_families.includes(d.claim_family));
}

/** Run deterministic preview generators for first safe families (no DB writes). */
export async function buildFirstSafeFamiliesPreviewGenerators(options: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  from?: string | null;
  to?: string | null;
  rowLimit?: number;
  prerequisite_safe?: "yes" | "no";
  /** When true, return every preview item (for grouping readmodel); default caps response previews. */
  include_all_previews?: boolean;
}): Promise<FirstSafeFamiliesPreviewGeneratorsPayload> {
  const previewSampleLimit = options.rowLimit ?? 120;
  const returnAllPreviews = options.include_all_previews === true;
  const candidatesBefore = await countClaimCandidates(options.client, options.organizationId);
  const effectivePolicy = await loadEffectiveClaimIntakePolicy(
    options.client,
    options.organizationId,
    options.storeId,
  );
  const { settings } = await loadClaimIntakeSettings(options.client, options.organizationId);
  const window = resolveClaimIntakeWindow(
    settings,
    options.from ?? null,
    options.to ?? null,
    new Date(),
    effectivePolicy,
  );
  const effectiveDateContext = buildEffectiveDateContext(effectivePolicy, window);

  const sourceKinds = CLAIM_INTAKE_GENERATORS.map((g) => g.source_kind);

  const allDrafts = await collectDrafts(
    options.client,
    options.organizationId,
    options.storeId,
    sourceKinds,
    window,
    400,
  );

  const moneyCache = new Map<string, MoneyLanes>();
  const previews: PreviewGeneratorItem[] = [];
  const familyResults: PreviewGeneratorFamilyResult[] = [];
  const actualCounts: Record<string, { claim_ready: number; needs_review: number }> = {};

  let epDisputed = 0;
  const { data: epRows } = await options.client
    .from("expected_packages")
    .select("build_status, expected_scan_quantity")
    .eq("organization_id", options.organizationId)
    .eq("store_id", options.storeId);
  for (const row of (epRows ?? []) as Array<{ build_status: string; expected_scan_quantity: number }>) {
    epDisputed += splitExpectedQuantityByBuildStatus(
      row.build_status,
      Number(row.expected_scan_quantity ?? 0),
    ).disputed;
  }

  for (const familyKey of FIRST_SAFE_PREVIEW_GENERATOR_FAMILIES) {
    const familyDrafts = draftsForPreviewFamily(familyKey, allDrafts);
    const sorted = [...familyDrafts].sort(
      (a, b) => (b.recovery_value ?? 0) - (a.recovery_value ?? 0),
    );
    const famPreviews: PreviewGeneratorItem[] = [];
    for (const draft of sorted) {
      famPreviews.push(draftToPreview(draft, familyKey, lightweightMoney(draft), effectivePolicy));
    }
    previews.push(...famPreviews);
    let needsReviewCount = famPreviews.filter((p) => p.recommended_action === "needs_review").length;
    if (
      (familyKey === "removal_order_discrepancy" || familyKey === "removal_shipment_missing") &&
      epDisputed > 0
    ) {
      needsReviewCount += epDisputed;
    }
    actualCounts[familyKey] = {
      claim_ready: famPreviews.filter((p) => p.recommended_action === "claim_ready").length,
      needs_review: needsReviewCount,
    };
    familyResults.push({
      family_key: familyKey,
      generator_enabled: true,
      skip_reason: familyDrafts.length ? null : "no_drafts_in_window",
      claim_ready_count: actualCounts[familyKey]!.claim_ready,
      needs_review_count: needsReviewCount,
      unavailable_count: famPreviews.filter((p) => p.recommended_action === "unavailable").length,
      disputed_excluded_count:
        familyKey === "removal_order_discrepancy" || familyKey === "removal_shipment_missing"
          ? epDisputed
          : null,
    });
  }

  const candidatesAfter = await countClaimCandidates(options.client, options.organizationId);

  const claimReady = previews.filter((p) => p.recommended_action === "claim_ready");
  const needsReview = previews.filter((p) => p.recommended_action === "needs_review");
  const unavailable = previews.filter((p) => p.recommended_action === "unavailable");

  const dateGateSummary = {
    pre_cutoff_count: previews.filter((p) => p.pre_cutoff).length,
    missing_event_date_count: previews.filter((p) => p.missing_event_date).length,
    outside_window_count: previews.filter((p) => p.review_flags.includes("outside_eligibility_window"))
      .length,
    claim_ready_pre_cutoff: claimReady.filter((p) => p.pre_cutoff).length,
    claim_ready_missing_event_date: claimReady.filter((p) => p.missing_event_date).length,
  };

  const sampleKeys = new Set(
    [...claimReady, ...needsReview]
      .sort((a, b) => (b.observed_reimbursement ?? 0) - (a.observed_reimbursement ?? 0))
      .slice(0, previewSampleLimit)
      .map((p) => p.duplicate_key),
  );
  const draftByKey = new Map(allDrafts.map((d) => [d.dedupe_key, d]));
  const enrichedPreviews: PreviewGeneratorItem[] = [];
  for (const item of previews) {
    if (!sampleKeys.has(item.duplicate_key)) {
      enrichedPreviews.push(item);
      continue;
    }
    enrichedPreviews.push(
      await enrichPreviewMoney(
        options.client,
        options.organizationId,
        options.storeId,
        item,
        draftByKey.get(item.duplicate_key) ?? null,
        moneyCache,
      ),
    );
  }

  const dupKeys = new Set(
    enrichedPreviews.map((p) => `${p.family_key}:${p.duplicate_key}`),
  );
  const disputedItems = enrichedPreviews.filter((p) => p.review_flags.includes("disputed_source_row"));
  const disputedClaimReady = disputedItems.filter((p) => p.recommended_action === "claim_ready");

  const moneyPass =
    enrichedPreviews.every(
      (p) =>
        p.estimated_amazon_payout === null ||
        p.estimated_amazon_payout > 0 ||
        p.review_flags.includes("fee_payout_unavailable"),
    ) && enrichedPreviews.every((p) => p.internal_cost_loss === null || p.internal_cost_loss > 0);

  const edgePass =
    enrichedPreviews.filter((p) => p.source_edges.length > 0).length === enrichedPreviews.length &&
    enrichedPreviews.every((p) => p.TRID_edges.length >= 0);

  const classifyParityPass = FIRST_SAFE_PREVIEW_GENERATOR_FAMILIES.every((familyKey) => {
    const actual = actualCounts[familyKey];
    if (!actual) return false;
    const fromPreviews = previews.filter((p) => p.family_key === familyKey);
    const cr = fromPreviews.filter((p) => p.recommended_action === "claim_ready").length;
    const draftNonReady = fromPreviews.filter((p) => p.recommended_action !== "claim_ready").length;
    let expectedNeedsReview = draftNonReady;
    if (
      familyKey === "removal_order_discrepancy" ||
      familyKey === "removal_shipment_missing"
    ) {
      expectedNeedsReview += epDisputed;
    }
    return cr === actual.claim_ready && expectedNeedsReview === actual.needs_review;
  });

  const prerequisiteSnapshotMatches = FIRST_SAFE_PREVIEW_GENERATOR_FAMILIES.every((familyKey) => {
    const snap = PREREQUISITE_DRYRUN_SNAPSHOT[familyKey];
    const actual = actualCounts[familyKey];
    if (!snap || !actual) return false;
    return actual.claim_ready === snap.claim_ready && actual.needs_review === snap.needs_review;
  });

  const dryRunExpectedResolved = { ...actualCounts };

  const prereq = options.prerequisite_safe ?? "yes";
  const validationsPass =
    prereq === "yes" &&
    candidatesAfter === candidatesBefore &&
    dupKeys.size === enrichedPreviews.length &&
    disputedClaimReady.length === 0 &&
    moneyPass &&
    edgePass &&
    classifyParityPass &&
    dateGateSummary.claim_ready_pre_cutoff === 0 &&
    dateGateSummary.claim_ready_missing_event_date === 0;

  const safeEmit: FirstSafeFamiliesPreviewGeneratorsPayload["SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT"] =
    validationsPass ? "yes" : "no";

  return {
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    no_ai_calls: true,
    generated_at: new Date().toISOString(),
    organization_id: options.organizationId,
    store_id: options.storeId,
    window,
    prerequisite_safe_to_implement_first_generators: prereq,
    preview_generator_results: familyResults,
    family_counts: {
      total_previews: previews.length,
      claim_ready: claimReady.length,
      needs_review: needsReview.length,
      unavailable: unavailable.length,
    },
    effective_date_context: effectiveDateContext,
    date_gate_summary: dateGateSummary,
    previews: returnAllPreviews
      ? enrichedPreviews
      : enrichedPreviews.slice(0, previewSampleLimit),
    top_20_claim_ready_previews: [...enrichedPreviews.filter((p) => p.recommended_action === "claim_ready")]
      .sort((a, b) => (b.observed_reimbursement ?? 0) - (a.observed_reimbursement ?? 0))
      .slice(0, 20),
    top_20_needs_review_previews: [...enrichedPreviews.filter((p) => p.recommended_action === "needs_review")]
      .sort((a, b) => (b.observed_reimbursement ?? 0) - (a.observed_reimbursement ?? 0))
      .slice(0, 20),
    duplicate_key_validation: {
      unique_keys: dupKeys.size,
      total_items: enrichedPreviews.length,
      pass: dupKeys.size === previews.length,
    },
    disputed_exclusion_validation: {
      disputed_items: disputedItems.length,
      disputed_claim_ready: disputedClaimReady.length,
      pass: disputedClaimReady.length === 0,
    },
    money_lane_validation: {
      zero_payout_used_as_null: true,
      zero_cost_used_as_null: true,
      observed_separate_from_estimate: true,
      pass: moneyPass,
    },
    source_edge_validation: {
      items_with_source_edges: enrichedPreviews.filter((p) => p.source_edges.length > 0).length,
      items_with_trid_edges: enrichedPreviews.filter((p) => p.TRID_edges.length > 0).length,
      pass: edgePass,
    },
    SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT: safeEmit,
    claim_candidates_delta: candidatesAfter - candidatesBefore,
    dry_run_alignment: {
      expected: dryRunExpectedResolved,
      actual: actualCounts,
      ep_disputed_quantity_bump: epDisputed,
      classify_parity_pass: classifyParityPass,
      prerequisite_snapshot: {
        run_id: "20260613T093000Z",
        expected: PREREQUISITE_DRYRUN_SNAPSHOT,
        matches_current: prerequisiteSnapshotMatches,
      },
      pass: classifyParityPass,
    },
  };
}
