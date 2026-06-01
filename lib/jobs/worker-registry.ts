import type { JobTickInput, JobTickResult, JobWorkerFn } from "./types";
import { runProductEnrichmentWorker } from "./workers/product-enrichment-worker";
import { runSmokeTickWorker } from "./workers/smoke-worker";

function skeletonWorker(kind: string): JobWorkerFn {
  return async (): Promise<JobTickResult> => ({
    ok: false,
    needsTick: false,
    stepProgressPct: 0,
    errorCode: "worker_skeleton",
    errorDetail: `${kind} worker not wired in phase 1 — enqueue/tick plumbing only`,
  });
}

/** Phase 1 worker registry — smoke worker live; domain workers are skeleton stubs. */
export const WORKER_REGISTRY: Record<string, JobWorkerFn> = {
  smoke_tick: runSmokeTickWorker,
  product_import: skeletonWorker("product_import"),
  product_enrichment: runProductEnrichmentWorker,
  amazon_fetch: skeletonWorker("amazon_fetch"),
  amazon_domain_sync: skeletonWorker("amazon_domain_sync"),
  resolver_backfill: skeletonWorker("resolver_backfill"),
  claim_generation: skeletonWorker("claim_generation"),
  image_processing: skeletonWorker("image_processing"),
};

export function resolveWorker(workerKind: string): JobWorkerFn | null {
  return WORKER_REGISTRY[workerKind] ?? null;
}

export function defaultWorkerKindForJobType(jobType: string): string {
  if (jobType === "orchestration") return "smoke_tick";
  return jobType;
}

export function listRegisteredWorkerKinds(): string[] {
  return Object.keys(WORKER_REGISTRY);
}

export async function dispatchWorkerTick(input: JobTickInput): Promise<JobTickResult> {
  const worker = resolveWorker(input.step.worker_kind);
  if (!worker) {
    return {
      ok: false,
      needsTick: false,
      stepProgressPct: 0,
      errorCode: "unknown_worker_kind",
      errorDetail: `No worker registered for kind ${input.step.worker_kind}`,
    };
  }
  return worker(input);
}
