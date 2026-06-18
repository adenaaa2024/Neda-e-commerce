/**
 * PHASE-CLAIM-FAMILY-AWARE-RECOVERY-MATCHING-V2
 *
 * Read-only architecture correction + deterministic matching upgrade. Prints:
 *   - claim_family_policy_matrix (CLAIM_AMOUNT_POLICY_MATRIX)
 *   - current_vs_alternative_amount_basis_matrix
 *   - per_claim_family_aware_recovery_matrix (10 pilot claims)
 *   - misclassified_candidate_matrix
 *   - separate_claim_candidate_suggestions
 *   - source_api_coverage_matrix + missing_live_sources
 * then verifies no DB writes, no claim_* mutation.
 *
 * No DB writes. No claim_* mutation. No Amazon. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-claim-family-aware-recovery-matching-v2.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  CLAIM_AMOUNT_POLICY_MATRIX,
  computeFamilyAwareRecovery,
  summarizeFamilyAwareRecovery,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
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

function fmt(v: number | null): string {
  return v == null ? "—" : `$${v.toFixed(2)}`;
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

  console.log("=== PHASE-CLAIM-FAMILY-AWARE-RECOVERY-MATCHING-V2 (read-only) ===");

  const before = {
    submissions: await tableCount(client, "claim_submissions"),
    cases: await tableCount(client, "claim_cases"),
    lines: await tableCount(client, "claim_lines"),
    candidates: await tableCount(client, "claim_candidates"),
    edges: await tableCount(client, "claim_reference_edges"),
  };

  // ---- 1. Claim family policy matrix ----
  const policies = Object.values(CLAIM_AMOUNT_POLICY_MATRIX);
  console.log(`\n──── CLAIM FAMILY POLICY MATRIX (${policies.length} families) ────`);
  for (const p of policies) {
    console.log(
      `  ${p.policy_resolved ? "resolved " : "NEEDS-CONF"} ${p.family_key.padEnd(32)} basis=${p.default_claim_amount_basis} kind=${p.amount_kind} salePrice=${p.sale_price_allowed} fees=${p.amazon_fees_included} handling=${p.inbound_removal_handling_included}`,
    );
  }
  check(policies.length >= 16, `expected >=16 families, got ${policies.length}`);
  check(
    CLAIM_AMOUNT_POLICY_MATRIX.removal_shipment_missing.default_claim_amount_basis === "cogs_recovery",
    "removal_shipment_missing default basis must be cogs_recovery",
  );
  check(
    CLAIM_AMOUNT_POLICY_MATRIX.removal_shipment_missing.policy_resolved === false,
    "removal_shipment_missing must be needs-policy-confirmation (COGS vs sale-net not confirmed)",
  );
  check(
    CLAIM_AMOUNT_POLICY_MATRIX.fulfillment_fee_overcharge.default_claim_amount_basis === "fee_delta",
    "fulfillment_fee_overcharge basis must be fee_delta",
  );
  check(
    CLAIM_AMOUNT_POLICY_MATRIX.reimbursement_reversal.default_claim_amount_basis === "reimbursement_reinstatement",
    "reimbursement_reversal basis must be reimbursement_reinstatement",
  );

  // ---- 2/3/4. Pilot claims: per-claim family-aware recovery + amount basis ----
  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  const allRows = [...payload.ready_rows, ...payload.blocked_rows];
  check(allRows.length === 10, `expected 10 pilot rows, got ${allRows.length}`);

  console.log(`\n──── PER-CLAIM FAMILY-AWARE RECOVERY MATRIX (10) ────`);
  let totalMisclassified = 0;
  let totalSeparate = 0;
  for (const row of allRows) {
    const fa = computeFamilyAwareRecovery(row);
    totalMisclassified += fa.misclassified_candidates.length;
    totalSeparate += fa.separate_claim_suggestions.length;
    console.log(`\n  • ${row.claim_submission_id} · ${fa.claim_family} → ${fa.filing_status.toUpperCase()}`);
    console.log(
      `    cogs=${fmt(fa.current_cogs_expected_recovery)} sale_net=${fmt(fa.alternative_latest_sale_net_estimate)} biz_loss=${fmt(fa.business_total_loss_estimate)} | SC=${fmt(fa.seller_central_amount)} (${fa.seller_central_amount_basis})`,
    );
    console.log(
      `    confirmed_strong=${fmt(fa.confirmed_reimbursed_strong)} open_current=${fmt(fa.open_gap_under_current_policy)} open_alt=${fmt(fa.open_gap_under_alternative_policy)}`,
    );
    console.log(
      `    candidates=${fa.candidate_classifications.length} misclassified=${fa.misclassified_candidates.length} separate_suggestions=${fa.separate_claim_suggestions.length}`,
    );
    for (const c of fa.misclassified_candidates.slice(0, 4)) {
      console.log(`      ⚠ ${c.source_label}:${c.reference_id} → '${c.classified_family}' (${c.reason ?? "—"})`);
    }
    // Per-claim invariants. Family-aware confirmed never EXCEEDS the raw gap confirmed
    // (cross-family counted rows are excluded), and is never negative.
    check(
      fa.confirmed_reimbursed_strong >= 0 && fa.confirmed_reimbursed_strong <= fa.gap.confirmed_reimbursed,
      `${row.claim_submission_id}: family-aware confirmed must be within [0, gap.confirmed_reimbursed]`,
    );
    check(
      fa.misclassified_candidates.every((c) => !c.belongs_to_this_claim && c.should_create_separate_claim),
      `${row.claim_submission_id}: every misclassified candidate must be flagged for a separate claim`,
    );
  }

  // ---- Summary ----
  const sum = summarizeFamilyAwareRecovery(allRows);
  console.log(`\n──── FAMILY-AWARE SUMMARY ────`);
  console.log(`  total_cogs_recovery=${fmt(sum.total_cogs_recovery)}`);
  console.log(`  total_latest_sale_net_estimate=${fmt(sum.total_latest_sale_net_estimate)}`);
  console.log(`  total_business_loss_estimate=${fmt(sum.total_business_loss_estimate)}`);
  console.log(`  confirmed_reimbursed_total=${fmt(sum.confirmed_reimbursed_total)}`);
  console.log(`  weak_candidates_total=${sum.weak_candidates_total} excluded=${sum.weak_candidates_excluded_total}`);
  console.log(`  separate_claim_candidate_suggestions=${sum.separate_claim_candidate_suggestions}`);
  console.log(
    `  safe_to_file=${sum.safe_to_file_count} needs_policy_confirmation=${sum.needs_policy_confirmation_count} needs_reference_review=${sum.needs_reference_review_count} do_not_file=${sum.do_not_file_count}`,
  );

  check(Math.abs(sum.total_cogs_recovery - EXPECTED_TOTAL_RECOVERY) < 0.01, `total_cogs_recovery must be $${EXPECTED_TOTAL_RECOVERY}, got ${fmt(sum.total_cogs_recovery)}`);
  check(sum.confirmed_reimbursed_total === 0, `pilot has no confirmed strong reimbursement; got ${fmt(sum.confirmed_reimbursed_total)}`);
  check(
    sum.needs_policy_confirmation_count === 10,
    `all 10 pilot claims (removal families) must be needs_policy_confirmation until operator confirms basis; got ${sum.needs_policy_confirmation_count}`,
  );
  check(sum.safe_to_file_count === 0, `no pilot claim is safe_to_file while amount basis unconfirmed; got ${sum.safe_to_file_count}`);
  check(totalMisclassified === sum.weak_candidates_excluded_total, "misclassified total reconciles with summary");
  check(totalSeparate === sum.separate_claim_candidate_suggestions, "separate suggestions total reconciles with summary");

  // ---- 6. Source / API coverage matrix ----
  const coverage = await composeClaimSourceCoverageV1(client, ORG);
  console.log(`\n──── SOURCE / API COVERAGE MATRIX (${coverage.source_coverage_matrix.length}) ────`);
  for (const s of coverage.source_coverage_matrix) {
    console.log(
      `  ${s.connection_status.padEnd(14)} ${s.label} rows=${s.row_count ?? "—"} spapi=${s.live_sp_api_exists}`,
    );
  }
  const missingLive = coverage.source_coverage_matrix
    .filter((s) => s.connection_status !== "live_loaded")
    .map((s) => s.label);
  console.log(`\n  missing_live_sources (${missingLive.length}): ${missingLive.join(", ") || "none"}`);
  check(coverage.source_coverage_matrix.length === 17, `expected 17 audited sources, got ${coverage.source_coverage_matrix.length}`);

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
  console.log(`family_aware_matching_engine_built=${failures === 0 ? "yes" : "no"}`);
  console.log(`SAFE_FAMILY_AWARE_RECOVERY_MATCHING_READY=${failures === 0 ? "yes" : "no"}`);
  console.log(`SAFE_TO_FILE_APPROVED_FAMILIES=no (amount basis pending operator confirmation)`);
  console.log(`SAFE_TO_BUILD_SEPARATE_CLAIM_CANDIDATE_GENERATORS=${failures === 0 ? "yes" : "no"}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
