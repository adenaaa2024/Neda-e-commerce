"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { MenorixModuleEmptyState, MenorixModuleScopeBar } from "@/components/menorix";
import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { ClaimCenterAppShell } from "./ClaimCenterAppShell";
import { CLAIM_CENTER_MAIN_CLASS } from "./claim-center-ui";
import { ClaimCenterDetailDrawer } from "./ClaimCenterDetailDrawer";
import { ClaimCenterLegacyToolsMenu } from "./ClaimCenterLegacyToolsMenu";

type ModuleAccess = {
  enabled: boolean;
  reason: string | null;
};

export type ClaimCenterStoreOption = {
  store_id: string;
  name: string;
  platform?: string;
};

type Ctx = {
  organizationId: string;
  storeId: string | null;
  setStoreId: (id: string | null) => void;
  stores: ClaimCenterStoreOption[];
  storesLoading: boolean;
  moduleAccess: ModuleAccess | null;
  selectedRow: ClaimCenterV1Row | null;
  setSelectedRow: (row: ClaimCenterV1Row | null) => void;
  fetchJson: <T>(path: string, extra?: Record<string, string>, init?: RequestInit) => Promise<T>;
};

const ClaimCenterContext = createContext<Ctx | null>(null);

export function useClaimCenter() {
  const ctx = useContext(ClaimCenterContext);
  if (!ctx) throw new Error("useClaimCenter must be used within ClaimCenterRootClient");
  return ctx;
}

/**
 * Claim Center root — flow command bar navigation, full-width surface, read-only V2.
 * Legacy /claim-engine pages remain separate.
 */
export function ClaimCenterRootClient({
  organizationId,
  defaultStoreId,
  children,
}: {
  organizationId: string;
  defaultStoreId: string | null;
  children: ReactNode;
}) {
  const [storeId, setStoreId] = useState<string | null>(defaultStoreId);
  const [stores, setStores] = useState<ClaimCenterStoreOption[]>([]);
  const [storesLoading, setStoresLoading] = useState(true);
  const [moduleAccess, setModuleAccess] = useState<ModuleAccess | null>(null);
  const [selectedRow, setSelectedRow] = useState<ClaimCenterV1Row | null>(null);

  const scopeParams = useMemo(() => {
    const p = new URLSearchParams({ organization_id: organizationId });
    if (storeId) p.set("store_id", storeId);
    return p;
  }, [organizationId, storeId]);

  const fetchJson = useCallback(
    async <T,>(path: string, extra?: Record<string, string>, init?: RequestInit): Promise<T> => {
      const p = new URLSearchParams(scopeParams);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) p.set(k, v);
      }
      const res = await fetch(`${path}?${p}`, init);
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
        const list = ((data as { stores?: unknown[] }).stores ?? data.items ?? []) as Array<{
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

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/claims/center/module-access?organization_id=${organizationId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setModuleAccess({ enabled: !!data.enabled, reason: data.reason ?? null });
      })
      .catch(() => {
        if (!cancelled) setModuleAccess({ enabled: false, reason: "Unable to verify module access." });
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const value = useMemo(
    () => ({
      organizationId,
      storeId,
      setStoreId,
      stores,
      storesLoading,
      moduleAccess,
      selectedRow,
      setSelectedRow,
      fetchJson,
    }),
    [organizationId, storeId, stores, storesLoading, moduleAccess, selectedRow, fetchJson],
  );

  const lockedOverlay =
    moduleAccess && !moduleAccess.enabled ? (
      <div className={`${CLAIM_CENTER_MAIN_CLASS} p-6`}>
        <MenorixModuleEmptyState
          icon={<AlertTriangle className="h-8 w-8 text-amber-500" />}
          title="Claim Center unavailable"
          description={moduleAccess.reason ?? "Claim Recovery module is not enabled."}
        />
      </div>
    ) : null;

  return (
    <ClaimCenterContext.Provider value={value}>
      <ClaimCenterAppShell
        lockedOverlay={lockedOverlay}
        scopeBar={
          moduleAccess?.enabled ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <MenorixModuleScopeBar
                  moduleLabel="Claim Center"
                  stores={stores}
                  storeId={storeId}
                  onStoreChange={setStoreId}
                  loading={storesLoading}
                  organizationHint="Organization scoped · read-only V2"
                />
              </div>
              <ClaimCenterLegacyToolsMenu />
            </div>
          ) : null
        }
        detailDrawer={<ClaimCenterDetailDrawer row={selectedRow} onClose={() => setSelectedRow(null)} />}
      >
        {moduleAccess === null ? (
          <div className="flex items-center gap-2 py-12 text-sm opacity-70">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading Claim Center…
          </div>
        ) : moduleAccess.enabled ? (
          children
        ) : null}
      </ClaimCenterAppShell>
    </ClaimCenterContext.Provider>
  );
}
