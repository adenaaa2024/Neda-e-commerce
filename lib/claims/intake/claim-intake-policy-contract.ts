/**
 * Claim intake policy contract — read-model resolution for Claim Center APIs.
 * Merges platform → company → store settings without mutating generators or DB schema.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_CLAIM_CANDIDATE_INTAKE_POLICY,
  normalizeClaimCandidateIntakePolicy,
  type ClaimCandidateIntakePolicy,
} from "@/lib/claim-candidate-intake-policy";
import {
  normalizeClaimPolicy,
  resolveEffectiveClaimPolicy,
  toUtcDateString,
} from "@/lib/claim-eligibility-policy";
import type { ClaimPolicyV1 } from "@/lib/claim-policy-types";
import {
  automationScopeKey,
  parseAutomationPersisted,
} from "@/lib/platform-automation-scope-storage";
import {
  DEFAULT_CLAIM_INTAKE_SETTINGS,
  evaluateSourceGate,
  mergeIntakeConfig,
} from "./claim-intake-settings";
import type { ClaimIntakeSettings, ClaimSourceKind } from "./claim-intake-types";
import { isClaimSourceKind } from "./claim-intake-types";
import type { ClaimCenterCanonicalWindow } from "../center/claim-center-v1-types";
import {
  computeCanonicalWindow,
  observedWindowFromMetadata,
  windowStatusFromDaysRemaining,
} from "../center/claim-center-v1-window";

export type ClaimLifecycleStatus =
  | "detected"
  | "ineligible_pre_cutoff"
  | "not_yet_claimable"
  | "claimable"
  | "closing_soon"
  | "expired"
  | "needs_review"
  | "evidence_needed"
  | "product_blocked"
  | "reference_blocked"
  | "ready_to_file"
  | "filed"
  | "reimbursed"
  | "rejected";

export const CLAIM_LIFECYCLE_STATUS_LABELS: Record<ClaimLifecycleStatus, string> = {
  detected: "Detected",
  ineligible_pre_cutoff: "Ineligible (pre-cutoff)",
  not_yet_claimable: "Not yet claimable",
  claimable: "Claimable",
  closing_soon: "Closing soon",
  expired: "Expired",
  needs_review: "Needs review",
  evidence_needed: "Evidence needed",
  product_blocked: "Product blocked",
  reference_blocked: "Reference blocked",
  ready_to_file: "Ready to file",
  filed: "Filed",
  reimbursed: "Reimbursed",
  rejected: "Rejected",
};

export type ClaimPolicyReadModelWarning =
  | "policy_stale_if_intake_metadata_predates_policy_revision"
  | "source_disabled_by_policy"
  | "not_yet_claimable_until"
  | "expires_soon"
  | "expired"
  | "unknown_expiry";

export type ClaimPolicyWarnings = {
  codes: ClaimPolicyReadModelWarning[];
  not_yet_claimable_until: string | null;
  expires_soon_deadline: string | null;
  policy_revision_at: string | null;
};

export type ClaimIntakeEffectivePolicy = {
  schema_version: 1;
  scan_go_live_date: string | null;
  claim_start_date: string | null;
  claim_eligibility_window_days: number;
  expiration_warning_days: number;
  delayed_not_received_days: number;
  enabled_sources: ClaimSourceKind[];
  purchased_sources: Partial<Record<ClaimSourceKind, boolean>>;
  candidate_intake: ClaimCandidateIntakePolicy;
  sources_read: string[];
  policy_revision_at: string | null;
  resolution_steps: Array<{ tier: string; path: string; active: boolean }>;
};

export const DEFAULT_EXPIRATION_WARNING_DAYS = 14;

export const DEFAULT_CLAIM_INTAKE_EFFECTIVE_POLICY: ClaimIntakeEffectivePolicy = {
  schema_version: 1,
  scan_go_live_date: null,
  claim_start_date: null,
  claim_eligibility_window_days: 90,
  expiration_warning_days: DEFAULT_EXPIRATION_WARNING_DAYS,
  delayed_not_received_days: DEFAULT_CLAIM_INTAKE_SETTINGS.delayed_not_received_days,
  enabled_sources: [...DEFAULT_CLAIM_INTAKE_SETTINGS.enabled_sources],
  purchased_sources: {},
  candidate_intake: { ...DEFAULT_CLAIM_CANDIDATE_INTAKE_POLICY },
  sources_read: ["code_defaults"],
  policy_revision_at: null,
  resolution_steps: [],
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parsePositiveInt(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v ?? NaN));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseWarningDays(raw: Record<string, unknown> | null): number | null {
  if (!raw) return null;
  const keys = [
    "expiration_warning_days",
    "expire_soon_days",
    "closing_soon_days",
    "expiration_warning",
  ];
  for (const k of keys) {
    if (raw[k] != null) {
      const n = parsePositiveInt(raw[k], DEFAULT_EXPIRATION_WARNING_DAYS);
      if (n > 0) return n;
    }
  }
  return null;
}

/** Normalize partial JSON into the effective read-model policy shape. */
export function normalizeClaimIntakeEffectivePolicy(
  raw: Partial<ClaimIntakeEffectivePolicy> | null | undefined,
): ClaimIntakeEffectivePolicy {
  const base = DEFAULT_CLAIM_INTAKE_EFFECTIVE_POLICY;
  if (!raw) return { ...base, enabled_sources: [...base.enabled_sources] };

  const orgPolicy = normalizeClaimPolicy({
    scan_go_live_date: raw.scan_go_live_date,
    claim_start_date: raw.claim_start_date,
    claim_eligibility_window_days: raw.claim_eligibility_window_days,
  });

  return {
    schema_version: 1,
    scan_go_live_date: orgPolicy.scan_go_live_date,
    claim_start_date: orgPolicy.claim_start_date,
    claim_eligibility_window_days: orgPolicy.claim_eligibility_window_days,
    expiration_warning_days: parsePositiveInt(
      raw.expiration_warning_days,
      DEFAULT_EXPIRATION_WARNING_DAYS,
    ),
    delayed_not_received_days: parsePositiveInt(
      raw.delayed_not_received_days,
      base.delayed_not_received_days,
    ),
    enabled_sources: Array.isArray(raw.enabled_sources)
      ? raw.enabled_sources.filter(isClaimSourceKind)
      : [...base.enabled_sources],
    purchased_sources: raw.purchased_sources ?? {},
    candidate_intake: raw.candidate_intake
      ? normalizeClaimCandidateIntakePolicy(raw.candidate_intake)
      : { ...base.candidate_intake },
    sources_read: raw.sources_read ?? [...base.sources_read],
    policy_revision_at: raw.policy_revision_at ?? null,
    resolution_steps: raw.resolution_steps ?? [],
  };
}

function mergeIntakeLayer(
  settings: ClaimIntakeSettings,
  raw: unknown,
  warningDaysOut: { value: number | null },
): ClaimIntakeSettings {
  const o = asRecord(raw);
  if (!o) return settings;
  const wd = parseWarningDays(o);
  if (wd != null) warningDaysOut.value = wd;
  return mergeIntakeConfig(settings, o);
}

function mergeOrgClaimPolicy(
  base: ClaimPolicyV1,
  claimPolicyRaw: unknown,
  warningDaysOut: { value: number | null },
): ClaimPolicyV1 {
  const cp = asRecord(claimPolicyRaw);
  if (!cp) return base;
  const intake = asRecord(cp.intake);
  const candidate = asRecord(cp.candidate_intake);
  const wd = parseWarningDays(intake) ?? parseWarningDays(candidate) ?? parseWarningDays(cp);
  if (wd != null) warningDaysOut.value = wd;
  return normalizeClaimPolicy({ ...base, ...cp });
}

function mergePlatformModuleConfigs(
  settings: ClaimIntakeSettings,
  moduleConfigs: unknown,
  warningDaysOut: { value: number | null },
  candidateOut: { raw: unknown | null },
): ClaimIntakeSettings {
  const mc = asRecord(moduleConfigs);
  if (!mc) return settings;
  let next = settings;
  if (mc.claim_intake) {
    next = mergeIntakeLayer(next, mc.claim_intake, warningDaysOut);
  }
  if (mc.claim_candidate_intake) {
    candidateOut.raw = mc.claim_candidate_intake;
    const wd = parseWarningDays(asRecord(mc.claim_candidate_intake));
    if (wd != null) warningDaysOut.value = wd;
  }
  return next;
}

export type ResolveEffectivePolicyInput = {
  platformModuleConfigs?: unknown | null;
  platformCandidateIntake?: unknown | null;
  orgClaimPolicy?: unknown | null;
  orgUpdatedAt?: string | null;
  storeCandidateIntake?: unknown | null;
  storeId?: string | null;
};

/** Pure merge: platform → company → store (read-model only). */
export function resolveEffectiveClaimIntakePolicyFromParts(
  input: ResolveEffectivePolicyInput,
): ClaimIntakeEffectivePolicy {
  const warningDaysOut = { value: null as number | null };
  const candidateOut = { raw: null as unknown | null };
  const sourcesRead: string[] = [];
  const steps: ClaimIntakeEffectivePolicy["resolution_steps"] = [];

  let intakeSettings = { ...DEFAULT_CLAIM_INTAKE_SETTINGS };
  let orgPolicy = normalizeClaimPolicy(null);
  let candidateIntake = { ...DEFAULT_CLAIM_CANDIDATE_INTAKE_POLICY };

  if (input.platformModuleConfigs != null) {
    intakeSettings = mergePlatformModuleConfigs(
      intakeSettings,
      input.platformModuleConfigs,
      warningDaysOut,
      candidateOut,
    );
    sourcesRead.push("workspace_settings.module_configs");
    steps.push({
      tier: "platform_default",
      path: "workspace_settings.module_configs.claim_intake",
      active: true,
    });
  }

  if (candidateOut.raw != null) {
    candidateIntake = normalizeClaimCandidateIntakePolicy(candidateOut.raw);
    sourcesRead.push("workspace_settings.module_configs.claim_candidate_intake");
  }

  if (input.orgClaimPolicy != null) {
    const cp = asRecord(input.orgClaimPolicy);
    orgPolicy = mergeOrgClaimPolicy(orgPolicy, input.orgClaimPolicy, warningDaysOut);
    if (cp?.intake) {
      intakeSettings = mergeIntakeLayer(intakeSettings, cp.intake, warningDaysOut);
      sourcesRead.push("organization_settings.claim_policy.intake");
      steps.push({
        tier: "company_override",
        path: "organization_settings.claim_policy.intake",
        active: true,
      });
    }
    if (cp?.candidate_intake) {
      candidateIntake = normalizeClaimCandidateIntakePolicy({
        ...candidateIntake,
        ...cp.candidate_intake,
      });
      sourcesRead.push("organization_settings.claim_policy.candidate_intake");
      steps.push({
        tier: "company_override",
        path: "organization_settings.claim_policy.candidate_intake",
        active: true,
      });
    }
    sourcesRead.push("organization_settings.claim_policy");
    steps.push({
      tier: "company_override",
      path: "organization_settings.claim_policy",
      active: true,
    });
  }

  if (input.storeCandidateIntake != null && input.storeId) {
    candidateIntake = normalizeClaimCandidateIntakePolicy({
      ...candidateIntake,
      ...input.storeCandidateIntake,
    });
    sourcesRead.push(
      `platform_settings.automation_settings.scopes[${input.storeId}].claim_candidate_intake`,
    );
    steps.push({
      tier: "store_automation_override",
      path: "platform_settings.automation_settings.scopes[org:store].claim_candidate_intake",
      active: true,
    });
  }

  const effectiveOrg = resolveEffectiveClaimPolicy(orgPolicy);

  return normalizeClaimIntakeEffectivePolicy({
    scan_go_live_date: effectiveOrg.scan_go_live_date,
    claim_start_date: effectiveOrg.claim_start_date,
    claim_eligibility_window_days: effectiveOrg.claim_eligibility_window_days,
    expiration_warning_days: warningDaysOut.value ?? DEFAULT_EXPIRATION_WARNING_DAYS,
    delayed_not_received_days: intakeSettings.delayed_not_received_days,
    enabled_sources: intakeSettings.enabled_sources,
    purchased_sources: intakeSettings.purchased_sources,
    candidate_intake: candidateIntake,
    sources_read: sourcesRead.length ? sourcesRead : ["code_defaults"],
    policy_revision_at: input.orgUpdatedAt ?? null,
    resolution_steps: steps,
  });
}

/** Load effective policy from existing settings tables (read-only). */
export async function loadEffectiveClaimIntakePolicy(
  client: SupabaseClient,
  organizationId: string,
  storeId?: string | null,
): Promise<ClaimIntakeEffectivePolicy> {
  const [wsRes, orgRes, psRes] = await Promise.all([
    client.from("workspace_settings").select("module_configs").limit(1).maybeSingle(),
    client
      .from("organization_settings")
      .select("claim_policy, updated_at")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    client.from("platform_settings").select("automation_settings").eq("id", true).maybeSingle(),
  ]);

  let storeCandidateIntake: unknown | null = null;
  if (storeId) {
    const doc = parseAutomationPersisted(
      (psRes.data as { automation_settings?: unknown } | null)?.automation_settings,
    );
    const scope = doc.scopes[automationScopeKey(organizationId, storeId)];
    storeCandidateIntake = scope?.claim_candidate_intake ?? null;
  }

  return resolveEffectiveClaimIntakePolicyFromParts({
    platformModuleConfigs: (wsRes.data as { module_configs?: unknown } | null)?.module_configs,
    orgClaimPolicy: (orgRes.data as { claim_policy?: unknown } | null)?.claim_policy,
    orgUpdatedAt: (orgRes.data as { updated_at?: string } | null)?.updated_at ?? null,
    storeCandidateIntake,
    storeId: storeId ?? null,
  });
}

const EXTERNAL_FILED = new Set(["submitted", "pending", "investigating", "pending_amazon"]);
const EXTERNAL_REIMBURSED = new Set(["reimbursed", "approved", "paid"]);
const EXTERNAL_REJECTED = new Set(["denied", "rejected", "closed_denied"]);

const IMPORT_SOURCE_KINDS = new Set<ClaimSourceKind>([
  "orbit_fra",
  "reimbursement",
  "settlement",
  "transaction",
  "inventory_ledger",
  "safet",
  "delayed_not_received",
  "shipment_discrepancy",
  "inbound_shipment",
  "manual_import",
  "amazon_removal_api",
]);

function daysUntil(iso: string, now: Date): number | null {
  const ms = new Date(`${iso}T23:59:59Z`).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86_400_000);
}

function cutoffDateForSource(
  policy: ClaimIntakeEffectivePolicy,
  sourceKind: string | null,
): string | null {
  if (sourceKind && IMPORT_SOURCE_KINDS.has(sourceKind as ClaimSourceKind)) {
    return policy.claim_start_date;
  }
  return policy.scan_go_live_date;
}

export type ClaimLifecycleDerivationInput = {
  source_kind: string | null;
  event_date: string | null;
  dispute_deadline: string | null;
  days_remaining_snapshot: number | null;
  source_observed_window: ClaimCenterCanonicalWindow | null;
  scanner_expiration_date: string | null;
  metadata?: Record<string, unknown>;
  policy: ClaimIntakeEffectivePolicy;
  current_date?: Date;
  evidence_status: string | null;
  product_linked: boolean;
  reference_edge_count: number;
  ambiguity_pending: boolean;
  orbit_external_case_status: string | null;
  candidate_status: string | null;
  rejected_at: string | null;
  inbox_queue: string | null;
  final_bucket: string | null;
  automation_allowed: boolean;
  intake_run_id: string | null;
  candidate_updated_at: string | null;
};

function resolveWindow(input: ClaimLifecycleDerivationInput): ClaimCenterCanonicalWindow {
  const observed =
    input.source_observed_window ??
    (input.metadata ? observedWindowFromMetadata(input.metadata) : null);
  if (observed) return observed;

  return computeCanonicalWindow({
    eventDate: input.event_date,
    disputeDeadline: input.dispute_deadline,
    daysRemainingSnapshot: input.days_remaining_snapshot,
    claimEligibilityWindowDays: input.policy.claim_eligibility_window_days,
    expirationWarningDays: input.policy.expiration_warning_days,
  });
}

function scannerWindowStatus(
  scannerDate: string | null,
  warningDays: number,
  now: Date,
): ClaimCenterWindowStatus | null {
  if (!scannerDate) return null;
  const remaining = daysUntil(scannerDate, now);
  if (remaining == null) return "unknown";
  return windowStatusFromDaysRemaining(remaining, warningDays);
}

type ClaimCenterWindowStatus = ClaimCenterCanonicalWindow["status"];

/** Pure lifecycle derivation — no DB writes. */
export function deriveClaimLifecycleStatus(
  input: ClaimLifecycleDerivationInput,
): ClaimLifecycleStatus {
  const now = input.current_date ?? new Date();
  const ext = (input.orbit_external_case_status ?? "").toLowerCase();

  if (input.rejected_at || input.candidate_status === "rejected") return "rejected";
  if (EXTERNAL_REJECTED.has(ext)) return "rejected";
  if (EXTERNAL_REIMBURSED.has(ext)) return "reimbursed";
  if (EXTERNAL_FILED.has(ext)) return "filed";

  if (input.ambiguity_pending || input.final_bucket === "ambiguous") return "reference_blocked";
  if (!input.product_linked) return "product_blocked";

  const eventDate = toUtcDateString(input.event_date);
  const today = toUtcDateString(now);
  const cutoff = cutoffDateForSource(input.policy, input.source_kind);

  if (cutoff && eventDate && eventDate < cutoff) return "ineligible_pre_cutoff";
  if (!cutoff && eventDate) return "not_yet_claimable";

  const scannerDate = toUtcDateString(input.scanner_expiration_date);
  const scannerStatus = scannerWindowStatus(
    scannerDate,
    input.policy.expiration_warning_days,
    now,
  );

  if (scannerStatus === "expired") return "expired";

  const window = resolveWindow(input);
  if (window.status === "expired") return "expired";

  if (
    input.evidence_status === "missing" ||
    input.inbox_queue === "evidence_missing" ||
    input.inbox_queue === "legacy_source_broken"
  ) {
    return "evidence_needed";
  }

  if (
    input.final_bucket === "safe_update_candidate" &&
    input.evidence_status === "complete" &&
    input.automation_allowed
  ) {
    return "ready_to_file";
  }

  if (scannerStatus === "closing_soon" || window.status === "closing_soon") return "closing_soon";

  if (input.inbox_queue === "ineligible_pre_cutoff") return "ineligible_pre_cutoff";
  if (input.inbox_queue === "ready_for_review" && input.evidence_status !== "missing") {
    return "needs_review";
  }

  if (window.status === "unknown" && !scannerDate) return "needs_review";
  if (window.status === "open" || scannerStatus === "open") return "claimable";
  if (input.candidate_status === "detected") return "detected";

  return "needs_review";
}

export function mapLifecycleToV1StatusGroup(
  lifecycle: ClaimLifecycleStatus,
): import("../center/claim-center-v1-types").ClaimCenterV1StatusGroup {
  switch (lifecycle) {
    case "detected":
      return "new";
    case "ineligible_pre_cutoff":
    case "not_yet_claimable":
    case "claimable":
    case "closing_soon":
    case "needs_review":
    case "evidence_needed":
      return "needs_review";
    case "product_blocked":
      return "blocked_product_link";
    case "reference_blocked":
      return "blocked_reference_conflict";
    case "ready_to_file":
      return "ready_to_file";
    case "filed":
      return "filed";
    case "reimbursed":
      return "reimbursed";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    default:
      return "needs_review";
  }
}

export function buildPolicyWarnings(args: {
  lifecycle: ClaimLifecycleStatus;
  policy: ClaimIntakeEffectivePolicy;
  source_kind: string | null;
  event_date: string | null;
  canonical_window: ClaimCenterCanonicalWindow;
  scanner_expiration_date: string | null;
  intake_run_id: string | null;
  candidate_updated_at: string | null;
  intakeSettings?: Pick<ClaimIntakeSettings, "enabled_sources" | "purchased_sources">;
}): ClaimPolicyWarnings {
  const codes: ClaimPolicyReadModelWarning[] = [];
  const cutoff = cutoffDateForSource(args.policy, args.source_kind);
  const eventDate = toUtcDateString(args.event_date);

  if (args.source_kind && isClaimSourceKind(args.source_kind)) {
    const gate = evaluateSourceGate(
      {
        enabled_sources: args.policy.enabled_sources,
        purchased_sources: args.policy.purchased_sources,
      } as ClaimIntakeSettings,
      args.source_kind,
    );
    if (!gate.enabled || !gate.purchased) codes.push("source_disabled_by_policy");
  }

  if (
    args.policy.policy_revision_at &&
    args.candidate_updated_at &&
    args.candidate_updated_at < args.policy.policy_revision_at &&
    args.intake_run_id
  ) {
    codes.push("policy_stale_if_intake_metadata_predates_policy_revision");
  }

  if (args.lifecycle === "not_yet_claimable" || args.lifecycle === "ineligible_pre_cutoff") {
    if (cutoff) codes.push("not_yet_claimable_until");
  }

  if (args.lifecycle === "closing_soon") codes.push("expires_soon");
  if (args.lifecycle === "expired") codes.push("expired");

  if (
    args.canonical_window.status === "unknown" &&
    !args.scanner_expiration_date &&
    args.lifecycle !== "filed" &&
    args.lifecycle !== "reimbursed"
  ) {
    codes.push("unknown_expiry");
  }

  return {
    codes: [...new Set(codes)],
    not_yet_claimable_until: cutoff && eventDate && eventDate < cutoff ? cutoff : cutoff,
    expires_soon_deadline: args.canonical_window.deadline ?? args.scanner_expiration_date,
    policy_revision_at: args.policy.policy_revision_at,
  };
}

export type ClaimCenterPolicyContext = {
  effective_policy: Pick<
    ClaimIntakeEffectivePolicy,
    | "scan_go_live_date"
    | "claim_start_date"
    | "claim_eligibility_window_days"
    | "expiration_warning_days"
    | "delayed_not_received_days"
    | "enabled_sources"
    | "sources_read"
    | "policy_revision_at"
  >;
};

export function buildClaimCenterPolicyContext(
  policy: ClaimIntakeEffectivePolicy,
): ClaimCenterPolicyContext {
  return {
    effective_policy: {
      scan_go_live_date: policy.scan_go_live_date,
      claim_start_date: policy.claim_start_date,
      claim_eligibility_window_days: policy.claim_eligibility_window_days,
      expiration_warning_days: policy.expiration_warning_days,
      delayed_not_received_days: policy.delayed_not_received_days,
      enabled_sources: policy.enabled_sources,
      sources_read: policy.sources_read,
      policy_revision_at: policy.policy_revision_at,
    },
  };
}
