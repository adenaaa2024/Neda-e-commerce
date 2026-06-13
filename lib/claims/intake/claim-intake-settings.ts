/**
 * Phase 7C — claim intake settings resolver.
 * Reads `workspace_settings.module_configs.claim_intake` (platform level) merged
 * with `organization_settings.claim_policy.intake` (company level). No hardcoded
 * policy: every knob has a default and a JSONB override path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CLAIM_SOURCE_KINDS,
  isClaimSourceKind,
  type ClaimIntakeSettings,
  type ClaimIntakeWindow,
  type ClaimSourceKind,
} from "./claim-intake-types";

export const DEFAULT_CLAIM_INTAKE_SETTINGS: ClaimIntakeSettings = {
  enabled_sources: [...CLAIM_SOURCE_KINDS],
  purchased_sources: {},
  date_from: null,
  date_to: null,
  rolling_window_days: 90,
  excluded_source_tables: [],
  schedule_frequency: "manual",
  manual_run_enabled: true,
  per_run_row_limit: 300,
  delayed_not_received_days: 14,
  manual_import_rows: [],
  cogs_overrides: {},
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseSourceList(v: unknown): ClaimSourceKind[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(isClaimSourceKind);
  return out.length > 0 ? out : null;
}

function parseIsoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function parsePositiveInt(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v ?? NaN));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function mergeIntakeConfig(
  base: ClaimIntakeSettings,
  raw: unknown,
): ClaimIntakeSettings {
  const o = asRecord(raw);
  if (!o) return base;

  const purchased: Partial<Record<ClaimSourceKind, boolean>> = { ...base.purchased_sources };
  const purchasedRaw = asRecord(o.purchased_sources);
  if (purchasedRaw) {
    for (const k of CLAIM_SOURCE_KINDS) {
      if (purchasedRaw[k] === true || purchasedRaw[k] === false) {
        purchased[k] = purchasedRaw[k] === true;
      }
    }
  }

  const freqRaw = String(o.schedule_frequency ?? "").trim();
  const schedule_frequency = (["manual", "hourly", "daily", "weekly"] as const).includes(
    freqRaw as ClaimIntakeSettings["schedule_frequency"],
  )
    ? (freqRaw as ClaimIntakeSettings["schedule_frequency"])
    : base.schedule_frequency;

  return {
    enabled_sources: parseSourceList(o.enabled_sources) ?? base.enabled_sources,
    purchased_sources: purchased,
    date_from: parseIsoDate(o.date_from) ?? base.date_from,
    date_to: parseIsoDate(o.date_to) ?? base.date_to,
    rolling_window_days: parsePositiveInt(o.rolling_window_days, base.rolling_window_days),
    excluded_source_tables: Array.isArray(o.excluded_source_tables)
      ? o.excluded_source_tables.map((t) => String(t ?? "").trim()).filter(Boolean)
      : base.excluded_source_tables,
    schedule_frequency,
    manual_run_enabled:
      o.manual_run_enabled === false ? false : o.manual_run_enabled === true ? true : base.manual_run_enabled,
    per_run_row_limit: parsePositiveInt(o.per_run_row_limit, base.per_run_row_limit),
    delayed_not_received_days: parsePositiveInt(
      o.delayed_not_received_days,
      base.delayed_not_received_days,
    ),
    manual_import_rows: Array.isArray(o.manual_import_rows)
      ? o.manual_import_rows.filter((r): r is Record<string, unknown> => asRecord(r) !== null)
      : base.manual_import_rows,
    cogs_overrides: asRecord(o.cogs_overrides) ?? base.cogs_overrides,
  };
}

/**
 * Platform (workspace_settings.module_configs.claim_intake) merged with
 * company (organization_settings.claim_policy.intake). Company wins.
 */
export async function loadClaimIntakeSettings(
  client: SupabaseClient,
  organizationId: string,
): Promise<{ settings: ClaimIntakeSettings; sources_read: string[] }> {
  const sourcesRead: string[] = [];
  let settings = { ...DEFAULT_CLAIM_INTAKE_SETTINGS };

  const { data: ws } = await client
    .from("workspace_settings")
    .select("module_configs")
    .limit(1)
    .maybeSingle();
  const wsIntake = asRecord((ws as { module_configs?: unknown } | null)?.module_configs)?.claim_intake;
  if (wsIntake) {
    settings = mergeIntakeConfig(settings, wsIntake);
    sourcesRead.push("workspace_settings.module_configs.claim_intake");
  } else {
    sourcesRead.push("workspace_settings.module_configs.claim_intake (absent — defaults)");
  }

  const { data: org } = await client
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const orgIntake = asRecord((org as { claim_policy?: unknown } | null)?.claim_policy)?.intake;
  if (orgIntake) {
    settings = mergeIntakeConfig(settings, orgIntake);
    sourcesRead.push("organization_settings.claim_policy.intake");
  } else {
    sourcesRead.push("organization_settings.claim_policy.intake (absent — platform/defaults)");
  }

  return { settings, sources_read: sourcesRead };
}

/** Effective run window: explicit run args > explicit settings > rolling window. */
export function resolveClaimIntakeWindow(
  settings: ClaimIntakeSettings,
  runFrom: string | null,
  runTo: string | null,
  now: Date = new Date(),
): ClaimIntakeWindow {
  const today = now.toISOString().slice(0, 10);
  if (runFrom || runTo) {
    return {
      from: runFrom ?? settings.date_from ?? rollingFrom(settings.rolling_window_days, now),
      to: runTo ?? settings.date_to ?? today,
      source: "explicit_run",
    };
  }
  if (settings.date_from || settings.date_to) {
    return {
      from: settings.date_from ?? rollingFrom(settings.rolling_window_days, now),
      to: settings.date_to ?? today,
      source: "explicit_settings",
    };
  }
  return {
    from: rollingFrom(settings.rolling_window_days, now),
    to: today,
    source: "rolling_window",
  };
}

function rollingFrom(days: number, now: Date): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Per-source gating: enabled (settings) AND purchased (SaaS plan). */
export function evaluateSourceGate(
  settings: ClaimIntakeSettings,
  kind: ClaimSourceKind,
): { enabled: boolean; purchased: boolean; skip_reason: string | null } {
  const enabled = settings.enabled_sources.includes(kind);
  const purchased = settings.purchased_sources[kind] !== false;
  if (!enabled) return { enabled, purchased, skip_reason: "disabled_in_settings" };
  if (!purchased) return { enabled, purchased, skip_reason: "not_purchased_pro_feature" };
  return { enabled, purchased, skip_reason: null };
}
