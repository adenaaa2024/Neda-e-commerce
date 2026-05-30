/**
 * Product spreadsheet staging match census — dryrun only (read-only).
 *
 *   npx tsx scripts/product-spreadsheet-staging-match-census-dryrun.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/product-spreadsheet-staging-match-census-dryrun";
const DEFAULT_XLSX = ".cursor/audit-reports/product-dimensions-spreadsheet-intake-audit/_tmp/dims-sheet.xlsx";
const SHEET_ID = "1T66cBdEUXSdTFasNZ0ax1AtlwbI_89Fk3ZinpX07Mu8";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const PRIOR_BATCH_TAG = "SPREADSHEET_DIMENSIONS_20260528T010000Z";
const PRIOR_IMPORTED_COUNT = 80;

const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const CONFLICT_THRESHOLD_IN = 1.0;
const SAME_EPSILON = 0.0001;

type SheetRow = {
  row: number;
  seller_sku: string;
  asin: string | null;
  fnsku: string | null;
  brand: string | null;
  brand_starts_1883: boolean;
  fulfillment_context: string;
  packaging_level: string;
  dimensions: {
    length: number;
    width: number;
    height: number;
    dimension_unit: string;
    raw: string;
  } | null;
  weight: { weight: number; weight_unit: string } | null;
  case_pack: number | null;
  selling_pack: number | null;
  ti: number | null;
  hi: number | null;
  cases_per_pallet: number | null;
  sheet_merge_class: string;
  has_parseable_lwh: boolean;
};

type RowClassification =
  | "already_imported_packaging"
  | "packaging_candidate_existing_product"
  | "missing_product"
  | "identifier_mismatch"
  | "ambiguous_identifier"
  | "vendor_brand_cleanup_candidate"
  | "unsafe_product_create_candidate"
  | "needs_review";

type ClassifiedRow = {
  spreadsheet_row: number;
  seller_sku: string;
  sheet_asin: string | null;
  sheet_fnsku: string | null;
  brand: string | null;
  classification: RowClassification;
  reasons: string[];
  product_id: string | null;
  fulfillment_context: string;
  packaging_level: string;
  case_pack: number | null;
  selling_pack: number | null;
  ti: number | null;
  hi: number | null;
  cases_per_pallet: number | null;
  length_in: number | null;
  width_in: number | null;
  height_in: number | null;
  weight_lb: number | null;
  prior_import_match: boolean;
};

type ProductRow = {
  id: string;
  sku: string;
  asin: string | null;
  fnsku: string | null;
  vendor_name: string | null;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function xlsxArg(): string {
  const a = process.argv.find((x) => x.startsWith("--xlsx="));
  return a ? a.split("=")[1]!.trim() : DEFAULT_XLSX;
}

async function ensureXlsx(xlsxPath: string): Promise<void> {
  if (fs.existsSync(xlsxPath)) return;
  fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
  execSync(
    `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${xlsxPath.replace(/'/g, "''")}' -UseBasicParsing"`,
    { stdio: "inherit" },
  );
}

function toInches(v: number, unit: string | null): number {
  if (!unit || unit === "in") return v;
  if (unit === "cm") return v / 2.54;
  if (unit === "mm") return v / 25.4;
  return v;
}

function dimsSame(
  sheet: { length: number; width: number; height: number },
  db: { l: number | null; w: number | null; h: number | null; unit: string | null },
): boolean {
  if (db.l == null || db.w == null || db.h == null) return false;
  const dl = Math.abs(sheet.length - toInches(db.l, db.unit));
  const dw = Math.abs(sheet.width - toInches(db.w, db.unit));
  const dh = Math.abs(sheet.height - toInches(db.h, db.unit));
  return dl < SAME_EPSILON && dw < SAME_EPSILON && dh < SAME_EPSILON;
}

function maxAxisDeltaIn(
  sheet: { length: number; width: number; height: number },
  db: { l: number | null; w: number | null; h: number | null; unit: string | null },
): number | null {
  if (db.l == null || db.w == null || db.h == null) return null;
  const dl = Math.abs(sheet.length - toInches(db.l, db.unit));
  const dw = Math.abs(sheet.width - toInches(db.w, db.unit));
  const dh = Math.abs(sheet.height - toInches(db.h, db.unit));
  return Math.max(dl, dw, dh);
}

function normSku(s: string): string {
  return s.trim();
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

function loadSheetRows(xlsxPath: string): {
  headers: string[];
  total_rows: number;
  merge_safe_count: number;
  parseable_lwh_count: number;
  duplicate_asin_keys: number;
  rows: SheetRow[];
  merge_safe_rows: SheetRow[];
} {
  const pyScript = path.join(process.cwd(), "scripts", "spreadsheet-staging-match-census-load-ext.py");
  const pyOut = execSync(`python "${pyScript}" "${xlsxPath}"`, {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
  });
  return JSON.parse(pyOut);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const xlsxPath = path.resolve(process.cwd(), xlsxArg());
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = dbUrl ? refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false }) : STAGING_REF;

  const blockers: string[] = [];
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset — sheet-only classification will run");
  else {
    if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}, got ${ref}`);
    if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL as staging");
  }

  await ensureXlsx(xlsxPath);
  const loaded = loadSheetRows(xlsxPath);

  const importedSpreadsheetRows = new Set<number>();
  const productsBySku = new Map<string, ProductRow[]>();
  const packagingByProduct = new Map<
    string,
    Array<{
      packaging_level: string;
      fulfillment_context: string;
      length_value: number | null;
      width_value: number | null;
      height_value: number | null;
      dimension_unit: string | null;
      weight_value: number | null;
      weight_unit: string | null;
      profile_status: string;
      source_type: string;
      display_label: string | null;
    }>
  >();
  const mapAsinByProduct = new Map<string, Set<string>>();
  const mapFnskuByProduct = new Map<string, Set<string>>();
  const vendor1883ProductIds = new Set<string>();
  let stagingPackagingProfiles = 0;
  let stagingDimensionsCurrent = 0;
  let priorImportDbCount = 0;

  if (blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const snap = await client.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS dimensions_current`,
    );
    stagingPackagingProfiles = Number(snap.rows[0]?.profiles ?? 0);
    stagingDimensionsCurrent = Number(snap.rows[0]?.dimensions_current ?? 0);

    const prior = await client.query(
      `SELECT DISTINCT (v.evidence_summary->>'spreadsheet_row')::int AS spreadsheet_row
       FROM public.product_packaging_profiles p
       JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
       WHERE p.display_label = $1
          OR v.evidence_summary->>'batch_tag' = $1
          OR v.source_reference LIKE 'spreadsheet_intake:%'`,
      [PRIOR_BATCH_TAG],
    );
    for (const row of prior.rows as { spreadsheet_row: number | null }[]) {
      if (row.spreadsheet_row != null && Number.isFinite(Number(row.spreadsheet_row))) {
        importedSpreadsheetRows.add(Number(row.spreadsheet_row));
      }
    }
    priorImportDbCount = importedSpreadsheetRows.size;

    const storeRow = await client.query(`SELECT id::text, organization_id::text FROM public.stores WHERE id = $1::uuid`, [
      SAM_STORE_ID,
    ]);
    const orgId = storeRow.rows[0]?.organization_id != null ? String(storeRow.rows[0].organization_id) : SAM_ORG_ID;
    const storeId = storeRow.rows[0]?.id != null ? String(storeRow.rows[0].id) : SAM_STORE_ID;

    const skus = [...new Set(loaded.rows.map((r) => normSku(r.seller_sku)).filter(Boolean))];
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const pr = await client.query(
        `SELECT id::text, sku, asin, fnsku, vendor_name
         FROM public.products
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
           AND sku = ANY($3::text[])`,
        [orgId, storeId, chunk],
      );
      for (const row of pr.rows as ProductRow[]) {
        const k = normSku(row.sku);
        const list = productsBySku.get(k) ?? [];
        list.push({
          id: String(row.id),
          sku: k,
          asin: row.asin ? String(row.asin).trim().toUpperCase() : null,
          fnsku: row.fnsku ? String(row.fnsku).trim().toUpperCase() : null,
          vendor_name: row.vendor_name ? String(row.vendor_name) : null,
        });
        productsBySku.set(k, list);
      }
    }

    const productIds = new Set<string>();
    for (const list of productsBySku.values()) {
      for (const p of list) productIds.add(p.id);
    }

    if (productIds.size > 0) {
      const ids = [...productIds];
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const pk = await client.query(
          `SELECT
             c.product_id::text, c.packaging_level, c.fulfillment_context,
             c.length_value::float8, c.width_value::float8, c.height_value::float8,
             c.dimension_unit, c.weight_value::float8, c.weight_unit,
             c.profile_status, c.source_type, p.display_label
           FROM public.product_packaging_dimensions_current c
           JOIN public.product_packaging_profiles p ON p.id = c.profile_id
           WHERE c.product_id = ANY($1::uuid[])`,
          [chunk],
        );
        for (const row of pk.rows as Record<string, unknown>[]) {
          const pid = String(row.product_id);
          const list = packagingByProduct.get(pid) ?? [];
          list.push({
            packaging_level: String(row.packaging_level),
            fulfillment_context: String(row.fulfillment_context),
            length_value: row.length_value != null ? Number(row.length_value) : null,
            width_value: row.width_value != null ? Number(row.width_value) : null,
            height_value: row.height_value != null ? Number(row.height_value) : null,
            dimension_unit: row.dimension_unit ? String(row.dimension_unit) : null,
            weight_value: row.weight_value != null ? Number(row.weight_value) : null,
            weight_unit: row.weight_unit ? String(row.weight_unit) : null,
            profile_status: String(row.profile_status),
            source_type: String(row.source_type),
            display_label: row.display_label ? String(row.display_label) : null,
          });
          packagingByProduct.set(pid, list);
        }
      }

      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const mr = await client.query(
          `SELECT product_id::text, asin, fnsku
           FROM public.product_identifier_map
           WHERE product_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [chunk],
        );
        for (const row of mr.rows as { product_id: string; asin: string | null; fnsku: string | null }[]) {
          const pid = String(row.product_id);
          if (row.asin) {
            const s = mapAsinByProduct.get(pid) ?? new Set();
            s.add(String(row.asin).trim().toUpperCase());
            mapAsinByProduct.set(pid, s);
          }
          if (row.fnsku) {
            const s = mapFnskuByProduct.get(pid) ?? new Set();
            s.add(String(row.fnsku).trim().toUpperCase());
            mapFnskuByProduct.set(pid, s);
          }
        }
      }
    }

    const vendor1883 = await client.query(
      `SELECT id::text FROM public.products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND btrim(coalesce(vendor_name, '')) = '1883'`,
      [orgId, storeId],
    );
    for (const row of vendor1883.rows as { id: string }[]) vendor1883ProductIds.add(String(row.id));

    await client.end();
  }

  function resolveProductMatches(sku: string): ProductRow[] {
    return sku ? (productsBySku.get(sku) ?? []) : [];
  }

  function checkIdentifierMismatch(row: SheetRow, product: ProductRow): { mismatch: boolean; reasons: string[] } {
    const idReasons: string[] = [];
    let mismatch = false;
    if (row.asin && product.asin && product.asin !== row.asin) {
      mismatch = true;
      idReasons.push("products_asin_mismatch");
    } else if (row.asin) {
      const mapAsins = mapAsinByProduct.get(product.id);
      if (mapAsins && mapAsins.size > 0 && !mapAsins.has(row.asin)) {
        mismatch = true;
        idReasons.push("map_asin_mismatch");
      }
    }
    if (row.fnsku && product.fnsku && product.fnsku !== row.fnsku) {
      mismatch = true;
      idReasons.push("products_fnsku_mismatch");
    } else if (row.fnsku) {
      const mapFns = mapFnskuByProduct.get(product.id);
      if (mapFns && mapFns.size > 0 && !mapFns.has(row.fnsku)) {
        mismatch = true;
        idReasons.push("map_fnsku_mismatch");
      }
    }
    return { mismatch, reasons: idReasons };
  }

  function classifyPackagingForResolvedProduct(row: SheetRow, product: ProductRow): RowClassification | null {
    if (!row.dimensions || !row.has_parseable_lwh || row.sheet_merge_class !== "merge-safe") return null;
    const pkgs = packagingByProduct.get(product.id) ?? [];
    const casePkgs = pkgs.filter((p) => p.packaging_level === "case");
    const ctxMatch = casePkgs.filter((p) => p.fulfillment_context === row.fulfillment_context);
    const withLwh = ctxMatch.filter(
      (p) => p.length_value != null && p.width_value != null && p.height_value != null,
    );

    if (withLwh.length === 1 && dimsSame(row.dimensions, { l: withLwh[0]!.length_value, w: withLwh[0]!.width_value, h: withLwh[0]!.height_value, unit: withLwh[0]!.dimension_unit })) {
      reasons.push("active_case_dims_match_sheet");
      return "already_imported_packaging";
    }
    if (withLwh.length > 1) {
      reasons.push(`multiple_case_profiles_${withLwh.length}`);
      return "ambiguous_identifier";
    }
    const anyCaseLwh = casePkgs.filter(
      (p) => p.length_value != null && p.width_value != null && p.height_value != null,
    );
    if (anyCaseLwh.length > 0) {
      const deltas = anyCaseLwh.map((p) =>
        maxAxisDeltaIn(row.dimensions!, {
          l: p.length_value,
          w: p.width_value,
          h: p.height_value,
          unit: p.dimension_unit,
        }),
      );
      const maxDelta = Math.max(...deltas.filter((d): d is number => d != null), 0);
      if (maxDelta > CONFLICT_THRESHOLD_IN) {
        reasons.push(`case_conflict_gt_1in_${maxDelta.toFixed(2)}`);
        return "needs_review";
      }
      reasons.push("needs_new_version_or_other_context");
      return "packaging_candidate_existing_product";
    }
    reasons.push("no_case_lwh_current_import_ready");
    return "packaging_candidate_existing_product";
  }

  const classified: ClassifiedRow[] = [];

  for (const row of loaded.rows) {
    const sku = normSku(row.seller_sku);
    const reasons: string[] = [];
    let classification: RowClassification = "needs_review";
    let product: ProductRow | null = null;
    const priorImportMatch = importedSpreadsheetRows.has(row.row);

    if (priorImportMatch) {
      classification = "already_imported_packaging";
      reasons.push(`prior_wave_${PRIOR_BATCH_TAG}`);
    } else if (!sku) {
      classification = "needs_review";
      reasons.push("missing_seller_sku");
    } else {
      const matches = resolveProductMatches(sku);
      if (matches.length === 0) {
        if (row.asin || row.fnsku) {
          classification = "unsafe_product_create_candidate";
          reasons.push("no_product_for_seller_sku_has_sheet_identifiers");
          reasons.push("forbidden_auto_create_use_manual_product_link_first");
        } else {
          classification = "missing_product";
          reasons.push("no_product_for_seller_sku_scoped_org_store");
        }
        if (!row.has_parseable_lwh) reasons.push("missing_parseable_case_lwh");
        if (row.sheet_merge_class !== "merge-safe") reasons.push("sheet_review_required_duplicate_asin_or_conflict");
      } else if (matches.length > 1) {
        classification = "ambiguous_identifier";
        reasons.push(`multiple_products_for_sku_${matches.length}`);
        product = matches[0]!;
      } else {
        product = matches[0]!;
        reasons.push("resolved_by_seller_sku_org_store");
        const idCheck = checkIdentifierMismatch(row, product);
        if (idCheck.mismatch) {
          classification = "identifier_mismatch";
          reasons.push(...idCheck.reasons);
        } else if (vendor1883ProductIds.has(product.id) && row.brand_starts_1883) {
          classification = "vendor_brand_cleanup_candidate";
          reasons.push("products_vendor_bare_1883_sheet_brand_prefix_1883");
        } else {
          const pkgClass = classifyPackagingForResolvedProduct(row, product);
          if (pkgClass) {
            classification = pkgClass;
          } else if (!row.has_parseable_lwh) {
            classification = "needs_review";
            reasons.push("missing_parseable_case_lwh");
          } else if (row.sheet_merge_class !== "merge-safe") {
            classification = "needs_review";
            reasons.push("sheet_review_required_duplicate_asin_or_conflict");
          } else {
            classification = "packaging_candidate_existing_product";
            reasons.push("merge_safe_product_resolved");
          }
        }
      }
    }

    classified.push({
      spreadsheet_row: row.row,
      seller_sku: sku,
      sheet_asin: row.asin,
      sheet_fnsku: row.fnsku,
      brand: row.brand,
      classification,
      reasons,
      product_id: product?.id ?? null,
      fulfillment_context: row.fulfillment_context,
      packaging_level: row.packaging_level,
      case_pack: row.case_pack,
      selling_pack: row.selling_pack,
      ti: row.ti,
      hi: row.hi,
      cases_per_pallet: row.cases_per_pallet,
      length_in: row.dimensions?.length ?? null,
      width_in: row.dimensions?.width ?? null,
      height_in: row.dimensions?.height ?? null,
      weight_lb: row.weight?.weight ?? null,
      prior_import_match: priorImportMatch,
    });
  }

  const rollup = new Map<RowClassification, number>();
  for (const c of classified) {
    rollup.set(c.classification, (rollup.get(c.classification) ?? 0) + 1);
  }

  const packagingCandidates = classified.filter((r) => r.classification === "packaging_candidate_existing_product");
  const missingProducts = classified.filter((r) => r.classification === "unsafe_product_create_candidate");
  const idMismatches = classified.filter((r) => r.classification === "identifier_mismatch");
  const vendorCandidates = classified.filter((r) => r.classification === "vendor_brand_cleanup_candidate");
  const alreadyImported = classified.filter((r) => r.classification === "already_imported_packaging");

  const csvHeaders = [
    "spreadsheet_row",
    "seller_sku",
    "sheet_asin",
    "sheet_fnsku",
    "brand",
    "classification",
    "reasons",
    "product_id",
    "fulfillment_context",
    "case_pack",
    "selling_pack",
    "ti",
    "hi",
    "cases_per_pallet",
    "length_in",
    "width_in",
    "height_in",
    "weight_lb",
    "prior_import_match",
  ];

  writeCsv(
    path.join(outDir, "row-classification-rollup.csv"),
    ["classification", "count"],
    [...rollup.entries()].map(([classification, count]) => ({ classification, count })),
  );
  writeCsv(path.join(outDir, "packaging-candidates.csv"), csvHeaders, packagingCandidates);
  writeCsv(path.join(outDir, "missing-products.csv"), csvHeaders, missingProducts);
  writeCsv(path.join(outDir, "identifier-mismatches.csv"), csvHeaders, idMismatches);
  writeCsv(path.join(outDir, "vendor-brand-candidates.csv"), csvHeaders, vendorCandidates);

  const sampleN = 8;
  const samplesMd = `# Row classification samples

**Run:** \`${OUT_BASE}/${runId}/\`

${[...rollup.entries()]
  .map(([cls, count]) => {
    const rows = classified.filter((r) => r.classification === cls).slice(0, sampleN);
    return `## ${cls} (${count})

${rows.length ? rows.map((r) => `- row ${r.spreadsheet_row} · \`${r.seller_sku || "—"}\` · ${r.reasons.join("; ")}`).join("\n") : "_none_"}
`;
  })
  .join("\n")}`;
  fs.writeFileSync(path.join(outDir, "row-classification-samples.md"), samplesMd);

  const remaining = loaded.total_rows - alreadyImported.length;
  fs.writeFileSync(
    path.join(outDir, "sheet-summary.md"),
    `# Sheet summary

**Run:** \`${OUT_BASE}/${runId}/\`  
**Sheet:** [Google Products dimensions](${SHEET_URL})  
**Branch audited:** \`${branch}\`  
**Mode:** read-only dryrun · **no DB writes**

## Headers (${loaded.headers.length})

${loaded.headers.map((h) => `- \`${h}\``).join("\n")}

## Row counts

| Metric | Count |
|--------|------:|
| **Total data rows** | **${loaded.total_rows}** |
| Parseable case L×W×H | ${loaded.parseable_lwh_count} |
| Sheet merge-safe | ${loaded.merge_safe_count} |
| Duplicate ASIN keys (sheet) | ${loaded.duplicate_asin_keys} |
| **Already imported (classification)** | **${alreadyImported.length}** |
| **Remaining after prior wave overlap** | **${remaining}** |
| Safe packaging candidates | ${packagingCandidates.length} |
| Missing product (unsafe create) | ${missingProducts.length} |
| Identifier mismatch | ${idMismatches.length} |
| Vendor/brand 1883 cleanup | ${vendorCandidates.length} |
| Needs review (other) | ${rollup.get("needs_review") ?? 0} |
| Ambiguous identifier | ${rollup.get("ambiguous_identifier") ?? 0} |

## Staging packaging snapshot (read-only)

| Table | Count |
|-------|------:|
| product_packaging_profiles | ${stagingPackagingProfiles} |
| product_packaging_dimensions_current | ${stagingDimensionsCurrent} |
| Prior-wave spreadsheet rows in DB (\`${PRIOR_BATCH_TAG}\`) | ${priorImportDbCount} |

## Join rules used

- **seller_sku → products.sku** scoped by Sam \`organization_id\` + \`store_id\`
- **No product_name** used for merge
- **UPC-only** not used as primary join (sheet has ASIN/FNSKU/seller-sku)
- **No writes** to products, map, or packaging tables
`,
  );

  fs.writeFileSync(
    path.join(outDir, "prior-80-comparison.md"),
    `# Prior 80-row packaging wave comparison

**Prior execute batch:** \`${PRIOR_BATCH_TAG}\`  
**Expected prior import count:** ${PRIOR_IMPORTED_COUNT}  
**Spreadsheet rows matched in staging DB:** ${priorImportDbCount}

## What the prior wave wrote

| Table | Written |
|-------|---------|
| product_packaging_profiles | Yes |
| product_packaging_profile_versions | Yes (\`needs_review\` → later activate) |
| product_packaging_dimensions_current | Yes (after activate) |
| products | **No** |
| product_identifier_map | **No** |
| catalog_products | **No** |
| raw_report_uploads | **No** |

## Overlap with full sheet (${loaded.total_rows} rows)

| Metric | Count |
|--------|------:|
| Rows flagged \`already_imported_packaging\` | ${alreadyImported.length} |
| Of those, prior DB \`spreadsheet_row\` match | ${classified.filter((r) => r.prior_import_match).length} |
| Of those, dims already match active case (no prior row tag) | ${alreadyImported.filter((r) => !r.prior_import_match).length} |
| Remaining not yet imported | ${loaded.total_rows - alreadyImported.length} |

## Notes

- Prior wave joined **seller_sku → products.sku** only; packaging-only import.
- Rows with matching dimensions to active case packaging are classified \`already_imported_packaging\` even without prior batch tag.
- **${packagingCandidates.length}** merge-safe rows with resolved products are the next packaging apply cohort (needs operator approval).
`,
  );

  fs.writeFileSync(
    path.join(outDir, "risks.md"),
    `# Risks

## Data / identity

- **${rollup.get("missing_product") ?? 0} missing_product** + **${rollup.get("unsafe_product_create_candidate") ?? 0} unsafe_product_create_candidate** rows have no \`products.sku\` match — must **not** auto-create products from spreadsheet title/OCR.
- **${idMismatches.length} rows** have seller_sku product match but ASIN/FNSKU disagrees with \`products\` or \`product_identifier_map\`.
- **${rollup.get("ambiguous_identifier") ?? 0} rows** have duplicate SKU products or multiple case profiles — manual disambiguation required.
- **${rollup.get("needs_review") ?? 0} rows** lack parseable dimensions or have sheet duplicate-ASIN conflicts — out of packaging scope until fixed.

## Vendor / brand

- **${vendorCandidates.length} rows** pair bare \`vendor_name = '1883'\` with sheet Brand starting \`1883\` — vendor cleanup is a **separate** approved write path; not bundled with packaging import.

## Packaging

- Conflict threshold **>${CONFLICT_THRESHOLD_IN}"** per axis triggers \`needs_review\` — prevents silent overwrite of active case dims.
- Prior **${PRIOR_IMPORTED_COUNT}** rows used \`profile_status = needs_review\` then activate — repeat same governed pattern for next cohort.

## Operational

- Branch \`${branch}\` (not \`feature/product-canonicalization-v2\`) — census used read-only SELECT only.
${blockers.length ? `- Blockers noted: ${blockers.join("; ")}` : "- Staging DB connected read-only."}
- **No Amazon API, no AI, no migrations, no imports executed.**
`,
  );

  const nextPackagingBatch = Math.min(packagingCandidates.length, 80);
  fs.writeFileSync(
    path.join(outDir, "exact-next-prompts.md"),
    `# Exact next prompts

## 1 — Next packaging dryrun/apply (recommended first)

\`\`\`
MAIN-PRODUCT-SPREADSHEET-PACKAGING-WAVE2-DRYRUN-APPLY

Owner: Main/user
Branch: feature/product-canonicalization-v2
Mode: DRYRUN first, then APPLY only with operator approval

Scope: Next ${nextPackagingBatch} rows from packaging-candidates.csv (merge-safe, product resolved, no identifier mismatch).
Source census: ${OUT_BASE}/${runId}/
Tables: product_packaging_profiles, product_packaging_profile_versions, product_packaging_dimensions_current only.
Forbidden: products, product_identifier_map, vendor_name updates, product_name merge.
Join: seller_sku -> products.sku scoped org+store.
Profile status: needs_review until separate activate approval.
\`\`\`

## 2 — Vendor 1883 cleanup (separate approval)

\`\`\`
MAIN-VENDOR-1883-CLEANUP-STAGING-DRYRUN

Scope: ${vendorCandidates.length} vendor_brand_cleanup_candidate rows only.
Forbidden: packaging import in same transaction.
\`\`\`

## 3 — Identifier mismatch queue

\`\`\`
MAIN-PRODUCT-SPREADSHEET-IDENTIFIER-MISMATCH-REVIEW-CENSUS

Scope: ${idMismatches.length} identifier_mismatch rows — manual PIM/map fix before packaging.
\`\`\`

## 4 — Missing product backlog

\`\`\`
MAIN-PRODUCT-SPREADSHEET-MISSING-PRODUCT-LINK-PLAN

Scope: ${missingProducts.length} rows (${rollup.get("missing_product") ?? 0} missing + ${rollup.get("unsafe_product_create_candidate") ?? 0} unsafe create) — manual product link or approved seed path; no spreadsheet auto-create.
\`\`\`
`,
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "MAIN-PRODUCT-SPREADSHEET-STAGING-MATCH-CENSUS-DRYRUN",
        run_id: runId,
        sheet_url: SHEET_URL,
        read_only: true,
        no_db_writes: true,
        branch,
        staging_ref: STAGING_REF,
        store_id: SAM_STORE_ID,
        organization_id: SAM_ORG_ID,
        total_rows: loaded.total_rows,
        already_imported_count: alreadyImported.length,
        packaging_candidate_count: packagingCandidates.length,
        missing_product_count: rollup.get("missing_product") ?? 0,
        unsafe_product_create_candidate_count: rollup.get("unsafe_product_create_candidate") ?? 0,
        identifier_mismatch_count: idMismatches.length,
        vendor_brand_candidate_count: vendorCandidates.length,
        prior_batch_tag: PRIOR_BATCH_TAG,
        prior_import_db_rows: priorImportDbCount,
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
        total_rows: loaded.total_rows,
        already_imported_count: alreadyImported.length,
        packaging_candidate_count: packagingCandidates.length,
        missing_product_count: rollup.get("missing_product") ?? 0,
        unsafe_product_create_candidate_count: rollup.get("unsafe_product_create_candidate") ?? 0,
        identifier_mismatch_count: idMismatches.length,
        vendor_brand_candidate_count: vendorCandidates.length,
        blockers,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
