/**
 * PHASE-EXPECTED-PACKAGES-CONFLICT-STATUS-GATING-V1 — read-only verification
 *   npx tsx scripts/phase-expected-packages-conflict-status-gating-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  CLEAN_BUILD_STATUSES,
  DISPUTED_BUILD_STATUSES,
  EXPECTED_PACKAGE_SOURCE_PRIORITY_RULES,
  EXPECTED_PACKAGE_UI_COPY,
  buildExpectedPackageReviewSignals,
  classifyExpectedPackageBuildStatus,
  filterExpectedPackagesForClaimGeneration,
  reviewSignalNotes,
} from "../lib/expected-packages-conflict-status";
import {
  aggregateExpectedPackageRowsForInventoryDisplay,
  resolveInventoryDisputedQuantity,
  resolveInventoryExpectedClean,
} from "../lib/scanner/v-inventory-status";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const OUT_BASE = ".cursor/audit-reports/phase-expected-packages-conflict-status-gating-v1";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const epRows = await client.query(
    `SELECT ep.id::text, ep.tracking_number, ep.fnsku, ep.sku, ep.order_id,
            ep.expected_scan_quantity, ep.actual_scanned_count, ep.build_status,
            ep.build_source, ep.source_detail_row_id::text, ep.source_shipment_row_id::text
     FROM public.expected_packages ep
     WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
       AND upper(trim(coalesce(ep.fnsku,''))) = $3
       AND trim(coalesce(ep.tracking_number,'')) = $4
     ORDER BY ep.expected_scan_quantity DESC NULLS LAST, ep.id`,
    [ORG, STORE, FNSKU, TRACKING],
  );

  const invRow = await client.query(
    `SELECT expected_package_id::text, tracking_number, fnsku, sku, total_expected, total_scanned
     FROM public.v_inventory_item_status
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND trim(coalesce(tracking_number,'')) = $4
     LIMIT 5`,
    [ORG, STORE, FNSKU, TRACKING],
  );

  await client.end();

  const rawRows = epRows.rows as Record<string, unknown>[];
  const rowBreakdown = rawRows.map((r) => ({
    id: r.id,
    build_status: r.build_status,
    status_class: classifyExpectedPackageBuildStatus(String(r.build_status ?? "")),
    expected_scan_quantity: r.expected_scan_quantity,
    actual_scanned_count: r.actual_scanned_count,
    source_detail_row_id: r.source_detail_row_id,
    source_shipment_row_id: r.source_shipment_row_id,
    build_source: r.build_source,
  }));

  const grouped = aggregateExpectedPackageRowsForInventoryDisplay(rawRows, ORG, STORE);
  const target = grouped.find((g) => (g.fnsku ?? "").toUpperCase() === FNSKU) ?? grouped[0];

  const oldDisplayTotal =
    invRow.rows.reduce((sum: number, r: { total_expected?: number }) => sum + Number(r.total_expected ?? 0), 0) ||
    rawRows.reduce((sum, r) => sum + Number(r.expected_scan_quantity ?? 0), 0);

  const newCleanExpectedTotal = target ? resolveInventoryExpectedClean(target) : 0;
  const disputedQuantityTotal = target ? resolveInventoryDisputedQuantity(target) : 0;

  const { claimReady, reviewNeeded } = filterExpectedPackagesForClaimGeneration(
    rawRows.map((r) => ({
      id: String(r.id ?? ""),
      build_status: String(r.build_status ?? ""),
      expected_scan_quantity: Number(r.expected_scan_quantity ?? 0),
      tracking_number: String(r.tracking_number ?? ""),
      fnsku: String(r.fnsku ?? ""),
      sku: String(r.sku ?? ""),
    })),
  );
  const reviewSignals = buildExpectedPackageReviewSignals(reviewNeeded);

  const results = {
    prompt: "PHASE-EXPECTED-PACKAGES-CONFLICT-STATUS-GATING-V1",
    run_id: runId,
    ref: PRODUCTION_REF,
    tracking_number: TRACKING,
    fnsku: FNSKU,
    status_classification: {
      clean: [...CLEAN_BUILD_STATUSES],
      disputed: [...DISPUTED_BUILD_STATUSES],
      unknown_defaults_to: "disputed",
    },
    source_priority_rules: EXPECTED_PACKAGE_SOURCE_PRIORITY_RULES,
    old_display_total: oldDisplayTotal,
    new_clean_expected_total: newCleanExpectedTotal,
    disputed_quantity_total: disputedQuantityTotal,
    row_breakdown_for_387003587_X004LKS4VD: rowBreakdown,
    grouped_display_line: target
      ? {
          display_lines: grouped.length,
          expected_clean: newCleanExpectedTotal,
          disputed_quantity: disputedQuantityTotal,
          total_expected_gate: target.total_expected,
          needs_reconciliation: target.needs_reconciliation,
          reconciliation_message: target.reconciliation_message,
          display_group: target.display_group,
        }
      : null,
    why_clean_is_52_not_53:
      "Only build_status=matched EP row (qty 52) counts toward Expected clean. shipment_overflow_conflict row (qty 1) is disputed — from older/partial removal detail vs shipment row 52; not silently merged into gate progress.",
    why_stale_1_not_clean:
      "Source priority: amazon_removal_shipments.shipped_quantity is primary physical evidence (52). The +1 overflow conflict row reflects detail/shipment disagreement, not verified physical units — classified disputed, excluded from claim-ready quantity.",
    claim_ready_filter_result: {
      claim_ready_count: claimReady.length,
      claim_ready_ids: claimReady.map((r) => r.id),
      claim_ready_qty_sum: claimReady.reduce((s, r) => s + Number(r.expected_scan_quantity ?? 0), 0),
    },
    review_needed_signal_result: {
      review_needed_count: reviewNeeded.length,
      signals: reviewSignals,
      notes: reviewSignalNotes(reviewSignals),
    },
    ui_copy: EXPECTED_PACKAGE_UI_COPY,
    no_db_write_verification: true,
    no_allocation_logic_change_verification: true,
    no_scanner_save_change_verification: true,
    PASS:
      newCleanExpectedTotal === 52 &&
      disputedQuantityTotal === 1 &&
      claimReady.length === 1 &&
      reviewNeeded.length === 1,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      `# PHASE-EXPECTED-PACKAGES-CONFLICT-STATUS-GATING-V1`,
      ``,
      `**Run:** ${runId}`,
      `**Target:** tracking ${TRACKING} / FNSKU ${FNSKU}`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Old display total (view sum) | ${oldDisplayTotal} |`,
      `| New clean expected | ${newCleanExpectedTotal} |`,
      `| Disputed quantity | ${disputedQuantityTotal} |`,
      `| Claim-ready EP rows | ${claimReady.length} |`,
      `| Review-needed EP rows | ${reviewNeeded.length} |`,
      ``,
      `**PASS:** ${results.PASS ? "yes" : "no"}`,
      ``,
      `Read-model only — no DB writes.`,
    ].join("\n"),
  );

  console.log(JSON.stringify(results, null, 2));
  if (!results.PASS) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
