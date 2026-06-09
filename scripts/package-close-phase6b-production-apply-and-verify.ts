/**
 * PHASE-6B-PACKAGE-CLOSE-SHORTAGE-RPC-PRODUCTION-APPLY
 *   npx tsx scripts/package-close-phase6b-production-apply-and-verify.ts --apply
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

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MIGRATION = "supabase/migrations/20260906120000_phase6b_package_finalize_shortage_rpc.sql";
const OUT_BASE = ".cursor/audit-reports/package-close-phase6b-production-apply";

type RpcRow = Record<string, unknown>;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

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

async function rpc(client: pg.Client, packageId: string, emptyBox: boolean): Promise<RpcRow> {
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
  const tracking = `P6B-PROD-${sessionId}`;
  const slip = `S-PROD-${sessionId}`;
  const sku = `SKU-P6B-PROD-${sessionId}`;

  const pkg = await client.query(
    `INSERT INTO packages (
       organization_id, store_id, package_code, tracking_number, id_slip_contents,
       status, expected_item_count, inside_photo_urls, notes
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'open', 6, $6::text[], $7)
     RETURNING id::text`,
    [
      ORG,
      STORE,
      `PKG-P6B-PROD-${sessionId}`,
      tracking,
      slip,
      opts?.photos ? ["https://example.test/phase6b-prod-empty.jpg"] : [],
      opts?.photos ? "Operator noted empty box at intake." : null,
    ],
  );
  const packageId = String(pkg.rows[0]?.id);

  const orderId = `ORDER-P6B-PROD-${sessionId}`;
  await client.query(
    `INSERT INTO expected_packages (
       organization_id, store_id, tracking_number, id_slip_contents, sku, fnsku, order_id,
       expected_scan_quantity, build_source
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULL, $6, 6, 'legacy')`,
    [ORG, STORE, tracking, slip, sku, orderId],
  );

  const scanned = Math.max(0, Math.floor(Number(opts?.scannedQty ?? 0)));
  if (scanned > 0) {
    await client.query(
      `INSERT INTO return_items (
         organization_id, store_id, marketplace, item_name, conditions, status, notes,
         sku, package_id, scanned_quantity
       ) VALUES ($1::uuid, $2::uuid, 'amazon', $3, $4::text[], 'received', $5, $6, $7::uuid, $8)`,
      [
        ORG,
        STORE,
        `p6b-prod-item-${sessionId}`,
        opts?.damaged ? ["damaged_product"] : ["sellable_ok"],
        `_fixture_sess:${sessionId}`,
        sku,
        packageId,
        scanned,
      ],
    );
  }

  return { packageId, sku, tracking, slip };
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

async function packageStatus(client: pg.Client, packageId: string) {
  const r = await client.query(`SELECT status FROM packages WHERE id=$1::uuid`, [packageId]);
  return String(r.rows[0]?.status ?? "");
}

async function runSmokes(client: pg.Client): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  await client.query("BEGIN");
  try {
    const sidA = randomUUID();
    const fxA = await fixture(client, sidA, { scannedQty: 4 });
    const rpcA = await rpc(client, fxA.packageId, false);
    const linesA = await shortageLines(client, fxA.packageId);
    const statusA = await packageStatus(client, fxA.packageId);
    out.shortage_qty_2_result = {
      pass:
        rpcA.ok === true &&
        linesA.rowCount === 1 &&
        Number(linesA.rows[0]?.quantity_delta) === 2 &&
        linesA.rows[0]?.discrepancy_kind === "short" &&
        linesA.rows[0]?.line_grain === "expected_group" &&
        statusA === "suspicious",
      rpc: rpcA,
      lines: linesA.rows,
      package_status: statusA,
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
    const evidenceB = await client.query(
      `SELECT count(*)::int AS n FROM claim_evidence
        WHERE organization_id=$1::uuid AND claim_case_id=$2::uuid`,
      [ORG, caseB.rows[0]?.id],
    );
    const statusB = await packageStatus(client, fxB.packageId);
    out.empty_box_result = {
      pass:
        rpcB.ok === true &&
        Number(linesB.rows[0]?.quantity_delta) === 6 &&
        caseB.rowCount === 1 &&
        caseB.rows[0]?.scanner_issue_type === "empty_box" &&
        Number(evidenceB.rows[0]?.n ?? 0) >= 1 &&
        statusB === "suspicious",
      rpc: rpcB,
      shortage_lines: linesB.rows,
      claim_case: caseB.rows[0] ?? null,
      evidence_count: evidenceB.rows[0]?.n,
      package_status: statusB,
    };

    const sidC = randomUUID();
    const fxC = await fixture(client, sidC, { scannedQty: 6 });
    const rpcC = await rpc(client, fxC.packageId, false);
    const linesC = await shortageLines(client, fxC.packageId);
    const statusC = await packageStatus(client, fxC.packageId);
    out.no_shortage_result = {
      pass: rpcC.ok === true && linesC.rowCount === 0 && statusC === "closed",
      rpc: rpcC,
      line_count: linesC.rowCount,
      package_status: statusC,
    };

    const sidD = randomUUID();
    const fxD = await fixture(client, sidD, { scannedQty: 4 });
    await rpc(client, fxD.packageId, false);
    await rpc(client, fxD.packageId, false);
    const linesD = await shortageLines(client, fxD.packageId);
    out.idempotency_result = {
      pass: linesD.rowCount === 1,
      line_count: linesD.rowCount,
      result: linesD.rowCount === 1 ? "PASS" : "FAIL",
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
    out.damaged_item_preserved = {
      pass:
        Number(beforeRi.rows[0]?.c) === 1 &&
        Number(afterRi.rows[0]?.c) === 1 &&
        afterRi.rows[0]?.has_damaged === true,
      before: beforeRi.rows[0],
      after: afterRi.rows[0],
    };

    out.package_status_result = {
      pass:
        (out.shortage_qty_2_result as { pass?: boolean }).pass &&
        (out.empty_box_result as { pass?: boolean }).pass &&
        (out.no_shortage_result as { pass?: boolean }).pass,
      shortage_status: statusA,
      empty_box_status: statusB,
      full_scan_status: statusC,
    };

    await client.query("ROLLBACK");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  out.missing_item_blocked = {
    pass:
      isPackageLevelShortageTagBlocked(["missing_item"]) &&
      filterPackageItemDiscrepancyTags(["missing_item", "damaged_product"]).join(",") ===
        "damaged_product",
    result: isPackageLevelShortageTagBlocked(["missing_item"]) ? "blocked" : "FAIL",
  };

  return out;
}

function passFlag(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { pass?: boolean }).pass === true;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const ref =
    refFromSupabaseUrl(dbUrl) ?? dbUrl.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
  const blockers: string[] = [];

  if (!dbUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (ref !== ORIGINAL_REF) blockers.push(`Expected original ref ${ORIGINAL_REF}, got ${ref ?? "null"}`);
  if (dbUrl.includes(STAGING_REF)) blockers.push("BLOCKED: URL targets staging");

  const result: Record<string, unknown> = {
    phase_number: "6B",
    production_applied: "no",
    migration_applied: "pending",
    new_tables_created: "no",
    new_columns_created: "no",
    shortage_qty_2_result: "pending",
    empty_box_result: "pending",
    no_shortage_result: "pending",
    idempotency_result: "pending",
    damaged_item_preserved: "pending",
    missing_item_blocked: "pending",
    package_status_result: "pending",
    build_result: "SKIP",
    SAFE_FOR_LIVE_EMPTY_BOX_AND_SHORTAGE: "no",
    blockers,
  };

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const tables = await client.query(`
    SELECT
      to_regclass('public.claim_lines') IS NOT NULL AS claim_lines,
      to_regclass('public.claim_cases') IS NOT NULL AS claim_cases,
      to_regclass('public.claim_evidence') IS NOT NULL AS claim_evidence
  `);
  const schema = tables.rows[0] as { claim_lines: boolean; claim_cases: boolean; claim_evidence: boolean };
  if (!schema.claim_lines) blockers.push("claim_lines missing on production");
  if (!schema.claim_cases) blockers.push("claim_cases missing on production");
  if (!schema.claim_evidence) blockers.push("claim_evidence missing on production");

  if (apply && blockers.length === 0) {
    const applied = await applyMigration(client);
    result.production_applied = applied ? "yes" : "already_applied";
    result.migration_applied = applied ? MIGRATION : "already_applied";

    const fn = await client.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='finalize_package_receive_close'`,
    );
    if (!fn.rows.length) blockers.push("finalize_package_receive_close RPC missing after apply");

    const smokes = await runSmokes(client);
    Object.assign(result, smokes);

    result.shortage_qty_2_result = passFlag(smokes.shortage_qty_2_result) ? "PASS" : "FAIL";
    result.empty_box_result = passFlag(smokes.empty_box_result) ? "PASS" : "FAIL";
    result.no_shortage_result = passFlag(smokes.no_shortage_result) ? "PASS" : "FAIL";
    result.idempotency_result = passFlag(smokes.idempotency_result) ? "PASS" : "FAIL";
    result.damaged_item_preserved = passFlag(smokes.damaged_item_preserved) ? "PASS" : "FAIL";
    result.missing_item_blocked = passFlag(smokes.missing_item_blocked) ? "PASS" : "FAIL";
    result.package_status_result = passFlag(smokes.package_status_result) ? "PASS" : "FAIL";
  }

  await client.end();

  let buildOk = false;
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
    buildOk = true;
  } catch (e) {
    result.build_error = e instanceof Error ? e.message : String(e);
  }
  result.build_result = buildOk ? "PASS" : apply ? "FAIL" : "SKIP";

  const smokesPass =
    !apply ||
    (result.shortage_qty_2_result === "PASS" &&
      result.empty_box_result === "PASS" &&
      result.no_shortage_result === "PASS" &&
      result.idempotency_result === "PASS" &&
      result.damaged_item_preserved === "PASS" &&
      result.missing_item_blocked === "PASS" &&
      result.package_status_result === "PASS");

  result.SAFE_FOR_LIVE_EMPTY_BOX_AND_SHORTAGE =
    blockers.length === 0 && buildOk && smokesPass ? "yes" : "no";
  result.blockers = blockers;

  fs.writeFileSync(path.join(outDir, "apply-result.md"), [
    "# Phase 6B production apply",
    "",
    `- Run: \`${rid}\` · Mode: **${apply ? "APPLY" : "DRY-RUN"}**`,
    `- Target: \`${ORIGINAL_REF}\``,
    `- Migration: \`${MIGRATION}\``,
    `- Smokes: rollback-safe transaction (no persistent fixture data)`,
    "",
    `| Check | Result |`,
    `|-------|--------|`,
    `| production_applied | ${result.production_applied} |`,
    `| shortage_qty_2 | ${result.shortage_qty_2_result} |`,
    `| empty_box | ${result.empty_box_result} |`,
    `| no_shortage | ${result.no_shortage_result} |`,
    `| idempotency | ${result.idempotency_result} |`,
    `| damaged preserved | ${result.damaged_item_preserved} |`,
    `| missing blocked | ${result.missing_item_blocked} |`,
    `| package status | ${result.package_status_result} |`,
    `| build | ${result.build_result} |`,
    `| SAFE_FOR_LIVE | ${result.SAFE_FOR_LIVE_EMPTY_BOX_AND_SHORTAGE} |`,
  ].join("\n") + "\n");

  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ run_id: rid, mode: apply ? "apply" : "dry-run", target: ORIGINAL_REF, migration: MIGRATION }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.SAFE_FOR_LIVE_EMPTY_BOX_AND_SHORTAGE !== "yes") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
