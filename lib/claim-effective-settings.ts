import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadGlobalClaimAgentConfig } from "./claim-filing-handoff";
import { loadClaimPolicy, normalizeClaimPolicy } from "./claim-eligibility-policy";
import {
  DEFAULT_CLAIM_WORKFLOW,
  type ClaimGroupBySetting,
  type ClaimWorkflowSettings,
  type CreateCaseWhenSetting,
  type EffectiveClaimSettingsSnapshot,
} from "./claim-effective-settings-shared";
import type { ClaimGroupingPolicy, ClaimHoldPolicyFlag, ClaimPolicyV1 } from "./claim-policy-types";

export type {
  ClaimGroupBySetting,
  ClaimWorkflowSettings,
  CreateCaseWhenSetting,
  EffectiveClaimSettingsSnapshot,
} from "./claim-effective-settings-shared";

export type EffectiveClaimSettings = EffectiveClaimSettingsSnapshot & {
  policy: ClaimPolicyV1;
};

const GROUP_BY_VALUES = new Set<ClaimGroupBySetting>([
  "manual",
  "pallet",
  "package",
  "order_id",
  "removal_order",
  "product",
  "issue_type",
  "date_window",
]);

const CREATE_CASE_VALUES = new Set<CreateCaseWhenSetting>([
  "immediately",
  "package_closed",
  "pallet_closed",
  "removal_order_closed",
  "manual_only",
]);

function trimOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function parseBool(v: unknown, fallback: boolean): boolean {
  if (v === true) return true;
  if (v === false) return false;
  return fallback;
}

function mapLegacyGroupingToGroupBy(grouping: ClaimGroupingPolicy): ClaimGroupBySetting {
  switch (grouping) {
    case "group_by_pallet":
      return "pallet";
    case "group_by_package":
      return "package";
    case "group_by_order":
      return "order_id";
    case "single_item":
    default:
      return "manual";
  }
}

function inferCreateCaseWhenFromHolds(holds: ClaimHoldPolicyFlag[]): CreateCaseWhenSetting {
  if (holds.includes("manual_review_required")) return "manual_only";
  if (holds.includes("hold_until_pallet_closed")) return "pallet_closed";
  if (holds.includes("hold_until_package_closed")) return "package_closed";
  return "immediately";
}

/** Parse workflow keys from organization_settings.claim_policy JSON (no migration). */
export function normalizeClaimWorkflowFromPolicyJson(
  raw: unknown,
  policy: ClaimPolicyV1,
): ClaimWorkflowSettings {
  const base = { ...DEFAULT_CLAIM_WORKFLOW };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ...base,
      group_by: mapLegacyGroupingToGroupBy(policy.claim_grouping_policy),
      create_case_when: inferCreateCaseWhenFromHolds(policy.claim_hold_policy),
    };
  }
  const o = raw as Record<string, unknown>;

  const groupByRaw = trimOrNull(o.group_by) as ClaimGroupBySetting | null;
  const groupBy =
    groupByRaw && GROUP_BY_VALUES.has(groupByRaw)
      ? groupByRaw
      : mapLegacyGroupingToGroupBy(policy.claim_grouping_policy);

  const createRaw = trimOrNull(o.create_case_when) as CreateCaseWhenSetting | null;
  const create_case_when =
    createRaw && CREATE_CASE_VALUES.has(createRaw)
      ? createRaw
      : inferCreateCaseWhenFromHolds(policy.claim_hold_policy);

  return {
    auto_grouping_enabled: parseBool(o.auto_grouping_enabled, base.auto_grouping_enabled),
    group_by: groupBy,
    create_case_when,
    allow_mixed_products: parseBool(
      o.allow_mixed_products,
      policy.allow_manual_override === true ? true : base.allow_mixed_products,
    ),
    allow_mixed_issue_types: parseBool(o.allow_mixed_issue_types, base.allow_mixed_issue_types),
    require_product_link: parseBool(o.require_product_link, base.require_product_link),
    require_operator_note: parseBool(o.require_operator_note, base.require_operator_note),
    require_evidence: parseBool(o.require_evidence, base.require_evidence),
  };
}

export function mergeEffectiveClaimSettings(args: {
  organizationId: string;
  storeId?: string | null;
  policy: ClaimPolicyV1;
  claimPolicyRaw?: unknown;
  agentConfig?: {
    scanner_auto_promote_on_save?: boolean;
    auto_generate_pdf_reports?: boolean;
  } | null;
}): EffectiveClaimSettings {
  const orgId = args.organizationId.trim();
  const raw = args.claimPolicyRaw ?? args.policy;
  const policy = args.policy;
  const workflow = normalizeClaimWorkflowFromPolicyJson(raw, policy);

  const agentAuto = args.agentConfig?.scanner_auto_promote_on_save;
  const orgAutoOverride =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).auto_create_drafts_on_scan
      : undefined;
  const auto_create_drafts_on_scan =
    orgAutoOverride === true || orgAutoOverride === false
      ? orgAutoOverride === true
      : agentAuto !== false;

  const pdfAgent = args.agentConfig?.auto_generate_pdf_reports;

  return {
    organization_id: orgId,
    store_id: args.storeId?.trim() ? args.storeId.trim() : null,
    policy,
    workflow,
    auto_create_drafts_on_scan,
    auto_generate_pdf_reports: pdfAgent !== false,
    claim_from_date: policy.scan_go_live_date,
    claim_cutoff_date: policy.claim_start_date,
    claim_window_days: policy.claim_eligibility_window_days,
    allow_manual_override: policy.allow_manual_override === true,
  };
}

export function toEffectiveClaimSettingsSnapshot(
  settings: EffectiveClaimSettings,
): EffectiveClaimSettingsSnapshot {
  return {
    organization_id: settings.organization_id,
    store_id: settings.store_id,
    auto_create_drafts_on_scan: settings.auto_create_drafts_on_scan,
    auto_generate_pdf_reports: settings.auto_generate_pdf_reports,
    claim_from_date: settings.claim_from_date,
    claim_cutoff_date: settings.claim_cutoff_date,
    claim_window_days: settings.claim_window_days,
    workflow: settings.workflow,
    allow_manual_override: settings.allow_manual_override,
  };
}

/**
 * Single server-side resolver: org claim_policy JSON + workspace claim_agent_config.
 * Phase 1: store-level overrides are reserved (storeId recorded for future use).
 */
export async function getEffectiveClaimSettings(
  client: SupabaseClient,
  organizationId: string,
  storeId?: string | null,
): Promise<EffectiveClaimSettings> {
  const orgId = organizationId.trim();
  const policy = await loadClaimPolicy(client, orgId);

  let claimPolicyRaw: unknown = null;
  const { data } = await client
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", orgId)
    .maybeSingle();
  claimPolicyRaw = (data as { claim_policy?: unknown } | null)?.claim_policy ?? null;
  if (!claimPolicyRaw) claimPolicyRaw = policy;

  const agent = await loadGlobalClaimAgentConfig(client);
  return mergeEffectiveClaimSettings({
    organizationId: orgId,
    storeId,
    policy: normalizeClaimPolicy(claimPolicyRaw),
    claimPolicyRaw,
    agentConfig: agent,
  });
}

export type AutoCaseCreationContext = {
  packageClosed?: boolean | null;
  palletClosed?: boolean | null;
  removalOrderClosed?: boolean | null;
};

/** Whether scanner auto-promote may insert claim_cases (draft lines may still be created). */
export function isAutoClaimCaseCreationAllowed(
  settings: EffectiveClaimSettings,
  ctx: AutoCaseCreationContext,
): { allowed: boolean; reason?: string } {
  const when = settings.workflow.create_case_when;
  if (when === "manual_only") {
    return { allowed: false, reason: "create_case_manual_only" };
  }
  if (when === "package_closed" && ctx.packageClosed !== true) {
    return { allowed: false, reason: "create_case_awaiting_package_closed" };
  }
  if (when === "pallet_closed" && ctx.palletClosed !== true) {
    return { allowed: false, reason: "create_case_awaiting_pallet_closed" };
  }
  if (when === "removal_order_closed" && ctx.removalOrderClosed !== true) {
    return { allowed: false, reason: "create_case_awaiting_removal_order_closed" };
  }
  return { allowed: true };
}
