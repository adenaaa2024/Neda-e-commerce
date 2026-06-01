import type { PimCatalogEnrichmentRequestBody } from "./pim-catalog-enrichment-batch-request";
import type { ProductEnrichmentJobUiStatus } from "./jobs/product-enrichment-job-status";

export type PimEnrichmentRunMode = "backend" | "browser";

export const PIM_ENRICHMENT_RUN_MODE_STORAGE_KEY = "pim-enrichment-run-mode-v1";
export const PIM_ENRICHMENT_ACTIVE_JOB_STORAGE_PREFIX = "pim-product-enrichment-job-v1:";

export function pimEnrichmentJobStorageKey(organizationId: string, storeId: string): string {
  return `${PIM_ENRICHMENT_ACTIVE_JOB_STORAGE_PREFIX}${organizationId}:${storeId}`;
}

export type PimEnrichmentJobStorageRecord = {
  job_id: string;
  organization_id: string;
  store_id: string;
  payload: PimCatalogEnrichmentRequestBody;
  saved_at: string;
};

export function readPimEnrichmentJobStorage(key: string): PimEnrichmentJobStorageRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PimEnrichmentJobStorageRecord;
    if (!parsed?.job_id || !parsed.organization_id || !parsed.store_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePimEnrichmentJobStorage(key: string, record: PimEnrichmentJobStorageRecord): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(record));
}

export function clearPimEnrichmentJobStorage(key: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(key);
}

export function readPimEnrichmentRunMode(): PimEnrichmentRunMode {
  if (typeof window === "undefined") return "backend";
  const v = window.localStorage.getItem(PIM_ENRICHMENT_RUN_MODE_STORAGE_KEY);
  return v === "browser" ? "browser" : "backend";
}

export function writePimEnrichmentRunMode(mode: PimEnrichmentRunMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PIM_ENRICHMENT_RUN_MODE_STORAGE_KEY, mode);
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchProductEnrichmentJobStatus(
  jobId: string,
): Promise<{ ok: true; status: ProductEnrichmentJobUiStatus } | { ok: false; error: string }> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { credentials: "same-origin" });
  const data = await parseJson(res);
  if (!res.ok || data.ok === false) {
    return { ok: false, error: String(data.error ?? `Status failed (${res.status}).`) };
  }
  return { ok: true, status: data.status as ProductEnrichmentJobUiStatus };
}

export async function fetchActiveProductEnrichmentJob(args: {
  organization_id: string;
  store_id: string;
}): Promise<{ ok: true; job_id: string | null; status: ProductEnrichmentJobUiStatus | null } | { ok: false; error: string }> {
  const q = new URLSearchParams({
    organization_id: args.organization_id,
    store_id: args.store_id,
    job_type: "product_enrichment",
  });
  const res = await fetch(`/api/jobs/active?${q}`, { credentials: "same-origin" });
  const data = await parseJson(res);
  if (!res.ok || data.ok === false) {
    return { ok: false, error: String(data.error ?? `Active job lookup failed (${res.status}).`) };
  }
  return {
    ok: true,
    job_id: (data.job_id as string | null) ?? null,
    status: (data.status as ProductEnrichmentJobUiStatus | null) ?? null,
  };
}

export async function enqueueProductEnrichmentJob(args: {
  organization_id: string;
  store_id: string;
  idempotency_key: string;
  payload: PimCatalogEnrichmentRequestBody;
}): Promise<{ ok: true; job_id: string; status: string } | { ok: false; error: string }> {
  const res = await fetch("/api/jobs/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      organization_id: args.organization_id,
      store_id: args.store_id,
      job_type: "product_enrichment",
      idempotency_key: args.idempotency_key,
      payload: args.payload,
    }),
  });
  const data = await parseJson(res);
  if (!res.ok || data.ok === false) {
    return { ok: false, error: String(data.error ?? `Enqueue failed (${res.status}).`) };
  }
  return { ok: true, job_id: String(data.job_id), status: String(data.status ?? "queued") };
}

export async function tickProductEnrichmentJob(
  jobId: string,
): Promise<
  | {
      ok: boolean;
      status: string;
      progress_pct: number;
      needs_tick: boolean;
      error?: string;
    }
  | { ok: false; error: string }
> {
  const res = await fetch("/api/jobs/tick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ job_id: jobId, worker_instance_id: "pim-catalog-ui" }),
  });
  const data = await parseJson(res);
  if (!res.ok && data.ok !== true) {
    return { ok: false, error: String(data.error ?? `Tick failed (${res.status}).`) };
  }
  return {
    ok: Boolean(data.ok),
    status: String(data.status ?? ""),
    progress_pct: Number(data.progress_pct ?? 0),
    needs_tick: Boolean(data.needs_tick),
    error: data.error ? String(data.error) : undefined,
  };
}

export async function cancelProductEnrichmentJob(
  jobId: string,
): Promise<{ ok: boolean; status: string; error?: string }> {
  const res = await fetch("/api/jobs/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ job_id: jobId }),
  });
  const data = await parseJson(res);
  if (!res.ok && data.ok !== true) {
    return { ok: false, status: "failed", error: String(data.error ?? `Cancel failed (${res.status}).`) };
  }
  return { ok: Boolean(data.ok), status: String(data.status ?? "") };
}

export async function drainProductEnrichmentJobTicks(
  jobId: string,
  options?: { maxTicks?: number; abortSignal?: AbortSignal; onStatus?: (s: ProductEnrichmentJobUiStatus) => void },
): Promise<{ ok: boolean; finalStatus: string; error?: string }> {
  const maxTicks = options?.maxTicks ?? 200;
  let ticks = 0;

  while (ticks < maxTicks) {
    if (options?.abortSignal?.aborted) {
      return { ok: false, finalStatus: "cancelled", error: "aborted" };
    }

    const st = await fetchProductEnrichmentJobStatus(jobId);
    if (!st.ok) return { ok: false, finalStatus: "failed", error: st.error };
    options?.onStatus?.(st.status);

    if (st.status.status === "completed") return { ok: true, finalStatus: "completed" };
    if (st.status.status === "cancelled") return { ok: true, finalStatus: "cancelled" };
    if (st.status.status === "failed") {
      return { ok: false, finalStatus: "failed", error: st.status.last_error ?? "Job failed" };
    }

    if (st.status.needs_tick) {
      const tick = await tickProductEnrichmentJob(jobId);
      ticks += 1;
      if (!tick.ok) return { ok: false, finalStatus: "failed", error: tick.error };
      if (tick.status === "completed" || tick.status === "cancelled" || tick.status === "failed") {
        const after = await fetchProductEnrichmentJobStatus(jobId);
        if (after.ok) options?.onStatus?.(after.status);
        return {
          ok: tick.status === "completed",
          finalStatus: tick.status,
          error: tick.error,
        };
      }
      await new Promise((r) => window.setTimeout(r, 120));
      continue;
    }

    await new Promise((r) => window.setTimeout(r, 400));
  }

  return { ok: false, finalStatus: "running", error: "max_ticks_exceeded" };
}
