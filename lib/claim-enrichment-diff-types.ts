/**
 * NEXT-CONTINUOUS-CLAIM-ENRICHMENT-03 — Read-only enrichment diff API types (no I/O).
 */

/** Subset of `claim_enrichment_generations` for diff responses. */
export type EnrichmentGenerationSummary = {
  readonly id: string;
  readonly generation_number: number;
  readonly status: string | null;
  readonly rules_version: string | null;
  readonly confidence_before: number | null;
  readonly confidence_after: number | null;
  readonly operator_refresh_state: string | null;
  readonly filing_refresh_state: string | null;
  readonly computed_at: string | null;
};

/** Subset of `claim_reference_edges` for diff responses. */
export type EnrichmentReferenceEdgeSummary = {
  readonly id: string;
  readonly generation_id: string;
  readonly edge_type: string | null;
  readonly reference_kind: string | null;
  readonly reference_value: string | null;
  readonly confidence_score: number | null;
  readonly ambiguity_group_key: string | null;
  readonly invalidated_by_edge_id: string | null;
  readonly created_at: string | null;
};

/** Subset of `claim_evidence_lineage_events` when `include_events` is enabled. */
export type EnrichmentLineageEventSummary = {
  readonly id: string;
  readonly generation_id: string;
  readonly event_type: string | null;
  readonly producer: string | null;
  readonly created_at: string | null;
};

export type EnrichmentFreezeStateSummary = {
  readonly state: string;
  readonly reason: string | null;
};

export type EnrichmentDiffNotConfigured = {
  readonly configured: false;
  readonly reason: string;
  readonly draft_id: string;
  readonly since_generation: string;
  readonly organization_id: string;
  readonly changes: readonly [];
  readonly next_required_step: "apply additive CCE DDL in a later governed migration";
};

export type EnrichmentDiffConfigured = {
  readonly configured: true;
  readonly draft_id: string;
  readonly organization_id: string;
  readonly store_id: string | null;
  readonly since_generation: number;
  readonly latest_generation: EnrichmentGenerationSummary | null;
  readonly changes_since_generation: readonly EnrichmentGenerationSummary[];
  readonly new_reference_edges: readonly EnrichmentReferenceEdgeSummary[];
  readonly lineage_events_sample: readonly EnrichmentLineageEventSummary[];
  readonly changed_confidence: number | null;
  readonly filing_refresh_required: boolean;
  readonly operator_refresh_required: boolean;
  readonly preterminal_filing_request_count: number;
  readonly terminal_filing_request_count: number;
  readonly freeze_state: EnrichmentFreezeStateSummary | null;
  readonly source_citations: readonly { readonly kind: string; readonly ref: string }[];
};

export type EnrichmentDiffResponse = EnrichmentDiffNotConfigured | EnrichmentDiffConfigured;
