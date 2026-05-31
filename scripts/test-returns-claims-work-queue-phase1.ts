/**
 * CLAIM-RETURNS-WORK-QUEUE-PHASE1 — unit tests (no DB).
 *
 *   npx tsx scripts/test-returns-claims-work-queue-phase1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeClaimPolicy, evaluateClaimEligibilitySync } from "../lib/claim-eligibility-policy";
import {
  buildReturnsClaimQueueRow,
  deriveReturnsClaimQueueState,
  filterClaimLinesForReturnsQueue,
  isBackfillClaimLineExcludedFromQueue,
  isReturnsWorkQueueClaimLine,
  returnHasResolvedProduct,
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

function main(): void {
  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-returns-work-queue-phase1-implement",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const backfillLines = [
    { line_grain: "import_source", return_item_id: null },
    { line_grain: "expected_group", return_item_id: "ri-x" },
    { line_grain: "return_item", return_item_id: "ri-1", id: "cl-1", status: "detected", scanner_issue_type: "damaged_product" },
  ];

  const eligibleRow = buildReturnsClaimQueueRow(baseSource(), policyReturnsOn, true);
  const preCutoffRow = buildReturnsClaimQueueRow(
    baseSource({ created_at: "2025-12-01T00:00:00Z" }),
    policyReturnsOn,
    true,
  );
  const noProductRow = buildReturnsClaimQueueRow(
    baseSource({ resolved_product_id: null, resolved_catalog_product_id: null }),
    policyReturnsOn,
    true,
  );
  const domainOffRow = buildReturnsClaimQueueRow(baseSource(), policyReturnsOff, true);
  const withReturnLine = buildReturnsClaimQueueRow(
    baseSource({
      claim_line: {
        id: "cl-return",
        status: "claim_ready",
        scanner_issue_type: "damaged_product",
        line_grain: "return_item",
      },
    }),
    policyReturnsOn,
    true,
  );

  const checks: Check[] = [
    assert(
      "backfill_import_source_excluded",
      isBackfillClaimLineExcludedFromQueue("import_source"),
      "import_source grain flagged as backfill",
    ),
    assert(
      "backfill_expected_group_excluded",
      isBackfillClaimLineExcludedFromQueue("expected_group"),
      "expected_group grain flagged as backfill",
    ),
    assert(
      "filter_keeps_only_return_item_lines",
      filterClaimLinesForReturnsQueue(backfillLines as { line_grain: string; return_item_id?: string | null }[])
        .length === 1,
      "only return_item line survives filter",
    ),
    assert(
      "return_item_line_visible_when_eligible",
      eligibleRow.queue_state === "eligible" && isReturnsWorkQueueClaimLine({ line_grain: "return_item", return_item_id: "ri-1" }),
      "eligible scanner return_item row",
    ),
    assert(
      "pre_cutoff_blocked",
      preCutoffRow.queue_state === "pre_cutoff",
      "event before scan_go_live_date → pre_cutoff",
    ),
    assert(
      "returns_disabled_blocks_queue_state",
      domainOffRow.queue_state === "domain_disabled",
      "returns domain off → domain_disabled",
    ),
    assert(
      "unresolved_product_needs_resolution",
      noProductRow.queue_state === "needs_product_resolution",
      "missing resolved_product_id → needs_product_resolution",
    ),
    assert(
      "return_item_claim_line_attached",
      withReturnLine.claim_line?.id === "cl-return",
      "return_item claim_line ref shown on row",
    ),
    assert(
      "derive_state_respects_eligibility",
      deriveReturnsClaimQueueState({
        policy: policyReturnsOn,
        eligibility: evaluateClaimEligibilitySync({
          policy: policyReturnsOn,
          claimSource: "scanner_operator_issue",
          eventAt: "2026-05-10",
          hasScannerEvidence: false,
          packageClosed: true,
          moduleDomain: "returns",
        }),
        hasResolvedProduct: returnHasResolvedProduct({ resolved_product_id: "p1" }),
        hasScannerEvidence: false,
      }) === "missing_evidence",
      "missing evidence when no photo",
    ),
  ];

  const failed = checks.filter((c) => !c.pass);
  const result = { run_id: rid, status: failed.length === 0 ? "PASS" : "FAIL", checks };

  fs.writeFileSync(path.join(outDir, "test-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "SUMMARY.md"),
    [
      "# CLAIM-RETURNS-WORK-QUEUE-PHASE1-IMPLEMENT — tests",
      "",
      `**Status:** ${result.status}`,
      `**Run ID:** ${rid}`,
      "",
      "## Route",
      "",
      "- Page: `/returns/claims`",
      "- Nav: Finance & Claims → **Returns Claims**",
      "",
      "## Filters enforced",
      "",
      "- Source: `return_items` with scanner claimable `conditions` only",
      "- `claim_lines` join: `line_grain = return_item` only",
      "- Excludes `import_source` / `expected_group` backfill grains",
      "- Policy: `enabled_claim_domains.returns`, cutoff dates, hold-until-package-closed, evidence",
      "",
      "## Checks",
      "",
      ...checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} **${c.name}** — ${c.detail}`),
      "",
      "## Next prompt",
      "",
      "`CLAIM-MANUAL-GROUPING-PHASE1-IMPLEMENT` — multi-select return items → open/attach claim case (no auto-group).",
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exit(1);
}

main();
