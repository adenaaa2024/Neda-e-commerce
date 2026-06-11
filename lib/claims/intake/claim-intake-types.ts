/**
 * Phase 7C — unified claim pool generator framework (types).
 * Trusted generators rebuild claim candidates from source-of-truth tables into
 * the single `claim_candidates` pool. legacy_seed rows are NEVER source truth.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Mirrors the claim_candidates_source_kind_check CHECK constraint (minus legacy_seed, which no generator may emit). */
export const CLAIM_SOURCE_KINDS = [
  "scanner_physical_review",
  "amazon_removal_api",
  "reimbursement",
  "settlement",
  "transaction",
  "inventory_ledger",
  "safet",
  "delayed_not_received",
  "shipment_discrepancy",
  "inbound_shipment",
  "manual_import",
  "orbit_fra",
] as const;

export type ClaimSourceKind = (typeof CLAIM_SOURCE_KINDS)[number];

export function isClaimSourceKind(v: unknown): v is ClaimSourceKind {
  return typeof v === "string" && (CLAIM_SOURCE_KINDS as readonly string[]).includes(v);
}

export type ClaimProductGrain = {
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
};

export type ClaimEvidencePointer = {
  table: string;
  id: string;
  note?: string;
};

/** TRID-style reference edge emitted in memory; persisted via claim_reference_edges in a later phase. */
export type ClaimReferenceEdge = {
  reference_kind: string;
  reference_value: string;
};

/** Normalized in-memory candidate draft — every generator must emit this shape. */
export type ClaimCandidateDraft = {
  source_kind: ClaimSourceKind;
  claim_family: string;
  dedupe_key: string;
  source_event_key: string | null;
  source_table: string;
  source_row_id: string;
  organization_id: string;
  store_id: string | null;
  product: ClaimProductGrain;
  reference_key: string | null;
  /** ORBIT-FRA reference id TYPE for the claim category (order_id, tracking_number, ...). */
  reference_type: string | null;
  expected_quantity: number | null;
  actual_quantity: number | null;
  delta_quantity: number | null;
  expected_amount: number | null;
  currency: string | null;
  event_date: string | null;
  /** ORBIT-FRA dispute window end (ISO date) and snapshot of days remaining at intake. */
  dispute_deadline: string | null;
  days_remaining: number | null;
  /** Expected recovery (units x cogs_unit, or report amount). */
  recovery_value: number | null;
  cogs_unit: number | null;
  /** ORBIT-FRA Evidence Summary template output. */
  evidence_summary: string | null;
  claim_reason: string;
  confidence_score: number;
  evidence_pointers: ClaimEvidencePointer[];
  reference_edges: ClaimReferenceEdge[];
  metadata: Record<string, unknown>;
};

export type ClaimIntakeWindow = {
  /** ISO date (inclusive). */
  from: string;
  /** ISO date (inclusive). */
  to: string;
  source: "explicit_settings" | "explicit_run" | "rolling_window";
};

export type ClaimIntakeSettings = {
  enabled_sources: ClaimSourceKind[];
  /** SaaS purchase gate per source; absent key = purchased (default-open on staging). */
  purchased_sources: Partial<Record<ClaimSourceKind, boolean>>;
  /** Explicit window; when null, rolling_window_days applies. */
  date_from: string | null;
  date_to: string | null;
  rolling_window_days: number;
  /** Source tables excluded from intake entirely. */
  excluded_source_tables: string[];
  /** For the 7D scheduler; 7C only reads/reports it. */
  schedule_frequency: "manual" | "hourly" | "daily" | "weekly";
  manual_run_enabled: boolean;
  /** Per-generator fetch cap per run. */
  per_run_row_limit: number;
  /** delayed_not_received: days since shipment_date before a tracking counts as overdue. */
  delayed_not_received_days: number;
  /** manual_import generator rows (settings-provided normalized drafts). */
  manual_import_rows: Record<string, unknown>[];
  /** ORBIT-FRA COGS overrides (sku/fnsku/asin -> unit cost); wins over data-derived COGS. */
  cogs_overrides: Record<string, unknown>;
};

export type ClaimGeneratorContext = {
  client: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  window: ClaimIntakeWindow;
  settings: ClaimIntakeSettings;
  rowLimit: number;
  /** How this intake run was started — candidate trigger policy gates on it. */
  runKind: "scheduled" | "manual";
};

export type ClaimGeneratorOutput = {
  /** Total source rows matching the detector filters (may exceed drafts when capped). */
  matched_count: number;
  drafts: ClaimCandidateDraft[];
  notes: string[];
};

export type ClaimGeneratorDefinition = {
  source_kind: ClaimSourceKind;
  title: string;
  source_tables: string[];
  default_claim_family: string;
  generate: (ctx: ClaimGeneratorContext) => Promise<ClaimGeneratorOutput>;
};

export type ClaimGeneratorApplyStats = {
  inserted: number;
  updated_existing_trusted: number;
  skipped_identity_conflict: number;
  legacy_corroborated: number;
};

export type ClaimGeneratorRunResult = {
  source_kind: ClaimSourceKind;
  title: string;
  enabled: boolean;
  purchased: boolean;
  ran: boolean;
  skip_reason: string | null;
  matched_count: number;
  drafts_generated: number;
  legacy_overlap_count: number;
  sample: ClaimCandidateDraft[];
  apply: ClaimGeneratorApplyStats | null;
  notes: string[];
  error: string | null;
};

export type ClaimIntakeRunSummary = {
  run_id: string;
  mode: "dry_run" | "apply";
  organization_id: string;
  store_id: string | null;
  window: ClaimIntakeWindow;
  requested_sources: ClaimSourceKind[] | "all_enabled";
  results: ClaimGeneratorRunResult[];
  totals: {
    generators_ran: number;
    drafts_generated: number;
    inserted: number;
    legacy_corroborated: number;
  };
};

/** Deterministic idempotency key — unique per (org, dedupe_key) in claim_candidates. */
export function buildClaimDedupeKey(parts: {
  source_kind: ClaimSourceKind;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  claim_family: string;
}): string {
  return [
    "v1",
    parts.source_kind,
    parts.organization_id,
    parts.store_id ?? "-",
    parts.source_table,
    parts.source_row_id,
    parts.claim_family,
  ].join(":");
}
