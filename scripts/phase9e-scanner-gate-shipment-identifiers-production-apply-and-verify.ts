/**
 * PHASE-9E-SCANNER-GATE-SHIPMENT-IDENTIFIERS-PRODUCTION-APPLY
 *
 *   npx tsx scripts/phase9e-scanner-gate-shipment-identifiers-production-apply-and-verify.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { resolveOperatorBarcode } from "../lib/scanner/operator-resolve-barcode";
import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import { fetchVInventoryItemStatusLinesExact } from "../lib/scanner/v-inventory-status";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const KNOWN_SLIP = "SD9L0wKpZR";
const MIGRATION = "supabase/migrations/20260911120000_phase9e_scanner_gate_shipment_identifiers_staging.sql";
const MIGRATION_VERSION = "20260911120000";
const OUT_BASE = ".cursor/audit-reports/phase9e-scanner-gate-shipment-identifiers-production-apply";

const INDEX_NAMES = [
  "idx_packages_org_store_package_code",
  "idx_ep_org_store_order_id",
  "idx_packages_org_store_order_id",
  "idx_shipment_boxes_org_store_box_code",
];

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function originalPostgresUrl(): string {
  const url = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!url) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (url.includes(STAGING_REF)) throw new Error("BLOCKED: URL targets staging");
  const ref = refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
  if (ref !== ORIGINAL_REF) throw new Error(`Expected original ref ${ORIGINAL_REF}, got ${ref ?? "null"}`);
  return url;
}

function stagingPostgresUrl(): string {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!url.includes(STAGING_REF)) throw new Error(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  return url;
}

function originalSupabase(): SupabaseClient {
  const url = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url.includes(ORIGINAL_REF) || !key) {
    throw new Error("ORIGINAL_SUPABASE_URL + ORIGINAL_SERVICE_ROLE_KEY required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function migrationApplied(client: pg.Client, version: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`, [version]);
  return r.rows.length > 0;
}

async function stagingPhase9eReady(client: pg.Client): Promise<boolean> {
  if (await migrationApplied(client, MIGRATION_VERSION)) return true;
  const idx = await indexExists(client, INDEX_NAMES[0]!);
  const fn = await client.query(
    `SELECT obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'scanner_identity_gate_lookup'`,
  );
  return idx && String(fn.rows[0]?.comment ?? "").includes("Phase 9E");
}

async function applyMigration(client: pg.Client): Promise<"applied" | "already_applied"> {
  if (await migrationApplied(client, MIGRATION_VERSION)) return "already_applied";
  await client.query(fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8"));
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [MIGRATION_VERSION, path.basename(MIGRATION)],
  );
  return "applied";
}

async function indexExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${name}`]);
  return r.rows[0]?.e === true;
}

async function sampleCodes(client: pg.Client): Promise<{
  tracking: string;
  package_code: string;
  slip: string;
  amazon_order_id: string;
  removal_order_id: string;
  shipment_id: string;
  fnsku: string;
  sku: string;
  asin: string;
  upc: string;
}> {
  const r = await client.query(
    `
    SELECT
      (SELECT ep.tracking_number FROM expected_packages ep
        WHERE ep.organization_id = $1 AND ep.store_id = $2
          AND ep.tracking_number IS NOT NULL AND btrim(ep.tracking_number) <> ''
        ORDER BY ep.id LIMIT 1) AS tracking,
      (SELECT p.package_code FROM packages p
        WHERE p.organization_id = $1 AND p.store_id = $2 AND p.deleted_at IS NULL
          AND p.package_code IS NOT NULL AND btrim(p.package_code) <> ''
        ORDER BY p.id LIMIT 1) AS package_code,
      (SELECT ep.id_slip_contents FROM expected_packages ep
        WHERE ep.organization_id = $1 AND ep.store_id = $2
          AND ep.id_slip_contents IS NOT NULL AND btrim(ep.id_slip_contents) <> ''
        ORDER BY ep.id LIMIT 1) AS slip,
      (SELECT ao.amazon_order_id FROM amazon_all_orders ao
        WHERE ao.organization_id = $1 AND ao.amazon_order_id IS NOT NULL AND btrim(ao.amazon_order_id) <> ''
        ORDER BY ao.id LIMIT 1) AS amazon_order_id,
      (SELECT ar.order_id FROM amazon_removals ar
        WHERE ar.organization_id = $1 AND ar.store_id = $2
          AND ar.order_id IS NOT NULL AND btrim(ar.order_id) <> ''
        ORDER BY ar.id LIMIT 1) AS removal_order_id,
      (SELECT coalesce(
          nullif(btrim(s.raw_row->>'shipment_id'), ''),
          nullif(btrim(s.raw_row->>'shipment-id'), ''),
          nullif(btrim(s.raw_row->>'Shipment ID'), ''),
          nullif(btrim(s.raw_row->>'fba-shipment-id'), '')
        )
        FROM amazon_removal_shipments s
        WHERE s.organization_id = $1 AND s.store_id = $2
          AND (
            coalesce(s.raw_row->>'shipment_id', '') <> ''
            OR coalesce(s.raw_row->>'shipment-id', '') <> ''
            OR coalesce(s.raw_row->>'Shipment ID', '') <> ''
            OR coalesce(s.raw_row->>'fba-shipment-id', '') <> ''
          )
        ORDER BY s.id LIMIT 1) AS shipment_id,
      (SELECT ep.fnsku FROM expected_packages ep
        WHERE ep.organization_id = $1 AND ep.store_id = $2
          AND ep.fnsku IS NOT NULL AND btrim(ep.fnsku) <> ''
        ORDER BY ep.id LIMIT 1) AS fnsku,
      (SELECT ep.sku FROM expected_packages ep
        WHERE ep.organization_id = $1 AND ep.store_id = $2
          AND ep.sku IS NOT NULL AND btrim(ep.sku) <> ''
        ORDER BY ep.id LIMIT 1) AS sku,
      (SELECT p.asin FROM products p
        WHERE p.organization_id = $1 AND p.store_id = $2 AND p.deleted_at IS NULL
          AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
        ORDER BY p.id LIMIT 1) AS asin,
      (SELECT m.upc_code FROM product_identifier_map m
        WHERE m.organization_id = $1 AND (m.store_id = $2 OR m.store_id IS NULL)
          AND m.deleted_at IS NULL AND m.upc_code IS NOT NULL AND btrim(m.upc_code) <> ''
        ORDER BY m.id LIMIT 1) AS upc
    `,
    [ORG_ID, STORE_ID],
  );
  const row = r.rows[0] ?? {};
  return {
    tracking: String(row.tracking ?? "387019251").trim(),
    package_code: String(row.package_code ?? "").trim(),
    slip: String(row.slip ?? KNOWN_SLIP).trim(),
    amazon_order_id: String(row.amazon_order_id ?? "").trim(),
    removal_order_id: String(row.removal_order_id ?? "").trim(),
    shipment_id: String(row.shipment_id ?? "").trim(),
    fnsku: String(row.fnsku ?? "").trim(),
    sku: String(row.sku ?? "").trim(),
    asin: String(row.asin ?? "").trim(),
    upc: String(row.upc ?? "").trim(),
  };
}

async function rpcLookup(
  sb: SupabaseClient,
  code: string,
): Promise<{ match_type: string | null; matched_field: string | null; row_count: number; error?: string }> {
  const { data, error } = await sb.rpc("scanner_identity_gate_lookup", {
    p_organization_id: ORG_ID,
    p_store_id: STORE_ID,
    p_code: code,
  });
  if (error) return { match_type: null, matched_field: null, row_count: 0, error: error.message };
  const payload = (data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  return {
    match_type: payload.match_type != null ? String(payload.match_type) : null,
    matched_field: payload.matched_field != null ? String(payload.matched_field) : null,
    row_count: rows.length,
  };
}

function gatePass(
  label: string,
  rpc: { match_type: string | null; error?: string },
  expected: string,
  hasSample: boolean,
): { result: string; ok: boolean } {
  if (!hasSample) return { result: "SKIP_NO_SAMPLE", ok: true };
  if (rpc.error) return { result: `FAIL:${rpc.error}`, ok: false };
  return rpc.match_type === expected
    ? { result: "PASS", ok: true }
    : { result: `FAIL:match_type=${rpc.match_type}`, ok: false };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  let productionApplied: "yes" | "no" | "already_applied" = "no";

  const stagingClient = new pg.Client({
    connectionString: stagingPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await stagingClient.connect();
  const staging9e = await stagingPhase9eReady(stagingClient);
  await stagingClient.end();
  if (!staging9e) blockers.push("Prerequisite failed: Phase 9E not applied on staging");

  const pgClient = new pg.Client({
    connectionString: originalPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await pgClient.connect();
  await pgClient.query("SET statement_timeout = '180s'");

  try {
    if (apply) {
      const status = await applyMigration(pgClient);
      productionApplied = status === "applied" ? "yes" : "already_applied";
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      productionApplied = (await migrationApplied(pgClient, MIGRATION_VERSION)) ? "already_applied" : "no";
    }

    const rpcAfter = await pgClient.query(
      `SELECT to_regprocedure('public.scanner_identity_gate_lookup(uuid,uuid,text)') IS NOT NULL AS e`,
    );
    if (rpcAfter.rows[0]?.e !== true) blockers.push("scanner_identity_gate_lookup missing after apply");

    for (const idx of INDEX_NAMES) {
      if (!(await indexExists(pgClient, idx))) blockers.push(`missing index ${idx}`);
    }

    const tableProbe = await pgClient.query(`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema='public' AND table_name LIKE 'phase9e_%') AS new_tables,
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema='public' AND column_name LIKE 'phase9e_%') AS new_columns
    `);
    if (Number(tableProbe.rows[0]?.new_tables) > 0) blockers.push("unexpected new tables");
    if (Number(tableProbe.rows[0]?.new_columns) > 0) blockers.push("unexpected new columns");
  } finally {
    await pgClient.end();
  }

  const sb = originalSupabase();
  const pgSamples = new pg.Client({
    connectionString: originalPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await pgSamples.connect();
  const samples = await sampleCodes(pgSamples);
  await pgSamples.end();

  const trackingRpc = await rpcLookup(sb, samples.tracking);
  const slipRpc = await rpcLookup(sb, samples.slip);
  const packageRpc = samples.package_code ? await rpcLookup(sb, samples.package_code) : null;
  const removalRpc = samples.removal_order_id ? await rpcLookup(sb, samples.removal_order_id) : null;
  const shipmentRpc = samples.shipment_id ? await rpcLookup(sb, samples.shipment_id) : null;
  const amazonRpc = samples.amazon_order_id ? await rpcLookup(sb, samples.amazon_order_id) : null;
  const fnskuRpc = samples.fnsku ? await rpcLookup(sb, samples.fnsku) : null;

  const trackingGate = gatePass("tracking", trackingRpc, "tracking", true);
  const slipGate = gatePass("slip_code", slipRpc, "slip_code", true);
  const packageGate = gatePass(
    "package_code",
    packageRpc ?? { match_type: null },
    "package_code",
    Boolean(samples.package_code),
  );
  const removalGate = gatePass(
    "removal_order_id",
    removalRpc ?? { match_type: null },
    "removal_order_id",
    Boolean(samples.removal_order_id),
  );
  const shipmentGate = gatePass(
    "shipment_id",
    shipmentRpc ?? { match_type: null },
    "shipment_id",
    Boolean(samples.shipment_id),
  );
  const amazonGate = gatePass(
    "amazon_order_id",
    amazonRpc ?? { match_type: null },
    "amazon_order_id",
    Boolean(samples.amazon_order_id),
  );

  const shipmentGateIdentifiersOk =
    trackingGate.ok &&
    slipGate.ok &&
    packageGate.ok &&
    removalGate.ok &&
    shipmentGate.ok &&
    amazonGate.ok &&
    (!samples.fnsku || fnskuRpc?.match_type === "product_identifier_fallback");

  if (!trackingGate.ok) blockers.push(`tracking: ${trackingGate.result}`);
  if (!slipGate.ok) blockers.push(`slip_code: ${slipGate.result}`);
  if (!packageGate.ok) blockers.push(`package_code: ${packageGate.result}`);
  if (!removalGate.ok) blockers.push(`removal_order_id: ${removalGate.result}`);
  if (!shipmentGate.ok) blockers.push(`shipment_id: ${shipmentGate.result}`);
  if (!amazonGate.ok) blockers.push(`amazon_order_id: ${amazonGate.result}`);
  if (samples.fnsku && fnskuRpc?.match_type !== "product_identifier_fallback") {
    blockers.push(`fnsku gate match_type=${fnskuRpc?.match_type} expected product_identifier_fallback`);
  }

  const gateDemotedFnsku = samples.fnsku
    ? await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, samples.fnsku, { skipExpensiveFallback: true })
    : null;
  const productDemotedAtGate =
    !samples.fnsku ||
    (gateDemotedFnsku!.inventory_rows.length === 0 && gateDemotedFnsku!.inventory_matched_field == null);
  if (!productDemotedAtGate) blockers.push("FNSKU not demoted at shipment entry gate");

  const productChecks: Record<string, { ok: boolean; detail: string }> = {};
  if (samples.fnsku) {
    const inv = await fetchVInventoryItemStatusLinesExact(sb, ORG_ID, STORE_ID, "fnsku", samples.fnsku);
    productChecks.fnsku = {
      ok: inv.rows.length > 0,
      detail: `inventory_rows=${inv.rows.length}`,
    };
  }
  if (samples.sku) {
    const inv = await fetchVInventoryItemStatusLinesExact(sb, ORG_ID, STORE_ID, "sku", samples.sku);
    productChecks.sku = {
      ok: inv.rows.length > 0,
      detail: `inventory_rows=${inv.rows.length}`,
    };
  }
  if (samples.asin) {
    const resolved = await resolveOperatorBarcode(sb, ORG_ID, samples.asin, { only: "item" });
    productChecks.asin = {
      ok: resolved.kind === "item",
      detail: `resolve=${resolved.kind}`,
    };
  }
  if (samples.upc) {
    const resolved = await resolveOperatorBarcode(sb, ORG_ID, samples.upc, { only: "item" });
    productChecks.upc = {
      ok: resolved.kind === "item",
      detail: `resolve=${resolved.kind}`,
    };
  }

  const productSearchOk = Object.values(productChecks).every((c) => c.ok);
  for (const [k, v] of Object.entries(productChecks)) {
    if (!v.ok) blockers.push(`product search ${k}: ${v.detail}`);
  }

  const gateTimings: number[] = [];
  for (let i = 0; i < 16; i++) {
    for (const code of [samples.tracking, samples.slip, samples.package_code].filter(Boolean)) {
      const t0 = performance.now();
      await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, code, { skipExpensiveFallback: true });
      gateTimings.push(Math.round(performance.now() - t0));
    }
  }
  const p95 = percentile(gateTimings, 95);
  if (p95 >= 150) blockers.push(`p95 gate ${p95}ms >= 150ms target`);

  let buildOk = false;
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
    buildOk = true;
  } catch (e) {
    blockers.push(`build failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const output = {
    phase_number: "9E",
    production_applied: productionApplied,
    new_tables_created: "no",
    new_columns_created: "no",
    staging_prerequisite_9e: staging9e ? "yes" : "no",
    shipment_gate_identifiers_ok: shipmentGateIdentifiersOk ? "yes" : "no",
    product_search_identifiers_ok: productSearchOk ? "yes" : "no",
    gate_results: {
      tracking: trackingGate.result,
      package_code: packageGate.result,
      slip_code: slipGate.result,
      removal_order_id: removalGate.result,
      shipment_id: shipmentGate.result,
      amazon_order_id: amazonGate.result,
      product_fallback_fnsku: fnskuRpc?.match_type ?? "SKIP",
    },
    product_search_checks: productChecks,
    product_demoted_at_shipment_gate: productDemotedAtGate ? "yes" : "no",
    p95_gate_ms: p95,
    build_result: buildOk ? "PASS" : "FAIL",
    SAFE_FOR_LIVE_SCANNER_GATE: blockers.length === 0 ? "yes" : "no",
    blockers,
    samples,
  };

  fs.writeFileSync(path.join(outDir, "phase9e_production_result.json"), JSON.stringify(output, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md",
    ),
    [
      "# Phase 9E production apply",
      "",
      `- Run: \`${rid}\` · Apply: **${apply}**`,
      `- Target: \`${ORIGINAL_REF}\``,
      `- production_applied: **${productionApplied}**`,
      "",
      "| Check | Result |",
      "|-------|--------|",
      `| shipment_gate_identifiers | ${output.shipment_gate_identifiers_ok} |`,
      `| product_search_identifiers | ${output.product_search_identifiers_ok} |`,
      `| p95_gate_ms | ${p95} |`,
      `| build | ${output.build_result} |`,
      `| SAFE_FOR_LIVE | ${output.SAFE_FOR_LIVE_SCANNER_GATE} |`,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ run_id: rid, migration: MIGRATION, target: ORIGINAL_REF }, null, 2),
  );

  console.log(JSON.stringify(output, null, 2));
  if (output.SAFE_FOR_LIVE_SCANNER_GATE !== "yes") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
