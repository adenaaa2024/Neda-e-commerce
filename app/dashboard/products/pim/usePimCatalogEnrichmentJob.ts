"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

import {
  derivePimProductEnrichmentCanonicalJobState,
  hasActiveNonTerminalProductEnrichmentJob,
  isTerminalProductEnrichmentJob,
  type PimProductEnrichmentCanonicalJobState,
} from "./pim-product-enrichment-job-ui-state";

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
  /** True only after explicit Start/Resume in this session — never from mount/localStorage discovery. */
  const autoTickEnabledRef = useRef(false);
  const [autoTickEnabled, setAutoTickEnabled] = useState(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const enableAutoTick = useCallback(() => {
    autoTickEnabledRef.current = true;
    setAutoTickEnabled(true);
  }, []);

  const disableAutoTick = useCallback(() => {
    autoTickEnabledRef.current = false;
    setAutoTickEnabled(false);
  }, []);

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
    disableAutoTick();
    if (storageKey) clearPimEnrichmentJobStorage(storageKey);
  }, [disableAutoTick, storageKey]);

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

            if (isTerminalProductEnrichmentJob(st)) {
              callbacksRef.current?.onTerminal?.(st);
              if (st.status === "completed" && storageKey) clearPimEnrichmentJobStorage(storageKey);
              break;
            }

            if (st.needs_tick && autoTickEnabledRef.current) {
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
        enableAutoTick();
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
    [attachJob, enableAutoTick, oid, refreshJobStatus, startPolling, storeId],
  );

  const cancelBackendJob = useCallback(async () => {
    if (!jobId) return;
    stopPolling();
    disableAutoTick();
    setActionBusy(true);
    try {
      await cancelProductEnrichmentJob(jobId);
      const st = await refreshJobStatus(jobId);
      if (st) callbacksRef.current?.onTerminal?.(st);
    } finally {
      setActionBusy(false);
    }
  }, [disableAutoTick, jobId, refreshJobStatus, stopPolling]);

  const resumeBackendJob = useCallback(
    async (basePayload: PimCatalogEnrichmentRequestBody) => {
      if (!oid || !storeId) return { ok: false as const, error: "Organization and store are required." };

      if (jobId && jobStatus && !isTerminalProductEnrichmentJob(jobStatus)) {
        setJobErr(null);
        setActionBusy(true);
        try {
          enableAutoTick();
          const st = await refreshJobStatus(jobId);
          if (st?.needs_tick) {
            const tick = await tickProductEnrichmentJob(jobId);
            if (!tick.ok) {
              const msg = tick.error ?? "Product enrichment tick failed.";
              setJobErr(msg);
              callbacksRef.current?.onError?.(msg);
              return { ok: false as const, error: msg };
            }
            await refreshJobStatus(jobId);
          }
          startPolling(jobId);
          return { ok: true as const, job_id: jobId };
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Failed to resume enrichment job.";
          setJobErr(msg);
          callbacksRef.current?.onError?.(msg);
          return { ok: false as const, error: msg };
        } finally {
          setActionBusy(false);
        }
      }

      const resumeIndex = jobStatus?.last_cursor_index ?? jobStatus?.processed ?? 0;
      const payload: PimCatalogEnrichmentRequestBody = {
        ...basePayload,
        organization_id: oid,
        store_id: storeId,
        start_index: resumeIndex > 0 ? resumeIndex : undefined,
      };
      return startBackendJob(payload);
    },
    [enableAutoTick, jobId, jobStatus, oid, refreshJobStatus, startBackendJob, startPolling, storeId],
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
        if (!isTerminalProductEnrichmentJob(active.status)) startPolling(active.job_id);
        return;
      }

      const stored = readPimEnrichmentJobStorage(storageKey);
      if (!stored?.job_id || stored.organization_id !== oid || stored.store_id !== storeId) return;
      const st = await fetchProductEnrichmentJobStatus(stored.job_id);
      if (cancelled || !st.ok) return;
      setJobId(stored.job_id);
      setJobStatus(st.status);
      if (!isTerminalProductEnrichmentJob(st.status)) startPolling(stored.job_id);
    })();

    return () => {
      cancelled = true;
    };
  }, [oid, startPolling, storageKey, storeId]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const canonicalJobState: PimProductEnrichmentCanonicalJobState = useMemo(
    () =>
      derivePimProductEnrichmentCanonicalJobState({
        jobId,
        jobStatus,
        autoTickEnabled,
        jobErr,
      }),
    [autoTickEnabled, jobErr, jobId, jobStatus],
  );

  const hasActiveNonTerminalJob = hasActiveNonTerminalProductEnrichmentJob({ jobId, jobStatus });
  const jobAdvancing = canonicalJobState === "actively_advancing";
  const jobPausedAwaitingUser = canonicalJobState === "paused_awaiting_user";

  return {
    jobId,
    jobStatus,
    jobBusy: actionBusy,
    canonicalJobState,
    hasActiveNonTerminalJob,
    jobRunning: jobAdvancing,
    autoTickEnabled,
    jobPausedAwaitingUser,
    jobErr,
    startBackendJob,
    cancelBackendJob,
    resumeBackendJob,
    refreshJobStatus,
    clearJob,
    stopPolling,
  };
}
