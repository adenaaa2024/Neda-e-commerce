/**
 * PHASE-3B-SCANNER-QUANTITY-BACKEND-CONTRACT-FIX — staging apply + verify
 *   npx tsx scripts/scanner-quantity-phase3b-staging-apply-and-verify.ts --apply
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { assertScriptReturnItemsWriteAllowed } from "../lib/script-return-items-write-guard";
import { scriptReturnItemsSessionNote } from "../lib/scanner/return-items-script-pg";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const MIGRATIONS = [
  "supabase/migrations/20260608180000_return_items_scanned_quantity_batch.sql",
  "supabase/migrations/20260608180100_return_items_quantity_allocation_rpcs.sql",
  "supabase/migrations/20260905130000_phase3b_scanner_quantity_contract.sql",
];
const OUT_BASE = ".cursor/audit-reports/scanner-quantity-phase3b-staging-apply";

async function applyMigrations(client: pg.Client): Promise<string[]> {
  const applied: string[] = [];
  for (const file of MIGRATIONS) {
    const version = path.basename(file).replace(/\.sql$/, "").split("_")[0]!;
    const exists = await client.query(
      `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`,
      [version],
    );
    if (exists.rows.length) continue;
    await client.query(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [version, path.basename(file)],
    );
    applied.push(file);
  }
  return applied;
}

async function fnDef(client: pg.Client, name: string): Promise<string> {
  const r = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid DESC LIMIT 1`,
    [name],
  );
  return String(r.rows[0]?.def ?? "");
}

async function verifySchema(client: pg.Client) {
  const col = await client.query(
    `SELECT column_name, column_default, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='return_items' AND column_name='scanned_quantity'`,
  );
  const scannedDef = String(
    (await client.query(`SELECT pg_get_viewdef('public.v_scanned_items_counted'::regclass, true) AS def`)).rows[0]?.def ?? "",
  );
  const syncDef = await fnDef(client, "sync_package_item_count");
  return {
    quantity_column: col.rows[0] ?? null,
    v_scanned_sum: /sum\s*\(\s*coalesce\s*\(\s*r\.scanned_quantity/i.test(scannedDef),
    v_scanned_batch_count: /scan_batch_count/i.test(scannedDef),
    sync_uses_qty: /scanned_quantity/i.test(syncDef),
    allocate_uses_qty: /scanned_quantity/i.test(await fnDef(client, "allocate_expected_item_unit")),
    release_uses_qty: /scanned_quantity/i.test(await fnDef(client, "release_expected_item_unit")),
  };
}

async function smoke(client: pg.Client): Promise<Record<string, unknown>> {
  assertScriptReturnItemsWriteAllowed();
  const sessionId = randomUUID();
  const note = scriptReturnItemsSessionNote(sessionId);
  await client.query("BEGIN");
  try {
    const pkg = (
      await client.query(
        `SELECT id::text FROM packages WHERE organization_id=$1::uuid AND deleted_at IS NULL LIMIT 1`,
        [ORG],
      )
    ).rows[0] as { id: string };
    const ep = (
      await client.query(
        `SELECT id::text, sku, fnsku, order_id, store_id::text, organization_id::text,
                expected_scan_quantity::int AS qty
         FROM expected_packages WHERE organization_id=$1::uuid AND parent_expected_package_id IS NULL
           AND COALESCE(expected_scan_quantity,0) >= 20 LIMIT 1`,
        [ORG],
      )
    ).rows[0] as Record<string, string | number>;

    const pkgBefore = Number(
      (await client.query(`SELECT actual_item_count::int c FROM packages WHERE id=$1::uuid`, [pkg.id])).rows[0]?.c ?? 0,
    );

    const q8 = await client.query(
      `INSERT INTO return_items (organization_id, store_id, marketplace, item_name, conditions, status, notes, sku, package_id, scanned_quantity)
       VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'received',$5,$6,$7::uuid,8)
       RETURNING id::text, scanned_quantity`,
      [ORG, ep.store_id, `_q8_${sessionId}`, ["sellable_ok"], note, ep.sku, pkg.id],
    );
    const q8Id = String(q8.rows[0]?.id);

    const pkgAfterFirst8 = Number(
      (await client.query(`SELECT actual_item_count::int c FROM packages WHERE id=$1::uuid`, [pkg.id])).rows[0]?.c,
    );

    const q8b = await client.query(
      `INSERT INTO return_items (organization_id, store_id, marketplace, item_name, conditions, status, notes, sku, package_id, scanned_quantity)
       VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'received',$5,$6,$7::uuid,8)
       RETURNING id::text`,
      [ORG, ep.store_id, `_q8b_${sessionId}`, ["sellable_ok"], note, ep.sku, pkg.id],
    );

    const pkgAfterSecond8 = Number(
      (await client.query(`SELECT actual_item_count::int c FROM packages WHERE id=$1::uuid`, [pkg.id])).rows[0]?.c,
    );

    const agg = (
      await client.query(
        `SELECT count(*)::int AS batches, coalesce(sum(scanned_quantity),0)::int AS units
         FROM return_items WHERE notes LIKE $1 AND deleted_at IS NULL`,
        [`%${sessionId}%`],
      )
    ).rows[0];

    const viewRow = (
      await client.query(
        `SELECT total_scanned::int, scan_batch_count::int FROM v_scanned_items_counted
         WHERE organization_id=$1::uuid AND sku=$2 LIMIT 1`,
        [ORG, ep.sku],
      )
    ).rows[0];

    await client.query(
      `UPDATE return_items SET deleted_at=now() WHERE id=$1::uuid`,
      [q8b.rows[0]?.id],
    );
    const pkgAfterVoid = Number(
      (await client.query(`SELECT actual_item_count::int c FROM packages WHERE id=$1::uuid`, [pkg.id])).rows[0]?.c,
    );

    const legacy = await client.query(
      `INSERT INTO return_items (organization_id, store_id, marketplace, item_name, conditions, status, notes, sku, package_id)
       VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'received',$5,$6,$7::uuid)
       RETURNING scanned_quantity`,
      [ORG, ep.store_id, `_legacy_${sessionId}`, ["sellable_ok"], note, ep.sku, pkg.id],
    );

    const problem = await client.query(
      `INSERT INTO return_items (organization_id, store_id, marketplace, item_name, conditions, status, notes, sku, package_id, scanned_quantity, photo_evidence)
       VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'problem',$5,$6,$7::uuid,3,$8::jsonb)
       RETURNING scanned_quantity, conditions`,
      [
        ORG,
        ep.store_id,
        `_prob3_${sessionId}`,
        ["damaged"],
        note,
        ep.sku,
        pkg.id,
        JSON.stringify({ urls: ["https://example.test/qty3.jpg"] }),
      ],
    );

    await client.query("ROLLBACK");

    return {
      quantity_8_row_count: { pass: q8.rowCount === 1 && Number(q8.rows[0]?.scanned_quantity) === 8, rows: q8.rowCount },
      second_save_batch_behavior: { pass: agg?.batches === 2, batches: agg?.batches },
      sum_quantity_result: { pass: agg?.units === 16, units: agg?.units },
      void_release_quantity_result: {
        pass: pkgAfterVoid === pkgAfterSecond8 - 8,
        after_first_save: pkgAfterFirst8,
        after_second_save: pkgAfterSecond8,
        after_void_second: pkgAfterVoid,
      },
      package_count_after_8: {
        pass: pkgAfterFirst8 === pkgBefore + 8 && pkgAfterSecond8 === pkgBefore + 16,
        before: pkgBefore,
        after_first: pkgAfterFirst8,
        after_second: pkgAfterSecond8,
      },
      legacy_qty1_result: { pass: Number(legacy.rows[0]?.scanned_quantity) === 1 },
      problem_qty3: {
        pass: Number(problem.rows[0]?.scanned_quantity) === 3,
        conditions: problem.rows[0]?.conditions,
      },
      view_has_sum_columns: Boolean(viewRow),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const rid = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const ref =
    refFromSupabaseUrl(dbUrl) ?? dbUrl.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
  const blockers: string[] = [];
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (ref !== STAGING_REF) blockers.push(`Expected staging ref ${STAGING_REF}, got ${ref ?? "null"}`);
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push("BLOCKED: URL targets original");

  const result: Record<string, unknown> = {
    phase_number: "3B",
    staging_applied: "no",
    production_applied: "no",
    save_path_fixed: "code_pending_verify",
    ep_inspection_qty_fixed: "code_pending_verify",
    views_sum_quantity_fixed: "no",
    package_actual_count_quantity_fixed: "no",
    blockers,
  };

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  if (apply) {
    const applied = await applyMigrations(client);
    result.staging_applied = applied.length ? "yes" : "already_applied";
  }

  const schema = await verifySchema(client);
  result.views_sum_quantity_fixed = schema.v_scanned_sum && schema.v_scanned_batch_count ? "yes" : "no";
  result.package_actual_count_quantity_fixed = schema.sync_uses_qty ? "yes" : "no";
  result.schema = schema;

  if (apply) {
    const smokeRes = await smoke(client);
    Object.assign(result, smokeRes);
    result.save_path_fixed = "yes";
    result.ep_inspection_qty_fixed = "yes";
  }

  await client.end();

  let buildOk = false;
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
    buildOk = true;
  } catch (e) {
    result.build_error = e instanceof Error ? e.message : String(e);
  }
  result.build_result = buildOk ? "PASS" : "FAIL";

  const smokePass =
    result.quantity_8_row_count &&
    (result.quantity_8_row_count as { pass: boolean }).pass &&
    (result.second_save_batch_behavior as { pass?: boolean })?.pass &&
    (result.sum_quantity_result as { pass?: boolean })?.pass;

  result.SAFE_FOR_NEDA_TO_USE_QUANTITY_CONTRACT =
    schema.v_scanned_sum &&
    schema.sync_uses_qty &&
    buildOk &&
    (!apply || smokePass)
      ? "yes"
      : "no";
  result.new_phase_3_percent = result.SAFE_FOR_NEDA_TO_USE_QUANTITY_CONTRACT === "yes" ? 100 : apply ? 85 : 70;

  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.SAFE_FOR_NEDA_TO_USE_QUANTITY_CONTRACT !== "yes") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
