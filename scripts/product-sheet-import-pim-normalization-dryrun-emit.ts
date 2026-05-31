/**
 * PRODUCT-SHEET-IMPORT-PIM-NORMALIZATION-DRYRUN — emit artifacts from census run
 *
 *   npx tsx scripts/product-sheet-import-pim-normalization-dryrun-emit.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1T66cBdEUXSdTFasNZ0ax1AtlwbI_89Fk3ZinpX07Mu8/edit";
const CENSUS_BASE = ".cursor/audit-reports/product-spreadsheet-staging-match-census-dryrun";
const OUT_BASE = ".cursor/audit-reports/product-sheet-import-pim-normalization-dryrun";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type Row = Record<string, string>;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function censusRunId(): string {
  const a = process.argv.find((x) => x.startsWith("--census-run-id="));
  return a ? a.split("=")[1]!.trim() : runIdArg();
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

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

function asinOk(s: string): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(s.trim());
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const censusId = censusRunId();
  const censusDir = path.join(process.cwd(), CENSUS_BASE, censusId);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const allRowsPath = path.join(censusDir, "all-classified-rows.csv");
  if (!fs.existsSync(allRowsPath)) {
    throw new Error(`Missing ${allRowsPath} — run product-spreadsheet-staging-match-census-dryrun first`);
  }

  const rows = parseCsv(fs.readFileSync(allRowsPath, "utf8"));
  loadEnvLocalIntoProcess();

  const mapByProduct = new Map<string, { asins: Set<string>; fnskus: Set<string> }>();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (dbUrl) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const mr = await client.query(
      `SELECT product_id::text, upper(trim(asin)) AS asin, upper(trim(fnsku)) AS fnsku
       FROM public.product_identifier_map
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND product_id IS NOT NULL`,
      [SAM_ORG],
    );
    for (const r of mr.rows as { product_id: string; asin: string | null; fnsku: string | null }[]) {
      const pid = String(r.product_id);
      const entry = mapByProduct.get(pid) ?? { asins: new Set(), fnskus: new Set() };
      if (r.asin) entry.asins.add(r.asin);
      if (r.fnsku) entry.fnskus.add(r.fnsku);
      mapByProduct.set(pid, entry);
    }
    await client.end();
  }

  const existingUpdates: Record<string, unknown>[] = [];
  const proposedInserts: Record<string, unknown>[] = [];
  const mapInserts: Record<string, unknown>[] = [];
  const catalogUpserts: Record<string, unknown>[] = [];
  const specNorm: Record<string, unknown>[] = [];
  const conflicts: Record<string, unknown>[] = [];

  for (const r of rows) {
    const cls = r.classification ?? "";
    const pid = r.product_id?.trim() || "";
    const sku = r.seller_sku?.trim() || "";
    const asin = r.sheet_asin?.trim().toUpperCase() || "";
    const fnsku = r.sheet_fnsku?.trim().toUpperCase() || "";
    const brand = r.brand?.trim() || "";
    const reasons = r.reasons ?? "";

    const base = {
      spreadsheet_row: r.spreadsheet_row,
      seller_sku: sku,
      sheet_asin: asin,
      sheet_fnsku: fnsku,
      brand,
      classification: cls,
      product_id: pid,
      reasons,
    };

    if (["identifier_mismatch", "ambiguous_identifier", "unsafe_product_create_candidate", "missing_product"].includes(cls)) {
      conflicts.push({ ...base, action_class: "F_needs_review_or_blocked" });
    } else if (cls === "needs_review") {
      conflicts.push({ ...base, action_class: "F_needs_review" });
    }

    if (cls === "unsafe_product_create_candidate" || cls === "missing_product") {
      proposedInserts.push({
        ...base,
        insert_allowed: "false",
        block_reason: "forbidden_auto_create_without_governed_product_seed",
      });
    }

    if (pid && cls === "identifier_mismatch") {
      conflicts.push({ ...base, action_class: "F_identifier_conflict" });
    }

    if (pid && !["identifier_mismatch", "ambiguous_identifier", "unsafe_product_create_candidate", "missing_product"].includes(cls)) {
      const map = mapByProduct.get(pid) ?? { asins: new Set(), fnskus: new Set() };
      if (asin && asinOk(asin) && !map.asins.has(asin)) {
        mapInserts.push({
          ...base,
          identifier_type: "asin",
          identifier_value: asin,
          match_source: "spreadsheet_import_dryrun",
          confidence_score: cls === "already_imported_packaging" ? 0.95 : 0.85,
        });
      }
      if (fnsku && /^X0[A-Z0-9]{8,}$/i.test(fnsku) && !map.fnskus.has(fnsku)) {
        mapInserts.push({
          ...base,
          identifier_type: "fnsku",
          identifier_value: fnsku,
          match_source: "spreadsheet_import_dryrun",
          confidence_score: 0.85,
        });
      }
    }

    if (sku && asin && asinOk(asin) && !["unsafe_product_create_candidate", "missing_product"].includes(cls)) {
      catalogUpserts.push({
        ...base,
        source_report_type: "spreadsheet_product_sheet",
        item_name: "",
        fulfillment_channel: r.fulfillment_context ?? "",
        upsert_fn: "merge_catalog_product_from_listing_json",
      });
    }

    if (pid && ["already_imported_packaging", "packaging_candidate_existing_product"].includes(cls)) {
      specNorm.push({
        ...base,
        target_table: "product_packaging_profile_versions",
        packaging_level: r.packaging_level || "case",
        fulfillment_context: r.fulfillment_context || "unknown",
        length_in: r.length_in,
        width_in: r.width_in,
        height_in: r.height_in,
        weight_lb: r.weight_lb,
        case_pack: r.case_pack,
        selling_pack: r.selling_pack,
        ti: r.ti,
        hi: r.hi,
        cases_per_pallet: r.cases_per_pallet,
        source_type: "import",
        profile_status: "needs_review",
        brand_evidence: brand,
      });
    } else if (pid && r.length_in && cls === "needs_review") {
      specNorm.push({
        ...base,
        target_table: "product_packaging_profile_versions",
        note: "blocked_until_sheet_merge_safe_and_identifier_clean",
        profile_status: "needs_review",
      });
    }

    if (pid && cls !== "identifier_mismatch" && cls !== "already_imported_packaging") {
      existingUpdates.push({
        ...base,
        proposed_products_patch: "fill_null_identifiers_only_no_title_merge",
        patch_asin_if_null: asin && asinOk(asin) ? asin : "",
        patch_fnsku_if_null: fnsku || "",
        forbidden: "vendor_name,product_name,title_overwrite",
      });
    }
  }

  const uniqueConflicts = conflicts.filter(
    (r, i, arr) => arr.findIndex((x) => x.spreadsheet_row === r.spreadsheet_row) === i,
  );

  writeCsv(
    path.join(outDir, "existing-product-updates.csv"),
    ["spreadsheet_row", "seller_sku", "product_id", "classification", "proposed_products_patch", "patch_asin_if_null", "patch_fnsku_if_null", "forbidden", "reasons"],
    existingUpdates,
  );
  writeCsv(
    path.join(outDir, "proposed-product-inserts.csv"),
    ["spreadsheet_row", "seller_sku", "sheet_asin", "sheet_fnsku", "brand", "insert_allowed", "block_reason", "reasons"],
    proposedInserts,
  );
  writeCsv(
    path.join(outDir, "proposed-identifier-map-inserts.csv"),
    ["spreadsheet_row", "product_id", "seller_sku", "identifier_type", "identifier_value", "match_source", "confidence_score", "classification"],
    mapInserts,
  );
  writeCsv(
    path.join(outDir, "proposed-catalog-product-upserts.csv"),
    ["spreadsheet_row", "seller_sku", "sheet_asin", "sheet_fnsku", "fulfillment_channel", "source_report_type", "upsert_fn", "classification"],
    catalogUpserts,
  );
  writeCsv(
    path.join(outDir, "proposed-spec-normalization.csv"),
    ["spreadsheet_row", "product_id", "seller_sku", "target_table", "packaging_level", "fulfillment_context", "length_in", "width_in", "height_in", "weight_lb", "case_pack", "selling_pack", "ti", "hi", "cases_per_pallet", "source_type", "profile_status", "brand_evidence", "note", "classification"],
    specNorm,
  );
  writeCsv(
    path.join(outDir, "conflicts-needs-review.csv"),
    ["spreadsheet_row", "seller_sku", "sheet_asin", "sheet_fnsku", "product_id", "classification", "action_class", "reasons"],
    uniqueConflicts,
  );

  const summary = {
    total_rows: rows.length,
    A_existing_product_updates: existingUpdates.length,
    B_proposed_product_inserts_blocked: proposedInserts.length,
    C_proposed_identifier_map_inserts: mapInserts.length,
    D_proposed_catalog_upserts: catalogUpserts.length,
    E_proposed_spec_normalization: specNorm.length,
    F_conflicts_needs_review: uniqueConflicts.length,
    already_imported_packaging: rows.filter((r) => r.classification === "already_imported_packaging").length,
    identifier_mismatch: rows.filter((r) => r.classification === "identifier_mismatch").length,
  };

  fs.writeFileSync(
    path.join(outDir, "source-column-map.md"),
    `# Source column map

**Sheet:** [Product sheet](${SHEET_URL})  
**Census run:** \`${CENSUS_BASE}/${censusId}/\`

## Spreadsheet → canonical targets

| Sheet column | Target | Write policy |
|--------------|--------|--------------|
| \`seller-sku\` | \`products.sku\` (join) · \`product_identifier_map.seller_sku\` · \`catalog_products.seller_sku\` | **Primary join** scoped \`organization_id\` + \`store_id\` |
| \`ASIN (B0)\` | \`products.asin\` (null-fill only) · map \`asin\` · \`catalog_products.asin\` | Validation; no overwrite on conflict |
| \`FNSKU (X0)\` | \`products.fnsku\` (null-fill only) · map \`fnsku\` | Validation; no overwrite on conflict |
| \`Unit UPC\` / \`Case UPC\` | map \`upc\` / packaging evidence metadata | **UPC only if unique/clean/conflict-free** — not primary join |
| \`Mfg #\` | \`products.mfg_part_number\` | Fill-if-null only in apply phase |
| \`Brand\` | packaging evidence / PIM review queue | **Not** \`products.vendor_name\` bulk overwrite |
| \`Description\` | \`catalog_products.item_description\` / evidence | Not product title merge |
| \`FBA / FBM\` | \`fulfillment_context\` on packaging profile | Maps to \`fba\` / \`mfn\` |
| \`Case Pack\`, \`Selling pack ct\`, \`Ti\`, \`Hi\`, \`Cases Per Pallet\` | \`product_packaging_profile_versions\` unit counts | Normalized packaging table |
| \`Case Dimensions\\n Bag Dimensions\` | L/W/H + unit on packaging version | Parse to inches; \`source_type=import\` |
| \`Case Net / Gross Wt (LB)\` | \`weight_value\` + \`weight_unit=lb\` | Packaging version |

## Tables (product spine)

| Table | Role |
|-------|------|
| \`products\` | Canonical \`id\`; sparse identifier + display fields |
| \`product_identifier_map\` | Resolver bridge SKU/ASIN/FNSKU/UPC per org/store |
| \`catalog_products\` | Listing/catalog snapshot (\`merge_catalog_product_from_listing_json\`) |
| \`product_packaging_profiles\` + \`product_packaging_profile_versions\` + \`product_packaging_dimensions_current\` | Dimensions, case pack, pallet math |
| \`product_packaging_evidence\` | Raw sheet row + import batch tag |

**No dedicated brand/category/vendor normalized tables in current schema** — brand/vendor captured as packaging evidence + governed PIM review; category not present on this sheet.
`,
  );

  fs.writeFileSync(
    path.join(outDir, "dryrun-summary.md"),
    `# Dry-run summary

**Run:** \`${OUT_BASE}/${runId}/\`  
**Branch:** \`${branch}\`  
**Mode:** READ-ONLY · **no DB writes**

## Row counts

| Bucket | Count | Class |
|--------|------:|-------|
| Total sheet rows | **${summary.total_rows}** | — |
| A — existing product safe updates (null-fill identifiers) | **${summary.A_existing_product_updates}** | A |
| B — proposed product inserts | **${summary.B_proposed_product_inserts_blocked}** | B (**all blocked**) |
| C — proposed identifier map inserts | **${summary.C_proposed_identifier_map_inserts}** | C |
| D — proposed catalog upserts | **${summary.D_proposed_catalog_upserts}** | D |
| E — proposed spec / packaging normalization | **${summary.E_proposed_spec_normalization}** | E |
| F — conflicts / needs review | **${summary.F_conflicts_needs_review}** | F |
| Already imported packaging (prior wave) | **${summary.already_imported_packaging}** | skip |

## Key conflicts

- **984** duplicate ASIN keys on sheet → most rows flagged \`sheet_review_required_duplicate_asin_or_conflict\`
- **${summary.identifier_mismatch}** identifier mismatches (SKU resolves product but ASIN/FNSKU disagrees)
- **${summary.B_proposed_product_inserts_blocked}** rows have sheet identifiers but **no \`products.sku\` match** — auto-create forbidden
- **175** parseable case L×W×H of **4479** rows — packaging import requires parseable dims + merge-safe sheet row

## Apply order (when approved)

1. Resolve F bucket (identifier conflicts + sheet duplicate ASIN cleanup)
2. Manual product link for blocked B rows (or governed seed prompt)
3. C identifier map inserts (deterministic only)
4. D catalog snapshots (listing layer)
5. A null-fill products identifiers (no title merge)
6. E packaging profiles (\`needs_review\` → separate activate)
`,
  );

  const sqlLines = [
    "-- PRODUCT SHEET PIM NORMALIZATION — PROPOSED SQL DRY-RUN (DO NOT EXECUTE)",
    `-- run_id=${runId}`,
    `-- census=${CENSUS_BASE}/${censusId}`,
    "",
    "-- Phase 1: catalog snapshots (example per row)",
    "-- SELECT public.merge_catalog_product_from_listing_json(",
    `--   '${SAM_ORG}'::uuid, '${SAM_STORE}'::uuid, 'spreadsheet_product_sheet',`,
    "--   jsonb_build_object('seller-sku', ..., 'asin1', ..., 'fnsku', ...));",
    "",
    "-- Phase 2: identifier map (deterministic inserts only — sample)",
    `-- -- ${mapInserts.length} proposed map rows; apply via governed map-only script`,
    "",
    "-- Phase 3: products null-fill (NO title/vendor overwrite)",
    `-- -- ${existingUpdates.length} candidate patches; fill asin/fnsku only when NULL`,
    "",
    "-- Phase 4: packaging profiles (needs_review)",
    `-- -- ${specNorm.filter((r) => r.target_table).length} packaging version proposals`,
    "",
    "-- FORBIDDEN in this import:",
    "-- products INSERT from sheet title/description",
    "-- product_name / OCR merge",
    "-- bulk vendor_name := Brand",
  ];
  fs.writeFileSync(path.join(outDir, "proposed-sql-dryrun.sql"), sqlLines.join("\n") + "\n");

  fs.writeFileSync(
    path.join(outDir, "approval-template.md"),
    `# Product sheet PIM normalization — staging apply approval

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`eiqfaapyumhixxoeltgu\` |
| Source sheet | [Google Sheet](${SHEET_URL}) |
| Dry-run | \`${OUT_BASE}/${runId}/\` |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_PRODUCT_SHEET_PIM_NORMALIZATION_APPLY=false
\`\`\`

## Scope if approved

- [ ] Phase C: identifier map inserts (${summary.C_proposed_identifier_map_inserts} rows max — operator may subset)
- [ ] Phase D: catalog_products upserts (${summary.D_proposed_catalog_upserts} rows)
- [ ] Phase A: products null-fill identifiers only (${summary.A_existing_product_updates} rows)
- [ ] Phase E: packaging profiles \`needs_review\` (${summary.E_proposed_spec_normalization} rows)

## Explicit exclusions

- [ ] No product INSERT from sheet without separate governed seed approval
- [ ] No product_name / title merge
- [ ] No bulk vendor_name overwrite from Brand column
- [ ] No UPC map insert unless unique/clean/conflict-free review pass
- [ ] No production/original writes

## Sign-off

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_PRODUCT_SHEET_PIM_NORMALIZATION_APPLY=false
Approved by:
UTC date:
Max rows per phase (default 100):
Notes:
\`\`\`
`,
  );

  fs.writeFileSync(
    path.join(outDir, "exact-next-prompt.md"),
    `# Exact next prompt

\`\`\`
PRODUCT-SHEET-PIM-NORMALIZATION-PHASE-F-RESOLVE — resolve ${summary.identifier_mismatch} identifier_mismatch rows + sheet duplicate-ASIN review queue before any apply

Then:

PRODUCT-SHEET-PIM-NORMALIZATION-STAGING-APPLY-WAVE1 — map-only + catalog upserts for merge-safe cohort (approval-gated, max 100 rows)

Forbidden until F resolved: product INSERT from sheet, packaging apply on needs_review rows with duplicate ASIN keys.
\`\`\`
`,
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PRODUCT-SHEET-IMPORT-PIM-NORMALIZATION-DRYRUN",
        run_id: runId,
        census_run_id: censusId,
        branch,
        sheet_url: SHEET_URL,
        read_only: true,
        no_db_writes: true,
        summary,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: true, outDir, summary }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
