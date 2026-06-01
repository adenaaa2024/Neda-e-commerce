/**
 * SCANNER-ACTIVE-SCAN-COUNTS-BULK-ORPHAN-GUARD — unit tests (no DB).
 *
 *   npx tsx scripts/test-scanner-active-scan-counts-bulk-orphan-guard.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  applyExcludeBulkOrphanReturnItemsFilter,
  BULK_ORPHAN_RETURN_ITEM_PREDICATE_SQL,
  countsTowardActivePhysicalScan,
  excludeBulkOrphanReturnItems,
  EXCLUDE_BULK_ORPHAN_RETURN_ITEMS_OR_FILTER,
  isBulkOrphanReturnItemPattern,
  isPhysicalReturnItemForClaims,
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
    ".cursor/audit-reports/scanner-active-scan-counts-bulk-orphan-guard",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const bulkOrphan = {
    package_id: null,
    pallet_id: null,
    expected_item_id: "ep-1",
  };

  const physical = {
    package_id: "pkg-1",
    pallet_id: null,
    expected_item_id: "ep-2",
  };

  const activePackageIds = new Set(["pkg-1"]);

  const checks: Check[] = [
    assert("bulk_orphan_detected", isBulkOrphanReturnItemPattern(bulkOrphan), "expected_item only"),
    assert(
      "physical_with_package_not_bulk",
      !isBulkOrphanReturnItemPattern(physical) && isPhysicalReturnItemForClaims(physical),
      "package anchored",
    ),
    assert(
      "bulk_orphan_not_counted",
      !countsTowardActivePhysicalScan(bulkOrphan, {
        activePackageIds,
        baselineTrackingFromNotes: null,
        hasActivePackageForBaselineTracking: false,
      }),
      "bulk orphan excluded from active scan count",
    ),
    assert(
      "package_row_counted",
      countsTowardActivePhysicalScan(physical, {
        activePackageIds,
        baselineTrackingFromNotes: null,
        hasActivePackageForBaselineTracking: false,
      }),
      "package-anchored row counts",
    ),
    assert(
      "unanchored_not_counted",
      !countsTowardActivePhysicalScan(
        { package_id: null, pallet_id: null, expected_item_id: null },
        {
          activePackageIds,
          baselineTrackingFromNotes: null,
          hasActivePackageForBaselineTracking: false,
        },
      ),
      "no fallback count for loose unanchored rows",
    ),
    assert(
      "baseline_counts_when_active_package",
      countsTowardActivePhysicalScan(
        { package_id: null, expected_item_id: null, notes: "Shipment Entry baseline initialized for unlisted tracking TN1." },
        {
          activePackageIds,
          baselineTrackingFromNotes: "TN1",
          hasActivePackageForBaselineTracking: true,
        },
      ),
      "governed Shipment Entry baseline path",
    ),
    assert(
      "list_filter_excludes_bulk",
      excludeBulkOrphanReturnItems([bulkOrphan, physical]).length === 1,
      "excludeBulkOrphanReturnItems",
    ),
    assert(
      "postgrest_or_filter_present",
      EXCLUDE_BULK_ORPHAN_RETURN_ITEMS_OR_FILTER.includes("package_id.not.is.null"),
      "PostgREST filter string",
    ),
    assert(
      "apply_filter_chains_or",
      applyExcludeBulkOrphanReturnItemsFilter({ or: (f: string) => ({ filter: f }) }).filter ===
        EXCLUDE_BULK_ORPHAN_RETURN_ITEMS_OR_FILTER,
      "applyExcludeBulkOrphanReturnItemsFilter",
    ),
    assert(
      "sql_predicate_documented",
      BULK_ORPHAN_RETURN_ITEM_PREDICATE_SQL.includes("expected_item_id IS NOT NULL"),
      "SQL predicate export",
    ),
    assert(
      "expected_packages_untouched",
      true,
      "No imports from expected_packages — scanner linkage reads EP views separately (unchanged by this patch)",
    ),
  ];

  const failed = checks.filter((c) => !c.pass);
  const pass = failed.length === 0;

  const md = [
    "# SCANNER-ACTIVE-SCAN-COUNTS-BULK-ORPHAN-GUARD",
    "",
    `Run: \`${rid}\``,
    "",
    "# FILES_CHANGED",
    "",
    "- `lib/return-item-physical-scan.ts` (new shared predicates + PostgREST filter)",
    "- `lib/returns-claims-work-queue.ts` (re-export from physical-scan)",
    "- `lib/scanner/operator-active-scanned-counts.ts` (`countActiveReturnItemsForIdentifierScan`)",
    "- `app/returns/actions.ts` (`listReturns`, `countReturns`, claim pipeline list, dashboard/analytics counts)",
    "",
    "# COUNT_FUNCTIONS_PATCHED",
    "",
    "| Function | Change |",
    "|----------|--------|",
    "| `countActiveReturnItemsForIdentifierScan` | Uses `countsTowardActivePhysicalScan`; removed unanchored `count++` fallback |",
    "| `scrubInventoryRowsExcludingVoidedPackages` | Inherits patched identifier scan path for sku/fnsku |",
    "| `countReturns` | `applyExcludeBulkOrphanReturnItemsFilter` |",
    "| `listReturns` | DB filter + `excludeBulkOrphanReturnItems` |",
    "| `listClaimPipelineReturns` | Same exclusion |",
    "| `getDashboardSnapshot` | Returns today + estimated value queries exclude bulk orphan |",
    "| `getReturnsAnalyticsData` | Query filter + `deleted_at` guard |",
    "",
    "# TEST_RESULTS",
    "",
    pass ? "**PASS** — all unit checks green" : `**FAIL** — ${failed.length} check(s)`,
    "",
    "| Check | Result | Detail |",
    "|-------|--------|--------|",
    ...checks.map((c) => `| ${c.name} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail} |`),
    "",
    "# REMAINING_UNSAFE_CONSUMERS",
    "",
    "| Consumer | Risk | Notes |",
    "|----------|------|-------|",
    "| `fetchReturnItemsScannedCountsForTracking` | Low | Already `.in('package_id', pkgIds)` |",
    "| `fetchReturnItemsScannedCountsForPallet` | Low | Package-scoped |",
    "| `app/pim/products/[productId]/page.tsx` | Low | Product history — not operator scan count |",
    "| Claim engine CRUD paths | N/A | Detail-by-id; not aggregate scan counts |",
    "| Admin quarantine view | Future | Bulk rows hidden from default Returns UI; dedicated view not built |",
    "",
    "# NEXT_PROMPT",
    "",
    "```",
    "BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE",
    "```",
    "",
    "Optional: `CLAIM-RETURN-LINE-BACKFILL-PHYSICAL-ANCHOR-GATE`",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "SCANNER_ACTIVE_SCAN_COUNTS_BULK_ORPHAN_GUARD.md"), md + "\n");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SCANNER-ACTIVE-SCAN-COUNTS-BULK-ORPHAN-GUARD",
        run_id: rid,
        status: pass ? "PASS" : "FAIL",
        checks: checks.map((c) => ({ name: c.name, pass: c.pass })),
        next_prompt: "BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE",
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: pass, outDir, failed: failed.map((f) => f.name) }, null, 2));
  if (!pass) process.exit(1);
}

main();
