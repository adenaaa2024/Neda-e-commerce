/**
 * ASYNC IMPORT + LONG JOB ORCHESTRATION FOUNDATION (read-only dryrun)
 *
 *   npx tsx scripts/async-import-job-orchestration-foundation-dryrun.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/async-import-job-orchestration-foundation";
const MIGRATION_PHASE1 = "supabase/migrations/20260529120000_async_job_orchestration_phase1.sql";
const MIGRATION_PHASE2_DRAFT = "supabase/migrations/20260902120000_async_job_orchestration_phase2_draft.sql";

const JOB_TYPES = [
  "product_import",
  "product_enrichment",
  "amazon_fetch",
  "amazon_domain_sync",
  "orchestration",
  "resolver_backfill",
  "claim_generation",
  "image_processing",
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const PHASE2_DRAFT_SQL = `-- =============================================================================
-- ASYNC JOB ORCHESTRATION — PHASE 2 DRAFT (do not apply without approval)
-- Adds dequeue helper + pim_import_sessions bridge + scheduled drain hook target
-- =============================================================================

BEGIN;

ALTER TABLE public.pim_import_sessions
  ADD COLUMN IF NOT EXISTS background_job_id uuid REFERENCES public.background_jobs (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pim_import_sessions_background_job
  ON public.pim_import_sessions (background_job_id)
  WHERE background_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_next_background_job(
  p_worker_id text,
  p_job_types text[] DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.background_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.background_jobs%ROWTYPE;
BEGIN
  PERFORM public.reclaim_stale_background_jobs(interval '30 seconds');

  SELECT * INTO v_job
  FROM public.background_jobs j
  WHERE j.status = 'queued'
    AND (j.scheduled_at IS NULL OR j.scheduled_at <= now())
    AND (p_job_types IS NULL OR j.job_type = ANY (p_job_types))
    AND j.cancel_requested_at IS NULL
  ORDER BY j.priority DESC, j.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.background_jobs
  SET status = 'running',
      locked_at = now(),
      locked_by = p_worker_id,
      lock_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = COALESCE(started_at, now()),
      updated_at = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN NEXT v_job;
END;
$$;

COMMENT ON FUNCTION public.claim_next_background_job IS
  'Cron/worker drain: atomically lease highest-priority queued job.';

GRANT EXECUTE ON FUNCTION public.claim_next_background_job(text, text[], integer) TO service_role;

COMMIT;
`;

async function schemaPreflight(): Promise<Record<string, string>> {
  const checks: Record<string, string> = {};
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) {
    checks.db = "skipped — no STAGING_DIRECT_POSTGRES_URL";
    return checks;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const t of ["background_jobs", "job_steps", "job_locks", "job_events"]) {
      const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
        [t],
      );
      checks[`table.${t}`] = r.rowCount ? "present" : "not_applied";
    }
    const bridge = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'raw_report_uploads' AND column_name = 'background_job_id'`,
    );
    checks["raw_report_uploads.background_job_id"] = bridge.rowCount ? "present" : "not_applied";
  } finally {
    await client.end();
  }
  return checks;
}

function main(): void {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];
  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch");
  }
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch \`${branch}\` !== \`${REQUIRED_BRANCH}\``);
  }

  if (!fs.existsSync(path.join(process.cwd(), MIGRATION_PHASE1))) {
    blockers.push(`Missing ${MIGRATION_PHASE1}`);
  }

  const phase1Sql = fs.readFileSync(path.join(process.cwd(), MIGRATION_PHASE1), "utf8");
  fs.writeFileSync(path.join(outDir, "migration-draft-phase1.sql"), phase1Sql);
  fs.writeFileSync(path.join(process.cwd(), MIGRATION_PHASE2_DRAFT), PHASE2_DRAFT_SQL);
  fs.writeFileSync(path.join(outDir, "migration-draft-phase2.sql"), PHASE2_DRAFT_SQL);

  fs.writeFileSync(
    path.join(outDir, "architecture.md"),
    [
      "# Async import + long job orchestration — architecture",
      "",
      "## Problem (current)",
      "",
      "- Browser refresh or navigation aborts in-flight import ticks",
      "- Progress lives in `raw_report_uploads.metadata` / ad-hoc `pim_import_job` blobs",
      "- No durable cancel, resume, or operator-visible timeline",
      "",
      "## Target control plane",
      "",
      "```mermaid",
      "flowchart TB",
      "  UI[Next.js UI]",
      "  API[POST /api/jobs/*]",
      "  ORCH[lib/jobs/orchestrator.ts]",
      "  DB[(background_jobs + job_steps + job_events)]",
      "  PY[Python FastAPI workers]",
      "  CRON[Vercel Cron / GHA / drain script]",
      "  UI -->|enqueue cancel retry poll| API",
      "  API --> ORCH",
      "  ORCH --> DB",
      "  CRON -->|claim_next + tick| API",
      "  PY -->|tick per step budget| API",
      "  UI -->|Realtime job_events| DB",
      "```",
      "",
      "## Design principles",
      "",
      "1. **Durable state in Postgres** — jobs survive refresh; UI is a viewer/controller",
      "2. **Tick workers** — each HTTP invocation advances one bounded slice (`budget_ms` ≤ Vercel limit)",
      "3. **Idempotency** — `(organization_id, job_type, idempotency_key)` unique on enqueue",
      "4. **Lease + reclaim** — `locked_by` / `lock_expires_at`; `reclaim_stale_background_jobs()`",
      "5. **Cancel cooperative** — `cancel_requested_at` checked at tick boundaries",
      "6. **Resume** — `job_steps.cursor` + `current_step_index` checkpoint",
      "7. **Audit** — append-only `job_events` for logs / failure reason",
      "8. **Priority queue** — `priority` DESC, `created_at` ASC within status=queued",
      "",
      "## Legacy bridge (phase 2+)",
      "",
      "- `pim_import_sessions` ↔ `background_job_id`",
      "- `raw_report_uploads.background_job_id` + `file_processing_status.background_job_id` (phase 1)",
      "- Gradual migration: enqueue job on upload confirm; replace frontend polling loops with `drainJobTicks`",
      "",
      "## Existing code (repo)",
      "",
      "| Layer | Path |",
      "|-------|------|",
      "| DDL phase 1 | `supabase/migrations/20260529120000_async_job_orchestration_phase1.sql` |",
      "| Orchestrator | `lib/jobs/orchestrator.ts` |",
      "| API | `app/api/jobs/{enqueue,tick,cancel,retry}/route.ts` |",
      "| Workers | `lib/jobs/worker-registry.ts` (smoke live; domain skeleton) |",
      "| Removal cron | `scripts/removal-automation-orchestrator.ts` → future `job_type=orchestration` |",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "queue-model.md"),
    [
      "# Queue model",
      "",
      "## Tables",
      "",
      "| Table | Role |",
      "|-------|------|",
      "| `background_jobs` | Job header: status, priority, lease, progress, errors |",
      "| `job_steps` | Ordered steps with `cursor` checkpoint + per-step `budget_ms` |",
      "| `job_locks` | Org-scoped mutex (`resource_key`) for domain sync / rebuild |",
      "| `job_events` | Append-only timeline (progress, errors, cancel, retry) |",
      "",
      "## Status machine (job)",
      "",
      "`queued` → `running` → `completed` | `failed` | `cancelled`",
      "",
      "- **Retry:** reset failed step + job to `queued`, bump `attempt_count`",
      "- **Cancel:** set `cancel_requested_at`; next tick finalizes `cancelled`",
      "- **Stale lease:** `reclaim_stale_background_jobs()` returns job to `queued`",
      "",
      "## Priority",
      "",
      "- `priority` 0–100 (default 50); higher runs first",
      "- Scheduled jobs: `scheduled_at` gate on dequeue",
      "",
      "## Idempotency",
      "",
      "- Unique: `(organization_id, job_type, idempotency_key)`",
      "- Re-enqueue with same key returns existing job (no duplicate work)",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "worker-model.md"),
    [
      "# Worker model",
      "",
      "## Tick contract (`JobWorkerFn`)",
      "",
      "Input: `{ job, step, budgetMs }`",
      "Output: `{ ok, needsTick, stepProgressPct, cursor?, output?, errorCode?, errorDetail? }`",
      "",
      "- `needsTick=true` → same step continues (multi-tick chunk)",
      "- `needsTick=false` + `ok=true` → step completes; orchestrator advances `current_step_index`",
      "",
      "## Deployment matrix",
      "",
      "| Worker kind | Runtime | Notes |",
      "|-------------|---------|-------|",
      "| `product_import` | Python `pim_import_async` via internal tick route | Chunked scan/apply cursors in `step.cursor` |",
      "| `product_enrichment` | Python / Edge | SP-API gated |",
      "| `amazon_fetch` | Python reports worker | Maps to removal fetch scripts |",
      "| `amazon_domain_sync` | TS `import/sync` slices | Uses `job_locks` per upload |",
      "| `resolver_backfill` | TS scripts | Map-only, approval gated |",
      "| `claim_generation` | TS/Python | Claim engine batches |",
      "| `image_processing` | Storage + Edge | Media transforms |",
      "| `smoke_tick` | Node | Phase 1 verification |",
      "",
      "## Vercel constraints",
      "",
      "- `maxDuration` on `/api/jobs/tick` (e.g. 60s Pro)",
      "- Each tick must respect `step.budget_ms` (default 25s)",
      "- Client: poll `tick` while `needsTick` OR subscribe Realtime to `job_events`",
      "- **Do not** hold one serverless function open for full import",
      "",
      "## Python integration",
      "",
      "- FastAPI endpoint: `POST /internal/jobs/tick` (service role) or call Next tick URL",
      "- Long CSV: N ticks × row_chunk from existing `scan_cursor` / `apply_cursor` in metadata",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "cron-orchestrator-integration.md"),
    [
      "# Cron / orchestrator integration",
      "",
      "## Patterns",
      "",
      "1. **Interactive drain** — UI calls `POST /api/jobs/tick` in loop (`drainJobTicks`) until done",
      "2. **Vercel Cron** — `GET /api/jobs/drain?limit=5` (phase 2) claims queued jobs and ticks",
      "3. **GitHub Actions** — same as removal automation: scheduled dry-run or apply with secrets",
      "4. **Removal pipeline** — wrap `removal-automation-orchestrator.ts` as multi-step job:",
      "   - steps: `amazon_fetch` → `amazon_domain_sync` → `verify` → `resolver_backfill`",
      "",
      "## Phase 2 RPC",
      "",
      "`claim_next_background_job(worker_id, job_types[], lease_seconds)` — SKIP LOCKED dequeue",
      "",
      "## Stale recovery",
      "",
      "- Run `reclaim_stale_background_jobs()` before each drain cycle",
      "- Align lease (120s) with Vercel maxDuration + retry",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "ui-contract.md"),
    [
      "# UI capabilities contract",
      "",
      "| Capability | API / data |",
      "|------------|------------|",
      "| Stop/cancel | `POST /api/jobs/cancel` → `cancel_requested_at` |",
      "| Resume | `POST /api/jobs/retry` or re-tick failed job after fix |",
      "| Retry | `retryJob()` resets step + queued |",
      "| Progress % | `background_jobs.progress_pct` + step aggregate |",
      "| Logs | `job_events` ordered by `created_at` |",
      "| Failure reason | `last_error_code` + `last_error_detail` + latest `job_events.error` |",
      "",
      "## Realtime",
      "",
      "Subscribe to `job_events` filtered by `job_id` (small payloads vs full metadata).",
      "",
      "## Migration off frontend loops",
      "",
      "- PIM: replace `preview-step` / `apply-step` polling in `page.tsx` with job enqueue + tick drain",
      "- Imports: `useImportProgress` reads `file_processing_status` **and** `background_job_id` when set",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "job-types-matrix.md"),
    JOB_TYPES.map((t) => `- \`${t}\``).join("\n") + "\n",
  );

  schemaPreflight()
    .then((preflight) => {
      fs.writeFileSync(path.join(outDir, "schema-preflight.json"), JSON.stringify(preflight, null, 2));

      const migrationApplied = preflight["table.background_jobs"] === "present";
      const exactNextPrompt = migrationApplied
        ? "ASYNC-JOB-ORCHESTRATION-PHASE2-WIRE-WORKERS — apply phase2 draft, wire product_import tick to pim_import_async, migrate PIM UI off frontend loops"
        : "ASYNC-JOB-ORCHESTRATION-PHASE1-STAGING-APPLY — apply 20260529120000 on staging + npx tsx scripts/async-job-orchestration-phase1-smoke.ts";

      fs.writeFileSync(
        path.join(outDir, "blockers.md"),
        blockers.length
          ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
          : "- None (dryrun read-only)\n",
      );

      fs.writeFileSync(
        path.join(outDir, "manifest.json"),
        JSON.stringify(
          {
            prompt: "ASYNC-IMPORT-LONG-JOB-ORCHESTRATION-FOUNDATION",
            run_id: runId,
            ok: blockers.length === 0,
            branch,
            staging_ref: STAGING_REF,
            migration_drafted: true,
            migration_phase1_path: MIGRATION_PHASE1,
            migration_phase2_draft_path: MIGRATION_PHASE2_DRAFT,
            migration_applied_on_staging: migrationApplied,
            job_types: JOB_TYPES,
            schema_preflight: preflight,
            exact_next_prompt: exactNextPrompt,
            db_mutated: false,
          },
          null,
          2,
        ),
      );

      console.log(
        JSON.stringify(
          {
            ok: blockers.length === 0,
            outDir,
            migration_drafted: true,
            migration_applied: migrationApplied,
            exact_next_prompt: exactNextPrompt,
          },
          null,
          2,
        ),
      );
      if (blockers.length) process.exit(1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

main();
