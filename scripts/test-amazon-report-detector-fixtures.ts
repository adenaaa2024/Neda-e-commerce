/**
 * Read-only fixture tests for `classifyCsvHeadersRuleBased` (Amazon report routing).
 * No DB, no SP-API, no AI.
 *
 * Run: `npm run test:amazon-report-detectors` or `npx tsx scripts/test-amazon-report-detector-fixtures.ts`
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  AMAZON_REPORT_CROSSWALK_LIVE,
  resolveSpApiReportTypeToSyncKind,
  SP_API_REPORT_TYPE_TO_SYNC_KIND,
} from "../lib/amazon/amazon-report-type-crosswalk";
import { classifyCsvHeadersRuleBased } from "../lib/csv-import-detected-type";
import type { AmazonSyncKind } from "../lib/pipeline/amazon-report-registry";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "amazon-report-headers");

type FixtureFile = {
  id: string;
  description?: string;
  headers: string[];
  expect_report_type?: string | null;
  skip_detector?: boolean;
  reason?: string;
};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function crosswalkSpApiKeysAlignRegistry(): void {
  for (const [spType, kind] of Object.entries(SP_API_REPORT_TYPE_TO_SYNC_KIND) as [string, AmazonSyncKind][]) {
    const resolved = resolveSpApiReportTypeToSyncKind(spType);
    assert(resolved === kind, `crosswalk SP type ${spType}: map says ${kind}, resolver says ${String(resolved)}`);
  }
}

function main(): void {
  crosswalkSpApiKeysAlignRegistry();

  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  assert(files.length > 0, `No JSON fixtures in ${FIXTURE_DIR}`);

  let passed = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const name of files.sort()) {
    const full = path.join(FIXTURE_DIR, name);
    const raw = fs.readFileSync(full, "utf8");
    const fixture = JSON.parse(raw) as FixtureFile;

    if (fixture.skip_detector) {
      skipped++;
      // eslint-disable-next-line no-console -- test runner
      console.log(`[SKIP] ${fixture.id}: ${fixture.reason ?? "skip_detector"}`);
      continue;
    }

    const { reportType, matchedRule } = classifyCsvHeadersRuleBased(fixture.headers);
    if (reportType !== fixture.expect_report_type) {
      failures.push(
        `${fixture.id} (${name}): expected ${String(fixture.expect_report_type)}, got ${reportType} (rule: ${matchedRule})`,
      );
    } else {
      passed++;
      // eslint-disable-next-line no-console -- test runner
      console.log(`[OK]   ${fixture.id} → ${reportType} (${matchedRule})`);
    }
  }

  // Crosswalk live rows reference registry kinds only
  for (const row of AMAZON_REPORT_CROSSWALK_LIVE) {
    assert(
      typeof row.amazon_sync_kind === "string" && row.amazon_sync_kind.length > 0,
      `crosswalk row ${row.crosswalk_id} missing amazon_sync_kind`,
    );
  }

  if (failures.length) {
    // eslint-disable-next-line no-console -- test runner
    console.error("\n--- FAILURES ---\n" + failures.join("\n"));
    process.exit(1);
  }

  // eslint-disable-next-line no-console -- test runner
  console.log(`\nDone: ${passed} passed, ${skipped} skipped (placeholders), ${files.length} files total.`);
}

main();
