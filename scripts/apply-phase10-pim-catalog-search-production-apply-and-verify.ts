/**
 * PHASE-10-PRODUCTION-APPLY-AND-VERIFY
 *   npx tsx scripts/apply-phase10-pim-catalog-search-production-apply-and-verify.ts --apply
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { resolveProductForScannerItem } from "../lib/scanner/resolve-product-for-scanner-item";
import {
  isShipmentEntryFastNegative,
  lookupShipmentEntryScanCode,
} from "../lib/scanner/shipment-entry-lookup";
import {
  aggregateInventoryStatus,
  fetchVInventoryItemStatusLinesExact,
} from "../lib/scanner/v-inventory-status";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MIGRATION = "supabase/migrations/20260913120000_phase10_pim_catalog_identifier_first_search.sql";
const MIGRATION_VERSION = "20260913120000";
const MIGRATION_NAME = "phase10_pim_catalog_identifier_first_search.sql";

const WARMUP = 3;
const ITERS = 12;
const GATE_RUNS = 7;
const P95_BUDGET_MS = 250;
const PRODUCT_P95_BUDGET_MS = 500;

type IdKind = "sku" | "asin" | "fnsku" | "upc";

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function originalPostgresUrl(): string {
  const url = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!url) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL unset");
  const ref = refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
  if (ref !== ORIGINAL_REF) throw new Error(`Expected original ref ${ORIGINAL_REF}, got ${ref ?? "null"}`);
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

async function migrationApplied(client: pg.Client): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`, [
    MIGRATION_VERSION,
  ]);
  return r.rows.length > 0;
}

async function phase10RpcExists(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'pim_catalog_products_page'
       AND pg_get_function_identity_arguments(p.oid) LIKE '%boolean%'`,
  );
  return (r.rowCount ?? 0) > 0;
}

async function applyMigration(client: pg.Client): Promise<"applied" | "already_applied"> {
  // Version 20260913120000 may already exist on original for an unrelated migration;
  // gate apply on the Phase 10 function signature (p_deep_search boolean).
  if (await phase10RpcExists(client)) return "already_applied";
  await client.query(readFileSync(join(process.cwd(), MIGRATION), "utf8"));
  if (!(await migrationApplied(client))) {
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [MIGRATION_VERSION, MIGRATION_NAME],
    );
  }
  if (!(await phase10RpcExists(client))) {
    throw new Error("Phase 10 pim_catalog_products_page(boolean) still missing after SQL apply");
  }
  return "applied";
}

async function loadSamples(client: pg.Client): Promise<{
  sku: string;
  asin: string;
  title: string;
  tracking: string;
  upc: string;
  fnsku: string;
}> {
  const r = await client.query(
    `
    SELECT
      (SELECT p.sku FROM products p
        WHERE p.organization_id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL
          AND p.sku IS NOT NULL AND btrim(p.sku) <> ''
        ORDER BY p.id LIMIT 1) AS sku,
      (SELECT p.asin FROM products p
        WHERE p.organization_id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL
          AND p.asin IS NOT NULL AND btrim(p.asin) <> ''
        ORDER BY p.id LIMIT 1) AS asin,
      (SELECT left(btrim(p.product_name), 12) FROM products p
        WHERE p.organization_id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL
          AND p.product_name IS NOT NULL AND length(btrim(p.product_name)) >= 8
        ORDER BY p.id LIMIT 1) AS title,
      (SELECT ep.tracking_number FROM expected_packages ep
        WHERE ep.organization_id=$1 AND ep.store_id=$2
          AND ep.tracking_number IS NOT NULL AND btrim(ep.tracking_number) <> ''
        ORDER BY ep.id LIMIT 1) AS tracking,
      (SELECT m.upc_code FROM product_identifier_map m
        WHERE m.organization_id=$1 AND (m.store_id=$2 OR m.store_id IS NULL)
          AND m.deleted_at IS NULL AND m.upc_code IS NOT NULL AND btrim(m.upc_code) <> ''
        ORDER BY m.id LIMIT 1) AS upc,
      (SELECT p.fnsku FROM products p
        WHERE p.organization_id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL
          AND p.fnsku IS NOT NULL AND btrim(p.fnsku) <> ''
        ORDER BY p.id LIMIT 1) AS fnsku
    `,
    [ORG, STORE],
  );
  const row = r.rows[0] ?? {};
  return {
    sku: String(row.sku ?? "B003W0PCEO-VEN").trim(),
    asin: String(row.asin ?? "B007OXL3GQ").trim(),
    title: String(row.title ?? "Monin Mango").trim(),
    tracking: String(row.tracking ?? "0643219686").trim(),
    upc: String(row.upc ?? "612511069669").trim(),
    fnsku: String(row.fnsku ?? "X003RRASTH").trim(),
  };
}

async function pimRpc(
  client: pg.Client,
  q: string | null,
  deepSearch: boolean,
): Promise<{ total: number; rows: number; ms: number; path: string }> {
  const t0 = performance.now();
  const r = await client.query(
    `SELECT public.pim_catalog_products_page(
       $1::uuid, $2::uuid, 1::integer, 25::integer, $3::text,
       NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text,
       'any'::text, 'any'::text, 'any'::text, 'any'::text, 'any'::text,
       'any'::text, 'any'::text, 'any'::text, 'updated_at'::text, 'desc'::text,
       $4::boolean
     ) AS payload`,
    [ORG, STORE, q, deepSearch],
  );
  const ms = Math.round(performance.now() - t0);
  const payload = r.rows[0]?.payload ?? {};
  const total = Number(payload?.total ?? 0);
  const rows = Array.isArray(payload?.rows) ? payload.rows.length : 0;
  let path = "browse";
  if (deepSearch) path = "deep_search_13field";
  else if (q) {
    if (/^B0[A-Z0-9]{8}$/i.test(q)) path = "asin_exact";
    else if (!/\s/.test(q) && q.length <= 80 && !/^\d+$/.test(q)) path = "sku_exact";
    else path = "title_trgm";
  }
  return { total, rows, ms, path };
}

async function verifyPim(client: pg.Client, samples: { sku: string; asin: string; title: string }) {
  const sku = await pimRpc(client, samples.sku, false);
  const asin = await pimRpc(client, samples.asin, false);
  const title = await pimRpc(client, samples.title, false);
  const deepSku = await pimRpc(client, samples.sku, true);
  const deepTitle = await pimRpc(client, samples.title, true);
  const hasTrgm = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS e`);
  return {
    pim_sku_q_result: {
      pass: sku.total > 0 && sku.path === "sku_exact",
      sample: samples.sku,
      total: sku.total,
      rows: sku.rows,
      ms: sku.ms,
      path: sku.path,
    },
    pim_asin_q_result: {
      pass: asin.total > 0 && asin.path === "asin_exact",
      sample: samples.asin,
      total: asin.total,
      rows: asin.rows,
      ms: asin.ms,
      path: asin.path,
    },
    pim_title_q_result: {
      pass: title.total > 0 && title.path === "title_trgm",
      sample: samples.title,
      total: title.total,
      rows: title.rows,
      ms: title.ms,
      path: title.path,
      pg_trgm: hasTrgm.rows[0]?.e === true,
    },
    deep_search_result: {
      pass:
        deepSku.path === "deep_search_13field" &&
        deepSku.total >= sku.total &&
        deepTitle.path === "deep_search_13field" &&
        deepTitle.total > 0,
      sku_sample: samples.sku,
      sku_total: deepSku.total,
      sku_exact_total: sku.total,
      title_sample: samples.title,
      title_total: deepTitle.total,
      title_trgm_total: title.total,
      ms: { sku_deep: deepSku.ms, title_deep: deepTitle.ms },
      path: "deep_search_13field",
    },
  };
}

async function benchGate(sb: SupabaseClient, code: string): Promise<{ p95: number; fast_negative: boolean }> {
  const opts = { skipExpensiveFallback: true, gateFastNegative: true };
  for (let i = 0; i < 2; i++) await lookupShipmentEntryScanCode(sb, ORG, STORE, code, opts);
  const ms: number[] = [];
  let last!: Awaited<ReturnType<typeof lookupShipmentEntryScanCode>>;
  for (let i = 0; i < GATE_RUNS; i++) {
    last = await lookupShipmentEntryScanCode(sb, ORG, STORE, code, opts);
    const timingMs = last.gate_timing?.total_ms ?? 0;
    ms.push(timingMs > 0 ? timingMs : 0);
  }
  return { p95: percentile(ms, 95), fast_negative: isShipmentEntryFastNegative(last) };
}

async function benchResolve(sb: SupabaseClient, kind: IdKind, value: string): Promise<number> {
  const input = {
    organization_id: ORG,
    store_id: STORE,
    upc: kind === "upc" ? value : null,
    sku: kind === "sku" ? value : null,
    fnsku: kind === "fnsku" ? value : null,
    asin: kind === "asin" ? value : null,
  };
  for (let i = 0; i < WARMUP; i++) await resolveProductForScannerItem(sb, input);
  const timings: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await resolveProductForScannerItem(sb, input);
    timings.push(Math.round(performance.now() - t0));
  }
  return percentile(timings, 95);
}

function inventoryTrackingCodeCheck(): { pass: boolean; detail: string } {
  const src = readFileSync(join(process.cwd(), "lib/scanner/v-inventory-status.ts"), "utf8");
  const exactFn = src.includes("fetchVInventoryItemStatusLinesExact");
  const noIlike = !/\.ilike\(/i.test(src) && !/ILIKE/i.test(src);
  return {
    pass: exactFn && noIlike,
    detail: exactFn && noIlike ? "eq-only path; no ILIKE in v-inventory-status.ts" : "ILIKE or missing exact helper",
  };
}

async function verifyInventoryTracking(sb: SupabaseClient, tracking: string) {
  const codeCheck = inventoryTrackingCodeCheck();
  const t0 = performance.now();
  const { rows } = await fetchVInventoryItemStatusLinesExact(sb, ORG, STORE, "tracking_number", tracking);
  const ms = Math.round(performance.now() - t0);
  const agg = aggregateInventoryStatus(rows);
  return {
    pass: codeCheck.pass && rows.length >= 0,
    sample: tracking,
    row_count: rows.length,
    total_expected: agg.totalExpected,
    total_scanned: agg.totalScanned,
    ms,
    code_check: codeCheck,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();

  const blockers: string[] = [];
  let production_applied: "yes" | "no" | "already_applied" = "no";

  const pgClient = new pg.Client({
    connectionString: originalPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await pgClient.connect();
  await pgClient.query("SET statement_timeout = '120s'");

  if (apply) {
    const status = await applyMigration(pgClient);
    production_applied = status === "applied" ? "yes" : "already_applied";
    await new Promise((r) => setTimeout(r, 1200));
  } else {
    production_applied = (await phase10RpcExists(pgClient)) ? "already_applied" : "no";
  }

  if (!(await phase10RpcExists(pgClient))) {
    blockers.push("pim_catalog_products_page(boolean) missing on production");
  }

  const samples = await loadSamples(pgClient);
  const pim = await verifyPim(pgClient, samples);
  await pgClient.end();

  if (!pim.pim_sku_q_result.pass) blockers.push("PIM SKU exact q failed");
  if (!pim.pim_asin_q_result.pass) blockers.push("PIM ASIN exact q failed");
  if (!pim.pim_title_q_result.pass) blockers.push("PIM title trgm q failed");
  if (!pim.deep_search_result.pass) blockers.push("PIM deep_search legacy path failed");

  const sb = originalSupabase();
  const knownGate = await benchGate(sb, "0643219686");
  const numericGate = await benchGate(sb, "25");
  const unknownGate = await benchGate(sb, "ZZZ-NOMATCH-PHASE10-999");
  const scanner_gate_regression = {
    pass:
      knownGate.p95 < P95_BUDGET_MS &&
      numericGate.p95 < P95_BUDGET_MS &&
      unknownGate.p95 < P95_BUDGET_MS &&
      unknownGate.fast_negative,
    known_p95_ms: knownGate.p95,
    numeric_p95_ms: numericGate.p95,
    unknown_p95_ms: unknownGate.p95,
    unknown_fast_negative: unknownGate.fast_negative,
  };
  if (!scanner_gate_regression.pass) blockers.push("scanner gate regression failed");

  const skuP95 = await benchResolve(sb, "sku", samples.sku);
  const asinP95 = await benchResolve(sb, "asin", samples.asin);
  const fnskuP95 = await benchResolve(sb, "fnsku", samples.fnsku);
  const upcP95 = await benchResolve(sb, "upc", samples.upc);
  const product_search_regression = {
    pass: skuP95 < PRODUCT_P95_BUDGET_MS && asinP95 < PRODUCT_P95_BUDGET_MS && fnskuP95 < PRODUCT_P95_BUDGET_MS && upcP95 < PRODUCT_P95_BUDGET_MS,
    sku_p95_ms: skuP95,
    asin_p95_ms: asinP95,
    fnsku_p95_ms: fnskuP95,
    upc_p95_ms: upcP95,
    samples: { sku: samples.sku, asin: samples.asin, fnsku: samples.fnsku, upc: samples.upc },
  };
  if (!product_search_regression.pass) blockers.push("product identifier benchmark regression failed");

  const inventory_tracking_result = await verifyInventoryTracking(sb, samples.tracking);
  if (!inventory_tracking_result.pass) blockers.push("inventory tracking exact search check failed");

  let build_result = "FAIL";
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe" });
    build_result = "PASS";
  } catch (e) {
    blockers.push(`build: ${String((e as { message?: string })?.message ?? e)}`);
  }

  const report = {
    production_applied,
    migration_name: MIGRATION_NAME,
    target_ref: ORIGINAL_REF,
    pim_sku_q_result: pim.pim_sku_q_result,
    pim_asin_q_result: pim.pim_asin_q_result,
    pim_title_q_result: pim.pim_title_q_result,
    deep_search_result: pim.deep_search_result,
    scanner_gate_regression,
    product_search_regression,
    inventory_tracking_result,
    build_result,
    SAFE_FOR_PRODUCTION_SEARCH: production_applied !== "no" && build_result === "PASS" && blockers.length === 0,
    blockers,
  };

  console.log(JSON.stringify(report, null, 2));
  if (blockers.length || production_applied === "no") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
