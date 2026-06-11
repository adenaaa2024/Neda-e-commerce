/**
 * Phase 7D — claim pool generation automation core.
 * Shared by the platform manual-run server action, the cron scheduler route,
 * and staging verification scripts. Writes claim_candidates ONLY in apply mode;
 * never touches claim_cases / claim_lines.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  computeClaimPoolGenerationNextRun,
  normalizeStoreAutomationSettings,
} from "../../platform-automation-schedule";
import {
  parseAutomationPersisted,
  automationScopeKey,
  writeStoreAutomationSettings,
} from "../../platform-automation-scope-storage";
import type {
  AutomationRunStatus,
  ClaimPoolGenerationSchedule,
  RemovalCronRuntimeState,
} from "../../platform-automation-settings-types";
import { runClaimIntake } from "./claim-generator-registry";
import type { ClaimIntakeRunSummary, ClaimSourceKind } from "./claim-intake-types";

export type ClaimPoolRunCounts = {
  generated: number;
  updated: number;
  superseded: number;
  quarantined_corroborated: number;
  drafts_in_memory: number;
  generators_ran: number;
  errors: number;
};

export type ClaimPoolRunOutcome = {
  ok: boolean;
  run_id: string;
  mode: "dry_run" | "apply";
  window: { from: string; to: string };
  effective_sources: string[];
  blocked_sources: Array<{ source_kind: string; reason: string }>;
  counts: ClaimPoolRunCounts;
  per_source: Array<{
    source_kind: string;
    ran: boolean;
    skip_reason: string | null;
    matched: number;
    drafts: number;
    inserted: number;
    updated: number;
    superseded: number;
    corroborated: number;
    error: string | null;
  }>;
  error: string | null;
};

export async function loadClaimPoolGenerationSchedule(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<{ schedule: ClaimPoolGenerationSchedule; rawSettings: unknown; updatedAt: string | null }> {
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
    schedule: normalized.claim_pool_generation,
    rawSettings: raw?.automation_settings ?? null,
    updatedAt: typeof raw?.updated_at === "string" ? raw.updated_at : null,
  };
}

/** Persist cron_runtime patch for the claim_pool_generation card (read-modify-write scope doc). */
export async function persistClaimPoolCronRuntime(
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
  const prev: RemovalCronRuntimeState = scope.claim_pool_generation.cron_runtime ?? {
    last_run_at: null,
    last_success_at: null,
    last_failed_at: null,
    last_run_status: "never",
    last_error: null,
    next_run_at: null,
    last_slot_key: null,
  };
  const nextSchedule: ClaimPoolGenerationSchedule = {
    ...scope.claim_pool_generation,
    cron_runtime: {
      ...prev,
      ...patch,
      next_run_at:
        patch.next_run_at !== undefined
          ? patch.next_run_at
          : (computeClaimPoolGenerationNextRun(scope.claim_pool_generation)?.toISOString() ?? null),
    },
  };
  const persisted = writeStoreAutomationSettings(raw, organizationId, storeId, {
    ...scope,
    claim_pool_generation: nextSchedule,
  });
  await client
    .from("platform_settings")
    .update({ automation_settings: persisted, updated_at: new Date().toISOString() })
    .eq("id", true);
}

function summarize(summary: ClaimIntakeRunSummary): {
  counts: ClaimPoolRunCounts;
  per_source: ClaimPoolRunOutcome["per_source"];
} {
  const per_source = summary.results.map((r) => ({
    source_kind: r.source_kind,
    ran: r.ran,
    skip_reason: r.skip_reason,
    matched: r.matched_count,
    drafts: r.drafts_generated,
    inserted: r.apply?.inserted ?? 0,
    updated: r.apply?.updated_existing_trusted ?? 0,
    superseded: r.apply?.skipped_identity_conflict ?? 0,
    corroborated: r.apply?.legacy_corroborated ?? 0,
    error: r.error,
  }));
  return {
    per_source,
    counts: {
      generated: per_source.reduce((s, r) => s + r.inserted, 0),
      updated: per_source.reduce((s, r) => s + r.updated, 0),
      superseded: per_source.reduce((s, r) => s + r.superseded, 0),
      quarantined_corroborated: per_source.reduce((s, r) => s + r.corroborated, 0),
      drafts_in_memory: summary.totals.drafts_generated,
      generators_ran: summary.totals.generators_ran,
      errors: per_source.filter((r) => r.error).length,
    },
  };
}

export type ClaimPoolGenerationRunArgs = {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  schedule: ClaimPoolGenerationSchedule;
  /** Requested subset; null = all sources enabled on the card. */
  requestedSources?: string[] | null;
  /** Explicit window override (manual run UI). */
  windowFrom?: string | null;
  windowTo?: string | null;
  apply: boolean;
  runId?: string;
  /** Origin for candidate trigger policy. Default "manual". */
  runKind?: "scheduled" | "manual";
};

/**
 * Effective sources = requested ∩ card.enabled_source_kinds ∩ purchased gates.
 * Window precedence: explicit args > card manual window > card rolling_days.
 */
export async function runClaimPoolGeneration(
  args: ClaimPoolGenerationRunArgs,
): Promise<ClaimPoolRunOutcome> {
  const { client, organizationId, storeId, schedule } = args;

  const blocked: Array<{ source_kind: string; reason: string }> = [];
  const requested = args.requestedSources?.length
    ? args.requestedSources
    : schedule.enabled_source_kinds;
  const effective: string[] = [];
  for (const kind of requested) {
    if (!schedule.enabled_source_kinds.includes(kind)) {
      blocked.push({ source_kind: kind, reason: "disabled_in_automation_settings" });
      continue;
    }
    if (schedule.purchased_source_kinds[kind] === false) {
      blocked.push({ source_kind: kind, reason: "not_purchased_pro_feature" });
      continue;
    }
    effective.push(kind);
  }

  const today = new Date().toISOString().slice(0, 10);
  const rollingFrom = new Date(Date.now() - schedule.rolling_days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const from = args.windowFrom ?? schedule.manual_window_start ?? rollingFrom;
  const to = args.windowTo ?? schedule.manual_window_end ?? today;

  const base: Omit<ClaimPoolRunOutcome, "counts" | "per_source" | "run_id" | "ok" | "error"> = {
    mode: args.apply ? "apply" : "dry_run",
    window: { from, to },
    effective_sources: effective,
    blocked_sources: blocked,
  };

  if (!effective.length) {
    return {
      ...base,
      ok: false,
      run_id: args.runId ?? crypto.randomUUID(),
      counts: {
        generated: 0,
        updated: 0,
        superseded: 0,
        quarantined_corroborated: 0,
        drafts_in_memory: 0,
        generators_ran: 0,
        errors: 0,
      },
      per_source: [],
      error: "No sources remain after enabled/purchased gating.",
    };
  }

  try {
    const summary = await runClaimIntake({
      client,
      organizationId,
      storeId,
      sources: effective as ClaimSourceKind[],
      from,
      to,
      apply: args.apply,
      runId: args.runId,
      maxRuntimeMs: schedule.max_runtime_seconds * 1000,
      runKind: args.runKind ?? "manual",
    });
    const { counts, per_source } = summarize(summary);
    return {
      ...base,
      ok: counts.errors === 0,
      run_id: summary.run_id,
      counts,
      per_source,
      error: null,
    };
  } catch (e) {
    return {
      ...base,
      ok: false,
      run_id: args.runId ?? crypto.randomUUID(),
      counts: {
        generated: 0,
        updated: 0,
        superseded: 0,
        quarantined_corroborated: 0,
        drafts_in_memory: 0,
        generators_ran: 0,
        errors: 1,
      },
      per_source: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function runStatusFromOutcome(outcome: ClaimPoolRunOutcome): AutomationRunStatus {
  if (outcome.error) return "failed";
  if (outcome.counts.errors > 0) return "partial";
  return "success";
}
