/**
 * PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES-DRYRUN — full-pool read-only counts.
 *
 *   npx tsx scripts/product-sheet-phase1-closeout-safe-waves-dryrun.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const PHASE_F_RUN_ID = "20260607T160000Z";
const DRYRUN_ID = "20260530T065129Z";
const CENSUS_ID = "20260530T065129Z";
const PHASE_F_DIR = `.cursor/audit-reports/product-sheet-phase-f-resolve-readonly/${PHASE_F_RUN_ID}`;
const DRYRUN_DIR = `.cursor/audit-reports/product-sheet-import-pim-normalization-dryrun/${DRYRUN_ID}`;
const CENSUS_DIR = `.cursor/audit-reports/product-spreadsheet-staging-match-census-dryrun/${CENSUS_ID}`;
const OUT_BASE = ".cursor/audit-reports/product-sheet-phase1-closeout-safe-waves-dryrun";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MATCH_SOURCE = "product_sheet_phase1_closeout";

type Row = Record<string, string>;
type NullFillRow = {
  spreadsheet_row: string;
  seller_sku: string;
  product_id: string;
  patch_asin: string | null;
  patch_fnsku: string | null;
};
type MapInsertRow = {
  spreadsheet_row: string;
  product_id: string;
  seller_sku: string;
  identifier_type: string;
  identifier_value: string;
  external_listing_id: string;
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

function asinOk(s: string): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(s.trim());
}

function buildTier2EligibleIds(classified: Row[]): Set<string> {
  const phaseFDir = path.join(process.cwd(), PHASE_F_DIR);
  const mismatchRows = new Set(
    parseCsv(fs.readFileSync(path.join(phaseFDir, "identifier-mismatch-review-queue.csv"), "utf8")).map(
      (r) => r.spreadsheet_row,
    ),
  );
  const blockedRows = new Set(
    parseCsv(fs.readFileSync(path.join(phaseFDir, "blocked-creates-classification.csv"), "utf8")).map(
      (r) => r.spreadsheet_row,
    ),
  );
  const classCAsins = new Set(
    parseCsv(fs.readFileSync(path.join(phaseFDir, "duplicate-asin-groups.csv"), "utf8"))
      .filter((r) => r.review_class === "C")
      .map((r) => (r.sheet_asin ?? "").trim().toUpperCase()),
  );
  const classCSpreadsheetRows = new Set<string>();
  for (const r of classified) {
    const asin = (r.sheet_asin ?? "").trim().toUpperCase();
    if (classCAsins.has(asin)) classCSpreadsheetRows.add(r.spreadsheet_row);
  }

  const eligible = new Set<string>();
  for (const r of classified) {
    const rowId = r.spreadsheet_row;
    if (mismatchRows.has(rowId)) continue;
    if (blockedRows.has(rowId)) continue;
    if (classCSpreadsheetRows.has(rowId)) continue;
    const cls = r.classification ?? "";
    if (
      ["identifier_mismatch", "unsafe_product_create_candidate", "missing_product", "ambiguous_identifier"].includes(
        cls,
      )
    ) {
      continue;
    }
    if (!r.product_id?.trim()) continue;
    if ((r.reasons ?? "").includes("sheet_review_required_duplicate_asin_or_conflict")) continue;
    eligible.add(rowId);
  }
  return eligible;
}

function loadAllCandidates(eligibleIds: Set<string>): { nullCandidates: Row[]; mapCandidates: Row[] } {
  const dryDir = path.join(process.cwd(), DRYRUN_DIR);
  const existingUpdates = parseCsv(fs.readFileSync(path.join(dryDir, "existing-product-updates.csv"), "utf8"));
  const mapInserts = parseCsv(fs.readFileSync(path.join(dryDir, "proposed-identifier-map-inserts.csv"), "utf8"));
  return {
    nullCandidates: existingUpdates
      .filter((r) => eligibleIds.has(r.spreadsheet_row))
      .filter((r) => r.patch_asin_if_null || r.patch_fnsku_if_null),
    mapCandidates: mapInserts.filter((r) => eligibleIds.has(r.spreadsheet_row)),
  };
}

function buildNullFill(nullCandidates: Row[]): NullFillRow[] {
  return nullCandidates.map((r) => ({
    spreadsheet_row: r.spreadsheet_row,
    seller_sku: r.seller_sku,
    product_id: r.product_id,
    patch_asin: r.patch_asin_if_null?.trim() || null,
    patch_fnsku: r.patch_fnsku_if_null?.trim() || null,
  }));
}

function buildMapPlan(mapCandidates: Row[]): MapInsertRow[] {
  const seen = new Set<string>();
  const out: MapInsertRow[] = [];
  for (const r of mapCandidates) {
    const key = `${r.product_id}|${r.identifier_type}|${r.identifier_value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      spreadsheet_row: r.spreadsheet_row,
      product_id: r.product_id,
      seller_sku: r.seller_sku,
      identifier_type: r.identifier_type,
      identifier_value: r.identifier_value,
      external_listing_id: `${MATCH_SOURCE}:dryrun:row:${r.spreadsheet_row}:${r.identifier_type}:${r.identifier_value}`,
    });
  }
  return out;
}

async function filterAlreadyApplied(
  client: pg.Client,
  nullFill: NullFillRow[],
  mapPlan: MapInsertRow[],
): Promise<{ nullFill: NullFillRow[]; mapPlan: MapInsertRow[] }> {
  const productIds = [...new Set(nullFill.map((r) => r.product_id))];
  const productState = new Map<string, { asin: string | null; fnsku: string | null }>();
  if (productIds.length > 0) {
    const pr = await client.query(`SELECT id::text, asin, fnsku FROM public.products WHERE id = ANY($1::uuid[])`, [
      productIds,
    ]);
    for (const r of pr.rows as { id: string; asin: string | null; fnsku: string | null }[]) {
      productState.set(r.id, r);
    }
  }

  const filteredNull = nullFill.filter((row) => {
    const p = productState.get(row.product_id);
    if (!p) return false;
    const needsAsin = row.patch_asin && !p.asin;
    const needsFnsku = row.patch_fnsku && !p.fnsku;
    return Boolean(needsAsin || needsFnsku);
  });

  const skus = [...new Set(mapPlan.map((r) => r.seller_sku))];
  const existingMaps = new Map<
    string,
    { product_id: string; fnsku: string | null; id: string; deleted_at: string | null }
  >();
  if (skus.length > 0) {
    const mr = await client.query(
      `SELECT DISTINCT ON (m.seller_sku)
        m.id::text, m.product_id::text, m.seller_sku, m.fnsku, m.deleted_at
      FROM public.product_identifier_map m
      WHERE m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.seller_sku = ANY($3::text[])
      ORDER BY m.seller_sku, (m.deleted_at IS NULL) DESC, m.updated_at DESC NULLS LAST`,
      [ORG, STORE, skus],
    );
    for (const r of mr.rows as {
      id: string;
      product_id: string;
      seller_sku: string;
      fnsku: string | null;
      deleted_at: string | null;
    }[]) {
      existingMaps.set(r.seller_sku, r);
    }
  }

  const filteredMap = mapPlan.filter((row) => {
    const hit = existingMaps.get(row.seller_sku);
    if (!hit) return true;
    if (hit.deleted_at != null) return false;
    if (String(hit.product_id) !== String(row.product_id)) return false;
    if (row.identifier_type === "fnsku" && hit.fnsku == null) return true;
    return false;
  });

  return { nullFill: filteredNull, mapPlan: filteredMap };
}

async function countSafeMapActions(
  client: pg.Client,
  mapPlan: MapInsertRow[],
): Promise<{ mapInserts: number; mapFnskuNullFill: number }> {
  if (mapPlan.length === 0) return { mapInserts: 0, mapFnskuNullFill: 0 };

  const mapPayload = mapPlan.map((r) => ({
    organization_id: ORG,
    store_id: STORE,
    product_id: r.product_id,
    seller_sku: r.seller_sku,
    msku: null,
    fnsku: r.identifier_type === "fnsku" ? r.identifier_value : null,
    match_source: MATCH_SOURCE,
    source_report_type: "spreadsheet_product_sheet",
    external_listing_id: r.external_listing_id,
  }));

  const mapConflicts = await client.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        organization_id uuid, store_id uuid, product_id uuid, seller_sku text, fnsku text, external_listing_id text
      )
    )
    SELECT i.external_listing_id
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id AND m.store_id = i.store_id AND m.deleted_at IS NULL
     AND m.seller_sku IS NOT DISTINCT FROM i.seller_sku
    WHERE m.product_id IS DISTINCT FROM i.product_id
    UNION
    SELECT i.external_listing_id
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id AND m.store_id = i.store_id AND m.deleted_at IS NULL
     AND i.fnsku IS NOT NULL AND m.fnsku IS NOT DISTINCT FROM i.fnsku
    WHERE m.product_id IS DISTINCT FROM i.product_id
    `,
    [JSON.stringify(mapPayload)],
  );
  const conflictIds = new Set(
    (mapConflicts.rows as { external_listing_id: string }[]).map((r) => r.external_listing_id),
  );
  const safePlan = mapPlan.filter((r) => !conflictIds.has(r.external_listing_id));
  const safePayload = mapPayload.filter((r) => !conflictIds.has(r.external_listing_id));

  const preExisting = await client.query(
    `SELECT external_listing_id FROM public.product_identifier_map WHERE external_listing_id = ANY($1::text[])`,
    [safePlan.map((r) => r.external_listing_id)],
  );
  const preExistingIds = new Set(
    (preExisting.rows as { external_listing_id: string }[]).map((r) => r.external_listing_id),
  );

  const existingSkuMaps = await client.query(
    `WITH input AS (SELECT unnest($1::text[]) AS seller_sku)
     SELECT DISTINCT ON (m.seller_sku)
       m.id::text, m.product_id::text, m.seller_sku, m.fnsku, m.deleted_at
     FROM input i
     JOIN public.product_identifier_map m
       ON m.organization_id = $2::uuid AND m.store_id = $3::uuid AND m.seller_sku = i.seller_sku
     ORDER BY m.seller_sku, (m.deleted_at IS NULL) DESC, m.updated_at DESC NULLS LAST`,
    [[...new Set(safePlan.map((r) => r.seller_sku))], ORG, STORE],
  );

  const insertable = safePayload.filter((row) => {
    if (preExistingIds.has(row.external_listing_id)) return false;
    const skuHit = existingSkuMaps.rows.find((r) => r.seller_sku === row.seller_sku);
    if (skuHit) return false;
    return true;
  });
  const insertSkuSeen = new Set<string>();
  const mapInserts = insertable.filter((row) => {
    if (insertSkuSeen.has(row.seller_sku)) return false;
    insertSkuSeen.add(row.seller_sku);
    return true;
  }).length;

  const mapFnskuNullFill = safePayload.filter((row) => {
    if (!row.fnsku) return false;
    const skuHit = existingSkuMaps.rows.find((r) => r.seller_sku === row.seller_sku);
    if (!skuHit) return false;
    if (skuHit.deleted_at != null) return false;
    if (String(skuHit.product_id) !== String(row.product_id)) return false;
    if (skuHit.fnsku != null && String(skuHit.fnsku).trim() !== "") return false;
    return true;
  }).length;

  return { mapInserts, mapFnskuNullFill };
}

async function countSafeNullFill(client: pg.Client, nullFill: NullFillRow[]): Promise<number> {
  if (nullFill.length === 0) return 0;
  const conflicts = await client.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(product_id uuid, patch_asin text, patch_fnsku text)
    )
    SELECT i.product_id::text
    FROM input i
    JOIN public.products p ON p.asin IS NOT NULL AND btrim(p.asin) = btrim(i.patch_asin) AND p.id <> i.product_id
    WHERE i.patch_asin IS NOT NULL
    UNION
    SELECT i.product_id::text
    FROM input i
    JOIN public.products p ON p.fnsku IS NOT NULL AND btrim(p.fnsku) = btrim(i.patch_fnsku) AND p.id <> i.product_id
    WHERE i.patch_fnsku IS NOT NULL
    `,
    [
      JSON.stringify(
        nullFill.map((r) => ({ product_id: r.product_id, patch_asin: r.patch_asin, patch_fnsku: r.patch_fnsku })),
      ),
    ],
  );
  const conflictIds = new Set((conflicts.rows as { product_id: string }[]).map((r) => r.product_id));
  return nullFill.filter((r) => !conflictIds.has(r.product_id)).length;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const classifiedPath = path.join(process.cwd(), CENSUS_DIR, "all-classified-rows.csv");
  if (!fs.existsSync(classifiedPath)) {
    throw new Error(`Missing ${classifiedPath} — run product-spreadsheet-staging-match-census-dryrun first`);
  }
  const dryNullPath = path.join(process.cwd(), DRYRUN_DIR, "existing-product-updates.csv");
  if (!fs.existsSync(dryNullPath)) {
    throw new Error(`Missing ${dryNullPath} — run product-sheet-import-pim-normalization-dryrun-emit first`);
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const classified = parseCsv(fs.readFileSync(classifiedPath, "utf8"));
  const eligibleIds = buildTier2EligibleIds(classified);
  const { nullCandidates, mapCandidates } = loadAllCandidates(eligibleIds);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  let nullFill = buildNullFill(nullCandidates);
  let mapPlan = buildMapPlan(mapCandidates);
  ({ nullFill, mapPlan } = await filterAlreadyApplied(client, nullFill, mapPlan));

  const safeNullFillRows = await countSafeNullFill(client, nullFill);
  const mapCounts = await countSafeMapActions(client, mapPlan);
  const safeIdentifierMapRows = mapCounts.mapInserts + mapCounts.mapFnskuNullFill;
  await client.end();

  const matchedRows = eligibleIds.size;
  const packagingRowsReady = classified.filter(
    (r) => eligibleIds.has(r.spreadsheet_row) && r.classification === "packaging_candidate_existing_product",
  ).length;

  const phaseFDir = path.join(process.cwd(), PHASE_F_DIR);
  const blockedProductCreates = parseCsv(
    fs.readFileSync(path.join(phaseFDir, "blocked-creates-classification.csv"), "utf8"),
  ).length;

  const needsReviewConflicts =
    classified.filter((r) => r.classification === "identifier_mismatch").length +
    classified.filter((r) => r.classification === "ambiguous_identifier").length +
    classified.filter((r) => r.classification === "needs_review").length;

  const applySafe =
    safeNullFillRows > 0 || safeIdentifierMapRows > 0 || packagingRowsReady > 0;

  const exactApplyPromptIfSafe = applySafe
    ? [
        "PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES",
        "",
        "Mode: GOVERNED STAGING APPLY.",
        "Target staging only (eiqfaapyumhixxoeltgu).",
        "No product creation. No fuzzy merge. Max waves: 30.",
        "",
        `Remaining safe null-fill rows: ${safeNullFillRows}`,
        `Remaining safe identifier map rows: ${safeIdentifierMapRows}`,
        `Packaging rows ready (separate wave): ${packagingRowsReady}`,
        "",
        "Approvals required:",
        "  APPROVED_TO_RUN_STAGING=true",
        "  APPROVED_PRODUCT_SHEET_PHASE1_CLOSEOUT=true",
        "  APPROVED_NULL_FILL_MAX_100=true",
        "  APPROVED_MAP_INSERT_MAX_100=true",
        "  APPROVED_CATALOG_UPSERT_MAX_100=true",
        "  APPROVED_PRODUCT_INSERT=false",
        "  TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu",
        "",
        "Command:",
        `  npx tsx scripts/product-sheet-phase1-closeout-safe-waves.ts --run-id=<UTC> --apply --max-waves=30`,
      ].join("\n")
    : "none — no remaining conflict-free closeout rows ready for apply";

  const report = {
    prompt: "PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES-DRYRUN",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "dry-run",
    matched_rows: matchedRows,
    safe_null_fill_rows: safeNullFillRows,
    safe_identifier_map_rows: safeIdentifierMapRows,
    packaging_rows_ready: packagingRowsReady,
    blocked_product_creates: blockedProductCreates,
    needs_review_conflicts: needsReviewConflicts,
    exact_apply_prompt_if_safe: exactApplyPromptIfSafe,
    detail: {
      safe_map_inserts: mapCounts.mapInserts,
      safe_map_fnsku_null_fill: mapCounts.mapFnskuNullFill,
      tier2_eligible_spreadsheet_rows: matchedRows,
      null_fill_pool_after_idempotent_filter: nullFill.length,
      map_pool_after_idempotent_filter: mapPlan.length,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "dryrun-report.md"), `# PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES-DRYRUN

| Field | Value |
|-------|------:|
| matched_rows | ${matchedRows} |
| safe_null_fill_rows | ${safeNullFillRows} |
| safe_identifier_map_rows | ${safeIdentifierMapRows} |
| packaging_rows_ready | ${packagingRowsReady} |
| blocked_product_creates | ${blockedProductCreates} |
| needs_review_conflicts | ${needsReviewConflicts} |

## exact_apply_prompt_if_safe

\`\`\`
${exactApplyPromptIfSafe}
\`\`\`
`);

  console.log(
    JSON.stringify(
      {
        matched_rows: matchedRows,
        safe_null_fill_rows: safeNullFillRows,
        safe_identifier_map_rows: safeIdentifierMapRows,
        packaging_rows_ready: packagingRowsReady,
        blocked_product_creates: blockedProductCreates,
        needs_review_conflicts: needsReviewConflicts,
        exact_apply_prompt_if_safe: applySafe ? "see manifest" : "none",
        outDir,
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
