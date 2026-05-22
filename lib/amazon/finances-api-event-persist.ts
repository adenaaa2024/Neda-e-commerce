/**
 * Batched persistence for Finances archive flatten phase (ARCHIVE-06).
 * Writes only to amazon_finances_* tables; idempotent via unique constraints + ignoreDuplicates.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AmazonFinancesSourceRunRow } from "./finances-api-archive";
import { assertFinancesArchiveTable } from "./finances-api-allowed-tables";
import type { ParsedFinancialEventGroup } from "./finances-api-event-group-parser";
import type { FlattenedFinancialEvent } from "./finances-api-event-flattener";
import { FINANCES_API_VERSION_V0 } from "./finances-api-idempotency";

/** Match phase-2 staging batch size; override via FINANCES_ARCHIVE_BATCH_SIZE. */
export const DEFAULT_FINANCES_ARCHIVE_BATCH_SIZE = 500;

export function financesArchiveBatchSize(): number {
  const raw = process.env.FINANCES_ARCHIVE_BATCH_SIZE?.trim();
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_FINANCES_ARCHIVE_BATCH_SIZE;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_FINANCES_ARCHIVE_BATCH_SIZE;
  return Math.min(n, 2000);
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function eventGroupRowIdMapKey(eventGroupId: string, payloadDigest: string): string {
  return `${eventGroupId}\0${payloadDigest}`;
}

export type FinancesEventInsertRow = {
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
};

export function toFinancesEventInsertRow(
  run: Pick<AmazonFinancesSourceRunRow, "id" | "organization_id">,
  eventGroupRowId: string,
  eventGroupId: string,
  ev: FlattenedFinancialEvent,
): FinancesEventInsertRow {
  return {
    organization_id: run.organization_id,
    event_group_row_id: eventGroupRowId,
    event_group_id: eventGroupId,
    source_run_id: run.id,
    finances_api_version: FINANCES_API_VERSION_V0,
    event_type: ev.event_type,
    amazon_event_id: ev.amazon_event_id,
    posted_at: ev.posted_at,
    amount: ev.amount,
    currency: ev.currency,
    order_id: ev.order_id,
    seller_order_id: ev.seller_order_id,
    sku: ev.sku,
    shipment_id: ev.shipment_id,
    removal_order_id: ev.removal_order_id,
    reimbursement_id: ev.reimbursement_id,
    adjustment_id: ev.adjustment_id,
    reference_ids: ev.reference_ids,
    raw_fragment: ev.raw_fragment,
    payload_digest: ev.payload_digest,
  };
}

export function toFinancesEventGroupInsertRow(
  run: AmazonFinancesSourceRunRow,
  g: ParsedFinancialEventGroup,
): Record<string, unknown> {
  return {
    organization_id: run.organization_id,
    store_id: run.store_id,
    marketplace_id: run.marketplace_id,
    event_group_id: g.event_group_id,
    finances_api_version: FINANCES_API_VERSION_V0,
    processing_status: g.processing_status,
    fund_transfer_status: g.fund_transfer_status,
    original_total: g.original_total,
    converted_total: g.converted_total,
    financial_event_group_start: g.financial_event_group_start,
    financial_event_group_end: g.financial_event_group_end,
    source_run_id: run.id,
    payload_digest: g.payload_digest,
    raw_payload: g.raw_payload,
  };
}

export type BatchInsertResult = {
  batches: number;
  rowsAttempted: number;
};

const FINANCES_INSERT_ON_CONFLICT: Record<
  "amazon_finances_events" | "amazon_finances_event_groups",
  string
> = {
  amazon_finances_events: "organization_id,event_group_id,payload_digest",
  amazon_finances_event_groups:
    "organization_id,finances_api_version,event_group_id,payload_digest",
};

function dedupeFinancesInsertRows(
  table: "amazon_finances_events" | "amazon_finances_event_groups",
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seenDigest = new Set<string>();
  const seenAmazonEventId = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    let digestKey: string;
    if (table === "amazon_finances_events") {
      digestKey = `${r.organization_id}\0${r.event_group_id}\0${r.payload_digest}`;
      if (seenDigest.has(digestKey)) continue;

      const amazonEventId = r.amazon_event_id;
      if (amazonEventId != null && String(amazonEventId).trim() !== "") {
        const amazonKey = `${r.organization_id}\0${r.finances_api_version}\0${r.event_group_id}\0${r.event_type}\0${amazonEventId}`;
        if (seenAmazonEventId.has(amazonKey)) continue;
        seenAmazonEventId.add(amazonKey);
      }
      seenDigest.add(digestKey);
    } else {
      digestKey = `${r.organization_id}\0${r.finances_api_version}\0${r.event_group_id}\0${r.payload_digest}`;
      if (seenDigest.has(digestKey)) continue;
      seenDigest.add(digestKey);
    }
    out.push(r);
  }
  return out;
}

export type FlattenPersistStats = {
  groupsProcessed: number;
  eventRowsAttempted: number;
  insertBatches: number;
};

/**
 * Idempotent batch insert — conflicts on unique keys are skipped (append-only archive).
 */
export async function batchInsertFinancesRows(
  supabase: SupabaseClient,
  table: "amazon_finances_events" | "amazon_finances_event_groups",
  rows: Record<string, unknown>[],
  batchSize: number = financesArchiveBatchSize(),
): Promise<BatchInsertResult> {
  assertFinancesArchiveTable(table);
  if (rows.length === 0) return { batches: 0, rowsAttempted: 0 };

  const chunks = chunkArray(rows, batchSize);
  let batches = 0;
  for (const chunk of chunks) {
    const payload = dedupeFinancesInsertRows(table, chunk);
    if (!payload.length) continue;
    if (table === "amazon_finances_events") {
      batches += await upsertFinancesEventsIdempotent(supabase, payload);
    } else {
      const { error } = await supabase.from(table).upsert(payload, {
        onConflict: FINANCES_INSERT_ON_CONFLICT[table],
        ignoreDuplicates: true,
      });
      if (error) {
        throw new Error(`Finances batch insert ${table}: ${error.message}`);
      }
      batches += 1;
    }
  }
  return { batches, rowsAttempted: rows.length };
}

function isFinancesUniqueViolation(message: string): boolean {
  return (
    message.includes("duplicate key value violates unique constraint") ||
    message.includes("23505")
  );
}

async function upsertFinancesEventsIdempotent(
  supabase: SupabaseClient,
  payload: Record<string, unknown>[],
): Promise<number> {
  const onConflict = FINANCES_INSERT_ON_CONFLICT.amazon_finances_events;
  const { error } = await supabase.from("amazon_finances_events").upsert(payload, {
    onConflict,
    ignoreDuplicates: true,
  });
  if (!error) return 1;

  if (!isFinancesUniqueViolation(error.message)) {
    throw new Error(`Finances batch insert amazon_finances_events: ${error.message}`);
  }

  for (const row of payload) {
    const { error: rowError } = await supabase
      .from("amazon_finances_events")
      .upsert([row], { onConflict, ignoreDuplicates: true });
    if (rowError && !isFinancesUniqueViolation(rowError.message)) {
      throw new Error(`Finances batch insert amazon_finances_events: ${rowError.message}`);
    }
  }
  return 1;
}

/** Drop events already queued in this flatten run (cross-batch amazon_id / digest dupes). */
export function filterNewFinancesEventRows(
  rows: FinancesEventInsertRow[],
  seen: { digest: Set<string>; amazon: Set<string> },
): FinancesEventInsertRow[] {
  const out: FinancesEventInsertRow[] = [];
  for (const r of rows) {
    const digestKey = `${r.organization_id}\0${r.event_group_id}\0${r.payload_digest}`;
    if (seen.digest.has(digestKey)) continue;

    if (r.amazon_event_id != null && r.amazon_event_id.trim() !== "") {
      const amazonKey = `${r.organization_id}\0${r.finances_api_version}\0${r.event_group_id}\0${r.event_type}\0${r.amazon_event_id}`;
      if (seen.amazon.has(amazonKey)) continue;
      seen.amazon.add(amazonKey);
    }
    seen.digest.add(digestKey);
    out.push(r);
  }
  return out;
}

export async function loadEventGroupRowIdMap(
  supabase: SupabaseClient,
  organizationId: string,
  eventGroupIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!eventGroupIds.length) return map;

  const idChunk = 80;
  for (let i = 0; i < eventGroupIds.length; i += idChunk) {
    const slice = eventGroupIds.slice(i, i + idChunk);
    const { data, error } = await supabase
      .from("amazon_finances_event_groups")
      .select("id, event_group_id, payload_digest")
      .eq("organization_id", organizationId)
      .eq("finances_api_version", FINANCES_API_VERSION_V0)
      .in("event_group_id", slice);

    if (error) throw new Error(`loadEventGroupRowIdMap: ${error.message}`);
    for (const row of data ?? []) {
      const id = (row as { id?: string }).id;
      const gid = (row as { event_group_id?: string }).event_group_id;
      const digest = (row as { payload_digest?: string }).payload_digest;
      if (id && gid && digest) {
        map.set(eventGroupRowIdMapKey(gid, digest), id);
      }
    }
  }
  return map;
}

/** Flush buffered event rows in batch-sized chunks (streaming flatten). */
export async function flushBufferedFinancesEvents(
  supabase: SupabaseClient,
  pending: FinancesEventInsertRow[],
  batchSize: number = financesArchiveBatchSize(),
): Promise<BatchInsertResult> {
  if (!pending.length) return { batches: 0, rowsAttempted: 0 };
  return batchInsertFinancesRows(
    supabase,
    "amazon_finances_events",
    pending as unknown as Record<string, unknown>[],
    batchSize,
  );
}

/** Round-trip count for performance tests (row-by-row vs batched). */
export function countPersistRoundTrips(rowCount: number, batchSize: number): {
  rowOriented: number;
  batched: number;
} {
  const batched = rowCount === 0 ? 0 : Math.ceil(rowCount / batchSize);
  return { rowOriented: rowCount, batched };
}
