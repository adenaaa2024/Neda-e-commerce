"use server";

import { supabaseServer } from "@/lib/supabase-server";
import { getSessionUserIdFromCookies } from "@/lib/supabase-server-auth";
import { loadTenantProfile, resolveWriteOrganizationId } from "@/lib/server-tenant";
import { canPickWorkspaceOrganizationForTenantBranding } from "@/lib/tenant-branding-permissions";
import { isUuidString } from "@/lib/uuid";
import type { OperatorStoreOption } from "@/lib/scanner/operator-session";

export type OperatorStoreScopeSnapshot = {
  stores: OperatorStoreOption[];
  defaultStoreId: string | null;
};

function normalizeStoreRow(raw: unknown): OperatorStoreOption | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { id?: unknown; name?: unknown; platform?: unknown };
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!isUuidString(id)) return null;
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Store";
  const platform = typeof row.platform === "string" && row.platform.trim() ? row.platform.trim() : "unknown";
  return { id, name, platform };
}

/**
 * Server-side store scope resolver for operator scanner.
 * Uses service-role reads with explicit actor checks so super_admin workspace switch
 * can load selected org stores without being blocked by browser RLS policies.
 */
export async function getOperatorStoreScopeForOrganization(
  requestedOrganizationId: string | null | undefined,
): Promise<{ ok: true; snapshot: OperatorStoreScopeSnapshot } | { ok: false; error: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const profile = await loadTenantProfile(sessionUserId);
  if (!profile) {
    return { ok: false, error: "Profile not found." };
  }

  const req = String(requestedOrganizationId ?? "").trim();
  const reqOk = req && isUuidString(req) ? req : null;
  const canSwitchOrg = canPickWorkspaceOrganizationForTenantBranding(profile.role);
  const orgId = canSwitchOrg ? (reqOk ?? profile.organization_id) : profile.organization_id;

  const [storesRes, settingsRes] = await Promise.all([
    supabaseServer
      .from("stores")
      .select("id,name,platform")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("name", { ascending: true }),
    supabaseServer
      .from("organization_settings")
      .select("default_store_id")
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);

  if (storesRes.error) {
    return { ok: false, error: storesRes.error.message };
  }
  if (settingsRes.error) {
    return { ok: false, error: settingsRes.error.message };
  }

  const stores = (storesRes.data ?? [])
    .map(normalizeStoreRow)
    .filter((r): r is OperatorStoreOption => Boolean(r));
  const rawDefault = typeof settingsRes.data?.default_store_id === "string"
    ? settingsRes.data.default_store_id.trim()
    : "";
  const defaultStoreId = rawDefault && isUuidString(rawDefault) ? rawDefault : null;

  return {
    ok: true,
    snapshot: {
      stores,
      defaultStoreId,
    },
  };
}

export type CreateOperatorPalletActionInput = {
  requestedOrganizationId: string;
  storeId: string;
  palletNumber: string;
  trackingNumber?: string | null;
  operatorPackageCount: number | null;
};

/**
 * Creates an off-manifest / operator pallet using the service-role client.
 * Browser inserts fail RLS when internal staff use the workspace org picker —
 * their JWT `profiles.organization_id` does not match the selected tenant.
 */
export async function createOperatorPalletAction(
  input: CreateOperatorPalletActionInput,
): Promise<
  { ok: true; id: string; pallet_number: string }
  | { ok: false; error: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }

  const palletNumber = String(input.palletNumber ?? "").trim();
  if (!palletNumber) {
    return { ok: false, error: "Pallet code is required." };
  }

  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, error: "Invalid store." };
  }

  const trackingRaw = input.trackingNumber != null ? String(input.trackingNumber).trim() : "";
  const tracking_number = trackingRaw || palletNumber;

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }

  const { data: storeRow, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  if (storeErr) return { ok: false, error: storeErr.message };
  if (!storeRow) {
    return { ok: false, error: "Store not found for this organization." };
  }

  const pkgCount = input.operatorPackageCount;
  const operator_package_count =
    typeof pkgCount === "number" && Number.isFinite(pkgCount) ? pkgCount : null;

  const { data, error } = await supabaseServer
    .from("pallets")
    .insert({
      organization_id: organizationId,
      store_id: storeId,
      pallet_number: palletNumber,
      status: "open",
      tracking_number,
      operator_package_count,
    })
    .select("id, pallet_number")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  const row = data as { id?: string; pallet_number?: string } | null;
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  const pn = typeof row?.pallet_number === "string" ? row.pallet_number.trim() : "";
  if (!id || !pn) {
    return { ok: false, error: "Pallet insert returned no row." };
  }

  return { ok: true, id, pallet_number: pn };
}

