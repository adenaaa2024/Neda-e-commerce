/**
 * Missing-product link plan for Google spreadsheet packaging backlog (read-only).
 *
 *   npx tsx scripts/product-spreadsheet-missing-product-link-plan.ts
 *   npx tsx scripts/product-spreadsheet-missing-product-link-plan.ts --census-run-id=20260529T200000Z
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
const OUT_BASE = ".cursor/audit-reports/product-spreadsheet-missing-product-link-plan";
const CENSUS_BASE = ".cursor/audit-reports/product-spreadsheet-staging-match-census-dryrun";
const DEFAULT_XLSX = ".cursor/audit-reports/product-dimensions-spreadsheet-intake-audit/_tmp/dims-sheet.xlsx";
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1T66cBdEUXSdTFasNZ0ax1AtlwbI_89Fk3ZinpX07Mu8/edit";

const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type SheetRow = {
  row: number;
  seller_sku: string;
  asin: string | null;
  fnsku: string | null;
  unit_upc: string | null;
  case_upc: string | null;
  mfg_number: string | null;
  brand: string | null;
  fulfillment_context: string;
};

type IdentifierProfile =
  | "seller_sku_asin_fnsku"
  | "seller_sku_asin_only"
  | "seller_sku_fnsku_only"
  | "upc_present_unique"
  | "mfg_present"
  | "weak_unsafe";

type ResolutionPath =
  | "A_link_via_identifier_map"
  | "B_seed_from_approved_source"
  | "C_manual_review"
  | "D_conflict_unsafe";

type PlanRow = {
  spreadsheet_row: number;
  seller_sku: string;
  sheet_asin: string | null;
  sheet_fnsku: string | null;
  unit_upc: string | null;
  case_upc: string | null;
  mfg_number: string | null;
  brand: string | null;
  identifier_profile: IdentifierProfile;
  resolution_path: ResolutionPath;
  candidate_product_id: string | null;
  seed_source_table: string | null;
  seed_source_id: string | null;
  reasons: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function censusRunArg(): string {
  const a = process.argv.find((x) => x.startsWith("--census-run-id="));
  if (a) return a.split("=")[1]!.trim();
  const base = path.join(process.cwd(), CENSUS_BASE);
  if (!fs.existsSync(base)) return "20260529T200000Z";
  const runs = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, "manifest.json"))).sort().reverse();
  return runs[0] ?? "20260529T200000Z";
}

function xlsxArg(): string {
  const a = process.argv.find((x) => x.startsWith("--xlsx="));
  return a ? a.split("=")[1]!.trim() : DEFAULT_XLSX;
}

async function ensureXlsx(xlsxPath: string): Promise<void> {
  if (fs.existsSync(xlsxPath)) return;
  fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });
  const sheetId = "1T66cBdEUXSdTFasNZ0ax1AtlwbI_89Fk3ZinpX07Mu8";
  execSync(
    `powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx' -OutFile '${xlsxPath.replace(/'/g, "''")}' -UseBasicParsing"`,
    { stdio: "inherit" },
  );
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

function pushIndex(map: Map<string, Set<string>>, key: string, productId: string): void {
  const k = key.trim();
  if (!k) return;
  const s = map.get(k) ?? new Set();
  s.add(productId);
  map.set(k, s);
}

function classifyIdentifierProfile(
  row: SheetRow,
  upcUniqueInCohort: Set<string>,
): IdentifierProfile {
  const hasSku = Boolean(row.seller_sku?.trim());
  const hasAsin = Boolean(row.asin);
  const hasFnsku = Boolean(row.fnsku);
  const upc = row.unit_upc ?? row.case_upc;
  const hasMfg = Boolean(row.mfg_number?.trim());

  if (hasSku && hasAsin && hasFnsku) return "seller_sku_asin_fnsku";
  if (hasSku && hasAsin) return "seller_sku_asin_only";
  if (hasSku && hasFnsku) return "seller_sku_fnsku_only";
  if (upc && upcUniqueInCohort.has(upc)) return "upc_present_unique";
  if (hasMfg) return "mfg_present";
  return "weak_unsafe";
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const censusRunId = censusRunArg();
  const censusDir = path.join(process.cwd(), CENSUS_BASE, censusRunId);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = dbUrl ? refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false }) : STAGING_REF;

  const blockers: string[] = [];
  const missingCsv = path.join(censusDir, "missing-products.csv");
  if (!fs.existsSync(missingCsv)) blockers.push(`Missing census file: ${missingCsv}`);
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);

  const missingCsvText = fs.existsSync(missingCsv) ? fs.readFileSync(missingCsv, "utf8") : "";
  const missingRowNums = [
    ...new Set(
      missingCsvText
        .split(/\r?\n/)
        .slice(1)
        .map((line) => Number(line.split(",")[0]))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];

  const xlsxPath = path.resolve(process.cwd(), xlsxArg());
  await ensureXlsx(xlsxPath);

  const missingRowsFile = path.join(outDir, "_missing_rows.txt");
  fs.writeFileSync(missingRowsFile, missingRowNums.join("\n") + "\n");

  const pyScript = path.join(process.cwd(), "scripts", "spreadsheet-missing-product-link-load.py");
  const pyOut = execSync(`python "${pyScript}" "${xlsxPath}" "@${missingRowsFile}"`, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const loaded = JSON.parse(pyOut) as { rows: SheetRow[]; count: number };

  const upcCounts = new Map<string, number>();
  for (const r of loaded.rows) {
    for (const u of [r.unit_upc, r.case_upc]) {
      if (!u) continue;
      upcCounts.set(u, (upcCounts.get(u) ?? 0) + 1);
    }
  }
  const upcUniqueInCohort = new Set([...upcCounts.entries()].filter(([, c]) => c === 1).map(([u]) => u));

  const productsBySku = new Map<string, Set<string>>();
  const productsByAsin = new Map<string, Set<string>>();
  const productsByFnsku = new Map<string, Set<string>>();
  const productsByUpc = new Map<string, Set<string>>();
  const mapByAsin = new Map<string, Set<string>>();
  const mapByFnsku = new Map<string, Set<string>>();
  const mapBySellerSku = new Map<string, Set<string>>();
  const mapByUpc = new Map<string, Set<string>>();
  const catalogByAsin = new Map<string, number>();
  const catalogBySku = new Map<string, number>();
  const catalogByFnsku = new Map<string, number>();
  const manageByAsin = new Map<string, number>();
  const manageBySku = new Map<string, number>();
  const manageByFnsku = new Map<string, number>();
  const fbaByAsin = new Map<string, number>();
  const fbaBySku = new Map<string, number>();
  const fbaByFnsku = new Map<string, number>();
  const afiByAsin = new Map<string, number>();
  const afiBySku = new Map<string, number>();
  const afiByFnsku = new Map<string, number>();

  let orgId = SAM_ORG_ID;
  let storeId = SAM_STORE_ID;

  if (blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const storeRow = await client.query(`SELECT id::text, organization_id::text FROM public.stores WHERE id = $1::uuid`, [
      SAM_STORE_ID,
    ]);
    orgId = storeRow.rows[0]?.organization_id != null ? String(storeRow.rows[0].organization_id) : SAM_ORG_ID;
    storeId = storeRow.rows[0]?.id != null ? String(storeRow.rows[0].id) : SAM_STORE_ID;

    const pr = await client.query(
      `SELECT id::text, sku, asin, fnsku, upc_code, barcode
       FROM public.products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
      [orgId, storeId],
    );
    for (const row of pr.rows as Record<string, string | null>[]) {
      const id = String(row.id);
      if (row.sku) pushIndex(productsBySku, String(row.sku).trim(), id);
      if (row.asin) pushIndex(productsByAsin, String(row.asin).trim().toUpperCase(), id);
      if (row.fnsku) pushIndex(productsByFnsku, String(row.fnsku).trim().toUpperCase(), id);
      if (row.upc_code) pushIndex(productsByUpc, String(row.upc_code).replace(/\D/g, ""), id);
      if (row.barcode) pushIndex(productsByUpc, String(row.barcode).replace(/\D/g, ""), id);
    }

    const mr = await client.query(
      `SELECT product_id::text, asin, fnsku, seller_sku, upc_code, msku
       FROM public.product_identifier_map
       WHERE organization_id = $1::uuid AND deleted_at IS NULL
         AND (store_id = $2::uuid OR store_id IS NULL)`,
      [orgId, storeId],
    );
    for (const row of mr.rows as Record<string, string | null>[]) {
      const id = String(row.product_id);
      if (row.asin) pushIndex(mapByAsin, String(row.asin).trim().toUpperCase(), id);
      if (row.fnsku) pushIndex(mapByFnsku, String(row.fnsku).trim().toUpperCase(), id);
      if (row.seller_sku) pushIndex(mapBySellerSku, String(row.seller_sku).trim(), id);
      if (row.upc_code) pushIndex(mapByUpc, String(row.upc_code).replace(/\D/g, ""), id);
      if (row.msku) pushIndex(mapBySellerSku, String(row.msku).trim(), id);
    }

    const cat = await client.query(
      `SELECT count(*)::int AS c, asin, seller_sku, fnsku
       FROM public.catalog_products
       WHERE organization_id = $1::uuid AND (store_id = $2::uuid OR store_id IS NULL)
       GROUP BY asin, seller_sku, fnsku`,
      [orgId, storeId],
    );
    for (const row of cat.rows as { c: number; asin: string | null; seller_sku: string | null; fnsku: string | null }[]) {
      if (row.asin) catalogByAsin.set(String(row.asin).trim().toUpperCase(), (catalogByAsin.get(String(row.asin).trim().toUpperCase()) ?? 0) + row.c);
      if (row.seller_sku) catalogBySku.set(String(row.seller_sku).trim(), (catalogBySku.get(String(row.seller_sku).trim()) ?? 0) + row.c);
      if (row.fnsku) catalogByFnsku.set(String(row.fnsku).trim().toUpperCase(), (catalogByFnsku.get(String(row.fnsku).trim().toUpperCase()) ?? 0) + row.c);
    }

    async function loadAmazonSkuTable(
      table: string,
      skuCol: string,
      fnskuCol: string | null,
      byAsin: Map<string, number>,
      bySku: Map<string, number>,
      byFnsku: Map<string, number>,
    ) {
      const fnskuSelect = fnskuCol ? `, ${fnskuCol}` : "";
      const groupFnsku = fnskuCol ? `, ${fnskuCol}` : "";
      const r = await client.query(
        `SELECT count(*)::int AS c, asin, ${skuCol} AS sku${fnskuSelect}
         FROM public.${table}
         WHERE organization_id = $1::uuid AND (store_id = $2::uuid OR store_id IS NULL)
         GROUP BY asin, ${skuCol}${groupFnsku}`,
        [orgId, storeId],
      );
      for (const row of r.rows as { c: number; asin: string | null; sku: string | null; fnsku?: string | null }[]) {
        if (row.asin) byAsin.set(String(row.asin).trim().toUpperCase(), (byAsin.get(String(row.asin).trim().toUpperCase()) ?? 0) + row.c);
        if (row.sku) bySku.set(String(row.sku).trim(), (bySku.get(String(row.sku).trim()) ?? 0) + row.c);
        if (fnskuCol && row.fnsku) byFnsku.set(String(row.fnsku).trim().toUpperCase(), (byFnsku.get(String(row.fnsku).trim().toUpperCase()) ?? 0) + row.c);
      }
    }

    await loadAmazonSkuTable("amazon_manage_fba_inventory", "sku", "fnsku", manageByAsin, manageBySku, manageByFnsku);
    await loadAmazonSkuTable("amazon_fba_inventory", "sku", "fnsku", fbaByAsin, fbaBySku, fbaByFnsku);
    await loadAmazonSkuTable(
      "amazon_amazon_fulfilled_inventory",
      "seller_sku",
      "fulfillment_channel_sku",
      afiByAsin,
      afiBySku,
      afiByFnsku,
    );

    await client.end();
  }

  function collectProductIds(row: SheetRow): { ids: Set<string>; sources: string[] } {
    const ids = new Set<string>();
    const sources: string[] = [];
    const addFrom = (map: Map<string, Set<string>>, key: string | null | undefined, label: string) => {
      if (!key) return;
      const hits = map.get(key.trim()) ?? map.get(key.trim().toUpperCase());
      if (!hits?.size) return;
      sources.push(`${label}:${hits.size}`);
      for (const id of hits) ids.add(id);
    };
    addFrom(productsByAsin, row.asin, "products.asin");
    addFrom(productsByFnsku, row.fnsku, "products.fnsku");
    addFrom(mapByAsin, row.asin, "map.asin");
    addFrom(mapByFnsku, row.fnsku, "map.fnsku");
    const upc = row.unit_upc ?? row.case_upc;
    addFrom(productsByUpc, upc, "products.upc");
    addFrom(mapByUpc, upc, "map.upc");
    return { ids, sources };
  }

  function seedEvidence(row: SheetRow): { table: string | null; strength: number; note: string } {
    const checks: { table: string; hit: number }[] = [];
    if (row.asin) {
      checks.push({ table: "catalog_products", hit: catalogByAsin.get(row.asin) ?? 0 });
      checks.push({ table: "amazon_manage_fba_inventory", hit: manageByAsin.get(row.asin) ?? 0 });
      checks.push({ table: "amazon_fba_inventory", hit: fbaByAsin.get(row.asin) ?? 0 });
      checks.push({ table: "amazon_amazon_fulfilled_inventory", hit: afiByAsin.get(row.asin) ?? 0 });
    }
    if (row.seller_sku) {
      checks.push({ table: "catalog_products", hit: Math.max(checks.find((c) => c.table === "catalog_products")?.hit ?? 0, catalogBySku.get(row.seller_sku) ?? 0) });
      checks.push({ table: "amazon_manage_fba_inventory", hit: Math.max(checks.find((c) => c.table === "amazon_manage_fba_inventory")?.hit ?? 0, manageBySku.get(row.seller_sku) ?? 0) });
    }
    if (row.fnsku) {
      checks.push({ table: "catalog_products", hit: Math.max(catalogByFnsku.get(row.fnsku) ?? 0, catalogByAsin.get(row.asin ?? "") ?? 0) });
      checks.push({ table: "amazon_manage_fba_inventory", hit: manageByFnsku.get(row.fnsku) ?? 0 });
    }
    const best = [...checks].sort((a, b) => b.hit - a.hit)[0];
    if (best && best.hit > 0) return { table: best.table, strength: best.hit, note: `source_rows_${best.hit}` };
    return { table: null, strength: 0, note: "no_approved_source_hit" };
  }

  const planRows: PlanRow[] = [];

  for (const row of loaded.rows) {
    const profile = classifyIdentifierProfile(row, upcUniqueInCohort);
    const reasons: string[] = [];
    let path: ResolutionPath = "C_manual_review";
    let candidateProductId: string | null = null;
    let seedSourceTable: string | null = null;
    let seedSourceId: string | null = null;

    if (productsBySku.get(row.seller_sku.trim())?.size) {
      reasons.push("unexpected_products_sku_exists");
      path = "D_conflict_unsafe";
    } else if (mapBySellerSku.get(row.seller_sku.trim())?.size) {
      const mapHits = mapBySellerSku.get(row.seller_sku.trim())!;
      if (mapHits.size === 1) {
        path = "A_link_via_identifier_map";
        candidateProductId = [...mapHits][0]!;
        reasons.push("map_already_has_seller_sku_products_row_missing");
      } else {
        path = "D_conflict_unsafe";
        reasons.push(`map_seller_sku_ambiguous_${mapHits.size}`);
      }
    } else {
      const { ids, sources } = collectProductIds(row);
      reasons.push(...sources);

      if (ids.size === 1) {
        path = "A_link_via_identifier_map";
        candidateProductId = [...ids][0]!;
        reasons.push("single_product_via_asin_fnsku_upc_add_map_seller_sku");
      } else if (ids.size > 1) {
        path = "D_conflict_unsafe";
        reasons.push(`cross_identifier_multi_product_${ids.size}`);
      } else if (profile === "weak_unsafe") {
        path = "D_conflict_unsafe";
        reasons.push("weak_identifiers_no_spine_match");
      } else if (profile === "upc_present_unique") {
        const upc = row.unit_upc ?? row.case_upc;
        const upcProducts = new Set([...(productsByUpc.get(upc ?? "") ?? []), ...(mapByUpc.get(upc ?? "") ?? [])]);
        if (upcProducts.size === 1) {
          path = "A_link_via_identifier_map";
          candidateProductId = [...upcProducts][0]!;
          reasons.push("upc_unique_single_product_map_candidate");
        } else if (upcProducts.size > 1) {
          path = "D_conflict_unsafe";
          reasons.push("upc_multi_product");
        } else {
          path = "C_manual_review";
          reasons.push("upc_unique_in_sheet_no_product_hit");
        }
      } else {
        const seed = seedEvidence(row);
        if (seed.table) {
          path = "B_seed_from_approved_source";
          seedSourceTable = seed.table;
          seedSourceId = seed.note;
          reasons.push(`approved_source_${seed.table}`);
        } else if (profile === "mfg_present") {
          path = "C_manual_review";
          reasons.push("mfg_only_no_catalog_or_amazon_hit");
        } else {
          path = "C_manual_review";
          reasons.push("no_product_no_approved_source");
        }
      }
    }

    planRows.push({
      spreadsheet_row: row.row,
      seller_sku: row.seller_sku,
      sheet_asin: row.asin,
      sheet_fnsku: row.fnsku,
      unit_upc: row.unit_upc,
      case_upc: row.case_upc,
      mfg_number: row.mfg_number,
      brand: row.brand,
      identifier_profile: profile,
      resolution_path: path,
      candidate_product_id: candidateProductId,
      seed_source_table: seedSourceTable,
      seed_source_id: seedSourceId,
      reasons: reasons.join("; "),
    });
  }

  const profileRollup = new Map<IdentifierProfile, number>();
  const pathRollup = new Map<ResolutionPath, number>();
  for (const r of planRows) {
    profileRollup.set(r.identifier_profile, (profileRollup.get(r.identifier_profile) ?? 0) + 1);
    pathRollup.set(r.resolution_path, (pathRollup.get(r.resolution_path) ?? 0) + 1);
  }

  const csvHeaders = [
    "spreadsheet_row",
    "seller_sku",
    "sheet_asin",
    "sheet_fnsku",
    "unit_upc",
    "case_upc",
    "mfg_number",
    "brand",
    "identifier_profile",
    "resolution_path",
    "candidate_product_id",
    "seed_source_table",
    "seed_source_id",
    "reasons",
  ];

  writeCsv(
    path.join(outDir, "identifier-profile-rollup.csv"),
    ["identifier_profile", "count"],
    [...profileRollup.entries()].map(([identifier_profile, count]) => ({ identifier_profile, count })),
  );
  writeCsv(
    path.join(outDir, "resolution-path-rollup.csv"),
    ["resolution_path", "count"],
    [...pathRollup.entries()].map(([resolution_path, count]) => ({ resolution_path, count })),
  );

  const pathA = planRows.filter((r) => r.resolution_path === "A_link_via_identifier_map");
  const pathB = planRows.filter((r) => r.resolution_path === "B_seed_from_approved_source");
  const pathC = planRows.filter((r) => r.resolution_path === "C_manual_review");
  const pathD = planRows.filter((r) => r.resolution_path === "D_conflict_unsafe");

  writeCsv(path.join(outDir, "identifier-map-candidates.csv"), csvHeaders, pathA);
  writeCsv(path.join(outDir, "product-seed-candidates.csv"), csvHeaders, pathB);
  writeCsv(path.join(outDir, "manual-review.csv"), csvHeaders, pathC);
  writeCsv(path.join(outDir, "conflicts.csv"), csvHeaders, pathD);

  const seedBySource = new Map<string, number>();
  for (const r of pathB) {
    const t = r.seed_source_table ?? "unknown";
    seedBySource.set(t, (seedBySource.get(t) ?? 0) + 1);
  }

  fs.writeFileSync(
    path.join(outDir, "link-plan-summary.md"),
    `# Missing product link plan summary

**Run:** \`${OUT_BASE}/${runId}/\`  
**Source census:** \`${CENSUS_BASE}/${censusRunId}/\`  
**Sheet:** [Google Products dimensions](${SHEET_URL})  
**Staging:** \`${STAGING_REF}\` · org \`${orgId}\` · store \`${storeId}\`  
**Branch:** \`${branch}\`  
**Mode:** read-only plan · **no writes**

## Input cohort

| Metric | Count |
|--------|------:|
| Missing-product rows (from census) | **${planRows.length}** |

## Identifier profile (task 2)

| Profile | Count |
|---------|------:|
| seller_sku + ASIN + FNSKU | ${profileRollup.get("seller_sku_asin_fnsku") ?? 0} |
| seller_sku + ASIN only | ${profileRollup.get("seller_sku_asin_only") ?? 0} |
| seller_sku + FNSKU only | ${profileRollup.get("seller_sku_fnsku_only") ?? 0} |
| UPC present + unique in cohort | ${profileRollup.get("upc_present_unique") ?? 0} |
| Mfg # present (fallback profile) | ${profileRollup.get("mfg_present") ?? 0} |
| Weak / unsafe identifiers | ${profileRollup.get("weak_unsafe") ?? 0} |

## Resolution path (task 4)

| Path | Count | Meaning |
|------|------:|---------|
| **A — link via identifier_map** | **${pathA.length}** | Existing \`products.id\` found via ASIN/FNSKU/UPC; add scoped \`seller_sku\` map row only |
| **B — seed from approved source** | **${pathB.length}** | No product spine; evidence in catalog/Amazon report tables |
| **C — manual review** | **${pathC.length}** | Operator triage before any write |
| **D — conflict / unsafe** | **${pathD.length}** | Multi-product or weak identifiers — do not auto-link/create |

## Product seed source breakdown (path B)

${[...seedBySource.entries()].map(([t, c]) => `- \`${t}\`: ${c}`).join("\n") || "_none_"}

## Recommended apply order (task 5)

1. **Identifier map dry-run** — ${pathA.length} rows (\`identifier-map-candidates.csv\`)
2. **Product seed dry-run** — ${pathB.length} rows from approved sources only (\`product-seed-candidates.csv\`)
3. **Re-run packaging staging match census** — unlock packaging wave-2 after links exist
4. **Manual queues** — ${pathC.length} review + ${pathD.length} conflicts remain out of automated scope

## Forbidden (unchanged)

- No spreadsheet auto-create from title/OCR/product_name
- No packaging import until \`products.sku\` resolves under org+store
- No vendor/brand writes in link phase
`,
  );

  fs.writeFileSync(
    path.join(outDir, "apply-strategy.md"),
    `# Apply strategy (plan only — no execute)

## Phase 1 — Identifier map dry-run (first)

**Scope:** ${pathA.length} path-A rows  
**Write target:** \`product_identifier_map\` only (INSERT scoped map row: org, store, seller_sku → existing product_id)  
**Pre-checks:** single unanimous product_id; seller_sku not already mapped to different product; no product_name merge  
**Approval:** new operator approval file required before staging apply

## Phase 2 — Product seed dry-run (second, gated)

**Scope:** ${pathB.length} path-B rows  
**Sources (priority):** catalog_products → amazon_manage_fba_inventory → amazon_fba_inventory → amazon_amazon_fulfilled_inventory  
**Write target:** governed E2-style product+map promotion (approved script only) — **not** spreadsheet import  
**Forbidden:** direct spreadsheet row → products insert

## Phase 3 — Packaging wave-2 (blocked until Phase 1+2)

Re-run \`product-spreadsheet-staging-match-census-dryrun\` after link/seed cohort completes.  
Expect \`packaging_candidate_existing_product\` count > 0 before packaging apply.

## Out of scope for automation

- **Manual review:** ${pathC.length} rows (\`manual-review.csv\`)
- **Conflicts:** ${pathD.length} rows (\`conflicts.csv\`)
`,
  );

  fs.writeFileSync(
    path.join(outDir, "exact-next-prompt.md"),
    `# Exact next prompt

\`\`\`
MAIN-PRODUCT-SPREADSHEET-IDENTIFIER-MAP-LINK-DRYRUN

Owner: Main/user
Branch: feature/product-canonicalization-v2
Mode: READ-ONLY dryrun first

Scope: ${pathA.length} path-A rows from identifier-map-candidates.csv
Source plan: ${OUT_BASE}/${runId}/
Source census: ${CENSUS_BASE}/${censusRunId}/
Write target (apply later): product_identifier_map only — seller_sku scoped org+store → existing products.id
Forbidden: products insert, packaging, vendor/brand, spreadsheet auto-create
Pre-requisite: operator approval before any staging apply
\`\`\`
`,
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "MAIN-PRODUCT-SPREADSHEET-MISSING-PRODUCT-LINK-PLAN",
        run_id: runId,
        census_run_id: censusRunId,
        read_only: true,
        no_db_writes: true,
        branch,
        staging_ref: STAGING_REF,
        missing_product_rows: planRows.length,
        path_a_identifier_map_candidates: pathA.length,
        path_b_product_seed_candidates: pathB.length,
        path_c_manual_review: pathC.length,
        path_d_conflicts: pathD.length,
        identifier_profiles: Object.fromEntries(profileRollup),
        resolution_paths: Object.fromEntries(pathRollup),
        seed_by_source: Object.fromEntries(seedBySource),
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
        missing_product_rows: planRows.length,
        path_a: pathA.length,
        path_b: pathB.length,
        path_c: pathC.length,
        path_d: pathD.length,
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
