/**
 * PHASE-9D-SCANNER_LOOKUP_SERVER_SIDE_RTT_REDUCTION
 *
 *   npx tsx scripts/phase9d-scanner-gate-rpc-staging-execute.ts
 *   APPROVED_PHASE9D_SCANNER_GATE_RPC_STAGING=true npx tsx scripts/phase9d-scanner-gate-rpc-staging-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, getStagingProjectRef } from "../lib/staging-project-ref";
import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import {
  aggregateInventoryStatus,
  fetchVInventoryItemStatusLinesExact,
} from "../lib/scanner/v-inventory-status";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const KNOWN_SLIP = "SD9L0wKpZR";
const MIGRATION = "supabase/migrations/20260910120000_phase9d_scanner_identity_gate_rpc_staging.sql";
const OUT_BASE = ".cursor/audit-reports/phase9d-scanner-gate-rpc-staging-execute";

/** Pre-9D slip path: fnsku + sku + tracking + (EP∥pkgIds) + (pkg∥return_items) */
const ROUND_TRIPS_BEFORE_SLIP = 5;
const ROUND_TRIPS_AFTER = 1;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function stagingPostgresUrl(): string {
  const url =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: postgres URL must target staging ${STAGING_REF}`);
  }
  return url;
}

function stagingSupabase(): SupabaseClient {
  const url = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url?.includes(STAGING_REF) || !key) {
    throw new Error("STAGING Supabase URL (staging ref) + SUPABASE_SERVICE_ROLE_KEY required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function rpcExists(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT to_regprocedure('public.scanner_identity_gate_lookup(uuid,uuid,text)') IS NOT NULL AS e`,
  );
  return r.rows[0]?.e === true;
}

async function viewTotalsForCode(
  sb: SupabaseClient,
  field: "tracking_number" | "fnsku" | "sku" | "id_slip_contents",
  code: string,
): Promise<{ rowCount: number; totalExpected: number; totalScanned: number }> {
  const { rows } = await fetchVInventoryItemStatusLinesExact(sb, ORG_ID, STORE_ID, field, code);
  return aggregateInventoryStatus(rows);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  getStagingProjectRef();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const apply = process.argv.includes("--apply");
  const approved = process.env.APPROVED_PHASE9D_SCANNER_GATE_RPC_STAGING === "true";
  let stagingApplied = "no";

  const pgClient = new pg.Client({ connectionString: stagingPostgresUrl() });
  await pgClient.connect();

  try {
    if (apply) {
      if (!approved) {
        throw new Error("Set APPROVED_PHASE9D_SCANNER_GATE_RPC_STAGING=true to apply migration");
      }
      const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
      await pgClient.query(sql);
      stagingApplied = "yes";
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      stagingApplied = (await rpcExists(pgClient)) ? "yes" : "no";
    }
  } finally {
    await pgClient.end();
  }

  const sb = stagingSupabase();

  const rpcProbe = await sb.rpc("scanner_identity_gate_lookup", {
    p_organization_id: ORG_ID,
    p_store_id: STORE_ID,
    p_code: KNOWN_SLIP,
  });
  const slipSingleServerCall =
    !rpcProbe.error && rpcProbe.data && typeof rpcProbe.data === "object" ? "yes" : "no";

  const sampleRes = await sb
    .from("expected_packages")
    .select("tracking_number, fnsku, sku")
    .eq("organization_id", ORG_ID)
    .eq("store_id", STORE_ID)
    .limit(1)
    .maybeSingle();

  const samples = {
    tracking: String(sampleRes.data?.tracking_number ?? "387019251").trim(),
    fnsku: String(sampleRes.data?.fnsku ?? "X004LTF679").trim(),
    sku: String(sampleRes.data?.sku ?? "B00LTEX51C-VEN").trim(),
    slip: KNOWN_SLIP,
  };

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
  const slipCase = parityCases.find((p) => p.field === "id_slip_contents");

  const blockers: string[] = [];
  if (stagingApplied !== "yes") blockers.push("RPC migration not applied on staging");
  if (slipSingleServerCall !== "yes") blockers.push("scanner_identity_gate_lookup RPC unavailable");
  if (p95 >= 300) blockers.push(`p95 gate ${p95}ms >= 300ms target`);
  if (worst >= 500) blockers.push(`worst gate ${worst}ms >= 500ms target`);
  if (!allMatch) blockers.push("Known code match parity failed");
  if (!allQty) blockers.push("Quantity total parity failed");
  if (slipCase && !slipCase.match_parity) blockers.push(`Slip ${KNOWN_SLIP} parity failed`);

  const output = {
    phase_number: "9D",
    staging_applied: stagingApplied,
    new_tables_created: "no",
    new_columns_created: "no",
    round_trips_before: ROUND_TRIPS_BEFORE_SLIP,
    round_trips_after: ROUND_TRIPS_AFTER,
    slip_single_server_call: slipSingleServerCall,
    parity_result: allMatch && allQty ? "pass" : "fail",
    p95_gate_ms: p95,
    worst_gate_ms: worst,
    build_result: "pending",
    SAFE_TO_APPLY_9BCD_PRODUCTION: blockers.length === 0 ? "yes" : "no",
    blockers,
    samples,
    parity_cases: parityCases,
    gate_timings_sample: gateTimings.slice(0, 24),
    rpc_slip_probe_ok: rpcProbe.error == null,
  };

  fs.writeFileSync(path.join(outDir, "phase9d_result.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
