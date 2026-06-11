/**
 * Claim Discovery Engine — per-source incremental intake into claim_candidates.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { runClaimIntake } from "../intake/claim-generator-registry";
import type { ClaimSourceKind } from "../intake/claim-intake-types";
import { loadDiscoveryEligibilityQueue } from "./claim-discovery-eligibility";
import {
  loadDiscoveryIndexState,
  mergeIndexedResultsIntoIndex,
  persistDiscoveryIndexState,
  resolveIncrementalWindow,
} from "./claim-discovery-index";
import type {
  ClaimDiscoveryRunOutcome,
  ClaimDiscoverySchedule,
  ClaimDiscoverySourceKind,
  IndexedSourceResult,
} from "./claim-discovery-types";
import { isClaimDiscoverySourceKind as isDiscoveryKind } from "./claim-discovery-types";

export type RunClaimDiscoveryArgs = {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  schedule: ClaimDiscoverySchedule;
  apply: boolean;
  runKind: "scheduled" | "manual";
  requestedSources?: string[] | null;
  windowFrom?: string | null;
  windowTo?: string | null;
  runId?: string;
};

function effectiveDiscoverySources(
  schedule: ClaimDiscoverySchedule,
  requested?: string[] | null,
): { effective: ClaimDiscoverySourceKind[]; blocked: Array<{ source_kind: string; reason: string }> } {
  const blocked: Array<{ source_kind: string; reason: string }> = [];
  const pool = requested?.length ? requested : schedule.enabled_source_kinds;
  const effective: ClaimDiscoverySourceKind[] = [];

  for (const raw of pool) {
    if (!isDiscoveryKind(raw)) {
      blocked.push({ source_kind: String(raw), reason: "unknown_discovery_source" });
      continue;
    }
    if (!schedule.enabled_source_kinds.includes(raw)) {
      blocked.push({ source_kind: raw, reason: "disabled_in_discovery_settings" });
      continue;
    }
    if (schedule.purchased_source_kinds[raw] === false) {
      blocked.push({ source_kind: raw, reason: "not_purchased_pro_feature" });
      continue;
    }
    effective.push(raw);
  }

  return { effective, blocked };
}

export async function runClaimDiscovery(args: RunClaimDiscoveryArgs): Promise<ClaimDiscoveryRunOutcome> {
  const runId = args.runId ?? crypto.randomUUID();
  const { effective, blocked } = effectiveDiscoverySources(args.schedule, args.requestedSources);

  let index = await loadDiscoveryIndexState(args.client, args.organizationId);
  const indexed_sources: IndexedSourceResult[] = [];
  let generated = 0;
  let updated = 0;
  let errors = 0;
  const deadline =
    args.schedule.max_runtime_seconds > 0
      ? Date.now() + args.schedule.max_runtime_seconds * 1000
      : null;

  for (const sourceKind of effective) {
    if (deadline && Date.now() > deadline) {
      indexed_sources.push({
        source_kind: sourceKind,
        window: { from: "", to: "" },
        strategy: "incremental_watermark",
        prior_watermark: index.sources[sourceKind]?.last_through_date ?? null,
        matched: 0,
        drafts: 0,
        inserted: 0,
        updated: 0,
        watermark_advanced_to: index.sources[sourceKind]?.last_through_date ?? "",
      });
      errors += 1;
      break;
    }

    const plan = resolveIncrementalWindow({
      sourceKind,
      schedule: args.schedule,
      index,
      manualFrom: args.windowFrom,
      manualTo: args.windowTo,
    });

    try {
      const summary = await runClaimIntake({
        client: args.client,
        organizationId: args.organizationId,
        storeId: args.storeId,
        sources: [sourceKind as ClaimSourceKind],
        from: plan.from,
        to: plan.to,
        apply: args.apply,
        runId,
        maxRuntimeMs: deadline ? Math.max(1000, deadline - Date.now()) : null,
        runKind: args.runKind,
      });

      const result = summary.results[0];
      const inserted = result?.apply?.inserted ?? 0;
      const upd = result?.apply?.updated_existing_trusted ?? 0;
      const drafts = result?.drafts_generated ?? 0;
      const matched = result?.matched_count ?? 0;
      if (result?.error) errors += 1;

      generated += inserted;
      updated += upd;

      indexed_sources.push({
        source_kind: sourceKind,
        window: { from: plan.from, to: plan.to },
        strategy: plan.strategy,
        prior_watermark: plan.prior_watermark,
        matched,
        drafts,
        inserted,
        updated: upd,
        watermark_advanced_to: plan.to,
      });
    } catch (e) {
      errors += 1;
      indexed_sources.push({
        source_kind: sourceKind,
        window: { from: plan.from, to: plan.to },
        strategy: plan.strategy,
        prior_watermark: plan.prior_watermark,
        matched: 0,
        drafts: 0,
        inserted: 0,
        updated: 0,
        watermark_advanced_to: index.sources[sourceKind]?.last_through_date ?? plan.from,
      });
      if (blocked.length === 0 && effective.length === 1) {
        return {
          ok: false,
          run_id: runId,
          mode: args.apply ? "apply" : "dry_run",
          run_kind: args.runKind,
          indexed_sources,
          candidate_queue: [],
          counts: {
            sources_ran: indexed_sources.length,
            generated,
            updated,
            queue_eligible: 0,
            queue_total: 0,
            errors,
          },
          index_state: index,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }

  if (blocked.length && !effective.length) {
    return {
      ok: false,
      run_id: runId,
      mode: args.apply ? "apply" : "dry_run",
      run_kind: args.runKind,
      indexed_sources,
      candidate_queue: [],
      counts: {
        sources_ran: 0,
        generated: 0,
        updated: 0,
        queue_eligible: 0,
        queue_total: 0,
        errors: blocked.length,
      },
      index_state: index,
      error: blocked.map((b) => `${b.source_kind}: ${b.reason}`).join("; "),
    };
  }

  index = mergeIndexedResultsIntoIndex(index, indexed_sources, runId, args.apply);
  if (args.apply) {
    await persistDiscoveryIndexState(args.client, args.organizationId, index);
  }

  const { queue, total_scanned } = args.apply
    ? await loadDiscoveryEligibilityQueue(args.client, args.organizationId, runId, {
        sourceKinds: effective,
        storeId: args.storeId,
      })
    : { queue: [], total_scanned: 0 };

  return {
    ok: errors === 0,
    run_id: runId,
    mode: args.apply ? "apply" : "dry_run",
    run_kind: args.runKind,
    indexed_sources,
    candidate_queue: queue,
    counts: {
      sources_ran: indexed_sources.length,
      generated,
      updated,
      queue_eligible: queue.length,
      queue_total: total_scanned,
      errors,
    },
    index_state: index,
    error: errors > 0 ? `${errors} source(s) failed or hit runtime cap` : null,
  };
}
