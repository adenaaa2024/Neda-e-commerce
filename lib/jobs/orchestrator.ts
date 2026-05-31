import type { SupabaseClient } from "@supabase/supabase-js";

import { assertAsyncJobPhase1Approved } from "./approval";
import {
  fetchJob,
  fetchJobStep,
  fetchJobSteps,
  insertJobEvent,
  insertJobWithSteps,
  releaseJobLocks,
  updateJob,
  updateJobStep,
} from "./repository";
import { assertAsyncJobsStagingOnly } from "./staging-guard";
import type {
  CancelJobResult,
  EnqueueJobInput,
  EnqueueJobResult,
  JobStatus,
  JobType,
  RetryJobResult,
  TickJobResult,
} from "./types";
import { defaultWorkerKindForJobType, dispatchWorkerTick } from "./worker-registry";

const LEASE_MS = 120_000;

function leaseExpiryIso(): string {
  return new Date(Date.now() + LEASE_MS).toISOString();
}

function defaultBudgetMsForJobType(jobType: JobType): number {
  if (jobType === "product_enrichment") return 120_000;
  return 25_000;
}

function buildDefaultSteps(input: EnqueueJobInput) {
  const workerKind = defaultWorkerKindForJobType(input.jobType);
  return [
    {
      step_key: workerKind,
      worker_kind: workerKind,
      input: input.payload ?? {},
      budget_ms: defaultBudgetMsForJobType(input.jobType),
    },
  ];
}

function normalizeSteps(input: EnqueueJobInput) {
  if (input.steps?.length) {
    return input.steps.map((s) => ({
      step_key: s.step_key,
      worker_kind: s.worker_kind,
      input: s.input ?? {},
      budget_ms: s.budget_ms ?? defaultBudgetMsForJobType(input.jobType),
    }));
  }
  return buildDefaultSteps(input);
}

function aggregateProgress(steps: { progress_pct: number; status: string }[]): number {
  if (steps.length === 0) return 0;
  const sum = steps.reduce((acc, s) => acc + (s.status === "completed" ? 100 : s.progress_pct), 0);
  return Math.round(sum / steps.length);
}

export async function enqueueJob(
  client: SupabaseClient,
  input: EnqueueJobInput,
): Promise<EnqueueJobResult> {
  assertAsyncJobPhase1Approved();
  assertAsyncJobsStagingOnly();

  const steps = normalizeSteps(input);
  const { job, inserted } = await insertJobWithSteps(client, input, steps);
  return {
    ok: true,
    jobId: job.id,
    inserted,
    status: job.status,
  };
}

async function finalizeCancelled(
  client: SupabaseClient,
  jobId: string,
  stepId: string | null,
): Promise<TickJobResult> {
  await updateJob(client, jobId, {
    status: "cancelled",
    finished_at: new Date().toISOString(),
    locked_at: null,
    locked_by: null,
    lock_expires_at: null,
  });
  await releaseJobLocks(client, jobId);
  await insertJobEvent(client, {
    jobId,
    stepId,
    eventType: "cancelled",
    message: "Job cancelled",
  });
  const job = await fetchJob(client, jobId);
  return {
    ok: true,
    jobId,
    status: "cancelled",
    progressPct: job?.progress_pct ?? 0,
    needsTick: false,
    currentStepIndex: job?.current_step_index ?? 0,
  };
}

export async function tickJob(
  client: SupabaseClient,
  jobId: string,
  workerInstanceId = "api-tick",
): Promise<TickJobResult> {
  assertAsyncJobPhase1Approved();
  assertAsyncJobsStagingOnly();

  const job = await fetchJob(client, jobId);
  if (!job) {
    return {
      ok: false,
      jobId,
      status: "failed",
      progressPct: 0,
      needsTick: false,
      currentStepIndex: 0,
      errorCode: "job_not_found",
      errorDetail: `Job ${jobId} not found`,
    };
  }

  if (job.status === "completed" || job.status === "cancelled") {
    return {
      ok: true,
      jobId,
      status: job.status,
      progressPct: job.progress_pct,
      needsTick: false,
      currentStepIndex: job.current_step_index,
    };
  }

  if (job.cancel_requested_at) {
    return finalizeCancelled(client, jobId, null);
  }

  if (job.status === "failed") {
    return {
      ok: false,
      jobId,
      status: "failed",
      progressPct: job.progress_pct,
      needsTick: false,
      currentStepIndex: job.current_step_index,
      errorCode: job.last_error_code ?? "failed",
      errorDetail: job.last_error_detail ?? "Job is failed — retry required",
    };
  }

  const step = await fetchJobStep(client, jobId, job.current_step_index);
  if (!step) {
    await updateJob(client, jobId, {
      status: "failed",
      last_error_code: "missing_step",
      last_error_detail: `No step at index ${job.current_step_index}`,
      finished_at: new Date().toISOString(),
    });
    return {
      ok: false,
      jobId,
      status: "failed",
      progressPct: job.progress_pct,
      needsTick: false,
      currentStepIndex: job.current_step_index,
      errorCode: "missing_step",
      errorDetail: `No step at index ${job.current_step_index}`,
    };
  }

  const nowIso = new Date().toISOString();
  await updateJob(client, jobId, {
    status: "running",
    locked_at: nowIso,
    locked_by: workerInstanceId,
    lock_expires_at: leaseExpiryIso(),
    started_at: job.started_at ?? nowIso,
  });
  await updateJobStep(client, step.id, {
    status: "running",
    started_at: step.started_at ?? nowIso,
  });

  await insertJobEvent(client, {
    jobId,
    stepId: step.id,
    eventType: "tick_start",
    message: `Tick step ${step.step_key}`,
    detail: { worker_kind: step.worker_kind, step_index: step.step_index },
  });

  const freshJob = (await fetchJob(client, jobId))!;
  if (freshJob.cancel_requested_at) {
    await updateJobStep(client, step.id, { status: "cancelled", finished_at: nowIso });
    return finalizeCancelled(client, jobId, step.id);
  }

  const tickResult = await dispatchWorkerTick({
    job: freshJob,
    step,
    budgetMs: step.budget_ms,
  });

  const attemptCount = Number(step.attempt?.count ?? 0) + (tickResult.ok ? 0 : 1);

  if (!tickResult.ok) {
    await updateJobStep(client, step.id, {
      status: "failed",
      progress_pct: tickResult.stepProgressPct,
      cursor: tickResult.cursor ?? step.cursor,
      attempt: {
        count: attemptCount,
        last_error_code: tickResult.errorCode,
        last_error_detail: tickResult.errorDetail,
      },
      finished_at: nowIso,
      output: tickResult.output ?? {},
    });
    await updateJob(client, jobId, {
      status: "failed",
      progress_pct: tickResult.stepProgressPct,
      last_error_code: tickResult.errorCode ?? "worker_error",
      last_error_detail: tickResult.errorDetail ?? "Worker tick failed",
      finished_at: nowIso,
      locked_at: null,
      locked_by: null,
      lock_expires_at: null,
    });
    await insertJobEvent(client, {
      jobId,
      stepId: step.id,
      eventType: "error",
      message: tickResult.errorDetail ?? "Worker tick failed",
      detail: { error_code: tickResult.errorCode },
    });
    return {
      ok: false,
      jobId,
      status: "failed",
      progressPct: tickResult.stepProgressPct,
      needsTick: false,
      currentStepIndex: job.current_step_index,
      errorCode: tickResult.errorCode,
      errorDetail: tickResult.errorDetail,
    };
  }

  const stepDone = !tickResult.needsTick;
  await updateJobStep(client, step.id, {
    status: stepDone ? "completed" : "running",
    progress_pct: tickResult.stepProgressPct,
    cursor: tickResult.cursor ?? step.cursor,
    output: tickResult.output ?? {},
    finished_at: stepDone ? nowIso : null,
  });

  const allSteps = await fetchJobSteps(client, jobId);
  const progressPct = aggregateProgress(allSteps);

  if (stepDone) {
    const nextIndex = job.current_step_index + 1;
    const hasNext = allSteps.some((s) => s.step_index === nextIndex);

    if (hasNext) {
      await updateJob(client, jobId, {
        current_step_index: nextIndex,
        progress_pct: progressPct,
        lock_expires_at: leaseExpiryIso(),
      });
      await insertJobEvent(client, {
        jobId,
        stepId: step.id,
        eventType: "tick_end",
        message: `Step ${step.step_key} completed; advancing`,
        detail: { next_step_index: nextIndex },
      });
      return {
        ok: true,
        jobId,
        status: "running",
        progressPct,
        needsTick: true,
        currentStepIndex: nextIndex,
      };
    }

    await updateJob(client, jobId, {
      status: "completed",
      progress_pct: 100,
      result: tickResult.output ?? {},
      finished_at: nowIso,
      locked_at: null,
      locked_by: null,
      lock_expires_at: null,
    });
    await releaseJobLocks(client, jobId);
    await insertJobEvent(client, {
      jobId,
      stepId: step.id,
      eventType: "completed",
      message: "Job completed",
      detail: { progress_pct: 100 },
    });
    return {
      ok: true,
      jobId,
      status: "completed",
      progressPct: 100,
      needsTick: false,
      currentStepIndex: job.current_step_index,
    };
  }

  await updateJob(client, jobId, {
    progress_pct: progressPct,
    lock_expires_at: leaseExpiryIso(),
  });
  await insertJobEvent(client, {
    jobId,
    stepId: step.id,
    eventType: "progress",
    message: `Step ${step.step_key} progress ${tickResult.stepProgressPct}%`,
    detail: { needs_tick: true },
  });

  return {
    ok: true,
    jobId,
    status: "running",
    progressPct,
    needsTick: true,
    currentStepIndex: job.current_step_index,
  };
}

export async function cancelJob(client: SupabaseClient, jobId: string): Promise<CancelJobResult> {
  assertAsyncJobPhase1Approved();
  assertAsyncJobsStagingOnly();

  const job = await fetchJob(client, jobId);
  if (!job) {
    return { ok: false, jobId, status: "failed", error: "job_not_found" };
  }

  if (job.status === "completed" || job.status === "cancelled") {
    return { ok: true, jobId, status: job.status };
  }

  const nowIso = new Date().toISOString();
  await updateJob(client, jobId, { cancel_requested_at: nowIso });
  await insertJobEvent(client, {
    jobId,
    eventType: "cancel_requested",
    message: "Cancel requested",
  });

  if (job.status === "queued") {
    await updateJob(client, jobId, {
      status: "cancelled",
      finished_at: nowIso,
    });
    await insertJobEvent(client, {
      jobId,
      eventType: "cancelled",
      message: "Queued job cancelled immediately",
    });
    return { ok: true, jobId, status: "cancelled" };
  }

  return { ok: true, jobId, status: "running" };
}

export async function retryJob(client: SupabaseClient, jobId: string): Promise<RetryJobResult> {
  assertAsyncJobPhase1Approved();
  assertAsyncJobsStagingOnly();

  const job = await fetchJob(client, jobId);
  if (!job) {
    return { ok: false, jobId, status: "failed", error: "job_not_found" };
  }

  if (job.status !== "failed" && job.status !== "cancelled") {
    return {
      ok: false,
      jobId,
      status: job.status,
      error: `retry only allowed from failed/cancelled (current: ${job.status})`,
    };
  }

  const steps = await fetchJobSteps(client, jobId);
  const failedIndex = steps.find((s) => s.status === "failed" || s.status === "cancelled")?.step_index ?? 0;

  for (const s of steps) {
    if (s.step_index >= failedIndex) {
      await updateJobStep(client, s.id, {
        status: "pending",
        progress_pct: 0,
        cursor: {},
        finished_at: null,
        started_at: null,
      });
    }
  }

  await updateJob(client, jobId, {
    status: "queued",
    current_step_index: failedIndex,
    progress_pct: 0,
    cancel_requested_at: null,
    last_error_code: null,
    last_error_detail: null,
    finished_at: null,
    locked_at: null,
    locked_by: null,
    lock_expires_at: null,
    attempt_count: job.attempt_count + 1,
  });

  await insertJobEvent(client, {
    jobId,
    eventType: "retry",
    message: "Job re-queued for retry",
    detail: { from_step_index: failedIndex },
  });

  return { ok: true, jobId, status: "queued" };
}

export async function drainJobTicks(
  client: SupabaseClient,
  jobId: string,
  maxTicks = 20,
): Promise<{ ok: boolean; finalStatus: JobStatus; ticks: number }> {
  let ticks = 0;
  let result = await tickJob(client, jobId, "drain");
  ticks += 1;
  while (result.needsTick && ticks < maxTicks) {
    result = await tickJob(client, jobId, "drain");
    ticks += 1;
  }
  return { ok: result.ok, finalStatus: result.status, ticks };
}
