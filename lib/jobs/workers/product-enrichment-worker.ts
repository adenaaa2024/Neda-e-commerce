import { validatePimCatalogEnrichmentBatchParams } from "../../pim-catalog-enrichment-batch-request";
import type { JobTickInput, JobTickResult } from "../types";
import {
  buildEnrichmentJobCursor,
  enrichmentParamsFromJob,
  enrichmentProgressPct,
  readEnrichmentJobCursor,
} from "./product-enrichment-job-state";

/** One worker tick = one enrich-images batch via runPimCatalogEnrichmentBatch (Wave1 library). */
export async function runProductEnrichmentWorker(input: JobTickInput): Promise<JobTickResult> {
  if (input.job.cancel_requested_at) {
    return {
      ok: false,
      needsTick: false,
      stepProgressPct: input.step.progress_pct,
      errorCode: "cancelled",
      errorDetail: "Job cancel requested before enrichment batch",
      cursor: input.step.cursor,
    };
  }

  const prevCursor = readEnrichmentJobCursor(input.step);
  const params = enrichmentParamsFromJob(input.job, input.step);
  const validationErr = validatePimCatalogEnrichmentBatchParams(params);
  if (validationErr) {
    return {
      ok: false,
      needsTick: false,
      stepProgressPct: input.step.progress_pct,
      errorCode: "invalid_payload",
      errorDetail: validationErr.error,
      cursor: input.step.cursor,
    };
  }

  if (!input.job.store_id) {
    return {
      ok: false,
      needsTick: false,
      stepProgressPct: input.step.progress_pct,
      errorCode: "missing_store_id",
      errorDetail: "product_enrichment jobs require store_id on the job row",
      cursor: input.step.cursor,
    };
  }

  const { runPimCatalogEnrichmentBatch } = await import("../../pim-catalog-enrichment-batch");
  const result = await runPimCatalogEnrichmentBatch(params);
  if (!result.ok) {
    return {
      ok: false,
      needsTick: false,
      stepProgressPct: input.step.progress_pct,
      errorCode: `enrichment_http_${result.status}`,
      errorDetail: result.error,
      cursor: input.step.cursor,
    };
  }

  const nextCursor = buildEnrichmentJobCursor({ prev: prevCursor, result });
  const needsTick = Boolean(result.continuation);
  const stepProgressPct = needsTick ? enrichmentProgressPct(nextCursor, result.metrics) : 100;

  return {
    ok: true,
    needsTick,
    stepProgressPct,
    cursor: nextCursor,
    output: {
      metrics: nextCursor.metrics,
      failures: nextCursor.failures,
      failed_product_ids: nextCursor.failed_product_ids,
      continuation: result.continuation ?? null,
      batches_run: nextCursor.batches_run,
      last_batch: {
        metrics: result.metrics,
        failures: result.failures,
        failed_product_ids: result.failed_product_ids,
      },
      completed: !needsTick,
    },
  };
}

export {
  enrichmentParamsFromJob,
  mergeEnrichmentJobMetrics,
  PRODUCT_ENRICHMENT_JOB_PAUSE_RESUME_GAP,
} from "./product-enrichment-job-state";
