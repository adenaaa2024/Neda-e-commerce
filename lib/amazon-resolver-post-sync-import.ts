/**
 * NEXT-UNIVERSAL-RESOLVER-08 — Post-sync product resolver: incremental (gated) or legacy direct path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAmazonImportProducts, type ResolveTargetTable } from "./amazon-import-product-resolver";
import { runIncrementalResolverForUpload } from "./amazon-resolver-incremental-orchestrator";
import {
  readIncrementalResolverOptionsFromEnv,
  shouldUseIncrementalOrchestrator,
} from "./amazon-resolver-incremental-gates";
import { emitResolverIncrementalObservabilityJsonLine } from "./amazon-resolver-incremental-observability";

export async function runPostSyncProductResolverForTable(args: {
  supabase: SupabaseClient;
  organizationId: string;
  uploadId: string;
  storeId: string;
  table: ResolveTargetTable;
  joinAllOrders?: boolean;
  /** Pass true only for FBA_RETURNS when AMAZON_RETURNS_POST_SYNC_RESOLVER is already on. */
  returnsPostSyncResolverActive?: boolean;
}): Promise<void> {
  const incremental = shouldUseIncrementalOrchestrator(args.table, {
    returnsPostSyncResolverActive: args.returnsPostSyncResolverActive ?? false,
  });

  if (incremental) {
    const o = readIncrementalResolverOptionsFromEnv(args.table);
    const result = await runIncrementalResolverForUpload({
      supabase: args.supabase,
      organizationId: args.organizationId,
      uploadId: args.uploadId,
      storeId: args.storeId,
      table: args.table,
      joinAllOrders: args.joinAllOrders,
      governance: o.governance,
      verifyOnly: o.verifyOnly,
      allowExecute: o.allowExecute,
      persistToUploadMetadata: true,
      onlyRowIds: o.onlyRowIds,
    });
    const m = result.final_metrics;
    emitResolverIncrementalObservabilityJsonLine({
      event: "resolver_incremental_run",
      table: args.table,
      upload_id: args.uploadId,
      organization_id: args.organizationId,
      lane: o.governance.lane,
      verify_only: o.verifyOnly,
      execute_allowed: o.allowExecute,
      only_row_ids_count: o.onlyRowIds?.length ?? 0,
      rows_analyzed: m?.rows_scanned,
      rows_resolved: m?.rows_resolved,
      ambiguous_count: m?.rows_ambiguous,
      unresolved_count: m?.rows_unresolved,
      duration_ms: result.duration_ms_total,
      status: result.ok ? "ok" : "error",
      error: result.error ?? null,
      aborted_execute: result.aborted_execute ?? null,
      persist_metadata_ok: result.persist_metadata_ok ?? null,
    });
    return;
  }

  await resolveAmazonImportProducts({
    supabase: args.supabase,
    organizationId: args.organizationId,
    uploadId: args.uploadId,
    storeId: args.storeId,
    table: args.table,
    joinAllOrders: args.joinAllOrders,
  });
}
