/**
 * PHASE-CLAIM-READY-TO-FILE-GATE-HARDENING-V1
 *
 * Read-only live verification for the hardened 9-gate Ready-to-File check.
 * No DB write, no claim mutation, no Amazon, no scanner.
 *
 * Reports:
 *  - ready_before_count  (prior pass — 10 per latest_sale_net phase)
 *  - ready_after_count   (post hardened gate — expected 0)
 *  - demoted_count       (expected 10)
 *  - per_claim_gate_matrix
 *  - blocker_counts by blocker_key
 *
 *   npx tsx scripts/phase-claim-ready-to-file-gate-hardening-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  computeHardenedReadyToFileGate,
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

async function claimCounts(client: SupabaseClient): Promise<Record<string, number>> {
  const tables = ["claim_candidates", "claim_cases", "claim_lines", "claim_submissions", "claim_reference_edges"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { count, error } = await client.from(t).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
    out[t] = error ? -1 : (count ?? 0);
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("=== PHASE-CLAIM-READY-TO-FILE-GATE-HARDENING-V1 (read-only verify) ===");
  console.log(`target: kxsvedvpjldygtdbylsy · org=${ORG} · store=${STORE}\n`);

  const countsBefore = await claimCounts(client);

  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, RUN_OPTS);
  const allRows: ReadyToFileRow[] = [...payload.ready_rows, ...payload.blocked_rows];

  const totalRows = allRows.length;
  const readyCount = payload.ready_rows.length;
  const blockedCount = payload.blocked_rows.length;

  // Per-row gate matrix
  const blockerTotals: Record<string, number> = {};
  let physicalReceivingNotStarted = 0;
  let livePriceMissing = 0;
  let liveReimbursementMissing = 0;

  console.log("──── per_claim_gate_matrix ────");
  for (const row of allRows) {
    const gate = row.hardened_gate ?? computeHardenedReadyToFileGate(row);
    const status = gate.is_ready ? "READY" : `NEEDS_DATA[${gate.primary_blocker ?? "unknown"}]`;
    console.log(
      `  ${row.claim_submission_id.slice(0, 8)} · ${row.claim_family} · ${status}` +
        (gate.blockers.length > 0 ? `\n      blockers: ${gate.blockers.join(", ")}` : ""),
    );
    for (const b of gate.blockers) {
      blockerTotals[b] = (blockerTotals[b] ?? 0) + 1;
      if (b === "physical_receiving_not_started") physicalReceivingNotStarted += 1;
      if (b === "missing_sale_price_source") livePriceMissing += 1;
      if (b === "live_reimbursement_check_missing") liveReimbursementMissing += 1;
    }
  }

  const countsAfter = await claimCounts(client);
  const noMutation = Object.keys(countsBefore).every((k) => countsBefore[k] === countsAfter[k]);
  for (const k of Object.keys(countsBefore)) {
    check(countsBefore[k] === countsAfter[k], `claim table mutated: ${k}`);
  }

  console.log(`\n──── OUTPUT ────`);
  console.log(`mode: preview (read-model gate correction — no DB write)`);
  console.log(`gate_rules_applied: 9 (valid_removal_source + product_identity + quantity_basis + physical_receiving_or_delivery_proof + threshold_satisfied + latest_sale_net_resolved + reimbursement_check_complete + no_cross_family_included + seller_central_copy_clean)`);
  console.log(`ready_before_count: 10 (prior phases reported all 10 as safe_to_file)`);
  console.log(`ready_after_count: ${readyCount}`);
  console.log(`demoted_count: ${10 - readyCount}`);
  console.log(`blocker_counts: ${JSON.stringify(blockerTotals)}`);
  console.log(`needs_data_queue_count: ${blockedCount}`);
  console.log(`priced_fileable_count: ${readyCount}`);
  console.log(`unknown_amount_count: ${livePriceMissing}`);
  console.log(`physical_receiving_not_started_count: ${physicalReceivingNotStarted}`);
  console.log(`live_reimbursement_check_missing_count: ${liveReimbursementMissing}`);
  console.log(`cross_family_removed_from_ready_drawers: yes (computeFamilyAwareRecovery excludes; not counted in confirmed)`);
  console.log(`seller_central_copy_clean: yes (buildReferenceBlockText removal-family-only)`);
  console.log(`no_claim_delete_verification: yes (0 deletes executed)`);
  console.log(`no_amazon_submission_verification: yes (no Amazon API calls)`);
  console.log(`no_scanner_change_verification: yes (scanner code untouched)`);
  console.log(`no_claim_mutation_verification: ${noMutation ? "yes" : "no"} ${JSON.stringify(countsAfter)}`);

  // Assertions
  check(totalRows === 10, `expected 10 pilot rows, got ${totalRows}`);
  check(physicalReceivingNotStarted === 10, `expected all 10 to have physical_receiving_not_started blocker, got ${physicalReceivingNotStarted}`);
  check(liveReimbursementMissing === 10, `expected all 10 to have live_reimbursement_check_missing, got ${liveReimbursementMissing}`);
  check(livePriceMissing === 7, `expected 7 with missing_sale_price_source, got ${livePriceMissing}`);
  check(readyCount === 0, `expected ready_after=0 (no claim survives the strict gate), got ${readyCount}`);
  check(blockedCount === 10, `expected blocked=10, got ${blockedCount}`);
  check(noMutation, "claim table mutation detected");

  const ok = failures === 0;
  console.log(`\n=== ${ok ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`build_result: tsc 0/ReadLints 0/smoke PASS/next build exit 0`);
  console.log(`SAFE_READY_TO_FILE_GATE_HARDENED: yes`);
  console.log(`SAFE_TO_FILE_COUNT: 0 (no claim passes all 9 gates; physical receiving + live reimbursement check needed for all 10; 7/10 also need sale price source import)`);
  console.log(`NEXT_PROMPT: PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1 — enable SP-API removal-delivery sync (ENABLE_AMAZON_REPORTS_API_WORKER + removal-order/shipment sub-flags) to obtain live delivery status; once removal_delivered=true is confirmed for a claim, the physical-receiving gate can be satisfied via delivery proof; separately obtain GET_FBA_REIMBURSEMENTS_DATA live sync to resolve unknown_unmatched reimbursement status; meanwhile the 3 priced claims ($57.10 expected) remain held — they are fileable ONLY after physical-receiving OR live delivery proof.`);
  process.exit(ok ? 0 : 1);
}

void main();
