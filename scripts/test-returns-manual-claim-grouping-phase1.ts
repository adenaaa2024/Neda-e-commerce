/**
 * CLAIM-MANUAL-GROUPING-PHASE1 — unit tests (no DB).
 *
 *   npx tsx scripts/test-returns-manual-claim-grouping-phase1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeClaimPolicy } from "../lib/claim-eligibility-policy";
import {
  isBackfillClaimLineExcludedFromQueue,
  isReturnsWorkQueueClaimLine,
} from "../lib/returns-claims-work-queue";
import {
  assertNoBulkBackfillExecuteInManualFlow,
  buildManualGroupKey,
  clusterRowsByManualDimension,
  evaluateManualDraftEligibility,
  filterAmazonReturnsReferenceLines,
  isExcludedFromReturnsFirstGrouping,
  isReturnsFirstOperatorClaimLineGrain,
  manualClaimCaseIdempotencyKey,
  validateManualGroupingSelection,
  type ManualGroupingReturnItemInput,
} from "../lib/returns-manual-claim-grouping";

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

const policyOn = normalizeClaimPolicy({
  scan_go_live_date: "2026-01-15",
  claim_start_date: "2026-01-15",
  enabled_claim_domains: { returns: true },
});

function physicalRow(overrides: Partial<ManualGroupingReturnItemInput> = {}): ManualGroupingReturnItemInput {
  return {
    return_item_id: "ri-1",
    organization_id: "org-1",
    store_id: null,
    package_id: "pkg-1",
    pallet_id: null,
    expected_item_id: null,
    conditions: ["damaged_product"],
    photo_evidence: { item_url: "https://example.com/p.jpg" },
    resolved_product_id: "prod-1",
    order_id: "111-999",
    sku: "SKU-A",
    created_at: "2026-05-10T12:00:00Z",
    ...overrides,
  };
}

function main(): void {
  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-manual-grouping-phase1-implement",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const eligibleQueueRow = {
    return_item_id: "ri-1",
    queue_state: "eligible" as const,
    has_scanner_evidence: true,
    package_id: "pkg-1",
    pallet_id: null,
    expected_item_id: null,
    conditions: ["damaged_product"],
    resolved_product_id: "prod-1",
    resolved_catalog_product_id: null,
    photo_evidence: { item_url: "https://example.com/p.jpg" },
    notes: null,
    created_at: "2026-05-10T12:00:00Z",
    package_closed: true,
  };

  const refs = filterAmazonReturnsReferenceLines(
    [
      {
        id: "cl-ar-1",
        line_grain: "import_source",
        source_table: "amazon_returns",
        source_row_id: "cand-1",
        order_id: "111-999",
        sku: "SKU-A",
        status: "detected",
      },
      {
        id: "cl-eg-1",
        line_grain: "expected_group",
        source_table: null,
        source_row_id: null,
        order_id: "111-999",
        sku: "SKU-A",
        status: "detected",
      },
      {
        id: "cl-rem-1",
        line_grain: "import_source",
        source_table: "amazon_removals",
        source_row_id: "r-1",
        order_id: "111-999",
        sku: "SKU-A",
        status: "detected",
      },
    ],
    { order_ids: ["111-999"], skus: ["SKU-A"] },
  );

  let backfillBlocked = false;
  try {
    assertNoBulkBackfillExecuteInManualFlow("claim-return-line-backfill-execute");
  } catch {
    backfillBlocked = true;
  }

  const checks: Check[] = [
    assert(
      "physical_with_evidence_can_draft",
      evaluateManualDraftEligibility(eligibleQueueRow, policyOn).allowed,
      "eligible physical row passes manual draft gate",
    ),
    assert(
      "expected_group_excluded_from_returns_first",
      isExcludedFromReturnsFirstGrouping("expected_group") &&
        !isReturnsFirstOperatorClaimLineGrain("expected_group"),
      "expected_group cannot become returns-first claim",
    ),
    assert(
      "import_source_not_return_item_grain",
      !isReturnsWorkQueueClaimLine({ line_grain: "import_source", return_item_id: "x" }),
      "import_source excluded from returns queue lines",
    ),
    assert(
      "amazon_returns_reference_read_only",
      refs.length === 1 && refs[0]!.read_only === true && refs[0]!.line_grain === "import_source",
      "only amazon_returns import_source shown as reference",
    ),
    assert(
      "validate_selection_physical_rows",
      validateManualGroupingSelection([physicalRow(), physicalRow({ return_item_id: "ri-2" })], policyOn).ok,
      "physical rows with evidence pass validation",
    ),
    assert(
      "bulk_backfill_execute_forbidden_in_flow",
      backfillBlocked,
      "manual flow rejects backfill execute caller",
    ),
    assert(
      "group_by_product_clusters",
      clusterRowsByManualDimension(
        [
          physicalRow(),
          physicalRow({ return_item_id: "ri-2", resolved_product_id: "prod-2", sku: "SKU-B" }),
        ],
        "product",
      ).size === 2,
      "distinct products form separate groups",
    ),
    assert(
      "manual_case_idempotency_stable",
      manualClaimCaseIdempotencyKey("org-1", ["ri-b", "ri-a"], "damaged_product") ===
        manualClaimCaseIdempotencyKey("org-1", ["ri-a", "ri-b"], "damaged_product"),
      "sorted ids produce stable case key",
    ),
    assert(
      "backfill_grain_flagged",
      isBackfillClaimLineExcludedFromQueue("import_source"),
      "backfill import_source flagged",
    ),
    assert(
      "group_key_order",
      buildManualGroupKey(physicalRow(), "order", "damaged_product") === "order:111-999",
      "order grouping key",
    ),
  ];

  const failed = checks.filter((c) => !c.pass);
  const result = { run_id: rid, status: failed.length === 0 ? "PASS" : "FAIL", checks };

  fs.writeFileSync(path.join(outDir, "test-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "REPORT.md"),
    [
      "# CLAIM-MANUAL-GROUPING-PHASE1-IMPLEMENT",
      "",
      `**Status:** ${result.status}`,
      "",
      "## Claim flow",
      "",
      "- Queue: live physical return_items only",
      "- Manual draft: `claim_cases` + `return_item` grain `claim_lines`",
      "- Auto-promote: off",
      "- Bulk backfill execute: forbidden",
      "- amazon_returns: read-only reference panel",
      "",
      "## Tests",
      "",
      ...checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} **${c.name}** — ${c.detail}`),
      "",
      "## SAFE_TO_CONTINUE",
      "",
      failed.length === 0 ? "**YES**" : "**NO**",
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exit(1);
}

main();
