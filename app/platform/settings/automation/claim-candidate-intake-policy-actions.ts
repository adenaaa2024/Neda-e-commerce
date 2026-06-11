"use server";

/**
 * Phase 7E — load/save claim candidate intake policy at platform, company, and store tiers.
 * JSONB only — no migrations. Does not run generators.
 */
import { evaluateClaimPermissionForActor } from "@/lib/claim-permission-evaluate";
import {
  DEFAULT_CLAIM_CANDIDATE_INTAKE_POLICY,
  normalizeClaimCandidateIntakePolicy,
  type ClaimCandidateIntakePolicy,
} from "@/lib/claim-candidate-intake-policy";
import {
  buildClaimCandidateIntakeResolutionSteps,
  resolveClaimCandidateIntakePolicy,
} from "@/lib/claim-candidate-intake-policy-resolution";
import type { ClaimIntakeSettings, ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";
import { DEFAULT_CLAIM_INTAKE_SETTINGS } from "@/lib/claims/intake/claim-intake-settings";
import { canEditPlatformProductSettings } from "@/lib/platform-product-settings-access";
import {
  automationScopeKey,
  parseAutomationPersisted,
  readStoreAutomationSettings,
} from "@/lib/platform-automation-scope-storage";
import { normalizeStoreAutomationSettings } from "@/lib/platform-automation-schedule";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";
import { getAuthenticatedPlatformRoleKey } from "../platform-settings-actions";
import type { ClaimCandidateIntakePolicyBundle } from "./claim-candidate-intake-policy-action-types";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function mergeIntakePartial(base: ClaimIntakeSettings, raw: unknown): ClaimIntakeSettings {
  const o = asRecord(raw);
  if (!o) return base;
  const enabled = Array.isArray(o.enabled_sources)
    ? o.enabled_sources.filter((k): k is ClaimSourceKind => typeof k === "string")
    : base.enabled_sources;
  const purchased = { ...base.purchased_sources };
  const purchasedRaw = asRecord(o.purchased_sources);
  if (purchasedRaw) {
    for (const [k, v] of Object.entries(purchasedRaw)) {
      if (v === true || v === false) purchased[k as ClaimSourceKind] = v === true;
    }
  }
  const freqRaw = String(o.schedule_frequency ?? "").trim();
  const schedule_frequency = (["manual", "hourly", "daily", "weekly"] as const).includes(
    freqRaw as ClaimIntakeSettings["schedule_frequency"],
  )
    ? (freqRaw as ClaimIntakeSettings["schedule_frequency"])
    : base.schedule_frequency;

  return {
    ...base,
    enabled_sources: enabled.length ? enabled : base.enabled_sources,
    purchased_sources: purchased,
    date_from:
      typeof o.date_from === "string" && /^\d{4}-\d{2}-\d{2}/.test(o.date_from)
        ? o.date_from.slice(0, 10)
        : base.date_from,
    date_to:
      typeof o.date_to === "string" && /^\d{4}-\d{2}-\d{2}/.test(o.date_to)
        ? o.date_to.slice(0, 10)
        : base.date_to,
    rolling_window_days:
      Number.isFinite(Number(o.rolling_window_days)) && Number(o.rolling_window_days) > 0
        ? Math.floor(Number(o.rolling_window_days))
        : base.rolling_window_days,
    schedule_frequency,
    manual_run_enabled:
      o.manual_run_enabled === false ? false : o.manual_run_enabled === true ? true : base.manual_run_enabled,
    per_run_row_limit:
      Number.isFinite(Number(o.per_run_row_limit)) && Number(o.per_run_row_limit) > 0
        ? Math.floor(Number(o.per_run_row_limit))
        : base.per_run_row_limit,
    delayed_not_received_days:
      Number.isFinite(Number(o.delayed_not_received_days)) && Number(o.delayed_not_received_days) > 0
        ? Math.floor(Number(o.delayed_not_received_days))
        : base.delayed_not_received_days,
    excluded_source_tables: Array.isArray(o.excluded_source_tables)
      ? o.excluded_source_tables.map((t) => String(t ?? "").trim()).filter(Boolean)
      : base.excluded_source_tables,
    manual_import_rows: Array.isArray(o.manual_import_rows)
      ? o.manual_import_rows.filter((r): r is Record<string, unknown> => asRecord(r) !== null)
      : base.manual_import_rows,
    cogs_overrides: asRecord(o.cogs_overrides) ?? base.cogs_overrides,
  };
}

async function assertSuperadmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  const roleKey = await getAuthenticatedPlatformRoleKey();
  if (!roleKey) return { ok: false, error: "Not signed in." };
  if (!canEditPlatformProductSettings(roleKey)) {
    return { ok: false, error: "Only super_admin can edit platform automation policy." };
  }
  return { ok: true };
}

async function loadWorkspaceModuleConfigs(): Promise<Record<string, unknown>> {
  const { data } = await supabaseServer.from("workspace_settings").select("module_configs").limit(1).maybeSingle();
  return asRecord((data as { module_configs?: unknown } | null)?.module_configs) ?? {};
}

async function loadOrgClaimPolicyRaw(organizationId: string): Promise<Record<string, unknown>> {
  const { data } = await supabaseServer
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", organizationId)
    .maybeSingle();
  return asRecord((data as { claim_policy?: unknown } | null)?.claim_policy) ?? {};
}

export async function getClaimCandidateIntakePolicyBundleAction(args: {
  organizationId: string;
  /** Optional — omit on company settings page to skip store automation layer. */
  storeId?: string | null;
}): Promise<{ ok: true; bundle: ClaimCandidateIntakePolicyBundle } | { ok: false; error: string }> {
  const organizationId = args.organizationId.trim();
  const storeId = String(args.storeId ?? "").trim();
  if (!isUuidString(organizationId)) {
    return { ok: false, error: "organization_id must be a UUID." };
  }
  const hasStore = isUuidString(storeId);

  const moduleConfigs = await loadWorkspaceModuleConfigs();
  const platformCandidateRaw = moduleConfigs.claim_candidate_intake;
  const platformIntakeRaw = moduleConfigs.claim_intake;

  const claimPolicy = await loadOrgClaimPolicyRaw(organizationId);
  const companyCandidateRaw = claimPolicy.candidate_intake;
  const companyIntakeRaw = claimPolicy.intake;
  const allowManualOverride = claimPolicy.allow_manual_override === true;

  const { data: platformRow } = await supabaseServer
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();
  const scopeSettings = hasStore
    ? readStoreAutomationSettings(
        (platformRow as { automation_settings?: unknown } | null)?.automation_settings,
        organizationId,
        storeId,
      )
    : null;

  const platformIntake = mergeIntakePartial({ ...DEFAULT_CLAIM_INTAKE_SETTINGS }, platformIntakeRaw);
  const companyIntake = mergeIntakePartial(platformIntake, companyIntakeRaw);
  const platformCandidate = normalizeClaimCandidateIntakePolicy(platformCandidateRaw);
  const companyCandidate = resolveClaimCandidateIntakePolicy({
    platformRaw: platformCandidateRaw,
    companyRaw: companyCandidateRaw,
    storeRaw: null,
  });
  const effectiveCandidate = resolveClaimCandidateIntakePolicy({
    platformRaw: platformCandidateRaw,
    companyRaw: companyCandidateRaw,
    storeRaw: scopeSettings?.claim_candidate_intake ?? null,
  });

  const defaultClaimPool = normalizeStoreAutomationSettings({}).claim_pool_generation;

  return {
    ok: true,
    bundle: {
      organization_id: organizationId,
      store_id: hasStore ? storeId : "",
      platform: {
        candidate_intake: platformCandidate,
        intake: platformIntake,
        candidate_intake_configured: platformCandidateRaw != null,
        intake_configured: platformIntakeRaw != null,
      },
      company: {
        candidate_intake: companyCandidate,
        intake: companyIntake,
        allow_manual_override: allowManualOverride,
        candidate_intake_configured: companyCandidateRaw != null,
        intake_configured: companyIntakeRaw != null,
      },
      store: {
        candidate_intake: scopeSettings?.claim_candidate_intake ?? null,
        claim_pool: scopeSettings?.claim_pool_generation ?? defaultClaimPool,
        candidate_intake_configured: scopeSettings?.claim_candidate_intake != null,
      },
      effective: {
        candidate_intake: effectiveCandidate,
        intake: companyIntake,
      },
      resolution_steps: buildClaimCandidateIntakeResolutionSteps({
        platformCandidateRaw,
        platformIntakeRaw,
        companyCandidateRaw,
        companyIntakeRaw,
        storeCandidateRaw: scopeSettings?.claim_candidate_intake ?? null,
        storeClaimPool: hasStore ? scopeSettings?.claim_pool_generation ?? null : null,
      }),
    },
  };
}

export async function savePlatformClaimCandidateIntakePolicyAction(args: {
  candidate_intake: ClaimCandidateIntakePolicy;
  intake: ClaimIntakeSettings;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return gate;

  const moduleConfigs = await loadWorkspaceModuleConfigs();
  const nextConfigs = {
    ...moduleConfigs,
    claim_candidate_intake: normalizeClaimCandidateIntakePolicy(args.candidate_intake),
    claim_intake: args.intake,
  };

  const { data: existing } = await supabaseServer.from("workspace_settings").select("id").limit(1).maybeSingle();
  if (!existing) {
    return { ok: false, error: "workspace_settings row not found." };
  }

  const { error } = await supabaseServer
    .from("workspace_settings")
    .update({ module_configs: nextConfigs })
    .eq("id", (existing as { id: unknown }).id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function saveCompanyClaimCandidateIntakePolicyAction(args: {
  organizationId: string;
  candidate_intake: ClaimCandidateIntakePolicy;
  intake: ClaimIntakeSettings;
  allow_manual_override: boolean;
  actorProfileId?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const organizationId = args.organizationId.trim();
  if (!isUuidString(organizationId)) return { ok: false, error: "Invalid organization id." };

  const actorId = args.actorProfileId?.trim() ?? "";
  if (actorId) {
    const perm = await evaluateClaimPermissionForActor("claims.settings.manage", actorId, {
      organizationId,
    });
    if (!perm.ok) return { ok: false, error: perm.message };
  }

  const claimPolicy = await loadOrgClaimPolicyRaw(organizationId);
  const nextPolicy = {
    ...claimPolicy,
    candidate_intake: normalizeClaimCandidateIntakePolicy(args.candidate_intake),
    intake: args.intake,
    allow_manual_override: args.allow_manual_override === true,
  };

  const { data: existing } = await supabaseServer
    .from("organization_settings")
    .select(
      "is_ai_label_ocr_enabled, is_ai_packing_slip_ocr_enabled, default_claim_evidence, company_display_name",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();

  const ex = existing as {
    is_ai_label_ocr_enabled?: boolean;
    is_ai_packing_slip_ocr_enabled?: boolean;
    default_claim_evidence?: Record<string, unknown>;
    company_display_name?: string | null;
  } | null;

  const row = {
    organization_id: organizationId,
    is_ai_label_ocr_enabled: ex?.is_ai_label_ocr_enabled ?? false,
    is_ai_packing_slip_ocr_enabled: ex?.is_ai_packing_slip_ocr_enabled ?? false,
    default_claim_evidence: ex?.default_claim_evidence ?? {},
    company_display_name: ex?.company_display_name ?? null,
    claim_policy: nextPolicy,
  };

  const { error } = await supabaseServer.from("organization_settings").upsert(row, {
    onConflict: "organization_id",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function saveStoreClaimCandidateIntakePolicyAction(args: {
  organizationId: string;
  storeId: string;
  /** Null clears store override (inherit company). */
  candidate_intake: ClaimCandidateIntakePolicy | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return gate;

  const organizationId = args.organizationId.trim();
  const storeId = args.storeId.trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "organization_id and store_id must be UUIDs." };
  }

  const { data: existing, error: readErr } = await supabaseServer
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };

  const raw = (existing as { automation_settings?: unknown } | null)?.automation_settings ?? null;
  const doc = parseAutomationPersisted(raw);
  const key = automationScopeKey(organizationId, storeId);
  const beforeScope = normalizeStoreAutomationSettings(doc.scopes[key] ?? {});
  const afterScope = normalizeStoreAutomationSettings({
    ...beforeScope,
    claim_candidate_intake:
      args.candidate_intake != null
        ? normalizeClaimCandidateIntakePolicy(args.candidate_intake)
        : null,
  });

  const persisted = {
    version: 2 as const,
    scopes: {
      ...doc.scopes,
      [key]: afterScope,
    },
  };

  const { error: writeErr } = await supabaseServer
    .from("platform_settings")
    .update({ automation_settings: persisted, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (writeErr) return { ok: false, error: writeErr.message };
  return { ok: true };
}

export async function clearStoreClaimCandidateIntakePolicyAction(args: {
  organizationId: string;
  storeId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return saveStoreClaimCandidateIntakePolicyAction({
    organizationId: args.organizationId,
    storeId: args.storeId,
    candidate_intake: null,
  });
}
