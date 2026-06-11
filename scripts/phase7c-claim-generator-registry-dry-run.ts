/**
 * PHASE-7C-CLAIM-GENERATOR-REGISTRY-DRY-RUN — manual run CLI (staging only).
 *
 * Default is DRY-RUN: no writes. Apply mode requires --apply.
 *
 *   npx tsx scripts/phase7c-claim-generator-registry-dry-run.ts                       # dry-run, all enabled sources
 *   npx tsx scripts/phase7c-claim-generator-registry-dry-run.ts --sources=reimbursement,settlement
 *   npx tsx scripts/phase7c-claim-generator-registry-dry-run.ts --from=2026-01-01 --to=2026-06-10
 *   npx tsx scripts/phase7c-claim-generator-registry-dry-run.ts --org=<uuid> --limit=200
 *   npx tsx scripts/phase7c-claim-generator-registry-dry-run.ts --apply               # writes candidates
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  listRegisteredClaimGenerators,
  runClaimIntake,
} from "../lib/claims/intake/claim-generator-registry";
import {
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "../lib/claims/intake/claim-intake-settings";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase7c-claim-generator-registry";
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=").trim() || null : null;
}

function runStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF) {
    throw new Error(`Refusing to run: expected staging ref ${STAGING_REF}. Production runs are not allowed here.`);
  }

  const apply = process.argv.includes("--apply");
  const organizationId = arg("org") ?? DEFAULT_ORG;
  const storeId = arg("store");
  const sourcesRaw = arg("sources");
  const sources = sourcesRaw ? sourcesRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const from = arg("from");
  const to = arg("to");
  const limitRaw = arg("limit");
  const rowLimit = limitRaw ? Math.max(1, Math.floor(Number(limitRaw))) : null;

  const client = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });

  const { settings, sources_read } = await loadClaimIntakeSettings(client, organizationId);
  const window = resolveClaimIntakeWindow(settings, from, to);

  const summary = await runClaimIntake({
    client,
    organizationId,
    storeId,
    sources,
    from,
    to,
    apply,
    rowLimit,
  });

  const stamp = runStamp();
  const outDir = path.join(process.cwd(), OUT_BASE, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const report = {
    audit: "PHASE-7C-CLAIM-GENERATOR-REGISTRY",
    stamp,
    staging_ref: STAGING_REF,
    mode: summary.mode,
    organization_id: summary.organization_id,
    store_id: summary.store_id,
    settings_read: sources_read,
    effective_settings: {
      enabled_sources: settings.enabled_sources,
      rolling_window_days: settings.rolling_window_days,
      date_from: settings.date_from,
      date_to: settings.date_to,
      excluded_source_tables: settings.excluded_source_tables,
      schedule_frequency: settings.schedule_frequency,
      manual_run_enabled: settings.manual_run_enabled,
      per_run_row_limit: settings.per_run_row_limit,
      delayed_not_received_days: settings.delayed_not_received_days,
    },
    window,
    requested_sources: summary.requested_sources,
    registered_generators: listRegisteredClaimGenerators(),
    results: summary.results,
    totals: summary.totals,
  };

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  const compact = {
    mode: summary.mode,
    run_id: summary.run_id,
    window: summary.window,
    requested_sources: summary.requested_sources,
    counts: Object.fromEntries(
      summary.results.map((r) => [
        r.source_kind,
        {
          ran: r.ran,
          skip_reason: r.skip_reason,
          matched: r.matched_count,
          drafts: r.drafts_generated,
          legacy_overlap: r.legacy_overlap_count,
          apply: r.apply,
          error: r.error,
        },
      ]),
    ),
    totals: summary.totals,
    report_file: path.join(OUT_BASE, stamp, "report.json"),
  };
  console.log(JSON.stringify(compact, null, 2));

  const anyError = summary.results.some((r) => r.error);
  process.exit(anyError ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
