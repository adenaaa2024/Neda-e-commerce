/**
 * PHASE-CLAIM-TRID-EDGE-READMODEL-IMPLEMENT-V1
 *
 * Per-candidate TRID edge read model. Exposes the canonical
 * TRID_EDGE_KIND_CATALOG together with a candidate's materialized
 * `claim_reference_edges` rows, enriched with the contract's
 * claim_ready / money / product_story requirement flags and a family-aware
 * gating verdict.
 *
 * Client-safe — pure data + types. No DB access, no claim mutation, no new
 * tables/columns. Reuses:
 *   - lib/claims/contracts/trid-edge-requirements-contract-v1.ts (catalog + family matrix)
 *   - lib/claims/edges/claim-reference-discovery-engine.ts (gateDiscoveredEdge)
 *
 * Materialized edges are loaded by callers via
 * `loadMaterializedCandidateEdges` and passed in as plain rows so this module
 * stays free of any Supabase dependency.
 */
import {
  MISSING_EDGE_BEHAVIOR_RULES,
  TRID_EDGE_KIND_CATALOG,
  type FamilyEdgeRequirement,
  type MissingEdgeBehavior,
  type TridEdgeKindId,
  type TridEdgeKindSpec,
} from "../contracts/trid-edge-requirements-contract-v1";
import {
  findFamilyEdgeRequirement,
  gateDiscoveredEdge,
  type DiscoveryEdgeGatingMode,
} from "../edges/claim-reference-discovery-engine";

export const TRID_EDGE_READMODEL_VERSION = "trid-edge-readmodel-v1" as const;

/** Edge kinds whose reference values are valid Seller Central proof. */
const SELLER_CENTRAL_PROOF_EDGE_KINDS: ReadonlySet<TridEdgeKindId> = new Set<TridEdgeKindId>([
  "order_id",
  "shipment_id",
  "removal_order_id",
  "removal_shipment_id",
  "tracking_number",
  "reimbursement_id",
  "settlement_id",
  "financial_event_group_id",
  "safet_reference",
  "observed_reimbursement",
  "inventory_ledger_reference",
]);

/** reference_kind → canonical edge kind (most specific). */
const REFERENCE_KIND_TO_EDGE_KIND: Record<string, TridEdgeKindId> = {
  amazon_order_id: "order_id",
  order_id: "order_id",
  removal_order_id: "removal_order_id",
  removal_shipment_id: "removal_shipment_id",
  shipment_id: "shipment_id",
  tracking_number: "tracking_number",
  delayed_not_received: "shipment_id",
  shipment_discrepancy: "shipment_id",
  package_code: "package_id",
  ledger_reference_id: "inventory_ledger_reference",
  reimbursement_id: "reimbursement_id",
  observed_reimbursement: "observed_reimbursement",
  settlement_id: "settlement_id",
  transaction_id: "settlement_id",
  financial_event_group_id: "financial_event_group_id",
  amazon_event_id: "financial_event_group_id",
  safet_claim_id: "safet_reference",
  product_id: "product_link",
  packaging_dimensions: "product_dimension_profile",
  return_item_id: "return_item_id",
  fee_preview_reference: "fee_preview_reference",
  monthly_storage_fee_reference: "monthly_storage_fee_reference",
  evidence: "scanner_evidence",
  scan_note: "scanner_evidence",
  source_row_id: "source_report_row",
  trid_key: "resolves",
};

/** edge_type → canonical edge kind (fallback when reference_kind is unknown). */
const EDGE_TYPE_TO_EDGE_KIND: Record<string, TridEdgeKindId> = {
  order_reference: "order_id",
  claim_to_removal: "removal_order_id",
  claim_to_shipment: "removal_shipment_id",
  shipment_scope: "tracking_number",
  ledger_reference: "inventory_ledger_reference",
  claim_to_reimbursement: "reimbursement_id",
  claim_to_settlement: "settlement_id",
  safet_reference: "safet_reference",
  product_link: "product_link",
  source_evidence: "source_report_row",
  financial_reference: "financial_reference",
  resolves: "resolves",
};

const CATALOG_BY_ID = new Map<TridEdgeKindId, TridEdgeKindSpec>(
  TRID_EDGE_KIND_CATALOG.map((spec) => [spec.edge_kind_id, spec]),
);

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/** Map a materialized edge row's (edge_type, reference_kind) to a catalog edge kind. */
export function resolveEdgeKindId(
  edgeType: string | null,
  referenceKind: string | null,
): TridEdgeKindId | null {
  const rk = str(referenceKind);
  if (rk && REFERENCE_KIND_TO_EDGE_KIND[rk]) return REFERENCE_KIND_TO_EDGE_KIND[rk];
  const et = str(edgeType);
  if (et && EDGE_TYPE_TO_EDGE_KIND[et]) return EDGE_TYPE_TO_EDGE_KIND[et];
  // Direct catalog id match as a last resort.
  if (rk && CATALOG_BY_ID.has(rk as TridEdgeKindId)) return rk as TridEdgeKindId;
  if (et && CATALOG_BY_ID.has(et as TridEdgeKindId)) return et as TridEdgeKindId;
  return null;
}

export type TridEdgeReadModelEdge = {
  edge_kind_id: TridEdgeKindId | null;
  edge_type: string | null;
  reference_kind: string | null;
  reference_value: string | null;
  to_source_table: string | null;
  to_source_row_id: string | null;
  confidence_score: number | null;
  ambiguity_group_key: string | null;
  operator_review_status: string | null;
  is_ambiguous: boolean;
  is_disputed: boolean;
  is_seller_central_proof: boolean;
  required_for_claim_ready: boolean;
  required_for_money: boolean;
  required_for_product_story: boolean;
  gating_mode: DiscoveryEdgeGatingMode | "uncatalogued";
  gating_reason: string;
};

export type TridEdgeCoverage = {
  edge_kind_id: TridEdgeKindId;
  present: boolean;
  edge_count: number;
  missing_behavior: MissingEdgeBehavior;
  missing_behavior_rule: string;
  is_seller_central_proof: boolean;
};

export type TridEdgeGating = {
  /** ready = all claim-ready edges present; blocked = a gap; review_signal_only = signal family. */
  claim_ready_state: "ready" | "blocked" | "review_signal_only" | "unknown_family";
  blocking_edge_kinds: TridEdgeKindId[];
  product_story_ready: boolean;
  product_story_gaps: TridEdgeKindId[];
  money_ready: boolean;
  money_gaps: TridEdgeKindId[];
  product_link_deferred_unresolved: boolean;
  has_disputed_edges: boolean;
  notes: string[];
};

export type TridEdgeReadModel = {
  version: typeof TRID_EDGE_READMODEL_VERSION;
  candidate_id: string | null;
  family_key: string | null;
  family_display_name: string | null;
  family_classification: string | null;
  resolved_product: boolean;
  edge_total: number;
  ambiguous_total: number;
  seller_central_proof_total: number;
  internal_only_total: number;
  edges: TridEdgeReadModelEdge[];
  grouped_by_kind: Record<string, TridEdgeReadModelEdge[]>;
  claim_ready_coverage: TridEdgeCoverage[];
  money_coverage: TridEdgeCoverage[];
  product_story_coverage: TridEdgeCoverage[];
  gating: TridEdgeGating;
};

/** Public, serializable view of the catalog for UI/read consumers. */
export function tridEdgeKindCatalog(): TridEdgeKindSpec[] {
  return [...TRID_EDGE_KIND_CATALOG];
}

function isDisputedRow(operatorReviewStatus: string | null, edgeType: string | null): boolean {
  const s = (operatorReviewStatus ?? "").toLowerCase();
  if (s === "disputed" || s === "rejected") return true;
  const et = (edgeType ?? "").toLowerCase();
  return et === "disputes" || et === "disputed";
}

function buildCoverage(
  requirement: FamilyEdgeRequirement | null,
  presentKinds: Map<TridEdgeKindId, number>,
  filter: (e: FamilyEdgeRequirement["edges"][number]) => boolean,
): TridEdgeCoverage[] {
  if (!requirement) return [];
  const seen = new Set<TridEdgeKindId>();
  const out: TridEdgeCoverage[] = [];
  for (const e of requirement.edges) {
    if (!filter(e)) continue;
    if (seen.has(e.edge_kind_id)) continue;
    seen.add(e.edge_kind_id);
    const count = presentKinds.get(e.edge_kind_id) ?? 0;
    out.push({
      edge_kind_id: e.edge_kind_id,
      present: count > 0,
      edge_count: count,
      missing_behavior: e.missing_behavior,
      missing_behavior_rule: MISSING_EDGE_BEHAVIOR_RULES[e.missing_behavior],
      is_seller_central_proof: SELLER_CENTRAL_PROOF_EDGE_KINDS.has(e.edge_kind_id),
    });
  }
  return out;
}

export type BuildTridEdgeReadModelArgs = {
  candidateId: string | null;
  familyKey: string | null;
  resolvedProduct: boolean;
  /** Materialized rows from loadMaterializedCandidateEdges (plain objects). */
  edges: Array<Record<string, unknown>>;
};

export function buildTridEdgeReadModel(args: BuildTridEdgeReadModelArgs): TridEdgeReadModel {
  const requirement = findFamilyEdgeRequirement(args.familyKey);
  const presentKinds = new Map<TridEdgeKindId, number>();
  let ambiguousTotal = 0;
  let sellerProofTotal = 0;
  let internalTotal = 0;
  let hasDisputed = false;

  const edges: TridEdgeReadModelEdge[] = args.edges.map((raw) => {
    const edgeType = str(raw.edge_type);
    const referenceKind = str(raw.reference_kind);
    const edgeKindId = resolveEdgeKindId(edgeType, referenceKind);
    const ambiguityGroupKey = str(raw.ambiguity_group_key);
    const operatorReviewStatus = str(raw.operator_review_status);
    const isAmbiguous = !!ambiguityGroupKey;
    const isDisputed = isDisputedRow(operatorReviewStatus, edgeType);
    const isSellerProof = edgeKindId ? SELLER_CENTRAL_PROOF_EDGE_KINDS.has(edgeKindId) : false;

    if (isAmbiguous) ambiguousTotal += 1;
    if (isDisputed) hasDisputed = true;
    if (edgeKindId) {
      presentKinds.set(edgeKindId, (presentKinds.get(edgeKindId) ?? 0) + 1);
      if (isSellerProof) sellerProofTotal += 1;
      else internalTotal += 1;
    }

    let gatingMode: TridEdgeReadModelEdge["gating_mode"] = "uncatalogued";
    let gatingReason = "edge kind not in catalog";
    if (edgeKindId) {
      const verdict = gateDiscoveredEdge({
        familyKey: args.familyKey,
        edgeKindId,
        resolvedProduct: args.resolvedProduct,
        disputed: isDisputed,
      });
      gatingMode = verdict.mode;
      gatingReason = verdict.reason;
    }

    const edgeReq = edgeKindId
      ? requirement?.edges.find((e) => e.edge_kind_id === edgeKindId) ?? null
      : null;

    return {
      edge_kind_id: edgeKindId,
      edge_type: edgeType,
      reference_kind: referenceKind,
      reference_value: str(raw.reference_value),
      to_source_table: str(raw.to_source_table),
      to_source_row_id: str(raw.to_source_row_id),
      confidence_score: num(raw.confidence_score),
      ambiguity_group_key: ambiguityGroupKey,
      operator_review_status: operatorReviewStatus,
      is_ambiguous: isAmbiguous,
      is_disputed: isDisputed,
      is_seller_central_proof: isSellerProof,
      required_for_claim_ready: edgeReq?.required_for_claim_ready ?? false,
      required_for_money: edgeReq?.required_for_money ?? false,
      required_for_product_story: edgeReq?.required_for_product_story ?? false,
      gating_mode: gatingMode,
      gating_reason: gatingReason,
    };
  });

  const grouped: Record<string, TridEdgeReadModelEdge[]> = {};
  for (const e of edges) {
    const key = e.edge_kind_id ?? e.reference_kind ?? e.edge_type ?? "unknown";
    grouped[key] = grouped[key] ?? [];
    grouped[key].push(e);
  }

  const claimReadyCoverage = buildCoverage(requirement, presentKinds, (e) => e.required_for_claim_ready);
  const moneyCoverage = buildCoverage(requirement, presentKinds, (e) => e.required_for_money);
  const storyCoverage = buildCoverage(requirement, presentKinds, (e) => e.required_for_product_story);

  const claimReadyMissing = claimReadyCoverage.filter((c) => !c.present);
  const moneyMissing = moneyCoverage.filter((c) => !c.present);
  const storyMissing = storyCoverage.filter((c) => !c.present);

  const productLinkRequired =
    claimReadyCoverage.some((c) => c.edge_kind_id === "product_link") ||
    storyCoverage.some((c) => c.edge_kind_id === "product_link");
  const productLinkPresent = (presentKinds.get("product_link") ?? 0) > 0;
  const productLinkDeferred = productLinkRequired && !productLinkPresent && !args.resolvedProduct;

  const notes: string[] = [];
  let claimReadyState: TridEdgeGating["claim_ready_state"];
  if (!requirement) {
    claimReadyState = "unknown_family";
    notes.push("Family not found in FAMILY_EDGE_REQUIREMENTS — gating limited to materialized edges.");
  } else if (
    requirement.classification === "review_signal_only" ||
    requirement.classification === "lifecycle_only"
  ) {
    claimReadyState = "review_signal_only";
    notes.push(`Family classification ${requirement.classification} — review signal only, never claim-ready.`);
  } else if (claimReadyMissing.length === 0) {
    claimReadyState = "ready";
  } else {
    claimReadyState = "blocked";
  }

  if (productLinkDeferred) {
    notes.push("product_link deferred until catalog identity resolves (no title/OCR auto-create).");
  }
  if (hasDisputed) {
    notes.push("Disputed edge(s) present — counted as review_signal only, not claim-ready lineage.");
  }
  if (ambiguousTotal > 0) {
    notes.push(`${ambiguousTotal} ambiguous edge(s) (ambiguity_group_key) — resolve before single-edge proof.`);
  }

  const gating: TridEdgeGating = {
    claim_ready_state: claimReadyState,
    blocking_edge_kinds: claimReadyMissing.map((c) => c.edge_kind_id),
    product_story_ready: requirement ? storyMissing.length === 0 : false,
    product_story_gaps: storyMissing.map((c) => c.edge_kind_id),
    money_ready: requirement ? moneyMissing.length === 0 : false,
    money_gaps: moneyMissing.map((c) => c.edge_kind_id),
    product_link_deferred_unresolved: productLinkDeferred,
    has_disputed_edges: hasDisputed,
    notes,
  };

  return {
    version: TRID_EDGE_READMODEL_VERSION,
    candidate_id: args.candidateId,
    family_key: requirement?.family_key ?? args.familyKey ?? null,
    family_display_name: requirement?.display_name ?? null,
    family_classification: requirement?.classification ?? null,
    resolved_product: args.resolvedProduct,
    edge_total: edges.length,
    ambiguous_total: ambiguousTotal,
    seller_central_proof_total: sellerProofTotal,
    internal_only_total: internalTotal,
    edges,
    grouped_by_kind: grouped,
    claim_ready_coverage: claimReadyCoverage,
    money_coverage: moneyCoverage,
    product_story_coverage: storyCoverage,
    gating,
  };
}
