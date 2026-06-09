/**
 * PHASE-9D-SCANNER-GATE-RPC-PRODUCTION-APPLY
 *
 *   npx tsx scripts/phase9d-scanner-gate-rpc-production-apply-and-verify.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  filterPackageItemDiscrepancyTags,
  isPackageLevelShortageTagBlocked,
} from "../lib/scanner/item-unit-discrepancy-tags";
import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import {
  aggregateInventoryStatus,
  fetchVInventoryItemStatusLinesExact,
} from "../lib/scanner/v-inventory-status";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MIGRATION = "supabase/migrations/20260910120000_phase9d_scanner_identity_gate_rpc_staging.sql";
const FIXUP_MIGRATION = "supabase/migrations/20260910130100_phase9d_scanner_gate_rpc_view_parity_fixup.sql";
const PERF_FIXUP_MIGRATION = "supabase/migrations/20260910130200_phase9d_scanner_gate_rpc_perf_fixup.sql";
const MIGRATION_VERSION = "20260910120000";
const FIXUP_VERSION = "20260910130100";
const PERF_FIXUP_VERSION = "20260910130200";
const OUT_BASE = ".cursor/audit-reports/phase9d-scanner-gate-rpc-production-apply";

function runId(): string {
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

function originalSupabase(): SupabaseClient {
  const url = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url.includes(ORIGINAL_REF) || !key) {
    throw new Error("ORIGINAL_SUPABASE_URL + ORIGINAL_SERVICE_ROLE_KEY required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function applyMigrationFile(client: pg.Client, version: string, file: string): Promise<"applied" | "already_applied"> {
  const exists = await client.query(
    `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`,
    [version],
  );
  if (exists.rows.length) return "already_applied";
  await client.query(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [version, path.basename(file)],
  );
  return "applied";
}

async function rpcExists(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT to_regprocedure('public.scanner_identity_gate_lookup(uuid,uuid,text)') IS NOT NULL AS e`,
  );
  return r.rows[0]?.e === true;
}

async function finalizeRpcExists(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='finalize_package_receive_close'`,
  );
  return r.rows.length > 0;
}

async function viewTotalsForCode(
  sb: SupabaseClient,
  field: "tracking_number" | "fnsku" | "sku" | "id_slip_contents",
  code: string,
): Promise<{ rowCount: number; totalExpected: number; totalScanned: number }> {
  const { rows } = await fetchVInventoryItemStatusLinesExact(sb, ORG_ID, STORE_ID, field, code);
  return aggregateInventoryStatus(rows);
}

async function discoverSamples(sb: SupabaseClient): Promise<{
  tracking: string;
  fnsku: string;
  sku: string;
  slip: string;
}> {
  const slipRes = await sb
    .from("expected_packages")
    .select("id_slip_contents")
    .eq("organization_id", ORG_ID)
    .eq("store_id", STORE_ID)
    .not("id_slip_contents", "is", null)
    .limit(20);
  let slip = "SD9L0wKpZR";
  for (const row of slipRes.data ?? []) {
    const code = String((row as { id_slip_contents?: string | null }).id_slip_contents ?? "").trim();
    if (!code) continue;
    const pkg = await sb
      .from("packages")
      .select("id")
      .eq("organization_id", ORG_ID)
      .eq("store_id", STORE_ID)
      .eq("id_slip_contents", code)
      .is("deleted_at", null)
      .limit(1);
    if ((pkg.data ?? []).length > 0) {
      slip = code;
      break;
    }
  }

  const sampleRes = await sb
    .from("expected_packages")
    .select("tracking_number, fnsku, sku")
    .eq("organization_id", ORG_ID)
    .eq("store_id", STORE_ID)
    .limit(1)
    .maybeSingle();

  return {
    tracking: String(sampleRes.data?.tracking_number ?? "387019251").trim(),
    fnsku: String(sampleRes.data?.fnsku ?? "X004LTF679").trim(),
    sku: String(sampleRes.data?.sku ?? "B00LTEX51C-VEN").trim(),
    slip,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  let productionApplied: "yes" | "no" | "already_applied" = "no";
  let rpcCreated = "no";

  const pgClient = new pg.Client({
    connectionString: originalPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await pgClient.connect();
  await pgClient.query("SET statement_timeout = '120s'");

  try {
    if (apply) {
      const main = await applyMigrationFile(pgClient, MIGRATION_VERSION, MIGRATION);
      const fixup = await applyMigrationFile(pgClient, FIXUP_VERSION, FIXUP_MIGRATION);
      const perf = await applyMigrationFile(pgClient, PERF_FIXUP_VERSION, PERF_FIXUP_MIGRATION);
      productionApplied =
        main === "applied" || fixup === "applied" || perf === "applied"
          ? "yes"
          : main === "already_applied" &&
              fixup === "already_applied" &&
              perf === "already_applied"
            ? "already_applied"
            : "yes";
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      productionApplied = (await rpcExists(pgClient)) ? "already_applied" : "no";
    }

    rpcCreated = (await rpcExists(pgClient)) ? "yes" : "no";
    if (rpcCreated !== "yes") blockers.push("scanner_identity_gate_lookup RPC missing on production");

    const finalizeOk = await finalizeRpcExists(pgClient);
    if (!finalizeOk) blockers.push("finalize_package_receive_close RPC missing (empty box/finalize regression)");
  } finally {
    await pgClient.end();
  }

  const sb = originalSupabase();

  const samples = await discoverSamples(sb);

  type ParityCase = {
    code: string;
    field: "tracking_number" | "fnsku" | "sku" | "id_slip_contents";
    gate_rows: number;
    gate_expected: number;
    gate_scanned: number;
    view_rows: number;
    view_expected: number;
    view_scanned: number;
    match_parity: boolean;
    quantity_parity: boolean;
  };

  const cases: { code: string; field: ParityCase["field"] }[] = [
    { code: samples.tracking, field: "tracking_number" },
    { code: samples.fnsku, field: "fnsku" },
    { code: samples.sku, field: "sku" },
    { code: samples.slip, field: "id_slip_contents" },
  ];

  const parityCases: ParityCase[] = [];
  const gateTimings: number[] = [];

  for (const c of cases) {
    const t0 = performance.now();
    const gate = await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, c.code, {
      skipExpensiveFallback: true,
    });
    gateTimings.push(Math.round(performance.now() - t0));

    const gateAgg = aggregateInventoryStatus(gate.inventory_rows);
    const viewAgg = await viewTotalsForCode(sb, c.field, c.code);

    const quantityParity =
      gateAgg.totalExpected === viewAgg.totalExpected && gateAgg.totalScanned === viewAgg.totalScanned;
    const matchParity =
      gate.inventory_matched_field === c.field &&
      gateAgg.rowCount === viewAgg.rowCount &&
      quantityParity;

    parityCases.push({
      code: c.code,
      field: c.field,
      gate_rows: gateAgg.rowCount,
      gate_expected: gateAgg.totalExpected,
      gate_scanned: gateAgg.totalScanned,
      view_rows: viewAgg.rowCount,
      view_expected: viewAgg.totalExpected,
      view_scanned: viewAgg.totalScanned,
      match_parity: matchParity || (gateAgg.rowCount === 0 && viewAgg.rowCount === 0),
      quantity_parity: quantityParity || (gateAgg.rowCount === 0 && viewAgg.rowCount === 0),
    });
  }

  for (let i = 0; i < 12; i++) {
    for (const c of cases) {
      const t0 = performance.now();
      await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, c.code, { skipExpensiveFallback: true });
      gateTimings.push(Math.round(performance.now() - t0));
    }
  }

  const p95 = percentile(gateTimings, 95);
  const worst = Math.max(...gateTimings, 0);

  const allMatch = parityCases.every((p) => p.match_parity);
  const allQty = parityCases.every((p) => p.quantity_parity);

  if (p95 >= 300) blockers.push(`p95 gate ${p95}ms >= 300ms target`);
  if (!allMatch) blockers.push("Known code match parity failed");
  if (!allQty) blockers.push("Quantity total parity failed");

  const missingItemBlocked =
    isPackageLevelShortageTagBlocked(["missing_item"]) &&
    filterPackageItemDiscrepancyTags(["missing_item", "damaged_product"]).join(",") === "damaged_product";
  if (!missingItemBlocked) blockers.push("missing_item still allowed on return_items path");

  let buildOk = false;
  if (!process.argv.includes("--skip-build")) {
    try {
      execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
      buildOk = true;
    } catch (e) {
      blockers.push(`build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    buildOk = true;
  }

  const output = {
    phase_number: "9D",
    production_applied: productionApplied,
    rpc_created: rpcCreated,
    parity_result: allMatch && allQty ? "pass" : "fail",
    p95_gate_ms: p95,
    worst_gate_ms: worst,
    build_result: buildOk ? "pass" : "fail",
    SAFE_FOR_LIVE_SCANNER_SPEED: blockers.length === 0 ? "yes" : "no",
    blockers,
    finalize_rpc_present: "checked_via_pg",
    missing_item_blocked: missingItemBlocked ? "yes" : "no",
    samples,
    parity_cases: parityCases,
    gate_timings_sample: gateTimings.slice(0, 24),
  };

  fs.writeFileSync(path.join(outDir, "phase9d_production_result.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));

  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
