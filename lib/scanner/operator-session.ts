import type { SupabaseClient } from "@supabase/supabase-js";
import { getDefaultStoreIdFromStorage } from "@/lib/openai-settings";
import { isUuidString } from "@/lib/uuid";

/** Optional fixed store for kiosk / embedded operators (`NEXT_PUBLIC_STORE_ID`). */
export function resolvePublicStoreId(): string | null {
  const v =
    typeof process !== "undefined" && typeof process.env?.NEXT_PUBLIC_STORE_ID === "string"
      ? process.env.NEXT_PUBLIC_STORE_ID.trim()
      : "";
  return v && isUuidString(v) ? v : null;
}

const OPERATOR_SESSION_STORE_KEY_PREFIX = "ecommerce_os_operator_session_store_v1:";

export function operatorSessionStoreStorageKey(organizationId: string): string {
  return `${OPERATOR_SESSION_STORE_KEY_PREFIX}${organizationId}`;
}

/** Last explicit operator store selection for this org (browser localStorage). */
export function getOperatorSessionStoreIdForOrg(organizationId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(operatorSessionStoreStorageKey(organizationId)) ?? "";
  } catch {
    return "";
  }
}

export function setOperatorSessionStoreIdForOrg(organizationId: string, storeId: string): void {
  if (typeof window === "undefined") return;
  try {
    if (!storeId.trim()) {
      localStorage.removeItem(operatorSessionStoreStorageKey(organizationId));
    } else {
      localStorage.setItem(operatorSessionStoreStorageKey(organizationId), storeId.trim());
    }
  } catch {
    // ignore quota / private mode
  }
}

export type OperatorStoreOption = {
  id: string;
  name: string;
  platform: string;
};

async function fetchOrganizationDefaultStoreId(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("organization_settings")
    .select("default_store_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  const id = (data as { default_store_id?: string | null }).default_store_id;
  return typeof id === "string" && isUuidString(id) ? id : null;
}

/** Active stores for operator UI — scoped by organization. */
export async function fetchOperatorStoresForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<OperatorStoreOption[]> {
  const { data, error } = await supabase
    .from("stores")
    .select("id,name,platform")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) throw error;
  const rows = data ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const row = r as { id: string; name?: string | null; platform?: string | null };
    return {
      id: String(row.id),
      name: String(row.name ?? "").trim() || "Store",
      platform: String(row.platform ?? "").trim() || "unknown",
    };
  });
}

async function fetchOperatorStoreRowForOrg(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<OperatorStoreOption | null> {
  const { data, error } = await supabase
    .from("stores")
    .select("id,name,platform")
    .eq("organization_id", organizationId)
    .eq("id", storeId)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as { id: string; name?: string | null; platform?: string | null };
  return {
    id: String(row.id),
    name: String(row.name ?? "").trim() || "Store",
    platform: String(row.platform ?? "").trim() || "unknown",
  };
}

/**
 * Load stores for the org, pick session `stores.id`, persist multi-store choice in localStorage.
 * Kiosk (`NEXT_PUBLIC_STORE_ID`) skips picker and locks to env store when present for the org.
 */
export async function initializeOperatorSessionStores(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ stores: OperatorStoreOption[]; sessionStoreId: string | null }> {
  const envId = resolvePublicStoreId();
  if (envId) {
    const row = await fetchOperatorStoreRowForOrg(supabase, organizationId, envId);
    return { stores: row ? [row] : [], sessionStoreId: envId };
  }

  const stores = await fetchOperatorStoresForOrganization(supabase, organizationId);
  if (!stores.length) {
    return { stores: [], sessionStoreId: null };
  }

  if (stores.length === 1) {
    const id = stores[0].id;
    setOperatorSessionStoreIdForOrg(organizationId, id);
    return { stores, sessionStoreId: id };
  }

  const ids = new Set(stores.map((s) => s.id));

  const persistedRaw = getOperatorSessionStoreIdForOrg(organizationId).trim();
  if (persistedRaw && isUuidString(persistedRaw) && !ids.has(persistedRaw)) {
    setOperatorSessionStoreIdForOrg(organizationId, "");
  }

  let chosen: string | null = null;
  const persisted = getOperatorSessionStoreIdForOrg(organizationId).trim();
  if (persisted && isUuidString(persisted) && ids.has(persisted)) {
    chosen = persisted;
  }

  if (!chosen) {
    const orgDefault = await fetchOrganizationDefaultStoreId(supabase, organizationId);
    if (orgDefault && ids.has(orgDefault)) chosen = orgDefault;
  }

  if (chosen) {
    setOperatorSessionStoreIdForOrg(organizationId, chosen);
  }

  return { stores, sessionStoreId: chosen };
}

/**
 * Resolves store context for operator scanning: env → localStorage default → organization_settings.
 */
export async function resolveOperatorStoreIdClient(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const fromEnv = resolvePublicStoreId();
  if (fromEnv) return fromEnv;

  if (typeof window !== "undefined") {
    const operatorScoped = getOperatorSessionStoreIdForOrg(organizationId).trim();
    if (operatorScoped && isUuidString(operatorScoped)) return operatorScoped;

    const fromStorage = getDefaultStoreIdFromStorage().trim();
    if (fromStorage && isUuidString(fromStorage)) return fromStorage;
  }

  const id = await fetchOrganizationDefaultStoreId(supabase, organizationId);
  return id;
}
