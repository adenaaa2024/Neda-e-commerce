/**
 * Upload-scoped incremental resolver orchestration (NEXT-UNIVERSAL-RESOLVER-06).
 *
 * Wraps `resolveAmazonImportProducts` with:
 * - Lane A / Lane B governance (preflight dry-run + ambiguity guard)
 * - verify-only mode (dry run, no writes)
 * - structured phase metrics + duration
 * - optional persistence to `raw_report_uploads.metadata.resolver_incremental_last_run`
 *   (upload_id, run_sequence, ambiguity isolation flags, orchestration/persist outcome)
 *
 * Does not perform whole-table sweeps, external API calls, or ambiguous auto-resolution.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resolveAmazonImportProducts,
  type ResolveMetrics,
  type ResolveTargetTable,
} from "./amazon-import-product-resolver";
import { mergeUploadMetadata, type ResolverIncrementalLastRunMetadata } from "./raw-report-upload-metadata";

export type IncrementalResolverLane = "A" | "B";

export type IncrementalResolverGovernance = {
  lane: IncrementalResolverLane;
  /**
   * Lane B: run a dry-run pass first; skip the execute pass when
   * ambiguous / max(1, scanned) exceeds `maxAmbiguousRatioForExecute`.
   */
  laneB_preflight?: boolean;
  /** Default 0.12 — conservative; ambiguous rows are never auto-cleared. */
  maxAmbiguousRatioForExecute?: number;
};

export type RunIncrementalResolverForUploadParams = {
  supabase: SupabaseClient;
  organizationId: string;
  uploadId: string;
  storeId: string;
  table: ResolveTargetTable;
  joinAllOrders?: boolean;
  pageSize?: number;
  governance: IncrementalResolverGovernance;
  /** When true, only dry-run metrics are produced (no row updates). */
  verifyOnly?: boolean;
  /**
   * When false, only preflight / verify-only dry runs run (no execute pass).
   * When verifyOnly is true, this is forced false.
   */
  allowExecute?: boolean;
  /** Merge last-run blob into `raw_report_uploads.metadata`. */
  persistToUploadMetadata?: boolean;
  signal?: AbortSignal;
  /**
   * When set, resolver processes only these row ids (must belong to upload scope).
   * Prefer env `RESOLVER_INCREMENTAL_ONLY_ROW_IDS_<SUFFIX>` for ops; API/workers may pass explicitly.
   */
  onlyRowIds?: string[];
};

export type IncrementalResolverPhaseLog = {
  name: "preflight_dry_run" | "execute" | "verify_only";
  duration_ms: number;
  metrics?: ResolveMetrics;
  aborted_reason?: string;
};

export type RunIncrementalResolverForUploadResult = {
  ok: boolean;
  duration_ms_total: number;
  phases: IncrementalResolverPhaseLog[];
  final_metrics?: ResolveMetrics;
  /** Populated when Lane B preflight aborts execute. */
  aborted_execute?: string;
  /** Fatal orchestration error (e.g. abort, resolver throw). */
  error?: string;
  /** Whether `resolver_incremental_last_run` was written successfully when persistence was requested. */
  persist_metadata_ok?: boolean;
};

function ratioAmbiguous(m: ResolveMetrics): number {
  const denom = Math.max(1, m.rows_scanned);
  return m.rows_ambiguous / denom;
}

async function loadUploadMetadata(
  supabase: SupabaseClient,
  organizationId: string,
  uploadId: string,
): Promise<unknown> {
  const { data, error } = await supabase
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", uploadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    console.warn(`[resolver-incremental] metadata read failed: ${error.message}`);
    return null;
  }
  return (data as { metadata?: unknown } | null)?.metadata ?? null;
}

function readPreviousIncrementalSnapshot(
  prev: unknown,
  table: ResolveTargetTable,
): { run_sequence: number; previous_run_at: string | null } {
  const root = prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
  const last = root.resolver_incremental_last_run;
  if (!last || typeof last !== "object" || Array.isArray(last)) {
    return { run_sequence: 0, previous_run_at: null };
  }
  const o = last as Record<string, unknown>;
  const prevTable = typeof o.table === "string" ? o.table : "";
  const prevAt = typeof o.at === "string" ? o.at : null;
  const seq = o.run_sequence;
  const n = typeof seq === "number" && Number.isFinite(seq) ? seq : 0;
  if (prevTable === table && n >= 0) {
    return { run_sequence: n, previous_run_at: prevAt };
  }
  return { run_sequence: 0, previous_run_at: null };
}

function buildLastRunMetadata(input: {
  uploadId: string;
  runSequence: number;
  previousRunAt: string | null;
  table: ResolveTargetTable;
  lane: IncrementalResolverLane;
  verifyOnly: boolean;
  phases: IncrementalResolverPhaseLog[];
  duration_ms_total: number;
  final?: ResolveMetrics;
  aborted_execute?: string;
  orchestration_completed_ok: boolean;
  orchestration_error: string | null;
  persist_metadata_ok: boolean;
  onlyRowIdsCount: number | null;
}): ResolverIncrementalLastRunMetadata {
  const final = input.final;
  const phasesOut: ResolverIncrementalLastRunMetadata["phases"] = input.phases.map((p) => ({
    name: p.name,
    duration_ms: p.duration_ms,
    aborted_reason: p.aborted_reason,
    metrics: p.metrics
      ? {
          rows_scanned: p.metrics.rows_scanned,
          rows_resolved: p.metrics.rows_resolved,
          rows_ambiguous: p.metrics.rows_ambiguous,
          rows_unresolved: p.metrics.rows_unresolved,
        }
      : undefined,
  }));
  const ambSkip =
    typeof input.aborted_execute === "string" &&
    input.aborted_execute.startsWith("lane_b_ambiguity_ratio_exceeded");

  return {
    at: new Date().toISOString(),
    upload_id: input.uploadId,
    run_sequence: input.runSequence,
    previous_run_at: input.previousRunAt,
    table: input.table,
    lane: input.lane,
    verify_only: input.verifyOnly,
    lane_b_ambiguity_execute_skipped: ambSkip,
    orchestration_completed_ok: input.orchestration_completed_ok,
    orchestration_error: input.orchestration_error,
    persist_metadata_ok: input.persist_metadata_ok,
    only_row_ids_count: input.onlyRowIdsCount,
    phases: phasesOut,
    duration_ms_total: input.duration_ms_total,
    rows_scanned: final?.rows_scanned ?? null,
    rows_resolved: final?.rows_resolved ?? null,
    rows_ambiguous: final?.rows_ambiguous ?? null,
    rows_unresolved: final?.rows_unresolved ?? null,
    safe_new_count: null,
    rollback_event_count: 0,
    aborted_execute: input.aborted_execute,
  };
}

/**
 * Runs resolver phases for exactly one upload + table (incremental / scoped by resolver internals).
 */
export async function runIncrementalResolverForUpload(
  params: RunIncrementalResolverForUploadParams,
): Promise<RunIncrementalResolverForUploadResult> {
  const t0 = Date.now();
  const phases: IncrementalResolverPhaseLog[] = [];
  const verifyOnly = Boolean(params.verifyOnly);
  const allowExecute = verifyOnly ? false : params.allowExecute !== false;
  const lane = params.governance.lane;
  const maxRatio =
    typeof params.governance.maxAmbiguousRatioForExecute === "number" &&
    Number.isFinite(params.governance.maxAmbiguousRatioForExecute)
      ? params.governance.maxAmbiguousRatioForExecute
      : 0.12;
  const laneB_preflight =
    lane === "B" && params.governance.laneB_preflight !== false && !verifyOnly;

  const rowScope =
    params.onlyRowIds && params.onlyRowIds.length > 0 ? { onlyRowIds: params.onlyRowIds } : {};
  const baseOpts = {
    supabase: params.supabase,
    organizationId: params.organizationId,
    uploadId: params.uploadId,
    storeId: params.storeId,
    table: params.table,
    joinAllOrders: params.joinAllOrders,
    pageSize: params.pageSize,
    ...rowScope,
  };
  const onlyRowIdsCount = params.onlyRowIds?.length ?? 0;

  const checkAbort = () => {
    if (params.signal?.aborted) {
      const err = new Error("Incremental resolver aborted");
      err.name = "AbortError";
      throw err;
    }
  };

  let finalMetrics: ResolveMetrics | undefined;
  let abortedExecute: string | undefined;
  let orchestrationOk = true;
  let orchestrationError: string | null = null;

  try {
    if (verifyOnly) {
      checkAbort();
      const p0 = Date.now();
      finalMetrics = await resolveAmazonImportProducts({ ...baseOpts, dryRun: true });
      phases.push({
        name: "verify_only",
        duration_ms: Date.now() - p0,
        metrics: finalMetrics,
      });
    } else if (laneB_preflight && allowExecute) {
      checkAbort();
      const p1 = Date.now();
      const pre = await resolveAmazonImportProducts({ ...baseOpts, dryRun: true });
      phases.push({
        name: "preflight_dry_run",
        duration_ms: Date.now() - p1,
        metrics: pre,
      });

      const ambRatio = ratioAmbiguous(pre);
      if (ambRatio > maxRatio) {
        abortedExecute = `lane_b_ambiguity_ratio_exceeded:${ambRatio.toFixed(4)}>${maxRatio}`;
        phases.push({
          name: "execute",
          duration_ms: 0,
          aborted_reason: abortedExecute,
        });
        finalMetrics = pre;
      } else {
        checkAbort();
        const p2 = Date.now();
        finalMetrics = await resolveAmazonImportProducts({ ...baseOpts, dryRun: false });
        phases.push({
          name: "execute",
          duration_ms: Date.now() - p2,
          metrics: finalMetrics,
        });
      }
    } else if (laneB_preflight && !allowExecute) {
      const p1 = Date.now();
      finalMetrics = await resolveAmazonImportProducts({ ...baseOpts, dryRun: true });
      phases.push({
        name: "preflight_dry_run",
        duration_ms: Date.now() - p1,
        metrics: finalMetrics,
      });
    } else {
      // Lane A — single pass (dry-run when execute disallowed).
      checkAbort();
      const p = Date.now();
      finalMetrics = await resolveAmazonImportProducts({
        ...baseOpts,
        dryRun: !allowExecute,
      });
      phases.push({
        name: allowExecute ? "execute" : "preflight_dry_run",
        duration_ms: Date.now() - p,
        metrics: finalMetrics,
      });
    }
  } catch (e) {
    orchestrationOk = false;
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : "";
    orchestrationError = msg;
    phases.push({
      name: "execute",
      duration_ms: 0,
      aborted_reason: name === "AbortError" ? `abort_signal:${msg}` : `orchestration_error:${msg}`,
    });
    console.warn(`[resolver-incremental] orchestration stopped: ${msg}`);
  }

  const duration_ms_total = Date.now() - t0;

  let lastRunSequenceForLog: number | undefined;

  let persistOk: boolean | undefined;
  if (params.persistToUploadMetadata) {
    const prev = await loadUploadMetadata(params.supabase, params.organizationId, params.uploadId);
    const snap = readPreviousIncrementalSnapshot(prev, params.table);
    const runSequence = snap.run_sequence + 1;
    lastRunSequenceForLog = runSequence;
    const baseLastRun = () =>
      buildLastRunMetadata({
        uploadId: params.uploadId,
        runSequence,
        previousRunAt: snap.previous_run_at,
        table: params.table,
        lane,
        verifyOnly,
        phases,
        duration_ms_total,
        final: finalMetrics,
        aborted_execute: abortedExecute,
        orchestration_completed_ok: orchestrationOk,
        orchestration_error: orchestrationError,
        persist_metadata_ok: true,
      });
    let merged = mergeUploadMetadata(prev, { resolver_incremental_last_run: baseLastRun() });
    const { error: upErr } = await params.supabase
      .from("raw_report_uploads")
      .update({ metadata: merged, updated_at: new Date().toISOString() })
      .eq("id", params.uploadId)
      .eq("organization_id", params.organizationId);
    if (!upErr) {
      persistOk = true;
    } else {
      console.warn(`[resolver-incremental] metadata persist failed: ${upErr.message}`);
      const corrected = buildLastRunMetadata({
        uploadId: params.uploadId,
        runSequence,
        previousRunAt: snap.previous_run_at,
        table: params.table,
        lane,
        verifyOnly,
        phases,
        duration_ms_total,
        final: finalMetrics,
        aborted_execute: abortedExecute,
        orchestration_completed_ok: orchestrationOk,
        orchestration_error: orchestrationError,
        persist_metadata_ok: false,
        onlyRowIdsCount: onlyRowIdsCount > 0 ? onlyRowIdsCount : null,
      });
      merged = mergeUploadMetadata(prev, { resolver_incremental_last_run: corrected });
      const { error: upErr2 } = await params.supabase
        .from("raw_report_uploads")
        .update({ metadata: merged, updated_at: new Date().toISOString() })
        .eq("id", params.uploadId)
        .eq("organization_id", params.organizationId);
      persistOk = !upErr2;
      if (upErr2) {
        console.warn(`[resolver-incremental] metadata persist retry failed: ${upErr2.message}`);
      }
    }
  }

  for (const line of phases) {
    const m = line.metrics;
    console.log(
      `[resolver-incremental] phase=${line.name} table=${params.table} upload=${params.uploadId} ` +
        `duration_ms=${line.duration_ms}` +
        (m
          ? ` scanned=${m.rows_scanned} resolved=${m.rows_resolved} ambiguous=${m.rows_ambiguous} unresolved=${m.rows_unresolved}`
          : "") +
        (line.aborted_reason ? ` aborted=${line.aborted_reason}` : ""),
    );
  }

  if (params.persistToUploadMetadata && lastRunSequenceForLog != null) {
    console.log(
      `[resolver-incremental] summary upload=${params.uploadId} run_sequence=${lastRunSequenceForLog} ` +
        `orchestration_ok=${orchestrationOk} persist_metadata_ok=${persistOk ?? "n/a"} ` +
        `duration_ms_total=${duration_ms_total}`,
    );
  }

  return {
    ok: orchestrationOk,
    duration_ms_total,
    phases,
    final_metrics: finalMetrics,
    aborted_execute: abortedExecute,
    error: orchestrationError ?? undefined,
    persist_metadata_ok: persistOk,
  };
}
