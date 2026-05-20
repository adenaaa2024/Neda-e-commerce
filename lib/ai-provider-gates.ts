import "server-only";

export type AiProviderSurface =
  | "raw_agent_proxy"
  | "packing_slip_vision"
  | "import_gpt_fallback"
  | "pim_disambiguation"
  | "settings_provider_test";

export type AiProviderGateDecision =
  | { ok: true; surface: AiProviderSurface }
  | {
      ok: false;
      surface: AiProviderSurface;
      reason: "external_http_disabled" | "surface_disabled";
      requiredFlags: string[];
    };

const SURFACE_FLAGS: Record<AiProviderSurface, string> = {
  raw_agent_proxy: "AI_RAW_AGENT_PROXY_ENABLED",
  packing_slip_vision: "AI_PACKING_SLIP_VISION_ENABLED",
  import_gpt_fallback: "AI_IMPORT_GPT_FALLBACK_ENABLED",
  pim_disambiguation: "AI_PIM_DISAMBIGUATION_ENABLED",
  settings_provider_test: "AI_SETTINGS_PROVIDER_TEST_ENABLED",
};

const EXTERNAL_HTTP_FLAG = "AI_EXTERNAL_HTTP_ENABLED";

function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function getAiProviderSurfaceFlag(surface: AiProviderSurface): string {
  return SURFACE_FLAGS[surface];
}

export function assertAiProviderCallAllowed(surface: AiProviderSurface): AiProviderGateDecision {
  const surfaceFlag = SURFACE_FLAGS[surface];
  const requiredFlags = [EXTERNAL_HTTP_FLAG, surfaceFlag];

  if (!envFlagEnabled(EXTERNAL_HTTP_FLAG)) {
    return {
      ok: false,
      surface,
      reason: "external_http_disabled",
      requiredFlags,
    };
  }

  if (!envFlagEnabled(surfaceFlag)) {
    return {
      ok: false,
      surface,
      reason: "surface_disabled",
      requiredFlags,
    };
  }

  return { ok: true, surface };
}

export function aiProviderGateMessage(decision: Exclude<AiProviderGateDecision, { ok: true }>): string {
  return `AI provider calls are disabled for ${decision.surface}. Required flags: ${decision.requiredFlags.join(", ")}.`;
}
