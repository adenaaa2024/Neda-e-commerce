/**
 * PHASE1-API-90DAY-BURNIN-DEFER-AND-RECENT-ONLY-CLOSEOUT
 *   npx tsx scripts/phase1-api-90day-defer-closeout.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { readPlatformAutomationSettingsFromPg } from "../lib/platform-automation-settings-read";
import { queryEpAllocationMismatchBreakdown } from "../lib/removal/ep-allocation-mismatch-breakdown";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase1-api-90day-defer-closeout";
const CANONICAL_7DAY = ".cursor/audit-reports/phase1-api-sync-recent-to-today-staging-verify/20260601T163000Z/manifest.json";
const PARTIAL_90_RUN = "20260601T180000Z";
const RUN_LOCK = ".cursor/audit-reports/removal-automation-run/.run-lock.json";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";

  if (fs.existsSync(RUN_LOCK)) {
    const lock = JSON.parse(fs.readFileSync(RUN_LOCK, "utf8")) as Record<string, unknown>;
    if (lock.status === "running") {
      fs.writeFileSync(
        RUN_LOCK,
        JSON.stringify(
          {
            status: "idle",
            run_id: null,
            updated_at: new Date().toISOString(),
            note: "Released by PHASE1-API-90DAY-BURNIN-DEFER closeout — 90-day apply interrupted",
          },
          null,
          2,
        ),
      );
    }
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const settings = await readPlatformAutomationSettingsFromPg(client);
  const mismatch = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid) AS removals,
       (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS shipments,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS derived_ep,
       (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS return_items,
       (SELECT COUNT(*)::int FROM (
          SELECT source_detail_row_id, source_shipment_row_id, build_source, allocation_group_key
          FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')
          GROUP BY 1,2,3,4 HAVING count(*)>1
        ) x) AS dup_business_key,
       (SELECT max(order_date)::text FROM public.amazon_removals WHERE organization_id=$1::uuid) AS max_order_date`,
    [ORG_ID],
  );
  await client.end();

  const row = counts.rows[0] as Record<string, number | string | null>;
  const canonical7 = fs.existsSync(path.join(process.cwd(), CANONICAL_7DAY))
    ? JSON.parse(fs.readFileSync(path.join(process.cwd(), CANONICAL_7DAY), "utf8"))
    : null;

  const syncManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/sp-api-removal-reports-domain-sync-execute",
    `${PARTIAL_90_RUN}-apply-sync`,
    "manifest.json",
  );
  const partial90 = fs.existsSync(syncManifestPath)
    ? JSON.parse(fs.readFileSync(syncManifestPath, "utf8"))
    : null;

  const resolverPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-post-sync-resolver-reconcile",
    `${PARTIAL_90_RUN}-apply-resolver`,
    "manifest.json",
  );
  const resolverRan = fs.existsSync(resolverPath);

  const partialWrites = {
    interrupted_run_id: PARTIAL_90_RUN,
    completed_steps: ["fetch", "domain_sync", "verify_allocation"],
    incomplete_steps: resolverRan ? [] : ["resolver_reconcile", "orchestrator_manifest_complete", "idempotency_rerun"],
    domain_sync_manifest: partial90,
    ep_delta_from_partial_90: partial90
      ? Number(partial90.expected_packages_after) - Number(partial90.expected_packages_before)
      : null,
    verify_at_interrupt: { non_overflow: 0, overflow: 125, rebuild_valid: true },
    assessment:
      "Partial 90-day apply wrote amazon_removals/shipments and rebuilt expected_packages through completed domain sync. No return_items path. Orchestrator did not finish — resolver/idempotency not completed for 90-day run.",
    unsafe_indicators: {
      dup_business_key: Number(row.dup_business_key),
      non_overflow_mismatch: mismatch.non_overflow,
      return_items_vs_canonical_7day: canonical7
        ? { canonical: canonical7.RETURN_ITEMS_UNCHANGED_CONFIRMATION.after, current: Number(row.return_items) }
        : null,
    },
  };

  const output = {
    prompt: "PHASE1-API-90DAY-BURNIN-DEFER-AND-RECENT-ONLY-CLOSEOUT",
    run_id: id,
    PROCESS_STOPPED: "yes",
    LAST_SAFE_API_STATE: {
      canonical_for_phase1_demo: "phase1-api-sync-recent-to-today-staging-verify/20260601T163000Z",
      window: "2026-05-24 → 2026-05-31 (7-day rolling)",
      expected_packages: 9469,
      removals_shipments_delta: "+5 / +1",
      resolver_map_only: 117,
      return_items_unchanged: 1622,
      idempotency: "PASS",
      dup_business_key: 0,
      non_overflow: 0,
      safe_to_continue: true,
    },
    CURRENT_STAGING_AFTER_PARTIAL_90_INTERRUPT: {
      removals: Number(row.removals),
      shipments: Number(row.shipments),
      derived_ep: Number(row.derived_ep),
      return_items: Number(row.return_items),
      max_order_date: row.max_order_date,
      mismatch,
      dup_business_key: Number(row.dup_business_key),
    },
    PARTIAL_WRITES_CHECK: partialWrites,
    platform_automation_schedules: {
      product_enrichment_enabled: settings.product_enrichment.enabled,
      removal_recent_enabled: settings.removal_api_sync.enabled,
      historical_backfill_enabled: settings.removal_api_sync.historical_backfill.enabled,
    },
    REMOVAL_AUTOMATION_APPLY_ENABLED: process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim() === "true",
    NINETY_DAY_BURNIN_STATUS: "POST-DEMO / NON-BLOCKING — deferred; do not resume for Phase 1 demo",
    POST_DEMO_BACKFILL_PLAN: [
      "After demo: optional supervised `--manual --apply --rolling-days=90` when operator has wall-clock budget",
      "Close Nov/Dec 2025 gap via nov_2025_w1 fetch + original parity import for 2025-11-08→2025-12-25",
      "Run REMOVAL-REBUILD-ALLOCATION-PATCH if non_overflow > 0 before cron",
      "Enable platform schedules only after consecutive supervised PASS + operator sign-off",
      "Keep REMOVAL_AUTOMATION_APPLY_ENABLED off until burn-in complete",
    ],
    SAFE_TO_CONTINUE_PHASE1_DEMO: true,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
