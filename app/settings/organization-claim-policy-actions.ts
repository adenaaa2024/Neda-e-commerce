"use server";

import { resolveTenantOrganizationId, type TenantWriteContext } from "../../lib/server-tenant";
import { supabaseServer } from "../../lib/supabase-server";
import { normalizeClaimPolicy } from "../../lib/claim-eligibility-policy";
import {
  DEFAULT_CLAIM_POLICY_V1,
  type ClaimGroupingPolicy,
  type ClaimHoldPolicyFlag,
  type ClaimPolicyV1,
} from "../../lib/claim-policy-types";

export type ClaimPolicyPatch = {
  scan_go_live_date?: string | null;
  claim_start_date?: string | null;
  claim_eligibility_window_days?: number;
  claim_grouping_policy?: ClaimGroupingPolicy;
  hold_until_package_closed?: boolean;
};

function emptyDateToNull(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

export async function getOrganizationClaimPolicy(
  tenant?: TenantWriteContext | null,
): Promise<ClaimPolicyV1> {
  const companyId = await resolveTenantOrganizationId(tenant);
  try {
    const { data, error } = await supabaseServer
      .from("organization_settings")
      .select("claim_policy")
      .eq("organization_id", companyId)
      .maybeSingle();
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("claim_policy") || msg.includes("column") || msg.includes("schema cache")) {
        return normalizeClaimPolicy(null);
      }
      return { ...DEFAULT_CLAIM_POLICY_V1 };
    }
    const raw = (data as { claim_policy?: unknown } | null)?.claim_policy;
    return normalizeClaimPolicy(raw);
  } catch {
    return { ...DEFAULT_CLAIM_POLICY_V1 };
  }
}

export async function saveOrganizationClaimPolicy(
  patch: ClaimPolicyPatch,
  tenant?: TenantWriteContext | null,
): Promise<{ ok: boolean; error?: string; policy?: ClaimPolicyV1 }> {
  const companyId = await resolveTenantOrganizationId(tenant);
  try {
    const current = await getOrganizationClaimPolicy(tenant);
    const holdFlags = new Set(current.claim_hold_policy);
    if (patch.hold_until_package_closed === true) {
      holdFlags.add("hold_until_package_closed");
    } else if (patch.hold_until_package_closed === false) {
      holdFlags.delete("hold_until_package_closed");
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
    });

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
      claim_policy: merged as unknown as Record<string, unknown>,
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
