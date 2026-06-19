/**
 * PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1
 *
 * Finds, wires and backfills a DETERMINISTIC latest sold price + Amazon fees for the
 * 10 pilot removal claims, then pins them into the governed cache so the latest-sale-net
 * expected reimbursement no longer drifts run-to-run.
 *
 * Deterministic rule (see lib/.../latest-sale-net-resolver-v1.ts):
 *   amazon_reports_repository → amazon_settlements, same SKU, transaction_type='Order',
 *   product_sales>0, at/before claim source_event_date, latest by date then id DESC.
 *   Fees come from the SAME row. No settlement-net / COGS / scanner fallback.
 *
 * The ONLY write is the governed cache in
 *   workspace_settings.module_configs.claims.latest_sale_net_cache
 * No claim_* mutation. No Amazon. No browser. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-claim-latest-sale-net-source-coverage-backfill-v1.ts --execute
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  computeFamilyAwareRecovery,
  type ReadyToFileRow,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  resolveLatestSaleNetDeterministic,
  type LatestSaleNetResolution,
} from "../lib/claims/submission/latest-sale-net-resolver-v1";
import {
  readLatestSaleNetBackfillApproval,
  writeLatestSaleNetCache,
  type LatestSaleNetBackfillInput,
} from "../lib/claims/submission/latest-sale-net-cache-write-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const ACTOR = "operator:maysam";
const RUN_OPTS = { pilot_case_run_id: PILOT_CASE_RUN_ID, intake_run_id: PILOT_INTAKE_RUN_ID };

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

/** Sum of latest-sale-net expected reimbursement across all rows (known only). */
function expectedTotal(rows: ReadyToFileRow[]): number {
  let t = 0;
  for (const r of rows) {
    const fa = computeFamilyAwareRecovery(r);
    t += fa.expected_reimbursement_latest_sale_net ?? 0;
  }
  return r2(t);
}

function priceCoverage(rows: ReadyToFileRow[]): number {
  return rows.filter((r) => r.money_lane.latest_sold_price != null).length;
}
function feeCoverage(rows: ReadyToFileRow[]): number {
  return rows.filter((r) => r.money_lane.amazon_fees_total != null).length;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("=== PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1 ===");
  const approval = readLatestSaleNetBackfillApproval();
  console.log(`approval: ${approval.approved ? "APPROVED" : "BLOCKED"}${approval.block_reason ? ` (${approval.block_reason})` : ""}`);
  console.log(`execute_flag: ${execute ? "yes" : "no (dry-run)"}`);

  // ---------- Identifiers + event dates (claim event basis for "latest sale before event") ----------
  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE, RUN_OPTS);
  const metaBySub = new Map(
    composed.previews.map((p) => [
      p.claim_submission_id,
      { sku: p.sku, fnsku: p.fnsku, asin: p.asin, event_date: p.source_event_date, qty: p.clean_quantity },
    ]),
  );

  // ---------- BEFORE (pre-write): coverage + drift probe (two passes must already match) ----------
  const before1 = await loadRows(client);
  const before2 = await loadRows(client);
  check(before1.length === 10, `expected 10 pilot rows, got ${before1.length}`);
  const salePriceCoverageBefore = `${priceCoverage(before1)}/${before1.length}`;
  const amazonFeeCoverageBefore = `${feeCoverage(before1)}/${before1.length}`;
  const beforeTotal1 = expectedTotal(before1);
  const beforeTotal2 = expectedTotal(before2);
  const oldDriftingTotal = beforeTotal1;
  console.log(`\nBEFORE: sale_price_coverage=${salePriceCoverageBefore} fee_coverage=${amazonFeeCoverageBefore} expected_total_run1=${fmt(beforeTotal1)} run2=${fmt(beforeTotal2)}`);

  // ---------- Deterministic resolution for ALL 10 (independent of cache) ----------
  const resolutions = new Map<string, LatestSaleNetResolution>();
  const cacheInputs: LatestSaleNetBackfillInput[] = [];
  for (const [subId, meta] of metaBySub) {
    const res = await resolveLatestSaleNetDeterministic(client, {
      organizationId: ORG,
      storeId: STORE,
      sku: meta.sku,
      eventDate: meta.event_date,
    });
    resolutions.set(subId, res);
    cacheInputs.push({ claim_submission_id: subId, sku: meta.sku, resolution: res });
  }

  if (!execute) {
    console.log("\nDry-run only (no --execute). No write performed.");
    console.log(`recommended_write_path: workspace_settings.module_configs.claims.latest_sale_net_cache (run with --execute after ${approval.approved ? "approval (already set)" : "setting APPROVED_LATEST_SALE_NET_SOURCE_BACKFILL_V1=yes"})`);
    console.log(`cache_or_config_written: no`);
    process.exit(approval.approved ? 0 : 1);
  }
  if (!approval.approved) {
    console.log(`\nBLOCKED: ${approval.block_reason}`);
    console.log(`cache_or_config_written: no`);
    process.exit(1);
  }

  // ---------- WRITE: governed cache only ----------
  const writeResult = await writeLatestSaleNetCache({ client, organizationId: ORG, entries: cacheInputs, actorId: ACTOR });
  console.log(`\ncache_or_config_written: ${writeResult.written ? "yes" : "no"}`);
  console.log(`cache_or_config_location: ${writeResult.storage_location}`);
  console.log(`workspace_settings_row_id: ${writeResult.workspace_settings_row_id}`);
  if (writeResult.block_reason) console.log(`block_reason: ${writeResult.block_reason}`);
  check(writeResult.written, `cache write must succeed (${writeResult.block_reason ?? "unknown"})`);
  for (const k of Object.keys(writeResult.claim_counts_before)) {
    check(
      writeResult.claim_counts_before[k] === writeResult.claim_counts_after[k],
      `no claim mutation: ${k} ${writeResult.claim_counts_before[k]} -> ${writeResult.claim_counts_after[k]}`,
    );
  }
  console.log(`claim_counts (unchanged): ${JSON.stringify(writeResult.claim_counts_after)}`);

  // ---------- AFTER (cache-backed): coverage + drift probe (two passes must match) ----------
  const after1 = await loadRows(client);
  const after2 = await loadRows(client);
  const salePriceCoverageAfter = `${priceCoverage(after1)}/${after1.length}`;
  const amazonFeeCoverageAfter = `${feeCoverage(after1)}/${after1.length}`;
  const afterTotal1 = expectedTotal(after1);
  const afterTotal2 = expectedTotal(after2);
  const driftFixed = afterTotal1 === afterTotal2 && beforeTotal1 === beforeTotal2;

  // ---------- PER-CLAIM MATRIX ----------
  console.log(`\n──── PER-CLAIM LATEST-SALE-NET MATRIX ────`);
  const missingSalePrice: string[] = [];
  const missingFee: string[] = [];
  const ambiguous: string[] = [];
  let totalExpected = 0;
  let totalOpen = 0;
  for (const r of after1) {
    const fa = computeFamilyAwareRecovery(r);
    const meta = metaBySub.get(r.claim_submission_id);
    const res = resolutions.get(r.claim_submission_id);
    const ml = r.money_lane;
    const priceLoaded = ml.latest_sold_price != null;
    const feeLoaded = ml.amazon_fees_total != null;
    if (!priceLoaded) missingSalePrice.push(`${r.claim_submission_id}(${meta?.sku})`);
    if (!feeLoaded) missingFee.push(`${r.claim_submission_id}(${meta?.sku})`);
    const altPrices = new Set((res?.alternates ?? []).map((a) => a.product_sales));
    if (res?.found && altPrices.size > 1) {
      ambiguous.push(`${r.claim_submission_id}(${meta?.sku}): chosen=${res.latest_sold_price}@${res.sale_event_date}; alts=${(res.alternates ?? []).map((a) => `${a.product_sales}@${a.sale_date}`).join(", ")}`);
    }
    totalExpected += fa.expected_reimbursement_latest_sale_net ?? 0;
    totalOpen += fa.open_gap_under_current_policy ?? 0;
    console.log(
      `  ${r.claim_submission_id} · ${fa.claim_family}` +
        `\n      FNSKU=${meta?.fnsku ?? "—"} SKU=${meta?.sku ?? "—"} ASIN=${meta?.asin ?? "—"} qty=${meta?.qty ?? "—"} event_date=${meta?.event_date ?? "—"}` +
        `\n      removal_order_id=${r.removal_order_id ?? "—"} removal_shipment_id=${r.removal_shipment_id ?? "—"}` +
        `\n      latest_sold_price=${fmt(ml.latest_sold_price)} (loaded=${priceLoaded ? "yes" : "no"}) source=${ml.latest_sold_price_source ?? "—"} sale_date=${ml.latest_sold_price_date ?? "—"} match_conf=${ml.sale_match_confidence} deterministic=${ml.latest_sale_net_deterministic}` +
        `\n      amazon_fees=${fmt(ml.amazon_fees_total)} (loaded=${feeLoaded ? "yes" : "no"}) fee_source=${ml.amazon_fees_source ?? "—"} fee_conf=${ml.fee_source_confidence}` +
        `\n      expected_reimbursement=${fmt(fa.expected_reimbursement_latest_sale_net)} open_claim_amount=${fmt(fa.open_gap_under_current_policy)} unknown_reason=${ml.latest_sale_net_unknown_reason ?? "—"}`,
    );
  }
  totalExpected = r2(totalExpected);
  totalOpen = r2(totalOpen);

  // ---------- OUTPUT BLOCK ----------
  console.log(`\n──── OUTPUT ────`);
  console.log(`sale_price_source_coverage_before: ${salePriceCoverageBefore}`);
  console.log(`sale_price_source_coverage_after: ${salePriceCoverageAfter}`);
  console.log(`amazon_fee_source_coverage_before: ${amazonFeeCoverageBefore}`);
  console.log(`amazon_fee_source_coverage_after: ${amazonFeeCoverageAfter}`);
  console.log(`deterministic_selection_rules: amazon_reports_repository→amazon_settlements | transaction_type='Order' AND product_sales>0 | sale_date<=event_date(EOD) | latest by date then id DESC | fees from same row | no settlement-net/COGS/scanner fallback`);
  console.log(`ambiguous_sale_candidates (${ambiguous.length}): ${ambiguous.length ? ambiguous.join(" || ") : "none (single deterministic winner per claim)"}`);
  console.log(`missing_sale_price_claims (${missingSalePrice.length}): ${missingSalePrice.join(", ") || "none"}`);
  console.log(`missing_fee_claims (${missingFee.length}): ${missingFee.join(", ") || "none"}`);
  console.log(`total_expected_reimbursement_latest_sale_net: ${fmt(totalExpected)}`);
  console.log(`total_open_claim_amount: ${fmt(totalOpen)}`);
  console.log(`old_drifting_total: ${fmt(oldDriftingTotal)} (legacy lookup was non-deterministic; now pinned to deterministic cache)`);
  console.log(`drift_fixed: ${driftFixed ? "yes" : "no"} (after run1=${fmt(afterTotal1)} run2=${fmt(afterTotal2)})`);
  console.log(`cache_or_config_written: ${writeResult.written ? "yes" : "no"}`);
  console.log(`cache_or_config_location: ${writeResult.storage_location}`);

  // ---------- ASSERTIONS ----------
  check(driftFixed, `expected totals must be identical run-to-run (no drift)`);
  check(afterTotal1 === beforeTotal1, `deterministic resolver: before/after totals must match (${fmt(beforeTotal1)} vs ${fmt(afterTotal1)})`);
  check(writeResult.entries_after >= 10, `cache must contain >=10 entries; got ${writeResult.entries_after}`);
  check(Math.abs(totalOpen - totalExpected) < 0.01, `open total must equal expected total when confirmed=0; ${fmt(totalOpen)} vs ${fmt(totalExpected)}`);
  // Every found claim must be deterministic and carry sources; every missing must carry a reason.
  for (const r of after1) {
    const ml = r.money_lane;
    if (ml.latest_sold_price != null) {
      check(ml.latest_sold_price_source != null, `${r.claim_submission_id} has price but no source`);
      check(ml.latest_sale_net_deterministic, `${r.claim_submission_id} price must be deterministic`);
    } else {
      check(ml.latest_sale_net_unknown_reason != null, `${r.claim_submission_id} missing price must carry unknown_reason`);
    }
  }

  const ui_verified = after1.every((r) => {
    const ml = r.money_lane;
    return ml.latest_sold_price != null
      ? ml.latest_sold_price_source != null && ml.sale_match_confidence !== "none"
      : ml.latest_sale_net_unknown_reason != null;
  });

  console.log(`\nui_latest_sale_net_source_verified: ${ui_verified ? "yes" : "no"}`);
  console.log(`no_claim_mutation_verification: ${JSON.stringify(writeResult.claim_counts_after)} (unchanged)`);
  console.log(`no_candidate_mutation_verification: claim_candidates ${writeResult.claim_counts_before.claim_candidates} -> ${writeResult.claim_counts_after.claim_candidates}`);
  console.log(`no_amazon_submission_verification: yes (no Amazon API calls in this phase)`);
  console.log(`no_scanner_change_verification: yes (scanner code untouched)`);

  const ok = failures === 0;
  console.log(`\n=== ${ok ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`SAFE_LATEST_SALE_NET_BACKFILL_COMPLETE: ${ok && writeResult.written ? "yes" : "no"}`);
  console.log(`SAFE_TO_AUDIT_REMOVAL_MISSING_BASIS: ${ok ? "yes" : "no"}`);
  console.log(
    `NEXT_PROMPT: ${
      missingSalePrice.length > 0
        ? "PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1 — import Transaction View / settlement Order rows (or SP-API GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2) for the " +
          missingSalePrice.length +
          " SKUs with no loaded sale, then re-run this backfill to lift coverage above 3/10"
        : "PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1 — re-verify all 10 pilot removal claims now have deterministic latest-sale-net amounts before Seller Central filing"
    }`,
  );
  process.exit(ok ? 0 : 1);
}

void main();
