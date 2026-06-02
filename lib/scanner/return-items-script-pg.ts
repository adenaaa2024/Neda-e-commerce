/**
 * Staging script harness: persist return_items only inside a Postgres transaction on the same
 * connection as BEGIN/ROLLBACK. Supabase HTTP inserts are not transactional and leak rows.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

import {
  isBlockedSyntheticTestReturnItemInsert,
  SYNTHETIC_TEST_MARKER_INSERT_ERROR,
  type ReturnItemSyntheticInsertFields,
} from "@/lib/scanner/return-items-test-data-guard";

export type ScriptReturnItemInsertRow = {
  organization_id: string;
  store_id: string;
  marketplace?: string;
  item_name: string;
  conditions?: string[];
  status?: string;
  notes?: string | null;
  sku?: string | null;
  fnsku?: string | null;
  order_id?: string | null;
  package_id?: string | null;
  pallet_id?: string | null;
  product_identifier?: string | null;
};

export function newScriptReturnItemsSessionId(): string {
  return randomUUID();
}

export function scriptReturnItemsSessionNote(sessionId: string): string {
  return `_fixture_sess:${sessionId}`;
}

export function assertScriptReturnItemInsertAllowed(
  row: ReturnItemSyntheticInsertFields,
): void {
  if (isBlockedSyntheticTestReturnItemInsert(row)) {
    throw new Error(`BLOCKED: ${SYNTHETIC_TEST_MARKER_INSERT_ERROR}`);
  }
}

/** INSERT via pg client — must run inside an open transaction that ends with ROLLBACK. */
export async function insertReturnItemViaPg(
  client: pg.Client,
  row: ScriptReturnItemInsertRow,
  sessionId: string,
): Promise<string> {
  const markerFields: ReturnItemSyntheticInsertFields = {
    item_name: row.item_name,
    sku: row.sku,
    fnsku: row.fnsku,
    product_identifier: row.product_identifier,
    notes: row.notes,
    raw_return_data: null,
  };
  assertScriptReturnItemInsertAllowed(markerFields);

  const notes = [row.notes?.trim(), scriptReturnItemsSessionNote(sessionId)].filter(Boolean).join(" | ");

  const res = await client.query(
    `INSERT INTO public.return_items (
       organization_id, store_id, marketplace, item_name, conditions, status, notes,
       sku, fnsku, order_id, package_id, pallet_id, product_identifier
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::text[], $6, $7,
       $8, $9, $10, $11::uuid, $12::uuid, $13
     )
     RETURNING id::text`,
    [
      row.organization_id,
      row.store_id,
      row.marketplace ?? "amazon",
      row.item_name,
      row.conditions ?? ["sellable_ok"],
      row.status ?? "received",
      notes || scriptReturnItemsSessionNote(sessionId),
      row.sku ?? null,
      row.fnsku ?? null,
      row.order_id ?? null,
      row.package_id ?? null,
      row.pallet_id ?? null,
      row.product_identifier ?? null,
    ],
  );
  const id = String(res.rows[0]?.id ?? "");
  if (!id) throw new Error("insertReturnItemViaPg: missing id");
  return id;
}

/** Hard-delete rows created in this script session (defensive if ROLLBACK is skipped). */
export async function deleteScriptSessionReturnItemsViaPg(
  client: pg.Client,
  sessionId: string,
): Promise<number> {
  const note = `%${scriptReturnItemsSessionNote(sessionId)}%`;
  const res = await client.query(
    `DELETE FROM public.return_items WHERE notes ILIKE $1`,
    [note],
  );
  return res.rowCount ?? 0;
}
