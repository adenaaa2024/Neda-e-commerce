"use server";

import { listStoresForOrganization } from "../../settings/adapters/actions";
import { canEditPlatformProductSettings } from "../../../lib/platform-product-settings-access";
import {
  buildStoreAutomationSettingsView,
  emptyStoreAutomationView,
} from "../../../lib/platform-automation-run-status";
import { normalizeStoreAutomationSettings } from "../../../lib/platform-automation-schedule";
import { writeStoreAutomationSettings } from "../../../lib/platform-automation-scope-storage";
import type {
  StoreAutomationSettings,
  StoreAutomationSettingsView,
} from "../../../lib/platform-automation-settings-types";
import { supabaseServer } from "../../../lib/supabase-server";
import { isUuidString } from "../../../lib/uuid";
import { getAuthenticatedPlatformRoleKey } from "./platform-settings-actions";

type AccessDenied = "not_authenticated" | "forbidden";

export type OrganizationOption = { id: string; name: string };

async function assertSuperadmin(): Promise<
  { ok: true; roleKey: string } | { ok: false; accessDenied: AccessDenied }
> {
  const roleKey = await getAuthenticatedPlatformRoleKey();
  if (!roleKey) return { ok: false, accessDenied: "not_authenticated" };
  if (!canEditPlatformProductSettings(roleKey)) return { ok: false, accessDenied: "forbidden" };
  return { ok: true, roleKey };
}

export async function listPlatformAutomationOrganizationsAction(): Promise<
  | { accessDenied: AccessDenied }
  | { accessDenied: null; organizations: OrganizationOption[] }
> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return { accessDenied: gate.accessDenied };

  const { data, error } = await supabaseServer
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true });

  if (error) {
    console.error("[listPlatformAutomationOrganizationsAction]", error.message);
    return { accessDenied: null, organizations: [] };
  }

  const organizations = (data ?? [])
    .map((row) => {
      const r = row as { id?: string; name?: string };
      const id = String(r.id ?? "").trim();
      return { id, name: String(r.name ?? "").trim() || id };
    })
    .filter((o) => isUuidString(o.id));

  return { accessDenied: null, organizations };
}

export async function listPlatformAutomationStoresAction(
  organizationId: string,
): Promise<
  | { accessDenied: AccessDenied }
  | { accessDenied: null; stores: { id: string; name: string; platform: string }[] }
> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return { accessDenied: gate.accessDenied };

  const orgId = organizationId.trim();
  if (!isUuidString(orgId)) {
    return { accessDenied: null, stores: [] };
  }

  const res = await listStoresForOrganization(orgId);
  if (!res.ok || !res.data) {
    return { accessDenied: null, stores: [] };
  }

  const stores = res.data
    .filter((s) => s.is_active !== false)
    .map((s) => ({
      id: s.id,
      name: s.name,
      platform: s.platform,
    }));

  return { accessDenied: null, stores };
}

export type StoreAutomationSettingsActionResult =
  | { accessDenied: AccessDenied }
  | { accessDenied: null; view: StoreAutomationSettingsView };

export async function getPlatformAutomationSettingsAction(args: {
  organizationId: string;
  storeId: string;
}): Promise<StoreAutomationSettingsActionResult> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return { accessDenied: gate.accessDenied };

  const organizationId = args.organizationId.trim();
  const storeId = args.storeId.trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { accessDenied: null, view: emptyStoreAutomationView(organizationId, storeId) };
  }

  const { data, error } = await supabaseServer
    .from("platform_settings")
    .select("automation_settings, updated_at")
    .eq("id", true)
    .maybeSingle();

  if (error) {
    console.error("[getPlatformAutomationSettingsAction]", error.message);
    return { accessDenied: null, view: emptyStoreAutomationView(organizationId, storeId) };
  }

  const row = data as { automation_settings?: unknown; updated_at?: string } | null;
  const view = await buildStoreAutomationSettingsView(
    supabaseServer,
    row?.automation_settings,
    organizationId,
    storeId,
    typeof row?.updated_at === "string" ? row.updated_at : null,
  );
  return { accessDenied: null, view };
}

export async function savePlatformAutomationSettingsAction(args: {
  organizationId: string;
  storeId: string;
  settings: StoreAutomationSettings;
}): Promise<
  { ok: true; view: StoreAutomationSettingsView } | { ok: false; error: string }
> {
  const gate = await assertSuperadmin();
  if (!gate.ok) {
    return {
      ok: false,
      error:
        gate.accessDenied === "not_authenticated"
          ? "You must be signed in."
          : "Only super_admin can edit platform automation settings.",
    };
  }

  const organizationId = args.organizationId.trim();
  const storeId = args.storeId.trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "organization_id and store_id must be valid UUIDs." };
  }

  const normalized = normalizeStoreAutomationSettings(args.settings);

  const { data: existing, error: readErr } = await supabaseServer
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();

  if (readErr) return { ok: false, error: readErr.message };

  const row = existing as { automation_settings?: unknown } | null;
  const nextDoc = writeStoreAutomationSettings(
    row?.automation_settings,
    organizationId,
    storeId,
    normalized,
  );

  const { error } = await supabaseServer
    .from("platform_settings")
    .update({ automation_settings: nextDoc })
    .eq("id", true);

  if (error) return { ok: false, error: error.message };

  const { data: savedRow } = await supabaseServer
    .from("platform_settings")
    .select("automation_settings, updated_at")
    .eq("id", true)
    .maybeSingle();

  const saved = savedRow as { automation_settings?: unknown; updated_at?: string } | null;
  const view = await buildStoreAutomationSettingsView(
    supabaseServer,
    saved?.automation_settings ?? nextDoc,
    organizationId,
    storeId,
    typeof saved?.updated_at === "string" ? saved.updated_at : null,
  );

  return { ok: true, view };
}
