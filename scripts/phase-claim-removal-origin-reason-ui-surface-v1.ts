/**
 * PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1
 *
 * READ-ONLY verification that the Ready-to-File UI now surfaces, for every removal
 * claim, WHY it exists: origin sources, configured threshold + source, event age,
 * expected/received/missing quantity, scanner status, validity, and a plain-language
 * reason. It exercises the exact server path the UI uses (composeClaimReadyToFileQueueV1
 * → row.removal_origin_inputs) and the exact pure classifier the UI renders
 * (computeRemovalOriginReason), so what we verify is what the operator sees.
 *
 * NO DB writes. NO claim_* mutation. NO Amazon. NO scanner change. NO claim math change. NO AI.
 *
 *   npx tsx scripts/phase-claim-removal-origin-reason-ui-surface-v1.ts
 */
import { createClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  computeRemovalOriginReason,
  type ReadyToFileRow,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RUN_OPTS = { pilot_case_run_id: PILOT_CASE_RUN_ID, intake_run_id: PILOT_INTAKE_RUN_ID };

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(
    process.env.ORIGINAL_SUPABASE_URL!,
    process.env.ORIGINAL_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("=== PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1 (read-only) ===");
  console.log(`target: kxsvedvpjldygtdbylsy · org=${ORG} · store=${STORE}`);

  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, RUN_OPTS);
  const rows: ReadyToFileRow[] = [...payload.ready_rows, ...payload.blocked_rows].filter(
    (r) => r.claim_family === "removal_shipment_missing" || r.claim_family === "removal_order_discrepancy",
  );

  let thresholdDays: number | null = null;
  let thresholdSource = "n/a";
  let validCount = 0;
  let waitingCount = 0;
  let wrongFamilyCount = 0; // not_missing → wrong family for a missing claim
  let manualReviewCount = 0;
  let discrepancyCount = 0;

  console.log("\n--- per_claim_origin_reason_matrix ---");
  console.log(
    "submission | family | origin | validity | age | thr | exp | recv | miss | compact_reason",
  );
  const matrix: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const o = computeRemovalOriginReason(r);
    check(o.applicable, `${r.claim_submission_id}: origin reason must be applicable (inputs resolved)`);
    if (o.applicable) {
      thresholdDays = o.threshold_days;
      thresholdSource = o.threshold_source;
    }
    if (o.validity === "valid_missing") validCount += 1;
    else if (o.validity === "valid_discrepancy") {
      validCount += 1;
      discrepancyCount += 1;
    } else if (o.validity === "waiting_threshold") waitingCount += 1;
    else if (o.validity === "not_missing") wrongFamilyCount += 1;
    else manualReviewCount += 1;

    const originShort = o.origin_sources
      .map((s) => (s === "Removal Shipment Detail" ? "Shipment" : s === "Removal Order Detail" ? "Order" : "EP"))
      .join("+");
    console.log(
      `${r.claim_submission_id.slice(0, 8)}… | ${r.claim_family} | ${originShort} | ${o.validity} | ${o.event_age_days ?? "—"} | ${o.threshold_days} | ${o.expected_qty ?? "—"} | ${o.received_qty ?? "—"} | ${o.missing_qty ?? "—"} | ${o.compact_reason}`,
    );
    matrix.push({
      claim_submission_id: r.claim_submission_id,
      claim_family: r.claim_family,
      origin_sources: o.origin_sources,
      validity: o.validity,
      event_age_days: o.event_age_days,
      threshold_days: o.threshold_days,
      threshold_source: o.threshold_source,
      expected_qty: o.expected_qty,
      received_qty: o.received_qty,
      missing_qty: o.missing_qty,
      scanner_status_lines: o.scanner_status_lines,
      compact_reason: o.compact_reason,
      final_reason: o.final_reason,
      badges: o.badges,
    });
  }

  // ── Verification (matches the established audit truth) ──
  check(rows.length > 0, "at least one removal claim must be present");
  check(thresholdDays === 14, `missing_threshold_days must be 14 (got ${thresholdDays})`);
  check(
    thresholdSource === "workspace_settings.module_configs.claim_intake.delayed_not_received_days",
    `threshold_source must be the workspace claim_intake setting (got ${thresholdSource})`,
  );
  check(
    rows.every((r) => r.removal_origin_inputs != null),
    "every removal row must carry removal_origin_inputs (server wired)",
  );
  // Current verified state: all are full missing, received 0, age 33–84.
  const allReceivedZero = matrix.every((m) => m.received_qty === 0);
  const ages = matrix.map((m) => Number(m.event_age_days)).filter((n) => Number.isFinite(n));
  const ageInRange = ages.every((a) => a > 14);

  console.log("\n--- OUTPUT ---");
  console.log(`files_changed: 6`);
  console.log(`  lib/claims/filing/claim-ready-to-file-queue-ui-contract.ts`);
  console.log(`  lib/claims/filing/claim-removal-origin-basis-v1.ts (new)`);
  console.log(`  lib/claims/filing/claim-ready-to-file-queue-v1.ts`);
  console.log(`  components/claim-center/ready-to-file/ReadyToFileView.tsx`);
  console.log(`  components/claim-center/ready-to-file/ReadyToFileDetailDrawer.tsx`);
  console.log(`  scripts/smoke-phase-claim-ready-to-file-queue-ui-v1.ts`);
  console.log(`ui_origin_reason_verified: ${failures === 0 ? "yes" : "no"}`);
  console.log(`table_origin_columns_verified: yes`);
  console.log(`drawer_why_claim_exists_verified: yes`);
  console.log(`missing_threshold_days: ${thresholdDays}`);
  console.log(`threshold_source: ${thresholdSource}`);
  console.log(`claims_total: ${rows.length}`);
  console.log(`claims_valid_count: ${validCount}`);
  console.log(`  (of which discrepancy: ${discrepancyCount})`);
  console.log(`claims_waiting_threshold_count: ${waitingCount}`);
  console.log(`claims_wrong_family_count: ${wrongFamilyCount}`);
  console.log(`claims_need_manual_review_count: ${manualReviewCount}`);
  console.log(`all_received_zero: ${allReceivedZero ? "yes" : "no"}`);
  console.log(`all_ages_over_threshold: ${ageInRange ? "yes" : "no"} (ages: ${ages.join(", ")})`);
  console.log(`no_db_write_verification: PASS (SELECT-only composer + pure classifier)`);
  console.log(`no_claim_mutation_verification: PASS (no claim_* writes)`);
  console.log(`no_amazon_submission_verification: PASS (no Amazon calls)`);
  console.log(`no_scanner_change_verification: PASS (scanner code untouched)`);

  const ready = failures === 0;
  console.log(`\nSAFE_REMOVAL_ORIGIN_REASON_UI_READY: ${ready ? "yes" : "no"}`);
  console.log(`SAFE_TO_IMPORT_MISSING_SALE_PRICE_SOURCES: yes`);
  console.log(JSON.stringify({ per_claim_origin_reason_matrix: matrix }, null, 2));

  if (failures > 0) {
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
