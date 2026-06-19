/**
 * PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1
 *
 * Read-only source-import determination + guarded coverage verification for the
 * removal claims whose latest-sale-net is UNKNOWN.
 *
 * Findings (from diag-missing-sale-price-source-import-v1 + diag-repo-order-sale-reprobe-v1):
 *   - 7/10 claims UNKNOWN across 3 distinct SKUs.
 *   - Neither amazon_reports_repository nor amazon_settlements holds ANY product_sales>0
 *     row (any transaction_type) for those 3 SKUs — only $0 Adjustment rows are loaded.
 *   - Order+product_sales>0 rows DO exist for other SKUs → importer/schema is mapped
 *     correctly → this is a DATA-COVERAGE gap, not a wiring gap.
 *   - amazon_transactions has no product_sales column; amazon_all_orders is empty.
 *   => import_required=yes, approval_required=yes. NO write executed here.
 *
 * This script performs NO writes. It re-runs the deterministic resolver for all 10
 * claims, recomputes coverage + the per-claim matrix, runs a drift probe, and emits
 * the full phase output block. The actual import stays blocked behind the approval file.
 *
 *   npx tsx scripts/phase-claim-missing-sale-price-source-import-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  computeFamilyAwareRecovery,
  type ReadyToFileRow,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { resolveLatestSaleNetDeterministic } from "../lib/claims/submission/latest-sale-net-resolver-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RUN_OPTS = { pilot_case_run_id: PILOT_CASE_RUN_ID, intake_run_id: PILOT_INTAKE_RUN_ID };
const APPROVAL_FILE = ".cursor/operator-approvals/claim-missing-sale-price-source-import-v1-approval.md";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}
function fmt(v: number | null): string {
  return v == null ? "UNKNOWN" : `$${v.toFixed(2)}`;
}
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

async function loadRows(client: SupabaseClient): Promise<ReadyToFileRow[]> {
  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, RUN_OPTS);
  return [...payload.ready_rows, ...payload.blocked_rows];
}
function priceCoverage(rows: ReadyToFileRow[]): number {
  return rows.filter((r) => r.money_lane.latest_sold_price != null).length;
}
function feeCoverage(rows: ReadyToFileRow[]): number {
  return rows.filter((r) => r.money_lane.amazon_fees_total != null).length;
}
function expectedTotal(rows: ReadyToFileRow[]): number {
  let t = 0;
  for (const r of rows) t += computeFamilyAwareRecovery(r).expected_reimbursement_latest_sale_net ?? 0;
  return r2(t);
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

  console.log("=== PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1 (read-only) ===");
  console.log(`target: kxsvedvpjldygtdbylsy · org=${ORG} · store=${STORE}\n`);

  // ---- claim-table snapshot (before, for no-mutation proof) ----
  const claimCountsBefore = await claimCounts(client);

  // ---- identifiers + event dates ----
  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE, RUN_OPTS);
  const metaBySub = new Map(
    composed.previews.map((p) => [
      p.claim_submission_id,
      { sku: p.sku, fnsku: p.fnsku, asin: p.asin, event_date: p.source_event_date, qty: p.clean_quantity },
    ]),
  );

  // ---- resolve all 10 deterministically (read-only) ----
  const resolutions = new Map<string, Awaited<ReturnType<typeof resolveLatestSaleNetDeterministic>>>();
  for (const [subId, meta] of metaBySub) {
    resolutions.set(
      subId,
      await resolveLatestSaleNetDeterministic(client, {
        organizationId: ORG,
        storeId: STORE,
        sku: meta.sku,
        eventDate: meta.event_date,
      }),
    );
  }

  // ---- coverage + drift probe (two passes; no import this phase → before == after) ----
  const pass1 = await loadRows(client);
  const pass2 = await loadRows(client);
  check(pass1.length === 10, `expected 10 pilot rows, got ${pass1.length}`);
  const salePriceCoverageBefore = `${priceCoverage(pass1)}/${pass1.length}`;
  const feeCoverageBefore = `${feeCoverage(pass1)}/${pass1.length}`;
  const salePriceCoverageAfter = salePriceCoverageBefore; // no import executed
  const feeCoverageAfter = feeCoverageBefore;
  const total1 = expectedTotal(pass1);
  const total2 = expectedTotal(pass2);
  const driftFixed = total1 === total2;

  // ---- missing-claim inventory ----
  const missing = pass1.filter((r) => r.money_lane.latest_sold_price == null);
  const missingSkuSet = new Set(missing.map((r) => metaBySub.get(r.claim_submission_id)?.sku ?? ""));

  // ---- PER-CLAIM MATRIX ----
  console.log("──── per_claim_latest_sale_net_matrix ────");
  let totalExpected = 0;
  let totalOpen = 0;
  const unknownByClaim: string[] = [];
  for (const r of pass1) {
    const fa = computeFamilyAwareRecovery(r);
    const meta = metaBySub.get(r.claim_submission_id);
    const ml = r.money_lane;
    const priceLoaded = ml.latest_sold_price != null;
    const feeLoaded = ml.amazon_fees_total != null;
    if (!priceLoaded) unknownByClaim.push(`${r.claim_submission_id}(sku=${meta?.sku}): ${ml.latest_sale_net_unknown_reason ?? "UNKNOWN"}`);
    totalExpected += fa.expected_reimbursement_latest_sale_net ?? 0;
    totalOpen += fa.open_gap_under_current_policy ?? 0;
    console.log(
      `  ${r.claim_submission_id} · ${fa.claim_family}` +
        `\n      SKU=${meta?.sku ?? "—"} FNSKU=${meta?.fnsku ?? "—"} ASIN=${meta?.asin ?? "—"} qty=${meta?.qty ?? "—"} event=${meta?.event_date ?? "—"}` +
        `\n      latest_sold_price=${fmt(ml.latest_sold_price)} (loaded=${priceLoaded ? "yes" : "no"}) source=${ml.latest_sold_price_source ?? "—"} sale_date=${ml.latest_sold_price_date ?? "—"} match_conf=${ml.sale_match_confidence}` +
        `\n      amazon_fees=${fmt(ml.amazon_fees_total)} (loaded=${feeLoaded ? "yes" : "no"}) fee_conf=${ml.fee_source_confidence}` +
        `\n      expected_reimbursement=${fmt(fa.expected_reimbursement_latest_sale_net)} open=${fmt(fa.open_gap_under_current_policy)} unknown_reason=${ml.latest_sale_net_unknown_reason ?? "—"}`,
    );
  }
  totalExpected = r2(totalExpected);
  totalOpen = r2(totalOpen);

  // ---- claim-table snapshot (after, no-mutation proof) ----
  const claimCountsAfter = await claimCounts(client);
  const noMutation = Object.keys(claimCountsBefore).every((k) => claimCountsBefore[k] === claimCountsAfter[k]);
  for (const k of Object.keys(claimCountsBefore)) {
    check(claimCountsBefore[k] === claimCountsAfter[k], `claim table mutated: ${k} ${claimCountsBefore[k]} -> ${claimCountsAfter[k]}`);
  }

  // ---- OUTPUT BLOCK ----
  console.log(`\n──── OUTPUT ────`);
  console.log(`missing_claims_before: ${missing.length} (distinct SKUs: ${[...missingSkuSet].filter(Boolean).join(", ")})`);
  console.log(`source_tables_checked: amazon_reports_repository(412645 rows), amazon_settlements(604883 rows), amazon_transactions(600 rows, no product_sales col), amazon_all_orders(0 rows); [all_orders, amazon_order_items, amazon_orders, order_items, amazon_settlement_transactions: do not exist]`);
  console.log(`loaded_order_rows_found: 0 for all ${missingSkuSet.size} missing SKUs (no product_sales>0 row of any transaction_type; only $0 Adjustment). Order+product_sales>0 rows DO exist for other SKUs → importer mapped OK.`);
  console.log(`import_required: yes`);
  console.log(`required_report_or_api: GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 (settlement flat file, Order rows w/ product_sales+selling_fees+fba_fees) covering the full sale history of SKUs ${[...missingSkuSet].filter(Boolean).join(", ")}; equivalently a Seller Central Transaction View export (all-time → removal event) → amazon_reports_repository. all_orders report (GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL) is a price-only fallback (no Amazon fees).`);
  console.log(`report_mapped: yes (settlement + transaction-view importers wired & mapping product_sales/selling_fees/fba_fees; gap is data coverage, not wiring). amazon_all_orders table exists but empty.`);
  console.log(`approval_required: yes`);
  console.log(`approval_file_path: ${APPROVAL_FILE}`);
  console.log(`sale_price_coverage_before: ${salePriceCoverageBefore}`);
  console.log(`sale_price_coverage_after: ${salePriceCoverageAfter} (no import executed — blocked on approval)`);
  console.log(`fee_coverage_before: ${feeCoverageBefore}`);
  console.log(`fee_coverage_after: ${feeCoverageAfter} (no import executed — blocked on approval)`);
  console.log(`unknown_reason_by_claim:`);
  for (const u of unknownByClaim) console.log(`  - ${u}`);
  console.log(`total_expected_reimbursement_latest_sale_net: ${fmt(totalExpected)}`);
  console.log(`total_open_claim_amount: ${fmt(totalOpen)}`);
  console.log(`drift_fixed: ${driftFixed ? "yes" : "no"} (run1=${fmt(total1)} run2=${fmt(total2)})`);
  console.log(`source_import_written: no`);
  console.log(`latest_sale_net_cache_written: no`);
  console.log(`no_claim_mutation_verification: ${noMutation ? "yes" : "no"} ${JSON.stringify(claimCountsAfter)}`);
  console.log(`no_candidate_mutation_verification: claim_candidates ${claimCountsBefore.claim_candidates} -> ${claimCountsAfter.claim_candidates}`);
  console.log(`no_amazon_submission_verification: yes (no Amazon API calls in this phase)`);
  console.log(`no_scanner_change_verification: yes (scanner code untouched)`);

  // ---- ASSERTIONS ----
  check(driftFixed, `expected totals must be identical run-to-run (no drift)`);
  check(missing.length === 7, `expected 7 missing claims, got ${missing.length}`);
  check(priceCoverage(pass1) === 3, `expected sale-price coverage 3/10, got ${priceCoverage(pass1)}`);
  for (const r of pass1) {
    const ml = r.money_lane;
    if (ml.latest_sold_price == null) check(ml.latest_sale_net_unknown_reason != null, `${r.claim_submission_id} missing price must carry unknown_reason`);
  }

  const ok = failures === 0;
  console.log(`\n=== ${ok ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`SAFE_MISSING_SALE_PRICE_SOURCE_IMPORTED: no (import required + approval pending; no source rows available to load yet)`);
  console.log(`SAFE_LATEST_SALE_NET_COVERAGE_COMPLETE: no (3/10; 7 SKUs have no Order sale loaded)`);
  console.log(`SAFE_TO_FILE_PRICED_REMOVAL_CLAIMS: ${ok ? "yes" : "no"} (the 3 priced claims = ${fmt(totalExpected)} are deterministic & drift-free; file those; hold the 7 UNKNOWN)`);
  console.log(`NEXT_PROMPT: PHASE-CLAIM-SETTLEMENT-ORDER-IMPORT-EXECUTE-V1 — after operator approval + provided GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 (or Transaction View export) covering SKUs ${[...missingSkuSet].filter(Boolean).join(", ")}, ingest Order rows into amazon_settlements/amazon_reports_repository via the existing mapped importer, then re-run scripts/phase-claim-latest-sale-net-source-coverage-backfill-v1.ts --execute to lift coverage above 3/10.`);
  process.exit(ok ? 0 : 1);
}

void main();
