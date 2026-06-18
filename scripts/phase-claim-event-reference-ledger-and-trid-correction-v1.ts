/**
 * PHASE-CLAIM-EVENT-REFERENCE-LEDGER-AND-TRID-CORRECTION-V1
 *
 * Read-only reference-correctness audit for the 10 pilot ready-to-file claims:
 *  - Confirms the current "TRID anchor" was an internal UUID and is now relabeled.
 *  - Confirms each claim resolves REAL external Amazon references (removal order id,
 *    tracking, removal shipment) and that no internal UUID leaks into the Seller
 *    Central reference block.
 *  - Classifies claims still ready-to-file vs needs-reference-review.
 *
 * No DB writes. No claim_* mutation. No Amazon. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-claim-event-reference-ledger-and-trid-correction-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
  const client = createClient(
    process.env.ORIGINAL_SUPABASE_URL!,
    process.env.ORIGINAL_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("=== PHASE-CLAIM-EVENT-REFERENCE-LEDGER-AND-TRID-CORRECTION-V1 (read-only) ===");

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
  check(payload.event_reference_ledger_summary.built, "event_reference_ledger_summary.built must be true");
  check(
    payload.event_reference_ledger_summary.event_datetime_filter_used === false,
    "event_datetime_filter_used must be reported false",
  );

  let readyCount = 0;
  let needsReviewCount = 0;
  const familyExternal: Record<string, number> = {};

  for (const row of allRows) {
    const L = row.event_reference_ledger;
    console.log(`\n──── ${row.claim_submission_id} · ${row.claim_family} (${row.filing_status}) ────`);
    console.log(
      `  primary_anchor: ${L.primary_reference_anchor.label} = ${L.primary_reference_anchor.value} (external=${L.primary_reference_anchor.is_external_amazon_reference})`,
    );
    console.log(
      `  external_refs=${L.external_reference_count} internal_anchors=${L.internal_anchor_count} confidence=${L.confidence} needs_review=${L.needs_reference_review}`,
    );
    console.log(`  removal_order_refs=[${L.removal_order_refs.join(", ")}] tracking=[${L.tracking_refs.join(", ")}]`);
    console.log(`  removal_shipment_refs=[${L.removal_shipment_refs.join(", ")}]`);
    console.log(
      `  reimbursement=[${L.reimbursement_refs.join(", ")}] transaction=[${L.transaction_refs.join(", ")}] inventory_ledger=[${L.inventory_ledger_refs.join(", ")}]`,
    );
    console.log(`  match_reasons=[${L.match_reasons.join(", ")}]`);
    console.log(`  Seller Central reference block:\n    ${L.seller_central_reference_block.replace(/\n/g, "\n    ")}`);

    // Correctness assertions
    check(L.external_reference_count > 0, `${row.claim_submission_id}: must have >=1 external reference`);
    check(
      !L.primary_reference_anchor.is_external_amazon_reference || !UUID_RE.test(String(L.primary_reference_anchor.value ?? "")),
      `${row.claim_submission_id}: external primary anchor must NOT be a UUID`,
    );
    check(
      !UUID_RE.test(L.seller_central_reference_block),
      `${row.claim_submission_id}: Seller Central reference block must contain NO internal UUID`,
    );
    check(
      !/TRID/i.test(L.seller_central_reference_block),
      `${row.claim_submission_id}: Seller Central reference block must not label anything "TRID"`,
    );
    check(
      L.removal_order_refs.every((r) => !UUID_RE.test(r)),
      `${row.claim_submission_id}: removal_order_refs must be external (no UUID)`,
    );
    // Packet message body must not carry internal expected_package UUID as proof
    check(
      !/Internal expected package ref/i.test(row.packet.seller_central_message_body),
      `${row.claim_submission_id}: message body must not include 'Internal expected package ref'`,
    );

    if (row.filing_status === "needs_reference_review") needsReviewCount += 1;
    if (row.ready_to_file) readyCount += 1;
    const fam = row.claim_family ?? "unknown";
    if (L.external_reference_count > 0) familyExternal[fam] = (familyExternal[fam] ?? 0) + 1;
  }

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

  console.log("\n=== SUMMARY ===");
  console.log(`ready_to_file = ${readyCount}`);
  console.log(`needs_reference_review = ${needsReviewCount}`);
  console.log(`claims_with_external_references = ${payload.event_reference_ledger_summary.claims_with_external_references}`);
  console.log(`family external coverage = ${JSON.stringify(familyExternal)}`);
  console.log(`no_db_write_verification = ${noWrite ? "PASS" : "FAIL"} (counts ${JSON.stringify(after)})`);
  console.log(`\n${failures === 0 ? "PHASE OK — all reference-correctness checks passed" : `PHASE FAILED — ${failures} check(s) failed`}`);
  if (failures > 0) process.exitCode = 1;
}

void main();
