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
  loadClaimEligibilityWindowDays,
  observedWindowFromMetadata,
} from "./claim-center-v1-window";
import type {
  ClaimCenterDashboardKpis,
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
  windowDays: number,
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

  return rows.map((row, i) => {
    const id = str(row.id) ?? "";
    const m = meta(row);
    const projection = proj.get(id) ?? null;
    const linkage = linkages[i] ?? null;
    const edgeInfo = edgeMap?.get(id) ?? { count: 0, ambiguity: false };

    const canonical = computeCanonicalWindow({
      eventDate: str(row.event_date),
      disputeDeadline: str(row.dispute_deadline),
      daysRemainingSnapshot: num(row.days_remaining),
      claimEligibilityWindowDays: windowDays,
    });

    const orbitExternal = str(m.orbit_external_case_status) ?? str(m.external_case_status);
    const v1Status = deriveV1StatusGroup({
      row,
      projection,
      ambiguity_pending: edgeInfo.ambiguity,
      canonical_window_status: canonical.status,
      orbit_external_case_status: orbitExternal,
    });

    const productLinked = !!linkage?.is_resolved;
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

    return {
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
      v1_status_group: v1Status,
      v1_status_label: V1_STATUS_LABELS[v1Status] ?? v1Status,
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
    };
  });
}

export function aggregateDashboardKpis(rows: ClaimCenterV1Row[]): ClaimCenterDashboardKpis {
  let recoverable = 0;
  let ready = 0;
  let blockedProduct = 0;
  let evidenceMissing = 0;
  let expiring = 0;
  let filed = 0;
  let reimbursed = 0;

  for (const r of rows) {
    recoverable += r.recovery_value ?? 0;
    if (r.v1_status_group === "ready_to_file" || r.v1_status_group === "evidence_ready") ready += 1;
    if (r.v1_status_group === "blocked_product_link") blockedProduct += 1;
    if (r.inbox_queue === "evidence_missing" || r.evidence_status === "missing") evidenceMissing += 1;
    if (r.canonical_window.status === "closing_soon") expiring += 1;
    if (r.v1_status_group === "filed") filed += 1;
    if (r.v1_status_group === "reimbursed") reimbursed += 1;
  }

  return {
    recoverable_amount: Math.round(recoverable * 100) / 100,
    ready_for_review_count: ready,
    blocked_product_link_count: blockedProduct,
    evidence_missing_count: evidenceMissing,
    expiring_soon_count: expiring,
    filed_count: filed,
    reimbursed_count: reimbursed,
    total_active: rows.length,
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
): Promise<ClaimCenterV1Row[]> {
  const windowDays = await loadClaimEligibilityWindowDays(client, organizationId);
  return mapRowsToClaimCenterV1(client, organizationId, rows, windowDays);
}
