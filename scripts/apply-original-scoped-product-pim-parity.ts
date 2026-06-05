/**
 * APPLY_ORIGINAL_PRODUCT_PIM_PARITY_SCOPED_FIRST
 * Products + product_identifier_map + vendor/category refs only. No scanner/claim row deletes.
 *
 *   npx tsx scripts/apply-original-scoped-product-pim-parity.ts           # audit
 *   APPROVED_TO_APPLY_SCOPED_PRODUCT_PIM_PARITY=true npx tsx scripts/apply-original-scoped-product-pim-parity.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const AUDIT_PACK = ".cursor/audit-reports/full-original-parity/20260605T044211Z";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromPgUrl(url: string): string | null {
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? refFromSupabaseUrl(url);
}

async function cols(c: pg.Client, table: string): Promise<string[]> {
  const r = await c.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}

async function intersectCols(stag: pg.Client, orig: pg.Client, table: string): Promise<string[]> {
  const s = await cols(stag, table);
  const o = new Set(await cols(orig, table));
  return s.filter((x) => o.has(x));
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${table}`]);
  return Boolean(r.rows[0]?.e);
}

/** Demo scope: active staging return_items only (matches original-demo-data-parity-census). */
async function discoverProductIds(stag: pg.Client): Promise<string[]> {
  const r = await stag.query<{ product_id: string }>(
    `SELECT DISTINCT pid::text AS product_id
     FROM (
       SELECT resolved_product_id AS pid FROM return_items
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND resolved_product_id IS NOT NULL
       UNION ALL
       SELECT product_id AS pid FROM return_items
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND product_id IS NOT NULL
     ) s
     WHERE pid IS NOT NULL`,
    [ORG_ID],
  );
  return [...new Set(r.rows.map((x) => x.product_id))];
}

type MapRow = Record<string, unknown>;

async function stagingMapRows(stag: pg.Client, productIds: string[]): Promise<MapRow[]> {
  if (!productIds.length) return [];
  const r = await stag.query(
    `SELECT * FROM product_identifier_map
     WHERE organization_id = $1::uuid AND product_id = ANY($2::uuid[])
     ORDER BY id`,
    [ORG_ID, productIds],
  );
  return r.rows as MapRow[];
}

async function upsertById(
  stag: pg.Client,
  orig: pg.Client,
  table: string,
  ids: string[],
  stats: { inserted: number; updated: number; skipped: number },
): Promise<void> {
  if (!ids.length) return;
  const useCols = await intersectCols(stag, orig, table);
  if (!useCols.includes("id")) throw new Error(`${table}: no id column`);
  const colList = useCols.map((c) => `"${c}"`).join(", ");
  const ph = useCols.map((_, i) => `$${i + 1}`).join(", ");
  const updates = useCols.filter((c) => c !== "id").map((c) => `"${c}"=EXCLUDED."${c}"`).join(", ");

  for (const id of ids) {
    const src = await stag.query(`SELECT ${colList} FROM public.${table} WHERE id=$1::uuid`, [id]);
    if (!src.rows.length) {
      stats.skipped += 1;
      continue;
    }
    const exists = await orig.query(`SELECT 1 FROM public.${table} WHERE id=$1::uuid`, [id]);
    const vals = useCols.map((c) => (src.rows[0] as Record<string, unknown>)[c]);
    await orig.query(
      `INSERT INTO public.${table} (${colList}) VALUES (${ph})
       ON CONFLICT (id) DO UPDATE SET ${updates}`,
      vals,
    );
    if (exists.rows.length) stats.updated += 1;
    else stats.inserted += 1;
  }
}

async function fkExists(orig: pg.Client, table: string, id: unknown): Promise<boolean> {
  if (!id || !(await tableExists(orig, table))) return false;
  const r = await orig.query(`SELECT 1 FROM public.${table} WHERE id=$1::uuid`, [id]);
  return r.rows.length > 0;
}

async function detectMapConflicts(
  orig: pg.Client,
  stagingMaps: MapRow[],
  productIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const conflicts: Array<Record<string, unknown>> = [];
  for (const row of stagingMaps) {
    const id = String(row.id);
    const pid = String(row.product_id);
    const org = row.organization_id;
    const store = row.store_id;
    const ext = row.external_listing_id;
    if (ext) {
      const dup = await orig.query(
        `SELECT id::text, product_id::text FROM product_identifier_map
         WHERE organization_id=$1 AND store_id IS NOT DISTINCT FROM $2
           AND external_listing_id=$3 AND id <> $4::uuid`,
        [org, store, ext, id],
      );
      for (const d of dup.rows) {
        conflicts.push({
          type: "external_listing_id",
          staging_map_id: id,
          staging_product_id: pid,
          original_map_id: d.id,
          original_product_id: d.product_id,
          in_scope: productIds.includes(d.product_id as string),
        });
      }
    }
    for (const key of ["fnsku", "seller_sku", "asin"] as const) {
      const val = row[key];
      if (!val) continue;
      const dup = await orig.query(
        `SELECT id::text, product_id::text FROM product_identifier_map
         WHERE organization_id=$1 AND ${key}=$2 AND id <> $3::uuid`,
        [org, val, id],
      );
      for (const d of dup.rows) {
        conflicts.push({
          type: key,
          value: val,
          staging_map_id: id,
          staging_product_id: pid,
          original_map_id: d.id,
          original_product_id: d.product_id,
          in_scope: productIds.includes(d.product_id as string),
        });
      }
    }
  }
  return conflicts;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const approved = process.env.APPROVED_TO_APPLY_SCOPED_PRODUCT_PIM_PARITY?.trim().toLowerCase() === "true";
  const rid = runId();
  const outDir = path.join(process.cwd(), AUDIT_PACK, `apply-scoped-product-pim-${rid}`);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (refFromPgUrl(stagingUrl) !== STAGING_REF) throw new Error("staging ref mismatch");
  if (refFromPgUrl(originalUrl) !== ORIGINAL_REF) throw new Error("original ref mismatch");

  const stag = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  const orig = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  await stag.connect();
  await orig.connect();

  const productIds = await discoverProductIds(stag);
  const stagingProducts = productIds.length
    ? (
        await stag.query(`SELECT * FROM products WHERE id = ANY($1::uuid[]) ORDER BY id`, [productIds])
      ).rows
    : [];
  const stagingMaps = await stagingMapRows(stag, productIds);

  const vendorIds = [
    ...new Set(stagingProducts.map((p) => p.vendor_id).filter(Boolean) as string[]),
  ];
  const categoryIds = [
    ...new Set(stagingProducts.map((p) => p.category_id).filter(Boolean) as string[]),
  ];

  const originalProductsBefore = productIds.length
    ? (await orig.query(`SELECT * FROM products WHERE id = ANY($1::uuid[])`, [productIds])).rows
    : [];
  const originalMapsBefore = productIds.length
    ? (
        await orig.query(
          `SELECT * FROM product_identifier_map WHERE organization_id=$1::uuid AND product_id = ANY($2::uuid[])`,
          [ORG_ID, productIds],
        )
      ).rows
    : [];

  const conflictsBefore = await detectMapConflicts(orig, stagingMaps, productIds);

  const audit = {
    run_id: rid,
    apply,
    approved,
    product_ids: productIds,
    staging_products: stagingProducts,
    staging_map_rows: stagingMaps,
    original_products_before: originalProductsBefore,
    original_maps_before: originalMapsBefore,
    vendor_ids: vendorIds,
    category_ids: categoryIds,
    conflicts_before: conflictsBefore,
  };
  fs.writeFileSync(path.join(outDir, "00_pre_apply_audit.json"), JSON.stringify(audit, null, 2));

  const report: Record<string, unknown> = {
    products_copied: 0,
    product_identifier_map_rows_copied: 0,
    vendors_copied: 0,
    categories_copied: 0,
    conflicts_found: conflictsBefore.length,
    conflicts_resolved: 0,
    conflicts_skipped: 0,
    remaining_product_gap: null as number | null,
    SAFE_TO_TEST_PRODUCT_LINKAGE_ON_ORIGINAL: "no",
  };

  if (!apply) {
    const stagMapCount = Number(
      (await stag.query(`SELECT count(*)::bigint c FROM product_identifier_map WHERE organization_id=$1`, [ORG_ID]))
        .rows[0]?.c ?? 0,
    );
    const origMapCount = Number(
      (await orig.query(`SELECT count(*)::bigint c FROM product_identifier_map WHERE organization_id=$1`, [ORG_ID]))
        .rows[0]?.c ?? 0,
    );
    report.remaining_product_gap = stagMapCount - origMapCount;
    fs.writeFileSync(path.join(outDir, "dry_run_result.json"), JSON.stringify({ ...report, audit_summary: {
      product_ids: productIds,
      map_rows_to_copy: stagingMaps.length,
      products_to_copy: stagingProducts.length,
    }}, null, 2));
    console.log(JSON.stringify({ ok: true, dry_run: true, outDir, product_ids: productIds, map_rows: stagingMaps.length, conflicts: conflictsBefore.length }, null, 2));
    await stag.end();
    await orig.end();
    return;
  }

  if (!approved) throw new Error("APPROVED_TO_APPLY_SCOPED_PRODUCT_PIM_PARITY=true required");

  const bk = rid.replace(/[^0-9A-Za-z]/g, "");
  const productStats = { inserted: 0, updated: 0, skipped: 0 };
  const mapStats = { inserted: 0, updated: 0, skipped: 0 };
  const vendorStats = { inserted: 0, updated: 0, skipped: 0 };
  const categoryStats = { inserted: 0, updated: 0, skipped: 0 };
  let conflictsResolved = 0;
  let conflictsSkipped = 0;

  try {
    await orig.query("BEGIN");

    if (productIds.length) {
      await orig.query(`DROP TABLE IF EXISTS public._backup_scoped_pim_products_${bk}`);
      await orig.query(
        `CREATE TABLE public._backup_scoped_pim_products_${bk} AS
         SELECT * FROM products WHERE id = ANY($1::uuid[])`,
        [productIds],
      );
      await orig.query(`DROP TABLE IF EXISTS public._backup_scoped_pim_map_${bk}`);
      await orig.query(
        `CREATE TABLE public._backup_scoped_pim_map_${bk} AS
         SELECT * FROM product_identifier_map
         WHERE organization_id = $1::uuid AND product_id = ANY($2::uuid[])`,
        [ORG_ID, productIds],
      );
    }

    // Vendors / categories first (FK)
    if (vendorIds.length && (await tableExists(stag, "vendors"))) {
      await upsertById(stag, orig, "vendors", vendorIds, vendorStats);
    }
    if (categoryIds.length && (await tableExists(stag, "product_categories"))) {
      await upsertById(stag, orig, "product_categories", categoryIds, categoryStats);
    }

    await upsertById(stag, orig, "products", productIds, productStats);

    // Map rows: upsert by id; resolve safe conflicts (original row points to same scoped product)
    const mapIds = stagingMaps.map((r) => String(r.id));
    for (const row of stagingMaps) {
      const id = String(row.id);
      const relatedConflicts = conflictsBefore.filter((c) => c.staging_map_id === id);
      let blocked = false;
      for (const c of relatedConflicts) {
        if (c.in_scope && c.original_product_id === c.staging_product_id) {
          conflictsResolved += 1;
        } else if (!c.in_scope) {
          blocked = true;
          conflictsSkipped += 1;
        }
      }
      if (blocked) {
        mapStats.skipped += 1;
        continue;
      }
      const useCols = await intersectCols(stag, orig, "product_identifier_map");
      const colList = useCols.map((c) => `"${c}"`).join(", ");
      const ph = useCols.map((_, i) => `$${i + 1}`).join(", ");
      const updates = useCols.filter((c) => c !== "id").map((c) => `"${c}"=EXCLUDED."${c}"`).join(", ");
      const exists = await orig.query(`SELECT 1 FROM product_identifier_map WHERE id=$1::uuid`, [id]);
      const vals = useCols.map((c) => row[c]);
      await orig.query(
        `INSERT INTO product_identifier_map (${colList}) VALUES (${ph})
         ON CONFLICT (id) DO UPDATE SET ${updates}`,
        vals,
      );
      if (exists.rows.length) mapStats.updated += 1;
      else mapStats.inserted += 1;
    }

    await orig.query("COMMIT");
  } catch (e) {
    await orig.query("ROLLBACK");
    throw e;
  }

  report.products_copied = productStats.inserted + productStats.updated;
  report.product_identifier_map_rows_copied = mapStats.inserted + mapStats.updated;
  report.vendors_copied = vendorStats.inserted + vendorStats.updated;
  report.categories_copied = categoryStats.inserted + categoryStats.updated;
  report.conflicts_resolved = conflictsResolved;
  report.conflicts_skipped = conflictsSkipped;

  // Post-verify
  const fkOrphans = await orig.query(
    `SELECT p.id::text FROM products p
     WHERE p.id = ANY($1::uuid[])
       AND p.vendor_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM vendors v WHERE v.id = p.vendor_id)`,
    [productIds],
  );

  const linkageCheck = productIds.length
    ? await orig.query(
        `SELECT p.id::text, p.product_name, p.main_image_url,
                (SELECT count(*)::int FROM product_identifier_map m WHERE m.product_id = p.id) AS map_count
         FROM products p WHERE p.id = ANY($1::uuid[])`,
        [productIds],
      )
    : { rows: [] };

  const conflictsAfter = await detectMapConflicts(orig, stagingMaps, productIds);

  const stagMapCount = Number(
    (await stag.query(`SELECT count(*)::bigint c FROM product_identifier_map WHERE organization_id=$1`, [ORG_ID]))
      .rows[0]?.c ?? 0,
  );
  const origMapCount = Number(
    (await orig.query(`SELECT count(*)::bigint c FROM product_identifier_map WHERE organization_id=$1`, [ORG_ID]))
      .rows[0]?.c ?? 0,
  );
  report.remaining_product_gap = stagMapCount - origMapCount;

  const safe =
    fkOrphans.rows.length === 0 &&
    linkageCheck.rows.every((r) => Number(r.map_count) > 0) &&
    conflictsAfter.length <= conflictsBefore.length;

  report.verify = {
    fk_vendor_orphans: fkOrphans.rows,
    linkage_check: linkageCheck.rows,
    conflicts_after: conflictsAfter,
    product_stats: productStats,
    map_stats: mapStats,
  };
  report.SAFE_TO_TEST_PRODUCT_LINKAGE_ON_ORIGINAL = safe ? "yes" : "no";

  fs.writeFileSync(path.join(outDir, "apply_result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await stag.end();
  await orig.end();

  if (!safe) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
