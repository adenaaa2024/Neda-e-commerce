/**
 * PHASE-CLAIM-EVIDENCE-PACKET-V1-PLAN
 * Read-only planning contract for original pilot evidence packet preview.
 * No DB writes. No packet persistence. No PDF.
 */
import type { ClaimEvidencePacket } from "./claim-evidence-packet-types";

export const CLAIM_EVIDENCE_PACKET_V1_PLAN_VERSION = "claim-evidence-packet-v1-plan" as const;

export const ORIGINAL_PILOT_INTAKE_RUN_ID = "a8a892fe-37d5-4d74-9ea2-02af8fd095ce";
export const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";

/** Existing Phase 7G modules — reuse, do not reimplement. */
export const EXISTING_EVIDENCE_CODE = {
  composer: "lib/claims/evidence/claim-evidence-packet-composer.ts",
  types: "lib/claims/evidence/claim-evidence-packet-types.ts",
  html_renderer: "lib/claims/evidence/claim-evidence-packet-html.ts",
  server_action: "app/claim-engine/evidence-packet-actions.ts",
  ui_preview_pane: "components/claim-center/EvidencePacketPreviewPane.tsx",
  proof_queue_route: "app/claim-center/evidence/page.tsx",
  pilot_review_route: "app/claim-center/pilot-review/page.tsx",
  staging_smoke: "scripts/phase7g-evidence-packet-composer-staging-smoke.ts",
  reference_edges: "lib/claims/edges/claim-reference-edge-materializer.ts",
  grouping_contract: "lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1.ts",
  legacy_pdf_track: [
    "app/claim-engine/claim-pdf-document.tsx",
    "app/claim-engine/claim-pdf-server.tsx",
    "app/claim-engine/claim-pdf-batch-actions.ts",
    "app/claim-engine/claim-print-html-actions.ts",
  ],
  draft_filing_packet: "lib/claim-filing-packet-preview.ts",
} as const;

/** V1 extension fields layered on ClaimEvidencePacket for pilot rows. */
export type ClaimEvidencePacketV1Identity = {
  candidate_id: string;
  intake_run_id: string | null;
  family_key_v3: string | null;
  claim_family: string;
  source_kind: string;
  source_table: string;
  source_row_id: string;
  source_event_key: string | null;
  dedupe_key: string | null;
  preview_id: string | null;
  emit_origin: string | null;
};

export type ClaimEvidencePacketV1Product = {
  product_id: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  title: string | null;
  linkage_confidence: "linked" | "unlinked" | "ambiguous" | "unknown";
  linkage_warnings: string[];
};

export type ClaimEvidencePacketV1Quantity = {
  clean_quantity: number | null;
  disputed_quantity_excluded: boolean;
  quantity_source: "expected_quantity" | "actual_quantity" | "delta_quantity" | "metadata";
  disputed_context: string | null;
};

export type ClaimEvidencePacketV1Dates = {
  source_event_date: string | null;
  effective_date_source: string | null;
  effective_date_value: string | null;
  date_gate_passed: boolean;
  claim_eligibility_window: { from: string | null; to: string | null; days: number | null };
  deadline_warning: string | null;
};

export type ClaimEvidencePacketV1SourceEvidence = {
  expected_packages: { table: string; row_id: string } | null;
  amazon_removals: { table: string; row_id: string } | null;
  amazon_removal_shipments: { table: string; row_id: string } | null;
  tracking_number: string | null;
  order_id: string | null;
  removal_shipment_id: string | null;
  reference_edges: Array<{ reference_kind: string; reference_value: string }>;
  evidence_pointers: Array<Record<string, unknown>>;
  reference_graph: ClaimEvidencePacket["events"][number]["reference_graph"];
};

export type ClaimEvidencePacketV1Money = {
  estimated_amazon_payout: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
  reimbursement_gap: number | null;
  recovery_value: number | null;
  expected_amount: number | null;
  currency: string | null;
  /** NULL stays NULL — never coerced to zero. */
  null_preservation: true;
  /** Sale price lane — display only; never COGS substitute. */
  sale_price_display_only: number | null;
};

export type ClaimEvidencePacketV1ReviewFlags = {
  missing_fee: boolean;
  missing_cost: boolean;
  low_confidence: boolean;
  policy_hold: boolean;
  missing_evidence: boolean;
  mixed_source_warning: boolean;
  source_ambiguity: boolean;
  codes: string[];
};

export type ClaimEvidencePacketV1HumanSummary = {
  internal_summary: string | null;
  /** Amazon-facing draft — plan only; do not generate final claim text in V1 preview. */
  amazon_facing_draft_placeholder: null;
};

export type ClaimEvidencePacketV1Event = {
  identity: ClaimEvidencePacketV1Identity;
  product: ClaimEvidencePacketV1Product;
  quantity: ClaimEvidencePacketV1Quantity;
  dates: ClaimEvidencePacketV1Dates;
  source_evidence: ClaimEvidencePacketV1SourceEvidence;
  money: ClaimEvidencePacketV1Money;
  review_flags: ClaimEvidencePacketV1ReviewFlags;
  human_summary: ClaimEvidencePacketV1HumanSummary;
  /** Phase 7G base section — reuse composer output. */
  base_packet_section: ClaimEvidencePacket["events"][number];
};

export type ClaimEvidencePacketV1Preview = {
  version: typeof CLAIM_EVIDENCE_PACKET_V1_PLAN_VERSION;
  packet_id: string;
  composed_at: string;
  intake_run_id: string;
  grouped: boolean;
  candidate_ids: string[];
  events: ClaimEvidencePacketV1Event[];
  warnings: ClaimEvidencePacket["warnings"];
  grouping: ClaimEvidencePacket["grouping"];
  html_preview_available: boolean;
  pdf_generation_deferred: true;
};

export const PACKET_SCHEMA_PROPOSAL = {
  base: "ClaimEvidencePacket (Phase 7G) — renderer-agnostic index + events + warnings + grouping",
  v1_extension: "ClaimEvidencePacketV1Preview — pilot-specific identity/dates/money_lanes/review_flags layered per event",
  persistence: "none — ephemeral compose; packet_id = crypto.randomUUID() per preview",
  renderers: {
    v1_preview: "HTML via renderClaimEvidencePacketHtml + V1 extension panel in Claim Center",
    pdf: "deferred — separate PHASE-CLAIM-EVIDENCE-PACKET-PDF-V1 after operator approval",
  },
} as const;

export const EVIDENCE_SOURCES_REQUIRED = [
  "claim_candidates (primary anchor)",
  "metadata.reference_edges",
  "metadata.evidence_pointers",
  "metadata.money_lanes",
  "metadata.evidence_summary",
  "expected_packages (source snapshot)",
  "amazon_removals (via reference_edges / evidence_pointers)",
  "amazon_removal_shipments (via reference_edges / evidence_pointers)",
  "claim_reference_edges (materialized TRID graph — 7H)",
  "products + product_identifier_map (title + linkage confidence)",
  "claim_evidence (photos — pilot rows expected empty)",
  "return_items (scanner context — pilot rows N/A for financial emit)",
] as const;

export const SOURCE_READER_PLAN = {
  reuse_composeClaimEvidencePacket: {
    module: "lib/claims/evidence/claim-evidence-packet-composer.ts",
    provides: ["source_report.snapshot", "reference_graph", "orbit_evidence_summary", "quantities", "base money columns"],
  },
  extend_with_pilot_projection: {
    module: "lib/claims/evidence/claim-evidence-packet-v1-pilot-projection.ts",
    status: "to_build_in_preview_phase",
    reads: [
      "claim_candidates.metadata (family_key_v3, date_gate, money_lanes, evidence_pointers)",
      "buildProductLinkageDisplayContracts for linkage confidence",
      "products.title when resolved_product_id present",
      "expected_packages.build_status for disputed exclusion context",
    ],
  },
  do_not_use: [
    "lib/claim-filing-packet-preview.ts (draft-only)",
    "claim_submissions PDF pipeline (legacy submission track)",
  ],
} as const;

export const PACKET_API_PLAN = {
  v1_preview_endpoint: "POST /api/claims/center/evidence-packet/preview",
  request: {
    store_id: "uuid (required)",
    candidate_ids: "uuid[] (1–50)",
    intake_run_id: "uuid (optional guard — reject ids outside pilot run when set)",
    title: "string | null",
    confirmMixed: "boolean (grouping override)",
    format: "'json' | 'html' (default json; html returns { packet, html })",
  },
  response: {
    ok: true,
    packet: "ClaimEvidencePacketV1Preview",
    html: "string | null",
    blocked_reason: "string | null",
  },
  interim_entry: "composeClaimEvidencePacketAction (server action) until REST route ships",
  auth: "centerModuleGateOrThrow + assertUserCanAccessOrganization",
  writes: "none",
} as const;

export const PACKET_UI_PLAN = {
  primary_surface: "/claim-center/pilot-review",
  wire_points: [
    "Enable 'Build evidence packet' as read-only preview (not disabled) for selected row(s)",
    "Detail drawer tab: Evidence packet preview (JSON sections + HTML iframe)",
    "Bulk select up to 50 pilot rows → grouped preview with confirmMixed modal",
    "Reuse EvidencePacketPreviewPane pattern; pass candidateIds[]",
  ],
  secondary_surface: "/claim-center/evidence (proof queue — already has single-candidate HTML preview)",
  sections: [
    "Identity block",
    "Product + linkage",
    "Quantity (clean only banner)",
    "Dates + date gate badge",
    "Source evidence + TRID graph",
    "Money lanes (NULL as —)",
    "Review flags chips",
    "Human summary (internal only)",
    "Warnings + grouping gate",
    "HTML preview iframe",
  ],
  disabled_in_v1_preview: ["Approve", "Reject", "Create case", "Submit", "PDF download"],
} as const;

export const BLOCKER_RULES = {
  keeps_evidence_status_missing: [
    "claim_evidence row count = 0 AND return_items.photo_evidence empty → composer warning missing_evidence",
    "resolved_product_id null → warning missing_product_link (pilot may have partial linkage)",
    "metadata.money_lanes.fee_payout_unavailable → flag missing_fee",
    "metadata.money_lanes.cogs_unavailable OR cogs_unit null → flag missing_cost",
    "confidence_score below policy threshold → flag low_confidence",
    "policy_warnings.policy_hold → flag policy_hold",
    "grouping.requires_confirmation true without confirmMixed → preview blocked, not case-ready",
    "expected_packages.build_status disputed → quantity context only; clean qty from emit metadata",
  ],
  does_not_auto_change_evidence_status: "V1 preview is read-only — evidence_status stays 'missing' until explicit evidence attach bridge (separate approval)",
  pilot_expected_blockers: [
    "missing_evidence (no photos — expected for financial/removal pilot)",
    "missing_cost (COGS null on original)",
    "missing_fee (fee-adjusted payout null)",
  ],
} as const;

export const MONEY_RULES = {
  lanes: ["estimated_amazon_payout", "observed_reimbursement", "internal_cost_loss", "reimbursement_gap"],
  source: "metadata.money_lanes JSONB on claim_candidates + column fallbacks (recovery_value, cogs_unit, expected_amount)",
  null_rule: "Display '—' or null in JSON; never coerce null to 0 in sums",
  index_total_rule: "Phase 7G index.total_recovery_value sums only non-null recovery_value; V1 must not sum unknown lanes",
  sale_price_rule: "product_prices.list_price / sale context — display-only lane; NEVER substitute for cogs_unit or estimated_amazon_payout",
  separation: "Three-lane contract from claim-money-recovery audit — observed ≠ estimated ≠ cost",
} as const;

export const DATE_RULES = {
  primary: "metadata.source_event_date (emit) with fallback claim_candidates.event_date",
  gate: "metadata.date_gate_passed must be true for pilot rows",
  effective: "metadata.effective_date_source + effective_date_value",
  window: "claim_policy.claim_eligibility_window_days + claim_start_date from intake policy",
  deadline: "candidate.dispute_deadline + days_remaining → window.status open|closing_soon|expired",
  pilot_expectation: "50/50 date_gate_passed; 0 pre_cutoff",
} as const;

export const CASE_CREATION_PREREQUISITES = {
  required_before_case: [
    "Operator reviewed evidence packet preview (pilot V1 UI sign-off)",
    "evidence_status advanced via explicit evidence attach bridge (not auto on preview)",
    "No unresolved grouping.requires_confirmation",
    "resolved_product_id OR governed linkage exception approved",
    "date_gate_passed = true",
    "claim_cases bridge scaffold approved (PHASE-CLAIM-CANDIDATE-CASE-SUBMISSION-BRIDGE-01)",
  ],
  out_of_scope_v1: [
    "claim_cases INSERT",
    "claim_lines INSERT",
    "claim_submissions INSERT",
    "PDF generation",
    "Amazon submission",
  ],
  evidence_status_transition: "missing → partial requires claim_evidence rows or operator attestation (future bridge)",
} as const;

export const PDF_GENERATION_DEFERRED = {
  deferred: true,
  reason: "Phase 7G HTML only; legacy @react-pdf targets claim_submissions not ClaimEvidencePacket",
  future_phase: "PHASE-CLAIM-EVIDENCE-PACKET-PDF-V1 — map V1 packet → print template after preview sign-off",
} as const;

export const NO_WRITE_SMOKE_TESTS_PLANNED = [
  "scripts/smoke-claim-evidence-packet-v1-preview-v1.ts — static: no .insert/.update/.delete in preview path",
  "scripts/phase-claim-evidence-packet-v1-preview-original-pilot-v1.ts — compose 50 pilot ids read-only; assert warnings; claim_cases count unchanged",
  "claim_candidates count unchanged before/after compose batch",
  "scanner git porcelain empty",
] as const;

export const FUTURE_PDF_EXPORT_STEP = {
  phase: "PHASE-CLAIM-EVIDENCE-PACKET-PDF-V1",
  inputs: "ClaimEvidencePacketV1Preview + HTML render",
  options: ["browser print-to-PDF from HTML", "headless render", "adapt legacy claim-pdf-document.tsx"],
  prerequisite: "SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW=yes + Maysam approval",
} as const;
