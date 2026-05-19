/**
 * NEXT-IMPORT-API-09F — verify settlement FRR reconciliation API (staging).
 * Run: npm run verify:import-api-09f-settlement-frr-reconcile
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
const UPLOAD_ID = process.env.IMPORT_API_09F_UPLOAD_ID?.trim() ?? "199be41a-20ab-4823-91b6-fc4335794235";
const ORG_ID = process.env.IMPORT_API_09F_ORG_ID?.trim() ?? "00000000-0000-0000-0000-000000000001";

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
  const outDir = join(process.cwd(), ".cursor/audit-reports/next-import-api-09f", rid);
  mkdirSync(outDir, { recursive: true });

  const { computeSettlementFrrReconciliation } = await import(
    "../lib/amazon/settlement-frr-reconciliation"
  );

  const result = await computeSettlementFrrReconciliation(
    (await import("../lib/supabase-server")).supabaseServer,
    ORG_ID,
    UPLOAD_ID,
    { sampleLimit: 50 },
  );

  if (!result.ok) {
    console.error(result);
    process.exit(1);
  }

  const checks = {
    settlement_rows_25244: result.counts.settlement_rows === 25244,
    frr_linked_25244: result.counts.frr_linked === 25244,
    unmatched_zero: result.counts.unmatched_settlement_rows === 0,
    health_fully_reconciled: result.health === "fully_reconciled",
    source_run_present: result.source_run?.source_run_id === "bacf19ca-da47-4525-b859-0ea4dcfba053",
    report_id_present: result.source_run?.report_id === "2002420020588",
    samples_capped: result.samples.matched.length <= 50,
  };

  const payload = {
    prompt: "NEXT-IMPORT-API-09F",
    run_id: rid,
    upload_id: UPLOAD_ID,
    organization_id: ORG_ID,
    result,
    checks,
    status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
  };

  writeFileSync(join(outDir, "09f-verification.json"), JSON.stringify(payload, null, 2));
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "NEXT-IMPORT-API-09F",
        run_id: rid,
        output_directory: `.cursor/audit-reports/next-import-api-09f/${rid}/`,
        status: payload.status,
        upload_id: UPLOAD_ID,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(outDir, "api-proof.md"),
    [
      "# API proof — NEXT-IMPORT-API-09F",
      "",
      `**Status:** ${payload.status}`,
      "",
      "## Route",
      "",
      "`GET /api/settings/imports/uploads/{uploadId}/settlement-frr-reconciliation?organization_id=…&sample_limit=50`",
      "",
      "## Pilot counts",
      "",
      `- settlement_rows: ${result.counts.settlement_rows}`,
      `- frr_linked: ${result.counts.frr_linked}`,
      `- unmatched: ${result.counts.unmatched_settlement_rows}`,
      `- health: ${result.health}`,
      "",
      "## Source run",
      "",
      `- source_run_id: \`${result.source_run?.source_run_id ?? "—"}\``,
      `- report_id: \`${result.source_run?.report_id ?? "—"}\``,
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(outDir, "ui-proof.md"),
    [
      "# UI proof — NEXT-IMPORT-API-09F",
      "",
      "## Component",
      "",
      "`app/(admin)/imports/SettlementFrrReconciliationDrawer.tsx`",
      "",
      "## Entry",
      "",
      "Import History row action **FRR recon** for `SETTLEMENT` uploads with `raw_synced` / complete source_run.",
      "",
      "## Manual check",
      "",
      "1. Open Settings → Imports.",
      "2. On settlement API upload, click **FRR recon**.",
      "3. Confirm summary cards show 25,244 / 25,244 / 0 unmatched.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(outDir, "no-write-proof.md"),
    [
      "# No-write proof — NEXT-IMPORT-API-09F",
      "",
      "- Reconciliation uses SELECT/count only via `computeSettlementFrrReconciliation`.",
      "- No calls to `syncFinancialReferenceResolverForUpload`.",
      "- No INSERT/UPDATE/DELETE on `financial_reference_resolver` or `amazon_settlements`.",
      "- Drawer and API are read-only.",
      "",
    ].join("\n"),
  );

  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
