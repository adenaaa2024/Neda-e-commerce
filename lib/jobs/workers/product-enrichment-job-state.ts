import {
  PIM_CATALOG_ENRICHMENT_METRIC_KEYS,
  parsePimCatalogEnrichmentBatchParams,
  type PimCatalogEnrichmentBatchParams,
  type PimCatalogEnrichmentFailureRow,
  type PimCatalogEnrichmentRequestBody,
} from "../../pim-catalog-enrichment-batch-request";
import type { BackgroundJobRow, JobStepRow } from "../types";

export type EnrichmentJobCursor = {
  start_index?: number;
  next_start_index?: number;
  total_eligible?: number;
  batches_run?: number;
  metrics?: Record<string, unknown>;
  failures?: PimCatalogEnrichmentFailureRow[];
  failed_product_ids?: string[];
  continuation?: { next_start_index: number; total_eligible: number } | null;
  last_batch_at?: string;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readEnrichmentJobCursor(step: JobStepRow): EnrichmentJobCursor {
  return asRecord(step.cursor) as EnrichmentJobCursor;
}

export function enrichmentParamsFromJob(job: BackgroundJobRow, step: JobStepRow): PimCatalogEnrichmentBatchParams {
  const cursor = readEnrichmentJobCursor(step);
  const resumeIndex =
    cursor.start_index ?? cursor.next_start_index ?? cursor.continuation?.next_start_index ?? undefined;

  const merged: PimCatalogEnrichmentRequestBody = {
    ...(job.payload as PimCatalogEnrichmentRequestBody),
    ...(step.input as PimCatalogEnrichmentRequestBody),
    organization_id: job.organization_id,
    store_id: job.store_id ?? undefined,
  };
  if (resumeIndex != null && Number.isFinite(Number(resumeIndex))) {
    merged.start_index = Math.max(0, Math.floor(Number(resumeIndex)));
  }

  return parsePimCatalogEnrichmentBatchParams(merged);
}

export function mergeEnrichmentJobMetrics(
  prev: Record<string, unknown> | undefined,
  batch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(prev ?? {}) };
  for (const key of PIM_CATALOG_ENRICHMENT_METRIC_KEYS) {
    const prevVal = out[key];
    const batchVal = batch[key];
    if (typeof batchVal === "number") {
      const base = typeof prevVal === "number" ? prevVal : 0;
      if (key === "start_index" || key === "scanned") {
        out[key] = batchVal;
      } else {
        out[key] = base + batchVal;
      }
    } else if (batchVal !== undefined) {
      out[key] = batchVal;
    }
  }
  return out;
}

export function enrichmentProgressPct(cursor: EnrichmentJobCursor, batchMetrics: Record<string, unknown>): number {
  const total =
    cursor.continuation?.total_eligible ??
    cursor.total_eligible ??
    (typeof batchMetrics.scanned === "number" ? batchMetrics.scanned : 0);
  const done =
    cursor.next_start_index ??
    cursor.start_index ??
    (typeof batchMetrics.start_index === "number" && typeof batchMetrics.batch_size === "number"
      ? batchMetrics.start_index + batchMetrics.batch_size
      : 0);
  if (!total || total <= 0) return 100;
  return Math.min(99, Math.max(1, Math.round((Number(done) / Number(total)) * 100)));
}

export function buildEnrichmentJobCursor(args: {
  prev: EnrichmentJobCursor;
  result: {
    metrics: Record<string, unknown>;
    failures: PimCatalogEnrichmentFailureRow[];
    failed_product_ids: string[];
    continuation?: { next_start_index: number; total_eligible: number };
  };
}): EnrichmentJobCursor {
  const batchesRun = Number(args.prev.batches_run ?? 0) + 1;
  const mergedMetrics = mergeEnrichmentJobMetrics(args.prev.metrics, args.result.metrics);
  const mergedFailures = [...(args.prev.failures ?? []), ...args.result.failures];
  const failedIdSet = new Set<string>(args.prev.failed_product_ids ?? []);
  for (const id of args.result.failed_product_ids) failedIdSet.add(id);
  const continuation = args.result.continuation;

  return {
    start_index: continuation?.next_start_index,
    next_start_index: continuation?.next_start_index,
    total_eligible: continuation?.total_eligible ?? args.prev.total_eligible,
    batches_run: batchesRun,
    metrics: mergedMetrics,
    failures: mergedFailures,
    failed_product_ids: [...failedIdSet],
    continuation: continuation ?? null,
    last_batch_at: new Date().toISOString(),
  };
}

/** Pause/resume infra gap — documented for Wave2 audit (no fake pause status). */
export const PRODUCT_ENRICHMENT_JOB_PAUSE_RESUME_GAP = {
  resumeViaCursor: true,
  explicitPausedStatus: false,
  retryClearsCursor: true,
  detail:
    "Resume works by continuing ticks on a running job (cursor.start_index). Schema has no paused status; retryJob resets step cursor to {}.",
} as const;
