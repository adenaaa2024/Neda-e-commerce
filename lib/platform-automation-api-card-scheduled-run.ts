import "server-only";

import {
  financesApiDisabledReason,
  isAmazonFinancesApiIngestEnabled,
} from "./amazon/finances-api-worker-flags";
import { runFinancesApiIngestWorker } from "./amazon/finances-api-ingest-worker";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiSettlementEnabled,
  reportsApiDisabledReasonForReimbursements,
  reportsApiDisabledReasonForSettlement,
} from "./amazon/reports-api-worker-flags";
import { runReimbursementsReportsWorker } from "./amazon/reports-api-reimbursements-worker";
import { runSettlementReportsWorker } from "./amazon/reports-api-settlement-worker";
import { apiCardSyncWindowThroughToday } from "./platform-automation-api-card-window";
import { persistApiCardCronRuntime, type ApiCardScheduleKey } from "./platform-automation-api-card-runtime-storage";
import type { ApiCardScheduleEvaluation } from "./platform-automation-scheduler-due";
import { computeApiCardNextRun } from "./platform-automation-schedule";
import type {
  ApiAutomationCardSchedule,
  FinancesArchiveApiSchedule,
  RemovalCronRuntimeState,
} from "./platform-automation-settings-types";

export type ApiCardScheduledRunResult = {
  card: ApiCardScheduleKey;
  ok: boolean;
  skipped: boolean;
  reason: string;
  upload_id?: string | null;
  source_run_id?: string | null;
  state?: string | null;
  needs_resume?: boolean;
  error?: string;
  window?: { start: string; end: string };
};

function slotKey(hourUtc: number): string {
  const d = new Date();
  return `${d.toISOString().slice(0, 10)}T${String(hourUtc).padStart(2, "0")}Z`;
}

async function persistRunning(
  connectionString: string,
  organizationId: string,
  storeId: string,
  card: ApiCardScheduleKey,
  schedule: ApiAutomationCardSchedule | FinancesArchiveApiSchedule,
  hourUtc: number,
): Promise<void> {
  const startedAt = new Date().toISOString();
  await persistApiCardCronRuntime({
    connectionString,
    organizationId,
    storeId,
    card,
    scheduleForNextRun: schedule,
    patch: {
      last_run_at: startedAt,
      last_run_status: "running",
      last_error: null,
      last_slot_key: slotKey(hourUtc),
    },
  });
}

async function persistFinished(
  connectionString: string,
  organizationId: string,
  storeId: string,
  card: ApiCardScheduleKey,
  schedule: ApiAutomationCardSchedule | FinancesArchiveApiSchedule,
  success: boolean,
  error: string | null,
  hourUtc: number,
): Promise<RemovalCronRuntimeState> {
  const finishedAt = new Date().toISOString();
  return persistApiCardCronRuntime({
    connectionString,
    organizationId,
    storeId,
    card,
    scheduleForNextRun: schedule,
    patch: {
      last_run_at: finishedAt,
      last_run_status: success ? "success" : "failed",
      last_error: error,
      last_success_at: success ? finishedAt : undefined,
      last_failed_at: success ? undefined : finishedAt,
      next_run_at: computeApiCardNextRun(schedule)?.toISOString() ?? null,
      last_slot_key: slotKey(hourUtc),
    },
  });
}

export async function runScheduledApiCard(args: {
  connectionString: string;
  organizationId: string;
  storeId: string;
  evaluation: ApiCardScheduleEvaluation;
  schedule: ApiAutomationCardSchedule | FinancesArchiveApiSchedule;
  dryRun: boolean;
}): Promise<ApiCardScheduledRunResult> {
  const { connectionString, organizationId, storeId, evaluation, schedule, dryRun } = args;
  const base = {
    card: evaluation.card,
    window: apiCardSyncWindowThroughToday(schedule.rolling_days),
  };

  if (!evaluation.enabled) {
    return { ...base, ok: true, skipped: true, reason: "schedule_disabled" };
  }
  if (!evaluation.schedule.due) {
    return { ...base, ok: true, skipped: true, reason: evaluation.schedule.reason };
  }
  if (dryRun) {
    return {
      ...base,
      ok: true,
      skipped: true,
      reason: "dry_run_would_execute",
    };
  }

  const hourUtc = evaluation.schedule.current_hour_utc;
  await persistRunning(connectionString, organizationId, storeId, evaluation.card, schedule, hourUtc);

  try {
    if (evaluation.card === "reimbursements_api") {
      const disabled = reportsApiDisabledReasonForReimbursements();
      if (disabled || !isAmazonReportsApiReimbursementsEnabled()) {
        const msg = disabled ?? "reimbursements_disabled";
        await persistFinished(connectionString, organizationId, storeId, evaluation.card, schedule, false, msg, hourUtc);
        return { ...base, ok: false, skipped: false, reason: msg, error: msg };
      }
      const result = await runReimbursementsReportsWorker({
        organizationId,
        storeId,
        windowStart: base.window!.start,
        windowEnd: base.window!.end,
        actorUserId: null,
        uploadId: null,
      });
      const success = result.ok && !result.needs_resume;
      await persistFinished(
        connectionString,
        organizationId,
        storeId,
        evaluation.card,
        schedule,
        success,
        success ? null : (result.error ?? result.state ?? "needs_resume_or_failed"),
        hourUtc,
      );
      return {
        ...base,
        ok: result.ok,
        skipped: false,
        reason: success ? "executed" : "worker_incomplete",
        upload_id: result.upload_id,
        source_run_id: result.source_run_id,
        state: result.state,
        needs_resume: result.needs_resume,
        error: result.error,
      };
    }

    if (evaluation.card === "settlement_api") {
      const disabled = reportsApiDisabledReasonForSettlement();
      if (disabled || !isAmazonReportsApiSettlementEnabled()) {
        const msg = disabled ?? "settlement_disabled";
        await persistFinished(connectionString, organizationId, storeId, evaluation.card, schedule, false, msg, hourUtc);
        return { ...base, ok: false, skipped: false, reason: msg, error: msg };
      }
      const result = await runSettlementReportsWorker({
        organizationId,
        storeId,
        windowStart: base.window!.start,
        windowEnd: base.window!.end,
        actorUserId: null,
        uploadId: null,
      });
      const success = result.ok && !result.needs_resume;
      await persistFinished(
        connectionString,
        organizationId,
        storeId,
        evaluation.card,
        schedule,
        success,
        success ? null : (result.error ?? result.state ?? "needs_resume_or_failed"),
        hourUtc,
      );
      return {
        ...base,
        ok: result.ok,
        skipped: false,
        reason: success ? "executed" : "worker_incomplete",
        upload_id: result.upload_id,
        source_run_id: result.source_run_id,
        state: result.state,
        needs_resume: result.needs_resume,
        error: result.error,
      };
    }

    const finDisabled = financesApiDisabledReason();
    if (finDisabled || !isAmazonFinancesApiIngestEnabled()) {
      const msg = finDisabled ?? "finances_ingest_disabled";
      await persistFinished(connectionString, organizationId, storeId, evaluation.card, schedule, false, msg, hourUtc);
      return { ...base, ok: false, skipped: false, reason: msg, error: msg };
    }
    const finSchedule = schedule as FinancesArchiveApiSchedule;
    const result = await runFinancesApiIngestWorker({
      organizationId,
      storeId,
      marketplaceId: finSchedule.marketplace_id,
      windowStart: base.window!.start,
      windowEnd: base.window!.end,
      sourceRunId: null,
    });
    const success = result.ok && !result.needs_resume;
    await persistFinished(
      connectionString,
      organizationId,
      storeId,
      evaluation.card,
      schedule,
      success,
      success ? null : (result.error ?? result.state ?? "needs_resume_or_failed"),
      hourUtc,
    );
    return {
      ...base,
      ok: result.ok,
      skipped: false,
      reason: success ? "executed" : "worker_incomplete",
      source_run_id: result.source_run_id,
      state: result.state,
      needs_resume: result.needs_resume,
      error: result.error,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await persistFinished(connectionString, organizationId, storeId, evaluation.card, schedule, false, msg, hourUtc);
    return { ...base, ok: false, skipped: false, reason: "exception", error: msg };
  }
}
