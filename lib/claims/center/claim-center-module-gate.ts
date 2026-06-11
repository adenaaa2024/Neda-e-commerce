import type { SupabaseClient } from "@supabase/supabase-js";

import { parseEnabledClaimDomains } from "@/lib/claim-module-scope";
import { loadClaimPolicy } from "@/lib/claim-eligibility-policy";

export type ClaimCenterModuleAccess = {
  enabled: boolean;
  reason: string | null;
  claim_recovery_flag: boolean;
  any_domain_enabled: boolean;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function evaluateClaimCenterModuleAccess(
  client: SupabaseClient,
  organizationId: string,
): Promise<ClaimCenterModuleAccess> {
  const policy = await loadClaimPolicy(client, organizationId);
  const domains = policy.enabled_claim_domains;
  const anyDomain = Object.values(domains).some((v) => v === true);

  const { data: ws } = await client.from("workspace_settings").select("module_configs").limit(1).maybeSingle();
  const mc = asRecord((ws as { module_configs?: unknown } | null)?.module_configs);
  const recovery = asRecord(mc?.claim_recovery);
  const claimRecoveryFlag = recovery?.enabled === true;

  const enabled = claimRecoveryFlag || anyDomain;
  return {
    enabled,
    reason: enabled ? null : "Claim Recovery module is not enabled for this organization.",
    claim_recovery_flag: claimRecoveryFlag,
    any_domain_enabled: anyDomain,
  };
}

export async function loadEnabledDomainsForOrg(
  client: SupabaseClient,
  organizationId: string,
): Promise<ReturnType<typeof parseEnabledClaimDomains>> {
  const policy = await loadClaimPolicy(client, organizationId);
  return policy.enabled_claim_domains;
}
