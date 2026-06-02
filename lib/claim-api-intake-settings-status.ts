import type { SupabaseClient } from "@supabase/supabase-js";

import { amazonSpCredentialsLookComplete } from "./amazon-marketplace-credentials";
import {
  inventoryForIntakeSource,
  missingSettingsFromInventory,
  type ApiIntakeSettingEntry,
} from "./api-intake-settings-inventory";
import type { ClaimIntakeSourceKind } from "./claim-intake-sources";
import { readPlatformAutomationApiFlags } from "./platform-automation-api-flags";
import { buildStoreAutomationSettingsView } from "./platform-automation-run-status";
import {
  getEffectiveClaimSettings,
  toEffectiveClaimSettingsSnapshot,
} from "./claim-effective-settings";

export type IntakeSourceConnectionStatus = {
  kind: ClaimIntakeSourceKind;
  label: string;
  connected: boolean;
  disabled_by_setting: boolean;
  disabled_reason: string | null;
  last_sync_at: string | null;
  last_sync_status: string;
  last_error: string | null;
  next_sync_at: string | null;
  manual_run_available: boolean;
  manual_run_href: string | null;
  generator_status: "live" | "partial" | "planned";
  related_settings: ApiIntakeSettingEntry[];
};

async function spApiCredentialsConfigured(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<boolean> {
  const { data: store } = await client
    .from("stores")
    .select("id, marketplaces(provider, credentials)")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const mp = (store as { marketplaces?: { provider?: string; credentials?: unknown } | null } | null)?.marketplaces;
  if (mp?.provider === "amazon_sp_api" && mp.credentials && typeof mp.credentials === "object") {
    return amazonSpCredentialsLookComplete(mp.credentials);
  }
  return false;
}

async function openAiConfigured(client: SupabaseClient, organizationId: string): Promise<boolean> {
  if (process.env.OPENAI_API_KEY?.trim()) return true;
  const { data } = await client
    .from("organization_settings")
    .select("credentials")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const cred = (data as { credentials?: unknown } | null)?.credentials;
  if (cred && typeof cred === "object" && !Array.isArray(cred)) {
    const key = String((cred as Record<string, unknown>).openai_api_key ?? "").trim();
    return key.length > 8;
  }
  return false;
}

export async function buildClaimApiIntakeSettingsStatus(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
}): Promise<{
  sources: IntakeSourceConnectionStatus[];
  missing_settings: string[];
  sp_api_credentials_configured: boolean;
  api_flags: ReturnType<typeof readPlatformAutomationApiFlags>;
  claim_policy_effective: ReturnType<typeof toEffectiveClaimSettingsSnapshot>;
}> {
  const flags = readPlatformAutomationApiFlags();
  const effective = toEffectiveClaimSettingsSnapshot(
    await getEffectiveClaimSettings(args.client, args.organizationId, args.storeId),
  );
  const credsOk = await spApiCredentialsConfigured(args.client, args.organizationId, args.storeId);
  const openAiOk = await openAiConfigured(args.client, args.organizationId);

  const { data: psRow } = await args.client
    .from("platform_settings")
    .select("automation_settings, updated_at")
    .eq("id", true)
    .maybeSingle();
  const rawSettings = (psRow as { automation_settings?: unknown } | null)?.automation_settings;
  const updatedAt = (psRow as { updated_at?: string | null } | null)?.updated_at ?? null;

  const view = await buildStoreAutomationSettingsView(
    args.client,
    rawSettings,
    args.organizationId,
    args.storeId,
    updatedAt,
  );

  const removalRecentRt = view.runtime.removal_api_sync.recent;
  const reimbRt = view.runtime.reimbursements_api;
  const settRt = view.runtime.settlement_api;

  const removalDisabled =
    !flags.reports_worker_enabled ||
    !flags.removal_order_enabled ||
    !flags.removal_shipment_enabled ||
    !view.removal_api_sync.enabled;
  const reimbDisabled =
    !flags.reports_worker_enabled || !flags.reimbursements_enabled || !view.reimbursements_api.enabled;
  const settDisabled =
    !flags.reports_worker_enabled || !flags.settlement_enabled || !view.settlement_api.enabled;

  const sources: IntakeSourceConnectionStatus[] = [
    {
      kind: "physical_return",
      label: "Physical return scan",
      connected: true,
      disabled_by_setting: false,
      disabled_reason: null,
      last_sync_at: null,
      last_sync_status: "never",
      last_error: null,
      next_sync_at: null,
      manual_run_available: true,
      manual_run_href: "/scanner/operator-mobile/scan",
      generator_status: "live",
      related_settings: inventoryForIntakeSource("physical_return"),
    },
    {
      kind: "amazon_return",
      label: "Amazon return reports",
      connected: credsOk && flags.reports_worker_enabled,
      disabled_by_setting: !flags.reports_worker_enabled || !credsOk,
      disabled_reason: !credsOk
        ? "SP-API credentials incomplete"
        : !flags.reports_worker_enabled
          ? "Reports API worker disabled on server"
          : null,
      last_sync_at: null,
      last_sync_status: "never",
      last_error: null,
      next_sync_at: null,
      manual_run_available: credsOk,
      manual_run_href: "/settings/imports",
      generator_status: "live",
      related_settings: inventoryForIntakeSource("amazon_return"),
    },
    {
      kind: "removal",
      label: "Removal orders & shipments",
      connected: credsOk && flags.removal_order_enabled && flags.removal_shipment_enabled,
      disabled_by_setting: removalDisabled,
      disabled_reason: removalDisabled ? "Removal API flags off or schedule disabled" : null,
      last_sync_at: removalRecentRt.last_run_at,
      last_sync_status: removalRecentRt.last_run_status,
      last_error: removalRecentRt.last_error,
      next_sync_at: removalRecentRt.next_run_at,
      manual_run_available: credsOk && flags.removal_order_enabled,
      manual_run_href: "/platform/settings/automation",
      generator_status: "live",
      related_settings: inventoryForIntakeSource("removal"),
    },
    {
      kind: "reimbursement",
      label: "Reimbursements",
      connected: credsOk && flags.reimbursements_enabled,
      disabled_by_setting: reimbDisabled,
      disabled_reason: reimbDisabled ? "Reimbursements API disabled or schedule off" : null,
      last_sync_at: reimbRt.last_run_at,
      last_sync_status: reimbRt.last_run_status,
      last_error: reimbRt.last_error,
      next_sync_at: reimbRt.next_run_at,
      manual_run_available: credsOk && flags.reimbursements_enabled,
      manual_run_href: "/platform/settings/automation",
      generator_status: "partial",
      related_settings: inventoryForIntakeSource("reimbursement"),
    },
    {
      kind: "settlement",
      label: "Settlements",
      connected: credsOk && flags.settlement_enabled,
      disabled_by_setting: settDisabled,
      disabled_reason: settDisabled ? "Settlement API disabled or schedule off" : null,
      last_sync_at: settRt.last_run_at,
      last_sync_status: settRt.last_run_status,
      last_error: settRt.last_error,
      next_sync_at: settRt.next_run_at,
      manual_run_available: credsOk && flags.settlement_enabled,
      manual_run_href: "/platform/settings/automation",
      generator_status: "partial",
      related_settings: inventoryForIntakeSource("settlement"),
    },
    {
      kind: "manual",
      label: "Manual entry",
      connected: true,
      disabled_by_setting: false,
      disabled_reason: null,
      last_sync_at: null,
      last_sync_status: "never",
      last_error: null,
      next_sync_at: null,
      manual_run_available: true,
      manual_run_href: "/returns/claims",
      generator_status: "partial",
      related_settings: inventoryForIntakeSource("manual"),
    },
    {
      kind: "inventory",
      label: "Inventory / QC",
      connected: openAiOk,
      disabled_by_setting: !openAiOk,
      disabled_reason: !openAiOk ? "OpenAI not configured (optional for slip parse)" : null,
      last_sync_at: null,
      last_sync_status: "never",
      last_error: null,
      next_sync_at: null,
      manual_run_available: openAiOk,
      manual_run_href: "/scanner/operator-mobile/scan",
      generator_status: "partial",
      related_settings: [],
    },
  ];

  const missing_settings = missingSettingsFromInventory({
    reports_worker: flags.reports_worker_enabled,
    removal_order: flags.removal_order_enabled,
    removal_shipment: flags.removal_shipment_enabled,
    reimbursements: flags.reimbursements_enabled,
    settlement: flags.settlement_enabled,
    finances_ingest: flags.finances_ingest_enabled,
    sp_api_credentials_configured: credsOk,
  });

  return {
    sources,
    missing_settings,
    sp_api_credentials_configured: credsOk,
    api_flags: flags,
    claim_policy_effective: effective,
  };
}
