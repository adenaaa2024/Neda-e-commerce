/** Client-safe types for settlement ↔ FRR reconciliation (IMPORT-API-09F). */

export type SettlementFrrReconciliationHealth =
  | "fully_reconciled"
  | "has_gaps"
  | "no_domain_rows";

export type SettlementFrrReconciliationCounts = {
  settlement_rows: number;
  frr_linked: number;
  unmatched_settlement_rows: number;
  duplicate_frr_rows: number;
  trid_collision_groups: number;
  staging_remaining: number;
};

export type SettlementFrrSourceRunSummary = {
  source_run_id: string | null;
  state: string | null;
  report_id: string | null;
  report_document_id: string | null;
  window_start: string | null;
  window_end: string | null;
};

export type SettlementFrrLineSample = {
  settlement_row_id: string;
  settlement_id: string | null;
  amazon_line_key: string | null;
  order_id: string | null;
  sku: string | null;
  posted_date: string | null;
  transaction_type: string | null;
  amount_total: number | null;
  frr_id: string | null;
  trid_key: string | null;
  confidence_score: number | null;
  match_status: "matched" | "unmatched" | "duplicate_frr" | "trid_collision";
};

export type SettlementFrrReconciliationPayload = {
  ok: true;
  upload_id: string;
  organization_id: string;
  file_name: string;
  upload_status: string;
  report_type: string;
  upload_source: string | null;
  source_run: SettlementFrrSourceRunSummary | null;
  counts: SettlementFrrReconciliationCounts;
  health: SettlementFrrReconciliationHealth;
  samples: {
    matched: SettlementFrrLineSample[];
    unmatched: SettlementFrrLineSample[];
    conflicts: SettlementFrrLineSample[];
  };
};

export type SettlementFrrReconciliationError = {
  ok: false;
  error: string;
  code?: string;
};

export const DEFAULT_SETTLEMENT_FRR_SAMPLE_LIMIT = 50;
export const MAX_SETTLEMENT_FRR_SAMPLE_LIMIT = 100;
