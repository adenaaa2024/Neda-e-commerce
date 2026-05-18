/**
 * NEXT-FINANCES-API-ARCHIVE-06B — staging flatten replay benchmark (archived pages only).
 * Run: npm run smoke:finances-api-archive-06b-flatten-benchmark
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire, type Module } from "node:module";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/finances-api-archive-06b-staging-benchmark-approval.md",
);
const ENV_LOCAL = join(process.cwd(), ".env.local");
const STAGING_REF = "kxsvedvpjldygtdbylsy";
const DEFAULT_SOURCE_RUN = "c1b2bd98-ab84-4dc7-a820-c5b8103313ed";
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const PRIOR_FULL_INGEST_WALL_MS = 29 * 60 * 1000;

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
  return /^APPROVED_TO_RUN_FINANCES_API_ARCHIVE_06B_STAGING_BENCHMARK\s*=\s*true\s*$/im.test(
    content,
  );
}

function runId(): string {
  const env = process.env.FINANCES_ARCHIVE_06B_RUN_ID?.trim();
  if (env) return env;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvFile(ENV_LOCAL);
  process.env.ENABLE_AMAZON_FINANCES_API_WORKER = "false";
  process.env.ENABLE_AMAZON_FINANCES_API_INGEST = "false";

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

  const org = process.env.FINANCES_BENCHMARK_ORG_ID?.trim() ?? DEFAULT_ORG;
  const sourceRunId =
    process.env.FINANCES_BENCHMARK_SOURCE_RUN_ID?.trim() ?? DEFAULT_SOURCE_RUN;
  const rid = runId();
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/next-finances-api-archive-06b",
    rid,
  );
  mkdirSync(outDir, { recursive: true });

  const { benchmarkArchiveFlattenReplay } = await import(
    "../lib/amazon/finances-api-ingest-worker"
  );

  console.log(`run_id=${rid}`);
  console.log(`source_run_id=${sourceRunId}`);
  console.log("mode=replay_archived_pages_only (no Amazon HTTP)");

  const result = await benchmarkArchiveFlattenReplay(org, sourceRunId);

  const validation = {
    staging_only: url.includes(STAGING_REF),
    no_live_amazon_http: result.live_amazon === false,
    frr_unchanged: result.frr_before === result.frr_after,
    idempotent_event_count:
      result.events_after_pass1 === result.events_after_pass2,
    events_stable_vs_before:
      result.events_before === result.events_after_pass2 ||
      result.events_after_pass1 === result.events_after_pass2,
    pass1_batches_match_expected_band:
      result.pass1.insertBatches >= 1 && result.pass1.insertBatches <= 50,
    pass2_duplicate_safe:
      result.idempotent_duplicate_safe && result.pass2.insertBatches >= 1,
  };
  const pass = Object.values(validation).every(Boolean);

  const payload = {
    prompt: "NEXT-FINANCES-API-ARCHIVE-06B",
    run_id: rid,
    prior_full_ingest_reference: {
      prompt: "NEXT-FINANCES-API-ARCHIVE-05B-EXECUTE",
      source_run_id: DEFAULT_SOURCE_RUN,
      wall_ms_approx: PRIOR_FULL_INGEST_WALL_MS,
      note: "Prior run included Amazon list_groups + list_events + flatten",
    },
    benchmark: result,
    flatten_only_wall_ms: {
      pass1: result.pass1.wall_ms,
      pass2: result.pass2.wall_ms,
      combined: result.pass1.wall_ms + result.pass2.wall_ms,
    },
    validation,
    status: pass ? "PASS" : "FAIL",
  };

  writeFileSync(join(outDir, "benchmark-results.json"), JSON.stringify(payload, null, 2));
  writeFileSync(join(outDir, "10-validation-checks.json"), JSON.stringify(validation, null, 2));
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "NEXT-FINANCES-API-ARCHIVE-06B",
        run_id: rid,
        output_directory: `.cursor/audit-reports/next-finances-api-archive-06b/${rid}/`,
        status: payload.status,
        replay_mode: "archived_pages_only",
        live_amazon: false,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(outDir, "run-summary.md"),
    [
      "# NEXT-FINANCES-API-ARCHIVE-06B — Staging flatten benchmark",
      "",
      `**Run ID:** ${rid}`,
      `**Status:** ${payload.status}`,
      "",
      "## Mode",
      "- Replay from `amazon_finances_api_pages` only (no Amazon HTTP)",
      `- Source run: \`${sourceRunId}\``,
      "",
      "## Counts",
      `- API pages: ${result.api_page_count}`,
      `- Event groups: ${result.event_group_count}`,
      `- Events (before / after pass1 / after pass2): ${result.events_before} / ${result.events_after_pass1} / ${result.events_after_pass2}`,
      `- Batch size: ${result.batch_size}`,
      "",
      "## Pass 1 (flatten replay)",
      `- Wall clock: **${(result.pass1.wall_ms / 1000).toFixed(1)}s**`,
      `- Event rows attempted: ${result.pass1.eventRowsAttempted}`,
      `- Insert batches: ${result.pass1.insertBatches}`,
      `- Groups processed: ${result.pass1.groupsProcessed}`,
      "",
      "## Pass 2 (idempotency)",
      `- Wall clock: **${(result.pass2.wall_ms / 1000).toFixed(1)}s**`,
      `- Insert batches: ${result.pass2.insertBatches}`,
      `- Duplicate-safe (event count stable): ${result.idempotent_duplicate_safe}`,
      "",
      "## FRR",
      `- Before: ${result.frr_before}`,
      `- After: ${result.frr_after}`,
      `- Unchanged: ${result.frr_before === result.frr_after}`,
      "",
      "## Comparison to prior full ingest (~29 min)",
      `- Flatten-only combined: ${((result.pass1.wall_ms + result.pass2.wall_ms) / 1000).toFixed(1)}s`,
      "",
    ].join("\n"),
  );

  console.log(JSON.stringify(payload, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
