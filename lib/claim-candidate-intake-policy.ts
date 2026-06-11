/**
 * Claim candidate intake policy — settings-driven control over WHEN physical
 * claim candidates are created, WHICH physical events are claimable, and how
 * manual grouping warns operators.
 *
 * Persisted (no migration) in `organization_settings.claim_policy.candidate_intake`
 * (JSONB). Client + server safe: no I/O in normalizers/evaluators.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const CLAIM_CANDIDATE_TRIGGERS = [
  "per_problem_scan",
  "box_close",
  "shipment_review_close",
  "order_resolved",
  "scheduled_generator_only",
  "manual_only",
] as const;

export type ClaimCandidateTrigger = (typeof CLAIM_CANDIDATE_TRIGGERS)[number];

export const CLAIMABLE_PHYSICAL_EVENTS = [
  "missing",
  "damaged",
  "wrong_item",
  "expired",
  "empty_box",
  "over_received",
  "unexpected_item",
] as const;

export type ClaimablePhysicalEvent = (typeof CLAIMABLE_PHYSICAL_EVENTS)[number];

export type ManualGroupingPolicy = {
  allow_single: boolean;
  allow_grouped: boolean;
  warn_mixed_products: boolean;
  warn_mixed_problem_types: boolean;
  warn_mixed_reference_types: boolean;
};

export type ClaimCandidateIntakePolicy = {
  claim_candidate_trigger: ClaimCandidateTrigger;
  claimable_physical_events: ClaimablePhysicalEvent[];
  claim_over_received: boolean;
  claim_unexpected_item: boolean;
  manual_grouping: ManualGroupingPolicy;
};

export const DEFAULT_CLAIM_CANDIDATE_INTAKE_POLICY: ClaimCandidateIntakePolicy = {
  claim_candidate_trigger: "box_close",
  claimable_physical_events: [...CLAIMABLE_PHYSICAL_EVENTS],
  claim_over_received: true,
  claim_unexpected_item: true,
  manual_grouping: {
    allow_single: true,
    allow_grouped: true,
    warn_mixed_products: true,
    warn_mixed_problem_types: true,
    warn_mixed_reference_types: true,
  },
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseBool(v: unknown, fallback: boolean): boolean {
  if (v === true) return true;
  if (v === false) return false;
  return fallback;
}

export function isClaimCandidateTrigger(v: unknown): v is ClaimCandidateTrigger {
  return typeof v === "string" && (CLAIM_CANDIDATE_TRIGGERS as readonly string[]).includes(v);
}

export function isClaimablePhysicalEvent(v: unknown): v is ClaimablePhysicalEvent {
  return typeof v === "string" && (CLAIMABLE_PHYSICAL_EVENTS as readonly string[]).includes(v);
}

/** Parse `claim_policy.candidate_intake` JSON; unknown values fall back to defaults. */
export function normalizeClaimCandidateIntakePolicy(raw: unknown): ClaimCandidateIntakePolicy {
  const base = DEFAULT_CLAIM_CANDIDATE_INTAKE_POLICY;
  const o = asRecord(raw);
  if (!o) return { ...base, claimable_physical_events: [...base.claimable_physical_events], manual_grouping: { ...base.manual_grouping } };

  const trigger = isClaimCandidateTrigger(o.claim_candidate_trigger)
    ? o.claim_candidate_trigger
    : base.claim_candidate_trigger;

  let events: ClaimablePhysicalEvent[];
  if (Array.isArray(o.claimable_physical_events)) {
    const picked = [...new Set(o.claimable_physical_events.filter(isClaimablePhysicalEvent))];
    events = picked.length ? picked : [...base.claimable_physical_events];
  } else {
    events = [...base.claimable_physical_events];
  }

  const claim_over_received = parseBool(o.claim_over_received, base.claim_over_received);
  const claim_unexpected_item = parseBool(o.claim_unexpected_item, base.claim_unexpected_item);

  // Toggles are the authoritative gate; keep the event list consistent with them.
  if (!claim_over_received) events = events.filter((e) => e !== "over_received");
  if (!claim_unexpected_item) events = events.filter((e) => e !== "unexpected_item");

  const g = asRecord(o.manual_grouping) ?? {};
  const manual_grouping: ManualGroupingPolicy = {
    allow_single: parseBool(g.allow_single, base.manual_grouping.allow_single),
    allow_grouped: parseBool(g.allow_grouped, base.manual_grouping.allow_grouped),
    warn_mixed_products: parseBool(g.warn_mixed_products, base.manual_grouping.warn_mixed_products),
    warn_mixed_problem_types: parseBool(
      g.warn_mixed_problem_types,
      base.manual_grouping.warn_mixed_problem_types,
    ),
    warn_mixed_reference_types: parseBool(
      g.warn_mixed_reference_types,
      base.manual_grouping.warn_mixed_reference_types,
    ),
  };

  return {
    claim_candidate_trigger: trigger,
    claimable_physical_events: events,
    claim_over_received,
    claim_unexpected_item,
    manual_grouping,
  };
}

/** Load org-level candidate intake policy from organization_settings.claim_policy.candidate_intake. */
export async function loadClaimCandidateIntakePolicy(
  client: SupabaseClient,
  organizationId: string,
): Promise<ClaimCandidateIntakePolicy> {
  const { data } = await client
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", organizationId.trim())
    .maybeSingle();
  const claimPolicy = asRecord((data as { claim_policy?: unknown } | null)?.claim_policy);
  return normalizeClaimCandidateIntakePolicy(claimPolicy?.candidate_intake);
}

export function isPhysicalEventClaimable(
  policy: ClaimCandidateIntakePolicy,
  event: ClaimablePhysicalEvent,
): boolean {
  if (event === "over_received" && !policy.claim_over_received) return false;
  if (event === "unexpected_item" && !policy.claim_unexpected_item) return false;
  return policy.claimable_physical_events.includes(event);
}

/** Map scanner condition tags / off-slip marker to the claimable physical event taxonomy. */
export function physicalEventFromScannerSignals(signals: {
  conditionTags: string[];
  offSlip: boolean;
}): ClaimablePhysicalEvent | null {
  if (signals.offSlip) return "unexpected_item";
  const tags = signals.conditionTags.map((t) => t.toLowerCase());
  if (tags.includes("wrong_item")) return "wrong_item";
  if (tags.includes("expired")) return "expired";
  if (tags.includes("missing_item")) return "missing";
  if (tags.includes("damaged_product") || tags.includes("scratched") || tags.includes("missing_parts")) {
    return "damaged";
  }
  return null;
}

export type IntakeRunKind = "live_scan" | "box_close" | "shipment_review_close" | "order_resolved" | "scheduled" | "manual";

/** Whether the configured trigger allows candidate creation for a given run kind. */
export function candidateTriggerAllowsRun(
  trigger: ClaimCandidateTrigger,
  runKind: IntakeRunKind,
): boolean {
  switch (trigger) {
    case "per_problem_scan":
      return true; // earliest trigger — every later consolidation point is also allowed
    case "box_close":
      return runKind !== "live_scan";
    case "shipment_review_close":
      return runKind === "shipment_review_close" || runKind === "order_resolved" || runKind === "scheduled" || runKind === "manual";
    case "order_resolved":
      return runKind === "order_resolved" || runKind === "scheduled" || runKind === "manual";
    case "scheduled_generator_only":
      return runKind === "scheduled" || runKind === "manual";
    case "manual_only":
      return runKind === "manual";
    default:
      return false;
  }
}

export type ManualGroupingWarning =
  | "mixed_products"
  | "mixed_problem_types"
  | "mixed_reference_types";

export type ManualGroupingEvaluation = {
  allowed: boolean;
  blocked_reason: "single_not_allowed" | "grouped_not_allowed" | null;
  warnings: ManualGroupingWarning[];
};

/** Warn-level manual grouping evaluation (blocking stays with claim-settings-gates mixed gates). */
export function evaluateManualGroupingPolicy(
  policy: ManualGroupingPolicy,
  group: {
    itemCount: number;
    distinctProductCount: number;
    distinctProblemTypeCount: number;
    distinctReferenceTypeCount: number;
  },
): ManualGroupingEvaluation {
  if (group.itemCount <= 1 && !policy.allow_single) {
    return { allowed: false, blocked_reason: "single_not_allowed", warnings: [] };
  }
  if (group.itemCount > 1 && !policy.allow_grouped) {
    return { allowed: false, blocked_reason: "grouped_not_allowed", warnings: [] };
  }
  const warnings: ManualGroupingWarning[] = [];
  if (policy.warn_mixed_products && group.distinctProductCount > 1) warnings.push("mixed_products");
  if (policy.warn_mixed_problem_types && group.distinctProblemTypeCount > 1) {
    warnings.push("mixed_problem_types");
  }
  if (policy.warn_mixed_reference_types && group.distinctReferenceTypeCount > 1) {
    warnings.push("mixed_reference_types");
  }
  return { allowed: true, blocked_reason: null, warnings };
}

export const MANUAL_GROUPING_WARNING_LABELS: Record<ManualGroupingWarning, string> = {
  mixed_products: "This group mixes multiple products — Amazon cases file cleaner per product.",
  mixed_problem_types: "This group mixes problem types (e.g. damaged + missing) — consider splitting.",
  mixed_reference_types:
    "This group mixes reference types (e.g. order vs tracking) — evidence may not align in one case.",
};
