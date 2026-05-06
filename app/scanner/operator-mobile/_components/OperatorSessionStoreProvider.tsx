"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isSupabaseConfigured, supabase } from "@/src/lib/supabase";
import { useUserRole } from "@/components/UserRoleContext";
import { resolveOrganizationId } from "@/lib/organization";
import { readWorkspaceSelectedOrganizationIdFromStorage } from "@/lib/workspace-organization-scope";
import { isUuidString } from "@/lib/uuid";
import {
  initializeOperatorSessionStores,
  resolvePublicStoreId,
  setOperatorSessionStoreIdForOrg,
  type OperatorStoreOption,
} from "@/lib/scanner/operator-session";

export type OperatorSessionStoreContextValue = {
  organizationId: string;
  sessionStoreId: string | null;
  /** Updates session store and persists per-org localStorage. */
  selectSessionStoreId: (storeId: string) => void;
  operatorStores: OperatorStoreOption[];
  operatorStoresLoading: boolean;
  kioskStoreLocked: boolean;
  activeStoreLabel: string | null;
};

const OperatorSessionStoreContext = createContext<OperatorSessionStoreContextValue | null>(null);

export function OperatorSessionStoreProvider({ children }: { children: ReactNode }) {
  const { organizationId: profileOrganizationId, sessionCanWorkspaceSwitch } = useUserRole();
  /**
   * Match workspace org picker (TopHeader / Settings): internal staff scope is persisted under
   * `workspace_selected_organization_id`. Prefer that when set so operator mobile stays aligned
   * with the company selected on the main shell.
   */
  const orgId = useMemo(() => {
    if (typeof window !== "undefined" && sessionCanWorkspaceSwitch) {
      const fromWorkspacePicker = readWorkspaceSelectedOrganizationIdFromStorage();
      if (fromWorkspacePicker) return fromWorkspacePicker;
    }
    const p = profileOrganizationId?.trim();
    if (p && isUuidString(p)) return p;
    return resolveOrganizationId();
  }, [profileOrganizationId, sessionCanWorkspaceSwitch]);
  const [sessionStoreId, setSessionStoreIdState] = useState<string | null>(null);
  const [operatorStores, setOperatorStores] = useState<OperatorStoreOption[]>([]);
  const [operatorStoresLoading, setOperatorStoresLoading] = useState(false);

  const kioskStoreLocked = useMemo(() => Boolean(resolvePublicStoreId()), []);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setOperatorStores([]);
      setOperatorStoresLoading(false);
      setSessionStoreIdState(null);
      return;
    }
    let cancelled = false;
    setOperatorStoresLoading(true);
    void (async () => {
      try {
        const res = await initializeOperatorSessionStores(supabase, orgId);
        if (cancelled) return;
        setOperatorStores(res.stores);
        setSessionStoreIdState(res.sessionStoreId);
      } catch (e) {
        console.error("[operator session store] init failed:", e);
        if (!cancelled) {
          setOperatorStores([]);
          setSessionStoreIdState(null);
        }
      } finally {
        if (!cancelled) setOperatorStoresLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const selectSessionStoreId = useCallback(
    (storeId: string) => {
      const id = storeId.trim();
      setSessionStoreIdState(id || null);
      if (id) setOperatorSessionStoreIdForOrg(orgId, id);
    },
    [orgId],
  );

  const activeStoreLabel = useMemo(() => {
    if (!sessionStoreId) return null;
    const hit = operatorStores.find((s) => s.id === sessionStoreId);
    return hit?.name ?? null;
  }, [operatorStores, sessionStoreId]);

  const value = useMemo<OperatorSessionStoreContextValue>(
    () => ({
      organizationId: orgId,
      sessionStoreId,
      selectSessionStoreId,
      operatorStores,
      operatorStoresLoading,
      kioskStoreLocked,
      activeStoreLabel,
    }),
    [
      orgId,
      sessionStoreId,
      selectSessionStoreId,
      operatorStores,
      operatorStoresLoading,
      kioskStoreLocked,
      activeStoreLabel,
    ],
  );

  return (
    <OperatorSessionStoreContext.Provider value={value}>{children}</OperatorSessionStoreContext.Provider>
  );
}

export function useOperatorSessionStore(): OperatorSessionStoreContextValue {
  const ctx = useContext(OperatorSessionStoreContext);
  if (!ctx) {
    throw new Error("useOperatorSessionStore must be used within OperatorMobileLayout / OperatorSessionStoreProvider");
  }
  return ctx;
}
