/**
 * Phase 7E — UI resolution for claim candidate intake policy across tiers.
 * Read/merge only; generators continue using org-level loaders until 7F.
 */

import {
  DEFAULT_CLAIM_CANDIDATE_INTAKE_POLICY,
  normalizeClaimCandidateIntakePolicy,
  type ClaimCandidateIntakePolicy,
  type ClaimCandidateTrigger,
  type ClaimablePhysicalEvent,
  CLAIM_CANDIDATE_TRIGGERS,
  CLAIMABLE_PHYSICAL_EVENTS,
} from "@/lib/claim-candidate-intake-policy";
import type { ClaimIntakeSettings } from "@/lib/claims/intake/claim-intake-types";
import { DEFAULT_CLAIM_INTAKE_SETTINGS } from "@/lib/claims/intake/claim-intake-settings";
import type { ClaimPoolGenerationSchedule } from "@/lib/platform-automation-settings-types";

export type ClaimPolicyResolutionStep = {
  tier: "platform_default" | "company_override" | "store_automation_override" | "manual_run_override";
  label: string;
  storage_path: string;
  active: boolean;
  summary: string;
};

export const CLAIM_CANDIDATE_TRIGGER_LABELS: Record<ClaimCandidateTrigger, string> = {
  per_problem_scan: "Per problem scan (earliest — at scan time)",
  box_close: "Box close (child scope)",
  shipment_review_close: "Shipment receive review close (primary scope)",
  order_resolved: "Order resolved",
  scheduled_generator_only: "Scheduled generator only",
  manual_only: "Manual generator runs only",
};

export const CLAIMABLE_PHYSICAL_EVENT_LABELS: Record<ClaimablePhysicalEvent, string> = {
  missing: "Missing",
  damaged: "Damaged",
  wrong_item: "Wrong item",
  expired: "Expired",
  empty_box: "Empty box",
  over_received: "Over received",
  unexpected_item: "Unexpected / off manifest",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function mergeCandidateLayer(
  base: ClaimCandidateIntakePolicy,
  raw: unknown | null | undefined,
): ClaimCandidateIntakePolicy {
  if (raw == null) return base;
  const o = asRecord(raw);
  if (!o) return base;
  return normalizeClaimCandidateIntakePolicy({
    ...base,
    ...o,
    manual_grouping: {
      ...base.manual_grouping,
      ...(asRecord(o.manual_grouping) ?? {}),
    },
  });
}

/** Merge platform → company → store candidate intake policy for UI effective preview. */
export function resolveClaimCandidateIntakePolicy(input: {
  platformRaw: unknown | null | undefined;
  companyRaw: unknown | null | undefined;
  storeRaw: unknown | null | undefined;
}): ClaimCandidateIntakePolicy {
  let policy = { ...DEFAULT_CLAIM_CANDIDATE_INTAKE_POLICY };
  policy = mergeCandidateLayer(policy, input.platformRaw);
  policy = mergeCandidateLayer(policy, input.companyRaw);
  if (input.storeRaw != null) {
    policy = mergeCandidateLayer(policy, input.storeRaw);
  }
  return policy;
}

function intakeConfigured(raw: unknown | null | undefined): boolean {
  return raw != null && asRecord(raw) != null;
}

export function buildClaimCandidateIntakeResolutionSteps(args: {
  platformCandidateRaw: unknown | null | undefined;
  platformIntakeRaw: unknown | null | undefined;
  companyCandidateRaw: unknown | null | undefined;
  companyIntakeRaw: unknown | null | undefined;
  storeCandidateRaw: unknown | null | undefined;
  storeClaimPool: ClaimPoolGenerationSchedule | null;
}): ClaimPolicyResolutionStep[] {
  const storePoolConfigured = Boolean(args.storeClaimPool);
  return [
    {
      tier: "platform_default",
      label: "Platform defaults",
      storage_path: "workspace_settings.module_configs.claim_candidate_intake / claim_intake",
      active: intakeConfigured(args.platformCandidateRaw) || intakeConfigured(args.platformIntakeRaw),
      summary: intakeConfigured(args.platformCandidateRaw)
        ? "Candidate trigger & physical events configured"
        : "Using code defaults for candidate intake",
    },
    {
      tier: "company_override",
      label: "Company override",
      storage_path: "organization_settings.claim_policy.candidate_intake / intake",
      active: intakeConfigured(args.companyCandidateRaw) || intakeConfigured(args.companyIntakeRaw),
      summary: intakeConfigured(args.companyCandidateRaw)
        ? "Company candidate intake overrides platform"
        : "Inherits platform candidate intake",
    },
    {
      tier: "store_automation_override",
      label: "Store automation override",
      storage_path: "platform_settings.automation_settings.scopes[org:store].claim_candidate_intake",
      active: args.storeCandidateRaw != null && asRecord(args.storeCandidateRaw) != null,
      summary:
        args.storeCandidateRaw != null && asRecord(args.storeCandidateRaw) != null
          ? "Store candidate intake overrides company"
          : "Inherits company candidate intake",
    },
    {
      tier: "manual_run_override",
      label: "Manual run window",
      storage_path: "platform_settings.automation_settings.scopes[org:store].claim_pool_generation",
      active: storePoolConfigured,
      summary: storePoolConfigured
        ? `Sources: ${args.storeClaimPool!.enabled_source_kinds.length} enabled · rolling ${args.storeClaimPool!.rolling_days}d · mode ${args.storeClaimPool!.scheduled_mode}`
        : "Configure on Claim Pool Generation card",
    },
  ];
}

export function candidateIntakePolicyEqual(
  a: ClaimCandidateIntakePolicy,
  b: ClaimCandidateIntakePolicy,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function claimIntakeSettingsSummary(settings: ClaimIntakeSettings): string {
  return `${settings.enabled_sources.length} sources · ${settings.rolling_window_days}d rolling · manual ${settings.manual_run_enabled ? "on" : "off"}`;
}
