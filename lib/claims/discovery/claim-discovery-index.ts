import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CLAIM_DISCOVERY_SOURCE_KINDS,
  type ClaimDiscoveryIndexState,
  type ClaimDiscoverySchedule,
  type ClaimDiscoverySourceKind,
  type ClaimDiscoverySourceIndex,
  type IndexedSourceResult,
  isClaimDiscoverySourceKind,
} from "./claim-discovery-types";

const EMPTY_SOURCE_INDEX = (): ClaimDiscoverySourceIndex => ({
  last_through_date: null,
  last_run_at: null,
  last_run_id: null,
  rows_indexed: 0,
});

export function emptyDiscoveryIndexState(): ClaimDiscoveryIndexState {
  return { version: 1, sources: {}, updated_at: null };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseIsoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function parseDiscoveryIndexState(raw: unknown): ClaimDiscoveryIndexState {
  const base = emptyDiscoveryIndexState();
  const o = asRecord(raw);
  if (!o) return base;

  const sources: ClaimDiscoveryIndexState["sources"] = {};
  const srcRaw = asRecord(o.sources);
  if (srcRaw) {
    for (const kind of CLAIM_DISCOVERY_SOURCE_KINDS) {
      const row = asRecord(srcRaw[kind]);
      if (!row) continue;
      sources[kind] = {
        last_through_date: parseIsoDate(row.last_through_date),
        last_run_at: typeof row.last_run_at === "string" ? row.last_run_at : null,
        last_run_id: typeof row.last_run_id === "string" ? row.last_run_id : null,
        rows_indexed: Math.max(0, Math.floor(Number(row.rows_indexed ?? 0))),
      };
    }
  }

  return {
    version: 1,
    sources,
    updated_at: typeof o.updated_at === "string" ? o.updated_at : null,
  };
}

export async function loadDiscoveryIndexState(
  client: SupabaseClient,
  organizationId: string,
): Promise<ClaimDiscoveryIndexState> {
  const { data, error } = await client
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("claim_policy") || msg.includes("column") || msg.includes("schema")) {
      return emptyDiscoveryIndexState();
    }
    throw new Error(error.message);
  }
  const policy = asRecord((data as { claim_policy?: unknown } | null)?.claim_policy);
  return parseDiscoveryIndexState(policy?.discovery_index);
}

export async function persistDiscoveryIndexState(
  client: SupabaseClient,
  organizationId: string,
  index: ClaimDiscoveryIndexState,
): Promise<void> {
  const { data, error } = await client
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const policy = asRecord((data as { claim_policy?: unknown } | null)?.claim_policy) ?? {};
  const nextPolicy = {
    ...policy,
    discovery_index: {
      ...index,
      updated_at: new Date().toISOString(),
    },
  };

  const { error: upErr } = await client
    .from("organization_settings")
    .update({ claim_policy: nextPolicy })
    .eq("organization_id", organizationId);
  if (upErr) throw new Error(upErr.message);
}

export type IncrementalWindowPlan = {
  from: string;
  to: string;
  strategy: IndexedSourceResult["strategy"];
  prior_watermark: string | null;
};

/**
 * Per-source incremental window — avoids full-table scans by narrowing to
 * watermark overlap (daily) or capped initial lookback (first run).
 */
export function resolveIncrementalWindow(args: {
  sourceKind: ClaimDiscoverySourceKind;
  schedule: ClaimDiscoverySchedule;
  index: ClaimDiscoveryIndexState;
  manualFrom?: string | null;
  manualTo?: string | null;
  today?: string;
}): IncrementalWindowPlan {
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const manualFrom = parseIsoDate(args.manualFrom);
  const manualTo = parseIsoDate(args.manualTo) ?? today;

  if (manualFrom) {
    return {
      from: manualFrom,
      to: manualTo,
      strategy: "manual_window",
      prior_watermark: args.index.sources[args.sourceKind]?.last_through_date ?? null,
    };
  }

  const wm = args.index.sources[args.sourceKind] ?? EMPTY_SOURCE_INDEX();
  const overlap = Math.max(0, Math.floor(args.schedule.incremental_overlap_days));
  const initialDays = Math.max(1, Math.floor(args.schedule.initial_lookback_days));

  if (wm.last_through_date) {
    const floor = new Date(`${wm.last_through_date}T00:00:00.000Z`);
    floor.setUTCDate(floor.getUTCDate() - overlap);
    const from = floor.toISOString().slice(0, 10);
    return {
      from: from > today ? today : from,
      to: today,
      strategy: "incremental_watermark",
      prior_watermark: wm.last_through_date,
    };
  }

  const fromDate = new Date(`${today}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - initialDays);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: today,
    strategy: "initial_lookback",
    prior_watermark: null,
  };
}

export function advanceIndexForSource(
  index: ClaimDiscoveryIndexState,
  sourceKind: ClaimDiscoverySourceKind,
  result: Pick<IndexedSourceResult, "watermark_advanced_to" | "inserted" | "updated" | "matched">,
  runId: string,
): ClaimDiscoveryIndexState {
  const prev = index.sources[sourceKind] ?? EMPTY_SOURCE_INDEX();
  const rows = result.inserted + result.updated;
  return {
    ...index,
    sources: {
      ...index.sources,
      [sourceKind]: {
        last_through_date: result.watermark_advanced_to,
        last_run_at: new Date().toISOString(),
        last_run_id: runId,
        rows_indexed: prev.rows_indexed + rows,
      },
    },
  };
}

export function mergeIndexedResultsIntoIndex(
  index: ClaimDiscoveryIndexState,
  results: IndexedSourceResult[],
  runId: string,
  apply: boolean,
): ClaimDiscoveryIndexState {
  if (!apply) return index;
  let next = index;
  for (const r of results) {
    if (!isClaimDiscoverySourceKind(r.source_kind)) continue;
    next = advanceIndexForSource(next, r.source_kind, r, runId);
  }
  return next;
}
