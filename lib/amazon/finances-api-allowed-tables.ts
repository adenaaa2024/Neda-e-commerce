/**
 * Runtime guard — Finances ingest may only write these tables.
 */

import { AMAZON_FINANCES_ARCHIVE_TABLES } from "./finances-api-archive";

export const FINANCES_ARCHIVE_ALLOWED_TABLES = new Set<string>(AMAZON_FINANCES_ARCHIVE_TABLES);

export function assertFinancesArchiveTable(table: string): void {
  if (!FINANCES_ARCHIVE_ALLOWED_TABLES.has(table)) {
    throw new Error(
      `Finances archive ingest blocked write to "${table}" — only amazon_finances_* tables allowed.`,
    );
  }
}
