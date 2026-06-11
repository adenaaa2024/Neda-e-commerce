import type { SupabaseClient } from "@supabase/supabase-js";

export type MenorixAiModuleAccess = {
  state: "locked" | "setup_required" | "ready";
  module_enabled: boolean;
  api_key_configured: boolean;
  reason: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Read-only AI module gate — no external HTTP, no model calls.
 * Uses workspace module_configs + env presence only.
 */
export async function evaluateMenorixAiModuleAccess(
  client: SupabaseClient,
  _organizationId: string,
): Promise<MenorixAiModuleAccess> {
  const { data: ws } = await client.from("workspace_settings").select("module_configs").limit(1).maybeSingle();
  const mc = asRecord((ws as { module_configs?: unknown } | null)?.module_configs);
  const ai = asRecord(mc?.ai_assistant);
  const moduleEnabled = ai?.enabled === true;

  const apiKeyConfigured = Boolean(
    process.env.OPENAI_API_KEY?.trim() ||
      process.env.AZURE_OPENAI_API_KEY?.trim() ||
      process.env.ANTHROPIC_API_KEY?.trim(),
  );

  if (!moduleEnabled) {
    return {
      state: "locked",
      module_enabled: false,
      api_key_configured: apiKeyConfigured,
      reason: "AI assistant module is not enabled for this workspace.",
    };
  }

  if (!apiKeyConfigured) {
    return {
      state: "setup_required",
      module_enabled: true,
      api_key_configured: false,
      reason: "AI module is enabled but no provider API key is configured.",
    };
  }

  return {
    state: "ready",
    module_enabled: true,
    api_key_configured: true,
    reason: null,
  };
}
