"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { MenorixModuleScopeBar } from "@/components/menorix";
import { TASK_CENTER_MODULE_LABEL, TASK_CENTER_MODULE_TAGLINE } from "@/lib/task-center/task-center-ui-contract";

import { TaskCenterAppShell } from "./TaskCenterAppShell";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";

type StoreOption = { store_id: string; name: string; platform?: string };

type Ctx = {
  organizationId: string;
  userId: string | null;
  storeId: string | null;
  setStoreId: (id: string | null) => void;
  stores: StoreOption[];
  storesLoading: boolean;
  fetchJson: <T>(path: string, extra?: Record<string, string>) => Promise<T>;
};

const TaskCenterContext = createContext<Ctx | null>(null);

export function useTaskCenter() {
  const ctx = useContext(TaskCenterContext);
  if (!ctx) throw new Error("useTaskCenter must be used within TaskCenterRootClient");
  return ctx;
}

export function TaskCenterRootClient({
  organizationId,
  userId,
  defaultStoreId,
  children,
}: {
  organizationId: string;
  userId: string | null;
  defaultStoreId: string | null;
  children: ReactNode;
}) {
  const [storeId, setStoreId] = useState<string | null>(defaultStoreId);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storesLoading, setStoresLoading] = useState(true);

  const scopeParams = useMemo(() => {
    const p = new URLSearchParams({ organization_id: organizationId });
    if (storeId) p.set("store_id", storeId);
    return p;
  }, [organizationId, storeId]);

  const fetchJson = useCallback(
    async <T,>(path: string, extra?: Record<string, string>): Promise<T> => {
      const p = new URLSearchParams(scopeParams);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) p.set(k, v);
      }
      const res = await fetch(`${path}?${p}`);
      const data = (await res.json()) as T & { error?: string };
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Request failed");
      return data;
    },
    [scopeParams],
  );

  useEffect(() => {
    let cancelled = false;
    setStoresLoading(true);
    fetch(`/api/claims/my-stores?organization_id=${organizationId}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const list = ((data as { stores?: unknown[] }).stores ?? []) as Array<{
          store_id: string;
          name: string;
          platform?: string;
        }>;
        setStores(list.map((s) => ({ store_id: s.store_id, name: s.name, platform: s.platform })));
      })
      .catch(() => {
        if (!cancelled) setStores([]);
      })
      .finally(() => {
        if (!cancelled) setStoresLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const value = useMemo(
    () => ({ organizationId, userId, storeId, setStoreId, stores, storesLoading, fetchJson }),
    [organizationId, userId, storeId, stores, storesLoading, fetchJson],
  );

  return (
    <TaskCenterContext.Provider value={value}>
      <TaskCenterAppShell
        scopeBar={
          <div className="space-y-3">
            <MenorixModuleScopeBar
              moduleLabel={`${TASK_CENTER_MODULE_LABEL} · ${TASK_CENTER_MODULE_TAGLINE}`}
              stores={stores}
              storeId={storeId}
              onStoreChange={setStoreId}
              loading={storesLoading}
              organizationHint="Organization scoped · read-only · Phase 7A"
            />
            <TaskCenterPhaseNotice compact variant="schema" />
          </div>
        }
      >
        {children}
      </TaskCenterAppShell>
    </TaskCenterContext.Provider>
  );
}

export function TaskCenterLoading() {
  return (
    <div className="task-center-text-muted flex items-center gap-2 py-12 text-sm">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading Task Center…
    </div>
  );
}
