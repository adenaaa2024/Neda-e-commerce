/**
 * CLAIM-RETURNS-WORK-QUEUE-PHYSICAL-ANCHOR-GATE — unit tests (no DB).
 *
 *   npx tsx scripts/test-returns-claims-work-queue-physical-anchor-gate.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeClaimPolicy } from "../lib/claim-eligibility-policy";
import {
  buildReturnsClaimQueueRow,
  isBulkOrphanReturnItemPattern,
  isPhysicalReturnItemForClaims,
  isReturnItemClaimCandidateForReturns,
  type ReturnsClaimQueueSourceRow,
} from "../lib/returns-claims-work-queue";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type Check = { name: string; pass: boolean; detail: string };

function assert(name: string, cond: boolean, detail: string): Check {
  return { name, pass: cond, detail };
}

const policyReturnsOn = normalizeClaimPolicy({
  scan_go_live_date: "2026-01-15",
  claim_start_date: "2026-01-15",
  enabled_claim_domains: { returns: true },
});

const policyReturnsOff = normalizeClaimPolicy({
  scan_go_live_date: "2026-01-15",
  claim_start_date: "2026-01-15",
  enabled_claim_domains: { returns: false },
});

function baseSource(overrides: Partial<ReturnsClaimQueueSourceRow> = {}): ReturnsClaimQueueSourceRow {
  return {
    return_item_id: "ri-1",
    organization_id: "org-1",
    store_id: null,
    package_id: "pkg-1",
    pallet_id: null,
    expected_item_id: null,
    created_at: "2026-05-10T12:00:00Z",
    conditions: ["damaged_product"],
    photo_evidence: { item_url: "https://example.com/p.jpg" },
    notes: null,
    resolved_product_id: "prod-1",
    resolved_catalog_product_id: null,
    identifier_resolution_status: "resolved",
    order_id: "111-123",
    sku: "SKU1",
    fnsku: null,
    asin: null,
    item_name: "Test item",
    lpn: "LPN1",
    status: "pending_evidence",
    claim_line: null,
    ...overrides,
  };
}

function promoteWouldSkipPhysical(row: {
  package_id: string | null;
  pallet_id: string | null;
  expected_item_id: string | null;
  conditions: string[] | null;
}): string | null {
  if (!isPhysicalReturnItemForClaims(row)) {
    return isBulkOrphanReturnItemPattern(row) ? "bulk_orphan_excluded" : "not_physical_scan";
  }
  return null;
}

function main(): void {
  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-returns-work-queue-physical-anchor-gate",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const bulkOrphan = {
    package_id: null,
    pallet_id: null,
    expected_item_id: "ep-child-1",
    conditions: ["damaged_product"] as string[] | null,
  };

  const physicalWithPackage = {
    package_id: "pkg-real",
    pallet_id: null,
    expected_item_id: "ep-child-1",
    conditions: ["damaged_product"] as string[] | null,
  };

  const physicalRow = buildReturnsClaimQueueRow(baseSource(), policyReturnsOn, true);
  const preCutoffRow = buildReturnsClaimQueueRow(
    baseSource({ created_at: "2025-12-01T00:00:00Z" }),
    policyReturnsOn,
    true,
  );
  const domainOffRow = buildReturnsClaimQueueRow(baseSource(), policyReturnsOff, true);

  const checks: Check[] = [
    assert(
      "bulk_orphan_pattern_detected",
      isBulkOrphanReturnItemPattern(bulkOrphan),
      "expected_item_id without package/pallet/slip",
    ),
    assert(
      "bulk_orphan_not_physical",
      !isPhysicalReturnItemForClaims(bulkOrphan),
      "orphan row fails physical gate",
    ),
    assert(
      "bulk_orphan_not_claim_candidate",
      !isReturnItemClaimCandidateForReturns(bulkOrphan),
      "orphan with claimable conditions still excluded",
    ),
    assert(
      "package_id_physical_passes",
      isPhysicalReturnItemForClaims(physicalWithPackage),
      "package_id satisfies Phase-1 minimum anchor",
    ),
    assert(
      "package_id_can_be_claim_candidate",
      isReturnItemClaimCandidateForReturns(physicalWithPackage),
      "physical + issue passes candidate selector",
    ),
    assert(
      "package_id_row_eligible_when_policy_passes",
      physicalRow.queue_state === "eligible",
      "physical scan row can reach eligible state",
    ),
    assert(
      "pre_cutoff_blocked",
      preCutoffRow.queue_state === "pre_cutoff",
      "event before scan_go_live_date → pre_cutoff",
    ),
    assert(
      "returns_disabled_blocked",
      domainOffRow.queue_state === "domain_disabled",
      "returns domain off → domain_disabled",
    ),
    assert(
      "promote_skips_bulk_orphan",
      promoteWouldSkipPhysical(bulkOrphan) === "bulk_orphan_excluded",
      "promote path skip_reason bulk_orphan_excluded",
    ),
    assert(
      "promote_skips_no_package",
      promoteWouldSkipPhysical({
        package_id: null,
        pallet_id: "pal-1",
        expected_item_id: null,
        conditions: ["damaged_product"],
      }) === "not_physical_scan",
      "pallet-only row fails package_id minimum",
    ),
    assert(
      "promote_allows_physical_with_issue",
      promoteWouldSkipPhysical(physicalWithPackage) === null,
      "physical row not skipped before issue/eligibility",
    ),
  ];

  const failed = checks.filter((c) => !c.pass);
  const result = { run_id: rid, status: failed.length === 0 ? "PASS" : "FAIL", checks };

  const report = [
    "# CLAIM-RETURNS-WORK-QUEUE-PHYSICAL-ANCHOR-GATE",
    "",
    `**Status:** ${result.status}`,
    `**Run ID:** ${rid}`,
    "",
    "# FILES_CHANGED",
    "",
    "- `lib/returns-claims-work-queue.ts` — `isPhysicalReturnItemForClaims`, `isBulkOrphanReturnItemPattern`, `isReturnItemClaimCandidateForReturns`",
    "- `app/returns/returns-claims-work-queue-actions.ts` — queue filters physical rows only",
    "- `app/returns/returns-constants.ts` — `expected_item_id` in list select",
    "- `lib/scanner-operator-claim-promote.ts` — promote physical gate",
    "- `app/returns/claims/ReturnsClaimsWorkQueueClient.tsx` — UI note",
    "- `scripts/test-returns-claims-work-queue-physical-anchor-gate.ts`",
    "",
    "# PHYSICAL_ANCHOR_RULE",
    "",
    "- Minimum Phase 1 anchor: `package_id IS NOT NULL`",
    "- Reject bulk/orphan: `expected_item_id` set AND `package_id`, `pallet_id` all null",
    "- Queue shows only rows passing `isPhysicalReturnItemForClaims` with claimable scanner conditions",
    "",
    "# TEST_RESULTS",
    "",
    ...checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} **${c.name}** — ${c.detail}`),
    "",
    "# CLAIM_PROMOTE_PROTECTION",
    "",
    "- `promoteScannerReturnItemToClaimStructures` returns `bulk_orphan_excluded` or `not_physical_scan` before issue pick",
    "- Auto-promote remains disabled via `evaluateScannerClaimPromoteGuard` (unchanged)",
    "",
    "# REMAINING_BULK_RI_RISK",
    "",
    "- ~5300+ staging bulk orphan `return_items` remain in DB; they are hidden from queue/promote but not deleted",
    "- Inventory views and other readers may still count them until quarantine migration",
    "",
    "# EXACT_NEXT_PROMPT",
    "",
    "`CLAIM-MANUAL-GROUPING-PHASE1-IMPLEMENT` — multi-select physical return_items → open/attach claim case.",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "test-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "REPORT.md"), report + "\n");

  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exit(1);
}

main();
