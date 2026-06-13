"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { ClaimCenterDashboardKpis } from "@/lib/claims/center/claim-center-v1-types";
import {
  flowCountsFromDashboard,
  type ClaimCenterFlowCounts,
} from "@/lib/claims/center/claim-center-flow-nav";

import { useClaimCenter } from "./ClaimCenterRootClient";

type FlowCountsCtx = {
  counts: ClaimCenterFlowCounts;
  loading: boolean;
  refresh: () => void;
};

const Ctx = createContext<FlowCountsCtx | null>(null);

const EMPTY_COUNTS: ClaimCenterFlowCounts = {
  find_money: 0,
  review: 0,
  proof: 0,
  product: 0,
  references: 0,
  recovery: 0,
  sources: 0,
};

export function useClaimCenterFlowCounts() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useClaimCenterFlowCounts must be used within ClaimCenterFlowCountsProvider");
  return ctx;
}

export function ClaimCenterFlowCountsProvider({ children }: { children: ReactNode }) {
  const { fetchJson, storeId, moduleAccess } = useClaimCenter();
  const [counts, setCounts] = useState<ClaimCenterFlowCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!moduleAccess?.enabled) {
      setCounts(EMPTY_COUNTS);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [dash, refs, auto] = await Promise.all([
        fetchJson<{ kpis: ClaimCenterDashboardKpis }>("/api/claims/center/dashboard"),
        fetchJson<{ ambiguity_count?: number }>("/api/claims/center/references"),
        fetchJson<{ enabled_sources?: string[] }>("/api/claims/center/automation-health"),
      ]);
      const refConflicts = refs.ambiguity_count ?? 0;
      const base = flowCountsFromDashboard(dash.kpis, refConflicts);
      setCounts({
        ...base,
        sources: auto.enabled_sources?.length ?? 0,
      });
    } catch {
      setCounts(EMPTY_COUNTS);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, moduleAccess?.enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh, storeId]);

  const value = useMemo(() => ({ counts, loading, refresh }), [counts, loading, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
