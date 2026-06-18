/**
 * PHASE-CLAIM-AMOUNT-BASIS-LATEST-SALE-NET-POLICY-FIX-V1
 *
 * Governed amount-basis correction (Maysam): for the two current pilot removal
 * families the Seller Central expected reimbursement must be
 *   expected_reimbursement = (latest_sold_price − amazon_fees) × qty
 * NOT COGS, NOT sale price alone, NOT settlement net. COGS / settlement remain
 * visible only as internal cost / profit-loss context.
 *
 * The ONLY write is the governed amount-basis policy config in
 * workspace_settings.module_configs.claims.amount_basis_policy. No claim_*
 * mutation. No Amazon. No browser. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-claim-amount-basis-latest-sale-net-policy-fix-v1.ts --execute
 */
import fs from "node:fs";
import path from "node:path";

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
const EXPECTED_TOTAL_COGS = 100.72; // internal COGS total stays unchanged

/** Phase-specific approval gate (in addition to the module's APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1). */
const PHASE_APPROVAL_KEY = "APPROVED_CLAIM_AMOUNT_BASIS_LATEST_SALE_NET_POLICY_FIX_V1";
const PHASE_APPROVAL_PATH =
  ".cursor/operator-approvals/claim-amount-basis-latest-sale-net-policy-fix-v1-approval.md";

const REMOVAL_FAMILIES = new Set(["removal_shipment_missing", "removal_order_discrepancy"]);

const DECISIONS: AmountBasisDecisionInput[] = [
  {
    family_key: "removal_shipment_missing",
    basis: "latest_sale_net",
    use_as_seller_central_amount: true,
    informational_only: ["cogs_recovery", "business_total_loss", "settlement_net"],
    note: "Maysam policy fix: Seller Central expected reimbursement = (latest_sold_price − amazon_fees) × qty. COGS / purchase cost / settlement net are internal accounting only, never the claim amount.",
  },
  {
    family_key: "removal_order_discrepancy",
    basis: "latest_sale_net",
    use_as_seller_central_amount: true,
    informational_only: ["cogs_recovery", "business_total_loss", "settlement_net"],
    note: "Maysam policy fix: Seller Central expected reimbursement = (latest_sold_price − amazon_fees) × qty. COGS / purchase cost / settlement net are internal accounting only, never the claim amount.",
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
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function readPhaseApproval(): { approved: boolean; block_reason: string | null } {
  const p = path.join(process.cwd(), PHASE_APPROVAL_PATH);
  if (!fs.existsSync(p)) return { approved: false, block_reason: `${PHASE_APPROVAL_PATH} missing` };
  const approved = new RegExp(`^${PHASE_APPROVAL_KEY}\\s*=\\s*yes\\s*$`, "im").test(fs.readFileSync(p, "utf8"));
  return { approved, block_reason: approved ? null : `${PHASE_APPROVAL_KEY}=yes required in ${PHASE_APPROVAL_PATH}` };
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

  console.log("=== PHASE-CLAIM-AMOUNT-BASIS-LATEST-SALE-NET-POLICY-FIX-V1 ===");
  const moduleApproval = readAmountBasisPolicyApproval();
  const phaseApproval = readPhaseApproval();
  console.log(`module_approval: ${moduleApproval.approved ? "APPROVED" : "BLOCKED"}${moduleApproval.block_reason ? ` (${moduleApproval.block_reason})` : ""}`);
  console.log(`phase_approval: ${phaseApproval.approved ? "APPROVED" : "BLOCKED"}${phaseApproval.block_reason ? ` (${phaseApproval.block_reason})` : ""}`);
  console.log(`execute_flag: ${execute ? "yes" : "no (dry-run)"}`);

  // ---- BEFORE: force the prior COGS-recovery overlay so the delta is explicit ----
  const liveRows = await loadRows(client);
  check(liveRows.length === 10, `expected 10 pilot rows, got ${liveRows.length}`);
  const cogsOverlay = {
    version: "claim-amount-basis-policy-v1",
    confirmed_by: ACTOR,
    confirmed_at: "before",
    approval_key: "APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1",
    families: {
      removal_shipment_missing: {
        family_key: "removal_shipment_missing",
        basis: "cogs_recovery" as const,
        use_as_seller_central_amount: true,
        informational_only: ["latest_sale_net", "business_total_loss"],
        confirmed_by: ACTOR,
        confirmed_at: "before",
        approval_key: "APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1",
        note: null,
      },
      removal_order_discrepancy: {
        family_key: "removal_order_discrepancy",
        basis: "cogs_recovery" as const,
        use_as_seller_central_amount: true,
        informational_only: ["latest_sale_net", "business_total_loss"],
        confirmed_by: ACTOR,
        confirmed_at: "before",
        approval_key: "APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1",
        note: null,
      },
    },
  };
  const beforeRows = liveRows.map((r) => ({ ...r, amount_basis_policy_overlay: cogsOverlay }) as ReadyToFileRow);
  const prevCogsBySubmission = new Map<string, number | null>();
  for (const r of beforeRows) {
    const fa = computeFamilyAwareRecovery(r);
    prevCogsBySubmission.set(r.claim_submission_id, fa.seller_central_amount);
  }

  if (!execute) {
    console.log("\nDry-run only (no --execute). No write performed.");
    console.log(`policy_config_written: no`);
    process.exit(moduleApproval.approved && phaseApproval.approved ? 0 : 1);
  }
  if (!phaseApproval.approved) {
    console.log(`\nBLOCKED: ${phaseApproval.block_reason}`);
    console.log(`policy_config_written: no`);
    process.exit(1);
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

  // ---- AFTER: re-run composer (now loads the confirmed latest_sale_net overlay) ----
  const afterRows = await loadRows(client);
  const afterCounts = statusCounts(afterRows);

  console.log(`\n──── PER-CLAIM MATRIX (latest_sale_net basis) ────`);
  let totalExpected = 0;
  let totalCogs = 0;
  let totalConfirmed = 0;
  let totalOpen = 0;
  let totalSettlement = 0;
  let totalPL = 0;
  let totalPrevCogs = 0;
  let weakExcluded = 0;
  let separateSuggestions = 0;
  let allLatestSaleNet = true;
  let scEqualsExpected = true;
  let noCogsAsRequested = true;
  for (const r of afterRows) {
    const fa = computeFamilyAwareRecovery(r);
    const prevCogs = prevCogsBySubmission.get(r.claim_submission_id) ?? fa.current_cogs_expected_recovery ?? 0;
    const expected = fa.expected_reimbursement_latest_sale_net;
    const open = fa.open_gap_under_current_policy;
    const delta = (expected ?? 0) - (prevCogs ?? 0);
    totalExpected += expected ?? 0;
    totalCogs += fa.total_cogs ?? 0;
    totalConfirmed += fa.confirmed_reimbursed_strong;
    totalOpen += open ?? 0;
    totalSettlement += fa.settlement_net ?? 0;
    totalPL += fa.business_profit_loss_context ?? 0;
    totalPrevCogs += prevCogs ?? 0;
    weakExcluded += fa.misclassified_candidates.length;
    separateSuggestions += fa.separate_claim_suggestions.length;
    if (REMOVAL_FAMILIES.has(fa.claim_family) && fa.seller_central_amount_basis !== "latest_sale_net") allLatestSaleNet = false;
    if (Math.abs((fa.seller_central_amount ?? 0) - (expected ?? 0)) > 0.01) scEqualsExpected = false;
    if (Math.abs((fa.seller_central_amount ?? 0) - (fa.current_cogs_expected_recovery ?? -1)) < 0.01 && (expected ?? 0) !== (fa.current_cogs_expected_recovery ?? 0)) noCogsAsRequested = false;
    console.log(
      `  ${r.claim_submission_id} · ${fa.claim_family} → ${fa.filing_status}` +
        `\n      latest_sold_price=${fmt(fa.latest_sold_price)} amazon_fees=${fmt(fa.amazon_fees)} expected_latest_sale_net=${fmt(expected)}` +
        `\n      confirmed_reimbursed_strong=${fmt(fa.confirmed_reimbursed_strong)} open_claim_amount=${fmt(open)} reimb_status=${fa.gap.status_label}` +
        `\n      approved_cogs_unit=${fmt(fa.policy ? r.approved_cogs_unit : null)} affected_qty=${r.clean_quantity ?? "—"} total_cogs=${fmt(fa.total_cogs)} settlement_net=${fmt(fa.settlement_net)} internal_pl=${fmt(fa.business_profit_loss_context)}` +
        `\n      previous_cogs_expected=${fmt(prevCogs)} delta_vs_previous_cogs=${fmt(r2(delta))} seller_central_requested=${fmt(fa.seller_central_amount)} basis=${fa.seller_central_amount_basis} policy=${fa.policy_confirmed ? "confirmed" : "needs_policy_confirmation"}`,
    );
  }

  console.log(`\n──── GLOBAL TOTALS ────`);
  console.log(`  old_total_cogs_expected=${fmt(r2(totalPrevCogs))}`);
  console.log(`  new_total_expected_reimbursement_latest_sale_net=${fmt(r2(totalExpected))}`);
  console.log(`  total_confirmed_reimbursed=${fmt(r2(totalConfirmed))}`);
  console.log(`  total_open_claim_amount=${fmt(r2(totalOpen))}`);
  console.log(`  total_internal_cogs=${fmt(r2(totalCogs))}`);
  console.log(`  total_internal_profit_loss_context=${fmt(r2(totalPL))}`);
  console.log(`  total_settlement_net=${fmt(r2(totalSettlement))}`);
  console.log(`  pilot_claim_status_counts=${JSON.stringify(afterCounts)}`);
  console.log(`  weak_candidates_excluded_total=${weakExcluded}`);
  console.log(`  separate_claim_candidate_suggestions=${separateSuggestions}`);

  check(afterCounts.safe_to_file === 10, `all 10 pilot claims must stay safe_to_file; got ${afterCounts.safe_to_file}`);
  check(afterCounts.needs_policy_confirmation === 0, `needs_policy_confirmation must be 0; got ${afterCounts.needs_policy_confirmation}`);
  check(Math.abs(totalCogs - EXPECTED_TOTAL_COGS) < 0.01, `internal COGS total must stay $${EXPECTED_TOTAL_COGS}; got ${fmt(totalCogs)}`);
  check(totalConfirmed === 0, `confirmed reimbursed must stay $0.00; got ${fmt(totalConfirmed)}`);
  check(Math.abs(totalOpen - totalExpected) < 0.01, `open claim total must equal expected total when confirmed=0; ${fmt(totalOpen)} vs ${fmt(totalExpected)}`);
  check(allLatestSaleNet, `every removal pilot claim must use latest_sale_net basis`);
  check(scEqualsExpected, `Seller Central amount must equal expected latest_sale_net for every claim`);
  check(noCogsAsRequested, `Seller Central requested amount must NOT be the COGS amount`);
  check(weakExcluded === 152, `weak cross-family candidates must remain excluded (152); got ${weakExcluded}`);
  check(separateSuggestions === 31, `separate claim suggestions must remain (31); got ${separateSuggestions}`);
  check(
    afterRows.every((r) => {
      const fa = computeFamilyAwareRecovery(r);
      return fa.policy_confirmed && fa.seller_central_amount_basis === "latest_sale_net";
    }),
    "every pilot claim must show confirmed latest_sale_net basis after write",
  );

  console.log(`\n=== ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`SAFE_AMOUNT_BASIS_LATEST_SALE_NET_CONFIRMED=${failures === 0 ? "yes" : "no"}`);
  console.log(`SAFE_TO_FILE_APPROVED_REMOVAL_FAMILIES=${failures === 0 ? "yes" : "no"}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
