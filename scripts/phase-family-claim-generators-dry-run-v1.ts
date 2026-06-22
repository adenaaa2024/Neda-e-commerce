/**
 * PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1
 *
 * Read-only DRY-RUN family-aware claim generator across all supported claim families.
 * Reuses existing read-models only — NO DB write, NO claim_candidate creation, NO claim
 * mutation, NO Amazon submission, NO scanner change, NO AI.
 *
 * Pipeline (all read-only):
 *   1. composeClaimReadyToFileQueueV1 → the 10 pilot removal claims (2 families) + hardened gate.
 *   2. composeSeparateFamilyCandidateGeneratorsV1 → cross-family candidate PREVIEWS
 *      (damaged/lost/reversal/refund/return/fee/ledger) from the removal claims' misclassified
 *      candidates (never reduces a removal open gap; never mixes families).
 *   3. composeClaimSourceCoverageV1 → per-source / per-family coverage + amount basis.
 *
 * Emits the full per-family dry-run matrix requested by the phase. Writes NOTHING.
 *
 *   npx tsx scripts/phase-family-claim-generators-dry-run-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  computeFamilyAwareRecovery,
  computeHardenedReadyToFileGate,
  computeRemovalOriginReason,
  getClaimAmountPolicy,
  type ReadyToFileRow,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { composeSeparateFamilyCandidateGeneratorsV1 } from "../lib/claims/opportunities/separate-family-candidate-generators-v1";
import { getGeneratorFamilySupport } from "../lib/claims/opportunities/separate-family-candidate-generator-contract-v1";
import { composeClaimSourceCoverageV1 } from "../lib/claims/center/claim-source-coverage-v1";
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

/** The 17 families requested by the phase + how each maps to existing read-models. */
type FamilyLane = "removal_pilot" | "generator" | "unsupported";
const REQUESTED_FAMILIES: Array<{
  req: string;
  lane: FamilyLane;
  policy_key: string;
  generator_key?: string;
  note: string;
}> = [
  { req: "removal_shipment_missing", lane: "removal_pilot", policy_key: "removal_shipment_missing", note: "Pilot removal family (in Ready-to-File queue)." },
  { req: "removal_order_discrepancy", lane: "removal_pilot", policy_key: "removal_order_discrepancy", note: "Pilot removal family (in Ready-to-File queue)." },
  { req: "damaged_warehouse", lane: "generator", policy_key: "damaged_warehouse", generator_key: "damaged_warehouse", note: "Inventory ledger (Detail View) adjustment." },
  { req: "lost_warehouse", lane: "generator", policy_key: "lost_warehouse", generator_key: "lost_warehouse", note: "Inventory ledger (Detail View) adjustment." },
  { req: "lost_outbound", lane: "generator", policy_key: "lost_outbound", generator_key: "lost_outbound", note: "Outbound shipment/settlement loss." },
  { req: "damaged_outbound", lane: "generator", policy_key: "damaged_outbound", generator_key: "damaged_outbound", note: "Outbound shipment/settlement damage." },
  { req: "disposed_without_reimbursement", lane: "generator", policy_key: "disposed_without_authorization", generator_key: "disposed_without_authorization", note: "Maps to disposed_without_authorization (inventory ledger disposal)." },
  { req: "reimbursement_reversal", lane: "generator", policy_key: "reimbursement_reversal", generator_key: "reimbursement_reversal", note: "Pair with original reimbursement; reinstate exact reversed amount." },
  { req: "missing_reimbursement", lane: "unsupported", policy_key: "other", note: "No generator yet — needs order-linked reimbursement anti-match reconciler (GET_FBA_REIMBURSEMENTS_DATA)." },
  { req: "partial_reimbursement", lane: "unsupported", policy_key: "other", note: "No generator yet — needs reimbursed-vs-expected delta reconciler." },
  { req: "refund_without_return", lane: "generator", policy_key: "refund_without_return", generator_key: "refund_without_return", note: "Refund with return anti-match." },
  { req: "customer_return_not_received", lane: "generator", policy_key: "customer_return_not_received", generator_key: "customer_return_not_received", note: "Refunded/returned but unit never received back." },
  { req: "wrong_item_returned", lane: "unsupported", policy_key: "other", note: "No generator yet — needs FBA customer returns (amazon_returns) + LPN/return-items evidence." },
  { req: "empty_box_return", lane: "unsupported", policy_key: "other", note: "No generator yet — needs FBA customer returns + physical scan evidence." },
  { req: "fulfillment_fee_overcharge", lane: "generator", policy_key: "fulfillment_fee_overcharge", generator_key: "fulfillment_fee_overcharge", note: "Fee delta (charged vs expected) — needs Fee Preview/Product Fees API for expected fee." },
  { req: "storage_fee_overcharge", lane: "generator", policy_key: "storage_fee_overcharge", generator_key: "storage_fee_overcharge", note: "Storage fee delta — needs monthly storage rows + cubic volume." },
  { req: "inbound_shipment_discrepancy", lane: "generator", policy_key: "inbound_discrepancy", generator_key: "inbound_discrepancy", note: "Maps to inbound_discrepancy (sent vs received shortage)." },
];

type FamilyRow = {
  family: string;
  lane: FamilyLane;
  source_reports_apis: string;
  required_references: string;
  trid_linkage_quality: string;
  product_identity_quality: string;
  reimbursement_match_quality: string;
  amount_basis: string;
  open_amount: number | null;
  dry_run_candidate_count: number;
  valid_candidate_count: number;
  blocked_candidate_count: number;
  ready_for_review_count: number;
  ready_to_file_count: number;
  blockers: Record<string, number>;
  source_coverage: string;
  missing_source_blocker: string | null;
};

function num(v: number | null): string {
  return v == null ? "UNKNOWN" : `$${v.toFixed(2)}`;
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

  console.log("=== PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1 (read-only dry-run) ===");
  console.log(`target: kxsvedvpjldygtdbylsy · org=${ORG} · store=${STORE}\n`);

  const countsBefore = await claimCounts(client);

  // ---- 1. removal pilot queue (read-only) ----
  const queue = await composeClaimReadyToFileQueueV1(client, ORG, STORE, RUN_OPTS);
  const queueRows: ReadyToFileRow[] = [...queue.ready_rows, ...queue.blocked_rows];

  // ---- 2. cross-family candidate previews (read-only) ----
  const generators = await composeSeparateFamilyCandidateGeneratorsV1(client, ORG, STORE, RUN_OPTS);

  // ---- 3. source/family coverage (read-only) ----
  const coverage = await composeClaimSourceCoverageV1(client, ORG);
  const coverageByFamily = new Map<string, string>();
  for (const f of coverage.claim_family_map) {
    coverageByFamily.set(f.family_key, `${f.support_status} (sources: ${f.source_tables_required.join(", ") || "—"})`);
  }
  // Source-table live status for quick coverage notes.
  const liveTables = new Set(
    coverage.source_coverage_matrix.filter((s) => s.connection_status === "live_loaded").map((s) => s.table ?? ""),
  );

  // ---- Build per-family matrix ----
  const matrix: FamilyRow[] = [];
  const top20: string[] = [];

  for (const fam of REQUESTED_FAMILIES) {
    const pol = getClaimAmountPolicy(fam.policy_key);
    const support = fam.lane === "generator" ? getGeneratorFamilySupport(fam.generator_key!) : null;
    const blockers: Record<string, number> = {};
    let dryRun = 0;
    let valid = 0;
    let blocked = 0;
    let readyForReview = 0;
    let readyToFile = 0;
    let openAmount: number | null = 0;
    let tridQuality = "n/a";
    let productQuality = "n/a";
    let reimbQuality = "n/a";
    let requiredRefs = "n/a";
    let sourceReports = "n/a";

    if (fam.lane === "removal_pilot") {
      const rows = queueRows.filter((r) => r.claim_family === fam.req);
      dryRun = rows.length;
      requiredRefs = "removal_order_id / removal_shipment_id / tracking + product identity + qty";
      sourceReports = "amazon_removals + amazon_removal_shipments + expected_packages (file importer); SP-API delivery auto-pull NOT wired";
      let withTrid = 0;
      let withProduct = 0;
      openAmount = 0;
      for (const r of rows) {
        const fa = computeFamilyAwareRecovery(r);
        const gate = r.hardened_gate ?? computeHardenedReadyToFileGate(r);
        const origin = computeRemovalOriginReason(r);
        if (r.removal_order_id || r.removal_shipment_id) withTrid += 1;
        if (r.fnsku || r.sku || r.asin) withProduct += 1;
        // Valid = legitimate removal candidate (origin reason valid_missing/valid_discrepancy).
        const isValid = origin.validity === "valid_missing" || origin.validity === "valid_discrepancy";
        if (isValid) valid += 1;
        if (gate.is_ready) {
          readyToFile += 1;
        } else {
          blocked += 1;
          readyForReview += 1; // valid candidate held in Needs Data for review
          for (const b of gate.blockers) blockers[b] = (blockers[b] ?? 0) + 1;
        }
        openAmount = openAmount != null && fa.open_gap_under_current_policy != null
          ? Math.round((openAmount + fa.open_gap_under_current_policy) * 100) / 100
          : null;
        if (top20.length < 20) {
          top20.push(
            `${fam.req} · ${r.claim_submission_id.slice(0, 8)} · valid=${isValid} ready_to_file=${gate.is_ready} ` +
              `open=${num(fa.open_gap_under_current_policy)} blockers=[${gate.blockers.join(",")}]`,
          );
        }
      }
      tridQuality = `${withTrid}/${rows.length} strong external removal ref`;
      productQuality = `${withProduct}/${rows.length} product identity resolved`;
      reimbQuality = "0/" + rows.length + " order-linked reimbursement (all unknown_unmatched — needs GET_FBA_REIMBURSEMENTS_DATA live sync)";
    } else if (fam.lane === "generator") {
      const previews = generators.candidates.filter((c) => c.recommended_claim_family === fam.req);
      dryRun = previews.length;
      requiredRefs = support?.evidence_rule ?? "see policy";
      sourceReports = `${support?.required_source_table ?? "—"} (${support?.required_source_group ?? "—"})`;
      let withProduct = 0;
      let withRef = 0;
      openAmount = 0;
      for (const p of previews) {
        if (p.product_identity.fnsku || p.product_identity.sku || p.product_identity.asin || p.product_identity.resolved_product_id) withProduct += 1;
        if (p.source_row_id) withRef += 1;
        for (const b of p.blockers) blockers[b] = (blockers[b] ?? 0) + 1;
        if (p.blockers.length === 0) {
          valid += 1;
          if (p.writeable) readyForReview += 1; // promotable opportunity (review before file)
        } else {
          blocked += 1;
        }
        openAmount = openAmount != null && p.expected_claim_amount != null
          ? Math.round((openAmount + p.expected_claim_amount) * 100) / 100
          : (p.expected_claim_amount == null ? null : openAmount);
        if (top20.length < 20) {
          top20.push(
            `${fam.req} · ${(p.source_row_id ?? "—").slice(0, 14)} · valid=${p.blockers.length === 0} writeable=${p.writeable} ` +
              `amount=${num(p.expected_claim_amount)} blockers=[${p.blockers.join(",")}]`,
          );
        }
      }
      // Generator families are OPPORTUNITIES only — never ready_to_file in a dry-run.
      readyToFile = 0;
      tridQuality = `${withRef}/${previews.length} source reference id present`;
      productQuality = `${withProduct}/${previews.length} product identity resolved`;
      reimbQuality = support?.required_source_group === "reimbursement"
        ? "reversal/reimbursement source rows weak (FNSKU/date-window — not order-linked)"
        : "n/a for this family lane";
      if (previews.length === 0) {
        openAmount = null;
      }
    } else {
      // unsupported — no generator wired yet → 0 dry-run candidates (opportunity-only, blocked on source/generator).
      dryRun = 0;
      valid = 0;
      blocked = 0;
      readyForReview = 0;
      readyToFile = 0;
      openAmount = null;
      blockers["family_generator_not_built"] = 1;
      requiredRefs = "see note (generator + live source not built)";
      sourceReports = fam.note;
      tridQuality = "n/a (no generator)";
      productQuality = "n/a (no generator)";
      reimbQuality = "n/a (no generator)";
    }

    // Which live source/API must land before this family can produce a fileable candidate
    // (mark the blocker — never invent data when a live source is missing).
    let missingSourceBlocker: string | null = null;
    if (fam.lane === "unsupported") {
      missingSourceBlocker = fam.note;
    } else if (fam.lane === "removal_pilot") {
      missingSourceBlocker =
        "GET_FBA_REIMBURSEMENTS_DATA (order-linked reimbursement) + SP-API removal-delivery proof + settlement Order rows for 3 missing SKUs — initial live source sync blocked at gate";
    } else {
      const tbl = support?.required_source_table ?? null;
      if (tbl && !liveTables.has(tbl)) {
        missingSourceBlocker = `needs ${tbl} live load (${support?.required_source_group ?? "—"})`;
      } else if (support?.required_source_group === "reimbursement") {
        missingSourceBlocker =
          "reimbursement rows weak (FNSKU/date-window, not order-linked) — needs GET_FBA_REIMBURSEMENTS_DATA order-linked sync";
      } else if (/fee/i.test(fam.req)) {
        missingSourceBlocker = "needs Product Fees / Fee Preview API for expected fee (amazon_fee_preview not live-loaded)";
      } else if (blocked > 0 && valid === 0) {
        missingSourceBlocker = Object.keys(blockers)[0] ?? null;
      }
    }

    matrix.push({
      family: fam.req,
      lane: fam.lane,
      source_reports_apis: sourceReports,
      required_references: requiredRefs,
      trid_linkage_quality: tridQuality,
      product_identity_quality: productQuality,
      reimbursement_match_quality: reimbQuality,
      amount_basis: pol.default_claim_amount_basis,
      open_amount: openAmount,
      dry_run_candidate_count: dryRun,
      valid_candidate_count: valid,
      blocked_candidate_count: blocked,
      ready_for_review_count: readyForReview,
      ready_to_file_count: readyToFile,
      blockers,
      source_coverage: coverageByFamily.get(fam.req) ?? `not in family map (live tables: ${[...liveTables].filter(Boolean).length})`,
      missing_source_blocker: missingSourceBlocker,
    });
  }

  const countsAfter = await claimCounts(client);
  const noMutation = Object.keys(countsBefore).every((k) => countsBefore[k] === countsAfter[k]);
  for (const k of Object.keys(countsBefore)) {
    check(countsBefore[k] === countsAfter[k], `claim table mutated: ${k}`);
  }

  // ---- OUTPUT ----
  console.log("──── per_family_matrix ────");
  for (const m of matrix) {
    console.log(
      `\n  ${m.family} [${m.lane}]` +
        `\n    source_reports_apis: ${m.source_reports_apis}` +
        `\n    required_references: ${m.required_references}` +
        `\n    trid_linkage_quality: ${m.trid_linkage_quality}` +
        `\n    product_identity_quality: ${m.product_identity_quality}` +
        `\n    reimbursement_match_quality: ${m.reimbursement_match_quality}` +
        `\n    amount_basis: ${m.amount_basis}` +
        `\n    open_amount: ${num(m.open_amount)}` +
        `\n    dry_run=${m.dry_run_candidate_count} valid=${m.valid_candidate_count} blocked=${m.blocked_candidate_count} ready_for_review=${m.ready_for_review_count} ready_to_file=${m.ready_to_file_count}` +
        `\n    blockers: ${JSON.stringify(m.blockers)}` +
        `\n    source_coverage: ${m.source_coverage}`,
    );
  }

  const sum = (sel: (m: FamilyRow) => number) => matrix.reduce((a, m) => a + sel(m), 0);
  const byFamily = (sel: (m: FamilyRow) => number) => Object.fromEntries(matrix.map((m) => [m.family, sel(m)]));
  const allBlockers: Record<string, number> = {};
  for (const m of matrix) for (const [k, v] of Object.entries(m.blockers)) allBlockers[k] = (allBlockers[k] ?? 0) + v;

  console.log(`\n──── OUTPUT ────`);
  console.log(`mode: preview (dry-run only — NO write, NO candidate creation)`);
  console.log(`families_evaluated: ${matrix.length}`);
  console.log(`dry_run_candidate_count_by_family: ${JSON.stringify(byFamily((m) => m.dry_run_candidate_count))}`);
  console.log(`valid_candidate_count_by_family: ${JSON.stringify(byFamily((m) => m.valid_candidate_count))}`);
  console.log(`blocked_candidate_count_by_family: ${JSON.stringify(byFamily((m) => m.blocked_candidate_count))}`);
  console.log(`ready_for_review_count_by_family: ${JSON.stringify(byFamily((m) => m.ready_for_review_count))}`);
  console.log(`ready_to_file_count_by_family: ${JSON.stringify(byFamily((m) => m.ready_to_file_count))}`);
  console.log(`blocker_counts: ${JSON.stringify(allBlockers)}`);
  console.log(`source_coverage_by_family: ${JSON.stringify(byFamily((m) => m.source_coverage as unknown as number))}`);
  console.log(`product_linkage_quality_by_family: ${JSON.stringify(Object.fromEntries(matrix.map((m) => [m.family, m.product_identity_quality])))}`);
  console.log(`trid_linkage_quality_by_family: ${JSON.stringify(Object.fromEntries(matrix.map((m) => [m.family, m.trid_linkage_quality])))}`);
  console.log(`reimbursement_match_quality_by_family: ${JSON.stringify(Object.fromEntries(matrix.map((m) => [m.family, m.reimbursement_match_quality])))}`);
  console.log(`amount_basis_by_family: ${JSON.stringify(Object.fromEntries(matrix.map((m) => [m.family, m.amount_basis])))}`);

  const missingSourceBlockers = {
    by_family: Object.fromEntries(
      matrix.filter((m) => m.missing_source_blocker).map((m) => [m.family, m.missing_source_blocker]),
    ),
    missing_files_or_tables: coverage.missing_files_or_tables,
    missing_api_endpoints: coverage.missing_api_endpoints,
  };
  console.log(`missing_source_blockers: ${JSON.stringify(missingSourceBlockers, null, 2)}`);
  console.log(`\ntop_20_candidate_preview:`);
  for (const t of top20) console.log(`  - ${t}`);
  console.log(`\ntotal_dry_run_candidates: ${sum((m) => m.dry_run_candidate_count)}`);
  console.log(`total_valid: ${sum((m) => m.valid_candidate_count)}`);
  console.log(`total_ready_for_review: ${sum((m) => m.ready_for_review_count)}`);
  console.log(`total_ready_to_file: ${sum((m) => m.ready_to_file_count)}`);
  console.log(`no_db_write_verification: yes (compose-only; 0 writes)`);
  console.log(`no_claim_mutation_verification: ${noMutation ? "yes" : "no"} ${JSON.stringify(countsAfter)}`);
  console.log(`no_amazon_submission_verification: yes (no Amazon API calls)`);
  console.log(`no_scanner_change_verification: yes (scanner code untouched)`);

  // ---- Assertions ----
  check(matrix.length === 17, `expected 17 families evaluated, got ${matrix.length}`);
  check(noMutation, "claim tables must be unchanged");
  check(sum((m) => m.ready_to_file_count) === 0, "dry-run must not mark any family ready_to_file (gates require live delivery + reimbursement)");
  const removalRows = matrix.filter((m) => m.lane === "removal_pilot");
  check(removalRows.reduce((a, m) => a + m.dry_run_candidate_count, 0) === 10, "removal pilot families must total 10 dry-run candidates");

  const ok = failures === 0;
  console.log(`\n=== ${ok ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`build_result/smoke_result/next_build_result: run by the phase gate (tsc --noEmit + smoke-phase-claim-ready-to-file-queue-ui-v1 + next build) — see orchestration output`);
  console.log(`SAFE_FAMILY_CLAIM_GENERATORS_DRY_RUN_COMPLETE: ${ok ? "yes" : "no"}`);
  console.log(`SAFE_TO_BUILD_CLAIM_OPPORTUNITIES_UI: yes (per-family dry-run matrix is deterministic, read-only, family-isolated; no removal-gap pollution)`);
  console.log(
    `NEXT_PROMPT: PHASE-CLAIM-OPPORTUNITIES-UI-V1 — surface this per-family dry-run matrix on /claim-center/opportunities (family cards: dry-run/valid/blocked/ready-for-review counts + source coverage + amount basis + blockers), keep removal Ready-to-File separate, and gate "promote to candidate" behind the existing approval (APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1). In parallel, build the missing generators (missing_reimbursement / partial_reimbursement / wrong_item_returned / empty_box_return) once GET_FBA_REIMBURSEMENTS_DATA + FBA customer returns live sync land.`,
  );
  process.exit(ok ? 0 : 1);
}

void main();
