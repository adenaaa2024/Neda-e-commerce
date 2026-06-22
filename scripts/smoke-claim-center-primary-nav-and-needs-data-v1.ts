/**
 * PHASE-CLAIM-CENTER-UI-LIVE-VERIFY-AND-COUNT-WIRE-V1 — focused smoke (pure, no DB).
 *
 * Verifies the inherited Claim Center UI contracts + the newly-wired per-section badge
 * counts are internally consistent:
 *   - 10-section primary nav (ids/order/hrefs) + route resolver + tab/More dedup
 *   - section -> flow-count-key mapping (primarySectionCountKey / primarySectionBadgeCount)
 *   - flowCountsFromDashboard now surfaces ready_to_file + filed
 *   - Needs Data taxonomy (blocker -> group) + group catalog
 *   - Opportunity family grouping covers all 17 families
 *
 *   npx tsx scripts/smoke-claim-center-primary-nav-and-needs-data-v1.ts
 */
import {
  CLAIM_CENTER_PRIMARY_SECTIONS,
  primarySectionBadgeCount,
  primarySectionCountKey,
  resolveActivePrimarySection,
  type ClaimCenterPrimarySectionId,
} from "../lib/claims/center/claim-center-primary-nav";
import {
  flowCountsFromDashboard,
  type ClaimCenterFlowCounts,
} from "../lib/claims/center/claim-center-flow-nav";
import {
  NEEDS_DATA_GROUPS,
  getNeedsDataGroup,
  needsDataGroupForBlocker,
  type NeedsDataGroupId,
} from "../lib/claims/center/claim-needs-data-contract";
import {
  OPPORTUNITY_FAMILY_GROUPS,
  opportunityGroupForFamily,
} from "../lib/claims/opportunities/claim-family-group-contract";
import {
  CLAIM_CENTER_MOBILE_MORE_GROUPS,
  CLAIM_CENTER_PRIMARY_SECTIONS_NAV,
  claimCenterHrefPath,
} from "../components/claim-center/claim-center-nav-config";

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Primary nav: 10 sections, unique ids, contiguous order, valid hrefs
// ---------------------------------------------------------------------------
check(CLAIM_CENTER_PRIMARY_SECTIONS.length === 10, `expected 10 primary sections, got ${CLAIM_CENTER_PRIMARY_SECTIONS.length}`);
const ids = CLAIM_CENTER_PRIMARY_SECTIONS.map((s) => s.id);
check(new Set(ids).size === ids.length, "section ids must be unique");
const orders = CLAIM_CENTER_PRIMARY_SECTIONS.map((s) => s.order).sort((a, b) => a - b);
check(orders.join(",") === "1,2,3,4,5,6,7,8,9,10", `section orders must be 1..10, got ${orders.join(",")}`);
const hrefs = CLAIM_CENTER_PRIMARY_SECTIONS.map((s) => s.href);
check(new Set(hrefs).size === hrefs.length, "section hrefs must be unique (no duplicate tabs)");
for (const s of CLAIM_CENTER_PRIMARY_SECTIONS) {
  check(s.href.startsWith("/claim-center"), `section ${s.id} href must start with /claim-center (got ${s.href})`);
  check(s.label.length > 0 && s.shortLabel.length > 0, `section ${s.id} must have label + shortLabel`);
}
// Expected ordered ids per PHASE-CLAIM-CENTER-OPPORTUNITIES-NEEDS-READY-UI-V1.
check(
  ids.join(",") ===
    "dashboard,opportunities,needs_data,ready_to_file,cases,submissions,reimbursement_tracking,product_story,sources,rules",
  `section ids/order mismatch, got ${ids.join(",")}`,
);

// ---------------------------------------------------------------------------
// 2. Route resolver (pathname only — query string is stripped by usePathname)
// ---------------------------------------------------------------------------
const routeCases: Array<[string, ClaimCenterPrimarySectionId | null]> = [
  ["/claim-center", "dashboard"],
  ["/claim-center/", "dashboard"],
  ["/claim-center/opportunities", "opportunities"],
  ["/claim-center/candidates", "opportunities"], // alias
  ["/claim-center/needs-data", "needs_data"],
  ["/claim-center/ready-to-file", "ready_to_file"],
  ["/claim-center/cases", "cases"],
  ["/claim-center/case-review", "cases"], // alias
  ["/claim-center/pilot-review", "cases"], // alias
  ["/claim-center/submissions", "submissions"],
  ["/claim-center/reimbursement-tracking", "reimbursement_tracking"],
  ["/claim-center/recovery", "reimbursement_tracking"], // alias (observed reimbursements)
  ["/claim-center/references", "product_story"],
  ["/claim-center/references/abc123", "product_story"], // descendant
  ["/claim-center/data-coverage", "sources"],
  ["/claim-center/sources", "sources"], // alias (generator runs)
  ["/claim-center/policies", "rules"],
  ["/some/other/path", null],
];
for (const [path, expected] of routeCases) {
  const got = resolveActivePrimarySection(path);
  check(got === expected, `resolveActivePrimarySection(${path}) expected ${expected}, got ${got}`);
}

// ---------------------------------------------------------------------------
// 3. section -> count-key mapping is total + only references valid keys
// ---------------------------------------------------------------------------
const sampleCounts: ClaimCenterFlowCounts = {
  find_money: 82,
  review: 20,
  proof: 5,
  product: 3,
  references: 7,
  recovery: 9,
  sources: 16,
  ready_to_file: 4,
  filed: 13,
};
const expectedKey: Record<ClaimCenterPrimarySectionId, keyof ClaimCenterFlowCounts | null> = {
  dashboard: null,
  opportunities: "find_money",
  needs_data: "review",
  ready_to_file: "ready_to_file",
  cases: null,
  submissions: "filed",
  reimbursement_tracking: "recovery",
  product_story: "references",
  sources: "sources",
  rules: null,
};
for (const s of CLAIM_CENTER_PRIMARY_SECTIONS) {
  const key = primarySectionCountKey(s.id);
  check(key === expectedKey[s.id], `primarySectionCountKey(${s.id}) expected ${expectedKey[s.id]}, got ${key}`);
  const badge = primarySectionBadgeCount(s.id, sampleCounts);
  const want = key ? sampleCounts[key] : 0;
  check(badge === want, `primarySectionBadgeCount(${s.id}) expected ${want}, got ${badge}`);
}
// Dashboard / cases / rules must have no badge.
check(primarySectionBadgeCount("dashboard", sampleCounts) === 0, "dashboard must have no badge count");
check(primarySectionBadgeCount("cases", sampleCounts) === 0, "cases must have no badge count");
check(primarySectionBadgeCount("rules", sampleCounts) === 0, "rules must have no badge count");
// Ready-to-file + submissions (filed) must surface their dedicated counts (the wiring goal).
check(primarySectionBadgeCount("ready_to_file", sampleCounts) === 4, "ready_to_file badge must use ready_to_file count");
check(primarySectionBadgeCount("submissions", sampleCounts) === 13, "submissions badge must use filed count");

// ---------------------------------------------------------------------------
// 4. flowCountsFromDashboard surfaces the two newly-wired counts
// ---------------------------------------------------------------------------
const fc = flowCountsFromDashboard(
  {
    total_active: 82,
    evidence_missing_count: 5,
    blocked_product_link_count: 3,
    observed_reimbursed_count: 9,
    observed_filed_count: 13,
    ready_to_file_count: 4,
    review_blocker_count: 20,
  },
  7,
);
check(fc.find_money === 82, `flowCounts.find_money expected 82, got ${fc.find_money}`);
check(fc.review === 20, `flowCounts.review expected 20, got ${fc.review}`);
check(fc.references === 7, `flowCounts.references expected 7, got ${fc.references}`);
check(fc.recovery === 9, `flowCounts.recovery expected 9, got ${fc.recovery}`);
check(fc.ready_to_file === 4, `flowCounts.ready_to_file expected 4, got ${fc.ready_to_file}`);
check(fc.filed === 13, `flowCounts.filed expected 13, got ${fc.filed}`);
// Defaults when KPI fields absent.
const fcEmpty = flowCountsFromDashboard({});
check(fcEmpty.ready_to_file === 0 && fcEmpty.filed === 0, "missing KPIs must default ready_to_file/filed to 0");

// ---------------------------------------------------------------------------
// 5. Needs Data taxonomy
// ---------------------------------------------------------------------------
check(NEEDS_DATA_GROUPS.length === 8, `expected 8 needs-data groups (7 + needs_review), got ${NEEDS_DATA_GROUPS.length}`);
const groupIds = new Set(NEEDS_DATA_GROUPS.map((g) => g.id));
check(groupIds.size === NEEDS_DATA_GROUPS.length, "needs-data group ids must be unique");
const blockerCases: Array<[string, NeedsDataGroupId]> = [
  ["physical_receiving_not_started", "physical_receiving"],
  ["waiting_physical_receiving", "physical_receiving"],
  ["missing_sale_price_source", "missing_sale_price"],
  ["live_reimbursement_check_missing", "missing_reimbursement_check"],
  ["missing_removal_source", "missing_live_source"],
  ["missing_live_delivery_proof", "missing_live_source"],
  ["missing_product_identity", "missing_product_linkage"],
  ["missing_quantity", "missing_trid_reference"],
  ["waiting_threshold", "waiting_threshold"],
  ["cross_family_pollution", "needs_review"],
  ["some_unknown_blocker_xyz", "needs_review"], // fallback
];
for (const [blocker, expected] of blockerCases) {
  const got = needsDataGroupForBlocker(blocker);
  check(got === expected, `needsDataGroupForBlocker(${blocker}) expected ${expected}, got ${got}`);
  check(groupIds.has(got), `needsDataGroupForBlocker(${blocker}) returned unknown group ${got}`);
  check(getNeedsDataGroup(got).id === got, `getNeedsDataGroup(${got}) must round-trip`);
  check(getNeedsDataGroup(got).unblockHint.length > 0, `group ${got} must have an unblock hint`);
}

// ---------------------------------------------------------------------------
// 6. Opportunity family grouping covers all 17 families
// ---------------------------------------------------------------------------
check(OPPORTUNITY_FAMILY_GROUPS.length === 8, `expected 8 opportunity family groups, got ${OPPORTUNITY_FAMILY_GROUPS.length}`);
const oppGroupIds = new Set(OPPORTUNITY_FAMILY_GROUPS.map((g) => g.id));
const ALL_17_FAMILIES = [
  "damaged_warehouse",
  "damaged_outbound",
  "lost_warehouse",
  "lost_outbound",
  "disposed_without_reimbursement",
  "removal_shipment_missing",
  "removal_order_discrepancy",
  "reimbursement_reversal",
  "missing_reimbursement",
  "partial_reimbursement",
  "customer_return_not_received",
  "refund_without_return",
  "wrong_item_returned",
  "empty_box_return",
  "fulfillment_fee_overcharge",
  "storage_fee_overcharge",
  "inbound_shipment_discrepancy",
];
check(ALL_17_FAMILIES.length === 17, "family list must be 17");
for (const fam of ALL_17_FAMILIES) {
  const g = opportunityGroupForFamily(fam);
  check(g !== null, `family ${fam} must bucket into a group`);
  check(g !== null && oppGroupIds.has(g), `family ${fam} bucketed into unknown group ${g}`);
}
check(opportunityGroupForFamily("not_a_real_family") === null, "unknown family must return null");
check(opportunityGroupForFamily(null) === null, "null family must return null");

// ---------------------------------------------------------------------------
// 7. Tab / More dedup: no non-"sections" More-menu route may equal a primary tab
//    href (so no page appears both as a desktop tab and in the desktop More menu).
// ---------------------------------------------------------------------------
const primaryHrefs = new Set(CLAIM_CENTER_PRIMARY_SECTIONS.map((s) => claimCenterHrefPath(s.href)));
// The mobile "sections" group intentionally mirrors the primary nav (desktop hides it).
check(
  CLAIM_CENTER_PRIMARY_SECTIONS_NAV.length === CLAIM_CENTER_PRIMARY_SECTIONS.length,
  `mobile sections nav must mirror the ${CLAIM_CENTER_PRIMARY_SECTIONS.length} primary sections, got ${CLAIM_CENTER_PRIMARY_SECTIONS_NAV.length}`,
);
const sectionsGroup = CLAIM_CENTER_MOBILE_MORE_GROUPS.find((g) => g.id === "sections");
check(!!sectionsGroup, "More groups must include the mobile-only 'sections' mirror group");
for (const group of CLAIM_CENTER_MOBILE_MORE_GROUPS) {
  if (group.id === "sections") continue;
  for (const item of group.items) {
    const path = claimCenterHrefPath(item.href);
    check(
      !primaryHrefs.has(path),
      `More-menu route ${path} (group ${group.id}) duplicates a primary tab href`,
    );
  }
}

// ---------------------------------------------------------------------------
const ok = failures === 0;
console.log(`\n=== smoke-claim-center-primary-nav-and-needs-data-v1: ${ok ? "PASS" : `FAIL (${failures})`} · ${passes} checks ===`);
console.log(`SAFE_CLAIM_CENTER_PRIMARY_NAV_AND_NEEDS_DATA_SMOKE_OK: ${ok ? "yes" : "no"}`);
process.exit(ok ? 0 : 1);
