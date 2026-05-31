/**
 * PRODUCT-SHEET-IDENTIFIER-MISMATCH-REVIEW-QUEUE (read-only)
 *   npx tsx scripts/product-sheet-identifier-mismatch-review-queue.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const PHASE_F_DIR = ".cursor/audit-reports/product-sheet-phase-f-resolve-readonly/20260607T160000Z";
const CENSUS_MISMATCH = ".cursor/audit-reports/product-spreadsheet-staging-match-census-dryrun/20260530T065129Z/identifier-mismatches.csv";
const OUT_BASE = ".cursor/audit-reports/product-sheet-identifier-mismatch-review-queue";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

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

function normId(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

function conflictType(reason: string): string {
  if (reason.includes("map_fnsku")) return "map_fnsku_mismatch";
  if (reason.includes("products_fnsku")) return "products_fnsku_mismatch";
  if (reason.includes("products_asin")) return "products_asin_mismatch";
  return reason || "unknown";
}

function conflictDetail(row: Row, prod: ProductRow | undefined, mapRows: MapRow[]): string {
  const parts: string[] = [];
  const sheetAsin = normId(row.sheet_asin);
  const sheetFnsku = normId(row.sheet_fnsku);
  const dbAsin = normId(prod?.asin);
  const dbFnsku = normId(prod?.fnsku);

  if (sheetAsin && dbAsin && sheetAsin !== dbAsin) {
    parts.push(`Sheet ASIN ${sheetAsin} ≠ products.asin ${dbAsin}`);
  }
  if (sheetFnsku && dbFnsku && sheetFnsku !== dbFnsku) {
    parts.push(`Sheet FNSKU ${sheetFnsku} ≠ products.fnsku ${dbFnsku}`);
  }
  if (sheetFnsku && !dbFnsku && mapRows.length) {
    const mapFns = [...new Set(mapRows.map((m) => normId(m.fnsku)).filter(Boolean))];
    if (mapFns.length && !mapFns.includes(sheetFnsku)) {
      parts.push(`Sheet FNSKU ${sheetFnsku} ≠ map FNSKU(s) ${mapFns.join("|")}`);
    }
  }
  if (sheetAsin && dbAsin && sheetAsin === dbAsin && sheetFnsku === dbFnsku) {
    parts.push("Sheet identifiers match products; map row disagreement only");
  }
  const skuHint = normId(row.seller_sku).replace(/-VEN$/i, "");
  if (skuHint.startsWith("B0") && sheetAsin !== skuHint && dbAsin === skuHint) {
    parts.push(`Seller SKU encodes DB ASIN ${skuHint}; sheet ASIN differs`);
  }
  return parts.join("; ") || row.mismatch_reason || row.reasons || "";
}

type ProductRow = {
  id: string;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  product_name: string | null;
  vendor_name: string | null;
  brand: string | null;
};

type MapRow = {
  id: string;
  product_id: string;
  seller_sku: string | null;
  fnsku: string | null;
  asin: string | null;
  msku: string | null;
};

function recommendAction(args: {
  row: Row;
  prod?: ProductRow;
  mapRows: MapRow[];
  duplicateSheetRows: number;
}): { code: "A" | "B" | "C" | "D"; label: string; rationale: string } {
  const { row, prod, mapRows, duplicateSheetRows } = args;
  const brand = (row.brand ?? "").trim();
  const vendor = (prod?.vendor_name ?? "").trim();
  const reason = conflictType(row.mismatch_reason || row.reasons || "");
  const sheetAsin = normId(row.sheet_asin);
  const dbAsin = normId(prod?.asin);
  const sheetFnsku = normId(row.sheet_fnsku);
  const dbFnsku = normId(prod?.fnsku);
  const sku = (row.seller_sku ?? "").trim();

  if (brand.toLowerCase() === "costco database" || vendor.toLowerCase().includes("costco")) {
    return {
      code: "D",
      label: "needs vendor/store scoping review",
      rationale: "Costco Database sheet brand vs store product — confirm org/store listing scope before changing identifiers.",
    };
  }

  if (duplicateSheetRows > 1) {
    return {
      code: "C",
      label: "needs manual product split/merge investigation",
      rationale: `${duplicateSheetRows} sheet rows hit same product_id with identical mismatch — likely duplicate sheet lines or multi-pack variant grouping.`,
    };
  }

  if (reason === "products_asin_mismatch" && sheetFnsku === dbFnsku && sheetFnsku) {
    const skuAsin = sku.replace(/-VEN$/i, "").toUpperCase();
    if (skuAsin === dbAsin) {
      return {
        code: "B",
        label: "sheet typo, needs sheet correction",
        rationale: "Seller SKU aligns with DB ASIN and FNSKU matches; sheet ASIN appears to be wrong listing code.",
      };
    }
    return {
      code: "C",
      label: "needs manual product split/merge investigation",
      rationale: "FNSKU matches DB but ASINs differ — possible listing change, relist, or wrong SKU→product link.",
    };
  }

  if (reason === "products_fnsku_mismatch" && sheetAsin === dbAsin && sheetAsin) {
    if (dbFnsku === dbAsin || !dbFnsku) {
      return {
        code: "A",
        label: "trust DB, ignore sheet field",
        rationale: "ASIN agrees; products.fnsku empty or legacy ASIN placeholder — prefer map/Amazon source over sheet FNSKU until verified.",
      };
    }
    return {
      code: "C",
      label: "needs manual product split/merge investigation",
      rationale: "ASIN matches but FNSKU differs — relabel, commingled inventory, or stale sheet FNSKU.",
    };
  }

  if (reason === "map_fnsku_mismatch") {
    return {
      code: "C",
      label: "needs manual product split/merge investigation",
      rationale: "Sheet FNSKU not on product row; map bridge FNSKU differs — reconcile map vs products before any apply.",
    };
  }

  if (dbAsin && sheetAsin && dbAsin.slice(0, 8) === sheetAsin.slice(0, 8)) {
    return {
      code: "B",
      label: "sheet typo, needs sheet correction",
      rationale: "ASINs are near-family variants on same SKU — likely sheet transcription error.",
    };
  }

  if (vendor && brand && vendor.toLowerCase() !== brand.toLowerCase() && !vendor.toLowerCase().includes(brand.toLowerCase())) {
    return {
      code: "D",
      label: "needs vendor/store scoping review",
      rationale: `products.vendor_name='${vendor}' vs sheet brand='${brand}' — confirm vendor normalization before identifier apply.`,
    };
  }

  return {
    code: "A",
    label: "trust DB, ignore sheet field",
    rationale: "Default: DB spine identifiers win; do not apply sheet identifier overwrite without explicit sign-off.",
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const queuePath = path.join(process.cwd(), PHASE_F_DIR, "identifier-mismatch-review-queue.csv");
  const censusPath = path.join(process.cwd(), CENSUS_MISMATCH);
  const queue = parseCsv(fs.readFileSync(queuePath, "utf8"));
  const census = parseCsv(fs.readFileSync(censusPath, "utf8"));
  const censusByRow = new Map(census.map((r) => [r.spreadsheet_row, r]));

  if (queue.length !== 21) {
    throw new Error(`Expected 21 mismatch rows, got ${queue.length}`);
  }

  const productIds = [...new Set(queue.map((r) => r.product_id).filter(Boolean))];
  const dupCountByProduct = new Map<string, number>();
  for (const r of queue) {
    const pid = r.product_id;
    dupCountByProduct.set(pid, (dupCountByProduct.get(pid) ?? 0) + 1);
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) throw new Error("STAGING_DIRECT_POSTGRES_URL required for read-only map/product enrichment");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const prodRes = await client.query(
    `SELECT id::text, sku, upper(trim(asin)) AS asin, upper(trim(fnsku)) AS fnsku,
            product_name, vendor_name, brand
     FROM products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
    [ORG, STORE, productIds],
  );
  const products = new Map<string, ProductRow>();
  for (const r of prodRes.rows as ProductRow[]) products.set(r.id, r);

  const mapRes = await client.query(
    `SELECT id::text, product_id::text, seller_sku, upper(trim(fnsku)) AS fnsku,
            upper(trim(asin)) AS asin, msku
     FROM product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND product_id = ANY($3::uuid[])
     ORDER BY product_id, seller_sku NULLS LAST, fnsku NULLS LAST`,
    [ORG, STORE, productIds],
  );
  const mapsByProduct = new Map<string, MapRow[]>();
  for (const r of mapRes.rows as MapRow[]) {
    const list = mapsByProduct.get(r.product_id) ?? [];
    list.push(r);
    mapsByProduct.set(r.product_id, list);
  }
  await client.end();

  const enriched: Record<string, unknown>[] = [];
  for (const q of queue) {
    const censusRow = censusByRow.get(q.spreadsheet_row) ?? {};
    const prod = products.get(q.product_id);
    const mapRows = mapsByProduct.get(q.product_id) ?? [];
    const rec = recommendAction({
      row: q,
      prod,
      mapRows,
      duplicateSheetRows: dupCountByProduct.get(q.product_id) ?? 1,
    });

    enriched.push({
      spreadsheet_row: q.spreadsheet_row,
      seller_sku: q.seller_sku,
      sheet_brand: q.brand,
      sheet_asin: q.sheet_asin,
      sheet_fnsku: q.sheet_fnsku,
      sheet_fulfillment: censusRow.fulfillment_context ?? "",
      sheet_case_pack: censusRow.case_pack ?? "",
      product_id: q.product_id,
      products_sku: prod?.sku ?? "",
      products_name: prod?.product_name ?? "",
      products_vendor: prod?.vendor_name ?? "",
      products_brand: prod?.brand ?? "",
      products_asin: prod?.asin ?? q.products_asin,
      products_fnsku: prod?.fnsku ?? q.products_fnsku,
      map_row_count: mapRows.length,
      map_seller_skus: [...new Set(mapRows.map((m) => m.seller_sku).filter(Boolean))].join("|"),
      map_fnskus: [...new Set(mapRows.map((m) => m.fnsku).filter(Boolean))].join("|"),
      map_asins: [...new Set(mapRows.map((m) => m.asin).filter(Boolean))].join("|"),
      phase_f_review_class: q.review_class,
      conflict_type: conflictType(q.mismatch_reason || q.reasons || ""),
      conflict_detail: conflictDetail(q, prod, mapRows),
      recommended_action_code: rec.code,
      recommended_action: rec.label,
      recommendation_rationale: rec.rationale,
      operator_decision_code: "",
      operator_decision_notes: "",
      operator_decision_utc: "",
    });
  }

  const decisionHeaders = [
    "spreadsheet_row",
    "seller_sku",
    "sheet_brand",
    "sheet_asin",
    "sheet_fnsku",
    "product_id",
    "products_name",
    "products_vendor",
    "products_asin",
    "products_fnsku",
    "map_row_count",
    "map_fnskus",
    "map_asins",
    "conflict_type",
    "conflict_detail",
    "recommended_action_code",
    "recommended_action",
    "recommendation_rationale",
    "operator_decision_code",
    "operator_decision_notes",
    "operator_decision_utc",
  ];

  writeCsv(path.join(outDir, "operator-decision-sheet.csv"), decisionHeaders, enriched);
  writeCsv(path.join(outDir, "identifier-mismatch-review-detail.csv"), Object.keys(enriched[0] ?? {}), enriched);

  const actionCounts = enriched.reduce(
    (acc, r) => {
      const c = String(r.recommended_action_code);
      acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const mdLines = [
    "# PRODUCT-SHEET-IDENTIFIER-MISMATCH-REVIEW-QUEUE",
    "",
    `**Run:** \`${OUT_BASE}/${runId}/\`  `,
    "**Mode:** read-only operator review packet · no DB writes  ",
    `**Source Phase F:** \`${PHASE_F_DIR}/\``,
    `**Rows:** 21 identifier mismatches (Phase F class A)`,
    "",
    "## Recommended action key",
    "",
    "| Code | Meaning |",
    "|------|---------|",
    "| **A** | trust DB, ignore sheet field |",
    "| **B** | sheet typo, needs sheet correction |",
    "| **C** | needs manual product split/merge investigation |",
    "| **D** | needs vendor/store scoping review |",
    "",
    "## Suggested distribution (agent pre-fill — operator overrides in CSV)",
    "",
    ...Object.entries(actionCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `- **${k}**: ${v} row(s)`),
    "",
    "## Operator instructions",
    "",
    "1. Open `operator-decision-sheet.csv`.",
    "2. For each row, set `operator_decision_code` to **A**, **B**, **C**, or **D** (override recommendation if needed).",
    "3. Add notes in `operator_decision_notes` and date in `operator_decision_utc`.",
    "4. Do **not** apply sheet identifier writes until all 21 rows are decided.",
    "",
    "## Row detail",
    "",
  ];

  for (const r of enriched) {
    mdLines.push(
      `### Row ${r.spreadsheet_row} — ${r.seller_sku}`,
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Sheet brand | ${r.sheet_brand} |`,
      `| Sheet ASIN / FNSKU | ${r.sheet_asin} / ${r.sheet_fnsku} |`,
      `| Matched product | \`${r.product_id}\` |`,
      `| DB name | ${String(r.products_name).replace(/\|/g, "/")} |`,
      `| DB vendor / brand | ${r.products_vendor} / ${r.products_brand} |`,
      `| DB ASIN / FNSKU | ${r.products_asin} / ${r.products_fnsku} |`,
      `| Map rows | ${r.map_row_count} (FNSKU: ${r.map_fnskus || "—"}; ASIN: ${r.map_asins || "—"}) |`,
      `| Conflict | **${r.conflict_type}** — ${r.conflict_detail} |`,
      `| Recommended | **${r.recommended_action_code}** — ${r.recommended_action} |`,
      `| Rationale | ${r.recommendation_rationale} |`,
      "",
    );
  }

  fs.writeFileSync(path.join(outDir, "review-queue.md"), mdLines.join("\n"));

  const manifest = {
    prompt: "PRODUCT-SHEET-IDENTIFIER-MISMATCH-REVIEW-QUEUE",
    run_id: runId,
    mode: "read_only_operator_review",
    db_writes: false,
    source_phase_f: PHASE_F_DIR,
    row_count: 21,
    distinct_product_ids: productIds.length,
    recommended_action_counts: actionCounts,
    artifacts: [
      "operator-decision-sheet.csv",
      "identifier-mismatch-review-detail.csv",
      "review-queue.md",
    ],
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
