/**
 * PHASE-CLAIM-DEEP-AMAZON-REFERENCE-LEDGER-V1
 *
 * Read-only deep Amazon reference ledger audit for the 10 pilot ready-to-file claims.
 * Verifies the composer searches every loaded Amazon report/source table, reports a
 * per-source status (found / not found / empty / missing / weak), runs a bounded
 * event-date window candidate pass, and keeps internal UUIDs out of the Seller Central
 * block. Emits the full per-claim + global output contract.
 *
 * No DB writes. No claim_* mutation. No Amazon. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-claim-deep-amazon-reference-ledger-v1.ts
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

  console.log("=== PHASE-CLAIM-DEEP-AMAZON-REFERENCE-LEDGER-V1 (read-only) ===");

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
  const census = payload.deep_reference_census;

  check(allRows.length === 10, `expected 10 pilot rows, got ${allRows.length}`);
  check(payload.event_reference_ledger_summary.built, "ledger must be built");
  check(census.event_date_time_filter_used === true, "event_date_time_filter_used must now be true (window pass)");

  // ---- Source census ----
  console.log("\n── source_tables_checked ──");
  for (const t of census.source_tables_checked) {
    console.log(`  ${t.table.padEnd(28)} status=${t.status.padEnd(10)} org_rows=${t.org_row_count ?? "n/a"} group=${t.group}`);
  }
  console.log(`  source_tables_empty_or_missing = [${census.source_tables_empty_or_missing.join(", ")}]`);

  const totals = {
    external: 0,
    removal_order: 0,
    removal_shipment: 0,
    tracking: 0,
    inventory_ledger: 0,
    transaction: 0,
    reimbursement: 0,
    customer_return: 0,
    report_metadata: 0,
  };

  for (const row of allRows) {
    const L = row.event_reference_ledger;
    console.log(`\n──── ${row.claim_submission_id} · ${row.claim_family} → ${L.filing_sufficiency} ────`);
    console.log(`  product: rpid=${L.product_identity.resolved_product_id ?? "—"} fnsku=${L.product_identity.fnsku ?? "—"} sku=${L.product_identity.sku ?? "—"} asin=${L.product_identity.asin ?? "—"} qty=${L.quantity ?? "—"}`);
    console.log(`  removal_order_refs=[${L.removal_order_refs.join(", ")}]`);
    console.log(`  removal_shipment_refs=[${L.removal_shipment_refs.join(", ")}] tracking=[${L.tracking_refs.join(", ")}]`);
    console.log(`  inventory_ledger=[${L.inventory_ledger_refs.join(", ")}] transaction=[${L.transaction_refs.join(", ")}] reimbursement=[${L.reimbursement_refs.join(", ")}] report_metadata=[${L.report_metadata_refs.join(", ")}]`);
    console.log(`  matched_by=[${L.matched_by.join(", ")}] event_date_window_used=${L.date_window_used} date_window_candidates=${L.date_window_candidate_count}`);
    console.log(`  external_count=${L.external_reference_count} internal_anchors=${L.internal_anchor_count} confidence=${L.confidence}`);
    console.log("  per-source status:");
    for (const g of L.source_groups) {
      console.log(`    - ${g.group.padEnd(22)} ${g.status.padEnd(28)} refs=${g.references.length} candidates=${g.candidate_count}`);
    }
    console.log(`  not_found_sources=[${L.not_found_sources.join(" | ")}]`);
    console.log(`  ambiguous_sources=[${L.ambiguous_sources.join(" | ")}]`);
    console.log(`  references_to_include_in_seller_central:\n    ${L.seller_central_reference_block.replace(/\n/g, "\n    ")}`);

    // ---- Correctness assertions ----
    check(L.source_groups.length >= 7, `${row.claim_submission_id}: must report >=7 source groups`);
    check(L.external_reference_count > 0, `${row.claim_submission_id}: must have >=1 materialized external reference`);
    check(!UUID_RE.test(L.seller_central_reference_block), `${row.claim_submission_id}: Seller Central block must contain NO internal UUID`);
    check(!/TRID/i.test(L.seller_central_reference_block), `${row.claim_submission_id}: Seller Central block must not label anything "TRID"`);
    check(L.removal_order_refs.every((r) => !UUID_RE.test(r)), `${row.claim_submission_id}: removal_order_refs must be external (no UUID)`);
    check(L.report_metadata_refs.every((r) => !UUID_RE.test(r)), `${row.claim_submission_id}: report_metadata_refs must be external (no UUID)`);
    check(!/Internal expected package ref/i.test(row.packet.seller_central_message_body), `${row.claim_submission_id}: message body must not include internal expected package ref`);
    // customer_return group must report the table is not loaded (empty or missing)
    const crGroup = L.source_groups.find((g) => g.group === "customer_return");
    check(
      !!crGroup && (crGroup.status === "source_table_empty" || crGroup.status === "source_table_missing"),
      `${row.claim_submission_id}: customer_return must report source_table_empty/missing (got ${crGroup?.status})`,
    );

    totals.external += L.external_reference_count;
    totals.removal_order += L.removal_order_refs.length;
    totals.removal_shipment += L.removal_shipment_refs.length;
    totals.tracking += L.tracking_refs.length;
    totals.inventory_ledger += L.inventory_ledger_refs.length;
    totals.transaction += L.transaction_refs.length;
    totals.reimbursement += L.reimbursement_refs.length;
    totals.customer_return += L.customer_return_refs.length;
    totals.report_metadata += L.report_metadata_refs.length;
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

  console.log("\n=== GLOBAL OUTPUT ===");
  console.log(`claims_total = ${census.claims_total}`);
  console.log(`claims_complete_reference_count = ${census.claims_complete}`);
  console.log(`claims_filing_sufficient_count = ${census.claims_filing_sufficient}`);
  console.log(`claims_needs_reference_review_count = ${census.claims_needs_reference_review}`);
  console.log(`total_external_references = ${totals.external}`);
  console.log(`total_removal_order_refs = ${totals.removal_order}`);
  console.log(`total_removal_shipment_refs = ${totals.removal_shipment}`);
  console.log(`total_tracking_refs = ${totals.tracking}`);
  console.log(`total_inventory_ledger_refs = ${totals.inventory_ledger}`);
  console.log(`total_transaction_refs = ${totals.transaction}`);
  console.log(`total_reimbursement_refs = ${totals.reimbursement}`);
  console.log(`total_report_metadata_refs = ${totals.report_metadata}`);
  console.log(`event_date_time_filter_used = ${census.event_date_time_filter_used ? "yes" : "no"} (±${census.date_window_days}d)`);
  console.log(`no_db_write_verification = ${noWrite ? "PASS" : "FAIL"} (counts ${JSON.stringify(after)})`);
  console.log(`\n${failures === 0 ? "PHASE OK — deep reference ledger checks passed" : `PHASE FAILED — ${failures} check(s) failed`}`);
  if (failures > 0) process.exitCode = 1;
}

void main();
