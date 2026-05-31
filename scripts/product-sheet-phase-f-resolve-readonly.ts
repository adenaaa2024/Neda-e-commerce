/**
 * PRODUCT-SHEET-PHASE-F-RESOLVE-READONLY
 *   npx tsx scripts/product-sheet-phase-f-resolve-readonly.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const DRYRUN_ID = "20260530T065129Z";
const DRYRUN_DIR = `.cursor/audit-reports/product-sheet-import-pim-normalization-dryrun/${DRYRUN_ID}`;
const CENSUS_DIR = `.cursor/audit-reports/product-spreadsheet-staging-match-census-dryrun/${DRYRUN_ID}`;
const OUT_BASE = ".cursor/audit-reports/product-sheet-phase-f-resolve-readonly";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const DEFAULT_XLSX = ".cursor/audit-reports/product-dimensions-spreadsheet-intake-audit/_tmp/dims-sheet.xlsx";

type Row = Record<string, string>;

type ReviewClass = "A" | "B" | "C" | "D" | "E";

const REVIEW_LABELS: Record<ReviewClass, string> = {
  A: "true conflict: must not apply",
  B: "duplicate ASIN but same product: eligible after grouping",
  C: "duplicate ASIN but different product/vendor: needs manual",
  D: "blocked create but strong identity: eligible for governed product seed later",
  E: "blocked create weak identity: no apply",
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const o: Row = {};
    headers.forEach((h, i) => {
      o[h] = vals[i] ?? "";
    });
    return o;
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(
    filePath,
    [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") + "\n",
  );
}

function asinOk(s: string): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(s.trim());
}

function fnskuOk(s: string): boolean {
  return /^X0[A-Z0-9]{8,}$/i.test(s.trim());
}

function loadMergeSafeRowIds(xlsxPath: string): Set<string> {
  const pyScript = path.join(process.cwd(), "scripts", "spreadsheet-staging-match-census-load-ext.py");
  const pyOut = execSync(`python "${pyScript}" "${xlsxPath}"`, { encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
  const loaded = JSON.parse(pyOut) as { merge_safe_rows: Array<{ row: number }> };
  return new Set(loaded.merge_safe_rows.map((r) => String(r.row)));
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dryDir = path.join(process.cwd(), DRYRUN_DIR);
  const censusDir = path.join(process.cwd(), CENSUS_DIR);
  const allRowsPath = path.join(censusDir, "all-classified-rows.csv");
  if (!fs.existsSync(allRowsPath)) {
    throw new Error(`Missing ${allRowsPath}`);
  }

  const classified = parseCsv(fs.readFileSync(allRowsPath, "utf8"));
  const existingUpdates = parseCsv(fs.readFileSync(path.join(dryDir, "existing-product-updates.csv"), "utf8"));
  const mapInserts = parseCsv(fs.readFileSync(path.join(dryDir, "proposed-identifier-map-inserts.csv"), "utf8"));
  const catalogUpserts = parseCsv(fs.readFileSync(path.join(dryDir, "proposed-catalog-product-upserts.csv"), "utf8"));
  const blockedCreates = parseCsv(fs.readFileSync(path.join(dryDir, "proposed-product-inserts.csv"), "utf8"));

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const productById = new Map<string, { asin: string | null; fnsku: string | null; sku: string | null; vendor_name: string | null }>();
  if (dbUrl) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const pr = await client.query(
      `SELECT id::text, upper(trim(asin)) AS asin, upper(trim(fnsku)) AS fnsku, sku, vendor_name
       FROM products WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
      [SAM_ORG, SAM_STORE],
    );
    for (const r of pr.rows as { id: string; asin: string | null; fnsku: string | null; sku: string | null; vendor_name: string | null }[]) {
      productById.set(r.id, r);
    }
    await client.end();
  }

  const idMismatches = classified.filter((r) => r.classification === "identifier_mismatch");
  const mismatchReview = idMismatches.map((r) => {
    const prod = r.product_id ? productById.get(r.product_id) : undefined;
    return {
      review_class: "A" as ReviewClass,
      spreadsheet_row: r.spreadsheet_row,
      seller_sku: r.seller_sku,
      sheet_asin: r.sheet_asin,
      sheet_fnsku: r.sheet_fnsku,
      brand: r.brand,
      product_id: r.product_id,
      products_asin: prod?.asin ?? "",
      products_fnsku: prod?.fnsku ?? "",
      mismatch_reason: (r.reasons ?? "").split(",").find((x) => x.includes("mismatch")) ?? r.reasons,
      action: "must_not_apply_until_manual_identifier_reconciliation",
    };
  });

  const asinGroups = new Map<string, Row[]>();
  for (const r of classified) {
    const asin = (r.sheet_asin ?? "").trim().toUpperCase();
    if (!asinOk(asin)) continue;
    const g = asinGroups.get(asin) ?? [];
    g.push(r);
    asinGroups.set(asin, g);
  }

  const duplicateAsinGroups: Record<string, unknown>[] = [];
  const dupClassCounts: Record<ReviewClass, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };

  for (const [asin, rows] of asinGroups) {
    if (rows.length < 2) continue;
    const productIds = new Set(rows.map((r) => r.product_id?.trim()).filter(Boolean));
    const brands = new Set(rows.map((r) => (r.brand ?? "").trim().toLowerCase()).filter(Boolean));
    const skus = new Set(rows.map((r) => (r.seller_sku ?? "").trim()).filter(Boolean));
    let reviewClass: ReviewClass = "C";
    if (productIds.size <= 1 && brands.size <= 1) reviewClass = "B";
    else if (productIds.size <= 1 && skus.size > 1) reviewClass = "B";
    dupClassCounts[reviewClass] += 1;
    duplicateAsinGroups.push({
      review_class: reviewClass,
      sheet_asin: asin,
      row_count: rows.length,
      distinct_seller_skus: skus.size,
      distinct_product_ids: productIds.size,
      distinct_brands: brands.size,
      sample_rows: rows.slice(0, 5).map((r) => ({
        spreadsheet_row: r.spreadsheet_row,
        seller_sku: r.seller_sku,
        brand: r.brand,
        product_id: r.product_id,
        classification: r.classification,
      })),
    });
  }

  const blockedReview: Record<string, unknown>[] = [];
  const blockedClassCounts: Record<ReviewClass, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const r of blockedCreates) {
    const asin = (r.sheet_asin ?? "").trim().toUpperCase();
    const fnsku = (r.sheet_fnsku ?? "").trim().toUpperCase();
    const strong = asinOk(asin) && fnskuOk(fnsku);
    const dupGroup = asinGroups.get(asin);
    const dupConflict = dupGroup && dupGroup.length > 1 && dupGroup.some((x) => (x.brand ?? "").trim() !== (r.brand ?? "").trim());
    let reviewClass: ReviewClass = "E";
    if (strong && !dupConflict) reviewClass = "D";
    else if (dupConflict) reviewClass = "C";
    blockedClassCounts[reviewClass] += 1;
    blockedReview.push({
      review_class: reviewClass,
      spreadsheet_row: r.spreadsheet_row,
      seller_sku: r.seller_sku,
      sheet_asin: asin,
      sheet_fnsku: fnsku,
      brand: r.brand,
      strong_identity: strong,
      duplicate_asin_group_size: dupGroup?.length ?? 0,
      block_reason: r.block_reason,
    });
  }

  const xlsxPath = path.resolve(process.cwd(), DEFAULT_XLSX);
  const mergeSafeRowIds = fs.existsSync(xlsxPath) ? loadMergeSafeRowIds(xlsxPath) : new Set<string>();

  function isSampleWaveEligible(row: Row): boolean {
    const cls = row.classification ?? "";
    if (["identifier_mismatch", "unsafe_product_create_candidate", "missing_product", "ambiguous_identifier"].includes(cls)) {
      return false;
    }
    if (!row.product_id?.trim()) return false;
    return mergeSafeRowIds.has(String(row.spreadsheet_row));
  }

  const classCAsinRows = new Set<string>();
  for (const g of duplicateAsinGroups) {
    if (g.review_class !== "C") continue;
    const asin = String(g.sheet_asin);
    for (const r of asinGroups.get(asin) ?? []) classCAsinRows.add(r.spreadsheet_row);
  }

  const mismatchRows = new Set(idMismatches.map((r) => r.spreadsheet_row));
  const blockedRows = new Set(blockedCreates.map((r) => r.spreadsheet_row));

  function isTier2SampleEligible(row: Row): boolean {
    if (mismatchRows.has(row.spreadsheet_row)) return false;
    if (blockedRows.has(row.spreadsheet_row)) return false;
    if (classCAsinRows.has(row.spreadsheet_row)) return false;
    const cls = row.classification ?? "";
    if (["identifier_mismatch", "unsafe_product_create_candidate", "missing_product", "ambiguous_identifier"].includes(cls)) {
      return false;
    }
    if (!row.product_id?.trim()) return false;
    if ((row.reasons ?? "").includes("sheet_review_required_duplicate_asin_or_conflict")) return false;
    return true;
  }

  const sampleEligibleRows = classified.filter(isSampleWaveEligible);
  const tier2EligibleRows = sampleEligibleRows.length ? sampleEligibleRows : classified.filter(isTier2SampleEligible);
  const sampleTier = sampleEligibleRows.length ? "tier1_sheet_merge_safe" : "tier2_conflict_free_resolved";
  const sampleEligibleIds = new Set(tier2EligibleRows.map((r) => r.spreadsheet_row));

  const sampleNullFill = existingUpdates
    .filter((r) => sampleEligibleIds.has(r.spreadsheet_row))
    .filter((r) => r.patch_asin_if_null || r.patch_fnsku_if_null)
    .slice(0, 25);

  const sampleMap = mapInserts
    .filter((r) => sampleEligibleIds.has(r.spreadsheet_row))
    .slice(0, 25);

  const sampleCatalog = catalogUpserts
    .filter((r) => sampleEligibleIds.has(r.spreadsheet_row))
    .filter((r) => asinOk(r.sheet_asin ?? ""))
    .slice(0, 25);

  writeCsv(path.join(outDir, "identifier-mismatch-review-queue.csv"), Object.keys(mismatchReview[0] ?? {}), mismatchReview);
  writeCsv(
    path.join(outDir, "duplicate-asin-groups.csv"),
    ["review_class", "sheet_asin", "row_count", "distinct_seller_skus", "distinct_product_ids", "distinct_brands"],
    duplicateAsinGroups,
  );
  writeCsv(
    path.join(outDir, "blocked-creates-classification.csv"),
    ["review_class", "spreadsheet_row", "seller_sku", "sheet_asin", "sheet_fnsku", "brand", "strong_identity", "duplicate_asin_group_size", "block_reason"],
    blockedReview,
  );
  writeCsv(path.join(outDir, "sample-wave-null-fill.csv"), Object.keys(sampleNullFill[0] ?? existingUpdates[0] ?? {}), sampleNullFill);
  writeCsv(path.join(outDir, "sample-wave-map-inserts.csv"), Object.keys(sampleMap[0] ?? mapInserts[0] ?? {}), sampleMap);
  writeCsv(path.join(outDir, "sample-wave-catalog-upserts.csv"), Object.keys(sampleCatalog[0] ?? catalogUpserts[0] ?? {}), sampleCatalog);

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();

  const conflictSummary = `# CONFLICT_SUMMARY

**Run:** \`${OUT_BASE}/${runId}/\`  
**Dry-run source:** \`${DRYRUN_DIR}/\`  
**Branch:** \`${branch}\`  
**Mode:** read-only · no DB writes

## Dry-run buckets (source)

| Bucket | Count |
|--------|------:|
| Total sheet rows | 4479 |
| A — existing product null-fill candidates | 2678 |
| B — blocked product inserts | 1700 |
| C — identifier map inserts | 233 |
| D — catalog upserts | 2779 |
| E — packaging/spec | 32 |
| F — conflicts/needs-review (unique) | 3399 |
| Identifier mismatch | 21 |
| Duplicate ASIN keys (sheet) | 984 |
| Sheet merge-safe rows | 90 |

## Phase F resolution totals

| Review class | Meaning | Count |
|--------------|---------|------:|
| **A** | True conflict — must not apply | **${mismatchReview.length}** identifier mismatches + **0** auto-applies |
| **B** | Duplicate ASIN, same product — group then apply | **${dupClassCounts.B}** ASIN groups |
| **C** | Duplicate ASIN, different product/vendor — manual | **${dupClassCounts.C}** ASIN groups |
| **D** | Blocked create, strong identity — governed seed later | **${blockedClassCounts.D}** rows |
| **E** | Blocked create, weak identity — no apply | **${blockedClassCounts.E}** rows |

## Gate before any apply

1. Resolve all **21** identifier mismatches (class **A**) — never overwrite \`products\`/map from sheet without operator sign-off.
2. Triage **984** duplicate ASIN keys — only **${dupClassCounts.B}** groups are same-product eligible; **${dupClassCounts.C}** need manual vendor/product grouping.
3. **1,700** blocked creates stay blocked — **${blockedClassCounts.D}** may enter governed product-seed queue after duplicate cleanup; **${blockedClassCounts.E}** remain hold.
4. Sample wave uses **${sampleTier}** — **${tier2EligibleRows.length}** eligible rows (${sampleEligibleRows.length} sheet merge-safe with \`product_id\`; **${mergeSafeRowIds.size}** merge-safe total on sheet).
`;

  const duplicateSection = `# DUPLICATE_ASIN_GROUPS

**984** duplicate ASIN keys on sheet → **${duplicateAsinGroups.length}** multi-row ASIN groups analyzed.

| Class | Groups | Action |
|-------|-------:|--------|
| B — same product/vendor | ${dupClassCounts.B} | Collapse to one catalog/map target per ASIN+product; then eligible for C/D/A buckets |
| C — different product/vendor | ${dupClassCounts.C} | Manual queue — do not merge by ASIN alone |

Full group list: \`duplicate-asin-groups.csv\` (${duplicateAsinGroups.length} groups).
`;

  const mismatchSection = `# IDENTIFIER_MISMATCHES

All **21** rows are class **A** (true conflict). SKU resolves \`products.sku\` under org+store, but sheet ASIN/FNSKU disagrees with \`products\` or \`product_identifier_map\`.

| Pattern | Count |
|---------|------:|
| \`products_asin_mismatch\` | ${mismatchReview.filter((r) => String(r.mismatch_reason).includes("products_asin")).length} |
| \`products_fnsku_mismatch\` | ${mismatchReview.filter((r) => String(r.mismatch_reason).includes("products_fnsku")).length} |
| \`map_fnsku_mismatch\` | ${mismatchReview.filter((r) => String(r.mismatch_reason).includes("map_fnsku")).length} |

**Rule:** No null-fill, map insert, or catalog upsert from sheet identifiers on these rows until operator picks canonical side (DB vs sheet).

Queue: \`identifier-mismatch-review-queue.csv\`
`;

  const blockedSection = `# BLOCKED_CREATES_CLASSIFICATION

**1,700** proposed product inserts — all blocked (\`insert_allowed=false\`).

| Class | Rows | Meaning |
|-------|-----:|---------|
| **D** | ${blockedClassCounts.D} | Valid B0 ASIN + X0 FNSKU, no cross-brand duplicate ASIN conflict — candidate for **governed product seed** prompt later |
| **C** | ${blockedClassCounts.C} | Blocked create on duplicate ASIN with brand/vendor conflict |
| **E** | ${blockedClassCounts.E} | Missing/weak identifiers or duplicate-only sheet row — **no apply** |

Full list: \`blocked-creates-classification.csv\`
`;

  const sampleSection = `# SAMPLE_WAVE_CANDIDATES

**Zero product creates.** Sample tier: \`${sampleTier}\` — **${tier2EligibleRows.length}** eligible rows.

| Wave slice | Selected | Max | File |
|------------|---------:|----:|------|
| Existing product null-fill | ${sampleNullFill.length} | 25 | \`sample-wave-null-fill.csv\` |
| Deterministic map inserts | ${sampleMap.length} | 25 | \`sample-wave-map-inserts.csv\` |
| Catalog upserts | ${sampleCatalog.length} | 25 | \`sample-wave-catalog-upserts.csv\` |
| Product creates | **0** | 0 | — |

**Preconditions for sample wave apply:** operator approval; staging only; no title/vendor overwrite; UPC not in sample wave.
`;

  const approvalTemplate = `# APPROVAL_TEMPLATE — Product sheet Phase F sample wave (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Target ref | \`eiqfaapyumhixxoeltgu\` |
| Org | \`${SAM_ORG}\` |
| Store | \`${SAM_STORE}\` |
| Dry-run | \`${DRYRUN_DIR}/\` |
| Resolve plan | \`${OUT_BASE}/${runId}/\` |

## Scope (sample wave only)

| Operation | Max rows | File |
|-----------|---------:|------|
| \`products\` null-fill ASIN/FNSKU | 25 | \`sample-wave-null-fill.csv\` |
| \`product_identifier_map\` insert | 25 | \`sample-wave-map-inserts.csv\` |
| \`catalog_products\` upsert | 25 | \`sample-wave-catalog-upserts.csv\` |
| \`products\` INSERT | **0** | forbidden |

## Forbidden

- Product create from sheet title/description
- \`product_name\` / vendor bulk overwrite
- Apply on identifier_mismatch rows (21)
- Apply on duplicate-ASIN class C groups without manual sign-off
- UPC-primary joins

## Required operator flags

\`\`\`text
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_SHEET_PHASE_F_SAMPLE_WAVE=true
APPROVED_NULL_FILL_ONLY=true
APPROVED_MAP_INSERT_MAX_25=true
APPROVED_CATALOG_UPSERT_MAX_25=true
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
\`\`\`

## Sign-off

\`\`\`
Approved by:
UTC date:
Notes:
\`\`\`
`;

  const nextPrompt = `# EXACT_NEXT_PROMPT

\`\`\`text
PRODUCT-SHEET-PHASE-F-SAMPLE-WAVE-STAGING-EXECUTE

After operator signs APPROVAL_TEMPLATE in this folder:
- Apply sample-wave-null-fill.csv (≤25 null-fill only)
- Apply sample-wave-map-inserts.csv (≤25 map inserts)
- Apply sample-wave-catalog-upserts.csv (≤25 catalog upserts)
- Zero product INSERT
- Staging ref eiqfaapyumhixxoeltgu only
- Note: tier1 sheet merge-safe has 0 resolved products; sample uses tier2 conflict-free resolved rows if needed
\`\`\`

\`\`\`text
PRODUCT-SHEET-IDENTIFIER-MISMATCH-REVIEW-QUEUE

Export 21 class-A rows for operator decision (DB canonical vs sheet correction).
No automated apply.
\`\`\`

\`\`\`text
PRODUCT-SHEET-DUPLICATE-ASIN-MANUAL-TRIAGE

Manual review of ${dupClassCounts.C} class-C duplicate ASIN groups before broad catalog/map apply.
\`\`\`
`;

  const fullReport = [
    conflictSummary,
    duplicateSection,
    mismatchSection,
    blockedSection,
    sampleSection,
    approvalTemplate,
    nextPrompt,
  ].join("\n\n");

  fs.writeFileSync(path.join(outDir, "phase-f-resolve-report.md"), fullReport);
  fs.writeFileSync(path.join(outDir, "approval-template.md"), approvalTemplate);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit_id: "PRODUCT-SHEET-PHASE-F-RESOLVE-READONLY",
        run_id: runId,
        dryrun_source: DRYRUN_DIR,
        mode: "read-only",
        identifier_mismatch_count: mismatchReview.length,
        duplicate_asin_groups: duplicateAsinGroups.length,
        duplicate_asin_class_B: dupClassCounts.B,
        duplicate_asin_class_C: dupClassCounts.C,
        blocked_create_D: blockedClassCounts.D,
        blocked_create_E: blockedClassCounts.E,
        merge_safe_sheet_rows: mergeSafeRowIds.size,
        sample_wave_tier: sampleTier,
        sample_wave_eligible: tier2EligibleRows.length,
        sample_wave_merge_safe_with_product: sampleEligibleRows.length,
        sample_wave: {
          null_fill: sampleNullFill.length,
          map_inserts: sampleMap.length,
          catalog_upserts: sampleCatalog.length,
          product_creates: 0,
        },
      },
      null,
      2,
    ),
  );

  console.log(fullReport);
  console.log(`\nWrote ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
