/**
 * PRODUCT-SHEET-STAGING-APPLY-WAVE1-SAMPLE
 *   npx tsx scripts/product-sheet-staging-apply-wave1-sample.ts --run-id=<UTC>
 *   npx tsx scripts/product-sheet-staging-apply-wave1-sample.ts --run-id=<UTC> --apply
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
const PLAN_DIR = `.cursor/audit-reports/product-sheet-phase-f-resolve-readonly/${PHASE_F_RUN_ID}`;
const APPROVAL_PATH = ".cursor/operator-approvals/product-sheet-staging-apply-wave1-sample-approval.md";
const OUT_BASE = ".cursor/audit-reports/product-sheet-staging-apply-wave1-sample";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MATCH_SOURCE = "product_sheet_wave1_sample";
const SOURCE_REPORT_TYPE = "spreadsheet_product_sheet";

const MAX_NULL_FILL = 25;
const MAX_MAP = 25;
const MAX_CATALOG = 25;
const MAX_PACKAGING = 0;

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

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function readApproval(): boolean {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_SHEET_PHASE_F_SAMPLE_WAVE\s*=\s*true/i.test(text) &&
    /APPROVED_NULL_FILL_ONLY\s*=\s*true/i.test(text) &&
    /APPROVED_MAP_INSERT_MAX_25\s*=\s*true/i.test(text) &&
    /APPROVED_CATALOG_UPSERT_MAX_25\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_INSERT\s*=\s*false/i.test(text) &&
    new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)
  );
}

function loadNullFill(): NullFillRow[] {
  const rows = parseCsv(fs.readFileSync(path.join(process.cwd(), PLAN_DIR, "sample-wave-null-fill.csv"), "utf8"));
  if (rows.length > MAX_NULL_FILL) {
    throw new Error(`Null-fill sample exceeds max ${MAX_NULL_FILL}: ${rows.length}`);
  }
  return rows.map((r) => ({
    spreadsheet_row: r.spreadsheet_row,
    seller_sku: r.seller_sku,
    product_id: r.product_id,
    patch_asin: r.patch_asin_if_null?.trim() || null,
    patch_fnsku: r.patch_fnsku_if_null?.trim() || null,
  }));
}

function loadMapInserts(): MapInsertRow[] {
  const rows = parseCsv(fs.readFileSync(path.join(process.cwd(), PLAN_DIR, "sample-wave-map-inserts.csv"), "utf8"));
  const seen = new Set<string>();
  const out: MapInsertRow[] = [];
  for (const r of rows) {
    const key = `${r.product_id}|${r.identifier_type}|${r.identifier_value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      spreadsheet_row: r.spreadsheet_row,
      product_id: r.product_id,
      seller_sku: r.seller_sku,
      identifier_type: r.identifier_type,
      identifier_value: r.identifier_value,
      external_listing_id: `product_sheet_wave1_sample:row:${r.spreadsheet_row}:${r.identifier_type}:${r.identifier_value}`,
    });
    if (out.length >= MAX_MAP) break;
  }
  if (out.length > MAX_MAP) {
    throw new Error(`Map insert sample exceeds max ${MAX_MAP}: ${out.length}`);
  }
  return out;
}

function loadCatalog(): CatalogRow[] {
  const rows = parseCsv(
    fs.readFileSync(path.join(process.cwd(), PLAN_DIR, "sample-wave-catalog-upserts.csv"), "utf8"),
  );
  if (rows.length > MAX_CATALOG) {
    throw new Error(`Catalog sample exceeds max ${MAX_CATALOG}: ${rows.length}`);
  }
  return rows.map((r) => ({
    spreadsheet_row: r.spreadsheet_row,
    seller_sku: r.seller_sku,
    sheet_asin: r.sheet_asin,
    sheet_fnsku: r.sheet_fnsku,
    fulfillment_channel: r.fulfillment_channel || "fba",
  }));
}

async function tableCounts(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.catalog_products) AS catalog_products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map
        WHERE match_source = $1 AND deleted_at IS NULL) AS wave1_map_rows
  `, [MATCH_SOURCE]);
  return r.rows[0] as Record<string, number>;
}

async function verifySampleLinkage(
  client: pg.Client,
  sampleSkus: string[],
  sampleFnskus: string[],
): Promise<{ pass: boolean; rows: Record<string, unknown>[] }> {
  const r = await client.query(
    `
    WITH sample AS (
      SELECT unnest($1::text[]) AS seller_sku
      UNION
      SELECT unnest($2::text[]) AS seller_sku
    ),
    map_res AS (
      SELECT
        s.seller_sku,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        MIN(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS resolved_product_id
      FROM sample s
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = $3::uuid
       AND m.store_id = $4::uuid
       AND m.deleted_at IS NULL
       AND (
         m.seller_sku = s.seller_sku
         OR m.fnsku = s.seller_sku
       )
      GROUP BY s.seller_sku
    )
    SELECT * FROM map_res ORDER BY seller_sku
    `,
    [sampleSkus, sampleFnskus, ORG, STORE],
  );
  const rows = r.rows as Record<string, unknown>[];
  const pass = rows.every((row) => Number(row.product_count) <= 1);
  return { pass, rows };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    throw new Error(`Approval flags missing or false in ${APPROVAL_PATH}`);
  }

  for (const f of ["sample-wave-null-fill.csv", "sample-wave-map-inserts.csv", "sample-wave-catalog-upserts.csv"]) {
    const p = path.join(process.cwd(), PLAN_DIR, f);
    if (!fs.existsSync(p)) throw new Error(`Missing Phase F sample file: ${p}`);
  }

  const nullFill = loadNullFill();
  const mapPlan = loadMapInserts();
  const catalogPlan = loadCatalog();

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
  await client.query("SET statement_timeout = '180s'");

  const beforeCounts = await tableCounts(client);

  const productIds = [...new Set([...nullFill.map((r) => r.product_id), ...mapPlan.map((r) => r.product_id)])];
  const productPre = await client.query(
    `SELECT id::text, asin, fnsku, product_name, sku FROM public.products WHERE id = ANY($1::uuid[])`,
    [productIds],
  );
  const productById = new Map(productPre.rows.map((r) => [r.id as string, r]));

  const nullFillConflicts = await client.query(
    `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        product_id uuid,
        patch_asin text,
        patch_fnsku text
      )
    )
    SELECT
      i.product_id::text,
      'asin_conflict'::text AS conflict_type,
      p.id::text AS other_product_id,
      p.asin
    FROM input i
    JOIN public.products p
      ON p.asin IS NOT NULL
     AND btrim(p.asin) = btrim(i.patch_asin)
     AND p.id <> i.product_id
    WHERE i.patch_asin IS NOT NULL
    UNION ALL
    SELECT
      i.product_id::text,
      'fnsku_conflict'::text,
      p.id::text,
      p.fnsku
    FROM input i
    JOIN public.products p
      ON p.fnsku IS NOT NULL
     AND btrim(p.fnsku) = btrim(i.patch_fnsku)
     AND p.id <> i.product_id
    WHERE i.patch_fnsku IS NOT NULL
    `,
    [
      JSON.stringify(
        nullFill.map((r) => ({
          product_id: r.product_id,
          patch_asin: r.patch_asin,
          patch_fnsku: r.patch_fnsku,
        })),
      ),
    ],
  );

  const mapPayload = mapPlan.map((r) => ({
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
        organization_id uuid,
        store_id uuid,
        product_id uuid,
        seller_sku text,
        fnsku text,
        external_listing_id text
      )
    )
    SELECT
      i.external_listing_id,
      i.product_id::text AS planned_product_id,
      m.id::text AS existing_map_id,
      m.product_id::text AS existing_product_id,
      m.seller_sku,
      m.fnsku,
      'seller_sku_mismatch'::text AS conflict_type
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id
     AND m.store_id = i.store_id
     AND m.deleted_at IS NULL
     AND m.seller_sku IS NOT DISTINCT FROM i.seller_sku
    WHERE m.product_id IS DISTINCT FROM i.product_id
    UNION ALL
    SELECT
      i.external_listing_id,
      i.product_id::text,
      m.id::text,
      m.product_id::text,
      m.seller_sku,
      m.fnsku,
      'fnsku_mismatch'::text
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id
     AND m.store_id = i.store_id
     AND m.deleted_at IS NULL
     AND i.fnsku IS NOT NULL
     AND m.fnsku IS NOT DISTINCT FROM i.fnsku
    WHERE m.product_id IS DISTINCT FROM i.product_id
    `,
    [JSON.stringify(mapPayload)],
  );

  const preExistingMaps = await client.query(
    `SELECT id::text, product_id::text, seller_sku, fnsku, external_listing_id
     FROM public.product_identifier_map
     WHERE external_listing_id = ANY($1::text[])`,
    [mapPlan.map((r) => r.external_listing_id)],
  );

  const existingSkuMaps = await client.query(
    `
    WITH input AS (
      SELECT unnest($1::text[]) AS seller_sku
    )
    SELECT m.id::text, m.product_id::text, m.seller_sku, m.fnsku, m.external_listing_id
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = $2::uuid
     AND m.store_id = $3::uuid
     AND m.deleted_at IS NULL
     AND m.seller_sku = i.seller_sku
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
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        organization_id uuid,
        store_id uuid,
        seller_sku text,
        asin text
      )
    )
    SELECT c.id::text, c.seller_sku, c.asin, c.fnsku, c.fulfillment_channel, c.source_report_type
    FROM input i
    JOIN public.catalog_products c
      ON c.organization_id = i.organization_id
     AND c.store_id = i.store_id
     AND c.seller_sku = i.seller_sku
     AND c.asin = i.asin
    `,
    [JSON.stringify(catalogKeys)],
  );

  const preimage = {
    before_counts: beforeCounts,
    null_fill_products: productPre.rows,
    map_conflicts: mapConflicts.rows,
    null_fill_conflicts: nullFillConflicts.rows,
    pre_existing_maps: preExistingMaps.rows,
    existing_seller_sku_maps: existingSkuMaps.rows,
    catalog_pre: catalogPre.rows,
    plan_counts: {
      null_fill: nullFill.length,
      map_inserts: mapPlan.length,
      catalog_upserts: catalogPlan.length,
      packaging: MAX_PACKAGING,
    },
  };
  fs.writeFileSync(path.join(outDir, "preimage.json"), JSON.stringify(preimage, null, 2));

  const blockers: string[] = [];
  if (nullFillConflicts.rows.length > 0) {
    blockers.push(`${nullFillConflicts.rows.length} null-fill identifier conflicts on other products`);
  }
  if (mapConflicts.rows.length > 0) {
    blockers.push(`${mapConflicts.rows.length} map insert conflicts with existing active map rows`);
  }
  for (const pid of productIds) {
    if (!productById.has(pid)) blockers.push(`Missing product_id ${pid}`);
  }

  if (blockers.length > 0) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`,
    );
    await client.end();
    throw new Error(`Pre-flight blockers: ${blockers.join("; ")}`);
  }

  const insertableMaps = mapPayload.filter((row) => {
    if (preExistingMaps.rows.some((r) => r.external_listing_id === row.external_listing_id)) {
      return false;
    }
    const skuHit = existingSkuMaps.rows.find((r) => r.seller_sku === row.seller_sku);
    if (skuHit) return false;
    return true;
  });

  const skippedExistingSkuMaps = mapPayload.filter((row) =>
    existingSkuMaps.rows.some((r) => r.seller_sku === row.seller_sku),
  );

  let nullFillApplied: Record<string, unknown>[] = [];
  let mapInserted: Record<string, unknown>[] = [];
  let catalogApplied: { seller_sku: string; asin: string; catalog_id: string | null; action: string }[] = [];

  if (apply) {
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
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(
              organization_id uuid,
              store_id uuid,
              product_id uuid,
              seller_sku text,
              msku text,
              fnsku text,
              match_source text,
              source_report_type text,
              external_listing_id text
            )
          ),
          inserted AS (
            INSERT INTO public.product_identifier_map (
              organization_id,
              store_id,
              product_id,
              seller_sku,
              msku,
              fnsku,
              match_source,
              source_report_type,
              external_listing_id,
              is_primary,
              first_seen_at,
              last_seen_at,
              created_at,
              updated_at
            )
            SELECT
              i.organization_id,
              i.store_id,
              i.product_id,
              i.seller_sku,
              i.msku,
              i.fnsku,
              i.match_source,
              i.source_report_type,
              i.external_listing_id,
              true,
              now(),
              now(),
              now(),
              now()
            FROM input i
            WHERE NOT EXISTS (
              SELECT 1 FROM public.product_identifier_map m
              WHERE m.external_listing_id = i.external_listing_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.product_identifier_map m
              WHERE m.organization_id = i.organization_id
                AND m.store_id = i.store_id
                AND m.deleted_at IS NULL
                AND m.seller_sku IS NOT DISTINCT FROM i.seller_sku
            )
            RETURNING id::text, product_id::text, seller_sku, fnsku, external_listing_id
          )
          SELECT * FROM inserted
          `,
          [JSON.stringify(insertableMaps)],
        );
        mapInserted = ins.rows;
      }

      for (const row of catalogPlan) {
        const existed = catalogPre.rows.some(
          (r) => r.seller_sku === row.seller_sku && r.asin === row.sheet_asin,
        );
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

  const afterCounts = await tableCounts(client);

  const idStable = nullFillApplied.every((r) => {
    const after = r.after as { id?: string } | undefined;
    return after?.id === (r as { product_id: string }).product_id;
  });

  const duplicateMaps = await client.query(
    `
    SELECT external_listing_id, COUNT(*)::int AS c
    FROM public.product_identifier_map
    WHERE match_source = $1
    GROUP BY external_listing_id
    HAVING COUNT(*) > 1
    `,
    [MATCH_SOURCE],
  );

  const sampleSkus = [
    ...new Set([
      ...nullFill.map((r) => r.seller_sku),
      ...mapPlan.map((r) => r.seller_sku),
      ...catalogPlan.map((r) => r.seller_sku),
    ]),
  ];
  const sampleFnskus = [...new Set(mapPlan.map((r) => r.identifier_value))];
  const linkage = await verifySampleLinkage(client, sampleSkus, sampleFnskus);

  const productCountDelta = Number(afterCounts.products) - Number(beforeCounts.products);
  const verification = {
    before_after_counts: { before: beforeCounts, after: afterCounts },
    product_count_unchanged: productCountDelta === 0,
    canonical_id_stable: idStable || nullFillApplied.length === 0,
    no_duplicate_wave1_maps: duplicateMaps.rows.length === 0,
    sample_linkage_check: linkage,
    rows_applied: {
      null_fill: nullFillApplied.length,
      map_inserts: mapInserted.length,
      catalog_upserts: catalogApplied.length,
      packaging: 0,
    },
    skipped_existing_maps: preExistingMaps.rows.length,
  };
  const allPass =
    apply &&
    verification.product_count_unchanged &&
    verification.canonical_id_stable &&
    verification.no_duplicate_wave1_maps &&
    linkage.pass;

  await client.end();

  const rollbackLines: string[] = [
    "-- Rollback PRODUCT-SHEET-STAGING-APPLY-WAVE1-SAMPLE",
    `-- run_id: ${runId}`,
    "",
  ];
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
  for (const row of catalogApplied) {
    const pre = catalogPre.rows.find(
      (r) => r.seller_sku === row.seller_sku && r.asin === row.asin,
    );
    if (!pre && row.action === "inserted" && row.catalog_id) {
      rollbackLines.push(`DELETE FROM public.catalog_products WHERE id = ${sqlLit(row.catalog_id)}::uuid;`);
    } else if (pre) {
      rollbackLines.push(
        `UPDATE public.catalog_products SET fnsku = ${pre.fnsku == null ? "NULL" : sqlLit(String(pre.fnsku))}, fulfillment_channel = ${pre.fulfillment_channel == null ? "NULL" : sqlLit(String(pre.fulfillment_channel))}, source_report_type = ${pre.source_report_type == null ? "NULL" : sqlLit(String(pre.source_report_type))} WHERE id = ${sqlLit(String(pre.id))}::uuid;`,
      );
    }
  }
  fs.writeFileSync(path.join(outDir, "rollback.sql"), `${rollbackLines.join("\n")}\n`);

  fs.writeFileSync(path.join(outDir, "null-fill-applied.json"), JSON.stringify(nullFillApplied, null, 2));
  fs.writeFileSync(path.join(outDir, "map-inserted.json"), JSON.stringify(mapInserted, null, 2));
  fs.writeFileSync(
    path.join(outDir, "skipped-existing-seller-sku.json"),
    JSON.stringify(skippedExistingSkuMaps, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "catalog-applied.json"), JSON.stringify(catalogApplied, null, 2));
  fs.writeFileSync(path.join(outDir, "verification.json"), JSON.stringify(verification, null, 2));

  const wave2Safe =
    allPass &&
    blockers.length === 0 &&
    "Wave2 may proceed with the same guardrails at larger batch size (tier2 conflict-free rows from Phase F), but still no broad apply, no product creates, and no class A/C/D/E rows until separately approved.";

  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Product sheet staging apply wave1 sample",
      "",
      `- Mode: **${apply ? "APPLY" : "DRY-RUN (pass --apply to write)"}**`,
      `- Phase F plan: \`${PLAN_DIR}\``,
      `- Null-fill applied: **${nullFillApplied.length}** / ${nullFill.length}`,
      `- Map inserts: **${mapInserted.length}** / ${mapPlan.length} (${preExistingMaps.rows.length} external_listing_id skipped, ${skippedExistingSkuMaps.length} seller_sku already mapped)`,
      `- Catalog upserts: **${catalogApplied.length}** / ${catalogPlan.length}`,
      `- Packaging: **0** (no conflict-free sample rows)`,
      "",
      "## Verification",
      "",
      `- Product count unchanged: ${verification.product_count_unchanged ? "PASS" : "FAIL"} (${beforeCounts.products} → ${afterCounts.products})`,
      `- Canonical product ids stable: ${verification.canonical_id_stable ? "PASS" : "FAIL"}`,
      `- No duplicate wave1 map rows: ${verification.no_duplicate_wave1_maps ? "PASS" : "FAIL"}`,
      `- Sample linkage check: ${linkage.pass ? "PASS" : "FAIL"}`,
      `- Overall: **${allPass ? "PASS" : apply ? "FAIL" : "PENDING (--apply)"}**`,
      "",
      "## Rollback",
      "",
      `- \`rollback.sql\` in this folder`,
      "",
      "## Wave2",
      "",
      typeof wave2Safe === "string" ? wave2Safe : wave2Safe ? "Safe to plan wave2 with same caps and Phase F filters." : "Not safe until wave1 verification passes.",
    ].join("\n"),
  );

  const manifest = {
    prompt: "PRODUCT-SHEET-STAGING-APPLY-WAVE1-SAMPLE",
    run_id: runId,
    staging_ref: STAGING_REF,
    phase_f_run_id: PHASE_F_RUN_ID,
    mode: apply ? "apply" : "dry-run",
    status: allPass ? "PASS" : apply ? "FAIL" : "DRY-RUN",
    approval_path: APPROVAL_PATH,
    rows_applied: verification.rows_applied,
    verification_pass: allPass,
    wave2_safe: Boolean(allPass),
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    forbidden_writes: {
      products_created: false,
      product_name_overwrite: false,
      production_touched: false,
      original_touched: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
