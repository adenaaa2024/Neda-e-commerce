import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type AmazonFinancesSourceRunRow,
  type AmazonFinancesSourceRunState,
  parseAmazonFinancesSourceRunRow,
} from "./finances-api-archive";
import { assertFinancesArchiveTable } from "./finances-api-allowed-tables";
import {
  FINANCES_API_VERSION_V0,
  FINANCES_OPERATION_ARCHIVE,
  buildFinancesArchiveIdempotencyKey,
} from "./finances-api-idempotency";

export type FinancesRunPhase = "list_groups" | "list_events_by_group" | "flatten" | "done";

export type FinancesRunMetadata = {
  phase?: FinancesRunPhase;
  list_groups_next_token?: string | null;
  event_group_ids?: string[];
  events_group_index?: number;
  events_next_token?: string | null;
  current_event_group_id?: string | null;
};

export type FinancesSourceRunAttempt = {
  count: number;
  last_error_code: string | null;
  next_retry_at: string | null;
  last_operation: string | null;
};

export const FINANCES_INGEST_MAX_ATTEMPTS = 5;

export function buildFinancesRunIdempotencyKey(parts: {
  organizationId: string;
  storeId: string | null;
  marketplaceId: string | null;
  windowStart: string;
  windowEnd: string;
}): string {
  return buildFinancesArchiveIdempotencyKey({
    organizationId: parts.organizationId,
    storeId: parts.storeId,
    marketplaceId: parts.marketplaceId,
    windowStart: parts.windowStart,
    windowEnd: parts.windowEnd,
    financesApiVersion: FINANCES_API_VERSION_V0,
  });
}

export function readFinancesRunMetadata(row: AmazonFinancesSourceRunRow): FinancesRunMetadata {
  return (row.metadata ?? {}) as FinancesRunMetadata;
}

export function isTerminalFinancesRunState(state: AmazonFinancesSourceRunState): boolean {
  return state === "complete" || state === "failed";
}

export function financesRunNeedsResume(
  state: AmazonFinancesSourceRunState,
  ingestEnabled: boolean,
): boolean {
  if (!ingestEnabled) return false;
  if (state === "complete" || state === "failed") return false;
  return true;
}

export async function findFinancesSourceRunByIdempotency(
  supabase: SupabaseClient,
  organizationId: string,
  idempotencyKey: string,
): Promise<AmazonFinancesSourceRunRow | null> {
  const { data, error } = await supabase
    .from("amazon_finances_source_runs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`findFinancesSourceRunByIdempotency: ${error.message}`);
  return parseAmazonFinancesSourceRunRow(data);
}

export async function loadFinancesSourceRunById(
  supabase: SupabaseClient,
  organizationId: string,
  sourceRunId: string,
): Promise<AmazonFinancesSourceRunRow | null> {
  const { data, error } = await supabase
    .from("amazon_finances_source_runs")
    .select("*")
    .eq("id", sourceRunId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`loadFinancesSourceRunById: ${error.message}`);
  return parseAmazonFinancesSourceRunRow(data);
}

export type CreateFinancesSourceRunInput = {
  organizationId: string;
  storeId: string | null;
  marketplaceId: string | null;
  windowStart: string;
  windowEnd: string;
  idempotencyKey: string;
};

export async function createFinancesSourceRun(
  supabase: SupabaseClient,
  input: CreateFinancesSourceRunInput,
): Promise<AmazonFinancesSourceRunRow> {
  assertFinancesArchiveTable("amazon_finances_source_runs");

  const { data, error } = await supabase
    .from("amazon_finances_source_runs")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      marketplace_id: input.marketplaceId,
      finances_api_version: FINANCES_API_VERSION_V0,
      operation: FINANCES_OPERATION_ARCHIVE,
      idempotency_key: input.idempotencyKey,
      window_start: input.windowStart,
      window_end: input.windowEnd,
      state: "requested",
      attempt: { count: 0, last_error_code: null, next_retry_at: null, last_operation: null },
      metadata: { phase: "list_groups", list_groups_next_token: null },
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      const existing = await findFinancesSourceRunByIdempotency(
        supabase,
        input.organizationId,
        input.idempotencyKey,
      );
      if (existing) return existing;
    }
    throw new Error(`createFinancesSourceRun: ${error.message}`);
  }

  const row = parseAmazonFinancesSourceRunRow(data);
  if (!row) throw new Error("createFinancesSourceRun: invalid row returned");
  return row;
}

export async function patchFinancesSourceRun(
  supabase: SupabaseClient,
  sourceRunId: string,
  organizationId: string,
  patch: {
    state?: AmazonFinancesSourceRunState;
    metadata?: FinancesRunMetadata;
    attempt?: Partial<FinancesSourceRunAttempt>;
  },
): Promise<void> {
  assertFinancesArchiveTable("amazon_finances_source_runs");

  const update: Record<string, unknown> = {};
  if (patch.state) update.state = patch.state;
  if (patch.metadata) update.metadata = patch.metadata;
  if (patch.attempt) {
    const { data: current } = await supabase
      .from("amazon_finances_source_runs")
      .select("attempt")
      .eq("id", sourceRunId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    const prior = (current?.attempt ?? {}) as unknown as Record<string, unknown>;
    update.attempt = { ...prior, ...patch.attempt };
  }

  const { error } = await supabase
    .from("amazon_finances_source_runs")
    .update(update)
    .eq("id", sourceRunId)
    .eq("organization_id", organizationId);

  if (error) throw new Error(`patchFinancesSourceRun: ${error.message}`);
}
