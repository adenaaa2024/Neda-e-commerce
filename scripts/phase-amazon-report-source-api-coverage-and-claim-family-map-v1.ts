/**
 * PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE-AND-CLAIM-FAMILY-MAP-V1
 *
 * Read-only source/API coverage audit + claim-family data map. Probes the 17
 * claim-relevant sources (composeClaimSourceCoverageV1), prints the
 * source_coverage_matrix / claim_family_map / live_sync_plan, then re-runs the
 * recovery-gap engine over the 10 pilot claims to emit the
 * current_pilot_claim_source_matrix + current_pilot_reimbursement_matching_matrix
 * (incl. files checked + missing files/API per claim).
 *
 * No DB writes. No claim_* mutation. No Amazon. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-amazon-report-source-api-coverage-and-claim-family-map-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { computeRecoveryGap } from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { composeClaimSourceCoverageV1 } from "../lib/claims/center/claim-source-coverage-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const EXPECTED_TOTAL_RECOVERY = 100.72;

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

async function tableCount(client: SupabaseClient, table: string): Promise<number> {
  const { count } = await client.from(table).select("id", { count: "exact", head: true }).eq("organization_id", ORG);
  return count ?? -1;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("=== PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE-AND-CLAIM-FAMILY-MAP-V1 (read-only) ===");

  const before = {
    submissions: await tableCount(client, "claim_submissions"),
    cases: await tableCount(client, "claim_cases"),
    lines: await tableCount(client, "claim_lines"),
    candidates: await tableCount(client, "claim_candidates"),
    edges: await tableCount(client, "claim_reference_edges"),
  };

  // ---- Source coverage matrix ----
  const coverage = await composeClaimSourceCoverageV1(client, ORG);

  console.log(`\n──── SOURCE COVERAGE MATRIX (${coverage.source_coverage_matrix.length} sources) ────`);
  for (const s of coverage.source_coverage_matrix) {
    console.log(
      `  ${s.connection_status.padEnd(14)} ${s.label} [${s.table ?? "—"}] rows=${s.row_count ?? "—"} latest=${
        s.latest_date ? s.latest_date.slice(0, 10) : "—"
      } api=${s.api_endpoint_exists} importer=${s.importer_exists} spapi=${s.live_sp_api_exists} ui=${s.ui_uses_it}`,
    );
  }
  console.log(
    `\n  totals: live_loaded=${coverage.totals.sources_live_loaded} empty=${coverage.totals.sources_loaded_empty} missing/planned=${coverage.totals.sources_missing_or_planned}`,
  );

  check(coverage.source_coverage_matrix.length === 17, `expected 17 audited sources, got ${coverage.source_coverage_matrix.length}`);
  check(
    coverage.source_coverage_matrix.every((s) => typeof s.connection_status === "string"),
    "every source has a connection_status",
  );

  // ---- Claim family map ----
  console.log(`\n──── CLAIM FAMILY MAP (${coverage.claim_family_map.length} families) ────`);
  for (const f of coverage.claim_family_map) {
    console.log(
      `  ${f.support_status.padEnd(12)} ${f.family_key} → tables=[${f.source_tables_required.join(", ")}] pilot=${f.is_pilot_family} inPool=${f.observed_in_claim_candidates}`,
    );
  }
  check(coverage.claim_family_map.length >= 9, `expected >=9 mapped families, got ${coverage.claim_family_map.length}`);
  check(
    coverage.claim_family_map.some((f) => f.family_key === "removal_shipment_missing" && f.is_pilot_family),
    "removal_shipment_missing present & flagged pilot",
  );
  check(
    coverage.claim_family_map.some((f) => f.family_key === "removal_order_discrepancy" && f.is_pilot_family),
    "removal_order_discrepancy present & flagged pilot",
  );

  // ---- Live sync plan ----
  console.log(`\n──── LIVE SYNC PLAN (${coverage.live_sync_plan.length} reports/APIs) ────`);
  for (const p of coverage.live_sync_plan) {
    console.log(`  safe=${p.safe_to_build_now} approval=${p.approval_required} ${p.report_api_name} → ${p.source_table ?? "—"} (${p.current_status})`);
  }
  check(coverage.live_sync_plan.length > 0, "live_sync_plan populated");

  console.log(`\n──── MISSING FILES / TABLES (${coverage.missing_files_or_tables.length}) ────`);
  coverage.missing_files_or_tables.forEach((m) => console.log(`  - ${m}`));
  console.log(`\n──── MISSING API ENDPOINTS (${coverage.missing_api_endpoints.length}) ────`);
  coverage.missing_api_endpoints.forEach((m) => console.log(`  - ${m}`));
  console.log(`\n──── HIGHEST-PRIORITY NEXT BUILDS ────`);
  coverage.highest_priority_next_builds.forEach((b) => console.log(`  - ${b}`));

  // ---- Current pilot claim source + reimbursement matching matrices ----
  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  const allRows = [...payload.ready_rows, ...payload.blocked_rows];
  check(allRows.length === 10, `expected 10 pilot rows, got ${allRows.length}`);

  let confirmedCount = 0;
  let weakCount = 0;
  let unknownCount = 0;
  let totalExpected = 0;
  let totalConfirmed = 0;
  let totalOpen = 0;

  console.log(`\n──── PILOT CLAIM SOURCE + REIMBURSEMENT MATCHING MATRIX (10) ────`);
  for (const row of allRows) {
    const g = computeRecoveryGap(row);
    totalExpected += g.expected_recovery_value ?? 0;
    totalConfirmed += g.confirmed_reimbursed;
    totalOpen += g.open_recovery_gap ?? 0;
    if (g.confirmed_reimbursed > 0) confirmedCount += 1;
    if (g.reimbursement_status === "unknown_unmatched") unknownCount += 1;
    if (g.has_weak_candidates) weakCount += 1;

    console.log(`\n  • ${row.claim_submission_id} · ${row.claim_family} → ${g.reimbursement_status.toUpperCase()} (${g.match_confidence})`);
    console.log(`    expected=$${(g.expected_recovery_value ?? 0).toFixed(2)} confirmed=$${g.confirmed_reimbursed.toFixed(2)} openGap=${g.open_recovery_gap == null ? "Unknown" : `$${g.open_recovery_gap.toFixed(2)}`}`);
    console.log(`    files checked: ${g.files_checked.join(" | ")}`);
    if (g.missing_files_or_api.length > 0) console.log(`    missing to confirm: ${g.missing_files_or_api.join(" | ")}`);
  }

  console.log(`\n──── TOTALS ────`);
  console.log(`  total_expected_recovery=$${totalExpected.toFixed(2)}`);
  console.log(`  total_confirmed_reimbursed=$${totalConfirmed.toFixed(2)}`);
  console.log(`  total_open_gap=$${totalOpen.toFixed(2)}`);
  console.log(`  confirmed=${confirmedCount} weak=${weakCount} unknown=${unknownCount}`);

  check(Math.abs(totalExpected - EXPECTED_TOTAL_RECOVERY) < 0.01, `total expected recovery must be $${EXPECTED_TOTAL_RECOVERY}, got $${totalExpected.toFixed(2)}`);
  check(totalConfirmed === 0, `pilot has no confirmed reimbursement; got $${totalConfirmed.toFixed(2)}`);
  check(unknownCount === 10, `all 10 pilot claims should be unknown_unmatched; got ${unknownCount}`);
  check(Math.abs(totalOpen - EXPECTED_TOTAL_RECOVERY) < 0.01, `total open gap must equal $${EXPECTED_TOTAL_RECOVERY}; got $${totalOpen.toFixed(2)}`);
  check(
    allRows.every((r) => computeRecoveryGap(r).files_checked.length > 0),
    "every pilot claim records the exact files/sources checked",
  );

  // ---- No-write verification ----
  const after = {
    submissions: await tableCount(client, "claim_submissions"),
    cases: await tableCount(client, "claim_cases"),
    lines: await tableCount(client, "claim_lines"),
    candidates: await tableCount(client, "claim_candidates"),
    edges: await tableCount(client, "claim_reference_edges"),
  };
  for (const k of Object.keys(before) as Array<keyof typeof before>) {
    check(before[k] === after[k], `no-write: ${k} changed ${before[k]} → ${after[k]}`);
  }
  console.log(`\n  no-write: subs=${after.submissions} cases=${after.cases} lines=${after.lines} cands=${after.candidates} edges=${after.edges} (unchanged)`);

  console.log(`\n=== ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`SAFE_SOURCE_COVERAGE_AUDIT_COMPLETE=${failures === 0 ? "yes" : "no"}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
