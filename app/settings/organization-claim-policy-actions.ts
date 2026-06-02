"use server";

import { evaluateClaimPermissionForActor } from "../../lib/claim-permission-evaluate";
import { resolveTenantOrganizationId, type TenantWriteContext } from "../../lib/server-tenant";
import { supabaseServer } from "../../lib/supabase-server";
import { normalizeClaimPolicy } from "../../lib/claim-eligibility-policy";
import { normalizeClaimWorkflowFromPolicyJson } from "../../lib/claim-effective-settings";
import {
  type ClaimGroupBySetting,
  type ClaimWorkflowSettings,
  type CreateCaseWhenSetting,
} from "../../lib/claim-effective-settings-shared";
import {
  DEFAULT_CLAIM_POLICY_V1,
  type ClaimGroupingPolicy,
  type ClaimHoldPolicyFlag,
  type ClaimModuleDomain,
  type ClaimPolicyV1,
  type EnabledClaimDomains,
} from "../../lib/claim-policy-types";

export type ClaimWorkflowPolicyPatch = {
  auto_create_drafts_on_scan?: boolean;
  auto_grouping_enabled?: boolean;
  group_by?: ClaimGroupBySetting;
  create_case_when?: CreateCaseWhenSetting;
  allow_mixed_products?: boolean;
  allow_mixed_issue_types?: boolean;
  require_product_link?: boolean;
  require_operator_note?: boolean;
  require_evidence?: boolean;
};

export type ClaimPolicyPatch = {
  scan_go_live_date?: string | null;
  claim_start_date?: string | null;
  claim_eligibility_window_days?: number;
  claim_grouping_policy?: ClaimGroupingPolicy;
  hold_until_package_closed?: boolean;
  enabled_claim_domains?: Partial<EnabledClaimDomains>;
} & ClaimWorkflowPolicyPatch;

export type OrganizationClaimSettingsBundle = {
  policy: ClaimPolicyV1;
  workflow: ClaimWorkflowSettings;
  auto_create_drafts_on_scan: boolean;
};

function emptyDateToNull(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function mergeEnabledDomains(
  current: EnabledClaimDomains,
  patch?: Partial<EnabledClaimDomains>,
): EnabledClaimDomains {
  if (!patch) return current;
  const next = { ...current };
  for (const key of Object.keys(patch) as ClaimModuleDomain[]) {
    if (patch[key] === true) next[key] = true;
    else if (patch[key] === false) next[key] = false;
  }
  return next;
}

async function loadClaimPolicyRaw(
  companyId: string,
): Promise<{ raw: unknown; policy: ClaimPolicyV1 }> {
  const { data, error } = await supabaseServer
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", companyId)
    .maybeSingle();
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("claim_policy") || msg.includes("column") || msg.includes("schema cache")) {
      return { raw: null, policy: normalizeClaimPolicy(null) };
    }
    return { raw: null, policy: { ...DEFAULT_CLAIM_POLICY_V1 } };
  }
  const raw = (data as { claim_policy?: unknown } | null)?.claim_policy;
  return { raw, policy: normalizeClaimPolicy(raw) };
}

export async function getOrganizationClaimPolicy(
  tenant?: TenantWriteContext | null,
): Promise<ClaimPolicyV1> {
  const companyId = await resolveTenantOrganizationId(tenant);
  try {
    return (await loadClaimPolicyRaw(companyId)).policy;
  } catch {
    return { ...DEFAULT_CLAIM_POLICY_V1 };
  }
}

export async function getOrganizationClaimSettingsBundle(
  tenant?: TenantWriteContext | null,
): Promise<OrganizationClaimSettingsBundle> {
  const companyId = await resolveTenantOrganizationId(tenant);
  const { raw, policy } = await loadClaimPolicyRaw(companyId);
  const workflow = normalizeClaimWorkflowFromPolicyJson(raw, policy);
  const orgAuto =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).auto_create_drafts_on_scan
      : undefined;
  return {
    policy,
    workflow,
    auto_create_drafts_on_scan: orgAuto === true || orgAuto === false ? orgAuto === true : true,
  };
}

export async function saveOrganizationClaimPolicy(
  patch: ClaimPolicyPatch,
  tenant?: TenantWriteContext | null,
): Promise<{ ok: boolean; error?: string; policy?: ClaimPolicyV1 }> {
  const companyId = await resolveTenantOrganizationId(tenant);
  const actorId = tenant?.actorProfileId?.trim() ?? "";
  if (actorId) {
    const perm = await evaluateClaimPermissionForActor("claims.settings.manage", actorId, {
      organizationId: companyId,
    });
    if (!perm.ok) {
      return { ok: false, error: perm.message };
    }
  }

  try {
    const { raw: rawExisting, policy: current } = await loadClaimPolicyRaw(companyId);
    const holdFlags = new Set(current.claim_hold_policy);
    if (patch.hold_until_package_closed === true) {
      holdFlags.add("hold_until_package_closed");
    } else if (patch.hold_until_package_closed === false) {
      holdFlags.delete("hold_until_package_closed");
    }

    const domainPatch = patch.enabled_claim_domains;
    const mergedDomains = mergeEnabledDomains(current.enabled_claim_domains, domainPatch);
    if (domainPatch) {
      for (const key of Object.keys(domainPatch) as ClaimModuleDomain[]) {
        if (domainPatch[key] === true && key !== "returns") {
          return {
            ok: false,
            error: `${key} module scope cannot be enabled in phase 1 — only Returns is available.`,
          };
        }
      }
    }

    const merged = normalizeClaimPolicy({
      ...current,
      scan_go_live_date:
        patch.scan_go_live_date !== undefined
          ? emptyDateToNull(patch.scan_go_live_date)
          : current.scan_go_live_date,
      claim_start_date:
        patch.claim_start_date !== undefined
          ? emptyDateToNull(patch.claim_start_date)
          : current.claim_start_date,
      claim_eligibility_window_days:
        patch.claim_eligibility_window_days ?? current.claim_eligibility_window_days,
      claim_grouping_policy: patch.claim_grouping_policy ?? current.claim_grouping_policy,
      claim_hold_policy: [...holdFlags] as ClaimHoldPolicyFlag[],
      enabled_claim_domains: mergedDomains,
    });

    const workflowCurrent = normalizeClaimWorkflowFromPolicyJson(rawExisting, merged);
    const workflowNext: ClaimWorkflowSettings = {
      auto_grouping_enabled:
        patch.auto_grouping_enabled ?? workflowCurrent.auto_grouping_enabled,
      group_by: patch.group_by ?? workflowCurrent.group_by,
      create_case_when: patch.create_case_when ?? workflowCurrent.create_case_when,
      allow_mixed_products: patch.allow_mixed_products ?? workflowCurrent.allow_mixed_products,
      allow_mixed_issue_types:
        patch.allow_mixed_issue_types ?? workflowCurrent.allow_mixed_issue_types,
      require_product_link: patch.require_product_link ?? workflowCurrent.require_product_link,
      require_operator_note: patch.require_operator_note ?? workflowCurrent.require_operator_note,
      require_evidence: patch.require_evidence ?? workflowCurrent.require_evidence,
    };

    const claim_policy: Record<string, unknown> = {
      ...merged,
      auto_grouping_enabled: workflowNext.auto_grouping_enabled,
      group_by: workflowNext.group_by,
      create_case_when: workflowNext.create_case_when,
      allow_mixed_products: workflowNext.allow_mixed_products,
      allow_mixed_issue_types: workflowNext.allow_mixed_issue_types,
      require_product_link: workflowNext.require_product_link,
      require_operator_note: workflowNext.require_operator_note,
      require_evidence: workflowNext.require_evidence,
    };
    if (patch.auto_create_drafts_on_scan !== undefined) {
      claim_policy.auto_create_drafts_on_scan = patch.auto_create_drafts_on_scan;
    } else if (
      rawExisting &&
      typeof rawExisting === "object" &&
      !Array.isArray(rawExisting) &&
      (rawExisting as Record<string, unknown>).auto_create_drafts_on_scan !== undefined
    ) {
      claim_policy.auto_create_drafts_on_scan = (
        rawExisting as Record<string, unknown>
      ).auto_create_drafts_on_scan;
    }

    const { data: existing } = await supabaseServer
      .from("organization_settings")
      .select(
        "is_ai_label_ocr_enabled, is_ai_packing_slip_ocr_enabled, default_claim_evidence, company_display_name",
      )
      .eq("organization_id", companyId)
      .maybeSingle();

    const ex = existing as {
      is_ai_label_ocr_enabled?: boolean;
      is_ai_packing_slip_ocr_enabled?: boolean;
      default_claim_evidence?: Record<string, unknown>;
      company_display_name?: string | null;
    } | null;

    const row = {
      organization_id: companyId,
      is_ai_label_ocr_enabled: ex?.is_ai_label_ocr_enabled ?? false,
      is_ai_packing_slip_ocr_enabled: ex?.is_ai_packing_slip_ocr_enabled ?? false,
      default_claim_evidence: ex?.default_claim_evidence ?? {},
      company_display_name: ex?.company_display_name ?? null,
      claim_policy,
    };

    const { error: upsertErr } = await supabaseServer.from("organization_settings").upsert(row, {
      onConflict: "organization_id",
    });
    if (upsertErr) {
      const msg = upsertErr.message.toLowerCase();
      if (msg.includes("claim_policy") || msg.includes("column")) {
        return {
          ok: false,
          error:
            "claim_policy column is not on organization_settings yet. Apply the phase-1 migration on staging first.",
        };
      }
      return { ok: false, error: upsertErr.message };
    }
    return { ok: true, policy: merged };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed." };
  }
}
