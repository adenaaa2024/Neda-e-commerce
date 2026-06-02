import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isClaimModuleDomainEnabled,
  parseEnabledClaimDomains,
  resolveClaimModuleDomain,
} from "./claim-module-scope";
import type { ClaimWorkflowSettings } from "./claim-effective-settings-shared";
import {
  DEFAULT_CLAIM_POLICY_V1,
  type ClaimEligibilityClaimSource,
  type ClaimEligibilityReason,
  type ClaimEligibilityResult,
  type ClaimGroupingPolicy,
  type ClaimHoldPolicyFlag,
  type ClaimModuleDomain,
  type ClaimPolicyV1,
} from "./claim-policy-types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const GROUPING_VALUES = new Set<ClaimGroupingPolicy>([
  "single_item",
  "group_by_package",
  "group_by_order",
  "group_by_pallet",
]);

const HOLD_VALUES = new Set<ClaimHoldPolicyFlag>([
  "hold_until_package_closed",
  "hold_until_pallet_closed",
  "hold_until_order_complete",
  "manual_review_required",
]);

function trimOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

/** Normalize YYYY-MM-DD from ISO timestamp or date string. */
export function toUtcDateString(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return null;
  if (DATE_RE.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parsePolicyDate(v: unknown): string | null {
  const s = trimOrNull(v);
  if (!s) return null;
  if (DATE_RE.test(s)) return s;
  return toUtcDateString(s);
}

function clampWindowDays(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_CLAIM_POLICY_V1.claim_eligibility_window_days;
  return Math.min(730, Math.max(1, Math.trunc(v)));
}

function parseHoldPolicy(raw: unknown): ClaimHoldPolicyFlag[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CLAIM_POLICY_V1.claim_hold_policy];
  const out: ClaimHoldPolicyFlag[] = [];
  for (const item of raw) {
    const s = trimOrNull(item);
    if (s && HOLD_VALUES.has(s as ClaimHoldPolicyFlag) && !out.includes(s as ClaimHoldPolicyFlag)) {
      out.push(s as ClaimHoldPolicyFlag);
    }
  }
  return out.length ? out : [...DEFAULT_CLAIM_POLICY_V1.claim_hold_policy];
}

/** Merge persisted JSON with safe defaults (empty {} blocks auto-claims via null dates). */
export function normalizeClaimPolicy(raw: unknown): ClaimPolicyV1 {
  const base = DEFAULT_CLAIM_POLICY_V1;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...base };
  }
  const o = raw as Record<string, unknown>;
  const groupingRaw = trimOrNull(o.claim_grouping_policy);
  const grouping =
    groupingRaw && GROUPING_VALUES.has(groupingRaw as ClaimGroupingPolicy)
      ? (groupingRaw as ClaimGroupingPolicy)
      : base.claim_grouping_policy;

  return {
    schema_version: 1,
    scan_go_live_date: parsePolicyDate(o.scan_go_live_date),
    claim_start_date: parsePolicyDate(o.claim_start_date),
    claim_eligibility_window_days: clampWindowDays(o.claim_eligibility_window_days),
    claim_grouping_policy: grouping,
    claim_hold_policy: parseHoldPolicy(o.claim_hold_policy),
    enabled_claim_domains: parseEnabledClaimDomains(o.enabled_claim_domains),
    allow_manual_override: o.allow_manual_override === true,
  };
}

export function resolveEffectiveClaimPolicy(
  orgPolicy: ClaimPolicyV1,
  _storeOverride?: Partial<ClaimPolicyV1> | null,
): ClaimPolicyV1 {
  // Phase 1: org policy only.
  return orgPolicy;
}

function daysBetweenUtcDates(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00.000Z`);
  const b = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.floor((b - a) / 86400000);
}

function cutoffForSource(
  policy: ClaimPolicyV1,
  claimSource: ClaimEligibilityClaimSource,
): string | null {
  if (claimSource === "import_candidate" || claimSource === "expected_mismatch") {
    return policy.claim_start_date;
  }
  return policy.scan_go_live_date;
}

function denyReasonForMissingCutoff(claimSource: ClaimEligibilityClaimSource): ClaimEligibilityReason {
  return claimSource === "import_candidate" || claimSource === "expected_mismatch"
    ? "import_pre_cutoff"
    : "scan_not_live";
}

function denyReasonForBeforeCutoff(claimSource: ClaimEligibilityClaimSource): ClaimEligibilityReason {
  return claimSource === "import_candidate" || claimSource === "expected_mismatch"
    ? "import_pre_cutoff"
    : "scan_not_live";
}

export type EvaluateClaimEligibilityInput = {
  policy: ClaimPolicyV1;
  claimSource: ClaimEligibilityClaimSource;
  eventAt: string | Date | null | undefined;
  hasScannerEvidence: boolean;
  evaluationDate?: string | Date;
  packageClosed?: boolean | null;
  palletClosed?: boolean | null;
  /** Import/API source table for import_candidate domain routing. */
  sourceTable?: string | null;
  /** When set, overrides resolveClaimModuleDomain(claimSource, sourceTable). */
  moduleDomain?: ClaimModuleDomain;
  /** Optional workflow gates from getEffectiveClaimSettings (require_evidence). */
  workflow?: Pick<ClaimWorkflowSettings, "require_evidence"> | null;
};

/** Pure eligibility evaluation — no DB I/O. */
export function evaluateClaimEligibilitySync(input: EvaluateClaimEligibilityInput): ClaimEligibilityResult {
  const policy = resolveEffectiveClaimPolicy(input.policy);
  const eventDate = toUtcDateString(input.eventAt);
  const today = toUtcDateString(input.evaluationDate ?? new Date());
  const cutoff = cutoffForSource(policy, input.claimSource);

  const base = {
    effective_policy: policy,
    event_at: eventDate,
    cutoff_date: cutoff,
  };

  if (policy.claim_hold_policy.includes("manual_review_required")) {
    return { allowed: false, reason: "manual_review_required", ...base };
  }

  const moduleDomain =
    input.moduleDomain ?? resolveClaimModuleDomain(input.claimSource, input.sourceTable);
  if (!isClaimModuleDomainEnabled(policy, moduleDomain)) {
    return { allowed: false, reason: "module_scope_disabled", ...base };
  }

  if (!cutoff) {
    return { allowed: false, reason: denyReasonForMissingCutoff(input.claimSource), ...base };
  }

  if (!eventDate || eventDate < cutoff) {
    return { allowed: false, reason: denyReasonForBeforeCutoff(input.claimSource), ...base };
  }

  if (today && daysBetweenUtcDates(eventDate, today) > policy.claim_eligibility_window_days) {
    return { allowed: false, reason: "outside_window", ...base };
  }

  const evidenceRequired =
    input.workflow?.require_evidence !== false &&
    input.claimSource !== "import_candidate";
  if (evidenceRequired && !input.hasScannerEvidence) {
    return { allowed: false, reason: "missing_scanner_evidence", ...base };
  }

  if (
    policy.claim_hold_policy.includes("hold_until_package_closed") &&
    input.packageClosed === false
  ) {
    return { allowed: false, reason: "hold_package_open", ...base };
  }

  if (policy.claim_hold_policy.includes("hold_until_pallet_closed") && input.palletClosed === false) {
    return { allowed: false, reason: "hold_pallet_open", ...base };
  }

  return { allowed: true, reason: "allowed", ...base };
}

export async function loadClaimPolicy(
  client: SupabaseClient,
  organizationId: string,
): Promise<ClaimPolicyV1> {
  const orgId = organizationId.trim();
  if (!orgId) return normalizeClaimPolicy(null);

  const { data, error } = await client
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("claim_policy") || msg.includes("column") || msg.includes("schema cache")) {
      return normalizeClaimPolicy(null);
    }
    return normalizeClaimPolicy(null);
  }

  const raw = (data as { claim_policy?: unknown } | null)?.claim_policy;
  return normalizeClaimPolicy(raw);
}

async function loadPackageClosed(
  client: SupabaseClient,
  packageId: string | null | undefined,
): Promise<boolean | null> {
  const id = trimOrNull(packageId);
  if (!id) return null;
  const { data, error } = await client.from("packages").select("status").eq("id", id).maybeSingle();
  if (error || !data) return null;
  const status = trimOrNull((data as { status?: string }).status)?.toLowerCase();
  if (!status) return null;
  return status === "closed" || status === "submitted";
}

export async function evaluateClaimEligibility(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId?: string | null;
  claimSource: ClaimEligibilityClaimSource;
  eventAt: string | Date | null;
  hasScannerEvidence: boolean;
  packageId?: string | null;
  palletId?: string | null;
  evaluationDate?: string | Date;
  sourceTable?: string | null;
  moduleDomain?: ClaimModuleDomain;
}): Promise<ClaimEligibilityResult> {
  const policy = await loadClaimPolicy(args.client, args.organizationId);
  const packageClosed = await loadPackageClosed(args.client, args.packageId);
  return evaluateClaimEligibilitySync({
    policy,
    claimSource: args.claimSource,
    eventAt: args.eventAt,
    hasScannerEvidence: args.hasScannerEvidence,
    evaluationDate: args.evaluationDate,
    packageClosed,
    palletClosed: null,
    sourceTable: args.sourceTable,
    moduleDomain: args.moduleDomain,
  });
}

const IMPORT_SOURCE_TABLES = new Set([
  "amazon_removals",
  "amazon_removal_shipments",
  "amazon_returns",
]);

export function isImportClaimSourceTable(sourceTable: string | null | undefined): boolean {
  const st = trimOrNull(sourceTable)?.toLowerCase();
  return st ? IMPORT_SOURCE_TABLES.has(st) : false;
}

/** Resolve primary event date for cutoff checks from operational source row. */
export function resolveClaimSourceEventDate(
  sourceTable: string | null | undefined,
  sourceRow: Record<string, unknown> | null | undefined,
  artifactRow?: Record<string, unknown> | null,
): string | null {
  const row = sourceRow ?? {};
  const st = trimOrNull(sourceTable)?.toLowerCase() ?? "";

  if (st === "amazon_removals" || st === "amazon_removal_shipments") {
    return (
      toUtcDateString(row.shipment_date) ??
      toUtcDateString(row.report_date) ??
      toUtcDateString(row.created_at)
    );
  }
  if (st === "amazon_returns") {
    return toUtcDateString(row.return_date) ?? toUtcDateString(row.created_at);
  }
  if (st === "return_items" || st === "returns") {
    return toUtcDateString(row.created_at);
  }

  return toUtcDateString(artifactRow?.created_at);
}

export function evaluateImportCandidateCutoffSync(
  policy: ClaimPolicyV1,
  sourceTable: string | null | undefined,
  sourceRow: Record<string, unknown> | null | undefined,
  artifactRow?: Record<string, unknown> | null,
  evaluationDate?: string | Date,
): ClaimEligibilityResult {
  const eventAt = resolveClaimSourceEventDate(sourceTable, sourceRow, artifactRow);
  return evaluateClaimEligibilitySync({
    policy,
    claimSource: "import_candidate",
    eventAt,
    hasScannerEvidence: false,
    evaluationDate,
    sourceTable,
  });
}

/** API-only expected row without scan evidence — not claim-eligible under default policy. */
export function evaluateExpectedPackageClaimEligibilitySync(
  policy: ClaimPolicyV1,
  shipmentDate: string | Date | null | undefined,
  hasScannerEvidence: boolean,
  evaluationDate?: string | Date,
): ClaimEligibilityResult {
  return evaluateClaimEligibilitySync({
    policy,
    claimSource: "expected_mismatch",
    eventAt: shipmentDate,
    hasScannerEvidence,
    evaluationDate,
  });
}

export function claimEligibilityReasonLabel(reason: ClaimEligibilityReason): string {
  switch (reason) {
    case "allowed":
      return "Eligible";
    case "scan_not_live":
      return "Before scan go-live date";
    case "import_pre_cutoff":
      return "Before claim start date";
    case "outside_window":
      return "Outside eligibility window";
    case "hold_package_open":
      return "Package not closed";
    case "hold_pallet_open":
      return "Pallet not closed";
    case "hold_order_incomplete":
      return "Order not complete";
    case "manual_review_required":
      return "Manual review required";
    case "missing_scanner_evidence":
      return "Missing scanner evidence";
    case "promote_disabled":
      return "Promote disabled";
    case "module_scope_disabled":
      return "Claim module disabled";
    default:
      return reason;
  }
}
