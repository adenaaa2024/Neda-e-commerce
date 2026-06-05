import "server-only";

import { normalizePlatformPwaSettings } from "./pwa-settings-normalize";
import type { PlatformPwaSettings } from "./pwa-settings-types";
import { supabaseServer } from "./supabase-server";

export async function getPlatformPwaSettings(): Promise<PlatformPwaSettings> {
  try {
    const { data, error } = await supabaseServer
      .from("platform_settings")
      .select("pwa_settings")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return normalizePlatformPwaSettings(null);
    return normalizePlatformPwaSettings(
      (data as { pwa_settings?: unknown }).pwa_settings,
    );
  } catch {
    return normalizePlatformPwaSettings(null);
  }
}

export { buildPwaVersionEndpointPayload } from "./pwa-settings-payload";
