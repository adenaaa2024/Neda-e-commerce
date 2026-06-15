/**
 * PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1
 * Unified effective-date evaluation for preview, grouping, and emit.
 * Reads policy from ClaimIntakeEffectivePolicy / claim-eligibility-policy (no hardcoded dates).
 */
import { toUtcDateString } from "@/lib/claim-eligibility-policy";
import type { EffectiveClaimSettings } from "@/lib/claim-effective-settings";
import type { ClaimIntakeEffectivePolicy } from "@/lib/claims/intake/claim-intake-policy-contract";
import type { ClaimIntakeWindow } from "@/lib/claims/intake/claim-intake-types";
import type { ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";

export const EFFECTIVE_DATE_GATE_VERSION = "claim-effective-date-gate-v1" as const;

export type EffectiveDateSourceField = "claim_start_date" | "scan_go_live_date";

export type EffectiveDateGateSkipReason =
  | "missing_effective_date_config"
  | "missing_source_event_date"
  | "pre_cutoff_event"
  | "outside_eligibility_window";

/** Import/API/removal/reimbursement/EP lanes → claim_start_date; scanner/physical → scan_go_live_date. */
const IMPORT_API_SOURCE_KINDS = new Set<ClaimSourceKind>([
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

export function resolveEffectiveDateForSource(
  sourceKind: ClaimSourceKind | string | null,
  policy: Pick<ClaimIntakeEffectivePolicy, "scan_go_live_date" | "claim_start_date">,
): { effective_date_source: EffectiveDateSourceField; effective_date_value: string | null } {
  const kind = String(sourceKind ?? "").trim() as ClaimSourceKind;
  if (kind && IMPORT_API_SOURCE_KINDS.has(kind)) {
    return {
      effective_date_source: "claim_start_date",
      effective_date_value: policy.claim_start_date,
    };
  }
  return {
    effective_date_source: "scan_go_live_date",
    effective_date_value: policy.scan_go_live_date,
  };
}

/** Earliest policy cutoff across claim_start_date and scan_go_live_date (intake window floor). */
export function earliestPolicyCutoff(
  policy: Pick<ClaimIntakeEffectivePolicy, "claim_start_date" | "scan_go_live_date">,
): string | null {
  const dates = [policy.claim_start_date, policy.scan_go_live_date]
    .map((d) => toUtcDateString(d))
    .filter((d): d is string => Boolean(d));
  if (!dates.length) return null;
  return dates.sort()[0]!;
}

function daysBetweenUtcDates(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00.000Z`);
  const b = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.floor((b - a) / 86400000);
}

/** Bind rolling/explicit intake window floor to policy cutoffs (expand backward when rolling is narrower). */
export function applyPolicyFloorToIntakeWindow(
  window: ClaimIntakeWindow,
  policy: Pick<ClaimIntakeEffectivePolicy, "claim_start_date" | "scan_go_live_date">,
): ClaimIntakeWindow {
  const floor = earliestPolicyCutoff(policy);
  if (!floor || window.from <= floor) return window;
  return {
    ...window,
    from: floor,
    source: window.source === "rolling_window" ? "explicit_settings" : window.source,
  };
}

export type EffectiveDateGateEvaluation = {
  pass: boolean;
  date_gate_passed: boolean;
  effective_date_source: EffectiveDateSourceField | null;
  effective_date_value: string | null;
  source_event_date: string | null;
  pre_cutoff: boolean;
  missing_event_date: boolean;
  outside_eligibility_window: boolean;
  skip_reason: EffectiveDateGateSkipReason | null;
};

export function evaluateClaimEffectiveDateGate(args: {
  source_kind: ClaimSourceKind | string | null;
  event_date: string | Date | null | undefined;
  policy: Pick<
    ClaimIntakeEffectivePolicy,
    "scan_go_live_date" | "claim_start_date" | "claim_eligibility_window_days"
  >;
  evaluation_date?: string | Date;
}): EffectiveDateGateEvaluation {
  const { effective_date_source, effective_date_value } = resolveEffectiveDateForSource(
    args.source_kind,
    args.policy,
  );
  const sourceEventDate = toUtcDateString(args.event_date);
  const today = toUtcDateString(args.evaluation_date ?? new Date());

  if (!effective_date_value) {
    return {
      pass: false,
      date_gate_passed: false,
      effective_date_source,
      effective_date_value: null,
      source_event_date: sourceEventDate,
      pre_cutoff: false,
      missing_event_date: !sourceEventDate,
      outside_eligibility_window: false,
      skip_reason: "missing_effective_date_config",
    };
  }

  if (!sourceEventDate) {
    return {
      pass: false,
      date_gate_passed: false,
      effective_date_source,
      effective_date_value,
      source_event_date: null,
      pre_cutoff: false,
      missing_event_date: true,
      outside_eligibility_window: false,
      skip_reason: "missing_source_event_date",
    };
  }

  if (sourceEventDate < effective_date_value) {
    return {
      pass: false,
      date_gate_passed: false,
      effective_date_source,
      effective_date_value,
      source_event_date: sourceEventDate,
      pre_cutoff: true,
      missing_event_date: false,
      outside_eligibility_window: false,
      skip_reason: "pre_cutoff_event",
    };
  }

  if (
    today &&
    daysBetweenUtcDates(sourceEventDate, today) > args.policy.claim_eligibility_window_days
  ) {
    return {
      pass: false,
      date_gate_passed: false,
      effective_date_source,
      effective_date_value,
      source_event_date: sourceEventDate,
      pre_cutoff: false,
      missing_event_date: false,
      outside_eligibility_window: true,
      skip_reason: "outside_eligibility_window",
    };
  }

  return {
    pass: true,
    date_gate_passed: true,
    effective_date_source,
    effective_date_value,
    source_event_date: sourceEventDate,
    pre_cutoff: false,
    missing_event_date: false,
    outside_eligibility_window: false,
    skip_reason: null,
  };
}

export function effectiveDateGateMetadata(
  gate: EffectiveDateGateEvaluation,
): Record<string, unknown> {
  return {
    date_gate_version: EFFECTIVE_DATE_GATE_VERSION,
    effective_date_source: gate.effective_date_source,
    effective_date_value: gate.effective_date_value,
    source_event_date: gate.source_event_date,
    date_gate_passed: gate.date_gate_passed,
    pre_cutoff: gate.pre_cutoff,
    missing_event_date: gate.missing_event_date,
  };
}

/** Default grouping date_from when client omits it — earliest policy cutoff. */
export function defaultGroupingDateFrom(
  policy: Pick<ClaimIntakeEffectivePolicy, "claim_start_date" | "scan_go_live_date">,
): string | null {
  return earliestPolicyCutoff(policy);
}

export function resolvePreviewEventDate(
  draftEventDate: string | Date | null | undefined,
): string | null {
  return toUtcDateString(draftEventDate);
}

export type EffectiveDateContextPayload = {
  gate_version: typeof EFFECTIVE_DATE_GATE_VERSION;
  claim_start_date: string | null;
  scan_go_live_date: string | null;
  claim_eligibility_window_days: number;
  intake_window_floor: string | null;
  default_grouping_date_from: string | null;
  import_api_cutoff_source: "claim_start_date";
  scanner_cutoff_source: "scan_go_live_date";
};

export function buildEffectiveDateContext(
  policy: ClaimIntakeEffectivePolicy,
  window?: ClaimIntakeWindow,
): EffectiveDateContextPayload {
  return {
    gate_version: EFFECTIVE_DATE_GATE_VERSION,
    claim_start_date: policy.claim_start_date,
    scan_go_live_date: policy.scan_go_live_date,
    claim_eligibility_window_days: policy.claim_eligibility_window_days,
    intake_window_floor: earliestPolicyCutoff(policy),
    default_grouping_date_from: defaultGroupingDateFrom(policy),
    import_api_cutoff_source: "claim_start_date",
    scanner_cutoff_source: "scan_go_live_date",
  };
}

/** Bridge EffectiveClaimSettings snapshot into gate policy shape. */
export function policyFromEffectiveSettings(
  settings: EffectiveClaimSettings,
): Pick<
  ClaimIntakeEffectivePolicy,
  "scan_go_live_date" | "claim_start_date" | "claim_eligibility_window_days"
> {
  return {
    scan_go_live_date: settings.claim_from_date,
    claim_start_date: settings.claim_cutoff_date,
    claim_eligibility_window_days: settings.claim_window_days,
  };
}

export function previewItemPassesDateFilter(
  item: { event_date?: string | null; source_event_date?: string | null },
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
): boolean {
  const eventDate = toUtcDateString(item.event_date ?? item.source_event_date);
  if (dateFrom || dateTo) {
    if (!eventDate) return false;
    if (dateFrom && eventDate < dateFrom) return false;
    if (dateTo && eventDate > dateTo) return false;
  }
  return true;
}
