/**
 * CLAIM-RETURN-LINE-BACKFILL-PHYSICAL-ANCHOR-GATE — unit tests (no DB).
 *
 *   npx tsx scripts/test-claim-return-line-backfill-physical-anchor-gate.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { isBackfillClaimLineExcludedFromQueue } from "../lib/returns-claims-work-queue";
import {
  isBulkOrphanReturnItemPattern,
  isPhysicalReturnItemForClaims,
  isReturnItemBackfillLaneEligible,
  sqlPhysicalReturnItemForClaimsWhere,
  sqlReturnItemBackfillLaneWhere,
} from "../lib/return-item-physical-scan";

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

function main(): void {
  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-return-line-backfill-physical-anchor-gate",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const bulkOrphan = {
    package_id: null,
    pallet_id: null,
    expected_item_id: "ep-1",
    conditions: ["damaged_product"],
  };
  const physicalAnchored = {
    package_id: "pkg-1",
    pallet_id: null,
    expected_item_id: "ep-1",
    conditions: ["damaged_product"],
  };
  const packageOnlyNoExpected = {
    package_id: "pkg-2",
    pallet_id: null,
    expected_item_id: null,
    conditions: ["damaged_product"],
  };

  const checks: Check[] = [
    assert(
      "bulk_orphan_not_backfill_lane",
      !isReturnItemBackfillLaneEligible(bulkOrphan),
      "expected_item_id-only orphan cannot produce return_item claim_line",
    ),
    assert(
      "bulk_orphan_not_physical",
      !isPhysicalReturnItemForClaims(bulkOrphan),
      "orphan fails package_id minimum",
    ),
    assert(
      "physical_with_expected_backfill_lane",
      isReturnItemBackfillLaneEligible(physicalAnchored),
      "package-anchored RI with expected_item_id is backfill-lane eligible",
    ),
    assert(
      "package_without_expected_not_backfill_lane",
      !isReturnItemBackfillLaneEligible(packageOnlyNoExpected),
      "backfill lane still requires expected_item_id",
    ),
    assert(
      "expected_group_grain_not_return_item",
      isBackfillClaimLineExcludedFromQueue("expected_group"),
      "expected_group uses expected_packages, not return_item grain in queue",
    ),
    assert(
      "import_source_grain_not_return_item",
      isBackfillClaimLineExcludedFromQueue("import_source"),
      "import_source lane separate from return_item",
    ),
    assert(
      "sql_lane_includes_package_id",
      sqlReturnItemBackfillLaneWhere("ri").includes("package_id IS NOT NULL"),
      "execute/dryrun SQL enforces physical anchor",
    ),
    assert(
      "sql_lane_excludes_bulk_orphan",
      sqlReturnItemBackfillLaneWhere("ri").includes("expected_item_id IS NOT NULL") &&
        sqlReturnItemBackfillLaneWhere("ri").includes("NOT ("),
      "SQL rejects bulk-orphan pattern",
    ),
    assert(
      "physical_sql_usable_for_promote_gate",
      sqlPhysicalReturnItemForClaimsWhere("ri").includes("package_id IS NOT NULL"),
      "shared predicate for promote/queue alignment",
    ),
  ];

  const failed = checks.filter((c) => !c.pass);
  const result = { run_id: rid, status: failed.length === 0 ? "PASS" : "FAIL", checks };

  const report = [
    "# CLAIM-RETURN-LINE-BACKFILL-PHYSICAL-ANCHOR-GATE",
    "",
    `**Status:** ${result.status}`,
    `**Run ID:** ${rid}`,
    "",
    "# BACKFILL_LANES_AUDITED",
    "",
    "| Lane | Grain | Physical gate |",
    "|------|-------|---------------|",
    "| `return_items_with_expected_item_id` | `return_item` | **YES** — `sqlReturnItemBackfillLaneWhere` |",
    "| `expected_group_short` | `expected_group` | N/A (root EP from `expected_packages`) |",
    "| `expected_group_overage` | `expected_group` | N/A |",
    "| `removal_claim_candidates` | `import_source` | N/A (claim_candidates / Amazon tables) |",
    "| `returnish_claim_candidates` | `import_source` | N/A; cross-lane skip only when physical RI wins |",
    "",
    "App paths: `promoteScannerReturnItemToClaimStructures`, Returns claims queue — already gated.",
    "`lib/claim-reference-candidates` — TRID graph only; does not insert `claim_lines`.",
    "",
    "# PATCHES",
    "",
    "- `lib/return-item-physical-scan.ts` — SQL helpers + `isReturnItemBackfillLaneEligible`",
    "- `scripts/claim-return-line-backfill-dryrun.ts` — census + planned inserts use physical lane",
    "- `scripts/claim-return-line-backfill-execute.ts` — INSERT WHERE uses `sqlReturnItemBackfillLaneWhere`",
    "",
    "# TEST_RESULTS",
    "",
    ...checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} **${c.name}** — ${c.detail}`),
    "",
    "# SAFE_TO_CONTINUE_CLAIMS",
    "",
    failed.length === 0
      ? "**YES** for staging claims work that respects physical anchor on return_item grain. Re-run `claim-return-line-backfill-dryrun` before any execute; return_item lane should plan **0** inserts while bulk orphan rows remain."
      : "**NO** — fix failing unit checks first.",
    "",
    "# NEXT_CLAIM_PROMPT",
    "",
    "`CLAIM-MANUAL-GROUPING-PHASE1-IMPLEMENT` — multi-select physical return_items → open/attach claim case.",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "test-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "REPORT.md"), report + "\n");

  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exit(1);
}

main();
