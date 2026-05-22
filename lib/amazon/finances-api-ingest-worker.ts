import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AmazonFinancesSourceRunRow } from "./finances-api-archive";
import { assertFinancesArchiveTable } from "./finances-api-allowed-tables";
import type { FinancesApiClient } from "./finances-api-client";
import { FinancesApiError, isFinancesApiAuthError } from "./finances-api-client";
import {
  dedupeEventGroupsById,
  extractFinancialEventGroupsFromListPage,
} from "./finances-api-event-group-parser";
import {
  extractFinancialEventsFromEventsPage,
  flattenFinancialEventsV0,
} from "./finances-api-event-flattener";
import {
  financesApiDisabledReason,
  isAmazonFinancesApiIngestEnabled,
} from "./finances-api-worker-flags";
import {
  FINANCES_OP_LIST_EVENT_GROUPS,
  archiveFinancesApiPage,
  financesOpListEventsByGroup,
  loadFinancesApiPages,
} from "./finances-api-page-archive";
import { resolveReportsApiContext } from "./reports-api-credentials";
import {
  batchInsertFinancesRows,
  eventGroupRowIdMapKey,
  filterNewFinancesEventRows,
  financesArchiveBatchSize,
  flushBufferedFinancesEvents,
  loadEventGroupRowIdMap,
  toFinancesEventGroupInsertRow,
  toFinancesEventInsertRow,
  type FlattenPersistStats,
} from "./finances-api-event-persist";
import {
  FINANCES_INGEST_MAX_ATTEMPTS,
  buildFinancesRunIdempotencyKey,
  createFinancesSourceRun,
  financesRunNeedsResume,
  findFinancesSourceRunByIdempotency,
  isTerminalFinancesRunState,
  loadFinancesSourceRunById,
  patchFinancesSourceRun,
  readFinancesRunMetadata,
  type FinancesRunMetadata,
} from "./finances-api-source-run";
import { supabaseServer } from "../supabase-server";
import { isUuidString } from "../uuid";

export const FINANCES_INGEST_REQUEST_BUDGET_MS = 25_000;

export type FinancesIngestRunRequest = {
  organizationId: string;
  storeId: string;
  marketplaceId?: string | null;
  windowStart: string;
  windowEnd: string;
  sourceRunId?: string | null;
};

export type FinancesIngestRunResult = {
  ok: boolean;
  httpStatus: number;
  source_run_id: string | null;
  state: string | null;
  needs_resume: boolean;
  error?: string;
  error_code?: string;
  idempotent_replay?: boolean;
};

export type FinancesIngestWorkerDeps = {
  client?: FinancesApiClient;
  supabase?: SupabaseClient;
  requestBudgetMs?: number;
  now?: () => number;
  /** When false, skip live HTTP even if flags on (tests). */
  allowHttp?: boolean;
};

function withinBudget(started: number, budgetMs: number, now: () => number): boolean {
  return now() - started < budgetMs;
}

function scheduleRetryIso(attempt: number): string {
  const delaySec = Math.min(120, 15 * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delaySec * 1000).toISOString();
}

async function collectEventGroupIdsFromPages(
  supabase: SupabaseClient,
  sourceRunId: string,
): Promise<string[]> {
  const pages = await loadFinancesApiPages(supabase, sourceRunId, FINANCES_OP_LIST_EVENT_GROUPS);
  const groups = pages.flatMap((p) => extractFinancialEventGroupsFromListPage(p.raw_body));
  return dedupeEventGroupsById(groups).map((g) => g.event_group_id);
}

async function persistEventGroups(
  supabase: SupabaseClient,
  run: AmazonFinancesSourceRunRow,
): Promise<void> {
  const pages = await loadFinancesApiPages(supabase, run.id, FINANCES_OP_LIST_EVENT_GROUPS);
  const groups = dedupeEventGroupsById(
    pages.flatMap((p) => extractFinancialEventGroupsFromListPage(p.raw_body)),
  );
  const rows = groups.map((g) => toFinancesEventGroupInsertRow(run, g));
  await batchInsertFinancesRows(supabase, "amazon_finances_event_groups", rows);
}

async function persistFlattenedEvents(
  supabase: SupabaseClient,
  run: AmazonFinancesSourceRunRow,
  eventGroupIds: string[],
): Promise<FlattenPersistStats> {
  assertFinancesArchiveTable("amazon_finances_events");

  const batchSize = financesArchiveBatchSize();
  const groupPages = await loadFinancesApiPages(supabase, run.id, FINANCES_OP_LIST_EVENT_GROUPS);
  const groupDigestById = new Map<string, string>();
  for (const p of groupPages) {
    for (const g of extractFinancialEventGroupsFromListPage(p.raw_body)) {
      groupDigestById.set(g.event_group_id, g.payload_digest);
    }
  }

  const rowIdMap = await loadEventGroupRowIdMap(supabase, run.organization_id, eventGroupIds);
  let pending: ReturnType<typeof toFinancesEventInsertRow>[] = [];
  const seenInRun = { digest: new Set<string>(), amazon: new Set<string>() };
  let insertBatches = 0;
  let eventRowsAttempted = 0;
  let groupsProcessed = 0;

  const flushPending = async (): Promise<void> => {
    if (!pending.length) return;
    const toInsert = filterNewFinancesEventRows(pending, seenInRun);
    pending = [];
    if (!toInsert.length) return;
    const res = await flushBufferedFinancesEvents(supabase, toInsert, batchSize);
    insertBatches += res.batches;
    eventRowsAttempted += res.rowsAttempted;
  };

  for (const gid of eventGroupIds) {
    const digest = groupDigestById.get(gid);
    if (!digest) continue;
    const eventGroupRowId = rowIdMap.get(eventGroupRowIdMapKey(gid, digest));
    if (!eventGroupRowId) continue;

    const pages = await loadFinancesApiPages(supabase, run.id, financesOpListEventsByGroup(gid));
    const financialEvents: Record<string, unknown> = {};
    for (const page of pages) {
      const chunk = extractFinancialEventsFromEventsPage(page.raw_body);
      for (const [k, v] of Object.entries(chunk)) {
        if (Array.isArray(v)) {
          const existing = financialEvents[k];
          financialEvents[k] = Array.isArray(existing) ? [...existing, ...v] : [...v];
        } else {
          financialEvents[k] = v;
        }
      }
    }

    const flat = flattenFinancialEventsV0(financialEvents);
    for (const ev of flat) {
      pending.push(toFinancesEventInsertRow(run, eventGroupRowId, gid, ev));
      if (pending.length >= batchSize) {
        await flushPending();
      }
    }
    groupsProcessed += 1;
  }

  await flushPending();

  return { groupsProcessed, eventRowsAttempted, insertBatches };
}

async function runListGroupsPhase(
  supabase: SupabaseClient,
  client: FinancesApiClient,
  run: AmazonFinancesSourceRunRow,
  meta: FinancesRunMetadata,
  started: number,
  budgetMs: number,
  now: () => number,
): Promise<FinancesRunMetadata> {
  let nextToken = meta.list_groups_next_token ?? null;
  const windowStart = run.window_start ?? "";
  const windowEnd = run.window_end ?? "";

  while (withinBudget(started, budgetMs, now)) {
    const res = await client.listFinancialEventGroups({
      startedAfter: windowStart,
      startedBefore: windowEnd,
      nextToken,
    });

    await archiveFinancesApiPage(supabase, {
      organizationId: run.organization_id,
      sourceRunId: run.id,
      operation: FINANCES_OP_LIST_EVENT_GROUPS,
      nextTokenIn: nextToken,
      nextTokenOut: res.nextToken,
      httpStatus: 200,
      rawBody: res.raw as unknown as Record<string, unknown>,
    });

    nextToken = res.nextToken;
    if (!nextToken) break;
  }

  const eventGroupIds = await collectEventGroupIdsFromPages(supabase, run.id);
  const groupsDone = !nextToken;

  return {
    ...meta,
    phase: groupsDone ? "list_events_by_group" : "list_groups",
    list_groups_next_token: nextToken,
    event_group_ids: eventGroupIds,
    events_group_index: meta.events_group_index ?? 0,
    events_next_token: null,
    current_event_group_id: null,
  };
}

async function runListEventsPhase(
  supabase: SupabaseClient,
  client: FinancesApiClient,
  run: AmazonFinancesSourceRunRow,
  meta: FinancesRunMetadata,
  started: number,
  budgetMs: number,
  now: () => number,
): Promise<FinancesRunMetadata> {
  const groupIds = meta.event_group_ids ?? [];
  let idx = meta.events_group_index ?? 0;
  let nextToken = meta.events_next_token ?? null;
  let currentGroupId = meta.current_event_group_id ?? groupIds[idx] ?? null;

  while (withinBudget(started, budgetMs, now) && idx < groupIds.length) {
    const gid = currentGroupId ?? groupIds[idx];
    if (!gid) break;
    const operation = financesOpListEventsByGroup(gid);

    const res = await client.listFinancialEventsByGroup({
      eventGroupId: gid,
      nextToken,
    });

    await archiveFinancesApiPage(supabase, {
      organizationId: run.organization_id,
      sourceRunId: run.id,
      operation,
      nextTokenIn: nextToken,
      nextTokenOut: res.nextToken,
      httpStatus: 200,
      rawBody: res.raw as unknown as Record<string, unknown>,
    });

    nextToken = res.nextToken;
    if (!nextToken) {
      idx += 1;
      currentGroupId = groupIds[idx] ?? null;
    }
  }

  const eventsDone = idx >= groupIds.length;
  return {
    ...meta,
    phase: eventsDone ? "flatten" : "list_events_by_group",
    event_group_ids: groupIds,
    events_group_index: idx,
    events_next_token: nextToken,
    current_event_group_id: currentGroupId,
  };
}

export async function runFinancesApiIngestWorker(
  req: FinancesIngestRunRequest,
  deps: FinancesIngestWorkerDeps = {},
): Promise<FinancesIngestRunResult> {
  const disabled = financesApiDisabledReason();
  if (disabled) {
    return {
      ok: false,
      httpStatus: 503,
      source_run_id: null,
      state: null,
      needs_resume: false,
      error:
        disabled === "worker_disabled"
          ? "Amazon Finances API worker is disabled (ENABLE_AMAZON_FINANCES_API_WORKER)."
          : "Finances API ingest is disabled (ENABLE_AMAZON_FINANCES_API_INGEST).",
      error_code: disabled,
    };
  }

  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.requestBudgetMs ?? FINANCES_INGEST_REQUEST_BUDGET_MS;
  const started = now();
  const supabase = deps.supabase ?? supabaseServer;
  const allowHttp = deps.allowHttp !== false;

  if (!isUuidString(req.organizationId) || !isUuidString(req.storeId)) {
    return {
      ok: false,
      httpStatus: 400,
      source_run_id: null,
      state: null,
      needs_resume: false,
      error: "organization_id and store_id must be valid UUIDs.",
      error_code: "invalid_input",
    };
  }

  const windowStart = req.windowStart.trim();
  const windowEnd = req.windowEnd.trim();
  if (!windowStart || !windowEnd) {
    return {
      ok: false,
      httpStatus: 400,
      source_run_id: null,
      state: null,
      needs_resume: false,
      error: "windowStart and windowEnd are required (ISO8601).",
      error_code: "invalid_window",
    };
  }

  const marketplaceId = req.marketplaceId?.trim() || null;
  const idempotencyKey = buildFinancesRunIdempotencyKey({
    organizationId: req.organizationId,
    storeId: req.storeId,
    marketplaceId,
    windowStart,
    windowEnd,
  });

  let run: AmazonFinancesSourceRunRow | null = null;
  let idempotentReplay = false;

  const resumeId = req.sourceRunId?.trim();
  if (resumeId && isUuidString(resumeId)) {
    run = await loadFinancesSourceRunById(supabase, req.organizationId, resumeId);
    if (!run) {
      return {
        ok: false,
        httpStatus: 404,
        source_run_id: resumeId,
        state: null,
        needs_resume: false,
        error: "Source run not found.",
        error_code: "source_run_not_found",
      };
    }
  } else {
    const existing = await findFinancesSourceRunByIdempotency(
      supabase,
      req.organizationId,
      idempotencyKey,
    );
    if (existing?.state === "complete") {
      return {
        ok: true,
        httpStatus: 200,
        source_run_id: existing.id,
        state: existing.state,
        needs_resume: false,
        idempotent_replay: true,
      };
    }
    if (existing) {
      run = existing;
    } else {
      run = await createFinancesSourceRun(supabase, {
        organizationId: req.organizationId,
        storeId: req.storeId,
        marketplaceId,
        windowStart,
        windowEnd,
        idempotencyKey,
      });
    }
  }

  if (!run) {
    return {
      ok: false,
      httpStatus: 500,
      source_run_id: null,
      state: null,
      needs_resume: false,
      error: "Failed to resolve source run.",
      error_code: "internal",
    };
  }

  if (isTerminalFinancesRunState(run.state)) {
    idempotentReplay = run.state === "complete";
    return {
      ok: run.state === "complete",
      httpStatus: run.state === "complete" ? 200 : 422,
      source_run_id: run.id,
      state: run.state,
      needs_resume: false,
      idempotent_replay: idempotentReplay,
      ...(run.state === "failed"
        ? { error: "Source run is in failed state.", error_code: "run_failed" }
        : {}),
    };
  }

  const attemptCount = Number((run.attempt as { count?: number })?.count ?? 0);
  if (attemptCount >= FINANCES_INGEST_MAX_ATTEMPTS) {
    await patchFinancesSourceRun(supabase, run.id, run.organization_id, {
      state: "failed",
      attempt: { last_error_code: "max_attempts", count: attemptCount },
    });
    return {
      ok: false,
      httpStatus: 422,
      source_run_id: run.id,
      state: "failed",
      needs_resume: false,
      error: "Max ingest attempts exceeded.",
      error_code: "max_attempts",
    };
  }

  let client = deps.client;
  if (!client && allowHttp) {
    const ctxRes = await resolveReportsApiContext(req.organizationId, req.storeId);
    if (!ctxRes.ok) {
      await patchFinancesSourceRun(supabase, run.id, run.organization_id, {
        state: "failed",
        attempt: {
          count: attemptCount + 1,
          last_error_code: "credentials_missing",
          next_retry_at: scheduleRetryIso(attemptCount + 1),
          last_operation: FINANCES_OP_LIST_EVENT_GROUPS,
        },
      });
      return {
        ok: false,
        httpStatus: 422,
        source_run_id: run.id,
        state: "failed",
        needs_resume: false,
        error: ctxRes.error,
        error_code: "credentials_missing",
      };
    }
    const { FinancesApiClient: Client } = await import("./finances-api-client");
    client = new Client({ context: ctxRes.context });
  }

  let meta = readFinancesRunMetadata(run);
  if (!meta.phase) meta = { ...meta, phase: "list_groups" };

  try {
    if (run.state === "requested") {
      await patchFinancesSourceRun(supabase, run.id, run.organization_id, { state: "polling" });
      run = { ...run, state: "polling" };
    }

    if (
      client &&
      allowHttp &&
      (meta.phase === "list_groups" || !meta.phase) &&
      withinBudget(started, budgetMs, now)
    ) {
      meta = await runListGroupsPhase(supabase, client, run, meta, started, budgetMs, now);
      await patchFinancesSourceRun(supabase, run.id, run.organization_id, {
        state: "polling",
        metadata: meta,
      });
    }

    if (
      client &&
      allowHttp &&
      meta.phase === "list_events_by_group" &&
      withinBudget(started, budgetMs, now)
    ) {
      if (!meta.event_group_ids?.length) {
        meta.event_group_ids = await collectEventGroupIdsFromPages(supabase, run.id);
      }
      meta = await runListEventsPhase(supabase, client, run, meta, started, budgetMs, now);
      await patchFinancesSourceRun(supabase, run.id, run.organization_id, {
        state: meta.phase === "flatten" ? "archived" : "polling",
        metadata: meta,
      });
      if (meta.phase === "flatten") {
        run = { ...run, state: "archived" };
      }
    }

    if (meta.phase === "flatten" || run.state === "archived") {
      await persistEventGroups(supabase, run);
      const groupIds =
        meta.event_group_ids && meta.event_group_ids.length > 0
          ? meta.event_group_ids
          : await collectEventGroupIdsFromPages(supabase, run.id);
      await persistFlattenedEvents(supabase, run, groupIds);
      meta = { ...meta, phase: "done" };
      await patchFinancesSourceRun(supabase, run.id, run.organization_id, {
        state: "complete",
        metadata: meta,
      });
      return {
        ok: true,
        httpStatus: 200,
        source_run_id: run.id,
        state: "complete",
        needs_resume: false,
      };
    }

    const refreshed = await loadFinancesSourceRunById(supabase, run.organization_id, run.id);
    const state = refreshed?.state ?? run.state;
    const needsResume = financesRunNeedsResume(
      state,
      isAmazonFinancesApiIngestEnabled(),
    );

    return {
      ok: true,
      httpStatus: needsResume ? 202 : 200,
      source_run_id: run.id,
      state,
      needs_resume: needsResume,
    };
  } catch (err) {
    const code =
      err instanceof FinancesApiError
        ? err.code
        : isFinancesApiAuthError(err)
          ? "auth_error"
          : "ingest_error";
    await patchFinancesSourceRun(supabase, run.id, run.organization_id, {
      state: isFinancesApiAuthError(err) ? "failed" : "polling",
      attempt: {
        count: attemptCount + 1,
        last_error_code: code,
        next_retry_at: scheduleRetryIso(attemptCount + 1),
        last_operation: meta.phase ?? "list_groups",
      },
    });
    return {
      ok: false,
      httpStatus: isFinancesApiAuthError(err) ? 401 : 500,
      source_run_id: run.id,
      state: isFinancesApiAuthError(err) ? "failed" : "polling",
      needs_resume: !isFinancesApiAuthError(err),
      error: err instanceof Error ? err.message : String(err),
      error_code: code,
    };
  }
}

export type FlattenReplayBenchmarkResult = {
  source_run_id: string;
  organization_id: string;
  replay_mode: "archived_pages_only";
  live_amazon: false;
  api_page_count: number;
  event_group_count: number;
  batch_size: number;
  frr_before: number;
  frr_after: number;
  events_before: number;
  events_after_pass1: number;
  events_after_pass2: number;
  pass1: FlattenPersistStats & { wall_ms: number };
  pass2: FlattenPersistStats & { wall_ms: number };
  idempotent_duplicate_safe: boolean;
};

/** Re-run flatten from existing `amazon_finances_api_pages` (no Amazon HTTP). */
export async function benchmarkArchiveFlattenReplay(
  organizationId: string,
  sourceRunId: string,
  supabase: SupabaseClient = supabaseServer,
): Promise<FlattenReplayBenchmarkResult> {
  const run = await loadFinancesSourceRunById(supabase, organizationId, sourceRunId);
  if (!run) {
    throw new Error(`Source run not found: ${sourceRunId}`);
  }

  const apiPageCount = (
    await supabase
      .from("amazon_finances_api_pages")
      .select("id", { count: "exact", head: true })
      .eq("source_run_id", sourceRunId)
  ).count;
  if (!apiPageCount) {
    throw new Error(`No archived pages for source_run ${sourceRunId}`);
  }

  const groupIds = await collectEventGroupIdsFromPages(supabase, sourceRunId);

  const frrBefore = await countFrrRows(supabase, organizationId);
  const eventsBefore = await countEventsForRun(supabase, sourceRunId);

  const t1 = performance.now();
  const pass1 = await persistFlattenedEvents(supabase, run, groupIds);
  const pass1Ms = performance.now() - t1;

  const eventsAfterPass1 = await countEventsForRun(supabase, sourceRunId);

  const t2 = performance.now();
  const pass2 = await persistFlattenedEvents(supabase, run, groupIds);
  const pass2Ms = performance.now() - t2;

  const eventsAfterPass2 = await countEventsForRun(supabase, sourceRunId);
  const frrAfter = await countFrrRows(supabase, organizationId);

  return {
    source_run_id: sourceRunId,
    organization_id: organizationId,
    replay_mode: "archived_pages_only",
    live_amazon: false,
    api_page_count: apiPageCount ?? 0,
    event_group_count: groupIds.length,
    batch_size: financesArchiveBatchSize(),
    frr_before: frrBefore,
    frr_after: frrAfter,
    events_before: eventsBefore,
    events_after_pass1: eventsAfterPass1,
    events_after_pass2: eventsAfterPass2,
    pass1: { ...pass1, wall_ms: Math.round(pass1Ms) },
    pass2: { ...pass2, wall_ms: Math.round(pass2Ms) },
    idempotent_duplicate_safe: eventsAfterPass1 === eventsAfterPass2,
  };
}

async function countFrrRows(supabase: SupabaseClient, organizationId: string): Promise<number> {
  const { count, error } = await supabase
    .from("financial_reference_resolver")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) throw new Error(`count FRR: ${error.message}`);
  return count ?? 0;
}

async function countEventsForRun(supabase: SupabaseClient, sourceRunId: string): Promise<number> {
  const { count, error } = await supabase
    .from("amazon_finances_events")
    .select("id", { count: "exact", head: true })
    .eq("source_run_id", sourceRunId);
  if (error) throw new Error(`count events: ${error.message}`);
  return count ?? 0;
}
