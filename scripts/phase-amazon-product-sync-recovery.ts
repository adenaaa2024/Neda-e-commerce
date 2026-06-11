/**
 * PHASE-AMAZON-PRODUCT-SYNC-RECOVERY
 *
 *   npx tsx scripts/phase-amazon-product-sync-recovery.ts
 *   npx tsx scripts/phase-amazon-product-sync-recovery.ts --apply
 *   npx tsx scripts/phase-amazon-product-sync-recovery.ts --apply --promote-limit=25 --enrich-batches=2
 */
import { createRequire, type Module } from "node:module";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  auditAmazonProductSyncHealth,
  runAmazonProductSyncCatchUp,
} from "../lib/amazon-product-sync-recovery";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const ORG = process.env.AUDIT_ORG_ID ?? "00000000-0000-0000-0000-000000000001";
const STORE = process.env.AUDIT_STORE_ID ?? "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-product-sync-recovery";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function numArg(name: string, fallback: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return fallback;
  const n = Number(a.split("=")[1]);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const apply = process.argv.includes("--apply");
  const run_id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run_id);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingRef = getStagingProjectRef();
  const url = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";

  if (!supabaseUrlMatchesStagingRef(url, stagingRef)) {
    throw new Error(`Supabase URL must target staging ref ${stagingRef}`);
  }
  if (!dbUrl || !key) {
    throw new Error("STAGING_DIRECT_POSTGRES_URL and service role key required");
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query(`SET statement_timeout = '300s'`);

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  let result;
  if (apply) {
    result = await runAmazonProductSyncCatchUp({
      pgClient,
      supabase,
      organizationId: ORG,
      storeId: STORE,
      runId: run_id,
      apply: true,
      promoteLimit: numArg("promote-limit", 50),
      enrichBatches: numArg("enrich-batches", 1),
      enrichStartIndex: numArg("enrich-start-index", 0),
    });
  } else {
    const report = await auditAmazonProductSyncHealth({
      pgClient,
      supabase,
      organizationId: ORG,
      storeId: STORE,
      runId: run_id,
      projectRef: stagingRef,
    });
    result = {
      ok: true,
      mode: "dry_run" as const,
      promoted: { attempted: report.products_missing, created: 0, skipped: 0, failed: 0 },
      enriched: { batches: 0, metrics: {}, continuation: null, failures: 0 },
      report,
    };
  }

  await pgClient.end();

  const summary = {
    last_successful_sync: result.report.last_successful_sync,
    products_missing: result.report.products_missing,
    products_stale: result.report.products_stale,
    image_sync_failures: result.report.image_sync_failures,
    scheduler_status: result.report.scheduler_status,
    auto_create_status: result.report.auto_create_status,
    SAFE_FOR_ORIGINAL: result.report.SAFE_FOR_ORIGINAL,
    mode: result.mode,
    promoted: result.promoted,
    enriched: result.enriched,
    root_cause_summary: result.report.root_cause_summary,
    api_connectivity: result.report.api_connectivity,
  };

  fs.writeFileSync(path.join(outDir, "recovery-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "recovery-report.json"), JSON.stringify(result.report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-AMAZON-PRODUCT-SYNC-RECOVERY",
        run_id,
        mode: result.mode,
        ok: result.ok,
        status: result.ok ? "PASS" : "BLOCKED",
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "recovery-summary.md"),
    `# Amazon product sync recovery

| Field | Value |
|-------|-------|
| last_successful_sync | ${summary.last_successful_sync ?? "null"} |
| products_missing | ${summary.products_missing} |
| products_stale | ${summary.products_stale} |
| image_sync_failures.total | ${summary.image_sync_failures.total} |
| scheduler enabled | ${summary.scheduler_status.enabled} |
| auto_create env | ${summary.auto_create_status.env_flag_enabled} |
| SAFE_FOR_ORIGINAL | ${summary.SAFE_FOR_ORIGINAL} |
| mode | ${summary.mode} |

## Root cause
${summary.root_cause_summary.map((x) => `- ${x}`).join("\n")}
`,
  );

  console.log(JSON.stringify(summary, null, 2));
  if (!result.ok) {
    throw new Error(result.error ?? "catch_up_failed");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
