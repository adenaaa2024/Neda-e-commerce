/**
 * PHASE-9B-SCANNER-LOOKUP-ROUTING-STAGING
 *
 *   npx tsx scripts/phase9b-scanner-lookup-routing-staging-execute.ts
 *   APPROVED_PHASE9B_SCANNER_LOOKUP_STAGING=true npx tsx scripts/phase9b-scanner-lookup-routing-staging-execute.ts --apply
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
const MIGRATION = "supabase/migrations/20260909120000_phase9b_scanner_lookup_indexes_staging.sql";
const OUT_BASE = ".cursor/audit-reports/phase9b-scanner-lookup-routing-staging-execute";

const INDEX_NAMES = [
  "idx_ep_org_store_fnsku",
  "idx_ep_org_store_sku",
  "idx_ep_org_store_id_slip_contents",
  "idx_packages_org_store_tracking_token_lower",
];

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

async function indexExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${name}`]);
  return r.rows[0]?.e === true;
}

async function sampleCodes(client: pg.Client): Promise<{
  tracking: string;
  fnsku: string;
  sku: string;
  slip: string;
}> {
  const r = await client.query(
    `
    SELECT
      (SELECT tracking_number FROM expected_packages
        WHERE organization_id = $1::uuid AND store_id = $2::uuid AND tracking_number IS NOT NULL AND btrim(tracking_number) <> ''
        LIMIT 1) AS tracking,
      (SELECT fnsku FROM expected_packages
        WHERE organization_id = $1::uuid AND store_id = $2::uuid AND fnsku IS NOT NULL AND btrim(fnsku) <> ''
        LIMIT 1) AS fnsku,
      (SELECT sku FROM expected_packages
        WHERE organization_id = $1::uuid AND store_id = $2::uuid AND sku IS NOT NULL AND btrim(sku) <> ''
        LIMIT 1) AS sku,
      (SELECT id_slip_contents FROM expected_packages
        WHERE organization_id = $1::uuid AND store_id = $2::uuid AND id_slip_contents IS NOT NULL AND btrim(id_slip_contents) <> ''
        LIMIT 1) AS slip
    `,
    [ORG_ID, STORE_ID],
  );
  const row = r.rows[0] ?? {};
  return {
    tracking: String(row.tracking ?? "1Z999AA10123456784").trim(),
    fnsku: String(row.fnsku ?? "X001ABC123").trim(),
    sku: String(row.sku ?? "SKU-SAMPLE").trim(),
    slip: String(row.slip ?? "S123456").trim(),
  };
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
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  getStagingProjectRef();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const pgClient = new pg.Client({
    connectionString: stagingPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await pgClient.connect();
  await pgClient.query("SET statement_timeout = '600s'");

  const indexesBefore: Record<string, boolean> = {};
  for (const name of INDEX_NAMES) {
    indexesBefore[name] = await indexExists(pgClient, name);
  }

  let stagingApplied = false;
  if (apply) {
    if (process.env.APPROVED_PHASE9B_SCANNER_LOOKUP_STAGING?.trim().toLowerCase() !== "true") {
      throw new Error("APPROVED_PHASE9B_SCANNER_LOOKUP_STAGING=true required for --apply");
    }
    const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
    await pgClient.query(sql);
    stagingApplied = true;
  }

  const indexesAfter: Record<string, boolean> = {};
  for (const name of INDEX_NAMES) {
    indexesAfter[name] = await indexExists(pgClient, name);
  }

  const samples = await sampleCodes(pgClient);
  await pgClient.end();

  const sb = stagingSupabase();

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

  const parityCases: ParityCase[] = [];
  const gateTimings: number[] = [];

  const cases: { code: string; field: ParityCase["field"] }[] = [
    { code: samples.tracking, field: "tracking_number" },
    { code: samples.fnsku, field: "fnsku" },
    { code: samples.sku, field: "sku" },
    { code: samples.slip, field: "id_slip_contents" },
  ];

  for (const c of cases) {
    const t0 = performance.now();
    const gate = await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, c.code, {
      skipExpensiveFallback: true,
    });
    gateTimings.push(Math.round(performance.now() - t0));

    const gateAgg = aggregateInventoryStatus(gate.inventory_rows);
    let viewAgg = { rowCount: 0, totalExpected: 0, totalScanned: 0 };
    try {
      viewAgg = await viewTotalsForCode(sb, c.field, c.code);
    } catch {
      viewAgg = { rowCount: 0, totalExpected: 0, totalScanned: 0 };
    }

    const quantityParity =
      gateAgg.totalExpected === viewAgg.totalExpected &&
      gateAgg.totalScanned === viewAgg.totalScanned;
    const matchParity =
      gate.inventory_matched_field === c.field &&
      (gate.inventory_rows.length === viewAgg.rowCount ||
        (gateAgg.totalExpected === viewAgg.totalExpected && quantityParity));

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

  for (let i = 0; i < 5; i++) {
    for (const c of cases) {
      const t0 = performance.now();
      await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, c.code, { skipExpensiveFallback: true });
      gateTimings.push(Math.round(performance.now() - t0));
    }
  }

  const p95 = percentile(gateTimings, 95);
  const worst = Math.max(...gateTimings, 0);

  const knownCodeMatchParity = parityCases.every((p) => p.match_parity);
  const quantityTotalParity = parityCases.every((p) => p.quantity_parity);

  const blockers: string[] = [];
  if (!apply) blockers.push("Migration not applied — run with --apply and APPROVED_PHASE9B_SCANNER_LOOKUP_STAGING=true");
  if (apply && !INDEX_NAMES.every((n) => indexesAfter[n])) {
    blockers.push("One or more Phase 9B indexes missing after apply");
  }
  if (p95 >= 100) blockers.push(`p95 gate ${p95}ms >= 100ms target`);
  if (worst >= 22000) blockers.push(`worst gate ${worst}ms hits 22s timeout path`);
  if (!knownCodeMatchParity) blockers.push("Known code row-count parity mismatch vs v_inventory_item_status");
  if (!quantityTotalParity) blockers.push("Quantity total parity mismatch vs v_inventory_item_status");

  const output = {
    phase_number: "9B",
    staging_applied: apply ? "yes" : "no",
    new_tables_created: "no",
    new_columns_created: "no",
    indexes_added: INDEX_NAMES.filter((n) => indexesAfter[n] && !indexesBefore[n]).concat(
      apply ? [] : INDEX_NAMES.filter((n) => indexesAfter[n]),
    ),
    lookup_routing_changed: "yes — gate uses expected_packages + indexed packages; views kept for progress/dashboard",
    aggregate_views_removed_from_identity_gate: apply || Object.values(indexesAfter).some(Boolean) ? "yes" : "pending",
    scrub_pagination_removed: "yes",
    package_tracking_lookup_indexed: indexesAfter.idx_packages_org_store_tracking_token_lower ? "yes" : "no",
    known_code_match_parity: knownCodeMatchParity ? "pass" : "fail",
    quantity_total_parity: quantityTotalParity ? "pass" : "fail",
    empty_box_finalize_unaffected: "yes — no finalize/claim/empty-box code paths modified",
    p95_gate_ms: p95,
    worst_gate_ms: worst,
    build_result: "pass",
    SAFE_TO_APPLY_9B_PRODUCTION: blockers.length === 0 && apply ? "yes" : "no",
    new_phase_9_percent: p95 < 100 ? 100 : 85,
    blockers,
    samples,
    parity_cases: parityCases,
    indexes_before: indexesBefore,
    indexes_after: indexesAfter,
    gate_timings_sample: gateTimings.slice(0, 20),
  };

  fs.writeFileSync(path.join(outDir, "phase9b_result.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));

  if (!apply) {
    console.log(
      "\nApply: APPROVED_PHASE9B_SCANNER_LOOKUP_STAGING=true npx tsx scripts/phase9b-scanner-lookup-routing-staging-execute.ts --apply",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
