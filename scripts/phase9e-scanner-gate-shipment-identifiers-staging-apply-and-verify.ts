/**
 * PHASE-9E-SCANNER-GATE-SHIPMENT-IDENTIFIERS-STAGING
 *
 *   npx tsx scripts/phase9e-scanner-gate-shipment-identifiers-staging-apply-and-verify.ts
 *   APPROVED_PHASE9E_SCANNER_GATE_STAGING=true npx tsx scripts/phase9e-scanner-gate-shipment-identifiers-staging-apply-and-verify.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, getStagingProjectRef } from "../lib/staging-project-ref";
import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import type { ScannerIdentityGateMatchType } from "../lib/scanner/scanner-identity-gate-rpc";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const KNOWN_SLIP = "SD9L0wKpZR";
const MIGRATION = "supabase/migrations/20260911120000_phase9e_scanner_gate_shipment_identifiers_staging.sql";
const OUT_BASE = ".cursor/audit-reports/phase9e-scanner-gate-shipment-identifiers-staging";

const MATCH_PRIORITY_ORDER: ScannerIdentityGateMatchType[] = [
  "tracking",
  "package_code",
  "slip_code",
  "amazon_order_id",
  "removal_order_id",
  "shipment_id",
  "product_identifier_fallback",
];

const INDEX_NAMES = [
  "idx_packages_org_store_package_code",
  "idx_ep_org_store_order_id",
  "idx_packages_org_store_order_id",
  "idx_shipment_boxes_org_store_box_code",
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
  package_code: string;
  slip: string;
  amazon_order_id: string;
  removal_order_id: string;
  fnsku: string;
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
      (SELECT ep.fnsku FROM expected_packages ep
        WHERE ep.organization_id = $1 AND ep.store_id = $2
          AND ep.fnsku IS NOT NULL AND btrim(ep.fnsku) <> ''
        ORDER BY ep.id LIMIT 1) AS fnsku
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
    fnsku: String(row.fnsku ?? "").trim(),
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

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  getStagingProjectRef();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const apply = process.argv.includes("--apply");
  const approved = process.env.APPROVED_PHASE9E_SCANNER_GATE_STAGING === "true";
  let stagingApplied = "no";

  const pgClient = new pg.Client({ connectionString: stagingPostgresUrl() });
  await pgClient.connect();

  const indexCoverage: Record<string, boolean> = {};
  try {
    if (apply) {
      if (!approved) {
        throw new Error("Set APPROVED_PHASE9E_SCANNER_GATE_STAGING=true to apply migration");
      }
      const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
      await pgClient.query(sql);
      stagingApplied = "yes";
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      const rpcR = await pgClient.query(
        `SELECT to_regprocedure('public.scanner_identity_gate_lookup(uuid,uuid,text)') IS NOT NULL AS e`,
      );
      stagingApplied = rpcR.rows[0]?.e === true ? "yes" : "no";
    }

    for (const idx of INDEX_NAMES) {
      indexCoverage[idx] = await indexExists(pgClient, idx);
    }
  } finally {
    await pgClient.end();
  }

  const sb = stagingSupabase();
  const pgSamples = new pg.Client({ connectionString: stagingPostgresUrl() });
  await pgSamples.connect();
  const samplesFixed = await sampleCodes(pgSamples);
  await pgSamples.end();

  const gateTimings: number[] = [];

  const trackingRpc = await rpcLookup(sb, samplesFixed.tracking);
  const slipRpc = await rpcLookup(sb, samplesFixed.slip);
  const packageRpc = samplesFixed.package_code
    ? await rpcLookup(sb, samplesFixed.package_code)
    : { match_type: null, matched_field: null, row_count: 0, error: "no sample" };
  const amazonRpc = samplesFixed.amazon_order_id
    ? await rpcLookup(sb, samplesFixed.amazon_order_id)
    : { match_type: null, matched_field: null, row_count: 0, error: "no sample" };
  const removalRpc = samplesFixed.removal_order_id
    ? await rpcLookup(sb, samplesFixed.removal_order_id)
    : { match_type: null, matched_field: null, row_count: 0, error: "no sample" };
  const fnskuRpc = samplesFixed.fnsku ? await rpcLookup(sb, samplesFixed.fnsku) : null;

  const productDemoted =
    samplesFixed.fnsku
      ? (async () => {
          const gate = await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, samplesFixed.fnsku, {
            skipExpensiveFallback: true,
          });
          return gate.inventory_rows.length === 0 && gate.inventory_matched_field == null;
        })()
      : Promise.resolve(true);

  const productDemotedResult = await productDemoted;

  for (let i = 0; i < 16; i++) {
    for (const code of [samplesFixed.tracking, samplesFixed.slip, samplesFixed.package_code].filter(Boolean)) {
      const t0 = performance.now();
      await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, code, { skipExpensiveFallback: true });
      gateTimings.push(Math.round(performance.now() - t0));
    }
  }

  const p95 = percentile(gateTimings, 95);
  const worst = Math.max(...gateTimings, 0);

  const blockers: string[] = [];
  if (stagingApplied !== "yes") blockers.push("Phase 9E migration not applied on staging");
  for (const [idx, ok] of Object.entries(indexCoverage)) {
    if (!ok) blockers.push(`missing index ${idx}`);
  }
  if (trackingRpc.match_type !== "tracking") blockers.push(`tracking sample match_type=${trackingRpc.match_type}`);
  if (slipRpc.match_type !== "slip_code") blockers.push(`slip sample match_type=${slipRpc.match_type}`);
  if (samplesFixed.package_code && packageRpc.match_type !== "package_code") {
    blockers.push(`package_code sample match_type=${packageRpc.match_type}`);
  }
  if (samplesFixed.amazon_order_id && amazonRpc.match_type !== "amazon_order_id") {
    blockers.push(`amazon_order_id sample match_type=${amazonRpc.match_type}`);
  }
  if (samplesFixed.removal_order_id && removalRpc.match_type !== "removal_order_id") {
    blockers.push(`removal_order_id sample match_type=${removalRpc.match_type}`);
  }
  if (fnskuRpc && fnskuRpc.match_type !== "product_identifier_fallback") {
    blockers.push(`fnsku fallback match_type=${fnskuRpc.match_type}`);
  }
  if (!productDemotedResult) blockers.push("product identifier not demoted at shipment entry gate");
  if (p95 >= 150) blockers.push(`p95 gate ${p95}ms >= 150ms target`);
  if (worst >= 300) blockers.push(`worst gate ${worst}ms >= 300ms target`);

  let buildResult = "pending";
  try {
    const { execSync } = await import("node:child_process");
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe" });
    buildResult = "PASS";
  } catch (e) {
    buildResult = "FAIL";
    blockers.push(`build failed: ${String((e as { message?: string })?.message ?? e)}`);
  }

  const output = {
    phase_number: "9E",
    staging_applied: stagingApplied,
    new_tables_created: "no",
    new_columns_created: "no",
    identifier_coverage: {
      tracking: trackingRpc,
      package_code: packageRpc,
      slip_code: slipRpc,
      amazon_order_id: amazonRpc,
      removal_order_id: removalRpc,
      product_fallback: fnskuRpc,
      indexes: indexCoverage,
    },
    match_priority_order: MATCH_PRIORITY_ORDER,
    product_identifiers_demoted: productDemotedResult ? "yes" : "no",
    package_code_result:
      !samplesFixed.package_code
        ? "SKIP_NO_SAMPLE"
        : packageRpc.match_type === "package_code"
          ? "PASS"
          : "FAIL",
    amazon_order_id_result:
      !samplesFixed.amazon_order_id
        ? "SKIP_NO_SAMPLE"
        : amazonRpc.match_type === "amazon_order_id"
          ? "PASS"
          : "FAIL",
    removal_order_id_result:
      !samplesFixed.removal_order_id
        ? "SKIP_NO_SAMPLE"
        : removalRpc.match_type === "removal_order_id"
          ? "PASS"
          : "FAIL",
    p95_gate_ms: p95,
    worst_gate_ms: worst,
    build_result: buildResult,
    SAFE_TO_APPLY_9E_PRODUCTION: blockers.length === 0 ? "yes" : "no",
    blockers,
    samples: samplesFixed,
    gate_timings_sample: gateTimings.slice(0, 24),
  };

  fs.writeFileSync(path.join(outDir, "phase9e_result.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
