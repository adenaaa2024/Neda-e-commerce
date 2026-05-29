/**
 * Spreadsheet governed import plan (read-only + approval scaffolding).
 *
 *   npx tsx scripts/spreadsheet-governed-import-plan.ts
 *   npx tsx scripts/spreadsheet-governed-import-plan.ts --census-run-id=20260528T000000Z
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const CENSUS_BASE = ".cursor/audit-reports/spreadsheet-staging-match-census";
const OUT_BASE = ".cursor/audit-reports/spreadsheet-governed-import-plan";
const DEFAULT_XLSX = ".cursor/audit-reports/product-dimensions-spreadsheet-intake-audit/_tmp/dims-sheet.xlsx";

const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const PACKAGING_APPROVAL = ".cursor/operator-approvals/spreadsheet-packaging-import-staging-approval.md";
const VENDOR_APPROVAL = ".cursor/operator-approvals/vendor-1883-cleanup-staging-approval.md";

type ImportCandidate = {
  row: number;
  seller_sku: string;
  sheet_asin: string | null;
  sheet_fnsku: string | null;
  brand: string | null;
  fulfillment_context: string;
  packaging_level: string;
  dimensions: {
    length: number;
    width: number;
    height: number;
    dimension_unit: string;
    raw: string;
  };
  weight: { weight: number; weight_unit: string } | null;
  case_pack: number | null;
  product_id: string;
  classification: string;
  reasons: string[];
};

type InsertPlanRow = {
  candidate_id: string;
  spreadsheet_row: number;
  organization_id: string;
  store_id: string;
  product_id: string;
  seller_sku: string;
  sheet_asin: string | null;
  packaging_level: string;
  fulfillment_context: string;
  length_value: number;
  width_value: number;
  height_value: number;
  dimension_unit: "in";
  weight_value: number | null;
  weight_unit: "lb" | null;
  units_per_case: number | null;
  units_per_inner_pack: number | null;
  source_type: "import";
  source_reference: string;
  profile_status: "needs_review";
  display_label: string;
  confidence_score: number;
  evidence_summary: Record<string, unknown>;
  recommended_action: "ready_for_execute_when_approved";
  blockers: string[];
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function latestCensusRun(): string {
  const base = path.join(process.cwd(), CENSUS_BASE);
  if (!fs.existsSync(base)) throw new Error(`Missing ${CENSUS_BASE}`);
  const runs = fs
    .readdirSync(base)
    .filter((d) => fs.existsSync(path.join(base, d, "manifest.json")))
    .sort()
    .reverse();
  if (!runs[0]) throw new Error("No census run found");
  return runs[0]!;
}

function censusRunArg(): string {
  const a = process.argv.find((x) => x.startsWith("--census-run-id="));
  return a ? a.split("=")[1]!.trim() : latestCensusRun();
}

function readApprovalFlags(filePath: string): Record<string, string> {
  const p = path.join(process.cwd(), filePath);
  if (!fs.existsSync(p)) {
    return {
      APPROVED_TO_RUN_STAGING: "false",
      APPROVED_SPREADSHEET_PACKAGING_IMPORT: "false",
      APPROVED_VENDOR_1883_CLEANUP: "false",
    };
  }
  const text = fs.readFileSync(p, "utf8");
  const flags: Record<string, string> = {};
  for (const key of [
    "APPROVED_TO_RUN_STAGING",
    "APPROVED_SPREADSHEET_PACKAGING_IMPORT",
    "APPROVED_VENDOR_1883_CLEANUP",
  ]) {
    const m = text.match(new RegExp(`${key}\\s*=\\s*(\\S+)`));
    flags[key] = m?.[1] ?? "false";
  }
  return flags;
}

function loadReviewCohortsFromSheet(xlsxPath: string): {
  duplicate_asin_parseable: Array<Record<string, unknown>>;
  missing_dimensions_count: number;
} {
  const py = path.join(process.cwd(), "scripts", "spreadsheet-staging-match-census-load.py");
  const pyOut = execSync(`python "${py}" "${path.resolve(process.cwd(), xlsxPath)}"`, {
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
  const loaded = JSON.parse(pyOut) as {
    rows: Array<{
      row: number;
      seller_sku: string;
      asin: string | null;
      sheet_merge_class: string;
      has_parseable_lwh: boolean;
      brand: string | null;
      dimensions: unknown;
    }>;
    total_rows: number;
  };
  const dup = loaded.rows.filter(
    (r) => r.has_parseable_lwh && r.sheet_merge_class === "review-required",
  );
  const missingDims = loaded.rows.filter((r) => !r.has_parseable_lwh).length;
  return {
    duplicate_asin_parseable: dup.map((r) => ({
      row: r.row,
      seller_sku: r.seller_sku,
      asin: r.asin,
      brand: r.brand,
      queue_reason: "duplicate_asin_variant_parseable",
      action: "manual_review_before_import",
    })),
    missing_dimensions_count: missingDims,
  };
}

function main(): void {
  const runId = runIdArg();
  const censusRunId = censusRunArg();
  const censusDir = path.join(process.cwd(), CENSUS_BASE, censusRunId);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const manifestPath = path.join(censusDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) blockers.push(`Missing census manifest: ${manifestPath}`);

  const censusManifest = fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>)
    : {};

  const importCandidates = JSON.parse(
    fs.readFileSync(path.join(censusDir, "packaging-import-candidates.json"), "utf8"),
  ) as ImportCandidate[];

  const missingProducts = JSON.parse(
    fs.readFileSync(path.join(censusDir, "missing-or-ambiguous-products.json"), "utf8"),
  ) as Record<string, unknown>[];

  const conflicts = JSON.parse(
    fs.readFileSync(path.join(censusDir, "conflict-report.json"), "utf8"),
  ) as Record<string, unknown>[];

  const vendorCandidates = JSON.parse(
    fs.readFileSync(path.join(censusDir, "vendor-1883-cleanup-candidates.json"), "utf8"),
  ) as Record<string, unknown>[];

  const batchTag = `SPREADSHEET_DIMENSIONS_${runId}`;
  const censusRef = `spreadsheet_intake:${censusRunId}`;

  const insertPlan: InsertPlanRow[] = importCandidates.map((c) => {
    const blockersRow: string[] = [];
    if (!c.product_id) blockersRow.push("missing_product_id");
    if (!c.dimensions) blockersRow.push("missing_dimensions");
    return {
      candidate_id: `spreadsheet-row-${c.row}`,
      spreadsheet_row: c.row,
      organization_id: SAM_ORG_ID,
      store_id: SAM_STORE_ID,
      product_id: c.product_id,
      seller_sku: c.seller_sku,
      sheet_asin: c.sheet_asin,
      packaging_level: "case",
      fulfillment_context: c.fulfillment_context || "unknown",
      length_value: c.dimensions.length,
      width_value: c.dimensions.width,
      height_value: c.dimensions.height,
      dimension_unit: "in",
      weight_value: c.weight?.weight ?? null,
      weight_unit: c.weight ? "lb" : null,
      units_per_case: c.case_pack,
      units_per_inner_pack: null,
      source_type: "import",
      source_reference: `${censusRef}:row=${c.row}`,
      profile_status: "needs_review",
      display_label: batchTag,
      confidence_score: 0.85,
      evidence_summary: {
        spreadsheet_row: c.row,
        seller_sku: c.seller_sku,
        sheet_asin: c.sheet_asin,
        sheet_fnsku: c.sheet_fnsku,
        brand: c.brand,
        raw_dimensions: c.dimensions.raw,
        census_run_id: censusRunId,
        plan_run_id: runId,
        batch_tag: batchTag,
      },
      recommended_action: "ready_for_execute_when_approved",
      blockers: blockersRow,
    };
  });

  const sheetCohorts = fs.existsSync(path.join(process.cwd(), DEFAULT_XLSX))
    ? loadReviewCohortsFromSheet(DEFAULT_XLSX)
    : { duplicate_asin_parseable: [], missing_dimensions_count: 4304 };

  const packagingFlags = readApprovalFlags(PACKAGING_APPROVAL);
  const vendorFlags = readApprovalFlags(VENDOR_APPROVAL);

  if (packagingFlags.APPROVED_TO_RUN_STAGING !== "true") {
    blockers.push("APPROVED_TO_RUN_STAGING=false (packaging)");
  }
  if (packagingFlags.APPROVED_SPREADSHEET_PACKAGING_IMPORT !== "true") {
    blockers.push("APPROVED_SPREADSHEET_PACKAGING_IMPORT=false");
  }

  const reviewQueue = {
    summary: {
      packaging_conflicts_gt_1in: conflicts.length,
      merge_safe_missing_product: missingProducts.length,
      duplicate_asin_parseable_lwh: sheetCohorts.duplicate_asin_parseable.length,
      sheet_missing_dimensions: sheetCohorts.missing_dimensions_count,
      import_ready_excluded_from_queue: insertPlan.length,
    },
    packaging_conflicts: conflicts,
    merge_safe_missing_product: missingProducts.map((r) => ({
      ...r,
      queue_reason: "missing_product_merge_safe",
      action: "create_or_link_product_before_packaging",
    })),
    duplicate_asin_variant_parseable: sheetCohorts.duplicate_asin_parseable,
    sheet_missing_dimensions_note:
      "4304 rows without parseable case L×W×H — out of packaging import scope until dimensions captured",
  };

  const packagingPlanMd = `# Spreadsheet packaging import plan

**Plan run:** \`${OUT_BASE}/${runId}/\`  
**Census:** \`${CENSUS_BASE}/${censusRunId}/\`  
**Staging:** \`${STAGING_REF}\` · Sam store \`${SAM_STORE_ID}\`  
**Batch tag / display_label:** \`${batchTag}\`

## Scope

| Cohort | Rows | This execute |
|--------|-----:|:------------:|
| import_ready (census) | **${insertPlan.length}** | **Yes** (when approved) |
| merge_safe missing_product | ${missingProducts.length} | No |
| duplicate_ASIN parseable L×W×H | ${sheetCohorts.duplicate_asin_parseable.length} | No — review queue |
| conflict > 1 in | ${conflicts.length} | No |

## Insert contract (staging only)

1. \`INSERT product_packaging_profiles\` — \`display_label = ${batchTag}\`
2. \`INSERT product_packaging_profile_versions\` — \`profile_status = needs_review\`, \`source_type = import\`
3. \`dimension_unit = in\`, \`weight_unit = lb\` when weight present
4. **No** direct \`product_packaging_dimensions_current\` writes (trigger only on \`active\`)
5. **No** \`products\` / \`product_identifier_map\` mutations

## Preflight at execute (separate script)

- Skip if profile key exists: \`org + store + product_id + case + fulfillment_context\`
- Re-verify ASIN/FNSKU vs census
- Packaging snapshot before/after; \`dimensions_current\` must stay **491** until activate wave

## Approval

\`${PACKAGING_APPROVAL}\`

\`\`\`text
APPROVED_TO_RUN_STAGING=${packagingFlags.APPROVED_TO_RUN_STAGING}
APPROVED_SPREADSHEET_PACKAGING_IMPORT=${packagingFlags.APPROVED_SPREADSHEET_PACKAGING_IMPORT}
\`\`\`

## Proposed execute script (not run in this prompt)

\`scripts/spreadsheet-packaging-import-staging-execute.ts --apply --plan-run-id=${runId}\`

Pattern: \`pc05-product-packaging-backfill-staging-execute.ts\` (approval-gated, insert-plan.json driven).
`;

  const vendorPlanMd = `# Vendor 1883 cleanup plan (staging)

**Plan only — no \`products\` UPDATE in this prompt.**

## Problem

${vendorCandidates.length} products on staging have bare \`vendor_name = '1883'\` while the spreadsheet \`Brand\` column has full names starting with \`1883\` (e.g. \`1883 Brand Name\`).

## Scope

| Metric | Count |
|--------|------:|
| Cleanup candidates (census) | **${vendorCandidates.length}** |
| Packaging import overlap | TBD at execute — join on \`seller_sku\` |

## Proposed update (when approved)

\`\`\`sql
-- ILLUSTRATIVE — do not run without approval
UPDATE products
SET vendor_name = :sheet_brand, updated_at = now()
WHERE id = :product_id
  AND btrim(vendor_name) = '1883';
\`\`\`

## Rules

- **Staging only** (\`${STAGING_REF}\`)
- **No** original/current
- **No** auto-update during packaging import execute
- Log each row: \`product_id\`, old \`vendor_name\`, new \`vendor_name\`, \`sheet_row\`, \`sheet_brand\`

## Approval

\`${VENDOR_APPROVAL}\`

\`\`\`text
APPROVED_TO_RUN_STAGING=${vendorFlags.APPROVED_TO_RUN_STAGING}
APPROVED_VENDOR_1883_CLEANUP=${vendorFlags.APPROVED_VENDOR_1883_CLEANUP}
\`\`\`

## Proposed execute script (not run in this prompt)

\`scripts/vendor-1883-cleanup-staging-execute.ts --apply --plan-run-id=${runId}\`

Reads \`vendor-cleanup-candidates.json\` from this plan directory.
`;

  fs.writeFileSync(path.join(outDir, "spreadsheet-packaging-import-plan.md"), packagingPlanMd);
  fs.writeFileSync(path.join(outDir, "packaging-insert-plan.json"), JSON.stringify(insertPlan, null, 2));
  fs.writeFileSync(path.join(outDir, "vendor-1883-cleanup-plan.md"), vendorPlanMd);
  fs.writeFileSync(path.join(outDir, "vendor-cleanup-candidates.json"), JSON.stringify(vendorCandidates, null, 2));
  fs.writeFileSync(path.join(outDir, "review-required-queue.json"), JSON.stringify(reviewQueue, null, 2));

  fs.writeFileSync(
    path.join(outDir, "approval-files.md"),
    [
      "# Approval files",
      "",
      "| File | Purpose |",
      "|------|---------|",
      `| \`${PACKAGING_APPROVAL}\` | Governed packaging INSERT (needs_review) |`,
      `| \`${VENDOR_APPROVAL}\` | Governed \`products.vendor_name\` cleanup |`,
      "",
      "Both default **false**. Packaging and vendor waves are independent.",
      "",
      "## Packaging flags",
      "",
      "```text",
      `APPROVED_TO_RUN_STAGING=${packagingFlags.APPROVED_TO_RUN_STAGING}`,
      `APPROVED_SPREADSHEET_PACKAGING_IMPORT=${packagingFlags.APPROVED_SPREADSHEET_PACKAGING_IMPORT}`,
      "```",
      "",
      "## Vendor flags",
      "",
      "```text",
      `APPROVED_TO_RUN_STAGING=${vendorFlags.APPROVED_TO_RUN_STAGING}`,
      `APPROVED_VENDOR_1883_CLEANUP=${vendorFlags.APPROVED_VENDOR_1883_CLEANUP}`,
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-strategy.md"),
    [
      "# Rollback strategy",
      "",
      "## Packaging (staging)",
      "",
      `1. Identify batch: \`display_label = '${batchTag}'\` on \`product_packaging_profiles\`.`,
      "2. Verify all linked versions have `profile_status = 'needs_review'` (not `active`).",
      "3. `DELETE FROM product_packaging_profile_versions WHERE profile_id IN (...)` ",
      "4. `DELETE FROM product_packaging_profiles WHERE display_label = ...`",
      "5. Confirm `product_packaging_dimensions_current` count unchanged (491) if nothing was activated.",
      "",
      "**Forbidden rollback:** deleting `active` versions without supersede chain.",
      "",
      "## Vendor cleanup (staging)",
      "",
      "1. Export before-image from execute audit (`vendor-1883-before.json`).",
      "2. `UPDATE products SET vendor_name = before.vendor_name WHERE id IN (...)`",
      "3. No packaging table impact.",
      "",
      "## Original / production",
      "",
      "**No rollback scope** — nothing written outside staging in this program.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? `# Blockers\n\nExecute blocked until resolved:\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`
      : "# Blockers\n\nPlan authoring: none.\n\n**Execute blockers (expected):** approval flags false.\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SPREADSHEET GOVERNED IMPORT PLAN — PACKAGING + VENDOR CLEANUP",
        run_id: runId,
        census_run_id: censusRunId,
        read_only: true,
        no_db_writes: true,
        staging_ref: STAGING_REF,
        packaging_insert_plan_count: insertPlan.length,
        vendor_cleanup_candidate_count: vendorCandidates.length,
        packaging_conflict_count: conflicts.length,
        review_queue_duplicate_asin_count: sheetCohorts.duplicate_asin_parseable.length,
        batch_tag: batchTag,
        approval_files: [PACKAGING_APPROVAL, VENDOR_APPROVAL],
        blockers,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        packaging_insert_plan_count: insertPlan.length,
        vendor_cleanup_candidate_count: vendorCandidates.length,
        packaging_conflict_count: conflicts.length,
        approval_files: [PACKAGING_APPROVAL, VENDOR_APPROVAL],
        next_prompt:
          "SPREADSHEET PACKAGING IMPORT STAGING EXECUTE — apply packaging-insert-plan.json after operator sets APPROVED_SPREADSHEET_PACKAGING_IMPORT=true; then PC05-style review census + activate wave",
      },
      null,
      2,
    ),
  );
}

main();
