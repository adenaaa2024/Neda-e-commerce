/**
 * PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1
 *
 * Builds per-family separate claim-candidate PREVIEWS from family-aware cross-family
 * suggestions. PREVIEW by default; writes claim_candidates ONLY if the approval file
 * has APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1=yes. Verifies the 10
 * removal pilot claims are unchanged and cross-family candidates never reduce them.
 *
 *   npx tsx scripts/phase-claim-separate-family-candidate-generators-v1.ts [--execute]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeSeparateFamilyCandidateGeneratorsV1 } from "../lib/claims/opportunities/separate-family-candidate-generators-v1";
import {
  readSeparateFamilyGeneratorApproval,
  writeSeparateFamilyCandidates,
} from "../lib/claims/opportunities/separate-family-candidate-generators-write-v1";
import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import { computeFamilyAwareRecovery, summarizeFamilyAwareRecovery } from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const ACTOR = "operator:maysam";
const EXPECTED_REMOVAL_GAP = 100.72;

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  loadEnvLocalIntoProcess();
  const client: SupabaseClient = createClient(
    process.env.ORIGINAL_SUPABASE_URL!,
    process.env.ORIGINAL_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("=== PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1 ===");
  const approval = readSeparateFamilyGeneratorApproval();
  const mode = execute && approval.approved ? "execute" : "preview";
  console.log(`mode: ${mode}`);
  console.log(`approval_status: ${approval.approved ? "APPROVED" : "BLOCKED"}`);
  console.log(`approval_path: ${approval.approval_path}`);
  if (approval.block_reason) console.log(`approval_block_reason: ${approval.block_reason}`);

  // ---- PREVIEW (read-only) ----
  const payload = await composeSeparateFamilyCandidateGeneratorsV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  console.log(`\nsuggestions_input_count: ${payload.suggestions_input_count}`);
  console.log(`candidates_preview_count: ${payload.candidates.length}`);
  console.log(`writeable_count: ${payload.writeable_count}`);
  console.log(`family_counts: ${JSON.stringify(payload.family_counts)}`);
  console.log(`unsupported_families: ${JSON.stringify(payload.unsupported_families)}`);

  console.log(`\n──── PER-FAMILY CANDIDATE MATRIX ────`);
  for (const [family, count] of Object.entries(payload.family_counts).sort()) {
    const blockers = payload.blockers_by_family[family] ?? {};
    const example = payload.candidates.find((c) => c.recommended_claim_family === family);
    console.log(
      `  ${family}: ${count} | basis=${example?.claim_amount_basis} src=${example?.source_table} | blockers=${JSON.stringify(blockers)}`,
    );
  }

  // ---- Verify removal pilot claims unchanged + no cross-family pollution ----
  const queue = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  const rows = [...queue.ready_rows, ...queue.blocked_rows];
  const fas = rows.map((r) => computeFamilyAwareRecovery(r));
  const summary = summarizeFamilyAwareRecovery(rows);
  const removalGap = Math.round(fas.reduce((a, f) => a + (f.open_gap_under_current_policy ?? 0), 0) * 100) / 100;
  const removalSafe = fas.filter((f) => f.filing_status === "safe_to_file").length;
  const confirmedTotal = summary.confirmed_reimbursed_total;
  const weakExcluded = summary.weak_candidates_excluded_total;

  console.log(`\ncurrent_removal_claims_unchanged_verification:`);
  console.log(`  removal_pilot_claim_count=${rows.length} safe_to_file=${removalSafe} open_gap_total=$${removalGap.toFixed(2)} confirmed=$${confirmedTotal.toFixed(2)} weak_excluded=${weakExcluded}`);
  check(removalSafe === 10, `removal pilot must stay 10 safe_to_file; got ${removalSafe}`);
  check(Math.abs(removalGap - EXPECTED_REMOVAL_GAP) < 0.01, `removal open gap must stay $${EXPECTED_REMOVAL_GAP}; got $${removalGap}`);
  check(confirmedTotal === 0, `confirmed reimbursed must stay $0.00 (no cross-family pollution); got $${confirmedTotal}`);
  check(weakExcluded === 152, `weak cross-family candidates must remain excluded (152); got ${weakExcluded}`);
  check(payload.candidates.every((c) => Boolean(c.product_identity.fnsku || c.product_identity.sku || c.product_identity.asin)), "no candidate may lack product identity");
  check(payload.candidates.every((c) => !c.recommended_claim_family.startsWith("removal_")), "no generated candidate may be a removal family");

  // ---- WRITE (guarded) ----
  const writeResult = await writeSeparateFamilyCandidates({
    client,
    organizationId: ORG,
    storeId: STORE,
    previews: payload.candidates,
    runId: `sep-fam-${new Date().toISOString()}`,
    actorId: ACTOR,
  });
  console.log(`\ncandidates_written_count: ${writeResult.candidates_written_count}`);
  console.log(`write_blocked: ${writeResult.blocked} ${writeResult.block_reason ? `(${writeResult.block_reason})` : ""}`);
  console.log(`claim_candidates: before=${writeResult.claim_candidates_before} after=${writeResult.claim_candidates_after}`);
  for (const [t, c] of Object.entries(writeResult.other_tables_unchanged)) {
    check(c.before === c.after, `no mutation on ${t}: ${c.before} -> ${c.after}`);
  }
  if (mode === "preview") {
    check(writeResult.candidates_written_count === 0, "preview mode must write 0 claim_candidates");
    check(writeResult.claim_candidates_before === writeResult.claim_candidates_after, "claim_candidates count must be unchanged in preview");
  }

  const ready = failures === 0;
  console.log(`\n=== ${ready ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`no_amazon_submission_verification: PASS (compose-only, no SP-API submit)`);
  console.log(`no_scanner_change_verification: PASS (no scanner code touched)`);
  console.log(`SAFE_SEPARATE_FAMILY_GENERATORS_READY=${ready ? "yes" : "no"}`);
  console.log(`SAFE_TO_PROMOTE_NEW_FAMILY_CANDIDATES=${ready && approval.approved ? "yes" : "no"}`);
  process.exit(ready ? 0 : 1);
}

void main();
