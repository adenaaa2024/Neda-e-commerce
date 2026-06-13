import type { SupabaseClient } from "@supabase/supabase-js";

import { claimInboxStr, projectClaimCandidatesBatch, type ProjectedCandidate } from "@/lib/claim-inbox-projection";
import { buildProductLinkageDisplayContracts } from "@/lib/product-linkage-display-enrich";
import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import { loadMaterializedCandidateEdges } from "@/lib/claims/edges/claim-reference-edge-materializer";

import {
  buildClaimCenterBadges,
  V1_STATUS_LABELS,
} from "./claim-center-v1-badges";
import {
  computeCanonicalWindow,
  observedWindowFromMetadata,
} from "./claim-center-v1-window";
import { attachMoneyProjections } from "./claim-center-candidate-money";
import { attachPhysicalReturnMvpFields } from "./claim-center-physical-return-mvp";
import { attachTwinMetadataToRows } from "./claim-center-twin-grouping";
import { deriveEligibilityDisplay } from "./claim-center-eligibility-display";
import {
  CLAIM_LIFECYCLE_STATUS_LABELS,
  buildPolicyWarnings,
  deriveClaimLifecycleStatus,
  loadEffectiveClaimIntakePolicy,
  mapLifecycleToV1StatusGroup,
  type ClaimIntakeEffectivePolicy,
} from "../intake/claim-intake-policy-contract";
import { aggregateClaimCenterMoney } from "./claim-center-money-contract";
import { computeQueueCounts } from "./claim-center-queue-semantics";
import type {
  ClaimCenterDashboardKpis,
  ClaimCenterQueryMeta,
  ClaimCenterV1Row,
  ClaimCenterV1StatusGroup,
} from "./claim-center-v1-types";

function str(v: unknown): string | null {
  return claimInboxStr(v);
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

function meta(row: Record<string, unknown>): Record<string, unknown> {
  const m = row.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

const EXTERNAL_FILED = new Set(["submitted", "pending", "investigating", "pending_amazon"]);
const EXTERNAL_REIMBURSED = new Set(["reimbursed", "approved", "paid"]);
const EXTERNAL_REJECTED = new Set(["denied", "rejected", "closed_denied"]);

export function deriveV1StatusGroup(args: {
  row: Record<string, unknown>;
  projection: ProjectedCandidate | null;
  ambiguity_pending: boolean;
  canonical_window_status: string;
  orbit_external_case_status: string | null;
}): ClaimCenterV1StatusGroup {
  if (str(args.row.rejected_at) || str(args.row.candidate_status) === "rejected") return "rejected";
  if (str(args.row.quarantined_at) && str(args.row.candidate_status) === "quarantined") return "rejected";

  const ext = (args.orbit_external_case_status ?? "").toLowerCase();
  if (EXTERNAL_REJECTED.has(ext)) return "rejected";
  if (EXTERNAL_REIMBURSED.has(ext)) return "reimbursed";
  if (EXTERNAL_FILED.has(ext)) return "filed";

  if (args.canonical_window_status === "expired") return "expired";

  const bucket = args.projection?.final_bucket;
  const queue = args.projection?.inbox_queue;

  if (args.ambiguity_pending || bucket === "ambiguous") return "blocked_reference_conflict";
  if (queue === "needs_product_link" || queue === "pim_blocked") return "blocked_product_link";

  if (bucket === "safe_update_candidate" && str(args.row.evidence_status) === "complete" && !args.ambiguity_pending) {
    return "ready_to_file";
  }

  if (
    str(args.row.evidence_status) === "complete" ||
    str(args.row.evidence_status) === "partial" ||
    queue === "ready_for_review"
  ) {
    if (queue === "ready_for_review" && str(args.row.evidence_status) !== "missing") return "evidence_ready";
  }

  if (queue === "evidence_missing" || queue === "legacy_source_broken" || queue === "ineligible_pre_cutoff") {
    return "needs_review";
  }

  if (str(args.row.candidate_status) === "detected") return "new";
  return "needs_review";
}

function productUnresolvedReason(projection: ProjectedCandidate | null): string | null {
  if (!projection) return "Projection unavailable";
  if (projection.final_bucket === "blocked_pim") return "Product identifier blocked by PIM policy";
  if (projection.final_bucket === "ambiguous") return "Ambiguous product identifier match";
  if (projection.inbox_queue === "needs_product_link") return "No product link resolved";
  if (!projection.proposed_resolved_product_id) return "Identifiers did not resolve to a product";
  return null;
}

function productStoryHref(
  linkage: ProductLinkageDisplayContract | null,
  row: Record<string, unknown>,
): string | null {
  if (!linkage?.is_resolved || !linkage.resolved_product_id) return null;
  const asin = linkage.asin ?? str(row.asin);
  if (asin) return `/dashboard/products?search=${encodeURIComponent(asin)}`;
  return `/dashboard/products?search=${encodeURIComponent(linkage.resolved_product_id)}`;
}

export async function mapRowsToClaimCenterV1(
  client: SupabaseClient,
  organizationId: string,
  rows: Record<string, unknown>[],
  policy: ClaimIntakeEffectivePolicy,
  edgeCounts?: Map<string, { count: number; ambiguity: boolean }>,
): Promise<ClaimCenterV1Row[]> {
  if (!rows.length) return [];

  const proj = await projectClaimCandidatesBatch(client, rows, organizationId);
  const inputs = rows.map((row) => ({
    source_table: str(row.source_table) ?? "claim_candidates",
    source_row_id: str(row.source_row_id) ?? str(row.id) ?? "",
    row,
  }));
  const linkages = await buildProductLinkageDisplayContracts(organizationId, inputs);

  const ids = rows.map((r) => str(r.id)).filter((id): id is string => !!id);
  let edgeMap = edgeCounts;
  if (!edgeMap) {
    const edges = await loadMaterializedCandidateEdges(client, organizationId, ids);
    edgeMap = new Map();
    for (const [cid, list] of edges) {
      const ambiguity = list.some((e) => !!str(e.ambiguity_group_key));
      edgeMap.set(cid, { count: list.length, ambiguity });
    }
  }

  const returnItemIds = [
    ...new Set(
      rows
        .filter((r) => str(r.source_table) === "return_items")
        .map((r) => str(r.source_row_id))
        .filter((id): id is string => !!id),
    ),
  ];
  const expirationByReturnItem = new Map<string, string | null>();
  if (returnItemIds.length) {
    const { data: riRows } = await client
      .from("return_items")
      .select("id, expiration_date")
      .eq("organization_id", organizationId)
      .in("id", returnItemIds.slice(0, 200));
    for (const ri of (riRows ?? []) as Array<{ id: string; expiration_date?: unknown }>) {
      const exp = str(ri.expiration_date);
      expirationByReturnItem.set(String(ri.id), exp);
    }
  }

  const mapped = rows.map((row, i) => {
    const id = str(row.id) ?? "";
    const m = meta(row);
    const projection = proj.get(id) ?? null;
    const linkage = linkages[i] ?? null;
    const edgeInfo = edgeMap?.get(id) ?? { count: 0, ambiguity: false };

    const canonical = computeCanonicalWindow({
      eventDate: str(row.event_date),
      disputeDeadline: str(row.dispute_deadline),
      daysRemainingSnapshot: num(row.days_remaining),
      claimEligibilityWindowDays: policy.claim_eligibility_window_days,
      expirationWarningDays: policy.expiration_warning_days,
    });

    const orbitExternal = str(m.orbit_external_case_status) ?? str(m.external_case_status);
    const productLinked = !!linkage?.is_resolved;
    const sourceObserved = observedWindowFromMetadata(m);

    const productProposed = !!projection?.proposed_resolved_product_id && !productLinked;

    const badges = buildClaimCenterBadges({
      source_kind: str(row.source_kind),
      evidence_status: str(row.evidence_status),
      product_linked: productLinked,
      product_proposed: productProposed,
      reference_edge_count: edgeInfo.count,
      ambiguity_pending: edgeInfo.ambiguity,
      canonical_window_status: canonical.status,
      automation_allowed: projection?.automation_allowed ?? false,
      has_conflict: projection?.reason_codes?.includes("conflict") ?? projection?.final_bucket === "ambiguous",
      orbit_external_case_status: orbitExternal,
      orbit_import: !!str(m.orbit_import_batch_id),
    });

    const sourceTable = str(row.source_table) ?? "";
    const sourceRowId = str(row.source_row_id) ?? "";
    const scannerExpiration =
      sourceTable === "return_items" ? (expirationByReturnItem.get(sourceRowId) ?? null) : null;
    const lifecycleWithScanner = deriveClaimLifecycleStatus({
      source_kind: str(row.source_kind),
      event_date: str(row.event_date),
      dispute_deadline: str(row.dispute_deadline),
      days_remaining_snapshot: num(row.days_remaining),
      source_observed_window: sourceObserved,
      scanner_expiration_date: scannerExpiration,
      metadata: m,
      policy,
      evidence_status: str(row.evidence_status),
      product_linked: productLinked,
      reference_edge_count: edgeInfo.count,
      ambiguity_pending: edgeInfo.ambiguity,
      orbit_external_case_status: orbitExternal,
      candidate_status: str(row.candidate_status),
      rejected_at: str(row.rejected_at),
      inbox_queue: projection?.inbox_queue ?? "needs_product_link",
      final_bucket: projection?.final_bucket ?? "unresolved_no_identifiers",
      automation_allowed: projection?.automation_allowed ?? false,
      intake_run_id: str(row.intake_run_id),
      candidate_updated_at: str(row.updated_at),
    });

    const policy_warnings_final = buildPolicyWarnings({
      lifecycle: lifecycleWithScanner,
      policy,
      source_kind: str(row.source_kind),
      event_date: str(row.event_date),
      canonical_window: canonical,
      scanner_expiration_date: scannerExpiration,
      intake_run_id: str(row.intake_run_id),
      candidate_updated_at: str(row.updated_at),
    });

    const eligibility_display = deriveEligibilityDisplay({
      canonical_window: canonical,
      scanner_expiration_date: scannerExpiration,
      event_date: str(row.event_date),
      expiration_warning_days: policy.expiration_warning_days,
    });

    const base: ClaimCenterV1Row = {
      id,
      organization_id: str(row.organization_id) ?? organizationId,
      store_id: str(row.store_id),
      source_kind: str(row.source_kind),
      source_table: str(row.source_table) ?? "",
      source_row_id: str(row.source_row_id) ?? "",
      claim_family: str(row.claim_family),
      claim_reason: str(row.claim_reason),
      event_date: str(row.event_date),
      reference_id: str(row.reference_id),
      reference_type: str(row.reference_type),
      recovery_value: num(row.recovery_value),
      cogs_unit: num(row.cogs_unit),
      currency: str(row.currency),
      sku: str(row.sku),
      fnsku: str(row.fnsku),
      asin: str(row.asin),
      resolved_product_id: str(row.resolved_product_id),
      candidate_status: str(row.candidate_status),
      evidence_status: str(row.evidence_status),
      quarantined_at: str(row.quarantined_at),
      intake_run_id: str(row.intake_run_id),
      v1_status_group: mapLifecycleToV1StatusGroup(lifecycleWithScanner),
      v1_status_label:
        V1_STATUS_LABELS[mapLifecycleToV1StatusGroup(lifecycleWithScanner)] ??
        lifecycleWithScanner,
      lifecycle_status: lifecycleWithScanner,
      lifecycle_status_label: CLAIM_LIFECYCLE_STATUS_LABELS[lifecycleWithScanner],
      policy_warnings: policy_warnings_final,
      inbox_queue: projection?.inbox_queue ?? "needs_product_link",
      final_bucket: projection?.final_bucket ?? "unresolved_no_identifiers",
      automation_allowed: projection?.automation_allowed ?? false,
      reason_codes: projection?.reason_codes ?? [],
      badges,
      canonical_window: canonical,
      source_observed_window: observedWindowFromMetadata(m),
      orbit_evidence_summary: str(m.evidence_summary),
      orbit_external_case_status: orbitExternal,
      orbit_case_group: str(m.orbit_case_group),
      amazon_reference_id: str(m.amazon_reference_id),
      reference_edge_count: edgeInfo.count,
      ambiguity_pending: edgeInfo.ambiguity,
      product_linkage: linkage,
      product_unresolved_reason: productUnresolvedReason(projection),
      product_story_href: productStoryHref(linkage, row),
      created_at: str(row.created_at),
      updated_at: str(row.updated_at),
      eligibility_display,
    };
    return base;
  });

  return attachPhysicalReturnMvpFields(attachTwinMetadataToRows(attachMoneyProjections(mapped)));
}

const REVIEW_STATUS_GROUPS = new Set<ClaimCenterV1StatusGroup>([
  "needs_review",
  "blocked_product_link",
  "blocked_reference_conflict",
  "evidence_ready",
]);

export function aggregateDashboardKpis(rows: ClaimCenterV1Row[]): ClaimCenterDashboardKpis {
  const money = aggregateClaimCenterMoney(rows);

  let readyToFile = 0;
  let blockedProduct = 0;
  let evidenceMissing = 0;
  let evidencePreviewable = 0;
  let expiring = 0;
  let reviewBlockers = 0;

  for (const r of rows) {
    if (r.v1_status_group === "ready_to_file") readyToFile += 1;
    if (r.v1_status_group === "blocked_product_link") blockedProduct += 1;
    if (r.inbox_queue === "evidence_missing" || r.evidence_status === "missing") evidenceMissing += 1;
    if (r.evidence_status === "complete" || r.evidence_status === "partial") evidencePreviewable += 1;
    if (
      r.lifecycle_status === "closing_soon" ||
      r.eligibility_display?.status === "expiring_soon" ||
      r.canonical_window.status === "closing_soon"
    ) {
      expiring += 1;
    }
    if (REVIEW_STATUS_GROUPS.has(r.v1_status_group)) reviewBlockers += 1;
  }

  const queue_counts = computeQueueCounts(rows);

  return {
    recoverable_amount: money.potential_recovery_known_usd,
    ready_to_file_count: readyToFile,
    blocked_product_link_count: blockedProduct,
    evidence_missing_count: queue_counts.proof_count,
    expiring_soon_count: expiring,
    observed_filed_count: money.observed_filed_count,
    observed_reimbursed_count: money.observed_reimbursed_count,
    total_active: rows.length,
    money,
    evidence_previewable_count: evidencePreviewable,
    review_blocker_count: queue_counts.review_count,
    queue_counts,
  };
}

export async function countActiveCandidatesForOrg(
  client: SupabaseClient,
  organizationId: string,
  opts: {
    storeId?: string | null;
    includeQuarantined?: boolean;
    includeLegacySeed?: boolean;
  },
): Promise<number> {
  let q = client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);

  if (opts.storeId) q = q.eq("store_id", opts.storeId);
  if (!opts.includeQuarantined) q = q.is("quarantined_at", null);
  if (!opts.includeLegacySeed) q = q.neq("source_kind", "legacy_seed");

  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export function buildQueryMeta(args: {
  itemsReturned: number;
  totalScanned: number;
  sampleLimit: number;
  dbTotalCount?: number | null;
}): ClaimCenterQueryMeta {
  const dbTotal = args.dbTotalCount ?? null;
  const isSampleCapped = dbTotal != null ? dbTotal > args.sampleLimit : args.totalScanned >= args.sampleLimit;
  return {
    items_returned: args.itemsReturned,
    total_scanned: args.totalScanned,
    sample_limit: args.sampleLimit,
    is_sample_capped: isSampleCapped,
    is_limited_scan: args.totalScanned > args.itemsReturned,
    db_total_count: dbTotal,
  };
}

export async function fetchActiveCandidatesForOrg(
  client: SupabaseClient,
  organizationId: string,
  opts: {
    storeId?: string | null;
    listSelect: string;
    limit: number;
    includeQuarantined?: boolean;
    includeLegacySeed?: boolean;
  },
): Promise<Record<string, unknown>[]> {
  let q = client
    .from("claim_candidates")
    .select(opts.listSelect)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(opts.limit);

  if (opts.storeId) q = q.eq("store_id", opts.storeId);
  if (!opts.includeQuarantined) q = q.is("quarantined_at", null);
  if (!opts.includeLegacySeed) q = q.neq("source_kind", "legacy_seed");

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown) as Record<string, unknown>[];
}

export async function buildClaimCenterListResponse(
  client: SupabaseClient,
  organizationId: string,
  rows: Record<string, unknown>[],
  opts?: { storeId?: string | null; policy?: ClaimIntakeEffectivePolicy },
): Promise<ClaimCenterV1Row[]> {
  const policy =
    opts?.policy ??
    (await loadEffectiveClaimIntakePolicy(client, organizationId, opts?.storeId ?? null));
  return mapRowsToClaimCenterV1(client, organizationId, rows, policy);
}

export { loadEffectiveClaimIntakePolicy };
