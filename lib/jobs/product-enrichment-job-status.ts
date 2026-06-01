import type { EnrichmentJobCursor } from "./workers/product-enrichment-job-state";
import type { BackgroundJobRow, JobStepRow, JobStatus } from "./types";
import type { PimCatalogEnrichmentFailureRow } from "../pim-catalog-enrichment-batch-request";

export type ProductEnrichmentJobUiStatus = {
  job_id: string;
  status: JobStatus;
  progress_pct: number;
  running: boolean;
  needs_tick: boolean;
  processed: number;
  total: number | null;
  failures_count: number;
  last_cursor_index: number | null;
  batches_run: number;
  metrics: Record<string, unknown> | null;
  failures: PimCatalogEnrichmentFailureRow[];
  failed_product_ids: string[];
  last_error: string | null;
  cancel_requested: boolean;
  can_resume: boolean;
  completed: boolean;
};

function asCursor(step: JobStepRow | null): EnrichmentJobCursor {
  const raw = step?.cursor;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as EnrichmentJobCursor) : {};
}

function cursorIndex(cursor: EnrichmentJobCursor): number | null {
  const n =
    cursor.next_start_index ??
    cursor.start_index ??
    cursor.continuation?.next_start_index ??
    null;
  return n != null && Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : null;
}

export function buildProductEnrichmentJobUiStatus(
  job: BackgroundJobRow,
  step: JobStepRow | null,
): ProductEnrichmentJobUiStatus {
  const cursor = asCursor(step);
  const output =
    step?.output && typeof step.output === "object" && !Array.isArray(step.output)
      ? (step.output as Record<string, unknown>)
      : {};
  const metrics =
    (cursor.metrics && typeof cursor.metrics === "object" ? cursor.metrics : null) ??
    (output.metrics && typeof output.metrics === "object" ? (output.metrics as Record<string, unknown>) : null);

  const failures = Array.isArray(cursor.failures)
    ? cursor.failures
    : Array.isArray(output.failures)
      ? (output.failures as PimCatalogEnrichmentFailureRow[])
      : [];

  const failedIds = Array.isArray(cursor.failed_product_ids)
    ? cursor.failed_product_ids
    : Array.isArray(output.failed_product_ids)
      ? (output.failed_product_ids as string[])
      : [];

  const total =
    cursor.continuation?.total_eligible ??
    cursor.total_eligible ??
    (typeof metrics?.scanned === "number" ? metrics.scanned : null);

  const processed = cursorIndex(cursor) ?? 0;
  const running = job.status === "running" || job.status === "queued";
  const completed = job.status === "completed";
  const cancelled = job.status === "cancelled";
  const failed = job.status === "failed";
  const hasMore =
    Boolean(cursor.continuation) ||
    (total != null && processed < total && !completed && !cancelled);

  const canResume =
    (cancelled || failed) && hasMore && processed > 0 && !job.cancel_requested_at;

  return {
    job_id: job.id,
    status: job.status,
    progress_pct: job.progress_pct,
    running,
    needs_tick: running && !job.cancel_requested_at,
    processed,
    total: total != null && Number.isFinite(Number(total)) ? Number(total) : null,
    failures_count: failures.length,
    last_cursor_index: cursorIndex(cursor),
    batches_run: Number(cursor.batches_run ?? 0),
    metrics,
    failures,
    failed_product_ids: failedIds,
    last_error: job.last_error_detail ?? job.last_error_code ?? null,
    cancel_requested: Boolean(job.cancel_requested_at),
    can_resume: canResume,
    completed,
  };
}

export function isTerminalProductEnrichmentJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}
