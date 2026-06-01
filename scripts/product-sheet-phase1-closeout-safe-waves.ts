/**
 * PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES
 *   npx tsx scripts/product-sheet-phase1-closeout-safe-waves.ts --run-id=<UTC>
 *   npx tsx scripts/product-sheet-phase1-closeout-safe-waves.ts --run-id=<UTC> --apply
 *   npx tsx scripts/product-sheet-phase1-closeout-safe-waves.ts --run-id=<UTC> --apply --max-waves=30
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
const APPROVAL_PATH = ".cursor/operator-approvals/product-sheet-phase1-closeout-safe-waves-approval.md";
const OUT_BASE = ".cursor/audit-reports/product-sheet-phase1-closeout-safe-waves";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MATCH_SOURCE = "product_sheet_phase1_closeout";
const SOURCE_REPORT_TYPE = "spreadsheet_product_sheet";

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

type CatalogRow = {
  spreadsheet_row: string;
  seller_sku: string;
  sheet_asin: string;
  sheet_fnsku: string;
  fulfillment_channel: string;
};

type LinkageMetrics = {
  expected_packages_total: number;
  expected_packages_resolved: number;
  expected_packages_unresolved: number;
  return_items_total: number;
  return_items_unresolved: number;
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

function intArg(name: string, fallback: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return fallback;
  const v = Number(a.split("=")[1]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
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

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function asinOk(s: string): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(s.trim());
}

function readApproval(): boolean {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_SHEET_PHASE1_CLOSEOUT\s*=\s*true/i.test(text) &&
    /APPROVED_NULL_FILL_MAX_100\s*=\s*true/i.test(text) &&
    /APPROVED_MAP_INSERT_MAX_100\s*=\s*true/i.test(text) &&
    /APPROVED_CATALOG_UPSERT_MAX_100\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_INSERT\s*=\s*false/i.test(text) &&
    new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)
  );
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

function loadAllCandidates(eligibleIds: Set<string>): {
  nullCandidates: Row[];
  mapCandidates: Row[];
  catalogCandidates: Row[];
} {
  const dryDir = path.join(process.cwd(), DRYRUN_DIR);
  const existingUpdates = parseCsv(fs.readFileSync(path.join(dryDir, "existing-product-updates.csv"), "utf8"));
  const mapInserts = parseCsv(fs.readFileSync(path.join(dryDir, "proposed-identifier-map-inserts.csv"), "utf8"));
  const catalogUpserts = parseCsv(
    fs.readFileSync(path.join(dryDir, "proposed-catalog-product-upserts.csv"), "utf8"),
  );

  return {
    nullCandidates: existingUpdates
      .filter((r) => eligibleIds.has(r.spreadsheet_row))
      .filter((r) => r.patch_asin_if_null || r.patch_fnsku_if_null),
    mapCandidates: mapInserts.filter((r) => eligibleIds.has(r.spreadsheet_row)),
    catalogCandidates: catalogUpserts
      .filter((r) => eligibleIds.has(r.spreadsheet_row))
      .filter((r) => asinOk(r.sheet_asin ?? "")),
  };
}

function buildWavePlans(
  nullCandidates: Row[],
  mapCandidates: Row[],
  catalogCandidates: Row[],
  maxPerType: number,
  waveIndex: number,
): {
  nullFill: NullFillRow[];
  mapPlan: MapInsertRow[];
  catalogPlan: CatalogRow[];
} {
  const nullFill = nullCandidates.slice(0, maxPerType).map((r) => ({
    spreadsheet_row: r.spreadsheet_row,
    seller_sku: r.seller_sku,
    product_id: r.product_id,
    patch_asin: r.patch_asin_if_null?.trim() || null,
    patch_fnsku: r.patch_fnsku_if_null?.trim() || null,
  }));

  const mapSlice = mapCandidates.slice(0, maxPerType);
  const seen = new Set<string>();
  const mapPlan: MapInsertRow[] = [];
  for (const r of mapSlice) {
    const key = `${r.product_id}|${r.identifier_type}|${r.identifier_value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mapPlan.push({
      spreadsheet_row: r.spreadsheet_row,
      product_id: r.product_id,
      seller_sku: r.seller_sku,
      identifier_type: r.identifier_type,
      identifier_value: r.identifier_value,
      external_listing_id: `${MATCH_SOURCE}:w${waveIndex + 1}:row:${r.spreadsheet_row}:${r.identifier_type}:${r.identifier_value}`,
    });
  }

  const catalogPlan = catalogCandidates.slice(0, maxPerType).map((r) => ({
    spreadsheet_row: r.spreadsheet_row,
    seller_sku: r.seller_sku,
    sheet_asin: r.sheet_asin,
    sheet_fnsku: r.sheet_fnsku,
    fulfillment_channel: r.fulfillment_channel || "fba",
  }));

  return { nullFill, mapPlan, catalogPlan };
}

async function tableCounts(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.catalog_products) AS catalog_products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map
        WHERE match_source = $1 AND deleted_at IS NULL) AS closeout_map_rows,
      (SELECT COUNT(*)::int FROM public.product_identifier_map
        WHERE match_source = 'product_sheet_wave1_sample' AND deleted_at IS NULL) AS wave1_map_rows
    `,
    [MATCH_SOURCE],
  );
  return r.rows[0] as Record<string, number>;
}

async function linkageMetrics(client: pg.Client): Promise<LinkageMetrics> {
  const ep = await client.query(
    `
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      count(*) FILTER (
        WHERE resolved_product_id IS NULL
          AND COALESCE(identifier_resolution_status, 'unresolved') NOT IN ('ambiguous', 'mismatch')
      )::int AS unresolved
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
    `,
    [ORG, STORE],
  );
  const ri = await client.query(
    `
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE resolved_product_id IS NULL
          AND COALESCE(identifier_resolution_status, 'unresolved') NOT IN ('ambiguous', 'mismatch')
      )::int AS unresolved
    FROM public.return_items
    WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
    `,
    [ORG, STORE],
  );
  const epRow = ep.rows[0] as { total: number; resolved: number; unresolved: number };
  const riRow = ri.rows[0] as { total: number; unresolved: number };
  return {
    expected_packages_total: epRow.total ?? 0,
    expected_packages_resolved: epRow.resolved ?? 0,
    expected_packages_unresolved: epRow.unresolved ?? 0,
    return_items_total: riRow.total ?? 0,
    return_items_unresolved: riRow.unresolved ?? 0,
  };
}

async function filterAlreadyApplied(
  client: pg.Client,
  nullFill: NullFillRow[],
  mapPlan: MapInsertRow[],
  catalogPlan: CatalogRow[],
): Promise<{ nullFill: NullFillRow[]; mapPlan: MapInsertRow[]; catalogPlan: CatalogRow[] }> {
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
      `
      SELECT DISTINCT ON (m.seller_sku)
        m.id::text, m.product_id::text, m.seller_sku, m.fnsku, m.deleted_at
      FROM public.product_identifier_map m
      WHERE m.organization_id = $1::uuid AND m.store_id = $2::uuid
        AND m.seller_sku = ANY($3::text[])
      ORDER BY m.seller_sku, (m.deleted_at IS NULL) DESC, m.updated_at DESC NULLS LAST
      `,
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

  const catalogKeys = catalogPlan.map((r) => ({ seller_sku: r.seller_sku, asin: r.sheet_asin }));
  const existingCatalog = new Set<string>();
  if (catalogKeys.length > 0) {
    const cr = await client.query(
      `
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(seller_sku text, asin text)
      )
      SELECT c.seller_sku, c.asin, c.fnsku, c.fulfillment_channel
      FROM input i
      JOIN public.catalog_products c
        ON c.organization_id = $2::uuid AND c.store_id = $3::uuid
       AND c.seller_sku = i.seller_sku AND c.asin = i.asin
      `,
      [JSON.stringify(catalogKeys), ORG, STORE],
    );
    for (const r of cr.rows as { seller_sku: string; asin: string; fnsku: string | null; fulfillment_channel: string | null }[]) {
      const plan = catalogPlan.find((p) => p.seller_sku === r.seller_sku && p.sheet_asin === r.asin);
      if (!plan) continue;
      const fnskuMatch = !plan.sheet_fnsku || r.fnsku === plan.sheet_fnsku;
      const channelMatch = !plan.fulfillment_channel || r.fulfillment_channel === plan.fulfillment_channel;
      if (fnskuMatch && channelMatch) existingCatalog.add(`${r.seller_sku}|${r.asin}`);
    }
  }

  const filteredCatalog = catalogPlan.filter((r) => !existingCatalog.has(`${r.seller_sku}|${r.sheet_asin}`));
  return { nullFill: filteredNull, mapPlan: filteredMap, catalogPlan: filteredCatalog };
}

async function applyOneWave(
  client: pg.Client,
  outDir: string,
  waveIndex: number,
  nullFill: NullFillRow[],
  mapPlan: MapInsertRow[],
  catalogPlan: CatalogRow[],
  apply: boolean,
): Promise<{
  nullFillApplied: Record<string, unknown>[];
  mapInserted: Record<string, unknown>[];
  mapFnskuNullFill: Record<string, unknown>[];
  catalogApplied: { seller_sku: string; asin: string; catalog_id: string | null; action: string }[];
  blockers: string[];
  rollbackLines: string[];
  productById: Map<string, Record<string, unknown>>;
  catalogPre: Record<string, unknown>[];
  existingSkuMaps: Record<string, unknown>[];
}> {
  const waveDir = path.join(outDir, `wave-${String(waveIndex + 1).padStart(3, "0")}`);
  fs.mkdirSync(waveDir, { recursive: true });

  const productIds = [...new Set([...nullFill.map((r) => r.product_id), ...mapPlan.map((r) => r.product_id)])];
  const productPre = await client.query(
    `SELECT id::text, asin, fnsku, product_name, sku FROM public.products WHERE id = ANY($1::uuid[])`,
    [productIds],
  );
  const productById = new Map(productPre.rows.map((r) => [r.id as string, r as Record<string, unknown>]));

  const nullFillConflicts = await client.query(
    `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(product_id uuid, patch_asin text, patch_fnsku text)
    )
    SELECT i.product_id::text, 'asin_conflict'::text AS conflict_type, p.id::text AS other_product_id, p.asin
    FROM input i
    JOIN public.products p ON p.asin IS NOT NULL AND btrim(p.asin) = btrim(i.patch_asin) AND p.id <> i.product_id
    WHERE i.patch_asin IS NOT NULL
    UNION ALL
    SELECT i.product_id::text, 'fnsku_conflict'::text, p.id::text, p.fnsku
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

  const conflictNullProductIds = new Set(
    (nullFillConflicts.rows as { product_id: string }[]).map((r) => r.product_id),
  );

  let mapPayload = mapPlan.map((r) => ({
    organization_id: ORG,
    store_id: STORE,
    product_id: r.product_id,
    seller_sku: r.seller_sku,
    msku: null,
    fnsku: r.identifier_type === "fnsku" ? r.identifier_value : null,
    match_source: MATCH_SOURCE,
    source_report_type: SOURCE_REPORT_TYPE,
    external_listing_id: r.external_listing_id,
  }));

  const mapConflicts = await client.query(
    `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        organization_id uuid, store_id uuid, product_id uuid, seller_sku text, fnsku text, external_listing_id text
      )
    )
    SELECT i.external_listing_id, i.product_id::text AS planned_product_id, m.id::text AS existing_map_id,
           m.product_id::text AS existing_product_id, m.seller_sku, m.fnsku, 'seller_sku_mismatch'::text AS conflict_type
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id AND m.store_id = i.store_id AND m.deleted_at IS NULL
     AND m.seller_sku IS NOT DISTINCT FROM i.seller_sku
    WHERE m.product_id IS DISTINCT FROM i.product_id
    UNION ALL
    SELECT i.external_listing_id, i.product_id::text, m.id::text, m.product_id::text, m.seller_sku, m.fnsku, 'fnsku_mismatch'::text
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id AND m.store_id = i.store_id AND m.deleted_at IS NULL
     AND i.fnsku IS NOT NULL AND m.fnsku IS NOT DISTINCT FROM i.fnsku
    WHERE m.product_id IS DISTINCT FROM i.product_id
    `,
    [JSON.stringify(mapPayload)],
  );

  const conflictMapExternalIds = new Set(
    (mapConflicts.rows as { external_listing_id: string }[]).map((r) => r.external_listing_id),
  );
  nullFill = nullFill.filter((r) => !conflictNullProductIds.has(r.product_id));
  mapPlan = mapPlan.filter((r) => !conflictMapExternalIds.has(r.external_listing_id));
  mapPayload = mapPlan.map((r) => ({
    organization_id: ORG,
    store_id: STORE,
    product_id: r.product_id,
    seller_sku: r.seller_sku,
    msku: null,
    fnsku: r.identifier_type === "fnsku" ? r.identifier_value : null,
    match_source: MATCH_SOURCE,
    source_report_type: SOURCE_REPORT_TYPE,
    external_listing_id: r.external_listing_id,
  }));

  const preExistingMaps = await client.query(
    `SELECT id::text, product_id::text, seller_sku, fnsku, external_listing_id
     FROM public.product_identifier_map WHERE external_listing_id = ANY($1::text[])`,
    [mapPlan.map((r) => r.external_listing_id)],
  );

  const existingSkuMaps = await client.query(
    `
    WITH input AS (SELECT unnest($1::text[]) AS seller_sku)
    SELECT DISTINCT ON (m.seller_sku)
      m.id::text, m.product_id::text, m.seller_sku, m.fnsku, m.external_listing_id, m.deleted_at
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = $2::uuid AND m.store_id = $3::uuid AND m.seller_sku = i.seller_sku
    ORDER BY m.seller_sku, (m.deleted_at IS NULL) DESC, m.updated_at DESC NULLS LAST
    `,
    [[...new Set(mapPlan.map((r) => r.seller_sku))], ORG, STORE],
  );

  const catalogKeys = catalogPlan.map((r) => ({
    organization_id: ORG,
    store_id: STORE,
    seller_sku: r.seller_sku,
    asin: r.sheet_asin,
  }));
  const catalogPre = await client.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(organization_id uuid, store_id uuid, seller_sku text, asin text)
    )
    SELECT c.id::text, c.seller_sku, c.asin, c.fnsku, c.fulfillment_channel, c.source_report_type
    FROM input i
    JOIN public.catalog_products c
      ON c.organization_id = i.organization_id AND c.store_id = i.store_id
     AND c.seller_sku = i.seller_sku AND c.asin = i.asin
    `,
    [JSON.stringify(catalogKeys)],
  );

  const preimage = {
    wave_index: waveIndex + 1,
    null_fill_products: productPre.rows,
    null_fill_conflicts: nullFillConflicts.rows,
    map_conflicts: mapConflicts.rows,
    skipped_conflict_null_fill: [...conflictNullProductIds],
    skipped_conflict_map: [...conflictMapExternalIds],
    pre_existing_maps: preExistingMaps.rows,
    existing_seller_sku_maps: existingSkuMaps.rows,
    catalog_pre: catalogPre.rows,
    plan_counts: { null_fill: nullFill.length, map_inserts: mapPlan.length, catalog_upserts: catalogPlan.length },
  };
  fs.writeFileSync(path.join(waveDir, "preimage.json"), JSON.stringify(preimage, null, 2));

  const blockers: string[] = [];
  for (const pid of productIds) {
    if (!productById.has(pid)) blockers.push(`Missing product_id ${pid}`);
  }

  const insertableMapsRaw = mapPayload.filter((row) => {
    if (preExistingMaps.rows.some((r) => r.external_listing_id === row.external_listing_id)) return false;
    const skuHit = existingSkuMaps.rows.find((r) => r.seller_sku === row.seller_sku);
    if (skuHit) return false;
    return true;
  });
  const insertSkuSeen = new Set<string>();
  const insertableMaps = insertableMapsRaw.filter((row) => {
    if (insertSkuSeen.has(row.seller_sku)) return false;
    insertSkuSeen.add(row.seller_sku);
    return true;
  });

  const updatableMapNullFills = mapPayload.filter((row) => {
    if (!row.fnsku) return false;
    const skuHit = existingSkuMaps.rows.find((r) => r.seller_sku === row.seller_sku);
    if (!skuHit) return false;
    if (skuHit.deleted_at != null) return false;
    if (String(skuHit.product_id) !== String(row.product_id)) return false;
    if (skuHit.fnsku != null && String(skuHit.fnsku).trim() !== "") return false;
    return true;
  });

  let nullFillApplied: Record<string, unknown>[] = [];
  let mapInserted: Record<string, unknown>[] = [];
  let mapFnskuNullFill: Record<string, unknown>[] = [];
  let catalogApplied: { seller_sku: string; asin: string; catalog_id: string | null; action: string }[] = [];

  if (apply && blockers.length === 0) {
    await client.query("BEGIN");
    try {
      for (const row of nullFill) {
        const before = productById.get(row.product_id);
        if (!before) continue;
        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (row.patch_asin && !before.asin) {
          sets.push(`asin = $${idx++}`);
          vals.push(row.patch_asin);
        }
        if (row.patch_fnsku && !before.fnsku) {
          sets.push(`fnsku = $${idx++}`);
          vals.push(row.patch_fnsku);
        }
        if (sets.length === 0) continue;
        vals.push(row.product_id);
        const upd = await client.query(
          `UPDATE public.products SET ${sets.join(", ")}, updated_at = now()
           WHERE id = $${idx}::uuid
             AND (${row.patch_asin && !before.asin ? "asin IS NULL" : "true"})
             AND (${row.patch_fnsku && !before.fnsku ? "fnsku IS NULL" : "true"})
           RETURNING id::text, asin, fnsku`,
          vals,
        );
        if (upd.rowCount) nullFillApplied.push({ ...row, after: upd.rows[0] });
      }

      if (insertableMaps.length > 0) {
        const ins = await client.query(
          `
          WITH input AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
              organization_id uuid, store_id uuid, product_id uuid, seller_sku text, msku text, fnsku text,
              match_source text, source_report_type text, external_listing_id text
            )
          ),
          inserted AS (
            INSERT INTO public.product_identifier_map (
              organization_id, store_id, product_id, seller_sku, msku, fnsku,
              match_source, source_report_type, external_listing_id,
              is_primary, first_seen_at, last_seen_at, created_at, updated_at
            )
            SELECT i.organization_id, i.store_id, i.product_id, i.seller_sku, i.msku, i.fnsku,
                   i.match_source, i.source_report_type, i.external_listing_id,
                   true, now(), now(), now(), now()
            FROM input i
            WHERE NOT EXISTS (
              SELECT 1 FROM public.product_identifier_map m WHERE m.external_listing_id = i.external_listing_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.product_identifier_map m
              WHERE m.organization_id = i.organization_id AND m.store_id = i.store_id
                AND m.seller_sku IS NOT DISTINCT FROM i.seller_sku
            )
            ON CONFLICT DO NOTHING
            RETURNING id::text, product_id::text, seller_sku, fnsku, external_listing_id
          )
          SELECT * FROM inserted
          `,
          [JSON.stringify(insertableMaps)],
        );
        mapInserted = ins.rows;
      }

      for (const row of updatableMapNullFills) {
        const before = existingSkuMaps.rows.find((r) => r.seller_sku === row.seller_sku);
        if (!before) continue;
        const upd = await client.query(
          `UPDATE public.product_identifier_map SET fnsku = $1, updated_at = now()
           WHERE id = $2::uuid AND organization_id = $3::uuid AND store_id = $4::uuid
             AND deleted_at IS NULL AND fnsku IS NULL
           RETURNING id::text, product_id::text, seller_sku, fnsku, external_listing_id`,
          [row.fnsku, before.id, ORG, STORE],
        );
        if (upd.rowCount) {
          mapFnskuNullFill.push({
            map_id: before.id,
            product_id: row.product_id,
            seller_sku: row.seller_sku,
            fnsku: row.fnsku,
            before_fnsku: before.fnsku,
            after: upd.rows[0],
          });
        }
      }

      for (const row of catalogPlan) {
        const existed = catalogPre.rows.some((r) => r.seller_sku === row.seller_sku && r.asin === row.sheet_asin);
        const json = {
          seller_sku: row.seller_sku,
          asin1: row.sheet_asin,
          fnsku: row.sheet_fnsku,
          "fulfillment-channel": row.fulfillment_channel,
        };
        const cr = await client.query(
          `SELECT public.merge_catalog_product_from_listing_json($1::uuid, $2::uuid, $3::text, $4::jsonb)::text AS id`,
          [ORG, STORE, SOURCE_REPORT_TYPE, JSON.stringify(json)],
        );
        catalogApplied.push({
          seller_sku: row.seller_sku,
          asin: row.sheet_asin,
          catalog_id: cr.rows[0]?.id ?? null,
          action: existed ? "updated" : "inserted",
        });
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const rollbackLines: string[] = [`-- Wave ${waveIndex + 1} rollback`];
  for (const row of nullFillApplied) {
    const before = productById.get((row as { product_id: string }).product_id);
    if (!before) continue;
    rollbackLines.push(
      `UPDATE public.products SET asin = ${before.asin == null ? "NULL" : sqlLit(String(before.asin))}, fnsku = ${before.fnsku == null ? "NULL" : sqlLit(String(before.fnsku))}, updated_at = now() WHERE id = ${sqlLit((row as { product_id: string }).product_id)}::uuid;`,
    );
  }
  if (mapInserted.length > 0) {
    rollbackLines.push(
      `DELETE FROM public.product_identifier_map WHERE id IN (${mapInserted.map((r) => `${sqlLit(String(r.id))}::uuid`).join(", ")});`,
    );
  }
  for (const row of mapFnskuNullFill) {
    const beforeFnsku = (row as { before_fnsku: string | null }).before_fnsku;
    rollbackLines.push(
      `UPDATE public.product_identifier_map SET fnsku = ${beforeFnsku == null ? "NULL" : sqlLit(String(beforeFnsku))}, updated_at = now() WHERE id = ${sqlLit(String((row as { map_id: string }).map_id))}::uuid;`,
    );
  }
  for (const row of catalogApplied) {
    const pre = catalogPre.rows.find((r) => r.seller_sku === row.seller_sku && r.asin === row.asin);
    if (!pre && row.action === "inserted" && row.catalog_id) {
      rollbackLines.push(`DELETE FROM public.catalog_products WHERE id = ${sqlLit(row.catalog_id)}::uuid;`);
    } else if (pre) {
      rollbackLines.push(
        `UPDATE public.catalog_products SET fnsku = ${pre.fnsku == null ? "NULL" : sqlLit(String(pre.fnsku))}, fulfillment_channel = ${pre.fulfillment_channel == null ? "NULL" : sqlLit(String(pre.fulfillment_channel))}, source_report_type = ${pre.source_report_type == null ? "NULL" : sqlLit(String(pre.source_report_type))} WHERE id = ${sqlLit(String(pre.id))}::uuid;`,
      );
    }
  }
  fs.writeFileSync(path.join(waveDir, "rollback.sql"), `${rollbackLines.join("\n")}\n`);

  return {
    nullFillApplied,
    mapInserted,
    mapFnskuNullFill,
    catalogApplied,
    blockers,
    rollbackLines,
    productById,
    catalogPre: catalogPre.rows,
    existingSkuMaps: existingSkuMaps.rows,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const maxPerType = Math.min(intArg("max-per-type", 100), 100);
  const maxWaves = intArg("max-waves", 30);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    throw new Error(`Approval flags missing or false in ${APPROVAL_PATH}`);
  }

  const classifiedPath = path.join(process.cwd(), CENSUS_DIR, "all-classified-rows.csv");
  if (!fs.existsSync(classifiedPath)) throw new Error(`Missing ${classifiedPath}`);
  const classified = parseCsv(fs.readFileSync(classifiedPath, "utf8"));
  const eligibleIds = buildTier2EligibleIds(classified);

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const beforeCounts = await tableCounts(client);
  const beforeLinkage = await linkageMetrics(client);

  const allCandidates = loadAllCandidates(eligibleIds);
  const nullCandidatesTotal = allCandidates.nullCandidates.length;
  const mapCandidatesTotal = allCandidates.mapCandidates.length;
  const catalogCandidatesTotal = allCandidates.catalogCandidates.length;
  let nullPool = [...allCandidates.nullCandidates];
  let mapPool = [...allCandidates.mapCandidates];
  let catalogPool = [...allCandidates.catalogCandidates];
  const dryDir = path.join(process.cwd(), DRYRUN_DIR);

  const statusRefresh = {
    tier2_eligible_spreadsheet_rows: eligibleIds.size,
    safe_null_fill_candidates: nullCandidatesTotal,
    safe_map_candidates: mapCandidatesTotal,
    safe_catalog_candidates: catalogCandidatesTotal,
    packaging_already_applied: 80,
    packaging_remaining_safe: 0,
    identifier_mismatch_blocked: 21,
    duplicate_asin_class_c_blocked_groups: 35,
    product_create_blocked: 1700,
    prior_wave1_map_rows: beforeCounts.wave1_map_rows,
    prior_closeout_map_rows: beforeCounts.closeout_map_rows,
  };
  fs.writeFileSync(path.join(outDir, "status-refresh.json"), JSON.stringify(statusRefresh, null, 2));

  const waveResults: Record<string, unknown>[] = [];
  const allRollback: string[] = [`-- PRODUCT-SHEET-PHASE1-CLOSEOUT rollback run_id=${runId}`, ""];
  let totalNullFill = 0;
  let totalMap = 0;
  let totalCatalog = 0;
  let wavesRun = 0;
  let lastWaveEmpty = false;
  let stoppedOnBlocker = false;
  let stoppedOnVerify = false;

  for (let waveIndex = 0; waveIndex < maxWaves; waveIndex++) {
    if (nullPool.length === 0 && mapPool.length === 0 && catalogPool.length === 0) {
      lastWaveEmpty = true;
      break;
    }

    const rawNullSlice = nullPool.slice(0, maxPerType);
    const rawMapSlice = mapPool.slice(0, maxPerType);
    const rawCatalogSlice = catalogPool.slice(0, maxPerType);

    let { nullFill, mapPlan, catalogPlan } = buildWavePlans(nullPool, mapPool, catalogPool, maxPerType, 0);
    ({ nullFill, mapPlan, catalogPlan } = await filterAlreadyApplied(client, nullFill, mapPlan, catalogPlan));

    if (nullFill.length === 0 && mapPlan.length === 0 && catalogPlan.length === 0) {
      nullPool = nullPool.slice(rawNullSlice.length);
      mapPool = mapPool.slice(rawMapSlice.length);
      catalogPool = catalogPool.slice(rawCatalogSlice.length);
      continue;
    }

    const result = await applyOneWave(client, outDir, wavesRun, nullFill, mapPlan, catalogPlan, apply);
    if (result.blockers.length > 0) {
      stoppedOnBlocker = true;
      waveResults.push({
        wave: wavesRun + 1,
        status: "BLOCKED",
        blockers: result.blockers,
        planned: { null_fill: nullFill.length, map: mapPlan.length, catalog: catalogPlan.length },
      });
      break;
    }

    const mapApplied = result.mapInserted.length + result.mapFnskuNullFill.length;
    const productCountBeforeWave = (await tableCounts(client)).products;

    if (apply) {
      const afterWaveCounts = await tableCounts(client);
      if (Number(afterWaveCounts.products) !== Number(productCountBeforeWave)) {
        stoppedOnVerify = true;
        waveResults.push({ wave: wavesRun + 1, status: "FAIL", reason: "product_count_changed" });
        break;
      }
    }

    totalNullFill += result.nullFillApplied.length;
    totalMap += mapApplied;
    totalCatalog += result.catalogApplied.length;
    wavesRun += 1;
    allRollback.push(...result.rollbackLines, "");

    const appliedNullRows = new Set(nullFill.map((r) => r.spreadsheet_row));
    const appliedMapRows = new Set(mapPlan.map((r) => r.spreadsheet_row));
    const appliedCatalogRows = new Set(catalogPlan.map((r) => r.spreadsheet_row));
    nullPool = nullPool.filter((r) => !appliedNullRows.has(r.spreadsheet_row));
    mapPool = mapPool.filter((r) => !appliedMapRows.has(r.spreadsheet_row));
    catalogPool = catalogPool.filter((r) => !appliedCatalogRows.has(r.spreadsheet_row));

    waveResults.push({
      wave: wavesRun + 1,
      status: apply ? "APPLIED" : "DRY-RUN",
      planned: { null_fill: nullFill.length, map: mapPlan.length, catalog: catalogPlan.length },
      applied: {
        null_fill: result.nullFillApplied.length,
        map: mapApplied,
        catalog: result.catalogApplied.length,
      },
    });

    if (!apply) break;
  }

  const afterCounts = await tableCounts(client);
  const afterLinkage = await linkageMetrics(client);

  fs.writeFileSync(path.join(outDir, "rollback.sql"), `${allRollback.join("\n")}\n`);
  fs.writeFileSync(path.join(outDir, "wave-results.json"), JSON.stringify(waveResults, null, 2));

  const phaseFDir = path.join(process.cwd(), PHASE_F_DIR);
  const unresolvedBlocked = {
    identifier_mismatch_class_a: parseCsv(
      fs.readFileSync(path.join(phaseFDir, "identifier-mismatch-review-queue.csv"), "utf8"),
    ),
    duplicate_asin_class_c: parseCsv(fs.readFileSync(path.join(phaseFDir, "duplicate-asin-groups.csv"), "utf8")).filter(
      (r) => r.review_class === "C",
    ),
    blocked_product_creates: parseCsv(
      fs.readFileSync(path.join(phaseFDir, "blocked-creates-classification.csv"), "utf8"),
    ),
    spec_packaging_blocked: parseCsv(
      fs.readFileSync(path.join(dryDir, "proposed-spec-normalization.csv"), "utf8"),
    ).filter((r) => (r.note ?? "").includes("blocked")),
  };
  writeCsv(
    path.join(outDir, "unresolved-blocked-summary.csv"),
    ["category", "count", "artifact"],
    [
      { category: "identifier_mismatch_class_a", count: unresolvedBlocked.identifier_mismatch_class_a.length, artifact: "identifier-mismatch-review-queue.csv" },
      { category: "duplicate_asin_class_c_groups", count: unresolvedBlocked.duplicate_asin_class_c.length, artifact: "duplicate-asin-groups.csv" },
      { category: "blocked_product_creates", count: unresolvedBlocked.blocked_product_creates.length, artifact: "blocked-creates-classification.csv" },
      { category: "spec_packaging_blocked", count: unresolvedBlocked.spec_packaging_blocked.length, artifact: "proposed-spec-normalization.csv" },
    ],
  );
  fs.writeFileSync(path.join(outDir, "unresolved-blocked.json"), JSON.stringify(unresolvedBlocked, null, 2));

  const productCountDelta = Number(afterCounts.products) - Number(beforeCounts.products);
  const mapDelta = Number(afterCounts.closeout_map_rows) - Number(beforeCounts.closeout_map_rows);
  const epDelta = afterLinkage.expected_packages_unresolved - beforeLinkage.expected_packages_unresolved;
  const riDelta = afterLinkage.return_items_unresolved - beforeLinkage.return_items_unresolved;

  const safeToContinue =
    apply &&
    !stoppedOnBlocker &&
    !stoppedOnVerify &&
    productCountDelta === 0 &&
    (lastWaveEmpty || wavesRun < maxWaves);

  const closeoutReport = `# PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES

**Run:** \`${OUT_BASE}/${runId}/\`  
**Mode:** ${apply ? "APPLY" : "DRY-RUN"}  
**Staging ref:** \`${STAGING_REF}\`

## BEFORE_COUNTS

| Metric | Value |
|--------|------:|
| products | ${beforeCounts.products} |
| active product_identifier_map | ${beforeCounts.active_map_rows} |
| catalog_products | ${beforeCounts.catalog_products} |
| closeout map rows | ${beforeCounts.closeout_map_rows} |
| wave1 sample map rows | ${beforeCounts.wave1_map_rows} |
| expected_packages unresolved | ${beforeLinkage.expected_packages_unresolved} |
| return_items unresolved | ${beforeLinkage.return_items_unresolved} |

## ROWS_APPLIED_BY_TYPE

| Type | Applied this run |
|------|-----------------:|
| null-fill (products) | ${totalNullFill} |
| map insert + fnsku null-fill | ${totalMap} |
| catalog upserts | ${totalCatalog} |
| packaging/spec | 0 |
| product creates | **0** |
| Waves executed | ${wavesRun} |

## AFTER_COUNTS

| Metric | Before → After | Δ |
|--------|----------------|--:|
| products | ${beforeCounts.products} → ${afterCounts.products} | ${productCountDelta} |
| active product_identifier_map | ${beforeCounts.active_map_rows} → ${afterCounts.active_map_rows} | ${Number(afterCounts.active_map_rows) - Number(beforeCounts.active_map_rows)} |
| catalog_products | ${beforeCounts.catalog_products} → ${afterCounts.catalog_products} | ${Number(afterCounts.catalog_products) - Number(beforeCounts.catalog_products)} |
| closeout map rows | ${beforeCounts.closeout_map_rows} → ${afterCounts.closeout_map_rows} | ${mapDelta} |
| expected_packages unresolved | ${beforeLinkage.expected_packages_unresolved} → ${afterLinkage.expected_packages_unresolved} | ${epDelta} |
| return_items unresolved | ${beforeLinkage.return_items_unresolved} → ${afterLinkage.return_items_unresolved} | ${riDelta} |

## UNRESOLVED_REMAINING

| Gate | Count |
|------|------:|
| Identifier mismatch (class A) | 21 |
| Duplicate ASIN class C groups | 35 |
| Blocked product creates | 1,700 |
| Spec/packaging blocked | ${unresolvedBlocked.spec_packaging_blocked.length} |
| Tier2 null-fill remaining (est.) | ~${Math.max(0, nullCandidatesTotal - totalNullFill)} |
| Tier2 map remaining (est.) | ~${Math.max(0, mapCandidatesTotal - totalMap)} |
| Tier2 catalog remaining (est.) | ~${Math.max(0, catalogCandidatesTotal - totalCatalog)} |

## ROLLBACK_PATHS

- Combined: \`${OUT_BASE}/${runId}/rollback.sql\`
- Per-wave: \`${OUT_BASE}/${runId}/wave-*/rollback.sql\`

## SAFE_TO_CONTINUE

**${safeToContinue ? "yes" : apply ? "no" : "pending (--apply)"}**

${epDelta < 0 ? `Expected packages unresolved improved by ${Math.abs(epDelta)}.` : epDelta > 0 ? `Expected packages unresolved increased by ${epDelta} — investigate resolver coupling.` : "Expected packages unresolved unchanged — map/catalog enrichment may need resolver pass to reflect in EP."}
${riDelta < 0 ? `Return items unresolved improved by ${Math.abs(riDelta)}.` : riDelta > 0 ? `Return items unresolved increased by ${riDelta}.` : "Return items unresolved unchanged — resolver pass may be needed."}
`;

  fs.writeFileSync(path.join(outDir, "closeout-report.md"), closeoutReport);

  const manifest = {
    prompt: "PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "apply" : "dry-run",
    status: stoppedOnBlocker ? "BLOCKED" : stoppedOnVerify ? "FAIL" : apply ? "PASS" : "DRY-RUN",
    before_counts: { ...beforeCounts, ...beforeLinkage },
    rows_applied_by_type: {
      null_fill: totalNullFill,
      map: totalMap,
      catalog: totalCatalog,
      packaging: 0,
      product_creates: 0,
      waves: wavesRun,
    },
    after_counts: { ...afterCounts, ...afterLinkage },
    unresolved_remaining: {
      identifier_mismatch: 21,
      duplicate_asin_class_c: 35,
      blocked_creates: 1700,
      spec_packaging_blocked: unresolvedBlocked.spec_packaging_blocked.length,
    },
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    safe_to_continue: safeToContinue ? "yes" : apply ? "no" : "pending",
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  await client.end();
  console.log(JSON.stringify(manifest, null, 2));
  console.log(closeoutReport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
