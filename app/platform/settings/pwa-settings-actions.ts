"use server";

import { normalizePlatformPwaSettings } from "@/lib/pwa-settings-normalize";
import type { PlatformPwaSettings } from "@/lib/pwa-settings-types";
import { canEditPlatformProductSettings } from "@/lib/platform-product-settings-access";
import { supabaseServer } from "@/lib/supabase-server";
import { getAuthenticatedPlatformRoleKey } from "./platform-settings-actions";

type AccessDenied = "not_authenticated" | "forbidden";

export type PlatformPwaSettingsView = PlatformPwaSettings & {
  accessDenied: AccessDenied | null;
};

export async function getPlatformPwaSettingsAction(): Promise<PlatformPwaSettingsView> {
  const roleKey = await getAuthenticatedPlatformRoleKey();
  if (!roleKey) {
    return { ...normalizePlatformPwaSettings(null), accessDenied: "not_authenticated" };
  }
  if (!canEditPlatformProductSettings(roleKey)) {
    return { ...normalizePlatformPwaSettings(null), accessDenied: "forbidden" };
  }

  const { data } = await supabaseServer
    .from("platform_settings")
    .select("pwa_settings")
    .eq("id", true)
    .maybeSingle();

  return {
    ...normalizePlatformPwaSettings((data as { pwa_settings?: unknown } | null)?.pwa_settings),
    accessDenied: null,
  };
}

export async function savePlatformPwaSettingsAction(
  input: PlatformPwaSettings,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const roleKey = await getAuthenticatedPlatformRoleKey();
  if (!roleKey) return { ok: false, error: "You must be signed in." };
  if (!canEditPlatformProductSettings(roleKey)) {
    return { ok: false, error: "Only super_admin can edit platform PWA settings." };
  }

  const normalized = normalizePlatformPwaSettings(input);
  const { error } = await supabaseServer
    .from("platform_settings")
    .update({ pwa_settings: normalized })
    .eq("id", true);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
