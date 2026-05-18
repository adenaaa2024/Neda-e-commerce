/**
 * NEXT-IMPORT-API-09C — repair domain sync for 09A settlement upload (no Amazon HTTP).
 * Run: npm run repair:import-api-09c-settlement-domain
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire, type Module } from "node:module";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const ENV_LOCAL = join(process.cwd(), ".env.local");
const STAGING_REF = "kxsvedvpjldygtdbylsy";
const DEFAULT_UPLOAD = "199be41a-20ab-4823-91b6-fc4335794235";
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvFile(ENV_LOCAL);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes(STAGING_REF)) {
    console.error("BLOCKED: staging Supabase URL required.");
    process.exit(1);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    console.error("BLOCKED: SUPABASE_SERVICE_ROLE_KEY missing.");
    process.exit(1);
  }

  const uploadId = process.env.IMPORT_API_09C_UPLOAD_ID?.trim() ?? DEFAULT_UPLOAD;
  const orgId = process.env.IMPORT_API_09C_ORG_ID?.trim() ?? DEFAULT_ORG;
  const rid = runId();
  const outDir = join(process.cwd(), ".cursor/audit-reports/next-import-api-09c", rid);
  mkdirSync(outDir, { recursive: true });

  const { supabaseServer } = await import("../lib/supabase-server");
  const { assessReportsApiPipelineCompletion } = await import(
    "../lib/amazon/reports-api-pipeline-completion"
  );
  const { parseSourceRun, patchSourceRun } = await import("../lib/amazon/reports-api-source-run");
  const { runReportsApiImportPipeline } = await import("../lib/amazon/reports-api-pipeline-handoff");

  const before = await assessReportsApiPipelineCompletion(
    supabaseServer,
    orgId,
    uploadId,
    "SETTLEMENT",
  );

  const { data: upRow } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", uploadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  const sr = parseSourceRun(upRow?.metadata);
  if (!sr) {
    console.error("No source_run on upload.");
    process.exit(1);
  }

  const repairSr = patchSourceRun(sr, {
    state: before.needs_domain_sync ? "syncing" : "generic",
  });
  const t0 = performance.now();
  const pipe = await runReportsApiImportPipeline({
    uploadId,
    organizationId: orgId,
    sourceRun: repairSr,
    importFullFile: false,
  });
  const wallMs = Math.round(performance.now() - t0);
  const after = await assessReportsApiPipelineCompletion(
    supabaseServer,
    orgId,
    uploadId,
    "SETTLEMENT",
  );

  const { data: upAfter } = await supabaseServer
    .from("raw_report_uploads")
    .select("status, metadata")
    .eq("id", uploadId)
    .maybeSingle();
  const srAfter = parseSourceRun(upAfter?.metadata);

  const { count: frrCount } = await supabaseServer
    .from("financial_reference_resolver")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("source_table", "amazon_settlements");

  const payload = {
    run_id: rid,
    upload_id: uploadId,
    organization_id: orgId,
    repair: {
      ok: pipe.ok,
      state: pipe.state,
      error: pipe.ok ? undefined : pipe.error,
      error_code: pipe.ok ? undefined : pipe.error_code,
      wall_ms: wallMs,
    },
    before,
    after,
    upload_status_after: upAfter?.status ?? null,
    source_run_state_after: srAfter?.state ?? null,
    frr_settlements_rows_org: frrCount ?? 0,
    status: pipe.ok && after.domain_rows > 0 && !after.needs_domain_sync ? "PASS" : "FAIL",
  };

  writeFileSync(join(outDir, "repair-result.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
