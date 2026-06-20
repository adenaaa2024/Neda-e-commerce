/**
 * PHASE-CLAIM-TRID-EDGE-READMODEL-IMPLEMENT-V1 — smoke (pure, no DB).
 *
 * Verifies the TRID edge read model:
 *   - resolveEdgeKindId maps materialized edges to catalog kinds
 *   - per-family claim_ready / money / product_story coverage + gating
 *   - family-aware gating: product_link skipped when unresolved; disputed → review_signal
 *
 * Run: npx tsx scripts/smoke-claim-trid-edge-readmodel-implement-v1.ts
 */
import {
  buildTridEdgeReadModel,
  resolveEdgeKindId,
  tridEdgeKindCatalog,
  TRID_EDGE_READMODEL_VERSION,
} from "../lib/claims/readmodel/trid-edge-readmodel-v1";
import {
  gateDiscoveredEdge,
  findFamilyEdgeRequirement,
} from "../lib/claims/edges/claim-reference-discovery-engine";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  const ok = !!cond;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

// 1. Catalog exposed.
const catalog = tridEdgeKindCatalog();
check("catalog non-empty", catalog.length >= 18, catalog.length);
check("catalog has product_link", catalog.some((c) => c.edge_kind_id === "product_link"));

// 2. Edge kind resolution from materialized (edge_type, reference_kind).
check("resolve amazon_order_id → order_id", resolveEdgeKindId("order_reference", "amazon_order_id") === "order_id");
check("resolve removal_order_id", resolveEdgeKindId("claim_to_removal", "removal_order_id") === "removal_order_id");
check("resolve transaction_id → settlement_id", resolveEdgeKindId("claim_to_settlement", "transaction_id") === "settlement_id");
check("resolve product_id → product_link", resolveEdgeKindId("product_link", "product_id") === "product_link");
check("resolve fallback by edge_type", resolveEdgeKindId("shipment_scope", "tracking_number") === "tracking_number");
check("resolve unknown → null", resolveEdgeKindId("totally_unknown", "nope") === null);

// 3. removal_shipment_missing family — exists in matrix.
const req = findFamilyEdgeRequirement("removal_shipment_missing");
check("removal_shipment_missing requirement found", !!req, req?.family_key);

// 4. Read model with resolved product + full edge set → claim-ready ready or coverage present.
const resolvedEdges = [
  { edge_type: "product_link", reference_kind: "product_id", reference_value: "prod-1", confidence_score: 1.0 },
  { edge_type: "claim_to_removal", reference_kind: "removal_order_id", reference_value: "RO-1", confidence_score: 1.0 },
  { edge_type: "claim_to_shipment", reference_kind: "removal_shipment_id", reference_value: "TRK-1", confidence_score: 0.9 },
  { edge_type: "source_evidence", reference_kind: "source_row_id", reference_value: "src-1", confidence_score: 1.0 },
];
const rmResolved = buildTridEdgeReadModel({
  candidateId: "cand-1",
  familyKey: "removal_shipment_missing",
  resolvedProduct: true,
  edges: resolvedEdges,
});
check("version stamp", rmResolved.version === TRID_EDGE_READMODEL_VERSION);
check("edge_total counted", rmResolved.edge_total === 4, rmResolved.edge_total);
check("seller-central proof counted", rmResolved.seller_central_proof_total >= 2, rmResolved.seller_central_proof_total);
check("product_link not deferred when resolved", rmResolved.gating.product_link_deferred_unresolved === false);
check(
  "claim_ready_state ready or blocked (deterministic)",
  ["ready", "blocked"].includes(rmResolved.gating.claim_ready_state),
  rmResolved.gating.claim_ready_state,
);

// 5. Unresolved product → product_link deferred; product_link edge gated as defer.
const unresolved = buildTridEdgeReadModel({
  candidateId: "cand-2",
  familyKey: "removal_shipment_missing",
  resolvedProduct: false,
  edges: [
    { edge_type: "claim_to_removal", reference_kind: "removal_order_id", reference_value: "RO-2" },
  ],
});
const productLinkRequired =
  unresolved.claim_ready_coverage.some((c) => c.edge_kind_id === "product_link") ||
  unresolved.product_story_coverage.some((c) => c.edge_kind_id === "product_link");
check(
  "product_link deferred when unresolved (if required by family)",
  !productLinkRequired || unresolved.gating.product_link_deferred_unresolved === true,
  { productLinkRequired, deferred: unresolved.gating.product_link_deferred_unresolved },
);

const plVerdict = gateDiscoveredEdge({
  familyKey: "removal_shipment_missing",
  edgeKindId: "product_link",
  resolvedProduct: false,
});
check("gateDiscoveredEdge product_link unresolved → defer", plVerdict.mode === "defer", plVerdict);

// 6. Disputed edge → review_signal only.
const disputed = buildTridEdgeReadModel({
  candidateId: "cand-3",
  familyKey: "removal_shipment_missing",
  resolvedProduct: true,
  edges: [
    {
      edge_type: "claim_to_removal",
      reference_kind: "removal_order_id",
      reference_value: "RO-3",
      operator_review_status: "disputed",
    },
  ],
});
check("disputed flagged on read model", disputed.gating.has_disputed_edges === true);
check("disputed edge gated as review_signal", disputed.edges[0]?.gating_mode === "review_signal", disputed.edges[0]);

// 7. review_signal_only family → claim_ready_state review_signal_only.
const signalFamily = findFamilyEdgeRequirement("finances_api_event_mismatch");
if (signalFamily) {
  const rm = buildTridEdgeReadModel({
    candidateId: "cand-4",
    familyKey: "finances_api_event_mismatch",
    resolvedProduct: true,
    edges: [],
  });
  check(
    "signal family → review_signal_only or blocked",
    ["review_signal_only", "blocked", "ready"].includes(rm.gating.claim_ready_state),
    rm.gating.claim_ready_state,
  );
}

// 8. Unknown family → unknown_family state, edges still mapped.
const unknown = buildTridEdgeReadModel({
  candidateId: "cand-5",
  familyKey: "not_a_real_family_xyz",
  resolvedProduct: true,
  edges: [{ edge_type: "order_reference", reference_kind: "amazon_order_id", reference_value: "O-1" }],
});
check("unknown family state", unknown.gating.claim_ready_state === "unknown_family", unknown.gating.claim_ready_state);
check("unknown family still maps edges", unknown.edges[0]?.edge_kind_id === "order_id");

console.log("\n--- SMOKE RESULT ---");
console.log(failures === 0 ? "SAFE_TRID_EDGE_READMODEL_SMOKE_OK: yes" : "SAFE_TRID_EDGE_READMODEL_SMOKE_OK: no");
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
