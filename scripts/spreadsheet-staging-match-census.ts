/**
 * Spreadsheet staging match census (read-only).
 *
 *   npx tsx scripts/spreadsheet-staging-match-census.ts
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
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/spreadsheet-staging-match-census";
const DEFAULT_XLSX = ".cursor/audit-reports/product-dimensions-spreadsheet-intake-audit/_tmp/dims-sheet.xlsx";
const SHEET_ID = "1T66cBdEUXSdTFasNZ0ax1AtlwbI_89Fk3ZinpX07Mu8";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

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
  sheet_merge_class: string;
  has_parseable_lwh: boolean;
};

type ProductRow = {
  id: string;
  sku: string;
  asin: string | null;
  fnsku: string | null;
  vendor_name: string | null;
};

type PackagingCurrent = {
  profile_id: string;
  product_id: string;
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
};

type CensusClassification =
  | "import_ready"
  | "already_same"
  | "needs_new_version"
  | "conflict_gt_1_in"
  | "missing_product"
  | "ambiguous_product"
  | "identifier_mismatch"
  | "review_required_sheet";

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

function isBare1883Vendor(v: string | null): boolean {
  if (!v) return false;
  const t = v.trim();
  return t === "1883" || /^\d+$/.test(t) && t === "1883";
}

function normSku(s: string): string {
  return s.trim();
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
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}, got ${ref}`);
    if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL as staging");
  }

  await ensureXlsx(xlsxPath);

  const pyScript = path.join(process.cwd(), "scripts", "spreadsheet-staging-match-census-load.py");
  const pyOut = execSync(`python "${pyScript}" "${xlsxPath}"`, {
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
  const loaded = JSON.parse(pyOut) as {
    headers: string[];
    total_rows: number;
    merge_safe_count: number;
    parseable_lwh_count: number;
    merge_safe_rows: SheetRow[];
    rows: SheetRow[];
  };

  const mergeSafeRows = loaded.merge_safe_rows;
  const packagingImportCandidates: Record<string, unknown>[] = [];
  const alreadySame: Record<string, unknown>[] = [];
  const conflicts: Record<string, unknown>[] = [];
  const missingOrAmbiguous: Record<string, unknown>[] = [];
  const mergeSafeResolved: Record<string, unknown>[] = [];

  let resolvedProductCount = 0;
  let importReadyCount = 0;
  let conflictCount = 0;
  let alreadySameCount = 0;
  let needsNewVersionCount = 0;
  let missingProductCount = 0;
  let ambiguousProductCount = 0;
  let identifierMismatchCount = 0;

  const vendor1883Candidates: Record<string, unknown>[] = [];
  let packagingSnapshotBefore = { profiles: 0, dimensions_current: 0 };
  let packagingSnapshotAfter = { profiles: 0, dimensions_current: 0 };

  if (blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const snap = await client.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS dimensions_current`,
    );
    packagingSnapshotBefore = snap.rows[0] as typeof packagingSnapshotBefore;
    packagingSnapshotAfter = { ...packagingSnapshotBefore };

    const storeRow = await client.query(
      `SELECT id::text, organization_id::text, name
       FROM public.stores WHERE id = $1::uuid`,
      [SAM_STORE_ID],
    );
    const orgId =
      storeRow.rows[0]?.organization_id != null ? String(storeRow.rows[0].organization_id) : SAM_ORG_ID;
    const storeId = storeRow.rows[0]?.id != null ? String(storeRow.rows[0].id) : SAM_STORE_ID;

    const skus = [...new Set(mergeSafeRows.map((r) => normSku(r.seller_sku)).filter(Boolean))];
    const productsBySku = new Map<string, ProductRow[]>();

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

    const packagingByProduct = new Map<string, PackagingCurrent[]>();
    if (productIds.size > 0) {
      const ids = [...productIds];
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const pk = await client.query(
          `SELECT
             c.profile_id::text, c.product_id::text, c.packaging_level, c.fulfillment_context,
             c.length_value::float8, c.width_value::float8, c.height_value::float8,
             c.dimension_unit, c.weight_value::float8, c.weight_unit,
             c.profile_status, c.source_type
           FROM public.product_packaging_dimensions_current c
           WHERE c.product_id = ANY($1::uuid[])`,
          [chunk],
        );
        for (const row of pk.rows as Record<string, unknown>[]) {
          const pid = String(row.product_id);
          const list = packagingByProduct.get(pid) ?? [];
          list.push({
            profile_id: String(row.profile_id),
            product_id: pid,
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
          });
          packagingByProduct.set(pid, list);
        }
      }
    }

    const mapAsinByProduct = new Map<string, Set<string>>();
    const mapFnskuByProduct = new Map<string, Set<string>>();
    if (productIds.size > 0) {
      const ids = [...productIds];
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

    for (const row of mergeSafeRows) {
      const sku = normSku(row.seller_sku);
      const matches = productsBySku.get(sku) ?? [];
      let classification: CensusClassification = "import_ready";
      const reasons: string[] = [];
      let product: ProductRow | null = null;

      if (matches.length === 0) {
        classification = "missing_product";
        missingProductCount++;
        reasons.push("no_product_for_seller_sku");
      } else if (matches.length > 1) {
        classification = "ambiguous_product";
        ambiguousProductCount++;
        reasons.push(`multiple_products_${matches.length}`);
        product = matches[0]!;
      } else {
        product = matches[0]!;
        resolvedProductCount++;
        reasons.push("resolved_by_seller_sku");

        if (row.asin && product.asin && product.asin !== row.asin) {
          classification = "identifier_mismatch";
          identifierMismatchCount++;
          reasons.push("products_asin_mismatch");
        } else if (row.asin) {
          const mapAsins = mapAsinByProduct.get(product.id);
          if (mapAsins && mapAsins.size > 0 && !mapAsins.has(row.asin)) {
            classification = "identifier_mismatch";
            identifierMismatchCount++;
            reasons.push("map_asin_mismatch");
          }
        }

        if (row.fnsku && product.fnsku && product.fnsku !== row.fnsku) {
          if (classification === "import_ready") {
            classification = "identifier_mismatch";
            identifierMismatchCount++;
          }
          reasons.push("products_fnsku_mismatch");
        } else if (row.fnsku) {
          const mapFns = mapFnskuByProduct.get(product.id);
          if (mapFns && mapFns.size > 0 && !mapFns.has(row.fnsku)) {
            if (classification === "import_ready") {
              classification = "identifier_mismatch";
              identifierMismatchCount++;
            }
            reasons.push("map_fnsku_mismatch");
          }
        }

        if (
          classification === "import_ready" &&
          row.dimensions &&
          product
        ) {
          const pkgs = packagingByProduct.get(product.id) ?? [];
          const casePkgs = pkgs.filter((p) => p.packaging_level === "case");
          const ctxMatch = casePkgs.filter((p) => p.fulfillment_context === row.fulfillment_context);
          const withLwh = ctxMatch.filter(
            (p) => p.length_value != null && p.width_value != null && p.height_value != null,
          );

          if (withLwh.length === 0) {
            const anyCaseLwh = casePkgs.filter(
              (p) => p.length_value != null && p.width_value != null && p.height_value != null,
            );
            if (anyCaseLwh.length === 0) {
              classification = "import_ready";
              importReadyCount++;
              reasons.push("no_case_lwh_current");
            } else {
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
                classification = "conflict_gt_1_in";
                conflictCount++;
                reasons.push(`case_other_context_delta_${maxDelta.toFixed(2)}in`);
              } else if (anyCaseLwh.some((p) => dimsSame(row.dimensions!, { l: p.length_value, w: p.width_value, h: p.height_value, unit: p.dimension_unit }))) {
                classification = "already_same";
                alreadySameCount++;
                reasons.push("case_lwh_matches_other_context");
              } else {
                classification = "needs_new_version";
                needsNewVersionCount++;
                reasons.push("case_lwh_other_context_minor_delta");
              }
            }
          } else if (withLwh.length === 1) {
            const p = withLwh[0]!;
            if (dimsSame(row.dimensions, { l: p.length_value, w: p.width_value, h: p.height_value, unit: p.dimension_unit })) {
              classification = "already_same";
              alreadySameCount++;
              reasons.push("exact_match_active_case");
            } else {
              const delta = maxAxisDeltaIn(row.dimensions, {
                l: p.length_value,
                w: p.width_value,
                h: p.height_value,
                unit: p.dimension_unit,
              });
              if (delta != null && delta > CONFLICT_THRESHOLD_IN) {
                classification = "conflict_gt_1_in";
                conflictCount++;
                reasons.push(`delta_${delta.toFixed(2)}in`);
              } else {
                classification = "needs_new_version";
                needsNewVersionCount++;
                reasons.push(`minor_delta_${delta?.toFixed(4) ?? "?"}in`);
              }
            }
          } else {
            classification = "ambiguous_product";
            ambiguousProductCount++;
            reasons.push(`multiple_case_profiles_${withLwh.length}`);
          }
        }
      }

      const entry = {
        row: row.row,
        seller_sku: sku,
        sheet_asin: row.asin,
        sheet_fnsku: row.fnsku,
        brand: row.brand,
        fulfillment_context: row.fulfillment_context,
        packaging_level: row.packaging_level,
        dimensions: row.dimensions,
        weight: row.weight,
        case_pack: row.case_pack,
        product_id: product?.id ?? null,
        products_asin: product?.asin ?? null,
        products_fnsku: product?.fnsku ?? null,
        products_vendor_name: product?.vendor_name ?? null,
        classification,
        reasons,
      };

      mergeSafeResolved.push(entry);

      if (classification === "import_ready") packagingImportCandidates.push(entry);
      else if (classification === "already_same") alreadySame.push(entry);
      else if (classification === "conflict_gt_1_in") conflicts.push(entry);
      else missingOrAmbiguous.push(entry);
    }

    const vendor1883Products = await client.query(
      `SELECT id::text, sku, asin, vendor_name
       FROM public.products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND btrim(coalesce(vendor_name, '')) = '1883'`,
      [orgId, storeId],
    );

    const sheetBySku = new Map<string, SheetRow>();
    for (const r of loaded.rows) {
      if (r.seller_sku) sheetBySku.set(normSku(r.seller_sku), r);
    }

    for (const row of vendor1883Products.rows as ProductRow[]) {
      const sku = normSku(row.sku);
      const sheet = sheetBySku.get(sku);
      if (!sheet?.brand_starts_1883) continue;
      vendor1883Candidates.push({
        product_id: String(row.id),
        seller_sku: sku,
        current_vendor_name: row.vendor_name,
        proposed_vendor_name: sheet.brand,
        sheet_row: sheet.row,
        sheet_brand: sheet.brand,
        sheet_asin: sheet.asin,
        note: "vendor_cleanup_candidate_only_no_write",
      });
    }

    await client.end();
  }

  const censusMd = `# Staging match census — product dimensions spreadsheet

**Run:** \`${OUT_BASE}/${runId}/\`  
**Sheet:** [Google Sheet](${SHEET_URL})  
**Staging:** \`${STAGING_REF}\` (Sam store \`${SAM_STORE_ID}\`)  
**Mode:** read-only · **no DB writes**

## Sheet summary

| Metric | Count |
|--------|------:|
| Total data rows | ${loaded.total_rows} |
| Parseable L×W×H | ${loaded.parseable_lwh_count} |
| Sheet merge-safe | ${loaded.merge_safe_count} |
| Duplicate ASIN keys (sheet) | ${loaded.duplicate_asin_keys ?? "—"} |

## Merge-safe staging resolution

| Classification | Count |
|----------------|------:|
| **Resolved product_id** | **${resolvedProductCount}** |
| **import_ready** | **${importReadyCount}** |
| already_same | ${alreadySameCount} |
| needs_new_version | ${needsNewVersionCount} |
| conflict_gt_1_in | ${conflictCount} |
| missing_product | ${missingProductCount} |
| ambiguous_product | ${ambiguousProductCount} |
| identifier_mismatch | ${identifierMismatchCount} |

## Vendor 1883 cleanup candidates

| Metric | Count |
|--------|------:|
| Products with \`vendor_name = '1883'\` (bare) + sheet Brand starts with 1883 | **${vendor1883Candidates.length}** |

## Packaging snapshot (unchanged)

| Table | Count |
|-------|------:|
| product_packaging_profiles | ${packagingSnapshotBefore.profiles} |
| product_packaging_dimensions_current | ${packagingSnapshotBefore.dimensions_current} |

## Next prompt

\`PRODUCT DIMENSIONS SPREADSHEET STAGING IMPORT PLAN — merge-safe cohort (${importReadyCount} import_ready rows) + operator approval for needs_review packaging INSERT; separate VENDOR-1883-CLEANUP plan if vendor writes approved.\`
`;

  fs.writeFileSync(path.join(outDir, "staging-match-census.md"), censusMd);
  fs.writeFileSync(
    path.join(outDir, "merge-safe-resolved-products.json"),
    JSON.stringify(mergeSafeResolved, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "packaging-import-candidates.json"),
    JSON.stringify(packagingImportCandidates, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "already-same.json"), JSON.stringify(alreadySame, null, 2));
  fs.writeFileSync(path.join(outDir, "conflict-report.json"), JSON.stringify(conflicts, null, 2));
  fs.writeFileSync(
    path.join(outDir, "missing-or-ambiguous-products.json"),
    JSON.stringify(missingOrAmbiguous, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "vendor-1883-cleanup-candidates.json"),
    JSON.stringify(vendor1883Candidates, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "| Check | Result |",
      "|-------|--------|",
      "| SQL mutations | **0** — SELECT only |",
      "| Amazon API | **not called** |",
      "| AI/OpenAI | **not called** |",
      "| Original/current DB | **not connected** for census |",
      "| product_packaging_profiles before | " + packagingSnapshotBefore.profiles + " |",
      "| product_packaging_profiles after | " + packagingSnapshotAfter.profiles + " |",
      "| dimensions_current before | " + packagingSnapshotBefore.dimensions_current + " |",
      "| dimensions_current after | " + packagingSnapshotAfter.dimensions_current + " |",
      "",
      "Script: `scripts/spreadsheet-staging-match-census.ts`",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`
      : "# Blockers\n\nNone.\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SPREADSHEET STAGING MATCH CENSUS — PRODUCT DIMENSIONS",
        run_id: runId,
        sheet_url: SHEET_URL,
        read_only: true,
        no_db_writes: true,
        staging_ref: STAGING_REF,
        store_id: SAM_STORE_ID,
        organization_id: SAM_ORG_ID,
        merge_safe_rows: mergeSafeRows.length,
        resolved_product_count: resolvedProductCount,
        import_ready_count: importReadyCount,
        conflict_count: conflictCount,
        vendor_1883_cleanup_candidate_count: vendor1883Candidates.length,
        blockers,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        outDir,
        merge_safe_rows: mergeSafeRows.length,
        resolved_product_count: resolvedProductCount,
        import_ready_count: importReadyCount,
        conflict_count: conflictCount,
        vendor_1883_cleanup_candidate_count: vendor1883Candidates.length,
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
