/**
 * NEXT-FINANCES-API-ARCHIVE-05B — live staging Finances archive ingest.
 * Run: npm run smoke:finances-api-archive-05-execute
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire, type Module } from "node:module";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/finances-api-archive-05-staging-smoke-approval.md",
);
const ENV_LOCAL = join(process.cwd(), ".env.local");
const STAGING_REF = "kxsvedvpjldygtdbylsy";
const MAX_RESUME_ROUNDS = 20;
const MAX_WINDOW_DAYS = 7;

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function approvalOk(): boolean {
  if (!existsSync(APPROVAL_PATH)) return false;
  const content = readFileSync(APPROVAL_PATH, "utf8");
  return /^APPROVED_TO_RUN_FINANCES_API_ARCHIVE_05_STAGING_SMOKE\s*=\s*true\s*$/im.test(
    content,
  );
}

function redact(msg: string): string {
  return msg
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt-redacted]")
    .replace(/(refresh[_-]?token|client[_-]?secret|access[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function defaultWindow(): { start: string; end: string } {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 3);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function main(): Promise<void> {
  loadEnvFile(ENV_LOCAL);
  process.env.ENABLE_AMAZON_FINANCES_API_WORKER = "true";
  process.env.ENABLE_AMAZON_FINANCES_API_INGEST = "true";

  if (!approvalOk()) {
    console.error("BLOCKED: approval flag not true.");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes(STAGING_REF)) {
    console.error("BLOCKED: staging Supabase URL missing or wrong project.");
    process.exit(1);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    console.error("BLOCKED: SUPABASE_SERVICE_ROLE_KEY missing.");
    process.exit(1);
  }

  const org =
    process.env.FINANCES_SMOKE_ORG_ID?.trim() ??
    "00000000-0000-0000-0000-000000000001";
  const store =
    process.env.FINANCES_SMOKE_STORE_ID?.trim() ??
    "509ee1f6-622c-46a5-8110-7b889ba46c2c";
  const win = defaultWindow();
  const windowStart = process.env.FINANCES_SMOKE_WINDOW_START?.trim() ?? win.start;
  const windowEnd = process.env.FINANCES_SMOKE_WINDOW_END?.trim() ?? win.end;
  const days =
    (new Date(windowEnd).getTime() - new Date(windowStart).getTime()) / 86400000;
  if (days > MAX_WINDOW_DAYS || days < 0) {
    console.error(`BLOCKED: window ${days.toFixed(1)}d invalid.`);
    process.exit(1);
  }

  const { runFinancesApiIngestWorker } = await import(
    "../lib/amazon/finances-api-ingest-worker"
  );
  const { loadFinancesArchiveRunStatus } = await import(
    "../lib/amazon/finances-api-status-server"
  );

  let sourceRunId: string | null = null;
  let last = await runFinancesApiIngestWorker({
    organizationId: org,
    storeId: store,
    windowStart,
    windowEnd,
  });
  sourceRunId = last.source_run_id;

  let round = 0;
  while (last.needs_resume && round < MAX_RESUME_ROUNDS) {
    round++;
    await new Promise((r) => setTimeout(r, 2000));
    last = await runFinancesApiIngestWorker({
      organizationId: org,
      storeId: store,
      windowStart,
      windowEnd,
      sourceRunId: last.source_run_id ?? sourceRunId,
    });
    sourceRunId = last.source_run_id ?? sourceRunId;
    if (last.state === "complete" || last.state === "failed") break;
  }

  let statusCounts: Record<string, number> | null = null;
  if (sourceRunId) {
    const status = await loadFinancesArchiveRunStatus(org, sourceRunId);
    if (status?.snapshot?.counts) {
      statusCounts = status.snapshot.counts as Record<string, number>;
    }
  }

  const summary = {
    ok: last.ok,
    smoke_status:
      last.ok && last.state === "complete"
        ? "PASS"
        : last.needs_resume
          ? "PARTIAL_NEEDS_RESUME"
          : "FAIL",
    source_run_id: sourceRunId,
    source_run_final_state: last.state,
    needs_resume: last.needs_resume,
    resume_rounds: round,
    ui_status_counts: statusCounts,
    error: last.error ? redact(last.error) : undefined,
    error_code: last.error_code,
    window_start: windowStart,
    window_end: windowEnd,
    organization_id: org,
    store_id: store,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(last.ok && last.state === "complete" ? 0 : 1);
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
