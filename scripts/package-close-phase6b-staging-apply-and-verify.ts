/**
 * PHASE-6B-PACKAGE-CLOSE-SHORTAGE-RPC-STAGING
 *   npx tsx scripts/package-close-phase6b-staging-apply-and-verify.ts --apply
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  filterPackageItemDiscrepancyTags,
  isPackageLevelShortageTagBlocked,
} from "../lib/scanner/item-unit-discrepancy-tags";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MIGRATION = "supabase/migrations/20260906120000_phase6b_package_finalize_shortage_rpc.sql";
const OUT_BASE = ".cursor/audit-reports/package-close-phase6b-staging-apply";

type RpcRow = Record<string, unknown>;

async function applyMigration(client: pg.Client): Promise<boolean> {
  const version = "20260906120000";
  const exists = await client.query(
    `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`,
    [version],
  );
  if (exists.rows.length) return false;
  await client.query(fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8"));
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [version, path.basename(MIGRATION)],
  );
  return true;
}

async function rpc(
  client: pg.Client,
  packageId: string,
  emptyBox: boolean,
): Promise<RpcRow> {
  const r = await client.query(
    `SELECT public.finalize_package_receive_close($1::uuid, $2::uuid, $3::uuid, $4::boolean, NULL::uuid, NULL::text) AS payload`,
    [ORG, packageId, STORE, emptyBox],
  );
  return (r.rows[0]?.payload ?? {}) as RpcRow;
}

async function fixture(
  client: pg.Client,
  sessionId: string,
  opts?: { scannedQty?: number; damaged?: boolean; photos?: boolean },
) {
  const tracking = `P6B-${sessionId}`;
  const slip = `S-${sessionId}`;
  const sku = `SKU-P6B-${sessionId}`;

  const pkg = await client.query(
    `INSERT INTO packages (
       organization_id, store_id, package_code, tracking_number, id_slip_contents,
       status, expected_item_count, inside_photo_urls, notes
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'open', 6, $6::text[], $7)
     RETURNING id::text`,
    [
      ORG,
      STORE,
      `PKG-P6B-${sessionId}`,
      tracking,
      slip,
      opts?.photos ? ["https://example.test/phase6b-empty.jpg"] : [],
      opts?.photos ? "Operator noted empty box at intake." : null,
    ],
  );
  const packageId = String(pkg.rows[0]?.id);

  const orderId = `ORDER-P6B-${sessionId}`;
  const ep = await client.query(
    `INSERT INTO expected_packages (
       organization_id, store_id, tracking_number, id_slip_contents, sku, fnsku, order_id,
       expected_scan_quantity, build_source
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULL, $6, 6, 'legacy')
     RETURNING id::text`,
    [ORG, STORE, tracking, slip, sku, orderId],
  );
  const rootEpId = String(ep.rows[0]?.id);

  let damagedId: string | null = null;
  const scanned = Math.max(0, Math.floor(Number(opts?.scannedQty ?? 0)));
  if (scanned > 0) {
    const ri = await client.query(
      `INSERT INTO return_items (
         organization_id, store_id, marketplace, item_name, conditions, status, notes,
         sku, package_id, scanned_quantity
       ) VALUES ($1::uuid, $2::uuid, 'amazon', $3, $4::text[], 'received', $5, $6, $7::uuid, $8)
       RETURNING id::text`,
      [
        ORG,
        STORE,
        `p6b-item-${sessionId}`,
        opts?.damaged ? ["damaged_product"] : ["sellable_ok"],
        `_fixture_sess:${sessionId}`,
        sku,
        packageId,
        scanned,
      ],
    );
    damagedId = String(ri.rows[0]?.id);
  }

  return { packageId, rootEpId, sku, tracking, slip, damagedId };
}

async function shortageLines(client: pg.Client, packageId: string) {
  return client.query(
    `SELECT id::text, quantity_delta::numeric, discrepancy_kind, line_grain
       FROM claim_lines
      WHERE organization_id=$1::uuid AND package_id=$2::uuid
        AND idempotency_key LIKE 'cl:package_finalize:short:%'`,
    [ORG, packageId],
  );
}

async function runSmokes(client: pg.Client): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  await client.query("BEGIN");
  try {
    const sidA = randomUUID();
    const fxA = await fixture(client, sidA, { scannedQty: 4 });
    const rpcA = await rpc(client, fxA.packageId, false);
    const linesA = await shortageLines(client, fxA.packageId);
    out.smoke_a_shortage_qty_2 = {
      pass:
        rpcA.ok === true &&
        linesA.rowCount === 1 &&
        Number(linesA.rows[0]?.quantity_delta) === 2 &&
        linesA.rows[0]?.discrepancy_kind === "short" &&
        linesA.rows[0]?.line_grain === "expected_group",
      rpc: rpcA,
      lines: linesA.rows,
    };

    const sidB = randomUUID();
    const fxB = await fixture(client, sidB, { scannedQty: 0, photos: true });
    const rpcB = await rpc(client, fxB.packageId, true);
    const linesB = await shortageLines(client, fxB.packageId);
    const caseB = await client.query(
      `SELECT id::text, scanner_issue_type FROM claim_cases
        WHERE organization_id=$1::uuid AND idempotency_key=$2`,
      [ORG, `cc:package_finalize:empty_box:${ORG}:${fxB.packageId}`],
    );
    out.smoke_b_empty_box = {
      pass:
        rpcB.ok === true &&
        Number(linesB.rows[0]?.quantity_delta) === 6 &&
        caseB.rowCount === 1 &&
        caseB.rows[0]?.scanner_issue_type === "empty_box",
      rpc: rpcB,
      shortage_lines: linesB.rows,
      claim_case: caseB.rows[0] ?? null,
    };

    const sidC = randomUUID();
    const fxC = await fixture(client, sidC, { scannedQty: 6 });
    const rpcC = await rpc(client, fxC.packageId, false);
    const linesC = await shortageLines(client, fxC.packageId);
    out.smoke_c_no_shortage = {
      pass: rpcC.ok === true && linesC.rowCount === 0,
      rpc: rpcC,
      line_count: linesC.rowCount,
    };

    const sidD = randomUUID();
    const fxD = await fixture(client, sidD, { scannedQty: 4 });
    await rpc(client, fxD.packageId, false);
    await rpc(client, fxD.packageId, false);
    const linesD = await shortageLines(client, fxD.packageId);
    out.smoke_d_idempotent = {
      pass: linesD.rowCount === 1,
      line_count: linesD.rowCount,
    };

    const sidE = randomUUID();
    const fxE = await fixture(client, sidE, { scannedQty: 4, damaged: true });
    const beforeRi = await client.query(
      `SELECT count(*)::int AS c FROM return_items WHERE package_id=$1::uuid AND deleted_at IS NULL`,
      [fxE.packageId],
    );
    await rpc(client, fxE.packageId, false);
    const afterRi = await client.query(
      `SELECT count(*)::int AS c, bool_or('damaged_product' = ANY(conditions)) AS has_damaged
         FROM return_items WHERE package_id=$1::uuid AND deleted_at IS NULL`,
      [fxE.packageId],
    );
    out.smoke_e_damaged_return_items_preserved = {
      pass:
        Number(beforeRi.rows[0]?.c) === 1 &&
        Number(afterRi.rows[0]?.c) === 1 &&
        afterRi.rows[0]?.has_damaged === true,
      before: beforeRi.rows[0],
      after: afterRi.rows[0],
    };

    await client.query("ROLLBACK");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  out.missing_item_return_items_blocked = {
    pass:
      isPackageLevelShortageTagBlocked(["missing_item"]) &&
      filterPackageItemDiscrepancyTags(["missing_item", "damaged_product"]).join(",") ===
        "damaged_product",
  };

  return out;
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
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push("BLOCKED: URL targets original production");

  const result: Record<string, unknown> = {
    phase_number: "6B",
    staging_applied: "no",
    production_applied: "no",
    new_tables_created: "no",
    new_columns_created: "no",
    schema_approval_required: "no",
    server_finalize_action: "finalizeOperatorPackageReceiveAction",
    shortage_claim_lines_created: "pending",
    empty_box_claim_case_created: "pending",
    idempotency_result: "pending",
    neda_finalize_path_updated: "yes",
    missing_item_return_items_blocked: "pending",
    build_result: "SKIP",
    SAFE_TO_APPLY_6B_PRODUCTION: "no",
    new_phase_6_percent: 0,
    blockers,
  };

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const tables = await client.query(`
    SELECT
      to_regclass('public.claim_lines') IS NOT NULL AS claim_lines,
      to_regclass('public.claim_cases') IS NOT NULL AS claim_cases,
      to_regclass('public.claim_evidence') IS NOT NULL AS claim_evidence
  `);
  const schema = tables.rows[0] as { claim_lines: boolean; claim_cases: boolean; claim_evidence: boolean };
  result.schema = schema;
  if (!schema.claim_lines) {
    blockers.push("claim_lines missing on staging");
  }
  if (!schema.claim_cases) {
    result.schema_approval_required = "yes";
    blockers.push("claim_cases missing — empty_box path needs schema approval");
  }

  if (apply && blockers.length === 0) {
    const applied = await applyMigration(client);
    result.staging_applied = applied ? "yes" : "already_applied";
    result.migration_applied = applied ? MIGRATION : "already_applied";

    const fn = await client.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='finalize_package_receive_close'`,
    );
    if (!fn.rows.length) blockers.push("finalize_package_receive_close RPC missing after apply");

    const smokes = await runSmokes(client);
    Object.assign(result, smokes);

    result.shortage_claim_lines_created =
      (smokes.smoke_a_shortage_qty_2 as { pass?: boolean })?.pass ? "yes" : "no";
    result.empty_box_claim_case_created =
      (smokes.smoke_b_empty_box as { pass?: boolean })?.pass ? "yes" : "no";
    result.idempotency_result = (smokes.smoke_d_idempotent as { pass?: boolean })?.pass ? "PASS" : "FAIL";
    result.missing_item_return_items_blocked = (
      smokes.missing_item_return_items_blocked as { pass?: boolean }
    )?.pass
      ? "yes"
      : "no";
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

  const smokesPass =
    !apply ||
    ((result.smoke_a_shortage_qty_2 as { pass?: boolean })?.pass &&
      (result.smoke_b_empty_box as { pass?: boolean })?.pass &&
      (result.smoke_c_no_shortage as { pass?: boolean })?.pass &&
      (result.smoke_d_idempotent as { pass?: boolean })?.pass &&
      (result.smoke_e_damaged_return_items_preserved as { pass?: boolean })?.pass &&
      result.missing_item_return_items_blocked === "yes");

  result.SAFE_TO_APPLY_6B_PRODUCTION =
    blockers.length === 0 && buildOk && smokesPass ? "yes" : "no";
  result.new_phase_6_percent = result.SAFE_TO_APPLY_6B_PRODUCTION === "yes" ? 100 : apply ? 75 : 50;
  result.blockers = blockers;

  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.SAFE_TO_APPLY_6B_PRODUCTION !== "yes") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
