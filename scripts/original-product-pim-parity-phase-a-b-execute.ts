/**
 * ORIGINAL_PRODUCT_PIM_PARITY_PHASE_A_B_EXECUTE
 *
 * Phase A: staging → original products + product_identifier_map + product_prices (id diff)
 * Phase B: Class A EP persist + Class B map bridge (original only)
 *
 *   npx tsx scripts/original-product-pim-parity-phase-a-b-execute.ts
 *   APPROVED_TO_APPLY_SCOPED_PRODUCT_PIM_PARITY=true APPROVED_TO_BACKFILL_EXPECTED_PACKAGE_PRODUCT_LINKAGE=true \
 *     npx tsx scripts/original-product-pim-parity-phase-a-b-execute.ts --apply
 *   npx tsx scripts/original-product-pim-parity-phase-a-b-execute.ts --apply --phase-b-only
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const AUDIT_REF = ".cursor/audit-reports/product-pim-full-parity-audit/20260605T202000Z";
const OUT_BASE = ".cursor/audit-reports/original-product-pim-parity-phase-a-b-execute";
const MATCH_SOURCE_B = "original_pim_parity_phase_b_bridge";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
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

async function upsertById(
  stag: pg.Client,
  orig: pg.Client,
  table: string,
  ids: string[],
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const stats = { inserted: 0, updated: 0, skipped: 0 };
  if (!ids.length) return stats;
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
  return stats;
}

type FnskuConflict = {
  organization_id: string;
  store_id: string;
  fnsku: string;
  rows: Array<{ map_id: string; product_id: string; seller_sku: string | null; deleted_at: unknown }>;
  staging_row: { map_id: string; product_id: string; seller_sku: string | null } | null;
  staging_rows?: Array<{ map_id: string; product_id: string; seller_sku: string | null }>;
};

async function fetchFnskuConflicts(stag: pg.Client, orig: pg.Client): Promise<FnskuConflict[]> {
  const r = await orig.query(`
    SELECT organization_id::text, store_id::text, upper(btrim(fnsku)) AS fnsku_norm,
           array_agg(json_build_object(
             'map_id', id::text,
             'product_id', product_id::text,
             'seller_sku', seller_sku,
             'deleted_at', deleted_at
           ) ORDER BY id) AS rows
    FROM product_identifier_map
    WHERE deleted_at IS NULL AND NULLIF(btrim(fnsku),'') IS NOT NULL
    GROUP BY organization_id, store_id, upper(btrim(fnsku))
    HAVING count(DISTINCT product_id) > 1
  `);
  const out: FnskuConflict[] = [];
  for (const row of r.rows) {
    const fnskuNorm = String(row.fnsku_norm);
    const org = String(row.organization_id);
    const store = String(row.store_id);
    const staging = await stag.query(
      `SELECT id::text AS map_id, product_id::text, seller_sku
       FROM product_identifier_map
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL
         AND upper(btrim(fnsku))=$3
       LIMIT 5`,
      [org, store, fnskuNorm],
    );
    const stagingRows = staging.rows as Array<{ map_id: string; product_id: string; seller_sku: string | null }>;
    const stagingTruth =
      stagingRows.length === 1
        ? stagingRows[0]!
        : stagingRows.length > 1
          ? null
          : null;
    out.push({
      organization_id: org,
      store_id: store,
      fnsku: fnskuNorm,
      rows: row.rows as FnskuConflict["rows"],
      staging_row: stagingTruth,
      staging_rows: stagingRows,
    });
  }
  return out;
}

async function resolveFnskuConflict(
  orig: pg.Client,
  conflict: FnskuConflict,
  auditNote: string[],
): Promise<"resolved" | "ambiguous_both_refs" | "blocked"> {
  const stagingActive = conflict.staging_rows ?? (conflict.staging_row ? [conflict.staging_row] : []);
  const stagingProductIds = [...new Set(stagingActive.map((r) => r.product_id))];
  const originalProductIds = [...new Set(conflict.rows.map((r) => r.product_id))];

  if (stagingProductIds.length !== 1) {
    const sameSet =
      stagingProductIds.length === originalProductIds.length &&
      stagingProductIds.every((id) => originalProductIds.includes(id)) &&
      originalProductIds.every((id) => stagingProductIds.includes(id));
    if (sameSet) {
      auditNote.push(
        `AMBIGUOUS (both refs): FNSKU ${conflict.fnsku} maps to products [${originalProductIds.join(", ")}] on staging and original — no staging-truth single winner; skipping destructive soft-delete; 0 EP unresolved for this FNSKU.`,
      );
      return "ambiguous_both_refs";
    }
    auditNote.push(
      `BLOCKED: FNSKU ${conflict.fnsku} — staging products [${stagingProductIds.join(", ")}] vs original [${originalProductIds.join(", ")}]`,
    );
    return "blocked";
  }

  const truthPid = stagingProductIds[0]!;
  const stale = conflict.rows.filter((r) => r.product_id !== truthPid);
  const keep = conflict.rows.filter((r) => r.product_id === truthPid);
  if (keep.length === 0) {
    auditNote.push(`BLOCKED: FNSKU ${conflict.fnsku} — staging product ${truthPid} not in original conflict set`);
    return "blocked";
  }
  if (stale.length === 0) return "resolved";
  for (const s of stale) {
    await orig.query(
      `UPDATE product_identifier_map SET deleted_at = now(), updated_at = now()
       WHERE id = $1::uuid AND deleted_at IS NULL`,
      [s.map_id],
    );
    auditNote.push(
      `Resolved FNSKU ${conflict.fnsku}: soft-deleted stale map ${s.map_id} (product ${s.product_id}); kept staging-truth ${keep[0]!.map_id} → ${truthPid}`,
    );
  }
  return "resolved";
}

async function crossIds(
  stag: pg.Client,
  orig: pg.Client,
  table: string,
  where: string,
): Promise<{ staging_only: string[]; original_only: string[] }> {
  const sIds = (
    await stag.query(`SELECT id::text AS id FROM public.${table} WHERE ${where}`)
  ).rows.map((r: { id: string }) => r.id);
  const oIds = new Set(
    (
      await orig.query(`SELECT id::text AS id FROM public.${table} WHERE ${where}`)
    ).rows.map((r: { id: string }) => r.id),
  );
  const staging_only = sIds.filter((id) => !oIds.has(id));
  const oAll = [...oIds];
  const sSet = new Set(sIds);
  const original_only = oAll.filter((id) => !sSet.has(id));
  return { staging_only, original_only };
}

async function classifyUnresolved(orig: pg.Client): Promise<{
  classA: Array<{ id: string; sole_product_id: string }>;
  classB: Array<{ id: string; product_id: string; sku: string | null; fnsku: string | null }>;
  counts: Record<string, number>;
}> {
  const r = await orig.query(`
    WITH base AS (
      SELECT ep.id, ep.organization_id, ep.store_id, ep.sku, ep.fnsku,
             ep.identifier_resolution_status
      FROM expected_packages ep
      WHERE ep.resolved_product_id IS NULL
    ),
    map_products AS (
      SELECT b.id, count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count,
             min(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS sole_product_id
      FROM base b
      LEFT JOIN product_identifier_map m
        ON m.deleted_at IS NULL AND m.organization_id = b.organization_id AND m.store_id = b.store_id
       AND ((NULLIF(btrim(b.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(b.fnsku)))
         OR (NULLIF(btrim(b.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(b.sku))))
      GROUP BY b.id
    ),
    direct_products AS (
      SELECT b.id, count(DISTINCT p.id)::int AS product_count,
             min(p.id::text) AS sample_product_id
      FROM base b
      LEFT JOIN products p ON p.organization_id = b.organization_id AND p.deleted_at IS NULL
       AND ((NULLIF(btrim(b.fnsku),'') IS NOT NULL AND upper(btrim(p.fnsku))=upper(btrim(b.fnsku)))
         OR (NULLIF(btrim(b.sku),'') IS NOT NULL AND upper(btrim(p.sku))=upper(btrim(b.sku))))
      GROUP BY b.id
    ),
    classified AS (
      SELECT b.id, b.sku, b.fnsku,
        coalesce(mp.map_product_count,0) AS map_product_count,
        coalesce(dp.product_count,0) AS product_count,
        mp.sole_product_id,
        dp.sample_product_id,
        CASE
          WHEN coalesce(mp.map_product_count,0) > 1 OR coalesce(dp.product_count,0) > 1 THEN 'D'
          WHEN coalesce(mp.map_product_count,0) = 1 THEN 'A'
          WHEN coalesce(dp.product_count,0) = 1 AND coalesce(mp.map_product_count,0) = 0 THEN 'B'
          ELSE 'C'
        END AS class
      FROM base b
      LEFT JOIN map_products mp ON mp.id = b.id
      LEFT JOIN direct_products dp ON dp.id = b.id
    )
    SELECT class, count(*)::int AS n FROM classified GROUP BY class
  `);
  const counts: Record<string, number> = {};
  for (const row of r.rows) counts[String(row.class)] = Number(row.n);

  const classA = (
    await orig.query(`
      WITH base AS (
        SELECT ep.id, ep.organization_id, ep.store_id, ep.sku, ep.fnsku
        FROM expected_packages ep WHERE ep.resolved_product_id IS NULL
      ),
      map_products AS (
        SELECT b.id, count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count,
               min(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS sole_product_id
        FROM base b
        LEFT JOIN product_identifier_map m
          ON m.deleted_at IS NULL AND m.organization_id = b.organization_id AND m.store_id = b.store_id
         AND ((NULLIF(btrim(b.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(b.fnsku)))
           OR (NULLIF(btrim(b.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(b.sku))))
        GROUP BY b.id
      )
      SELECT b.id::text, mp.sole_product_id::text
      FROM base b
      JOIN map_products mp ON mp.id = b.id
      WHERE mp.map_product_count = 1
    `)
  ).rows as Array<{ id: string; sole_product_id: string }>;

  const classB = (
    await orig.query(`
      WITH base AS (
        SELECT ep.id, ep.organization_id, ep.store_id, ep.sku, ep.fnsku
        FROM expected_packages ep WHERE ep.resolved_product_id IS NULL
      ),
      map_products AS (
        SELECT b.id, count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count
        FROM base b
        LEFT JOIN product_identifier_map m
          ON m.deleted_at IS NULL AND m.organization_id = b.organization_id AND m.store_id = b.store_id
         AND ((NULLIF(btrim(b.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(b.fnsku)))
           OR (NULLIF(btrim(b.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(b.sku))))
        GROUP BY b.id
      ),
      direct_products AS (
        SELECT b.id, min(p.id::text) AS product_id
        FROM base b
        JOIN products p ON p.organization_id = b.organization_id AND p.deleted_at IS NULL
         AND ((NULLIF(btrim(b.fnsku),'') IS NOT NULL AND upper(btrim(p.fnsku))=upper(btrim(b.fnsku)))
           OR (NULLIF(btrim(b.sku),'') IS NOT NULL AND upper(btrim(p.sku))=upper(btrim(b.sku))))
        GROUP BY b.id
        HAVING count(DISTINCT p.id) = 1
      )
      SELECT b.id::text, dp.product_id::text, b.sku, b.fnsku
      FROM base b
      JOIN direct_products dp ON dp.id = b.id
      JOIN map_products mp ON mp.id = b.id
      WHERE mp.map_product_count = 0
    `)
  ).rows as Array<{ id: string; product_id: string; sku: string | null; fnsku: string | null }>;

  return { classA, classB, counts };
}

function bridgeExternalId(row: {
  organization_id: string;
  store_id: string;
  sku: string | null;
  fnsku: string | null;
  product_id: string;
}): string {
  const key = [row.organization_id, row.store_id, row.sku ?? "", row.fnsku ?? "", row.product_id].join("|");
  return `${MATCH_SOURCE_B}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

async function epUnresolvedCount(orig: pg.Client): Promise<number> {
  const r = await orig.query(`SELECT count(*)::int AS c FROM expected_packages WHERE resolved_product_id IS NULL`);
  return Number(r.rows[0]?.c ?? 0);
}

async function verifyExample(orig: pg.Client, fnsku: string): Promise<Record<string, unknown>> {
  const ep = await orig.query(
    `SELECT count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
            count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved
     FROM expected_packages WHERE upper(trim(fnsku))=upper($1)`,
    [fnsku],
  );
  const map = await orig.query(
    `SELECT count(*)::int AS c FROM product_identifier_map
     WHERE organization_id=$1::uuid AND deleted_at IS NULL AND upper(trim(fnsku))=upper($2)`,
    [ORG_ID, fnsku],
  );
  return { fnsku, ep: ep.rows[0], map_rows: map.rows[0]?.c };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const phaseBOnly = process.argv.includes("--phase-b-only");
  loadEnvLocalIntoProcess();
  const approvedA = process.env.APPROVED_TO_APPLY_SCOPED_PRODUCT_PIM_PARITY?.trim().toLowerCase() === "true";
  const approvedB = process.env.APPROVED_TO_BACKFILL_EXPECTED_PACKAGE_PRODUCT_LINKAGE?.trim().toLowerCase() === "true";
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (refFromPgUrl(stagingUrl) !== STAGING_REF) throw new Error("staging ref mismatch");
  if (refFromPgUrl(originalUrl) !== ORIGINAL_REF) throw new Error("original ref mismatch");

  const stag = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  const orig = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  await stag.connect();
  await orig.connect();

  const unresolvedBefore = await epUnresolvedCount(orig);
  const fnskuConflictsBefore = await fetchFnskuConflicts(stag, orig);
  fs.writeFileSync(path.join(outDir, "fnsku_conflicts_before.json"), JSON.stringify(fnskuConflictsBefore, null, 2));

  const productCross = await crossIds(
    stag,
    orig,
    "products",
    `organization_id='${ORG_ID}'::uuid AND deleted_at IS NULL`,
  );
  const mapCross = await crossIds(
    stag,
    orig,
    "product_identifier_map",
    `organization_id='${ORG_ID}'::uuid AND deleted_at IS NULL`,
  );

  const result: Record<string, unknown> = {
    run_id: rid,
    apply,
    phase_b_only: phaseBOnly,
    phase_a_applied: false,
    fnsku_conflict_resolved: false,
    fnsku_conflict_detail: fnskuConflictsBefore,
    products_upserted: 0,
    identifier_map_rows_upserted: 0,
    prices_copied: 0,
    class_a_backfilled: 0,
    class_b_bridge_inserted: 0,
    unresolved_before: unresolvedBefore,
    unresolved_after: unresolvedBefore,
    remaining_class_c: null as number | null,
    example_X0030LQS8F_result: null as Record<string, unknown> | null,
    SAFE_FOR_PRODUCT_LINKAGE_LIVE: "no",
    dry_run: {
      staging_only_products: productCross.staging_only.length,
      staging_only_maps: mapCross.staging_only.length,
      original_only_maps_preserved: mapCross.original_only.length,
    },
  };

  if (!apply) {
    console.log(JSON.stringify(result, null, 2));
    await stag.end();
    await orig.end();
    return;
  }

  if (!approvedA || !approvedB) {
    throw new Error("Both APPROVED_TO_APPLY_SCOPED_PRODUCT_PIM_PARITY=true and APPROVED_TO_BACKFILL_EXPECTED_PACKAGE_PRODUCT_LINKAGE=true required");
  }

  const auditNotes: string[] = [];

  // ── FNSKU conflict resolution ──
  if (fnskuConflictsBefore.length === 0) {
    result.fnsku_conflict_resolved = true;
    auditNotes.push("No FNSKU multi-product clusters on original before apply.");
  } else if (fnskuConflictsBefore.length === 1) {
    const resolution = await resolveFnskuConflict(orig, fnskuConflictsBefore[0]!, auditNotes);
    if (resolution === "blocked") {
      fs.writeFileSync(path.join(outDir, "BLOCKED.json"), JSON.stringify({ auditNotes, conflicts: fnskuConflictsBefore }, null, 2));
      throw new Error(`FNSKU conflict blocked — stopped. See ${outDir}/BLOCKED.json`);
    }
    result.fnsku_conflict_resolved = resolution === "resolved";
    result.fnsku_conflict_status = resolution;
  } else {
    fs.writeFileSync(path.join(outDir, "BLOCKED.json"), JSON.stringify({ auditNotes, conflicts: fnskuConflictsBefore }, null, 2));
    throw new Error(`Multiple FNSKU conflict clusters (${fnskuConflictsBefore.length}) — stopped`);
  }

  const conflictsAfterResolve = await fetchFnskuConflicts(stag, orig);
  result.fnsku_conflicts_after = conflictsAfterResolve.length;
  if (conflictsAfterResolve.length > 0 && result.fnsku_conflict_status !== "ambiguous_both_refs") {
    throw new Error(`FNSKU conflicts remain after resolution: ${conflictsAfterResolve.length}`);
  }

  const bk = rid.replace(/[^0-9A-Za-z]/g, "");
  let productStats = { inserted: 0, updated: 0, skipped: 0 };
  let mapStats = { inserted: 0, updated: 0, skipped: 0 };
  let priceStats = { inserted: 0, updated: 0, skipped: 0 };
  let classABackfilled = 0;
  let classBInserted = 0;

  if (phaseBOnly) {
    result.phase_a_applied = productCross.staging_only.length === 0;
    result.products_upserted = "skipped_phase_b_only";
    result.identifier_map_rows_upserted = "skipped_phase_b_only";
    result.prices_copied = "skipped_phase_b_only";
    result.fnsku_conflict_resolved = result.fnsku_conflict_resolved || fnskuConflictsBefore.length === 0;
    if (!result.phase_a_applied) {
      throw new Error(
        `phase-b-only blocked: ${productCross.staging_only.length} staging-only products remain — run full apply first`,
      );
    }
  }

  // ── Phase A (separate transaction) ──
  if (!phaseBOnly) try {
    await orig.query("BEGIN");

    // Backup preimage
    if (productCross.staging_only.length) {
      await orig.query(`DROP TABLE IF EXISTS public._backup_phase_ab_products_${bk}`);
      await orig.query(
        `CREATE TABLE public._backup_phase_ab_products_${bk} AS
         SELECT * FROM products WHERE id = ANY($1::uuid[])`,
        [productCross.staging_only],
      );
    }
    if (mapCross.staging_only.length) {
      await orig.query(`DROP TABLE IF EXISTS public._backup_phase_ab_map_${bk}`);
      await orig.query(
        `CREATE TABLE public._backup_phase_ab_map_${bk} AS SELECT 1 WHERE false`,
      );
    }

    // Vendor/category FK deps for new products
    const newProducts = productCross.staging_only.length
      ? (await stag.query(`SELECT * FROM products WHERE id = ANY($1::uuid[])`, [productCross.staging_only])).rows
      : [];
    const vendorIds = [...new Set(newProducts.map((p) => p.vendor_id).filter(Boolean) as string[])];
    const categoryIds = [...new Set(newProducts.map((p) => p.category_id).filter(Boolean) as string[])];
    if (vendorIds.length && (await tableExists(stag, "vendors"))) {
      await upsertById(stag, orig, "vendors", vendorIds);
    }
    if (categoryIds.length && (await tableExists(stag, "product_categories"))) {
      await upsertById(stag, orig, "product_categories", categoryIds);
    }

    productStats = await upsertById(stag, orig, "products", productCross.staging_only);

    const mapUseCols = await intersectCols(stag, orig, "product_identifier_map");
    const mapColList = mapUseCols.map((c) => `"${c}"`).join(", ");
    const mapPh = mapUseCols.map((_, i) => `$${i + 1}`).join(", ");
    const mapUpdates = mapUseCols.filter((c) => c !== "id").map((c) => `"${c}"=EXCLUDED."${c}"`).join(", ");

    // Map rows by id from staging
    const mapConflictsSkipped: Array<Record<string, unknown>> = [];
    for (const mapId of mapCross.staging_only) {
      const row = (
        await stag.query(`SELECT * FROM product_identifier_map WHERE id=$1::uuid`, [mapId])
      ).rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        mapStats.skipped += 1;
        continue;
      }

      const org = row.organization_id;
      const store = row.store_id;
      const sellerSku = row.seller_sku;
      const fnsku = row.fnsku;
      const productId = row.product_id;

      if (sellerSku) {
        const dupSku = await orig.query(
          `SELECT id::text, product_id::text FROM product_identifier_map
           WHERE organization_id=$1 AND store_id IS NOT DISTINCT FROM $2
             AND deleted_at IS NULL
             AND upper(btrim(seller_sku))=upper(btrim($3::text))
             AND id <> $4::uuid`,
          [org, store, sellerSku, mapId],
        );
        if (dupSku.rows.length) {
          const d = dupSku.rows[0] as { id: string; product_id: string };
          if (d.product_id === String(productId)) {
            mapStats.skipped += 1;
            continue;
          }
          mapConflictsSkipped.push({ type: "seller_sku", map_id: mapId, seller_sku: sellerSku, existing: d });
          mapStats.skipped += 1;
          continue;
        }
      }
      if (fnsku) {
        const dupFnsku = await orig.query(
          `SELECT id::text, product_id::text FROM product_identifier_map
           WHERE organization_id=$1 AND store_id IS NOT DISTINCT FROM $2
             AND fnsku=$3 AND deleted_at IS NULL AND id <> $4::uuid`,
          [org, store, fnsku, mapId],
        );
        if (dupFnsku.rows.length) {
          const d = dupFnsku.rows[0] as { id: string; product_id: string };
          if (d.product_id === String(productId)) {
            mapStats.skipped += 1;
            continue;
          }
          mapConflictsSkipped.push({ type: "fnsku", map_id: mapId, fnsku, existing: d });
          mapStats.skipped += 1;
          continue;
        }
      }

      const useCols = mapUseCols;
      const colList = mapColList;
      const ph = mapPh;
      const updates = mapUpdates;
      const exists = await orig.query(`SELECT 1 FROM product_identifier_map WHERE id=$1::uuid`, [mapId]);
      const vals = useCols.map((c) => row[c]);
      await orig.query(
        `INSERT INTO product_identifier_map (${colList}) VALUES (${ph})
         ON CONFLICT (id) DO UPDATE SET ${updates}`,
        vals,
      );
      if (exists.rows.length) mapStats.updated += 1;
      else mapStats.inserted += 1;
    }
    result.map_conflicts_skipped = mapConflictsSkipped.length;

    // product_prices for new product ids
    if (productCross.staging_only.length && (await tableExists(stag, "product_prices"))) {
      const prices = await stag.query(
        `SELECT * FROM product_prices WHERE product_id = ANY($1::uuid[])`,
        [productCross.staging_only],
      );
      for (const pr of prices.rows as Array<Record<string, unknown>>) {
        const pid = String(pr.id);
        const exists = await orig.query(`SELECT 1 FROM product_prices WHERE id=$1::uuid`, [pid]);
        const useCols = await intersectCols(stag, orig, "product_prices");
        const colList = useCols.map((c) => `"${c}"`).join(", ");
        const ph = useCols.map((_, i) => `$${i + 1}`).join(", ");
        const updates = useCols.filter((c) => c !== "id").map((c) => `"${c}"=EXCLUDED."${c}"`).join(", ");
        const vals = useCols.map((c) => pr[c]);
        await orig.query(
          `INSERT INTO product_prices (${colList}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${updates}`,
          vals,
        );
        if (exists.rows.length) priceStats.updated += 1;
        else priceStats.inserted += 1;
      }
    }

    result.phase_a_applied = true;
    result.products_upserted = productStats.inserted + productStats.updated;
    result.identifier_map_rows_upserted = mapStats.inserted + mapStats.updated;
    result.prices_copied = priceStats.inserted + priceStats.updated;

    await orig.query("COMMIT");
  } catch (e) {
    await orig.query("ROLLBACK");
    throw e;
  }

  if (phaseBOnly) {
    const mapGap = mapCross.staging_only.length;
    result.identifier_map_gap_remaining = mapGap;
    result.original_only_maps_preserved = mapCross.original_only.length;
  }

  // ── Phase B (separate transaction) ──
  try {
    await orig.query("BEGIN");

    const { classA, classB } = await classifyUnresolved(orig);
    // ── Phase B Class A ──
    for (const row of classA) {
      const upd = await orig.query(
        `UPDATE expected_packages ep
         SET resolved_product_id = $2::uuid,
             identifier_resolution_status = 'resolved',
             updated_at = now()
         WHERE ep.id = $1::uuid
           AND ep.resolved_product_id IS NULL
           AND EXISTS (
             SELECT 1 FROM product_identifier_map m
             WHERE m.organization_id = ep.organization_id AND m.store_id = ep.store_id
               AND m.deleted_at IS NULL AND m.product_id = $2::uuid
               AND ((NULLIF(btrim(ep.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(ep.fnsku)))
                 OR (NULLIF(btrim(ep.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(ep.sku))))
           )
         RETURNING ep.id`,
        [row.id, row.sole_product_id],
      );
      classABackfilled += upd.rowCount ?? 0;
    }

    // ── Phase B Class B map bridge ──
    const mapCols = await cols(orig, "product_identifier_map");
    for (const row of classB) {
      const exists = await orig.query(
        `SELECT 1 FROM product_identifier_map m
         WHERE m.organization_id=$1::uuid AND m.store_id=$2::uuid AND m.deleted_at IS NULL
           AND m.product_id=$3::uuid
           AND (($4::text IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim($4::text)))
             OR ($5::text IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim($5::text))))`,
        [ORG_ID, STORE_ID, row.product_id, row.fnsku, row.sku],
      );
      if (exists.rows.length) continue;

      const prod = await orig.query(
        `SELECT asin, sku, fnsku FROM products WHERE id=$1::uuid`,
        [row.product_id],
      );
      const p = prod.rows[0] as { asin?: string; sku?: string; fnsku?: string } | undefined;
      const extId = bridgeExternalId({
        organization_id: ORG_ID,
        store_id: STORE_ID,
        sku: row.sku,
        fnsku: row.fnsku,
        product_id: row.product_id,
      });

      const insertCols = ["id", "organization_id", "store_id", "product_id", "match_source", "external_listing_id"];
      const insertVals: unknown[] = [crypto.randomUUID(), ORG_ID, STORE_ID, row.product_id, MATCH_SOURCE_B, extId];
      if (mapCols.includes("seller_sku") && row.sku) {
        insertCols.push("seller_sku");
        insertVals.push(row.sku);
      }
      if (mapCols.includes("fnsku") && row.fnsku) {
        insertCols.push("fnsku");
        insertVals.push(row.fnsku);
      }
      if (mapCols.includes("asin") && p?.asin) {
        insertCols.push("asin");
        insertVals.push(p.asin);
      }
      if (mapCols.includes("deleted_at")) {
        insertCols.push("deleted_at");
        insertVals.push(null);
      }
      const ph = insertCols.map((_, i) => `$${i + 1}`).join(", ");
      await orig.query(
        `INSERT INTO product_identifier_map (${insertCols.map((c) => `"${c}"`).join(", ")})
         VALUES (${ph}) ON CONFLICT DO NOTHING`,
        insertVals,
      );
      classBInserted += 1;

      const epUpd = await orig.query(
        `UPDATE expected_packages ep
         SET resolved_product_id = $2::uuid, identifier_resolution_status = 'resolved', updated_at = now()
         WHERE ep.id = $1::uuid AND ep.resolved_product_id IS NULL
         RETURNING ep.id`,
        [row.id, row.product_id],
      );
      classABackfilled += epUpd.rowCount ?? 0;
    }

    result.class_a_backfilled = classABackfilled;
    result.class_b_bridge_inserted = classBInserted;

    await orig.query("COMMIT");
  } catch (e) {
    await orig.query("ROLLBACK");
    throw e;
  }

  const unresolvedAfter = await epUnresolvedCount(orig);
  const postClass = await classifyUnresolved(orig);
  result.unresolved_after = unresolvedAfter;
  result.remaining_class_c = postClass.counts.C ?? 0;

  const fkOrphans = await orig.query(
    `SELECT count(*)::int AS c FROM product_identifier_map m
     WHERE m.organization_id=$1::uuid AND m.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id=m.product_id)`,
    [ORG_ID],
  );
  const fnskuConflictsAfter = await fetchFnskuConflicts(stag, orig);
  result.example_X0030LQS8F_result = await verifyExample(orig, "X0030LQS8F");

  const safe =
    Number(fkOrphans.rows[0]?.c ?? 0) === 0 &&
    Number((result.example_X0030LQS8F_result as { ep?: { unresolved?: number } })?.ep?.unresolved ?? 999) === 0 &&
    Number((result.example_X0030LQS8F_result as { map_rows?: number })?.map_rows ?? 0) > 0;

  result.SAFE_FOR_PRODUCT_LINKAGE_LIVE = safe ? "yes" : "no";
  result.verify = {
    fk_map_orphans: fkOrphans.rows[0],
    fnsku_conflicts_after: fnskuConflictsAfter.length,
    original_only_maps: mapCross.original_only.length,
    post_classification: postClass.counts,
    audit_notes: auditNotes,
  };

  fs.writeFileSync(path.join(outDir, "execute_result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "fnsku_conflict_audit_notes.md"), auditNotes.join("\n") + "\n");
  console.log(JSON.stringify(result, null, 2));

  await stag.end();
  await orig.end();

  if (!safe) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
