export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export type JobType =
  | "product_import"
  | "product_enrichment"
  | "amazon_fetch"
  | "amazon_domain_sync"
  | "orchestration"
  | "resolver_backfill"
  | "claim_generation"
  | "image_processing";

export type BackgroundJobRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  job_type: JobType;
  status: JobStatus;
  priority: number;
  idempotency_key: string;
  requested_by: string | null;
  cancel_requested_at: string | null;
  progress_pct: number;
  current_step_index: number;
  resource_refs: Record<string, unknown>;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  last_error_code: string | null;
  last_error_detail: string | null;
  attempt_count: number;
  max_attempts: number;
  locked_at: string | null;
  locked_by: string | null;
  lock_expires_at: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type JobStepRow = {
  id: string;
  job_id: string;
  step_index: number;
  step_key: string;
  status: StepStatus;
  progress_pct: number;
  cursor: Record<string, unknown>;
  attempt: { count?: number; last_error_code?: string; last_error_detail?: string };
  budget_ms: number;
  worker_kind: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EnqueueStepInput = {
  step_key: string;
  worker_kind: string;
  input?: Record<string, unknown>;
  budget_ms?: number;
};

export type EnqueueJobInput = {
  organizationId: string;
  storeId?: string | null;
  jobType: JobType;
  idempotencyKey: string;
  priority?: number;
  requestedBy?: string | null;
  payload?: Record<string, unknown>;
  resourceRefs?: Record<string, unknown>;
  steps?: EnqueueStepInput[];
  scheduledAt?: string | null;
};

export type JobTickInput = {
  job: BackgroundJobRow;
  step: JobStepRow;
  budgetMs: number;
};

export type JobTickResult = {
  ok: boolean;
  needsTick: boolean;
  stepProgressPct: number;
  cursor?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorCode?: string;
  errorDetail?: string;
};

export type JobWorkerFn = (input: JobTickInput) => Promise<JobTickResult>;

export type TickJobResult = {
  ok: boolean;
  jobId: string;
  status: JobStatus;
  progressPct: number;
  needsTick: boolean;
  currentStepIndex: number;
  errorCode?: string;
  errorDetail?: string;
};

export type EnqueueJobResult = {
  ok: boolean;
  jobId: string;
  inserted: boolean;
  status: JobStatus;
  error?: string;
};

export type CancelJobResult = {
  ok: boolean;
  jobId: string;
  status: JobStatus;
  error?: string;
};

export type RetryJobResult = {
  ok: boolean;
  jobId: string;
  status: JobStatus;
  error?: string;
};
