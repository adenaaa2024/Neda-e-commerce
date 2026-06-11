/**
 * Phase 7G — claim evidence packet model (renderer-agnostic).
 * Composed for single or grouped claim candidates; rendered to HTML (and later PDF).
 */

export type PacketWarningCode =
  | "mixed_products"
  | "mixed_problem_types"
  | "mixed_reference_types"
  | "expired_claim_window"
  | "missing_evidence"
  | "missing_product_link";

export type PacketWarning = {
  code: PacketWarningCode;
  message: string;
  candidate_ids: string[];
};

export type PacketTimelineEntry = {
  at: string | null;
  kind:
    | "scan_recorded"
    | "candidate_detected"
    | "candidate_updated"
    | "quarantined"
    | "rejected"
    | "package_audit";
  label: string;
  detail: string | null;
};

export type PacketPhoto = {
  source: "claim_evidence" | "return_item_photo_evidence";
  url: string | null;
  storage_path: string | null;
  mime_type: string | null;
  note: string | null;
};

export type PacketReferenceEdge = {
  reference_kind: string;
  reference_value: string;
  /** Where this edge came from: candidate metadata.reference_edges or materialized claim_reference_edges. */
  edge_source?: "metadata" | "materialized";
  /** Materialized edges only — 7H edge vocabulary (source_evidence, financial_reference, resolves, ...). */
  edge_type?: string | null;
  to_source_table?: string | null;
  to_source_row_id?: string | null;
  /** Non-null when financial resolution is ambiguous and requires operator selection. */
  ambiguity_group_key?: string | null;
  operator_review_status?: string | null;
};

export type PacketEventSection = {
  anchor: string;
  candidate_id: string;
  claim_family: string;
  claim_reason: string;
  source_kind: string;
  physical_event: string | null;
  product: {
    resolved_product_id: string | null;
    sku: string | null;
    fnsku: string | null;
    asin: string | null;
    item_name: string | null;
  };
  reference: { reference_id: string | null; reference_type: string | null };
  quantities: {
    expected: number | null;
    actual: number | null;
    delta: number | null;
  };
  money: {
    recovery_value: number | null;
    cogs_unit: number | null;
    expected_amount: number | null;
    currency: string | null;
  };
  window: {
    event_date: string | null;
    dispute_deadline: string | null;
    days_remaining: number | null;
    status: "open" | "closing_soon" | "expired" | "unknown";
  };
  shipment_context: {
    shipment_scope_key: string | null;
    pallet_id: string | null;
    package_id: string | null;
    package_code: string | null;
    tracking_number: string | null;
  };
  scan_notes: string | null;
  timeline: PacketTimelineEntry[];
  photos: PacketPhoto[];
  source_report: {
    source_table: string;
    source_row_id: string;
    snapshot: Record<string, unknown> | null;
  };
  reference_graph: PacketReferenceEdge[];
  orbit_evidence_summary: string | null;
};

export type PacketIndexLine = {
  anchor: string;
  candidate_id: string;
  claim_family: string;
  problem_type: string | null;
  source_kind: string;
  product_label: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  reference_id: string | null;
  reference_type: string | null;
  units: number | null;
  recovery_value: number | null;
  window_status: string;
};

export type ClaimEvidencePacket = {
  packet_id: string;
  composed_at: string;
  organization_id: string;
  title: string;
  grouped: boolean;
  index: {
    claim_families: string[];
    total_units: number;
    total_recovery_value: number;
    currency: string;
    lines: PacketIndexLine[];
  };
  events: PacketEventSection[];
  warnings: PacketWarning[];
  grouping: {
    allowed: boolean;
    blocked_reason: string | null;
    requires_confirmation: boolean;
    override_used: boolean;
  };
};

export type ComposePacketResult =
  | { ok: true; packet: ClaimEvidencePacket }
  | { ok: false; error: string; blocked_reason?: string | null; warnings?: PacketWarning[] };
