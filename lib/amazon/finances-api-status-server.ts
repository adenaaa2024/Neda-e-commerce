import "server-only";

import { assertFinancesArchiveTable } from "./finances-api-allowed-tables";
import { buildFinancesSourceRunUiSnapshot } from "./finances-api-ui";
import { loadFinancesSourceRunById } from "./finances-api-source-run";
import { supabaseServer } from "../supabase-server";

export type FinancesArchiveRunStatus = {
  snapshot: ReturnType<typeof buildFinancesSourceRunUiSnapshot>;
};

async function countForRun(table: string, sourceRunId: string): Promise<number> {
  assertFinancesArchiveTable(table);
  const { count, error } = await supabaseServer
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("source_run_id", sourceRunId);
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

/** Load sanitized Finances archive run status + table counts (no credentials). */
export async function loadFinancesArchiveRunStatus(
  organizationId: string,
  sourceRunId: string,
): Promise<FinancesArchiveRunStatus | null> {
  const row = await loadFinancesSourceRunById(supabaseServer, organizationId, sourceRunId);
  if (!row) return null;

  const [api_pages, event_groups, events] = await Promise.all([
    countForRun("amazon_finances_api_pages", sourceRunId),
    countForRun("amazon_finances_event_groups", sourceRunId),
    countForRun("amazon_finances_events", sourceRunId),
  ]);

  const snapshot = buildFinancesSourceRunUiSnapshot({
    row: {
      id: row.id,
      state: row.state,
      finances_api_version: row.finances_api_version,
      window_start: row.window_start,
      window_end: row.window_end,
      marketplace_id: row.marketplace_id,
      store_id: row.store_id,
      updated_at: row.updated_at,
      metadata: row.metadata,
      attempt: row.attempt,
    },
    counts: { api_pages, event_groups, events },
  });

  return { snapshot };
}
