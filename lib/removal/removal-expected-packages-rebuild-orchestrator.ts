import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { assessReportsApiPipelineCompletion } from "../amazon/reports-api-pipeline-completion";
import type { SourceRunV1 } from "../amazon/reports-api-source-run";
import { mergeUploadMetadata } from "../raw-report-upload-metadata";
import { supabaseServer } from "../supabase-server";
import { isUuidString } from "../uuid";
import { expectedPackagesRebuildRecordedForUpload } from "./expected-packages-explicit-rebuild-guard";

/** In-process dedupe: same Node tick / worker loop must not rebuild twice for one upload. */
const rebuildProcessedThisRun = new Set<string>();

export type ExpectedPackagesRebuildOrchestratorSummary = {
  org_id: string;
  store_id: string | null;
  upload_id: string;
  report_type: string;
  uploads_processed: string[];
  domain_rows_inserted_updated_deduped: number;
  rebuild_called: boolean;
  skipped_reason: string | null;
  detail_lines_in_scope: number | null;
  matched_rows_upserted: number | null;
  remainder_rows_upserted: number | null;
  overflow_lines: number | null;
  obsolete_rows_deleted: number | null;
  ep_rows_changed_estimate: number | null;
  disputed_rows_count: number | null;
  rebuilt_at: string | null;
};

function runKey(organizationId: string, storeId: string | null, uploadId: string): string {
  return `${organizationId}:${storeId ?? "null"}:${uploadId}`;
}

function isRemovalReportType(reportType: string): boolean {
  return reportType === "REMOVAL_ORDER" || reportType === "REMOVAL_SHIPMENT";
}


function resolveDirectPostgresUrl(): string | null {
  const url =
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ||
    "";
  return url || null;
}

async function callRebuildExpectedPackages(
  organizationId: string,
  storeId: string,
  supabase: SupabaseClient,
): Promise<{ row: Record<string, unknown> | null; error: string | null }> {
  const direct = resolveDirectPostgresUrl();
  if (direct) {
    const client = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      await client.query("SET statement_timeout = '900s'");
      const r = await client.query(
        `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
        [organizationId, storeId],
      );
      return { row: (r.rows[0] as Record<string, unknown>) ?? null, error: null };
    } catch (e) {
      return { row: null, error: e instanceof Error ? e.message : String(e) };
    } finally {
      await client.end();
    }
  }

  const { data, error } = await supabase.rpc("rebuild_expected_packages_from_removals", {
    p_organization_id: organizationId,
    p_store_id: storeId,
  });
  if (error) return { row: null, error: error.message };
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return { row, error: null };
}

async function countDisputedExpectedPackages(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string | null,
): Promise<number> {
  const disputedStatuses = [
    "shipment_overflow_conflict",
    "detail_remainder",
    "source_conflict",
    "stale_partial_snapshot",
    "duplicate_source_conflict",
    "no_shipment_expected",
    "awaiting_shipment_match",
  ];
  let q = supabase
    .from("expected_packages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .gt("expected_scan_quantity", 0)
    .in("build_status", disputedStatuses);
  if (storeId) q = q.eq("store_id", storeId);
  const { count, error } = await q;
  if (error) {
    console.warn("[removal-ep-rebuild] disputed count failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

/**
 * After REMOVAL_ORDER / REMOVAL_SHIPMENT domain import completes, rebuild derived expected_packages.
 * Skipped on fetch-only paths (caller must not invoke when pipeline did not run).
 * Idempotent per upload via raw_report_uploads.metadata.import_metrics.
 */
export async function maybeRebuildExpectedPackagesAfterRemovalImport(params: {
  uploadId: string;
  organizationId: string;
  reportType: string;
  sourceRun: SourceRunV1;
  supabase?: SupabaseClient;
}): Promise<ExpectedPackagesRebuildOrchestratorSummary> {
  const supabase = params.supabase ?? supabaseServer;
  const storeId = params.sourceRun.store_id;
  const base: ExpectedPackagesRebuildOrchestratorSummary = {
    org_id: params.organizationId,
    store_id: storeId,
    upload_id: params.uploadId,
    report_type: params.reportType,
    uploads_processed: [params.uploadId],
    domain_rows_inserted_updated_deduped: 0,
    rebuild_called: false,
    skipped_reason: null,
    detail_lines_in_scope: null,
    matched_rows_upserted: null,
    remainder_rows_upserted: null,
    overflow_lines: null,
    obsolete_rows_deleted: null,
    ep_rows_changed_estimate: null,
    disputed_rows_count: null,
    rebuilt_at: null,
  };

  if (!isRemovalReportType(params.reportType)) {
    base.skipped_reason = "not_removal_report_type";
    return base;
  }
  if (!isUuidString(params.organizationId) || !isUuidString(params.uploadId)) {
    base.skipped_reason = "invalid_ids";
    return base;
  }
  if (!storeId || !isUuidString(storeId)) {
    base.skipped_reason = "missing_store_id";
    return base;
  }

  const { data: uploadRow } = await supabase
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", params.uploadId)
    .eq("organization_id", params.organizationId)
    .maybeSingle();

  if (expectedPackagesRebuildRecordedForUpload(uploadRow?.metadata, params.uploadId)) {
    base.skipped_reason = "already_rebuilt_for_upload";
    return base;
  }

  const dedupeKey = runKey(params.organizationId, storeId, params.uploadId);
  if (rebuildProcessedThisRun.has(dedupeKey)) {
    base.skipped_reason = "duplicate_in_same_run";
    return base;
  }

  const completion = await assessReportsApiPipelineCompletion(
    supabase,
    params.organizationId,
    params.uploadId,
    params.reportType,
  );
  base.domain_rows_inserted_updated_deduped = completion.domain_rows;

  if (completion.needs_domain_sync || !completion.domain_complete) {
    base.skipped_reason = "domain_sync_incomplete";
    return base;
  }

  rebuildProcessedThisRun.add(dedupeKey);

  const { row, error: rebuildErr } = await callRebuildExpectedPackages(
    params.organizationId,
    storeId,
    supabase,
  );

  if (rebuildErr) {
    rebuildProcessedThisRun.delete(dedupeKey);
    base.skipped_reason = `rebuild_failed:${rebuildErr}`;
    console.error(
      JSON.stringify({
        phase: "expected_packages_rebuild_after_removal_import",
        ok: false,
        ...base,
        error: rebuildErr,
      }),
    );
    return base;
  }

  const matched = Number(row?.matched_rows_upserted ?? 0);
  const remainder = Number(row?.remainder_rows_upserted ?? 0);
  const overflow = Number(row?.overflow_lines ?? 0);
  const deleted = Number(row?.obsolete_rows_deleted ?? 0);
  const detailLines = Number(row?.detail_lines_in_scope ?? 0);

  const disputedCount = await countDisputedExpectedPackages(supabase, params.organizationId, storeId);
  const rebuiltAt = new Date().toISOString();

  const summary: ExpectedPackagesRebuildOrchestratorSummary = {
    ...base,
    rebuild_called: true,
    skipped_reason: null,
    detail_lines_in_scope: detailLines,
    matched_rows_upserted: matched,
    remainder_rows_upserted: remainder,
    overflow_lines: overflow,
    obsolete_rows_deleted: deleted,
    ep_rows_changed_estimate: matched + remainder + overflow + deleted,
    disputed_rows_count: disputedCount,
    rebuilt_at: rebuiltAt,
  };

  const metadata = mergeUploadMetadata(uploadRow?.metadata, {
    import_metrics: {
      expected_packages_rebuild_after_import: {
        upload_id: params.uploadId,
        report_type: params.reportType,
        rebuild_called: true,
        rebuilt_at: rebuiltAt,
        domain_rows_for_upload: completion.domain_rows,
        detail_lines_in_scope: detailLines,
        matched_rows_upserted: matched,
        remainder_rows_upserted: remainder,
        overflow_lines: overflow,
        obsolete_rows_deleted: deleted,
        disputed_rows_count: disputedCount,
      },
    },
  });

  await supabase
    .from("raw_report_uploads")
    .update({ metadata })
    .eq("id", params.uploadId)
    .eq("organization_id", params.organizationId);

  console.log(
    JSON.stringify({
      phase: "expected_packages_rebuild_after_removal_import",
      ok: true,
      ...summary,
    }),
  );

  return summary;
}

/** Test-only reset for in-process dedupe. */
export function resetExpectedPackagesRebuildOrchestratorDedupeForTests(): void {
  rebuildProcessedThisRun.clear();
}
