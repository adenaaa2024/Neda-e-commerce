"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isSupabaseConfigured } from "@/src/lib/supabase";
import { useUserRole } from "@/components/UserRoleContext";
import { resolveOrganizationId } from "@/lib/organization";
import {
  WORKSPACE_ORGANIZATION_CHANGED_EVENT,
  WORKSPACE_SELECTED_ORGANIZATION_ID_KEY,
  readWorkspaceSelectedOrganizationIdFromStorage,
  resolveActiveTenantOrganizationId,
} from "@/lib/workspace-organization-scope";
import { isUuidString } from "@/lib/uuid";
import {
  getOperatorSessionStoreIdForOrg,
  resolvePublicStoreId,
  setOperatorSessionStoreIdForOrg,
  type OperatorStoreOption,
} from "@/lib/scanner/operator-session";
import { getOperatorStoreScopeForOrganization } from "./operator-store-actions";

export type OperatorSessionStoreContextValue = {
  organizationId: string;
  sessionStoreId: string | null;
  /** Updates session store and persists per-org localStorage. */
  selectSessionStoreId: (storeId: string) => void;
  operatorStores: OperatorStoreOption[];
  /** True only on first store-scope fetch (no cached stores yet). */
  operatorStoresLoading: boolean;
  /** True during background store-scope refresh while prior stores stay visible. */
  operatorStoresRefreshing: boolean;
  kioskStoreLocked: boolean;
  activeStoreLabel: string | null;
};

const OperatorSessionStoreContext = createContext<OperatorSessionStoreContextValue | null>(null);

export function OperatorSessionStoreProvider({ children }: { children: ReactNode }) {
  const {
    organizationId: contextOrganizationId,
    homeOrganizationId: profileOrganizationId,
    sessionCanWorkspaceSwitch,
    profileLoading,
  } = useUserRole();
  const [workspaceSwitcherOrganizationId, setWorkspaceSwitcherOrganizationId] = useState(() =>
    typeof window === "undefined" ? "" : readWorkspaceSelectedOrganizationIdFromStorage(),
  );
  /**
   * Match workspace org picker (TopHeader / Settings): internal staff scope is persisted under
   * `workspace_selected_organization_id`. Workspace switcher wins over profile/context so
   * operator mobile stays aligned with the company selected on the main shell (same-tab events
   * and localStorage writes do not always update `UserRoleContext.organizationId` first).
   */
  const orgId = useMemo(() => {
    const workspaceOrg =
      workspaceSwitcherOrganizationId || readWorkspaceSelectedOrganizationIdFromStorage();
    const resolved = resolveActiveTenantOrganizationId({
      workspaceSwitcherOrganizationId: workspaceOrg,
      contextOrganizationId,
      profileOrganizationId,
    });
    if (resolved) return resolved;
    return resolveOrganizationId();
  }, [workspaceSwitcherOrganizationId, contextOrganizationId, profileOrganizationId]);
  const [sessionStoreId, setSessionStoreIdState] = useState<string | null>(null);
  const [operatorStores, setOperatorStores] = useState<OperatorStoreOption[]>([]);
  const [operatorStoresLoading, setOperatorStoresLoading] = useState(false);
  const [operatorStoresRefreshing, setOperatorStoresRefreshing] = useState(false);
  /** Ignores stale store-scope fetches when org/profile deps change mid-flight. */
  const storeScopeLoadGenerationRef = useRef(0);
  const hasResolvedStoresRef = useRef(false);

  const kioskStoreLocked = useMemo(() => Boolean(resolvePublicStoreId()), []);

  useEffect(() => {
    if (!sessionCanWorkspaceSwitch) return;
    setWorkspaceSwitcherOrganizationId(readWorkspaceSelectedOrganizationIdFromStorage());

    function syncWorkspaceOrgFromStorage() {
      setWorkspaceSwitcherOrganizationId(readWorkspaceSelectedOrganizationIdFromStorage());
    }

    function onWorkspaceOrgChanged(event: Event) {
      const detail =
        event instanceof CustomEvent && event.detail && typeof event.detail === "object"
          ? (event.detail as { id?: unknown })
          : null;
      const id = typeof detail?.id === "string" ? detail.id.trim() : "";
      if (id && isUuidString(id)) {
        setWorkspaceSwitcherOrganizationId(id);
        return;
      }
      syncWorkspaceOrgFromStorage();
    }

    function onStorage(event: StorageEvent) {
      if (event.key !== WORKSPACE_SELECTED_ORGANIZATION_ID_KEY) return;
      syncWorkspaceOrgFromStorage();
    }

    window.addEventListener(WORKSPACE_ORGANIZATION_CHANGED_EVENT, onWorkspaceOrgChanged as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(WORKSPACE_ORGANIZATION_CHANGED_EVENT, onWorkspaceOrgChanged as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, [sessionCanWorkspaceSwitch]);

  /** Hydrate session store from per-org localStorage before server scope returns (avoids gate race). */
  useEffect(() => {
    const envId = resolvePublicStoreId();
    if (envId) {
      setSessionStoreIdState(envId);
      return;
    }
    const persisted = getOperatorSessionStoreIdForOrg(orgId).trim();
    if (persisted && isUuidString(persisted)) {
      setSessionStoreIdState(persisted);
    }
  }, [orgId]);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setOperatorStores([]);
      setOperatorStoresLoading(false);
      setOperatorStoresRefreshing(false);
      setSessionStoreIdState(null);
      hasResolvedStoresRef.current = false;
      return;
    }
    if (profileLoading) {
      return;
    }

    const loadGeneration = ++storeScopeLoadGenerationRef.current;
    const isBackgroundRefresh = hasResolvedStoresRef.current || operatorStores.length > 0;
    if (isBackgroundRefresh) {
      setOperatorStoresRefreshing(true);
    } else {
      setOperatorStores([]);
      setOperatorStoresLoading(true);
    }
    void (async () => {
      try {
        const scope = await getOperatorStoreScopeForOrganization(orgId);
        if (loadGeneration !== storeScopeLoadGenerationRef.current) return;
        if (!scope.ok) {
          throw new Error(scope.error);
        }
        const stores = scope.snapshot.stores;
        const ids = new Set(stores.map((s) => s.id));
        const envId = resolvePublicStoreId();

        if (envId) {
          const envStoreRow = stores.find((s) => s.id === envId);
          const envRows = envStoreRow ? [envStoreRow] : [];
          setOperatorStores(envRows);
          setSessionStoreIdState(envId);
          hasResolvedStoresRef.current = envRows.length > 0;
          return;
        }

        setOperatorStores(stores);
        if (!stores.length) {
          setSessionStoreIdState(null);
          hasResolvedStoresRef.current = false;
          return;
        }

        const preselected = getOperatorSessionStoreIdForOrg(orgId).trim();
        if (preselected && isUuidString(preselected) && ids.has(preselected)) {
          setSessionStoreIdState(preselected);
        }

        if (stores.length === 1) {
          const id = stores[0].id;
          setOperatorSessionStoreIdForOrg(orgId, id);
          setSessionStoreIdState(id);
          hasResolvedStoresRef.current = true;
          return;
        }

        const persistedRaw = getOperatorSessionStoreIdForOrg(orgId).trim();
        if (persistedRaw && isUuidString(persistedRaw) && !ids.has(persistedRaw)) {
          setOperatorSessionStoreIdForOrg(orgId, "");
        }

        let chosen: string | null = null;
        const persisted = getOperatorSessionStoreIdForOrg(orgId).trim();
        if (persisted && isUuidString(persisted) && ids.has(persisted)) {
          chosen = persisted;
        }

        const orgDefault = scope.snapshot.defaultStoreId;
        if (!chosen && orgDefault && ids.has(orgDefault)) {
          chosen = orgDefault;
        }

        if (chosen) {
          setOperatorSessionStoreIdForOrg(orgId, chosen);
        }
        setSessionStoreIdState(chosen);
        hasResolvedStoresRef.current = stores.length > 0;
      } catch (e) {
        console.error("[operator session store] init failed:", e);
        if (loadGeneration === storeScopeLoadGenerationRef.current && !isBackgroundRefresh) {
          setOperatorStores([]);
          setSessionStoreIdState(null);
        }
      } finally {
        if (loadGeneration === storeScopeLoadGenerationRef.current) {
          setOperatorStoresLoading(false);
          setOperatorStoresRefreshing(false);
        }
      }
    })();
  }, [orgId, profileLoading]);

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
      operatorStoresRefreshing,
      kioskStoreLocked,
      activeStoreLabel,
    }),
    [
      orgId,
      sessionStoreId,
      selectSessionStoreId,
      operatorStores,
      operatorStoresLoading,
      operatorStoresRefreshing,
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
