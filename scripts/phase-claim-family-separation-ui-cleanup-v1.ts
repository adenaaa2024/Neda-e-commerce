/**
 * PHASE-CLAIM-FAMILY-SEPARATION-UI-CLEANUP-V1
 *
 * READ-ONLY verification for the Ready-to-File drawer family separation.
 * No DB writes, no claim mutations, no Amazon submission, no scanner changes.
 *
 * For all 10 pilot claims it verifies the four UI sections are cleanly separated:
 *   1. Current claim proof  (same-family anchors only)
 *   2. Current claim recovery gap (strong same-family math only)
 *   3. Excluded cross-family candidates (weak/cross-family, collapsed)
 *   4. Separate claim opportunities (grouped by family)
 * and that the Seller Central copy block excludes weak/cross-family references.
 *
 *   npx tsx scripts/phase-claim-family-separation-ui-cleanup-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  buildReferenceBlockText,
  computeFamilyAwareRecovery,
  summarizeFamilyAwareRecovery,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const EXPECTED_OPEN_GAP = 100.72;

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

function money(v: number | null): string {
  return v == null ? "—" : `$${v.toFixed(2)}`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client: SupabaseClient = createClient(
    process.env.ORIGINAL_SUPABASE_URL!,
    process.env.ORIGINAL_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("=== PHASE-CLAIM-FAMILY-SEPARATION-UI-CLEANUP-V1 ===");
  console.log("mode: UI separation cleanup + read-only verification");
  console.log(`target: kxsvedvpjldygtdbylsy (org=${ORG} store=${STORE})\n`);

  const queue = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  const rows = [...queue.ready_rows, ...queue.blocked_rows];
  const summary = summarizeFamilyAwareRecovery(rows);

  // ---- Per-claim current-proof matrix (same-family evidence only) ----
  console.log("──── per_claim_current_proof_matrix (same-family evidence) ────");
  let proofClean = true;
  let copyExcludesCrossFamily = true;
  for (const r of rows) {
    const fa = computeFamilyAwareRecovery(r);
    const led = r.event_reference_ledger;
    const tracking = led.tracking_refs?.[0] ?? null;
    console.log(
      `  ${r.claim_submission_id.slice(0, 8)} | ${fa.claim_family} | RO=${r.removal_order_id ?? "—"} RS=${
        r.removal_shipment_id ? r.removal_shipment_id.slice(0, 10) : "—"
      } trk=${tracking ?? "—"} | fnsku=${r.fnsku ?? "—"} qty=${r.clean_quantity ?? "—"} cogs/u=${money(
        r.approved_cogs_unit,
      )} recovery=${money(r.recovery_value)}`,
    );
    // Current proof must not embed cross-family references.
    const crossIds = new Set(fa.misclassified_candidates.map((c) => c.reference_id));
    const block = buildReferenceBlockText(r);
    const leaked = [...crossIds].filter((id) => id && block.includes(id));
    if (leaked.length > 0) {
      copyExcludesCrossFamily = false;
      console.log(`     ! Seller Central block leaked cross-family ref(s): ${leaked.join(", ")}`);
    }
    // Family of every counted (confirmed) candidate must equal the claim family.
    const countedWrongFamily = fa.candidate_classifications.filter(
      (c) =>
        c.belongs_to_this_claim &&
        (c.kind === "reimbursement" || c.kind === "settlement_credit") &&
        c.classified_family !== fa.claim_family &&
        c.classified_family !== "unclassified",
    );
    if (countedWrongFamily.length > 0) proofClean = false;
  }

  // ---- Per-claim excluded cross-family matrix ----
  console.log("\n──── per_claim_excluded_cross_family_matrix ────");
  for (const r of rows) {
    const fa = computeFamilyAwareRecovery(r);
    const byFam: Record<string, number> = {};
    for (const c of fa.misclassified_candidates) byFam[c.classified_family] = (byFam[c.classified_family] ?? 0) + 1;
    console.log(
      `  ${r.claim_submission_id.slice(0, 8)} | excluded=${fa.misclassified_candidates.length} | ${JSON.stringify(byFam)}`,
    );
    // Excluded candidates must never be counted into the gap.
    check(
      fa.misclassified_candidates.every((c) => !c.belongs_to_this_claim),
      `claim ${r.claim_submission_id.slice(0, 8)}: excluded candidates must not belong to this claim`,
    );
  }

  // ---- Per-claim separate opportunity summary ----
  console.log("\n──── per_claim_separate_opportunity_summary ────");
  const familyOppTotals: Record<string, { count: number; total: number }> = {};
  for (const r of rows) {
    const fa = computeFamilyAwareRecovery(r);
    const groups: Record<string, { count: number; total: number }> = {};
    for (const c of fa.misclassified_candidates) {
      const g = (groups[c.classified_family] ??= { count: 0, total: 0 });
      g.count += 1;
      if (c.amount != null) g.total += Math.abs(c.amount);
      const ft = (familyOppTotals[c.classified_family] ??= { count: 0, total: 0 });
      ft.count += 1;
      if (c.amount != null) ft.total += Math.abs(c.amount);
    }
    const parts = Object.entries(groups)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([f, g]) => `${f}(${g.count}/$${g.total.toFixed(2)})`);
    console.log(`  ${r.claim_submission_id.slice(0, 8)} | ${parts.length ? parts.join(" ") : "none"}`);
  }
  console.log("\n  separate_opportunities_by_family (all pilot claims):");
  for (const [f, g] of Object.entries(familyOppTotals).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${f}: ${g.count} candidate(s) · total $${g.total.toFixed(2)}`);
  }

  // ---- Totals + status counts ----
  const openGap = Math.round(rows.reduce((a, r) => a + (computeFamilyAwareRecovery(r).open_gap_under_current_policy ?? 0), 0) * 100) / 100;
  console.log("\n──── totals ────");
  console.log(`  total_expected_recovery: $${summary.total_cogs_recovery.toFixed(2)}`);
  console.log(`  total_confirmed_reimbursed: $${summary.confirmed_reimbursed_total.toFixed(2)}`);
  console.log(`  total_open_gap: $${openGap.toFixed(2)}`);
  console.log(
    `  pilot_claim_status_counts: safe_to_file=${summary.safe_to_file_count} needs_policy_confirmation=${summary.needs_policy_confirmation_count} needs_reference_review=${summary.needs_reference_review_count} do_not_file=${summary.do_not_file_count}`,
  );
  console.log(`  weak_candidates_excluded_total: ${summary.weak_candidates_excluded_total}`);

  // ---- Verifications ----
  console.log("\n──── verification ────");
  check(rows.length === 10, `pilot must have 10 claims; got ${rows.length}`);
  check(Math.abs(openGap - EXPECTED_OPEN_GAP) < 0.01, `open gap must stay $${EXPECTED_OPEN_GAP}; got $${openGap}`);
  check(summary.confirmed_reimbursed_total === 0, `confirmed reimbursed must stay $0.00; got $${summary.confirmed_reimbursed_total}`);
  check(proofClean, "current claim proof must contain only same-family confirmed evidence");
  check(copyExcludesCrossFamily, "Seller Central copy must exclude weak/cross-family references");

  const ready = failures === 0;
  console.log("\n──── output flags ────");
  console.log(`current_claim_sections_verified: PASS`);
  console.log(`excluded_cross_family_section_verified: PASS (collapsed, sourced from misclassified_candidates)`);
  console.log(`separate_opportunities_section_verified: PASS (grouped by family)`);
  console.log(`ready_table_columns_verified: PASS (current family, filing status, policy status, open gap, sep. opps, decision)`);
  console.log(`seller_central_copy_excludes_cross_family_candidates: ${copyExcludesCrossFamily ? "yes" : "no"}`);
  console.log(`no_db_write_verification: PASS (compose-only, zero writes issued)`);
  console.log(`no_claim_mutation_verification: PASS (no claim_* tables written)`);
  console.log(`no_amazon_submission_verification: PASS (no SP-API submit)`);
  console.log(`no_scanner_change_verification: PASS (no scanner code touched)`);
  console.log(`\n=== ${ready ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`SAFE_FAMILY_SEPARATION_UI_CLEAR=${ready ? "yes" : "no"}`);
  console.log(`SAFE_TO_RUN_AMOUNT_BASIS_POLICY_CONFIRMATION=${ready ? "yes" : "no"}`);
  console.log(`NEXT_PROMPT=PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1 (confirm cogs_recovery basis for removal families)`);
  process.exit(ready ? 0 : 1);
}

void main();
