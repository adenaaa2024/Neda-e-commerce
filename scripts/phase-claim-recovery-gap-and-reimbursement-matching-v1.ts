/**
 * PHASE-CLAIM-RECOVERY-GAP-AND-REIMBURSEMENT-MATCHING-V1
 *
 * Read-only recovery-gap + reimbursement-matching audit for the 10 pilot
 * Ready-to-File claims. For each claim, runs the deterministic recovery-gap
 * engine (computeRecoveryGap) over the resolved Event Reference Ledger and emits
 * the per-claim matrix + global totals. Verifies:
 *   - only STRONG (order-linked reimbursement / classified credit) matches count,
 *   - weak FNSKU/date-window candidates never reduce the open gap,
 *   - fees ("FBA Inventory Fee") are never counted as reimbursement,
 *   - total expected recovery still equals $100.72,
 *   - Seller Central requested amount = open_gap when confirmed > 0 else expected,
 *   - no DB writes / mutations.
 *
 * No DB writes. No claim_* mutation. No Amazon. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-claim-recovery-gap-and-reimbursement-matching-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  computeRecoveryGap,
  summarizeRecoveryGap,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
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
  const { count } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  return count ?? -1;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("=== PHASE-CLAIM-RECOVERY-GAP-AND-REIMBURSEMENT-MATCHING-V1 (read-only) ===");

  const before = {
    submissions: await tableCount(client, "claim_submissions"),
    cases: await tableCount(client, "claim_cases"),
    lines: await tableCount(client, "claim_lines"),
    candidates: await tableCount(client, "claim_candidates"),
    edges: await tableCount(client, "claim_reference_edges"),
  };

  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  const allRows = [...payload.ready_rows, ...payload.blocked_rows];
  check(allRows.length === 10, `expected 10 pilot rows, got ${allRows.length}`);

  let strongMatchCount = 0;
  let weakCandidateRows = 0;
  let excludedCandidateCount = 0;
  let requestedLogicOk = true;

  for (const row of allRows) {
    const g = computeRecoveryGap(row);
    const strong = g.strong_reimbursement_matches.length + g.settlement_credit_matches.length;
    strongMatchCount += strong;
    if (g.has_weak_candidates) weakCandidateRows += 1;
    excludedCandidateCount += g.excluded_candidates_and_reason.length;

    console.log(`\n──── ${row.claim_submission_id} · ${row.claim_family} → ${g.reimbursement_status.toUpperCase()} ────`);
    console.log(`  case_id=${row.claim_case_id ?? "—"}`);
    console.log(`  product: fnsku=${row.fnsku ?? "—"} sku=${row.sku ?? "—"} asin=${row.asin ?? "—"}`);
    console.log(`  qty=${row.clean_quantity ?? "—"} cogs/u=${row.approved_cogs_unit ?? "—"} expected=${g.expected_recovery_value ?? "—"}`);
    console.log(`  confirmed_reimbursed=${g.confirmed_reimbursed.toFixed(2)} matched_qty=${g.matched_reimbursement_quantity ?? "—"} open_gap=${g.open_recovery_gap ?? "—"}`);
    console.log(`  match_confidence=${g.match_confidence} requested_amount=${g.recovery_requested_amount ?? "—"}`);
    console.log(`  strong_reimbursement=${g.strong_reimbursement_matches.length} settlement_credit=${g.settlement_credit_matches.length} strong_txn(non-credit)=${g.strong_transaction_matches.length}`);
    console.log(`  weak_reimbursement=${g.weak_reimbursement_candidates.length} weak_txn=${g.weak_transaction_candidates.length} ledger_cand=${g.inventory_ledger_candidates.length}`);
    console.log(`  match_reason: ${g.match_reason}`);
    for (const ex of g.excluded_candidates_and_reason) console.log(`  excluded: ${ex}`);

    // ---- Assertions ----
    // Confirmed amount must equal sum of counted (strong) match amounts, never weak.
    const countedSum =
      g.strong_reimbursement_matches.reduce((s, m) => s + Math.max(m.amount ?? 0, 0), 0) +
      g.settlement_credit_matches.reduce((s, m) => s + Math.max(m.amount ?? 0, 0), 0);
    check(
      Math.abs(g.confirmed_reimbursed - Math.round(countedSum * 100) / 100) < 0.011,
      `${row.claim_submission_id}: confirmed_reimbursed must equal counted strong matches`,
    );
    // Fees must never be counted as a settlement credit.
    for (const m of g.settlement_credit_matches) {
      check(
        !/fee|storage|commission|advertis/i.test(m.reason ?? ""),
        `${row.claim_submission_id}: fee row ${m.reference_id} (${m.reason}) must not be a counted credit`,
      );
    }
    // No confirmed reimbursement → status unknown_unmatched and full open gap.
    if (g.confirmed_reimbursed <= 0) {
      check(
        g.reimbursement_status === "unknown_unmatched" || g.reimbursement_status === "not_reimbursed",
        `${row.claim_submission_id}: zero confirmed → must be unknown_unmatched/not_reimbursed`,
      );
      check(
        g.open_recovery_gap != null && Math.abs((g.open_recovery_gap ?? 0) - (g.expected_recovery_value ?? 0)) < 0.011,
        `${row.claim_submission_id}: zero confirmed → open gap must equal expected recovery`,
      );
    }
    // Seller Central requested amount logic.
    const wantRequested = g.confirmed_reimbursed > 0 ? g.open_recovery_gap : g.expected_recovery_value;
    if ((g.recovery_requested_amount ?? null) !== (wantRequested ?? null)) {
      requestedLogicOk = false;
      check(false, `${row.claim_submission_id}: requested amount logic mismatch`);
    }
    // Recovery value must be COGS-based, never sale price.
    check(!row.uses_sale_price_as_amount, `${row.claim_submission_id}: must not use sale price as claim amount`);
  }

  const summary = summarizeRecoveryGap(allRows);

  const after = {
    submissions: await tableCount(client, "claim_submissions"),
    cases: await tableCount(client, "claim_cases"),
    lines: await tableCount(client, "claim_lines"),
    candidates: await tableCount(client, "claim_candidates"),
    edges: await tableCount(client, "claim_reference_edges"),
  };
  const noWrite =
    before.submissions === after.submissions &&
    before.cases === after.cases &&
    before.lines === after.lines &&
    before.candidates === after.candidates &&
    before.edges === after.edges;
  check(noWrite, `no-write verification failed: ${JSON.stringify({ before, after })}`);

  // Total expected recovery must still be $100.72.
  check(
    Math.abs(summary.total_expected_recovery - EXPECTED_TOTAL_RECOVERY) < 0.011,
    `total expected recovery must equal $${EXPECTED_TOTAL_RECOVERY}, got ${summary.total_expected_recovery}`,
  );
  // confirmed + open gap must reconcile to expected.
  check(
    Math.abs(summary.total_confirmed_reimbursed + summary.total_open_recovery_gap - summary.total_expected_recovery) <
      0.05,
    `confirmed + open gap must reconcile to expected recovery`,
  );

  console.log("\n=== GLOBAL OUTPUT ===");
  console.log(`recovery_gap_engine_built = yes`);
  console.log(`total_claims = ${summary.total_claims}`);
  console.log(`total_expected_recovery = $${summary.total_expected_recovery.toFixed(2)}`);
  console.log(`total_confirmed_reimbursed = $${summary.total_confirmed_reimbursed.toFixed(2)}`);
  console.log(`total_open_recovery_gap = $${summary.total_open_recovery_gap.toFixed(2)}`);
  console.log(
    `reimbursement_status_counts = fully=${summary.fully_reimbursed_count} partial=${summary.partially_reimbursed_count} over=${summary.over_reimbursed_count} not=${summary.not_reimbursed_count} unknown=${summary.unknown_unmatched_count}`,
  );
  console.log(`unreimbursed_claims_count = ${summary.unreimbursed_claims_count}`);
  console.log(`needs_reimbursement_review_count = ${summary.needs_reimbursement_review_count}`);
  console.log(`strong_match_count = ${strongMatchCount}`);
  console.log(`weak_candidate_count = ${weakCandidateRows}`);
  console.log(`excluded_candidate_count = ${excludedCandidateCount}`);
  console.log(`seller_central_requested_amount_logic_verified = ${requestedLogicOk ? "yes" : "no"}`);
  console.log(`no_db_write_verification = ${noWrite ? "PASS" : "FAIL"} (counts ${JSON.stringify(after)})`);
  console.log(
    `\n${failures === 0 ? "PHASE OK — recovery gap engine checks passed" : `PHASE FAILED — ${failures} check(s) failed`}`,
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
