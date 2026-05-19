/**
 * NEXT-IMPORT-API-09D — verify Import History badge + counts (staging, no Amazon).
 * Run: npm run verify:import-api-09d-settlement-ui
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire, type Module } from "node:module";

import {
  getStagingProjectRef,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const ENV_LOCAL = join(process.cwd(), ".env.local");
const UPLOAD_ID = process.env.IMPORT_API_09D_UPLOAD_ID?.trim() ?? "199be41a-20ab-4823-91b6-fc4335794235";
const ORG_ID = process.env.IMPORT_API_09D_ORG_ID?.trim() ?? "00000000-0000-0000-0000-000000000001";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!m || process.env[m[1].trim()] !== undefined) continue;
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvFile(ENV_LOCAL);
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!supabaseUrlMatchesStagingRef(url, stagingRef) || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    console.error(`BLOCKED: staging env required (${stagingRef}).`);
    process.exit(1);
  }

  const rid = runId();
  const outDir = join(process.cwd(), ".cursor/audit-reports/next-import-api-09d", rid);
  mkdirSync(outDir, { recursive: true });

  const { supabaseServer } = await import("../lib/supabase-server");
  const { buildImportHistorySourceRunView } = await import("../lib/amazon/import-history-source-run");
  const { assessReportsApiPipelineCompletion } = await import(
    "../lib/amazon/reports-api-pipeline-completion"
  );
  const { requiresPhase4Generic, resolveAmazonImportSyncKind } = await import(
    "../lib/pipeline/amazon-report-registry"
  );

  const { data: row, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id, organization_id, file_name, report_type, status, metadata, created_at")
    .eq("id", UPLOAD_ID)
    .eq("organization_id", ORG_ID)
    .maybeSingle();
  if (error || !row) {
    console.error(error?.message ?? "upload not found");
    process.exit(1);
  }

  const view = buildImportHistorySourceRunView(
    row as Parameters<typeof buildImportHistorySourceRunView>[0],
  );
  const completion = await assessReportsApiPipelineCompletion(
    supabaseServer,
    ORG_ID,
    UPLOAD_ID,
    String(row.report_type ?? "SETTLEMENT"),
  );

  const kind = resolveAmazonImportSyncKind(row.report_type);
  const frrAutomatic = requiresPhase4Generic(kind);

  const meta = row.metadata as unknown as Record<string, unknown> | null;
  const sr =
    meta?.source_run && typeof meta.source_run === "object"
      ? (meta.source_run as unknown as Record<string, unknown>)
      : null;

  let frrForUpload = 0;
  const SID_PAGE = 1000;
  const IN_CHUNK = 200;
  let lastSid: string | null = null;
  for (;;) {
    let sidQ = supabaseServer
      .from("amazon_settlements")
      .select("id")
      .eq("organization_id", ORG_ID)
      .eq("upload_id", UPLOAD_ID)
      .order("id", { ascending: true })
      .limit(SID_PAGE);
    if (lastSid) sidQ = sidQ.gt("id", lastSid);
    const { data: sidPage, error: sidErr } = await sidQ;
    if (sidErr) throw new Error(sidErr.message);
    const ids = (sidPage ?? []).map((r) => String((r as { id: string }).id)).filter(Boolean);
    if (ids.length === 0) break;
    lastSid = ids[ids.length - 1] ?? lastSid;
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const part = ids.slice(i, i + IN_CHUNK);
      const { count } = await supabaseServer
        .from("financial_reference_resolver")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG_ID)
        .eq("source_table", "amazon_settlements")
        .in("source_row_id", part);
      frrForUpload += count ?? 0;
    }
    if (ids.length < SID_PAGE) break;
  }

  const checks = {
    import_history_badge: view.badgeLabel === "Settlement · Complete",
    badge_tone_success: view.badgeTone === "success",
    source_run_linked: sr?.source_run_id === "bacf19ca-da47-4525-b859-0ea4dcfba053",
    source_run_complete: sr?.state === "complete",
    upload_raw_synced: row.status === "raw_synced",
    settlements_25244: completion.domain_rows === 25244,
    staging_cleared: completion.staging_rows === 0,
    frr_matches_domain: frrForUpload === completion.domain_rows && completion.domain_rows === 25244,
    domain_complete: completion.domain_complete,
    frr_phase_automatic: frrAutomatic === true,
  };

  const { count: frrOrgSettlements } = await supabaseServer
    .from("financial_reference_resolver")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG_ID)
    .eq("source_table", "amazon_settlements");

  const payload = {
    prompt: "NEXT-IMPORT-API-09D",
    run_id: rid,
    upload_id: UPLOAD_ID,
    organization_id: ORG_ID,
    import_history: {
      badgeLabel: view.badgeLabel,
      badgeTone: view.badgeTone,
      origin: view.origin,
      showSourceRunBadge: view.showSourceRunBadge,
    },
    linkage: {
      source_run_id: sr?.source_run_id ?? null,
      source_run_state: sr?.state ?? null,
      report_id: (sr?.external_ids as { report_id?: string } | undefined)?.report_id ?? null,
      upload_source: meta?.source ?? null,
    },
    counts: {
      amazon_settlements: completion.domain_rows,
      amazon_staging_remaining: completion.staging_rows,
      frr_for_upload: frrForUpload,
      frr_org_settlements_table_total: frrOrgSettlements ?? 0,
    },
    completion,
    checks,
    status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
  };

  writeFileSync(join(outDir, "09d-verification.json"), JSON.stringify(payload, null, 2));
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify({
    prompt: "NEXT-IMPORT-API-09D",
    run_id: rid,
    output_directory: `.cursor/audit-reports/next-import-api-09d/${rid}/`,
    status: payload.status,
    prior_prompt: "NEXT-IMPORT-API-09C",
    upload_id: UPLOAD_ID,
  }, null, 2));

  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
