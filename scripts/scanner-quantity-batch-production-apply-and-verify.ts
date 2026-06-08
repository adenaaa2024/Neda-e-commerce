/**
 * PHASE-3-SCANNER-QUANTITY-BATCH-PRODUCTION-APPLY
 *   npx tsx scripts/scanner-quantity-batch-production-apply-and-verify.ts --apply
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const MIGRATIONS = [
  "supabase/migrations/20260608180000_return_items_scanned_quantity_batch.sql",
  "supabase/migrations/20260608180100_return_items_quantity_allocation_rpcs.sql",
];
const STAGING_SIGNOFF = ".cursor/audit-reports/scanner-quantity-batch-staging-apply/20260608190300Z/execute_result.json";
const OUT_BASE = ".cursor/audit-reports/scanner-quantity-batch-production-apply";

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

function readStagingSignoff(): { ok: boolean; detail: string } {
  if (!fs.existsSync(STAGING_SIGNOFF)) {
    return { ok: false, detail: `Missing staging signoff: ${STAGING_SIGNOFF}` };
  }
  const j = JSON.parse(fs.readFileSync(STAGING_SIGNOFF, "utf8")) as {
    SAFE_TO_APPLY_PHASE_3_PRODUCTION?: string;
  };
  if (j.SAFE_TO_APPLY_PHASE_3_PRODUCTION !== "yes") {
    return { ok: false, detail: "Staging SAFE_TO_APPLY_PHASE_3_PRODUCTION !== yes" };
  }
  return { ok: true, detail: STAGING_SIGNOFF };
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
            count(*) FILTER (WHERE deleted_at IS NULL AND scanned_quantity = 1)::int AS qty_one,
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
  const sessionId = randomUUID();
  const note = `_p3prod_verify:${sessionId}`;

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
      `SELECT id::text FROM packages
       WHERE organization_id=$1::uuid AND deleted_at IS NULL LIMIT 1`,
      [ORG],
    );
    const pkg = pkgRes.rows[0] as { id: string };
    const orgId = String(ep.organization_id);
    const storeId = String(ep.store_id);
    const rootId = String(ep.id);

    const insLegacy = await client.query(
      `INSERT INTO return_items (
         organization_id, store_id, marketplace, item_name, conditions, status, notes,
         sku, fnsku, order_id, package_id
       ) VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'received',$5,$6,$7,$8,$9::uuid)
       RETURNING id::text, scanned_quantity`,
      [orgId, storeId, `p3prod-legacy-${sessionId}`, ["sellable_ok"], note, ep.sku, ep.fnsku, ep.order_id, pkg.id],
    );

    const insBatch = await client.query(
      `INSERT INTO return_items (
         organization_id, store_id, marketplace, item_name, conditions, status, notes,
         sku, fnsku, order_id, package_id, scanned_quantity
       ) VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'received',$5,$6,$7,$8,$9::uuid,$10)
       RETURNING id::text, scanned_quantity`,
      [
        orgId,
        storeId,
        `p3prod-batch5-${sessionId}`,
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
    const batchQty = Number(insBatch.rows[0]?.scanned_quantity);

    const problem = await client.query(
      `INSERT INTO return_items (
         organization_id, store_id, marketplace, item_name, conditions, status, notes,
         sku, package_id, scanned_quantity, photo_evidence
       ) VALUES ($1::uuid,$2::uuid,'amazon',$3,$4::text[],'problem',$5,$6,$7::uuid,$8,$9::jsonb)
       RETURNING id::text, scanned_quantity, conditions, photo_evidence`,
      [
        orgId,
        storeId,
        `p3prod-problem2-${sessionId}`,
        ["damaged"],
        note,
        ep.sku,
        pkg.id,
        2,
        JSON.stringify({ urls: ["https://example.test/p3prod-verify.jpg"] }),
      ],
    );

    const parentBefore = await client.query(
      `SELECT expected_scan_quantity::int AS q FROM expected_packages WHERE id=$1::uuid`,
      [rootId],
    );
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
        `${orgId}|${storeId}|${pkg.id}|p3prod|package`,
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

    const parentAfter = await client.query(
      `SELECT expected_scan_quantity::int AS q FROM expected_packages WHERE id=$1::uuid`,
      [rootId],
    );
    const allocDelta = parentBeforeQty - Number(parentAfter.rows[0]?.q);

    await client.query("ROLLBACK");

    return {
      smoke_legacy_result: {
        pass: Number(insLegacy.rows[0]?.scanned_quantity) === 1,
        scanned_quantity: insLegacy.rows[0]?.scanned_quantity,
      },
      smoke_batch_qty_5_result: {
        pass: batchQty === 5,
        rows: 1,
        units: batchQty,
        return_item_id: batchId,
      },
      smoke_problem_qty_result: {
        pass:
          Number(problem.rows[0]?.scanned_quantity) === 2 &&
          Array.isArray(problem.rows[0]?.conditions) &&
          problem.rows[0].conditions.includes("damaged") &&
          problem.rows[0]?.photo_evidence != null,
        scanned_quantity: problem.rows[0]?.scanned_quantity,
        conditions: problem.rows[0]?.conditions,
      },
      allocation_result: {
        pass: allocDelta === 5,
        parent_before: parentBeforeQty,
        parent_after: Number(parentAfter.rows[0]?.q),
        delta: allocDelta,
      },
      cleanup_result: {
        pass: true,
        method: "transaction_rollback",
        rows_persisted: 0,
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

  const blockers: string[] = [];
  const signoff = readStagingSignoff();
  if (!signoff.ok) blockers.push(signoff.detail);

  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromUrl(dbUrl);
  if (!dbUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (ref !== ORIGINAL_REF) blockers.push(`Expected original ref ${ORIGINAL_REF}, got ${ref ?? "null"}`);
  if (dbUrl.includes(STAGING_REF)) blockers.push("BLOCKED: URL targets staging");

  const result: Record<string, unknown> = {
    phase_number: 3,
    production_migrations_applied: "no",
    target_ref: ORIGINAL_REF,
    quantity_column_verified: false,
    existing_rows_backfilled: false,
    views_quantity_aware: false,
    rpcs_quantity_aware: false,
    smoke_legacy_result: null,
    smoke_batch_qty_5_result: null,
    smoke_problem_qty_result: null,
    allocation_result: null,
    cleanup_result: null,
    build_result: "not_run",
    SAFE_FOR_NEDA_UI_BATCH_QUANTITY: "no",
    new_phase_3_percent: 0,
    blockers,
    staging_signoff: signoff.detail,
  };

  if (blockers.length || !apply) {
    if (!apply && !blockers.length) blockers.push("Pass --apply to execute on production");
    result.blockers = blockers;
    fs.writeFileSync(path.join(outDir, "execute_result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(blockers.length ? 1 : 0);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const applied = await applyMigrations(client);
  result.production_migrations_applied = applied.length > 0 ? "yes" : "already_applied";
  result.migrations_applied_files = applied;

  const verify = await verifySchema(client);
  result.verify = verify;

  const colOk =
    verify.quantity_column?.data_type === "integer" &&
    verify.quantity_column?.is_nullable === "NO" &&
    String(verify.quantity_column?.column_default ?? "").includes("1");
  const backfillOk =
    Number((verify.backfill as { nulls?: number })?.nulls ?? 1) === 0 &&
    Number((verify.backfill as { non_one?: number })?.non_one ?? 0) >= 0;
  result.quantity_column_verified = colOk;
  result.existing_rows_backfilled = backfillOk;
  result.views_quantity_aware = Object.values(verify.views).every(Boolean);
  result.rpcs_quantity_aware = Object.values(verify.rpcs).every(Boolean);

  if (!colOk) blockers.push("scanned_quantity column verify failed");
  if (!backfillOk) blockers.push("backfill verify failed (null scanned_quantity rows)");
  if (!result.views_quantity_aware) blockers.push("views not quantity-aware");
  if (!result.rpcs_quantity_aware) blockers.push("RPCs not quantity-aware");

  const smoke = await smokeTests(client);
  result.smoke_legacy_result = smoke.smoke_legacy_result;
  result.smoke_batch_qty_5_result = smoke.smoke_batch_qty_5_result;
  result.smoke_problem_qty_result = smoke.smoke_problem_qty_result;
  result.allocation_result = smoke.allocation_result;
  result.cleanup_result = smoke.cleanup_result;

  for (const key of [
    "smoke_legacy_result",
    "smoke_batch_qty_5_result",
    "smoke_problem_qty_result",
    "allocation_result",
    "cleanup_result",
  ] as const) {
    const row = smoke[key] as { pass?: boolean } | undefined;
    if (!row?.pass) blockers.push(`${key} failed`);
  }

  await client.end();

  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
    result.build_result = "pass";
  } catch (e) {
    result.build_result = "fail";
    blockers.push(`build failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const backendComplete =
    colOk &&
    backfillOk &&
    result.views_quantity_aware &&
    result.rpcs_quantity_aware &&
    blockers.filter((b) => b.startsWith("smoke") || b.startsWith("allocation") || b.startsWith("cleanup")).length === 0;

  result.new_phase_3_percent = backendComplete && result.build_result === "pass" ? 100 : 0;
  result.SAFE_FOR_NEDA_UI_BATCH_QUANTITY =
    backendComplete && result.build_result === "pass" ? "yes" : "no";
  result.blockers = blockers;

  fs.writeFileSync(path.join(outDir, "execute_result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
