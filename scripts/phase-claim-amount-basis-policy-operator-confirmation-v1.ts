/**
 * PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1
 *
 * Governed write of the operator-confirmed claim-amount basis policy into
 * workspace_settings.module_configs.claims.amount_basis_policy, then recompute the
 * 10 Ready-to-File pilot claims so removal_shipment_missing + removal_order_discrepancy
 * flip needs_policy_confirmation -> safe_to_file. The ONLY write is the policy config.
 *
 * No claim_* mutation. No Amazon. No browser. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-claim-amount-basis-policy-operator-confirmation-v1.ts --execute
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  computeFamilyAwareRecovery,
  type ReadyToFileRow,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import {
  readAmountBasisPolicyApproval,
  writeConfirmedAmountBasisPolicy,
  type AmountBasisDecisionInput,
} from "../lib/claims/policy/claim-amount-basis-policy-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const ACTOR = "operator:maysam";
const EXPECTED_TOTAL = 100.72;

const DECISIONS: AmountBasisDecisionInput[] = [
  {
    family_key: "removal_shipment_missing",
    basis: "cogs_recovery",
    use_as_seller_central_amount: true,
    informational_only: ["latest_sale_net", "business_total_loss"],
    note: "Operator policy: COGS recovery is the Seller Central claim amount; latest sale net + business loss are internal/informational only; sale price is not the claim amount.",
  },
  {
    family_key: "removal_order_discrepancy",
    basis: "cogs_recovery",
    use_as_seller_central_amount: true,
    informational_only: ["latest_sale_net", "business_total_loss"],
    note: "Operator policy: COGS recovery is the Seller Central claim amount; latest sale net + business loss are internal/informational only; sale price is not the claim amount.",
  },
];

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

function statusCounts(rows: ReadyToFileRow[]): Record<string, number> {
  const c: Record<string, number> = { safe_to_file: 0, needs_policy_confirmation: 0, needs_reference_review: 0, do_not_file: 0 };
  for (const r of rows) {
    const fa = computeFamilyAwareRecovery(r);
    c[fa.filing_status] = (c[fa.filing_status] ?? 0) + 1;
  }
  return c;
}

async function loadRows(client: SupabaseClient): Promise<ReadyToFileRow[]> {
  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  return [...payload.ready_rows, ...payload.blocked_rows];
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("=== PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1 ===");
  const approval = readAmountBasisPolicyApproval();
  console.log(`approval_status: ${approval.approved ? "APPROVED" : "BLOCKED"}${approval.block_reason ? ` (${approval.block_reason})` : ""}`);
  console.log(`execute_flag: ${execute ? "yes" : "no (dry-run)"}`);

  // ---- BEFORE: force overlay null to show the pre-policy view deterministically ----
  const liveRows = await loadRows(client);
  check(liveRows.length === 10, `expected 10 pilot rows, got ${liveRows.length}`);
  const beforeRows = liveRows.map((r) => ({ ...r, amount_basis_policy_overlay: null }) as ReadyToFileRow);
  const beforeCounts = statusCounts(beforeRows);
  console.log(`\npilot_claims_before_status_counts: ${JSON.stringify(beforeCounts)}`);

  if (!execute) {
    console.log("\nDry-run only (no --execute). No write performed.");
    console.log(`policy_config_written: no`);
    process.exit(approval.approved ? 0 : 1);
  }

  // ---- WRITE: governed policy config only ----
  const writeResult = await writeConfirmedAmountBasisPolicy({ client, organizationId: ORG, decisions: DECISIONS, actorId: ACTOR });
  console.log(`\npolicy_config_written: ${writeResult.written ? "yes" : "no"}`);
  console.log(`policy_storage_location: ${writeResult.storage_location}`);
  console.log(`workspace_settings_row: id=${writeResult.workspace_settings_row_id} source=${writeResult.workspace_settings_row_source}`);
  if (writeResult.block_reason) console.log(`block_reason: ${writeResult.block_reason}`);
  check(writeResult.written, `policy write must succeed (${writeResult.block_reason ?? "unknown"})`);

  // no claim_* mutation
  for (const k of Object.keys(writeResult.claim_counts_before)) {
    check(
      writeResult.claim_counts_before[k] === writeResult.claim_counts_after[k],
      `no claim mutation: ${k} ${writeResult.claim_counts_before[k]} -> ${writeResult.claim_counts_after[k]}`,
    );
  }
  console.log(`claim_counts (unchanged): ${JSON.stringify(writeResult.claim_counts_after)}`);

  // ---- AFTER: re-run composer (now loads the confirmed overlay) ----
  const afterRows = await loadRows(client);
  const afterCounts = statusCounts(afterRows);
  console.log(`\npilot_claims_after_status_counts: ${JSON.stringify(afterCounts)}`);

  console.log(`\n──── FAMILY POLICY MATRIX AFTER (confirmed families) ────`);
  let totalSc = 0;
  let totalCogs = 0;
  let totalSaleNet = 0;
  let totalBizLoss = 0;
  let totalConfirmed = 0;
  let totalOpen = 0;
  let weakExcluded = 0;
  let separateSuggestions = 0;
  for (const r of afterRows) {
    const fa = computeFamilyAwareRecovery(r);
    totalSc += fa.seller_central_amount ?? 0;
    totalCogs += fa.current_cogs_expected_recovery ?? 0;
    totalSaleNet += fa.alternative_latest_sale_net_estimate ?? 0;
    totalBizLoss += fa.business_total_loss_estimate ?? 0;
    totalConfirmed += fa.confirmed_reimbursed_strong;
    totalOpen += fa.open_gap_under_current_policy ?? 0;
    weakExcluded += fa.misclassified_candidates.length;
    separateSuggestions += fa.separate_claim_suggestions.length;
    console.log(
      `  ${r.claim_submission_id} · ${fa.claim_family} → ${fa.filing_status} | basis=${fa.seller_central_amount_basis} confirmed_policy=${fa.policy_confirmed} SC=${fmt(fa.seller_central_amount)} info=[${fa.informational_only_bases.join(",")}]`,
    );
  }

  console.log(`\n──── TOTALS AFTER ────`);
  console.log(`  total_seller_central_requested_amount=${fmt(Math.round(totalSc * 100) / 100)}`);
  console.log(`  total_cogs_recovery=${fmt(Math.round(totalCogs * 100) / 100)}`);
  console.log(`  total_latest_sale_net_estimate=${fmt(Math.round(totalSaleNet * 100) / 100)}`);
  console.log(`  total_business_loss_estimate=${fmt(Math.round(totalBizLoss * 100) / 100)}`);
  console.log(`  confirmed_reimbursed_total=${fmt(Math.round(totalConfirmed * 100) / 100)}`);
  console.log(`  open_gap_total=${fmt(Math.round(totalOpen * 100) / 100)}`);
  console.log(`  weak_candidates_excluded_total=${weakExcluded}`);
  console.log(`  separate_claim_candidate_suggestions=${separateSuggestions}`);

  check(afterCounts.safe_to_file === 10, `all 10 pilot claims must be safe_to_file after policy confirmation; got ${afterCounts.safe_to_file}`);
  check(afterCounts.needs_policy_confirmation === 0, `needs_policy_confirmation must be 0 after confirmation; got ${afterCounts.needs_policy_confirmation}`);
  check(Math.abs(totalSc - EXPECTED_TOTAL) < 0.01, `total Seller Central requested = $${EXPECTED_TOTAL}; got ${fmt(totalSc)}`);
  check(Math.abs(totalCogs - EXPECTED_TOTAL) < 0.01, `total COGS recovery = $${EXPECTED_TOTAL}; got ${fmt(totalCogs)}`);
  check(totalConfirmed === 0, `confirmed reimbursed must stay $0.00; got ${fmt(totalConfirmed)}`);
  check(Math.abs(totalOpen - EXPECTED_TOTAL) < 0.01, `open gap total = $${EXPECTED_TOTAL}; got ${fmt(totalOpen)}`);
  check(weakExcluded === 152, `weak cross-family candidates must remain excluded (152); got ${weakExcluded}`);
  check(separateSuggestions === 31, `separate claim suggestions must remain (31); got ${separateSuggestions}`);
  check(
    afterRows.every((r) => {
      const fa = computeFamilyAwareRecovery(r);
      return fa.policy_confirmed && fa.seller_central_amount_basis === "cogs_recovery";
    }),
    "every pilot claim must show confirmed COGS-recovery basis after write",
  );

  console.log(`\n=== ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`SAFE_CLAIM_AMOUNT_POLICY_CONFIRMED=${failures === 0 ? "yes" : "no"}`);
  console.log(`SAFE_TO_FILE_APPROVED_REMOVAL_FAMILIES=${failures === 0 ? "yes" : "no"}`);
  console.log(`SAFE_TO_BUILD_SEPARATE_CLAIM_CANDIDATE_GENERATORS=${failures === 0 ? "yes" : "no"}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
