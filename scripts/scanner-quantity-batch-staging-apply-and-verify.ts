/**
 * PHASE-3-SCANNER-QUANTITY-BATCH-STAGING-APPLY-AND-VERIFY
 *   npx tsx scripts/scanner-quantity-batch-staging-apply-and-verify.ts --apply
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { assertScriptReturnItemsWriteAllowed } from "../lib/script-return-items-write-guard";
import { scriptReturnItemsSessionNote } from "../lib/scanner/return-items-script-pg";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const MIGRATIONS = [
  "supabase/migrations/20260608180000_return_items_scanned_quantity_batch.sql",
  "supabase/migrations/20260608180100_return_items_quantity_allocation_rpcs.sql",
];
const OUT_BASE = ".cursor/audit-reports/scanner-quantity-batch-staging-apply";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromUrl(url: string): string | null {
  return refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
}

async function fnDef(client: pg.Client, name: string): Promise<string> {
  const r = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1
     ORDER BY p.oid DESC LIMIT 1`,
    [name],
  );
  return String(r.rows[0]?.def ?? "");
}

async function applyMigrations(client: pg.Client): Promise<string[]> {
  const applied: string[] = [];
  for (const file of MIGRATIONS) {
    const version = path.basename(file).replace(/\.sql$/, "").split("_")[0]!;
    const exists = await client.query(
      `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`,
      [version],
    );
    if (exists.rows.length) continue;
    const sql = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    await client.query(sql);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name)
       VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
      [version, path.basename(file)],
    );
    applied.push(file);
  }
  return applied;
}

async function verifySchema(client: pg.Client) {
  const col = await client.query(
    `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='return_items' AND column_name='scanned_quantity'`,
  );
  const backfill = await client.query(
    `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
            count(*) FILTER (WHERE deleted_at IS NULL AND scanned_quantity <> 1)::int AS non_one,
            count(*) FILTER (WHERE deleted_at IS NULL AND scanned_quantity IS NULL)::int AS nulls
     FROM return_items WHERE organization_id=$1::uuid`,
    [ORG],
  );
  const scannedView = await client.query(`SELECT pg_get_viewdef('public.v_scanned_items_counted'::regclass, true) AS def`);
  const invItemView = await client.query(`SELECT pg_get_viewdef('public.v_inventory_item_status'::regclass, true) AS def`);
  const invView = await client.query(`SELECT pg_get_viewdef('public.v_inventory_status'::regclass, true) AS def`);
  const scannedDef = String(scannedView.rows[0]?.def ?? "");
  const invItemDef = String(invItemView.rows[0]?.def ?? "");
  const invDef = String(invView.rows[0]?.def ?? "");

  const allocDef = await fnDef(client, "allocate_expected_item_unit");
  const batchDef = await fnDef(client, "allocate_expected_items_for_return_item_ids");
  const releaseDef = await fnDef(client, "release_expected_item_unit");
  const moveDef = await fnDef(client, "move_expected_item_unit");

  return {
    quantity_column: col.rows[0] ?? null,
    backfill: backfill.rows[0],
    views: {
      v_scanned_items_counted_uses_sum: /sum\s*\(\s*coalesce\s*\(\s*r\.scanned_quantity/i.test(scannedDef),
      v_scanned_items_counted_has_batch_count: /scan_batch_count/i.test(scannedDef),
      v_inventory_item_status_inherits_sum: /v_scanned_items_counted/i.test(invItemDef),
      v_inventory_status_quantity_weighted: /sum\s*\(\s*total_scanned\s*\)/i.test(invDef),
    },
    rpcs: {
      allocate_expected_item_unit: /scanned_quantity/i.test(allocDef),
      allocate_expected_items_for_return_item_ids: /allocate_expected_item_unit/i.test(batchDef),
      release_expected_item_unit: /scanned_quantity/i.test(releaseDef),
      move_expected_item_unit: /release_expected_item_unit/i.test(moveDef) && /allocate_expected_item_unit/i.test(moveDef),
    },
  };
}

async function smokeTests(client: pg.Client): Promise<Record<string, unknown>> {
  assertScriptReturnItemsWriteAllowed();
  const sessionId = randomUUID();
  const note = scriptReturnItemsSessionNote(sessionId);

  await client.query("BEGIN");

  try {
    const epRes = await client.query(
      `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, order_id,
              expected_scan_quantity::int AS qty
       FROM expected_packages
       WHERE organization_id=$1::uuid
         AND parent_expected_package_id IS NULL
         AND COALESCE(expected_scan_quantity, 0) >= 10
         AND build_source IN ('detail_shipment','detail_remainder','legacy')
       ORDER BY expected_scan_quantity DESC
       LIMIT 1`,
      [ORG],
    );
    const ep = epRes.rows[0] as Record<string, unknown> | undefined;
    if (!ep?.id) throw new Error("smoke: need root EP with qty >= 10");

    const pkgRes = await client.query(
      `SELECT id::text, pallet_id::text FROM packages
       WHERE organization_id=$1::uuid AND deleted_at IS NULL LIMIT 1`,
      [ORG],
    );
    const pkg = pkgRes.rows[0] as { id: string; pallet_id: string | null };
    const orgId = String(ep.organization_id);
    const storeId = String(ep.store_id);
    const rootId = String(ep.id);
    const rootQtyBefore = Number(ep.qty);

    const insBatch = await client.query(
      `INSERT INTO return_items (
         organization_id, store_id, marketplace, item_name, conditions, status, notes,
         sku, fnsku, order_id, package_id, scanned_quantity
       ) VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'received',$5,$6,$7,$8,$9::uuid,$10)
       RETURNING id::text, scanned_quantity`,
      [
        orgId,
        storeId,
        `_qtybatch5_${sessionId}`,
        ["sellable_ok"],
        note,
        ep.sku,
        ep.fnsku,
        ep.order_id,
        pkg.id,
        5,
      ],
    );
    const batchId = String(insBatch.rows[0]?.id);
    const batchRows = await client.query(
      `SELECT count(*)::int AS rows, coalesce(sum(scanned_quantity),0)::int AS units
       FROM return_items WHERE notes LIKE $1 AND deleted_at IS NULL`,
      [`%${sessionId}%`],
    );

    const insLegacy = await client.query(
      `INSERT INTO return_items (
         organization_id, store_id, marketplace, item_name, conditions, status, notes,
         sku, fnsku, order_id, package_id
       ) VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'received',$5,$6,$7,$8,$9::uuid)
       RETURNING id::text, scanned_quantity`,
      [
        orgId,
        storeId,
        `_qtylegacy1_${sessionId}`,
        ["sellable_ok"],
        note,
        ep.sku,
        ep.fnsku,
        ep.order_id,
        pkg.id,
      ],
    );
    const legacyQty = Number(insLegacy.rows[0]?.scanned_quantity);

    const legacyIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await client.query(
        `INSERT INTO return_items (
           organization_id, store_id, marketplace, item_name, conditions, status, notes,
           sku, package_id
         ) VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'received',$5,$6,$7::uuid)
         RETURNING id::text`,
        [orgId, storeId, `_qtytriple${i}_${sessionId}`, ["sellable_ok"], note, ep.sku, pkg.id],
      );
      legacyIds.push(String(r.rows[0]?.id));
    }
    const triple = await client.query(
      `SELECT count(*)::int AS rows, coalesce(sum(scanned_quantity),0)::int AS units
       FROM return_items WHERE id = ANY($1::uuid[])`,
      [legacyIds],
    );

    const parentBefore = await client.query(`SELECT expected_scan_quantity::int AS q FROM expected_packages WHERE id=$1::uuid`, [rootId]);
    const parentBeforeQty = Number(parentBefore.rows[0]?.q);

    await client.query(
      `SELECT * FROM allocate_expected_item_unit(
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13::uuid,$14::uuid
       )`,
      [
        batchId,
        orgId,
        storeId,
        pkg.id,
        `${orgId}|${storeId}|${pkg.id}|smoke|package`,
        ep.order_id,
        null,
        null,
        ep.sku,
        ep.fnsku,
        null,
        null,
        null,
        rootId,
      ],
    );
    const parentAfter = await client.query(`SELECT expected_scan_quantity::int AS q FROM expected_packages WHERE id=$1::uuid`, [rootId]);
    const parentAfterQty = Number(parentAfter.rows[0]?.q);
    const allocDelta = parentBeforeQty - parentAfterQty;

    const problem = await client.query(
      `INSERT INTO return_items (
         organization_id, store_id, marketplace, item_name, conditions, status, notes,
         sku, package_id, scanned_quantity, photo_evidence
       ) VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'problem',$5,$6,$7::uuid,$8,$9::jsonb)
       RETURNING id::text, scanned_quantity, conditions, photo_evidence`,
      [
        orgId,
        storeId,
        `_qtyproblem2_${sessionId}`,
        ["damaged"],
        note,
        ep.sku,
        pkg.id,
        2,
        JSON.stringify({ urls: ["https://example.test/smoke.jpg"] }),
      ],
    );
    const problemRow = problem.rows[0];

    await client.query("ROLLBACK");

    return {
      smoke_batch_qty_5: {
        pass: batchRows.rows[0]?.rows === 1 && batchRows.rows[0]?.units === 5,
        rows: batchRows.rows[0]?.rows,
        units: batchRows.rows[0]?.units,
      },
      smoke_legacy_qty_1: {
        pass: legacyQty === 1,
        scanned_quantity: legacyQty,
      },
      smoke_three_legacy_rows: {
        pass: triple.rows[0]?.rows === 3 && triple.rows[0]?.units === 3,
        rows: triple.rows[0]?.rows,
        units: triple.rows[0]?.units,
      },
      smoke_alloc_subtracts_5: {
        pass: allocDelta === 5,
        parent_before: parentBeforeQty,
        parent_after: parentAfterQty,
        delta: allocDelta,
      },
      problem_quantity_result: {
        pass:
          Number(problemRow?.scanned_quantity) === 2 &&
          Array.isArray(problemRow?.conditions) &&
          problemRow.conditions.includes("damaged") &&
          problemRow?.photo_evidence != null,
        scanned_quantity: problemRow?.scanned_quantity,
        conditions: problemRow?.conditions,
        has_evidence: problemRow?.photo_evidence != null,
      },
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromUrl(dbUrl);
  const blockers: string[] = [];
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (ref !== STAGING_REF) blockers.push(`Expected staging ref ${STAGING_REF}, got ${ref ?? "null"}`);
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push("BLOCKED: URL targets original");

  const result: Record<string, unknown> = {
    phase_number: 3,
    staging_migrations_applied: "no",
    canonical_scanned_table: "return_items",
    quantity_column_verified: false,
    views_quantity_aware: "no",
    rpcs_quantity_aware: "no",
    smoke_batch_qty_5_result: null,
    smoke_legacy_qty_1_result: null,
    problem_quantity_result: null,
    build_result: "not_run",
    SAFE_TO_APPLY_PHASE_3_PRODUCTION: "no",
    blockers,
    next_phase_recommendation:
      "PHASE-4-SCANNER-MOBILE-BATCH-QUANTITY-UI — send scanned_quantity from Neda mobile; relax operatorReceiveItem quantity guard.",
  };

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "execute_result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  let applied: string[] = [];
  if (apply) {
    applied = await applyMigrations(client);
    result.staging_migrations_applied = applied.length > 0 ? "yes" : "already_applied";
  } else {
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='return_items' AND column_name='scanned_quantity'`,
    );
    result.staging_migrations_applied = col.rows.length ? "already_applied" : "dry_run_only";
  }

  const verify = await verifySchema(client);
  result.quantity_column_verified =
    verify.quantity_column?.data_type === "integer" &&
    verify.quantity_column?.is_nullable === "NO" &&
    String(verify.quantity_column?.column_default ?? "").includes("1") &&
    Number((verify.backfill as { nulls?: number })?.nulls ?? 1) === 0;

  const viewsOk = Object.values(verify.views).every(Boolean);
  const rpcsOk = Object.values(verify.rpcs).every(Boolean);
  result.views_quantity_aware = viewsOk ? "yes" : "no";
  result.rpcs_quantity_aware = rpcsOk ? "yes" : "no";
  result.verify = verify;
  result.migrations_applied_files = applied;

  if (apply && verify.quantity_column) {
    const smoke = await smokeTests(client);
    result.smoke_batch_qty_5_result = smoke.smoke_batch_qty_5;
    result.smoke_legacy_qty_1_result = smoke.smoke_legacy_qty_1;
    result.smoke_three_legacy_rows = smoke.smoke_three_legacy_rows;
    result.problem_quantity_result = smoke.problem_quantity_result;

    const smokeOk =
      (smoke.smoke_batch_qty_5 as { pass?: boolean }).pass &&
      (smoke.smoke_legacy_qty_1 as { pass?: boolean }).pass &&
      (smoke.smoke_three_legacy_rows as { pass?: boolean }).pass &&
      (smoke.smoke_alloc_subtracts_5 as { pass?: boolean }).pass &&
      (smoke.problem_quantity_result as { pass?: boolean }).pass;

    if (!smokeOk) blockers.push("One or more smoke tests failed");
    if (!result.quantity_column_verified) blockers.push("scanned_quantity column/backfill verify failed");
    if (!viewsOk) blockers.push("Views not quantity-aware");
    if (!rpcsOk) blockers.push("RPCs not quantity-aware");

    result.SAFE_TO_APPLY_PHASE_3_PRODUCTION = blockers.length === 0 ? "yes" : "no";
    result.blockers = blockers;
  }

  await client.end();
  fs.writeFileSync(path.join(outDir, "execute_result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
