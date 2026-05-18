/**
 * NEXT-FINANCES-API-ARCHIVE-02 — Finances API archive row types and read helpers.
 * Append-only warehouse; no FRR / CSV sync coupling in this module.
 */

export const AMAZON_FINANCES_SOURCE_RUN_STATES = [
  "requested",
  "polling",
  "archived",
  "complete",
  "failed",
] as const;

export type AmazonFinancesSourceRunState = (typeof AMAZON_FINANCES_SOURCE_RUN_STATES)[number];

export const AMAZON_FINANCES_ARCHIVE_TABLES = [
  "amazon_finances_source_runs",
  "amazon_finances_api_pages",
  "amazon_finances_event_groups",
  "amazon_finances_events",
] as const;

export type AmazonFinancesSourceRunRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  marketplace_id: string | null;
  finances_api_version: string;
  operation: string;
  idempotency_key: string;
  window_start: string | null;
  window_end: string | null;
  state: AmazonFinancesSourceRunState;
  attempt: Record<string, unknown>;
  upload_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type AmazonFinancesApiPageRow = {
  id: string;
  organization_id: string;
  source_run_id: string;
  sequence: number;
  operation: string;
  next_token_in: string | null;
  next_token_out: string | null;
  http_status: number;
  response_sha256: string;
  raw_body: Record<string, unknown>;
  captured_at: string;
};

export type AmazonFinancesEventGroupRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  marketplace_id: string | null;
  event_group_id: string;
  finances_api_version: string;
  processing_status: string | null;
  fund_transfer_status: string | null;
  original_total: Record<string, unknown> | null;
  converted_total: Record<string, unknown> | null;
  financial_event_group_start: string | null;
  financial_event_group_end: string | null;
  source_run_id: string;
  payload_digest: string;
  raw_payload: Record<string, unknown>;
  ingested_at: string;
};

export type AmazonFinancesEventRow = {
  id: string;
  organization_id: string;
  event_group_row_id: string;
  event_group_id: string;
  source_run_id: string;
  finances_api_version: string;
  event_type: string;
  amazon_event_id: string | null;
  posted_at: string | null;
  amount: number | null;
  currency: string | null;
  order_id: string | null;
  seller_order_id: string | null;
  sku: string | null;
  shipment_id: string | null;
  removal_order_id: string | null;
  reimbursement_id: string | null;
  adjustment_id: string | null;
  reference_ids: Record<string, unknown>;
  raw_fragment: Record<string, unknown>;
  payload_digest: string;
  ingested_at: string;
};

export const AMAZON_FINANCES_EVENT_GROUPS_LATEST_VIEW =
  "v_amazon_finances_event_groups_latest" as const;

export function isAmazonFinancesSourceRunState(v: string): v is AmazonFinancesSourceRunState {
  return (AMAZON_FINANCES_SOURCE_RUN_STATES as readonly string[]).includes(v);
}

function readString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v.trim() : "";
}

function readNullableString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v == null) return null;
  return typeof v === "string" ? v.trim() || null : null;
}

function readJsonObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as unknown as Record<string, unknown>;
  return {};
}

/** Parse a PostgREST / Supabase row into a typed source run (no I/O). */
export function parseAmazonFinancesSourceRunRow(row: unknown): AmazonFinancesSourceRunRow | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const o = row as unknown as Record<string, unknown>;
  const id = readString(o, "id");
  const organization_id = readString(o, "organization_id");
  const stateRaw = readString(o, "state");
  if (!id || !organization_id || !isAmazonFinancesSourceRunState(stateRaw)) return null;
  const finances_api_version = readString(o, "finances_api_version");
  const operation = readString(o, "operation");
  const idempotency_key = readString(o, "idempotency_key");
  if (!finances_api_version || !operation || !idempotency_key) return null;
  return {
    id,
    organization_id,
    store_id: readNullableString(o, "store_id"),
    marketplace_id: readNullableString(o, "marketplace_id"),
    finances_api_version,
    operation,
    idempotency_key,
    window_start: readNullableString(o, "window_start"),
    window_end: readNullableString(o, "window_end"),
    state: stateRaw,
    attempt: readJsonObject(o, "attempt"),
    upload_id: readNullableString(o, "upload_id"),
    metadata: readJsonObject(o, "metadata"),
    created_at: readString(o, "created_at"),
    updated_at: readString(o, "updated_at"),
  };
}

/** Filters for listing latest event groups (read-only queries). */
export type AmazonFinancesEventGroupsLatestQuery = {
  organization_id: string;
  finances_api_version?: string;
  event_group_id?: string;
  limit?: number;
};

export function buildAmazonFinancesEventGroupsLatestSelectColumns(): string {
  return [
    "id",
    "organization_id",
    "event_group_id",
    "finances_api_version",
    "processing_status",
    "fund_transfer_status",
    "financial_event_group_start",
    "financial_event_group_end",
    "source_run_id",
    "payload_digest",
    "ingested_at",
  ].join(", ");
}
