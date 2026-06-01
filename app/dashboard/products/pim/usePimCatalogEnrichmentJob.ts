"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PimCatalogEnrichmentRequestBody } from "@/lib/pim-catalog-enrichment-batch-request";
import type { ProductEnrichmentJobUiStatus } from "@/lib/jobs/product-enrichment-job-status";
import {
  cancelProductEnrichmentJob,
  clearPimEnrichmentJobStorage,
  enqueueProductEnrichmentJob,
  fetchActiveProductEnrichmentJob,
  fetchProductEnrichmentJobStatus,
  pimEnrichmentJobStorageKey,
  readPimEnrichmentJobStorage,
  tickProductEnrichmentJob,
  writePimEnrichmentJobStorage,
} from "@/lib/pim-catalog-enrichment-job-client";

export type PimEnrichmentJobCallbacks = {
  onTerminal?: (status: ProductEnrichmentJobUiStatus) => void;
  onError?: (message: string) => void;
};

const POLL_MS = 3000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = window.setTimeout(resolve, ms);
    const onAbort = () => {
      window.clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTerminalStatus(status: ProductEnrichmentJobUiStatus | null | undefined): boolean {
  if (!status) return false;
  return status.status === "completed" || status.status === "cancelled" || status.status === "failed";
}

export function usePimCatalogEnrichmentJob(args: {
  organizationId: string | null;
  storeId: string;
  callbacks?: PimEnrichmentJobCallbacks;
}) {
  const { organizationId: oid, storeId, callbacks } = args;
  const storageKey = oid && storeId ? pimEnrichmentJobStorageKey(oid, storeId) : null;

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<ProductEnrichmentJobUiStatus | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [jobErr, setJobErr] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const refreshJobStatus = useCallback(async (id: string) => {
    const res = await fetchProductEnrichmentJobStatus(id);
    if (!res.ok) {
      setJobErr(res.error);
      return null;
    }
    setJobStatus(res.status);
    setJobErr(null);
    return res.status;
  }, []);

  const attachJob = useCallback(
    (id: string, payload: PimCatalogEnrichmentRequestBody) => {
      setJobId(id);
      if (storageKey && oid && storeId) {
        writePimEnrichmentJobStorage(storageKey, {
          job_id: id,
          organization_id: oid,
          store_id: storeId,
          payload,
          saved_at: new Date().toISOString(),
        });
      }
    },
    [oid, storageKey, storeId],
  );

  const clearJob = useCallback(() => {
    setJobId(null);
    setJobStatus(null);
    if (storageKey) clearPimEnrichmentJobStorage(storageKey);
  }, [storageKey]);

  const stopPolling = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  }, []);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      const ac = new AbortController();
      pollAbortRef.current = ac;

      void (async () => {
        try {
          while (!ac.signal.aborted) {
            const st = await refreshJobStatus(id);
            if (ac.signal.aborted) break;
            if (!st) break;

            if (isTerminalStatus(st)) {
              callbacksRef.current?.onTerminal?.(st);
              if (st.status === "completed" && storageKey) clearPimEnrichmentJobStorage(storageKey);
              break;
            }

            if (st.needs_tick) {
              const tick = await tickProductEnrichmentJob(id);
              if (ac.signal.aborted) break;
              if (!tick.ok) {
                const msg = tick.error ?? "Product enrichment tick failed.";
                setJobErr(msg);
                callbacksRef.current?.onError?.(msg);
                break;
              }
              await refreshJobStatus(id);
              if (ac.signal.aborted) break;
            }

            await sleep(POLL_MS, ac.signal);
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          const msg = e instanceof Error ? e.message : "Product enrichment polling failed.";
          setJobErr(msg);
          callbacksRef.current?.onError?.(msg);
        }
      })();
    },
    [refreshJobStatus, stopPolling, storageKey],
  );

  const startBackendJob = useCallback(
    async (payload: PimCatalogEnrichmentRequestBody) => {
      if (!oid || !storeId) return { ok: false as const, error: "Organization and store are required." };
      setJobErr(null);
      setActionBusy(true);
      try {
        const idempotencyKey = `pim-enrich-${oid}-${storeId}-${Date.now()}`;
        const enq = await enqueueProductEnrichmentJob({
          organization_id: oid,
          store_id: storeId,
          idempotency_key: idempotencyKey,
          payload,
        });
        if (!enq.ok) {
          setJobErr(enq.error);
          callbacksRef.current?.onError?.(enq.error);
          return { ok: false as const, error: enq.error };
        }
        attachJob(enq.job_id, payload);
        await refreshJobStatus(enq.job_id);
        await tickProductEnrichmentJob(enq.job_id);
        await refreshJobStatus(enq.job_id);
        startPolling(enq.job_id);
        return { ok: true as const, job_id: enq.job_id };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to start enrichment job.";
        setJobErr(msg);
        callbacksRef.current?.onError?.(msg);
        return { ok: false as const, error: msg };
      } finally {
        setActionBusy(false);
      }
    },
    [attachJob, oid, refreshJobStatus, startPolling, storeId],
  );

  const cancelBackendJob = useCallback(async () => {
    if (!jobId) return;
    stopPolling();
    setActionBusy(true);
    try {
      await cancelProductEnrichmentJob(jobId);
      const st = await refreshJobStatus(jobId);
      if (st) callbacksRef.current?.onTerminal?.(st);
    } finally {
      setActionBusy(false);
    }
  }, [jobId, refreshJobStatus, stopPolling]);

  const resumeBackendJob = useCallback(
    async (basePayload: PimCatalogEnrichmentRequestBody) => {
      if (!oid || !storeId) return;
      const resumeIndex = jobStatus?.last_cursor_index ?? jobStatus?.processed ?? 0;
      const payload: PimCatalogEnrichmentRequestBody = {
        ...basePayload,
        organization_id: oid,
        store_id: storeId,
        start_index: resumeIndex > 0 ? resumeIndex : undefined,
      };
      return startBackendJob(payload);
    },
    [jobStatus, oid, startBackendJob, storeId],
  );

  useEffect(() => {
    if (!oid || !storeId || !storageKey) return;
    let cancelled = false;

    void (async () => {
      const active = await fetchActiveProductEnrichmentJob({
        organization_id: oid,
        store_id: storeId,
      });
      if (cancelled) return;
      if (active.ok && active.job_id && active.status) {
        setJobId(active.job_id);
        setJobStatus(active.status);
        const stored = readPimEnrichmentJobStorage(storageKey);
        if (stored?.job_id === active.job_id) {
          writePimEnrichmentJobStorage(storageKey, stored);
        }
        if (!isTerminalStatus(active.status)) startPolling(active.job_id);
        return;
      }

      const stored = readPimEnrichmentJobStorage(storageKey);
      if (!stored?.job_id || stored.organization_id !== oid || stored.store_id !== storeId) return;
      const st = await fetchProductEnrichmentJobStatus(stored.job_id);
      if (cancelled || !st.ok) return;
      setJobId(stored.job_id);
      setJobStatus(st.status);
      if (!isTerminalStatus(st.status)) startPolling(stored.job_id);
    })();

    return () => {
      cancelled = true;
    };
  }, [oid, startPolling, storageKey, storeId]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const jobRunning = Boolean(jobStatus?.running || jobStatus?.needs_tick) && !isTerminalStatus(jobStatus);

  return {
    jobId,
    jobStatus,
    jobBusy: actionBusy,
    jobRunning,
    jobErr,
    startBackendJob,
    cancelBackendJob,
    resumeBackendJob,
    refreshJobStatus,
    clearJob,
    stopPolling,
  };
}
