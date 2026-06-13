/**
 * PHASE-CLAIM-TRID-EDGE-REQUIREMENTS-CONTRACT-V1
 * Read-only TRID/source lineage contract — no DB writes.
 *
 * Defines which reference edges each claim family needs so calculations,
 * evidence, duplicate prevention, Product Story, and reimbursement matching
 * share one lineage vocabulary.
 */
import {
  CLAIM_FAMILY_MATRIX_V3,
  type ClaimFamilyMatrixV3Entry,
} from "./claim-family-algorithm-matrix-v3-official-amazon-coverage";

export type MissingEdgeBehavior =
  | "review_signal_only"
  | "defer_until_linkage"
  | "low_confidence"
  | "exclude";

export type TridEdgeKindId =
  | "product_link"
  | "source_report_row"
  | "order_id"
  | "shipment_id"
  | "removal_order_id"
  | "removal_shipment_id"
  | "tracking_number"
  | "package_id"
  | "return_item_id"
  | "inventory_ledger_reference"
  | "reimbursement_id"
  | "settlement_id"
  | "financial_event_group_id"
  | "safet_reference"
  | "fee_preview_reference"
  | "monthly_storage_fee_reference"
  | "product_dimension_profile"
  | "scanner_evidence"
  | "observed_reimbursement"
  | "financial_reference"
  | "resolves";

/** Canonical edge kind spec — maps to claim_reference_edges columns + discovery rules. */
export type TridEdgeKindSpec = {
  edge_kind_id: TridEdgeKindId;
  edge_type: string;
  reference_kind: string;
  source_table: string;
  source_id_column: string;
  reference_value_column: string;
  default_confidence: number;
  ambiguous_confidence: number;
  duplicate_prevention_key: string;
  /** Default when edge is required for claim_ready but absent. */
  missing_when_required_for_claim_ready: MissingEdgeBehavior;
  /** Default when edge is required for money but absent. */
  missing_when_required_for_money: MissingEdgeBehavior;
  notes: string;
};

export const TRID_EDGE_KIND_CATALOG: readonly TridEdgeKindSpec[] = [
  {
    edge_kind_id: "product_link",
    edge_type: "product_link",
    reference_kind: "product_id",
    source_table: "products",
    source_id_column: "id",
    reference_value_column: "resolved_product_id on claim_candidates",
    default_confidence: 1.0,
    ambiguous_confidence: 0,
    duplicate_prevention_key: "org|candidate|product_link|products|{product_id}|product_id|{product_id}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "exclude",
    notes: "NEVER from title/OCR/raw report auto-create. Requires deterministic resolver match to products.id.",
  },
  {
    edge_kind_id: "source_report_row",
    edge_type: "source_evidence",
    reference_kind: "source_row_id",
    source_table: "varies per family (amazon_returns, amazon_removals, raw_report_uploads)",
    source_id_column: "id",
    reference_value_column: "claim_candidates.source_row_id",
    default_confidence: 1.0,
    ambiguous_confidence: 0.85,
    duplicate_prevention_key: "org|candidate|source_evidence|{source_table}|{source_row_id}|source_row_id|{id}",
    missing_when_required_for_claim_ready: "low_confidence",
    missing_when_required_for_money: "defer_until_linkage",
    notes: "Anchors candidate to normalized report row; includes raw_report_uploads via upload_id when wired.",
  },
  {
    edge_kind_id: "order_id",
    edge_type: "order_reference",
    reference_kind: "amazon_order_id",
    source_table: "return_items | amazon_returns | amazon_settlements | financial_reference_resolver",
    source_id_column: "order_id",
    reference_value_column: "order_id",
    default_confidence: 0.9,
    ambiguous_confidence: 0.7,
    duplicate_prevention_key: "org|candidate|order_reference||amazon_order_id|{order_id}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Financial join spine; ambiguous when multiple FRR rows per order → ambiguity_group_key.",
  },
  {
    edge_kind_id: "shipment_id",
    edge_type: "claim_to_shipment",
    reference_kind: "shipment_id",
    source_table: "amazon_removal_shipments | expected_packages",
    source_id_column: "id",
    reference_value_column: "tracking_number OR order_id per family",
    default_confidence: 0.9,
    ambiguous_confidence: 0.6,
    duplicate_prevention_key: "org|candidate|claim_to_shipment|{table}|{row_id}|shipment_id|{value}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Inbound/removal shipment grain — not interchangeable with package_id.",
  },
  {
    edge_kind_id: "removal_order_id",
    edge_type: "claim_to_removal",
    reference_kind: "removal_order_id",
    source_table: "amazon_removals",
    source_id_column: "id",
    reference_value_column: "order_id",
    default_confidence: 1.0,
    ambiguous_confidence: 0.7,
    duplicate_prevention_key: "org|candidate|claim_to_removal|amazon_removals|{id}|removal_order_id|{order_id}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Requires resolvable source_row_id pointer on candidate (Phase 7C pointer repair).",
  },
  {
    edge_kind_id: "removal_shipment_id",
    edge_type: "claim_to_shipment",
    reference_kind: "removal_shipment_id",
    source_table: "amazon_removal_shipments",
    source_id_column: "id",
    reference_value_column: "tracking_number",
    default_confidence: 0.9,
    ambiguous_confidence: 0.6,
    duplicate_prevention_key: "org|candidate|claim_to_shipment|amazon_removal_shipments|{id}|tracking_number|{tracking}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Aggregate one edge per candidate-order when multi-tracking (discovery engine).",
  },
  {
    edge_kind_id: "tracking_number",
    edge_type: "shipment_scope",
    reference_kind: "tracking_number",
    source_table: "packages | amazon_removal_shipments",
    source_id_column: "id",
    reference_value_column: "tracking_number",
    default_confidence: 1.0,
    ambiguous_confidence: 0.8,
    duplicate_prevention_key: "org|candidate|shipment_scope|{table}|{row_id}|tracking_number|{tracking}",
    missing_when_required_for_claim_ready: "low_confidence",
    missing_when_required_for_money: "exclude",
    notes: "Operational shipment scope — distinct from removal_order_id.",
  },
  {
    edge_kind_id: "package_id",
    edge_type: "shipment_scope",
    reference_kind: "package_code",
    source_table: "packages",
    source_id_column: "id",
    reference_value_column: "package_code",
    default_confidence: 1.0,
    ambiguous_confidence: 0.9,
    duplicate_prevention_key: "org|candidate|shipment_scope|packages|{id}|package_code|{code}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "exclude",
    notes: "Physical return MVP requires package_id on candidate or return_item join.",
  },
  {
    edge_kind_id: "return_item_id",
    edge_type: "source_evidence",
    reference_kind: "return_item_id",
    source_table: "return_items",
    source_id_column: "id",
    reference_value_column: "id",
    default_confidence: 1.0,
    ambiguous_confidence: 0.95,
    duplicate_prevention_key: "org|candidate|source_evidence|return_items|{id}|return_item_id|{id}",
    missing_when_required_for_claim_ready: "exclude",
    missing_when_required_for_money: "exclude",
    notes: "Scanner physical families: required. orbit_fra must populate return_item_id in metadata (generator fix).",
  },
  {
    edge_kind_id: "inventory_ledger_reference",
    edge_type: "ledger_reference",
    reference_kind: "ledger_reference_id",
    source_table: "amazon_inventory_ledger",
    source_id_column: "id",
    reference_value_column: "reference_id (often order_id)",
    default_confidence: 0.85,
    ambiguous_confidence: 0.7,
    duplicate_prevention_key: "org|candidate|ledger_reference|amazon_inventory_ledger|{id}|ledger_reference_id|{ref}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Ledger reference_id must overlap candidate order — staging gap for many rows.",
  },
  {
    edge_kind_id: "reimbursement_id",
    edge_type: "claim_to_reimbursement",
    reference_kind: "reimbursement_id",
    source_table: "amazon_reimbursements",
    source_id_column: "id",
    reference_value_column: "reimbursement_id",
    default_confidence: 1.0,
    ambiguous_confidence: 0.8,
    duplicate_prevention_key: "org|candidate|claim_to_reimbursement|amazon_reimbursements|{id}|reimbursement_id|{reimb_id}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Expected recovery lane — NOT the same as observed_reimbursement.",
  },
  {
    edge_kind_id: "settlement_id",
    edge_type: "claim_to_settlement",
    reference_kind: "settlement_id",
    source_table: "amazon_settlements | amazon_transactions",
    source_id_column: "id",
    reference_value_column: "settlement_id OR transaction row id",
    default_confidence: 0.9,
    ambiguous_confidence: 0.75,
    duplicate_prevention_key: "org|candidate|claim_to_settlement|{table}|{id}|settlement_id|{value}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Also covers transaction_id via claim_to_settlement edge_type alias.",
  },
  {
    edge_kind_id: "financial_event_group_id",
    edge_type: "financial_reference",
    reference_kind: "financial_event_group_id",
    source_table: "amazon_finances_events",
    source_id_column: "id",
    reference_value_column: "amazon_event_id",
    default_confidence: 0.85,
    ambiguous_confidence: 0.7,
    duplicate_prevention_key: "org|candidate|financial_reference|amazon_finances_events|{id}|financial_event_group_id|{event_id}",
    missing_when_required_for_claim_ready: "review_signal_only",
    missing_when_required_for_money: "defer_until_linkage",
    notes: "Citation layer — not claim-ready without settlement/reimbursement corroboration.",
  },
  {
    edge_kind_id: "safet_reference",
    edge_type: "safet_reference",
    reference_kind: "safet_claim_id",
    source_table: "amazon_safet_claims",
    source_id_column: "id",
    reference_value_column: "id",
    default_confidence: 1.0,
    ambiguous_confidence: 0.8,
    duplicate_prevention_key: "org|candidate|safet_reference|amazon_safet_claims|{id}|safet_claim_id|{id}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Staging table empty — edge rule exists but 0 rows until import.",
  },
  {
    edge_kind_id: "fee_preview_reference",
    edge_type: "financial_reference",
    reference_kind: "fee_preview_reference",
    source_table: "amazon_fee_preview (planned) | fee preview report rows",
    source_id_column: "id",
    reference_value_column: "asin/sku fee row key",
    default_confidence: 0.85,
    ambiguous_confidence: 0.7,
    duplicate_prevention_key: "org|candidate|financial_reference|amazon_fee_preview|{id}|fee_preview_reference|{key}",
    missing_when_required_for_claim_ready: "review_signal_only",
    missing_when_required_for_money: "defer_until_linkage",
    notes: "Fee overcharge families — expected_fee from fee preview, not sale price.",
  },
  {
    edge_kind_id: "monthly_storage_fee_reference",
    edge_type: "financial_reference",
    reference_kind: "monthly_storage_fee_reference",
    source_table: "amazon_monthly_storage_fees (planned)",
    source_id_column: "id",
    reference_value_column: "storage fee row key",
    default_confidence: 0.85,
    ambiguous_confidence: 0.7,
    duplicate_prevention_key: "org|candidate|financial_reference|amazon_monthly_storage_fees|{id}|monthly_storage_fee_reference|{key}",
    missing_when_required_for_claim_ready: "review_signal_only",
    missing_when_required_for_money: "defer_until_linkage",
    notes: "Storage overcharge gap = charged - expected storage fee.",
  },
  {
    edge_kind_id: "product_dimension_profile",
    edge_type: "product_link",
    reference_kind: "packaging_dimensions",
    source_table: "product_packaging_dimensions (PC04)",
    source_id_column: "product_id",
    reference_value_column: "product_id",
    default_confidence: 0.9,
    ambiguous_confidence: 0.7,
    duplicate_prevention_key: "org|candidate|product_link|product_packaging_dimensions|{product_id}|packaging_dimensions|{product_id}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "low_confidence",
    notes: "Dimension/weight fee families require PC04 profile — not title-based product edge.",
  },
  {
    edge_kind_id: "scanner_evidence",
    edge_type: "source_evidence",
    reference_kind: "evidence",
    source_table: "claim_evidence | return_items.photo_evidence",
    source_id_column: "id",
    reference_value_column: "storage_path | public_url | scan_note",
    default_confidence: 1.0,
    ambiguous_confidence: 0.5,
    duplicate_prevention_key: "org|candidate|source_evidence|{table}|{row}|evidence|{value}",
    missing_when_required_for_claim_ready: "defer_until_linkage",
    missing_when_required_for_money: "exclude",
    notes: "Physical return: photo OR claim_evidence row required for Proof tile; scan_note alone = low_confidence.",
  },
  {
    edge_kind_id: "observed_reimbursement",
    edge_type: "claim_to_reimbursement",
    reference_kind: "observed_reimbursement",
    source_table: "amazon_reimbursements",
    source_id_column: "id",
    reference_value_column: "amount_reimbursed SUM by matched keys",
    default_confidence: 1.0,
    ambiguous_confidence: 0.8,
    duplicate_prevention_key: "org|candidate|claim_to_reimbursement|amazon_reimbursements|{id}|observed_reimbursement|{amount}",
    missing_when_required_for_claim_ready: "exclude",
    missing_when_required_for_money: "low_confidence",
    notes: "SEPARATE from expected recovery. Never overwrites estimated_amazon_payout.",
  },
  {
    edge_kind_id: "financial_reference",
    edge_type: "financial_reference",
    reference_kind: "order_id",
    source_table: "financial_reference_resolver",
    source_id_column: "id",
    reference_value_column: "order_id | trid_key",
    default_confidence: 0.85,
    ambiguous_confidence: 0.7,
    duplicate_prevention_key: "org|candidate|financial_reference|financial_reference_resolver|{id}|order_id|{order}",
    missing_when_required_for_claim_ready: "low_confidence",
    missing_when_required_for_money: "defer_until_linkage",
    notes: "FRR join lane; use resolves edge when exactly one FRR match.",
  },
  {
    edge_kind_id: "resolves",
    edge_type: "resolves",
    reference_kind: "order_id",
    source_table: "financial_reference_resolver",
    source_id_column: "id",
    reference_value_column: "trid_key",
    default_confidence: 1.0,
    ambiguous_confidence: 0,
    duplicate_prevention_key: "org|candidate|resolves|financial_reference_resolver|{id}|order_id|{order}",
    missing_when_required_for_claim_ready: "exclude",
    missing_when_required_for_money: "low_confidence",
    notes: "Only when single deterministic FRR row per order; else financial_reference + operator selection.",
  },
];

/** Map legacy matrix string labels → canonical edge kind ids. */
const TRID_LABEL_ALIASES: Record<string, TridEdgeKindId[]> = {
  product_link: ["product_link"],
  "product_link (both SKUs)": ["product_link"],
  return_item: ["return_item_id"],
  return_reference: ["return_item_id", "source_report_row"],
  scanner_capture: ["scanner_evidence", "return_item_id"],
  evidence_image: ["scanner_evidence"],
  order_reference: ["order_id"],
  shipment_scope: ["tracking_number"],
  package_id: ["package_id"],
  tracking_number: ["tracking_number"],
  claim_to_removal: ["removal_order_id"],
  removal_order: ["removal_order_id"],
  claim_to_shipment: ["removal_shipment_id", "shipment_id"],
  removal_shipment: ["removal_shipment_id"],
  shipment_reference: ["shipment_id", "tracking_number"],
  ledger_reference: ["inventory_ledger_reference"],
  claim_to_reimbursement: ["reimbursement_id", "observed_reimbursement"],
  settlement_reference: ["settlement_id"],
  claim_to_settlement: ["settlement_id"],
  safet_claim: ["safet_reference"],
  safet_reference: ["safet_reference"],
  fee_preview_reference: ["fee_preview_reference"],
  storage_fee_reference: ["monthly_storage_fee_reference"],
  packaging_dimensions: ["product_dimension_profile"],
  finances_event: ["financial_event_group_id"],
  inbound_shipment: ["shipment_id", "order_id"],
  listing_reference: ["source_report_row"],
  orbit_source_row: ["source_report_row"],
  source_evidence: ["source_report_row", "scanner_evidence"],
  scanner_evidence: ["scanner_evidence"],
  financial_reference: ["financial_reference"],
  resolves: ["resolves"],
};

function parseTridLabels(labels: string[]): TridEdgeKindId[] {
  const out = new Set<TridEdgeKindId>();
  for (const raw of labels) {
    const t = raw.trim();
    if (TRID_LABEL_ALIASES[t]) {
      for (const id of TRID_LABEL_ALIASES[t]) out.add(id);
      continue;
    }
  if (t.includes("negative space") || t.includes("absence")) {
      out.add("reimbursement_id");
      continue;
    }
    if (t.startsWith("All edges")) {
      out.add("product_link");
      out.add("source_report_row");
      out.add("financial_reference");
      continue;
    }
    // fallback: try direct catalog match
    const direct = TRID_EDGE_KIND_CATALOG.find((e) => e.edge_kind_id === t || e.edge_type === t);
    if (direct) out.add(direct.edge_kind_id);
  }
  return [...out];
}

export type FamilyEdgeRequirement = {
  family_key: string;
  display_name: string;
  classification: string;
  implementation_priority: string;
  product_linkage_requirement: string;
  edges: Array<{
    edge_kind_id: TridEdgeKindId;
    required_for_claim_ready: boolean;
    required_for_money: boolean;
    required_for_product_story: boolean;
    missing_behavior: MissingEdgeBehavior;
  }>;
  raw_trid_labels: string[];
};

function inferMissingBehavior(
  edgeId: TridEdgeKindId,
  family: ClaimFamilyMatrixV3Entry,
  forClaimReady: boolean,
): MissingEdgeBehavior {
  if (family.classification === "review_signal_only" || family.classification === "lifecycle_only") {
    return "review_signal_only";
  }
  if (edgeId === "product_link") {
    return family.product_linkage_requirement === "required_before_trusted_money"
      ? "defer_until_linkage"
      : "low_confidence";
  }
  if (edgeId === "scanner_evidence") return "defer_until_linkage";
  if (!forClaimReady) return "low_confidence";
  const spec = TRID_EDGE_KIND_CATALOG.find((e) => e.edge_kind_id === edgeId);
  return spec?.missing_when_required_for_claim_ready ?? "defer_until_linkage";
}

function buildFamilyRequirements(entry: ClaimFamilyMatrixV3Entry): FamilyEdgeRequirement {
  const edgeIds = parseTridLabels(entry.trid_edges_required);
  const needsProductForMoney = entry.product_linkage_requirement === "required_before_trusted_money";
  const needsProductForStory =
    entry.product_linkage_requirement === "required_before_trusted_money" ||
    entry.product_linkage_requirement === "required_before_product_story" ||
    entry.product_linkage_requirement === "recommended";

  const edges = edgeIds.map((edge_kind_id) => {
    const claimReady =
      entry.classification === "claim_family" &&
      edge_kind_id !== "observed_reimbursement" &&
      edge_kind_id !== "financial_event_group_id";
    const money =
      needsProductForMoney &&
      (edge_kind_id === "product_link" ||
        edge_kind_id === "reimbursement_id" ||
        edge_kind_id === "settlement_id" ||
        edge_kind_id === "observed_reimbursement" ||
        edge_kind_id === "inventory_ledger_reference" ||
        edge_kind_id === "fee_preview_reference" ||
        edge_kind_id === "monthly_storage_fee_reference" ||
        edge_kind_id === "product_dimension_profile" ||
        edge_kind_id === "financial_reference" ||
        edge_kind_id === "resolves");
    const story =
      needsProductForStory ||
      edge_kind_id === "return_item_id" ||
      edge_kind_id === "source_report_row" ||
      edge_kind_id === "tracking_number" ||
      edge_kind_id === "package_id" ||
      edge_kind_id === "scanner_evidence";

    return {
      edge_kind_id,
      required_for_claim_ready: claimReady,
      required_for_money: money,
      required_for_product_story: story,
      missing_behavior: inferMissingBehavior(edge_kind_id, entry, claimReady),
    };
  });

  return {
    family_key: entry.family_key,
    display_name: entry.display_name,
    classification: entry.classification,
    implementation_priority: entry.implementation_priority,
    product_linkage_requirement: entry.product_linkage_requirement,
    edges,
    raw_trid_labels: [...entry.trid_edges_required],
  };
}

export const FAMILY_EDGE_REQUIREMENTS: readonly FamilyEdgeRequirement[] =
  CLAIM_FAMILY_MATRIX_V3.map(buildFamilyRequirements);

export const SOURCE_TABLE_TO_REFERENCE_KIND: Record<string, string[]> = {
  return_items: ["return_item_id", "package_id", "tracking_number", "order_id", "scanner_evidence"],
  packages: ["package_id", "tracking_number"],
  products: ["product_id"],
  product_identifier_map: ["product_id (lookup only — not auto-create)"],
  amazon_returns: ["source_report_row", "order_id"],
  amazon_removals: ["removal_order_id", "source_report_row"],
  amazon_removal_shipments: ["removal_shipment_id", "tracking_number", "order_id"],
  amazon_reimbursements: ["reimbursement_id", "observed_reimbursement"],
  amazon_settlements: ["settlement_id", "order_id"],
  amazon_transactions: ["settlement_id", "transaction_id"],
  amazon_inventory_ledger: ["ledger_reference_id"],
  amazon_safet_claims: ["safet_claim_id"],
  amazon_finances_events: ["amazon_event_id"],
  financial_reference_resolver: ["order_id", "trid_key"],
  raw_report_uploads: ["upload_id", "source_report"],
  claim_evidence: ["evidence"],
  product_packaging_dimensions: ["packaging_dimensions"],
  expected_packages: ["source_report_row (clean only)"],
};

export const DUPLICATE_PREVENTION_KEYS = {
  natural_key_index: "uq_claim_reference_edges_candidate_natural",
  key_fields: [
    "organization_id",
    "candidate_id",
    "edge_type",
    "COALESCE(to_source_table,'')",
    "COALESCE(to_source_row_id,'')",
    "COALESCE(reference_kind,'')",
    "COALESCE(reference_value,'')",
  ],
  apply_strategy: "INSERT ... ON CONFLICT DO NOTHING (idempotent re-runs)",
  candidate_regeneration: "Same natural key — new candidate_id gets fresh edges; dedupe does not cross candidates",
  disputed_rows:
    "Disputed expected_packages / removal detail rows create review_signal edges only — never claim-ready lineage",
} as const;

export const MISSING_EDGE_BEHAVIOR_RULES: Record<MissingEdgeBehavior, string> = {
  review_signal_only:
    "Candidate may appear in review dashboard with lineage gap flag; NOT claim-ready; no money display as trusted",
  defer_until_linkage:
    "Candidate stays in Find Money / linkage queue; operator or resolver must close gap before claim-ready",
  low_confidence:
    "Edge may be materialized with reduced confidence_score; UI shows 'needs confirmation'",
  exclude:
    "Family candidate withheld or quarantined; no TRID edge insert attempted for that kind",
};

export const PRODUCT_STORY_LINEAGE_RULES = [
  "Product Story requires product_link (resolved products.id) before trusted product identity section.",
  "Product Story money section requires product_link AND (reimbursement_id OR settlement_id OR observed_reimbursement edge) — never sale_price alone.",
  "Scan/receive history requires return_item_id edge (or source_table=return_items resolvable pointer).",
  "Shipment/removal context requires tracking_number OR package_id OR removal_shipment_id edge.",
  "TRID references section reads materialized claim_reference_edges(candidate_id) merged with metadata.reference_edges (legacy).",
  "Unresolved identifier (fnsku only) shows PIM review CTA — no auto product create.",
  "Disputed source rows: review_signal only in timeline — not counted as claim-ready evidence.",
] as const;

export const CLAIM_READY_LINEAGE_RULES = [
  "claim_ready requires: source_event edge (source_report_row OR return_item_id) + product_link when family requires product.",
  "Physical return families additionally require scanner_evidence OR defer_until_linkage on Proof tile.",
  "Financial families require order_id OR settlement_id join + product_link when money family.",
  "No title-only product edge. No OCR auto-create. No legacy_seed as truth.",
  "Disputed EP/removal rows: review_signal_only — never promote to claim-ready quantity.",
  "Ambiguous FRR (>1 row per order): financial_reference edges with ambiguity_group_key; resolves edge withheld until operator accepts one.",
  "orbit_fra twins: dedupe prefers orbit_fra source_kind over scanner_physical_review when same source row.",
] as const;

export const MONEY_LINEAGE_RULES = [
  "expected_recovery (preliminary) may compute from normalized tables WITHOUT full TRID spine.",
  "trusted_money display requires: product_link + cost basis (cogs_unit chain) + money source edge (reimbursement/settlement/fee).",
  "observed_reimbursement is ALWAYS a separate edge/lane from estimated_amazon_payout — never overwrite.",
  "reimbursement_gap = estimated - observed only when BOTH lanes have edges and values.",
  "sale_price / product_prices.price: display context only — NEVER actual_cost_basis substitute.",
  "zero_unpriced flag when cost unknown — do not hide candidate; show UNPRICED badge.",
  "Fee families: fee_preview_reference or monthly_storage_fee_reference + product_dimension_profile when applicable.",
] as const;

export const ORBIT_FRA_RETURN_ITEM_LINK_GAP = {
  confirmed: true,
  gap:
    "orbit_fra candidates from return_items omitted return_item_id/package_id/pallet_id in extra_metadata at draft time",
  exact_fix_location:
    "lib/claims/intake/claim-orbit-fra-generator.ts — makeDraft extra_metadata (~line 835) adds return_item_id, package_id, pallet_id when category.source_table === 'return_items'",
  registry_mapping:
    "lib/claims/intake/claim-generator-registry.ts draftToInsertRow already maps metadata.return_item_id → claim_candidates.return_item_id",
  workaround_until_regeneration:
    "TRID discovery uses source_row_id fallback when source_table=return_items (confidence 0.95 vs 1.0)",
  fixed_in_code: true,
  candidates_regenerated_this_phase: false,
} as const;

export const IMPLEMENTATION_PRIORITY = {
  P0_physical_and_core: [
    "physical_return_scanner_issue",
    "customer_return_not_reimbursed",
    "removal_order_discrepancy",
    "removal_shipment_missing",
    "missing_reimbursement",
    "orbit_fra_fight_list",
  ],
  P1_financial_and_fees: [
    "refund_without_return",
    "partial_incorrect_reimbursement",
    "settlement_refund_anomaly",
    "fba_fee_overcharge",
    "monthly_storage_fee_overcharge",
    "warehouse_lost_inventory",
    "warehouse_damaged_inventory",
  ],
  P2_signals_and_gaps: [
    "stranded_inventory_signal",
    "expired_inventory_action_signal",
    "finances_api_event_mismatch",
    "safet_followup",
  ],
  deferred_review_only: FAMILY_EDGE_REQUIREMENTS
    .filter((f) => f.classification === "review_signal_only" || f.classification === "lifecycle_only")
    .map((f) => f.family_key),
} as const;

export type TridEdgeRequirementsContractPayload = {
  contract_version: "TRID-EDGE-REQUIREMENTS-CONTRACT-V1";
  generated_at: string;
  read_only: true;
  no_db_writes: true;
  family_count: number;
  edge_kind_count: number;
  TRID_edge_requirement_matrix: FamilyEdgeRequirement[];
  required_edges_by_claim_family: Record<string, FamilyEdgeRequirement["edges"]>;
  source_table_to_reference_kind_mapping: typeof SOURCE_TABLE_TO_REFERENCE_KIND;
  duplicate_prevention_keys: typeof DUPLICATE_PREVENTION_KEYS;
  missing_edge_behavior: typeof MISSING_EDGE_BEHAVIOR_RULES;
  Product_Story_lineage_rules: typeof PRODUCT_STORY_LINEAGE_RULES;
  claim_ready_lineage_rules: typeof CLAIM_READY_LINEAGE_RULES;
  money_lineage_rules: typeof MONEY_LINEAGE_RULES;
  orbit_fra_return_item_link_gap: typeof ORBIT_FRA_RETURN_ITEM_LINK_GAP;
  implementation_priority: typeof IMPLEMENTATION_PRIORITY;
  SAFE_TO_IMPLEMENT_TRID_EDGE_READMODEL: "yes" | "no";
  NEXT_EXACT_PROMPT: string;
};

export function buildTridEdgeRequirementsContractPayload(): TridEdgeRequirementsContractPayload {
  const required_edges_by_claim_family: Record<string, FamilyEdgeRequirement["edges"]> = {};
  for (const f of FAMILY_EDGE_REQUIREMENTS) {
    required_edges_by_claim_family[f.family_key] = f.edges;
  }

  return {
    contract_version: "TRID-EDGE-REQUIREMENTS-CONTRACT-V1",
    generated_at: new Date().toISOString(),
    read_only: true,
    no_db_writes: true,
    family_count: FAMILY_EDGE_REQUIREMENTS.length,
    edge_kind_count: TRID_EDGE_KIND_CATALOG.length,
    TRID_edge_requirement_matrix: [...FAMILY_EDGE_REQUIREMENTS],
    required_edges_by_claim_family,
    source_table_to_reference_kind_mapping: SOURCE_TABLE_TO_REFERENCE_KIND,
    duplicate_prevention_keys: DUPLICATE_PREVENTION_KEYS,
    missing_edge_behavior: MISSING_EDGE_BEHAVIOR_RULES,
    Product_Story_lineage_rules: PRODUCT_STORY_LINEAGE_RULES,
    claim_ready_lineage_rules: CLAIM_READY_LINEAGE_RULES,
    money_lineage_rules: MONEY_LINEAGE_RULES,
    orbit_fra_return_item_link_gap: ORBIT_FRA_RETURN_ITEM_LINK_GAP,
    implementation_priority: IMPLEMENTATION_PRIORITY,
    SAFE_TO_IMPLEMENT_TRID_EDGE_READMODEL: "yes",
    NEXT_EXACT_PROMPT:
      "PHASE-CLAIM-TRID-EDGE-READMODEL-IMPLEMENT-V1\n\nMode: staging read-model implementation (no new tables/columns).\nScope:\n1. lib/claims/readmodel/trid-edge-readmodel-v1.ts — expose TRID_EDGE_KIND_CATALOG + per-candidate materialized edges with claim_ready/money/product_story flags from contract.\n2. Wire Claim Center References tab + Product Story TRID section to read model (not metadata-only).\n3. Extend discovery engine with family-aware edge gating (skip product_link when unresolved; disputed → review_signal only).\n4. npm run build + staging smoke; append memory.\nNo claim_cases, no submissions, no scanner changes, no Product Core resolver rewrite.",
  };
}
