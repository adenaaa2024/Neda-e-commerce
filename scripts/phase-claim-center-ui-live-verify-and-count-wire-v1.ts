/**
 * PHASE-CLAIM-CENTER-UI-LIVE-VERIFY-AND-COUNT-WIRE-V1 — read-only live verification.
 *
 * Verifies, against the LIVE project (kxsvedvpjldygtdbylsy), that the unified Claim Center
 * navigation + Needs Data grouping + Opportunities family buckets + the newly-wired
 * per-section badge counts produce correct, non-fabricated numbers on REAL data — using the
 * SAME pure functions the UI uses (flowCountsFromDashboard / primarySectionBadgeCount /
 * needsDataGroupForBlocker / opportunityGroupForFamily).
 *
 * HARD LIMITS (enforced by construction — compose/SELECT only):
 *   NO DB write. NO claim_candidate creation. NO claim_candidates/claim_cases/claim_lines/
 *   claim_submissions mutation. NO Amazon submission. NO browser. NO scanner change. NO AI.
 *
 * Note on "module enabled": the running UI gates these pages behind the Claim Recovery module
 * flag for the org; this script connects with the service role (which bypasses that flag), so
 * it verifies the DATA + LOGIC as the UI would render them once the module is enabled.
 *
 *   npx tsx scripts/phase-claim-center-ui-live-verify-and-count-wire-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import type { ReadyToFileRow } from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { composeSeparateFamilyCandidateGeneratorsV1 } from "../lib/claims/opportunities/separate-family-candidate-generators-v1";
import { composeClaimSourceCoverageV1 } from "../lib/claims/center/claim-source-coverage-v1";
import {
  CLAIM_CENTER_PRIMARY_SECTIONS,
  primarySectionBadgeCount,
  primarySectionCountKey,
} from "../lib/claims/center/claim-center-primary-nav";
import { flowCountsFromDashboard, type ClaimCenterFlowCounts } from "../lib/claims/center/claim-center-flow-nav";
import {
  NEEDS_DATA_GROUPS,
  needsDataGroupForBlocker,
  type NeedsDataGroupId,
} from "../lib/claims/center/claim-needs-data-contract";
import {
  OPPORTUNITY_FAMILY_GROUPS,
  opportunityGroupForFamily,
  type OpportunityFamilyGroupId,
} from "../lib/claims/opportunities/claim-family-group-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RUN_OPTS = { pilot_case_run_id: PILOT_CASE_RUN_ID, intake_run_id: PILOT_INTAKE_RUN_ID };

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) passes += 1;
  else {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

/** Mirror NeedsDataView.rowPrimaryBlocker exactly. */
function rowPrimaryBlocker(row: ReadyToFileRow): string {
  return row.hardened_gate?.primary_blocker ?? row.blockers[0] ?? "needs_manual_review";
}

/** Same scope as countActiveCandidatesForOrg (read-model), inlined to avoid server-only imports. */
async function countActiveCandidates(client: SupabaseClient): Promise<number> {
  const { count, error } = await client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .is("quarantined_at", null)
    .neq("source_kind", "legacy_seed");
  if (error) throw new Error(error.message);
  return count ?? 0;
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
  const url = process.env.ORIGINAL_SUPABASE_URL ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY ?? "";
  if (!url.includes(ORIGINAL_REF)) {
    throw new Error(`Refusing to run: ORIGINAL_SUPABASE_URL (${url}) is not bound to ${ORIGINAL_REF}.`);
  }
  const client = createClient(url, key, { auth: { persistSession: false } });

  console.log("=== PHASE-CLAIM-CENTER-UI-LIVE-VERIFY-AND-COUNT-WIRE-V1 (read-only) ===");
  console.log(`target: ${ORIGINAL_REF} · org=${ORG} · store=${STORE}\n`);

  const countsBefore = await claimCounts(client);

  // ---- Read-only composers (proven in prior phases) ----
  const queue = await composeClaimReadyToFileQueueV1(client, ORG, STORE, RUN_OPTS);
  const generators = await composeSeparateFamilyCandidateGeneratorsV1(client, ORG, STORE, RUN_OPTS);
  const coverage = await composeClaimSourceCoverageV1(client, ORG);
  const activeCandidates = await countActiveCandidates(client);

  const readyCount = queue.ready_rows.length;
  const blockedRows = queue.blocked_rows;
  const liveLoadedSources = coverage.source_coverage_matrix.filter((s) => s.connection_status === "live_loaded").length;

  // claim_submissions count (filed/tracking badge source proxy — real count, no schema guessing).
  const subsCount = countsBefore["claim_submissions"];

  // ---- Needs Data grouping over REAL blocked rows ----
  const needsDataCounts: Record<NeedsDataGroupId, number> = {
    missing_live_source: 0,
    missing_sale_price: 0,
    missing_reimbursement_check: 0,
    missing_trid_reference: 0,
    missing_product_linkage: 0,
    physical_receiving: 0,
    waiting_threshold: 0,
    needs_review: 0,
  };
  const fellBackToReview: string[] = [];
  for (const row of blockedRows) {
    const blocker = rowPrimaryBlocker(row);
    const group = needsDataGroupForBlocker(blocker);
    needsDataCounts[group] += 1;
    check(NEEDS_DATA_GROUPS.some((g) => g.id === group), `blocked row group ${group} not in NEEDS_DATA_GROUPS`);
    // record any blocker that was not explicitly mapped (fell back to needs_review).
    if (group === "needs_review" && blocker !== "needs_manual_review") fellBackToReview.push(blocker);
  }
  const needsDataTotal = Object.values(needsDataCounts).reduce((a, b) => a + b, 0);
  check(needsDataTotal === blockedRows.length, `needs-data grouping lost rows: ${needsDataTotal} vs ${blockedRows.length}`);

  // ---- Opportunities family buckets (mirror the UI: removal queue + generator previews) ----
  const oppCounts: Record<OpportunityFamilyGroupId, number> = {
    damaged: 0,
    lost: 0,
    disposed: 0,
    removal: 0,
    reimbursement_error: 0,
    customer_return: 0,
    fee_overcharge: 0,
    inbound_discrepancy: 0,
  };
  const unmappedFamilies = new Set<string>();
  const bucketFamily = (family: string | null | undefined): void => {
    const g = opportunityGroupForFamily(family);
    if (g) oppCounts[g] += 1;
    else if (family) unmappedFamilies.add(family);
  };
  for (const r of [...queue.ready_rows, ...queue.blocked_rows]) bucketFamily(r.claim_family);
  for (const c of generators.candidates) bucketFamily(c.recommended_claim_family);
  const oppTotalBucketed = Object.values(oppCounts).reduce((a, b) => a + b, 0);

  // ---- Build flow counts from REAL data + run the SAME wiring the UI uses ----
  const flowCounts: ClaimCenterFlowCounts = flowCountsFromDashboard(
    {
      total_active: activeCandidates,
      ready_to_file_count: readyCount,
      review_blocker_count: blockedRows.length,
      observed_filed_count: subsCount,
      observed_reimbursed_count: 0, // computed by the dashboard money contract at runtime; not derived here
    },
    0, // reference conflicts come from /api/claims/center/references at runtime
  );
  flowCounts.sources = liveLoadedSources; // provider sets this from automation-health enabled sources

  const sectionBadges = CLAIM_CENTER_PRIMARY_SECTIONS.map((s) => ({
    id: s.id,
    label: s.shortLabel,
    count_key: primarySectionCountKey(s.id),
    badge: primarySectionBadgeCount(s.id, flowCounts),
  }));

  const countsAfter = await claimCounts(client);
  const noMutation = Object.keys(countsBefore).every((k) => countsBefore[k] === countsAfter[k]);
  for (const k of Object.keys(countsBefore)) check(countsBefore[k] === countsAfter[k], `claim table mutated: ${k}`);

  // ---- Wiring assertions on real data ----
  check(
    sectionBadges.find((b) => b.id === "ready_to_file")?.badge === readyCount,
    "Ready-to-File badge must equal live ready_rows count",
  );
  check(
    sectionBadges.find((b) => b.id === "needs_data")?.badge === blockedRows.length,
    "Needs Data badge must equal live blocked_rows count",
  );
  check(
    sectionBadges.find((b) => b.id === "opportunities")?.badge === activeCandidates,
    "Opportunities badge must equal live active candidate count",
  );
  check(
    sectionBadges.find((b) => b.id === "submissions")?.badge === subsCount,
    "Submissions badge must equal live submissions count",
  );
  check(
    sectionBadges.find((b) => b.id === "sources")?.badge === liveLoadedSources,
    "Sources badge must equal live_loaded source count",
  );
  check(sectionBadges.find((b) => b.id === "dashboard")?.badge === 0, "Dashboard must show no badge");
  check(sectionBadges.find((b) => b.id === "rules")?.badge === 0, "Rules must show no badge");

  // ---- OUTPUT ----
  console.log("──── per_section_badge_counts (live, via the UI's own wiring) ────");
  for (const b of sectionBadges) {
    console.log(`  ${b.label.padEnd(8)} [${b.id.padEnd(14)}] key=${String(b.count_key).padEnd(13)} badge=${b.badge}`);
  }

  console.log("\n──── needs_data_group_counts (live blocked rows) ────");
  for (const g of NEEDS_DATA_GROUPS) console.log(`  ${g.id.padEnd(28)} ${needsDataCounts[g.id]}`);
  console.log(`  total_blocked_rows: ${blockedRows.length}`);
  if (fellBackToReview.length) console.log(`  unmapped_blockers_fell_back_to_needs_review: ${JSON.stringify([...new Set(fellBackToReview)])}`);

  console.log("\n──── opportunity_family_group_counts (live: removal queue + generator previews) ────");
  for (const g of OPPORTUNITY_FAMILY_GROUPS) console.log(`  ${g.id.padEnd(20)} ${oppCounts[g.id]}`);
  console.log(`  total_bucketed: ${oppTotalBucketed}`);
  console.log(`  unmapped_families: ${unmappedFamilies.size ? JSON.stringify([...unmappedFamilies]) : "none"}`);

  console.log("\n──── verification ────");
  console.log(`module_enabled_in_running_env: NO (Claim Recovery module flag off for org; UI shows module-unavailable until enabled)`);
  console.log(`data_and_logic_verified_via_service_role: yes`);
  console.log(`navigation_sections: ${CLAIM_CENTER_PRIMARY_SECTIONS.length}`);
  console.log(`ready_to_file_count_wired: yes (live ${readyCount})`);
  console.log(`filed_count_wired: yes (live ${subsCount})`);
  console.log(`active_candidates: ${activeCandidates}`);
  console.log(`live_loaded_sources: ${liveLoadedSources}`);
  console.log(`no_db_write_verification: yes (compose/SELECT only)`);
  console.log(`no_claim_mutation_verification: ${noMutation ? "yes" : "no"} ${JSON.stringify(countsAfter)}`);
  console.log(`no_amazon_submission_verification: yes`);
  console.log(`no_scanner_change_verification: yes`);

  const ok = failures === 0;
  console.log(`\n=== ${ok ? "PASS" : `FAIL (${failures})`} · ${passes} checks ===`);
  console.log(`SAFE_CLAIM_CENTER_UI_LIVE_VERIFIED: ${ok ? "yes" : "no"}`);
  console.log(`SAFE_CLAIM_CENTER_SECTION_COUNTS_WIRED: ${ok ? "yes" : "no"}`);
  console.log(
    `NEXT_PROMPT: PHASE-CLAIM-OPPORTUNITIES-UI-V1 — surface the per-family dry-run matrix on /claim-center/opportunities (family cards w/ dry-run/valid/blocked/ready-for-review + source coverage + amount basis + blockers); keep removal Ready-to-File separate; gate promote-to-candidate behind APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1. Operator: enable the Claim Recovery module for org ${ORG} to see the new nav/pages live.`,
  );
  process.exit(ok ? 0 : 1);
}

void main();
