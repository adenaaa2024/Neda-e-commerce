/**
 * PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE-AND-CLAIM-FAMILY-MAP-V1
 *
 * CLIENT-SAFE contract for the Claim Data Coverage page. This module is FULLY
 * self-contained (ZERO imports — not even `import type`) so it can be imported by
 * client components without ever dragging server-only code (node:fs, supabase,
 * report registry) into the browser bundle. Same boundary law as
 * `claim-ready-to-file-queue-ui-contract.ts`.
 */

export const CLAIM_SOURCE_COVERAGE_V1 = "claim-source-coverage-v1";

export type SourceConnectionStatus =
  | "live_loaded"
  | "loaded_empty"
  | "table_missing"
  | "planned"
  | "override_based";

export type SourceCoverageRow = {
  key: string;
  label: string;
  table: string | null;
  exists: boolean;
  row_count: number | null;
  latest_date: string | null;
  date_coverage: string | null;
  key_columns: string[];
  external_reference_columns: string[];
  product_identity_columns: string[];
  quantity_columns: string[];
  money_columns: string[];
  event_date_columns: string[];
  api_endpoint_exists: boolean;
  importer_exists: boolean;
  live_sp_api_exists: boolean;
  ui_uses_it: boolean;
  connection_status: SourceConnectionStatus;
  claim_families_depending: string[];
  notes: string;
};

export type ClaimFamilySupportStatus = "complete" | "partial" | "preview_only" | "missing";

export type ClaimFamilyMapRow = {
  family_key: string;
  display_name: string;
  classification: string;
  source_files_required: string[];
  source_tables_required: string[];
  source_references_needed: string[];
  event_matching_keys: string[];
  product_matching_keys: string[];
  quantity_logic: string;
  cogs_recovery_formula: string;
  reimbursement_matching_logic: string;
  settlement_transaction_matching_logic: string;
  support_status: ClaimFamilySupportStatus;
  ui_page: string;
  api_endpoint: string;
  blocked_reason: string | null;
  priority: string;
  is_pilot_family: boolean;
  observed_in_claim_candidates: boolean;
};

export type LiveSyncPlanRow = {
  report_api_name: string;
  source_table: string | null;
  current_status: string;
  sync_cadence: string;
  required_credentials: string;
  backfill_requirement: string;
  failure_handling: string;
  audit_log_requirement: string;
  safe_to_build_now: boolean;
  approval_required: boolean;
};

export type ClaimSourceCoverageTotals = {
  sources_total: number;
  sources_live_loaded: number;
  sources_loaded_empty: number;
  sources_missing_or_planned: number;
  families_total: number;
  families_complete: number;
  families_partial: number;
  families_preview_or_missing: number;
};

export type ClaimSourceCoveragePayload = {
  version: string;
  generated_at: string;
  organization_id: string;
  source_coverage_matrix: SourceCoverageRow[];
  claim_family_map: ClaimFamilyMapRow[];
  live_sync_plan: LiveSyncPlanRow[];
  totals: ClaimSourceCoverageTotals;
  missing_files_or_tables: string[];
  missing_api_endpoints: string[];
  highest_priority_next_builds: string[];
};

const CONNECTION_TONE: Record<SourceConnectionStatus, { label: string; tone: string }> = {
  live_loaded: { label: "Live · loaded", tone: "success" },
  loaded_empty: { label: "Connected · empty", tone: "warning" },
  table_missing: { label: "Table missing", tone: "danger" },
  planned: { label: "Planned", tone: "neutral" },
  override_based: { label: "Override-based", tone: "info" },
};

export function sourceConnectionMeta(status: SourceConnectionStatus): { label: string; tone: string } {
  return CONNECTION_TONE[status];
}

const SUPPORT_TONE: Record<ClaimFamilySupportStatus, { label: string; tone: string }> = {
  complete: { label: "Complete", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  preview_only: { label: "Preview only", tone: "info" },
  missing: { label: "Missing source", tone: "danger" },
};

export function familySupportMeta(status: ClaimFamilySupportStatus): { label: string; tone: string } {
  return SUPPORT_TONE[status];
}
