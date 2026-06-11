/**
 * Claim Discovery Engine — automation schedule load/save + cron runtime persistence.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  computeClaimDiscoveryNextRun,
  normalizeStoreAutomationSettings,
} from "../../platform-automation-schedule";
import {
  parseAutomationPersisted,
  automationScopeKey,
  writeStoreAutomationSettings,
} from "../../platform-automation-scope-storage";
import type {
  AutomationRunStatus,
  ClaimDiscoverySchedule,
  RemovalCronRuntimeState,
} from "../../platform-automation-settings-types";
import { runClaimDiscovery, type RunClaimDiscoveryArgs } from "./claim-discovery-engine";
import type { ClaimDiscoveryRunOutcome } from "./claim-discovery-types";

export async function loadClaimDiscoverySchedule(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<{ schedule: ClaimDiscoverySchedule; rawSettings: unknown; updatedAt: string | null }> {
  const { data } = await client
    .from("platform_settings")
    .select("automation_settings, updated_at")
    .eq("id", true)
    .maybeSingle();
  const raw = (data as { automation_settings?: unknown; updated_at?: string } | null) ?? null;
  const doc = parseAutomationPersisted(raw?.automation_settings);
  const scope = doc.scopes[automationScopeKey(organizationId, storeId)];
  const normalized = normalizeStoreAutomationSettings(scope ?? {});
  return {
    schedule: normalized.claim_discovery,
    rawSettings: raw?.automation_settings ?? null,
    updatedAt: typeof raw?.updated_at === "string" ? raw.updated_at : null,
  };
}

export async function persistClaimDiscoveryCronRuntime(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  patch: Partial<RemovalCronRuntimeState>,
): Promise<void> {
  const { data } = await client
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();
  const raw = (data as { automation_settings?: unknown } | null)?.automation_settings ?? null;
  const doc = parseAutomationPersisted(raw);
  const key = automationScopeKey(organizationId, storeId);
  const scope = normalizeStoreAutomationSettings(doc.scopes[key] ?? {});
  const prev: RemovalCronRuntimeState = scope.claim_discovery.cron_runtime ?? {
    last_run_at: null,
    last_success_at: null,
    last_failed_at: null,
    last_run_status: "never",
    last_error: null,
    next_run_at: null,
    last_slot_key: null,
  };
  const nextSchedule: ClaimDiscoverySchedule = {
    ...scope.claim_discovery,
    cron_runtime: {
      ...prev,
      ...patch,
      next_run_at:
        patch.next_run_at !== undefined
          ? patch.next_run_at
          : (computeClaimDiscoveryNextRun(scope.claim_discovery)?.toISOString() ?? null),
    },
  };
  const persisted = writeStoreAutomationSettings(raw, organizationId, storeId, {
    ...scope,
    claim_discovery: nextSchedule,
  });
  await client
    .from("platform_settings")
    .update({ automation_settings: persisted, updated_at: new Date().toISOString() })
    .eq("id", true);
}

export type ClaimDiscoveryAutomationRunArgs = Omit<RunClaimDiscoveryArgs, "schedule"> & {
  schedule: ClaimDiscoverySchedule;
};

export async function runClaimDiscoveryAutomation(
  args: ClaimDiscoveryAutomationRunArgs,
): Promise<ClaimDiscoveryRunOutcome> {
  return runClaimDiscovery(args);
}

export function discoveryRunStatusFromOutcome(outcome: ClaimDiscoveryRunOutcome): AutomationRunStatus {
  if (outcome.error && outcome.counts.sources_ran === 0) return "failed";
  if (outcome.counts.errors > 0) return "partial";
  return "success";
}
