import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  BackgroundJobRow,
  EnqueueJobInput,
  JobStepRow,
  JobType,
} from "./types";

const JOB_TYPES: JobType[] = [
  "product_import",
  "product_enrichment",
  "amazon_fetch",
  "amazon_domain_sync",
  "orchestration",
  "resolver_backfill",
  "claim_generation",
  "image_processing",
];

export function isJobType(v: string): v is JobType {
  return (JOB_TYPES as string[]).includes(v);
}

export async function insertJobEvent(
  client: SupabaseClient,
  args: {
    jobId: string;
    stepId?: string | null;
    eventType: string;
    message: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await client.from("job_events").insert({
    job_id: args.jobId,
    step_id: args.stepId ?? null,
    event_type: args.eventType,
    message: args.message,
    detail: args.detail ?? {},
  });
  if (error) throw new Error(`insertJobEvent: ${error.message}`);
}

export async function fetchJob(client: SupabaseClient, jobId: string): Promise<BackgroundJobRow | null> {
  const { data, error } = await client.from("background_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error) throw new Error(`fetchJob: ${error.message}`);
  return (data as BackgroundJobRow | null) ?? null;
}

export async function fetchJobStep(
  client: SupabaseClient,
  jobId: string,
  stepIndex: number,
): Promise<JobStepRow | null> {
  const { data, error } = await client
    .from("job_steps")
    .select("*")
    .eq("job_id", jobId)
    .eq("step_index", stepIndex)
    .maybeSingle();
  if (error) throw new Error(`fetchJobStep: ${error.message}`);
  return (data as JobStepRow | null) ?? null;
}

export async function fetchJobSteps(client: SupabaseClient, jobId: string): Promise<JobStepRow[]> {
  const { data, error } = await client
    .from("job_steps")
    .select("*")
    .eq("job_id", jobId)
    .order("step_index", { ascending: true });
  if (error) throw new Error(`fetchJobSteps: ${error.message}`);
  return (data ?? []) as JobStepRow[];
}

export async function findExistingJob(
  client: SupabaseClient,
  organizationId: string,
  jobType: JobType,
  idempotencyKey: string,
): Promise<BackgroundJobRow | null> {
  const { data, error } = await client
    .from("background_jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("job_type", jobType)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`findExistingJob: ${error.message}`);
  return (data as BackgroundJobRow | null) ?? null;
}

export async function insertJobWithSteps(
  client: SupabaseClient,
  input: EnqueueJobInput,
  steps: { step_key: string; worker_kind: string; input: Record<string, unknown>; budget_ms: number }[],
): Promise<{ job: BackgroundJobRow; inserted: boolean }> {
  const existing = await findExistingJob(
    client,
    input.organizationId,
    input.jobType,
    input.idempotencyKey,
  );
  if (existing && existing.status !== "completed" && existing.status !== "cancelled") {
    return { job: existing, inserted: false };
  }

  const { data: jobRow, error: jobErr } = await client
    .from("background_jobs")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId ?? null,
      job_type: input.jobType,
      status: "queued",
      priority: input.priority ?? 50,
      idempotency_key: input.idempotencyKey,
      requested_by: input.requestedBy ?? null,
      resource_refs: input.resourceRefs ?? {},
      payload: input.payload ?? {},
      scheduled_at: input.scheduledAt ?? null,
    })
    .select("*")
    .single();

  if (jobErr) {
    if (jobErr.code === "23505") {
      const again = await findExistingJob(
        client,
        input.organizationId,
        input.jobType,
        input.idempotencyKey,
      );
      if (again) return { job: again, inserted: false };
    }
    throw new Error(`insertJobWithSteps: ${jobErr.message}`);
  }

  const job = jobRow as BackgroundJobRow;
  const stepRows = steps.map((s, idx) => ({
    job_id: job.id,
    step_index: idx,
    step_key: s.step_key,
    worker_kind: s.worker_kind,
    input: s.input,
    budget_ms: s.budget_ms,
    status: "pending",
  }));

  const { error: stepsErr } = await client.from("job_steps").insert(stepRows);
  if (stepsErr) throw new Error(`insertJobWithSteps steps: ${stepsErr.message}`);

  await insertJobEvent(client, {
    jobId: job.id,
    eventType: "enqueued",
    message: `Job enqueued (${input.jobType})`,
    detail: { idempotency_key: input.idempotencyKey, step_count: steps.length },
  });

  return { job, inserted: true };
}

export async function updateJob(
  client: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<BackgroundJobRow> {
  const { data, error } = await client
    .from("background_jobs")
    .update(patch)
    .eq("id", jobId)
    .select("*")
    .single();
  if (error) throw new Error(`updateJob: ${error.message}`);
  return data as BackgroundJobRow;
}

export async function updateJobStep(
  client: SupabaseClient,
  stepId: string,
  patch: Record<string, unknown>,
): Promise<JobStepRow> {
  const { data, error } = await client
    .from("job_steps")
    .update(patch)
    .eq("id", stepId)
    .select("*")
    .single();
  if (error) throw new Error(`updateJobStep: ${error.message}`);
  return data as JobStepRow;
}

export async function releaseJobLocks(client: SupabaseClient, jobId: string): Promise<void> {
  const { error } = await client.from("job_locks").delete().eq("job_id", jobId);
  if (error) throw new Error(`releaseJobLocks: ${error.message}`);
}
