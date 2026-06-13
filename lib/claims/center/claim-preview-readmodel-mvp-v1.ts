/**
 * PHASE-FIRST-CLAIM-PREVIEW-READMODEL-MVP-V1
 * Read-only per-item claim preview — no claim_candidates writes, no cases, no PDFs.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import {
  collectDrafts,
  V3_FAMILY_INTAKE_BRIDGE,
} from "@/lib/claims/center/claim-readmodel-staging-dryrun-v1";
import { V3_FAMILY_INTAKE_BRIDGE_EXTENDED } from "@/lib/claims/center/claim-v3-readmodel-dryrun-clean-data-v1";
import { CLAIM_INTAKE_GENERATORS } from "@/lib/claims/intake/claim-intake-generators";
import {
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "@/lib/claims/intake/claim-intake-settings";
import type { ClaimCandidateDraft, ClaimIntakeWindow, ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";
import { FAMILY_EDGE_REQUIREMENTS } from "@/lib/claims/contracts/trid-edge-requirements-contract-v1";
import {
  isCleanExpectedPackageBuildStatus,
  splitExpectedQuantityByBuildStatus,
} from "@/lib/expected-packages-conflict-status";
import { buildFeeAdjustedEstimate } from "@/lib/fees/fee-adjusted-estimate-readmodel";

/** MVP families — aligned with V3 dry-run safe-first ordering. */
export const CLAIM_PREVIEW_MVP_FAMILIES = [
  "removal_order_discrepancy",
  "removal_shipment_missing",
  "physical_return_scanner_issue",
  "missing_reimbursement",
  "settlement_refund_anomaly",
] as const;

export type ClaimPreviewMvpFamilyKey = (typeof CLAIM_PREVIEW_MVP_FAMILIES)[number];

export type ClaimPreviewConfidence = "high" | "medium" | "low" | "unavailable";

export type ClaimPreviewItemStatus = "claim_ready_preview" | "needs_review" | "blocked";

export type ClaimPreviewItem = {
  preview_id: string;
  family_key: ClaimPreviewMvpFamilyKey;
  status: ClaimPreviewItemStatus;
  product_id: string | null;
  identifiers: { asin: string | null; fnsku: string | null; sku: string | null };
  source_rows: Array<{ table: string; id: string }>;
  clean_quantity: number | null;
  disputed_quantity_excluded: number | null;
  estimated_amazon_payout: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
  confidence: ClaimPreviewConfidence;
  claim_ready_preview: boolean;
  blocker: string | null;
  review_reason: string | null;
  evidence_summary: string | null;
  trid_reference_edges_required: string[];
  trid_reference_edges_present: string[];
  duplicate_prevention_key: string;
  recommended_next_action: string;
};

export type ClaimPreviewFamilySummary = {
  family_key: ClaimPreviewMvpFamilyKey;
  preview_item_count: number;
  claim_ready_count: number;
  review_deferred_count: number;
  disputed_excluded_total: number | null;
};

export type ClaimPreviewReadmodelMvpPayload = {
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: true;
  no_ai_calls: true;
  generated_at: string;
  organization_id: string;
  store_id: string;
  window: ClaimIntakeWindow;
  preview_family_count: number;
  preview_item_count: number;
  families: ClaimPreviewFamilySummary[];
  items: ClaimPreviewItem[];
  top_blockers: Array<{ blocker: string; count: number }>;
  SAFE_TO_PUSH: "yes" | "conditional" | "no";
};

const INTAKE_BRIDGE: Record<string, { draft_families: string[]; source_kinds: ClaimSourceKind[] }> = {
  ...V3_FAMILY_INTAKE_BRIDGE,
  removal_shipment_missing: V3_FAMILY_INTAKE_BRIDGE_EXTENDED.removal_shipment_missing!,
  settlement_refund_anomaly: V3_FAMILY_INTAKE_BRIDGE_EXTENDED.settlement_refund_anomaly!,
};

const V3_CLAIM_READY_FAMILIES = new Set([
  "physical_return_scanner_issue",
  "removal_order_discrepancy",
  "removal_shipment_missing",
  "partial_incorrect_reimbursement",
]);

function confFromScore(score: number | null | undefined): ClaimPreviewConfidence {
  if (score == null || !Number.isFinite(score)) return "unavailable";
  if (score >= 0.85) return "high";
  if (score >= 0.65) return "medium";
  return "low";
}

function previewIdFromDedupe(dedupeKey: string): string {
  const hash = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 16);
  return `preview:v1:${hash}`;
}

function draftMapsToFamily(draft: ClaimCandidateDraft, familyKey: ClaimPreviewMvpFamilyKey): boolean {
  const bridge = INTAKE_BRIDGE[familyKey];
  if (!bridge?.draft_families.length) return false;
  return bridge.draft_families.includes(draft.claim_family);
}

function tridRequiredForFamily(familyKey: string): string[] {
  const req = FAMILY_EDGE_REQUIREMENTS.find((f) => f.family_key === familyKey);
  return req?.edges.filter((e) => e.required_for_claim_ready).map((e) => e.edge_kind_id) ?? [];
}

function tridPresentFromDraft(draft: ClaimCandidateDraft, productId: string | null): string[] {
  const present = new Set<string>();
  if (productId) present.add("product_link");
  if (draft.source_table && draft.source_row_id) present.add("source_report_row");
  for (const e of draft.reference_edges) {
    if (e.reference_kind.includes("order")) present.add("order_id");
    if (e.reference_kind.includes("removal")) present.add("removal_order_id");
    if (e.reference_kind.includes("shipment")) present.add("removal_shipment_id");
    if (e.reference_kind.includes("tracking")) present.add("tracking_number");
    if (e.reference_kind.includes("return_item")) present.add("return_item_id");
    if (e.reference_kind.includes("reimbursement")) present.add("reimbursement_id");
    if (e.reference_kind.includes("settlement")) present.add("settlement_id");
    if (e.reference_kind.includes("ledger")) present.add("inventory_ledger_reference");
    if (e.reference_kind.includes("package")) present.add("package_id");
    if (e.reference_kind.includes("scanner")) present.add("scanner_evidence");
  }
  return [...present];
}

function isDisputedDraft(draft: ClaimCandidateDraft): boolean {
  const status = String(draft.metadata?.build_status ?? "").trim().toLowerCase();
  if (!status) return false;
  return !isCleanExpectedPackageBuildStatus(status);
}

function cleanQtyFromDraft(draft: ClaimCandidateDraft): number | null {
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

function disputedExcludedFromDraft(draft: ClaimCandidateDraft): number | null {
  const excluded = draft.metadata?.disputed_quantity_excluded;
  if (typeof excluded === "number" && excluded > 0) return excluded;
  const buildStatus = String(draft.metadata?.build_status ?? "");
  if (!buildStatus || isCleanExpectedPackageBuildStatus(buildStatus)) return null;
  const qty = draft.expected_quantity ?? draft.actual_quantity ?? 0;
  const split = splitExpectedQuantityByBuildStatus(buildStatus, Math.abs(qty));
  return split.disputed > 0 ? split.disputed : null;
}

function derivePreviewStatus(args: {
  claimReady: boolean;
  disputed: boolean;
  blocker: string | null;
}): ClaimPreviewItemStatus {
  if (args.claimReady) return "claim_ready_preview";
  if (args.disputed || args.blocker === "disputed_source_row") return "needs_review";
  if (args.blocker === "product_linkage_unresolved") return "needs_review";
  if (args.blocker === "family_not_claim_ready_in_v3_dryrun") return "needs_review";
  if (args.blocker) return "blocked";
  return "needs_review";
}

function recommendedAction(args: {
  status: ClaimPreviewItemStatus;
  reviewReason: string | null;
  familyKey: ClaimPreviewMvpFamilyKey;
}): string {
  if (args.status === "claim_ready_preview") {
    return "Review preview in Claim Center — dry-run only; no candidate write until operator approves";
  }
  if (args.reviewReason?.includes("linkage")) {
    return "Resolve product linkage in PIM (identifier map) before trusted money preview";
  }
  if (args.reviewReason?.includes("disputed")) {
    return "Reconcile disputed expected package / source conflict before claim-ready promotion";
  }
  if (args.familyKey === "missing_reimbursement" || args.familyKey === "settlement_refund_anomaly") {
    return "Resolve product linkage then re-run preview for trusted money fields";
  }
  return "Defer — complete source linkage or money spine gaps first";
}

async function expectedPackageDisputedTotal(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<number> {
  const { data, error } = await client
    .from("expected_packages")
    .select("build_status, expected_scan_quantity")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId);
  if (error) return 0;
  let disputed = 0;
  for (const row of (data ?? []) as Array<{ build_status: string; expected_scan_quantity: number }>) {
    const split = splitExpectedQuantityByBuildStatus(
      row.build_status,
      Number(row.expected_scan_quantity ?? 0),
    );
    disputed += split.disputed;
  }
  return disputed;
}

async function moneyForProduct(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string | null,
  draftFallback: ClaimCandidateDraft,
): Promise<{
  estimated_amazon_payout: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
}> {
  let estimated: number | null = null;
  let observed: number | null = draftFallback.expected_amount ?? draftFallback.recovery_value ?? null;
  let cost: number | null = null;

  if (productId) {
    try {
      const est = await buildFeeAdjustedEstimate(client, organizationId, storeId, productId);
      estimated = est.estimated_amazon_payout;
      if (est.observed_reimbursement != null) observed = est.observed_reimbursement;
      cost = est.internal_cost_loss;
    } catch {
      /* NULL money lanes */
    }
  }

  if (cost == null && draftFallback.cogs_unit != null) {
    const qty = cleanQtyFromDraft(draftFallback) ?? 1;
    cost = Math.round(draftFallback.cogs_unit * qty * 100) / 100;
  }

  return {
    estimated_amazon_payout: estimated,
    observed_reimbursement: observed,
    internal_cost_loss: cost,
  };
}

async function draftToPreviewItem(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  familyKey: ClaimPreviewMvpFamilyKey,
  draft: ClaimCandidateDraft,
  familyDisputedTotal: number | null,
): Promise<ClaimPreviewItem> {
  const productId = draft.product.resolved_product_id;
  const disputed = isDisputedDraft(draft);
  const cleanQty = disputed ? null : cleanQtyFromDraft(draft);
  const disputedExcluded = disputedExcludedFromDraft(draft) ?? (disputed ? familyDisputedTotal : null);

  const reviewReasons: string[] = [];
  if (disputed) reviewReasons.push("disputed_row_excluded");
  if (!productId) reviewReasons.push("product_linkage_unresolved");

  const familyClaimReady = V3_CLAIM_READY_FAMILIES.has(familyKey);
  const claimReady =
    familyClaimReady && !disputed && Boolean(productId) && (cleanQty == null || cleanQty > 0);

  const money = await moneyForProduct(client, organizationId, storeId, productId, draft);
  const required = tridRequiredForFamily(familyKey);
  const present = tridPresentFromDraft(draft, productId);

  let blocker: string | null = null;
  if (disputed) blocker = "disputed_source_row";
  else if (!productId) blocker = "product_linkage_unresolved";
  else if (!familyClaimReady) blocker = "family_not_claim_ready_in_v3_dryrun";

  const reviewReason = reviewReasons.length ? reviewReasons.join("; ") : null;
  const status = derivePreviewStatus({ claimReady, disputed, blocker });

  return {
    preview_id: previewIdFromDedupe(draft.dedupe_key),
    family_key: familyKey,
    status,
    product_id: productId,
    identifiers: {
      asin: draft.product.asin,
      fnsku: draft.product.fnsku,
      sku: draft.product.sku,
    },
    source_rows: draft.evidence_pointers.map((p) => ({ table: p.table, id: p.id })),
    clean_quantity: cleanQty,
    disputed_quantity_excluded: disputedExcluded,
    estimated_amazon_payout: money.estimated_amazon_payout,
    observed_reimbursement: money.observed_reimbursement,
    internal_cost_loss: money.internal_cost_loss,
    confidence: confFromScore(draft.confidence_score),
    claim_ready_preview: claimReady,
    blocker,
    review_reason: claimReady ? null : reviewReason,
    evidence_summary: draft.evidence_summary ?? draft.claim_reason,
    trid_reference_edges_required: required,
    trid_reference_edges_present: present,
    duplicate_prevention_key: draft.dedupe_key,
    recommended_next_action: recommendedAction({
      status,
      reviewReason,
      familyKey,
    }),
  };
}

/** Build read-only MVP claim preview items for the five safest-first families. */
export async function buildClaimPreviewReadmodelMvp(options: {
  client: SupabaseClient;
  pgClient?: pg.Client | null;
  organizationId: string;
  storeId: string;
  from?: string | null;
  to?: string | null;
  rowLimit?: number;
  families?: readonly ClaimPreviewMvpFamilyKey[];
}): Promise<ClaimPreviewReadmodelMvpPayload> {
  const rowLimit = options.rowLimit ?? 80;
  const familyKeys = [...(options.families ?? CLAIM_PREVIEW_MVP_FAMILIES)];
  const { settings } = await loadClaimIntakeSettings(options.client, options.organizationId);
  const window = resolveClaimIntakeWindow(settings, options.from ?? null, options.to ?? null);

  const sourceKinds = [
    ...new Set(
      familyKeys.flatMap((k) => INTAKE_BRIDGE[k]?.source_kinds ?? []).filter(Boolean),
    ),
  ] as ClaimSourceKind[];

  const allDrafts = await collectDrafts(
    options.client,
    options.organizationId,
    options.storeId,
    sourceKinds,
    window,
    rowLimit * 3,
  );

  const epDisputedTotal = await expectedPackageDisputedTotal(
    options.client,
    options.organizationId,
    options.storeId,
  );

  const items: ClaimPreviewItem[] = [];
  const perFamilyLimit = Math.ceil(rowLimit / familyKeys.length);

  for (const familyKey of familyKeys) {
    const familyDrafts = allDrafts.filter((d) => draftMapsToFamily(d, familyKey));
    const familyDisputed =
      familyKey === "removal_order_discrepancy" || familyKey === "removal_shipment_missing"
        ? epDisputedTotal
        : null;

    const sorted = [...familyDrafts].sort(
      (a, b) =>
        (b.recovery_value ?? b.expected_amount ?? 0) - (a.recovery_value ?? a.expected_amount ?? 0),
    );

    for (const draft of sorted.slice(0, perFamilyLimit)) {
      items.push(
        await draftToPreviewItem(
          options.client,
          options.organizationId,
          options.storeId,
          familyKey,
          draft,
          familyDisputed,
        ),
      );
    }
  }

  items.sort(
    (a, b) =>
      (b.observed_reimbursement ?? b.estimated_amazon_payout ?? 0) -
      (a.observed_reimbursement ?? a.estimated_amazon_payout ?? 0),
  );

  const blockerCounts = new Map<string, number>();
  for (const item of items) {
    const key = item.blocker ?? item.review_reason ?? "none";
    blockerCounts.set(key, (blockerCounts.get(key) ?? 0) + 1);
  }
  const topBlockers = [...blockerCounts.entries()]
    .map(([blocker, count]) => ({ blocker, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const families: ClaimPreviewFamilySummary[] = familyKeys.map((family_key) => {
    const famItems = items.filter((i) => i.family_key === family_key);
    return {
      family_key,
      preview_item_count: famItems.length,
      claim_ready_count: famItems.filter((i) => i.claim_ready_preview).length,
      review_deferred_count: famItems.filter((i) => !i.claim_ready_preview).length,
      disputed_excluded_total:
        family_key === "removal_order_discrepancy" || family_key === "removal_shipment_missing"
          ? epDisputedTotal
          : null,
    };
  });

  const claimReadyFamilies = families.filter((f) => f.claim_ready_count > 0).length;
  const safe: ClaimPreviewReadmodelMvpPayload["SAFE_TO_PUSH"] =
    items.length > 0 && claimReadyFamilies >= 2 ? "yes" : items.length > 0 ? "conditional" : "no";

  return {
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    no_ai_calls: true,
    generated_at: new Date().toISOString(),
    organization_id: options.organizationId,
    store_id: options.storeId,
    window,
    preview_family_count: familyKeys.length,
    preview_item_count: items.length,
    families,
    items: items.slice(0, rowLimit),
    top_blockers: topBlockers,
    SAFE_TO_PUSH: safe,
  };
}

/** Static verification — generators registered for MVP families (read-only). */
export function claimPreviewMvpGeneratorCoverage(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of CLAIM_PREVIEW_MVP_FAMILIES) {
    const kinds = INTAKE_BRIDGE[key]?.source_kinds ?? [];
    out[key] = kinds.flatMap((k) => {
      const gen = CLAIM_INTAKE_GENERATORS.find((g) => g.source_kind === k);
      return gen ? [gen.title] : [];
    });
  }
  return out;
}
