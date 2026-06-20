/**
 * PHASE-PRODUCT-STORY-TRID-EDGE-UI-WIRE-V1
 *
 * Pure client-safe contract for the Product Story TRID reference timeline.
 * No DB access. No claim mutation. No new tables. No server-only imports.
 *
 * Takes a `TridEdgeReadModel` (built from materialized claim_reference_edges)
 * and candidate identity fields, returns:
 *   - ProductStoryTimeline — annotated events split by proof class
 *   - ReferenceStorySummary — narrative why/what/missing/blocker
 *
 * Reuses: edge kind IDs and seller-central-proof classification from
 * trid-edge-readmodel-v1.ts (the read model is built server-side and passed
 * to the client as plain JSON).
 */

export const PRODUCT_STORY_TRID_EDGE_UI_WIRE_V1 = {
  phase: "PHASE-PRODUCT-STORY-TRID-EDGE-UI-WIRE-V1",
  read_only: true,
  no_db_writes: true,
  no_claim_mutation: true,
  no_new_tables: true,
  seller_central_proof_filter_verified: true,
} as const;

/* ------------------------------------------------------------------ */
/* Event label catalog                                                  */
/* ------------------------------------------------------------------ */

export type ProductStoryEventSpec = {
  label: string;
  source_table: string;
  is_seller_central_proof: boolean;
  is_internal_only: boolean;
  family_hint: string;
};

export const EVENT_SPEC_BY_KIND: Record<string, ProductStoryEventSpec> = {
  removal_order_id: {
    label: "Removal order",
    source_table: "amazon_removals",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "removal_order_discrepancy",
  },
  removal_shipment_id: {
    label: "Removal shipment",
    source_table: "amazon_removal_shipments",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "removal_shipment_missing",
  },
  shipment_id: {
    label: "Inbound shipment",
    source_table: "expected_packages",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "removal_shipment_missing",
  },
  tracking_number: {
    label: "Carrier tracking",
    source_table: "packages / amazon_removal_shipments",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "physical_return_scanner_issue",
  },
  order_id: {
    label: "Amazon order",
    source_table: "amazon_returns / amazon_settlements",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "customer_return_not_reimbursed / refund_without_return",
  },
  return_item_id: {
    label: "Return scan",
    source_table: "return_items",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "physical_return_scanner_issue / customer_return_not_reimbursed",
  },
  inventory_ledger_reference: {
    label: "Inventory ledger event",
    source_table: "amazon_inventory_ledger",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "warehouse_lost_inventory / warehouse_damaged_inventory",
  },
  reimbursement_id: {
    label: "Expected reimbursement",
    source_table: "amazon_reimbursements",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "missing_reimbursement / partial_incorrect_reimbursement",
  },
  observed_reimbursement: {
    label: "Observed reimbursement",
    source_table: "amazon_reimbursements",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "cross-lane — never overwrites expected recovery",
  },
  settlement_id: {
    label: "Settlement",
    source_table: "amazon_settlements / amazon_transactions",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "settlement_refund_anomaly",
  },
  financial_event_group_id: {
    label: "Financial event",
    source_table: "amazon_finances_events",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "finances_api_event_mismatch",
  },
  safet_reference: {
    label: "SAFET claim",
    source_table: "amazon_safet_claims",
    is_seller_central_proof: true,
    is_internal_only: false,
    family_hint: "safet_followup",
  },
  fee_preview_reference: {
    label: "Fee preview reference",
    source_table: "amazon_fee_preview",
    is_seller_central_proof: false,
    is_internal_only: false,
    family_hint: "fba_fee_overcharge",
  },
  monthly_storage_fee_reference: {
    label: "Storage fee reference",
    source_table: "amazon_monthly_storage_fees",
    is_seller_central_proof: false,
    is_internal_only: false,
    family_hint: "monthly_storage_fee_overcharge",
  },
  financial_reference: {
    label: "Financial reference (FRR)",
    source_table: "financial_reference_resolver",
    is_seller_central_proof: false,
    is_internal_only: false,
    family_hint: "settlement / financial families",
  },
  resolves: {
    label: "Resolved financial reference",
    source_table: "financial_reference_resolver",
    is_seller_central_proof: false,
    is_internal_only: false,
    family_hint: "settlement families — single deterministic FRR match",
  },
  source_report_row: {
    label: "Report row anchor",
    source_table: "amazon_returns / amazon_removals / raw_report_uploads",
    is_seller_central_proof: false,
    is_internal_only: false,
    family_hint: "all claim families — candidate origin",
  },
  product_link: {
    label: "Product identity",
    source_table: "products",
    is_seller_central_proof: false,
    is_internal_only: true,
    family_hint: "all product-linked families",
  },
  package_id: {
    label: "Package scan (internal)",
    source_table: "packages",
    is_seller_central_proof: false,
    is_internal_only: true,
    family_hint: "physical_return_scanner_issue",
  },
  scanner_evidence: {
    label: "Scanner evidence",
    source_table: "claim_evidence / return_items",
    is_seller_central_proof: false,
    is_internal_only: true,
    family_hint: "physical_return_scanner_issue",
  },
  product_dimension_profile: {
    label: "Product dimension profile",
    source_table: "product_packaging_dimensions",
    is_seller_central_proof: false,
    is_internal_only: false,
    family_hint: "fba_fee_overcharge / dimension-based families",
  },
};

function eventSpec(edgeKindId: string | null): ProductStoryEventSpec {
  return (
    EVENT_SPEC_BY_KIND[edgeKindId ?? ""] ?? {
      label: edgeKindId ?? "Reference edge",
      source_table: "varies",
      is_seller_central_proof: false,
      is_internal_only: false,
      family_hint: "unknown",
    }
  );
}

/* ------------------------------------------------------------------ */
/* Timeline event types                                                 */
/* ------------------------------------------------------------------ */

export type ProductStoryTimelineEvent = {
  event_key: string;
  event_type: string;
  source_table: string;
  reference_id: string | null;
  edge_kind_id: string | null;
  edge_type: string | null;
  confidence: number | null;
  is_seller_central_proof: boolean;
  is_internal_only: boolean;
  is_ambiguous: boolean;
  is_disputed: boolean;
  gating_mode: string;
  claim_family_hint: string;
};

export type ProductStoryIdentity = {
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  resolved_product_id: string | null;
  product_title: string | null;
  identity_status: "resolved" | "unresolved";
};

export type ProductStoryTimeline = {
  phase: string;
  identity: ProductStoryIdentity;
  all_events: ProductStoryTimelineEvent[];
  seller_central_proof_events: ProductStoryTimelineEvent[];
  internal_only_events: ProductStoryTimelineEvent[];
  other_events: ProductStoryTimelineEvent[];
  seller_central_proof_count: number;
  internal_only_count: number;
  ambiguous_count: number;
  disputed_count: number;
};

/* ------------------------------------------------------------------ */
/* Reference Story narrative                                            */
/* ------------------------------------------------------------------ */

export type ReferenceStorySummary = {
  why_exists: string;
  supporting_references: string[];
  missing_references: string[];
  family_key: string | null;
  family_display_name: string | null;
  claim_ready_state: "ready" | "blocked" | "review_signal_only" | "unknown_family";
  can_become_claim: boolean;
  exact_blocker: string | null;
  other_opportunities_hint: boolean;
};

/* ------------------------------------------------------------------ */
/* Input shape accepted from the API JSON (plain objects, no import)   */
/* ------------------------------------------------------------------ */

type EdgeLike = {
  edge_kind_id?: string | null;
  edge_type?: string | null;
  reference_value?: string | null;
  to_source_table?: string | null;
  confidence_score?: number | null;
  is_seller_central_proof?: boolean;
  is_internal_only?: boolean;
  is_ambiguous?: boolean;
  is_disputed?: boolean;
  gating_mode?: string | null;
};

type CoverageLike = {
  edge_kind_id: string;
  present: boolean;
  missing_behavior?: string;
};

type GatingLike = {
  claim_ready_state: "ready" | "blocked" | "review_signal_only" | "unknown_family";
  blocking_edge_kinds?: string[];
  product_link_deferred_unresolved?: boolean;
  has_disputed_edges?: boolean;
  notes?: string[];
};

export type ReadModelLike = {
  candidate_id?: string | null;
  family_key?: string | null;
  family_display_name?: string | null;
  family_classification?: string | null;
  resolved_product?: boolean;
  edges?: EdgeLike[];
  claim_ready_coverage?: CoverageLike[];
  gating?: GatingLike;
};

/* ------------------------------------------------------------------ */
/* Builders (pure — no DB, no server imports)                           */
/* ------------------------------------------------------------------ */

export function buildProductStoryTimeline(args: {
  readModel: ReadModelLike;
  identity: Partial<ProductStoryIdentity>;
}): ProductStoryTimeline {
  const edges: ProductStoryTimelineEvent[] = (args.readModel.edges ?? []).map((e, idx) => {
    const spec = eventSpec(e.edge_kind_id ?? null);
    return {
      event_key: `edge-${idx}-${e.edge_kind_id ?? "unknown"}-${e.reference_value ?? idx}`,
      event_type: spec.label,
      source_table: e.to_source_table ?? spec.source_table,
      reference_id: e.reference_value ?? null,
      edge_kind_id: e.edge_kind_id ?? null,
      edge_type: e.edge_type ?? null,
      confidence: typeof e.confidence_score === "number" ? e.confidence_score : null,
      is_seller_central_proof: e.is_seller_central_proof ?? spec.is_seller_central_proof,
      is_internal_only: e.is_internal_only ?? spec.is_internal_only,
      is_ambiguous: e.is_ambiguous ?? false,
      is_disputed: e.is_disputed ?? false,
      gating_mode: e.gating_mode ?? "active",
      claim_family_hint: spec.family_hint,
    };
  });

  const identity: ProductStoryIdentity = {
    sku: args.identity.sku ?? null,
    fnsku: args.identity.fnsku ?? null,
    asin: args.identity.asin ?? null,
    upc: args.identity.upc ?? null,
    resolved_product_id: args.identity.resolved_product_id ?? null,
    product_title: args.identity.product_title ?? null,
    identity_status: args.identity.resolved_product_id ? "resolved" : "unresolved",
  };

  const scProof = edges.filter((e) => e.is_seller_central_proof && !e.is_internal_only);
  const internal = edges.filter((e) => e.is_internal_only);
  const other = edges.filter((e) => !e.is_seller_central_proof && !e.is_internal_only);

  return {
    phase: PRODUCT_STORY_TRID_EDGE_UI_WIRE_V1.phase,
    identity,
    all_events: edges,
    seller_central_proof_events: scProof,
    internal_only_events: internal,
    other_events: other,
    seller_central_proof_count: scProof.length,
    internal_only_count: internal.length,
    ambiguous_count: edges.filter((e) => e.is_ambiguous).length,
    disputed_count: edges.filter((e) => e.is_disputed).length,
  };
}

export function buildReferenceStorySummary(readModel: ReadModelLike): ReferenceStorySummary {
  const gating = readModel.gating;
  const claimReadyState = gating?.claim_ready_state ?? "unknown_family";

  const coverage = readModel.claim_ready_coverage ?? [];
  const missing = coverage.filter((c) => !c.present).map((c) => {
    const spec = eventSpec(c.edge_kind_id);
    return `${spec.label} (${c.edge_kind_id})`;
  });
  const blocking = gating?.blocking_edge_kinds ?? [];
  const hasProductLinkDeferred = gating?.product_link_deferred_unresolved ?? false;

  const sourceEdge = (readModel.edges ?? []).find(
    (e) => e.edge_kind_id === "source_report_row" || e.edge_kind_id === "return_item_id",
  );
  const familyName = readModel.family_display_name ?? readModel.family_key ?? "unknown family";

  let whyExists = `This candidate belongs to the "${familyName}" claim family.`;
  if (sourceEdge?.to_source_table) {
    whyExists += ` It was generated from a ${sourceEdge.to_source_table} row`;
    if (sourceEdge.reference_value) whyExists += ` (ref: ${sourceEdge.reference_value})`;
    whyExists += ".";
  }
  if (hasProductLinkDeferred) {
    whyExists += " Product identity is not yet resolved — no auto-create from title or OCR.";
  }

  const supportingRefs = (readModel.edges ?? [])
    .filter((e) => e.is_seller_central_proof && e.reference_value)
    .map((e) => `${eventSpec(e.edge_kind_id ?? null).label}: ${e.reference_value}`);

  const exactBlocker =
    blocking.length > 0
      ? blocking.map((k) => `${eventSpec(k).label} (${k})`).join("; ")
      : hasProductLinkDeferred
        ? "Product identity unresolved — catalog link required before trusted money"
        : null;

  return {
    why_exists: whyExists,
    supporting_references: supportingRefs,
    missing_references: missing,
    family_key: readModel.family_key ?? null,
    family_display_name: readModel.family_display_name ?? null,
    claim_ready_state: claimReadyState,
    can_become_claim: claimReadyState === "ready",
    exact_blocker: exactBlocker,
    other_opportunities_hint: true,
  };
}
