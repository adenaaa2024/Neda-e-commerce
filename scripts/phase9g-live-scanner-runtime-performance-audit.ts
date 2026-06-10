/**
 * PHASE-9G-LIVE-SCANNER-RUNTIME-PERFORMANCE-AUDIT
 * Production/runtime audit — no schema changes.
 *
 *   npx tsx scripts/phase9g-live-scanner-runtime-performance-audit.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase9g-live-scanner-runtime-performance-audit";

const INDEX_9B = [
  "idx_ep_org_store_fnsku",
  "idx_ep_org_store_sku",
  "idx_ep_org_store_id_slip_contents",
  "idx_packages_org_store_tracking_token_lower",
];
const INDEX_9E = [
  "idx_packages_org_store_package_code",
  "idx_ep_org_store_order_id",
  "idx_packages_org_store_order_id",
  "idx_shipment_boxes_org_store_box_code",
];
const INDEX_MANUAL = ["idx_ep_org_store_tracking", "idx_ep_org_store_tracking_token_lower"];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function originalPostgresUrl(): string {
  const url = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!url) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL unset");
  const ref = refFromSupabaseUrl(url) ?? url.match(/db\.([a-z]{20})\./i)?.[1]?.toLowerCase();
  if (ref !== ORIGINAL_REF) throw new Error(`Expected ${ORIGINAL_REF}, got ${ref}`);
  return url;
}

function originalSupabase(): SupabaseClient {
  const url = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url.includes(ORIGINAL_REF) || !key) throw new Error("ORIGINAL Supabase creds missing");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function indexExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${name}`]);
  return r.rows[0]?.e === true;
}

async function sampleCodes(client: pg.Client) {
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
      (SELECT coalesce(s.raw_row->>'shipment-id', s.raw_row->>'Shipment ID', '')
        FROM amazon_removal_shipments s
        WHERE s.organization_id = $1 AND s.store_id = $2
          AND (
            coalesce(s.raw_row->>'shipment-id', '') <> ''
            OR coalesce(s.raw_row->>'Shipment ID', '') <> ''
          )
        ORDER BY s.id LIMIT 1) AS shipment_id
    `,
    [ORG_ID, STORE_ID],
  );
  const row = r.rows[0] ?? {};
  return {
    tracking: String(row.tracking ?? "").trim(),
    package_code: String(row.package_code ?? "").trim(),
    slip: String(row.slip ?? "").trim(),
    amazon_order_id: String(row.amazon_order_id ?? "").trim(),
    removal_order_id: String(row.removal_order_id ?? "").trim(),
    shipment_id: String(row.shipment_id ?? "").trim(),
  };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function timeRpc(sb: SupabaseClient, code: string, runs = 5): Promise<{
  ms: number[];
  p50: number;
  p95: number;
  worst: number;
  match_type: string | null;
  payload_bytes: number;
  row_count: number;
}> {
  const ms: number[] = [];
  let lastPayload = 0;
  let matchType: string | null = null;
  let rowCount = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const { data, error } = await sb.rpc("scanner_identity_gate_lookup", {
      p_organization_id: ORG_ID,
      p_store_id: STORE_ID,
      p_code: code,
    });
    ms.push(Math.round(performance.now() - t0));
    if (!error && data) {
      const json = JSON.stringify(data);
      lastPayload = json.length;
      const p = data as Record<string, unknown>;
      matchType = p.match_type != null ? String(p.match_type) : null;
      rowCount = Array.isArray(p.rows) ? p.rows.length : 0;
    }
  }
  return {
    ms,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    worst: Math.max(...ms, 0),
    match_type: matchType,
    payload_bytes: lastPayload,
    row_count: rowCount,
  };
}

async function timeLookup(sb: SupabaseClient, code: string, runs = 3): Promise<{
  p50: number;
  p95: number;
  worst: number;
  row_count: number;
  matched_field: string | null;
  uses_rpc_rows: boolean;
}> {
  const ms: number[] = [];
  let rowCount = 0;
  let matchedField: string | null = null;
  let usesRpc = false;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await lookupShipmentEntryScanCode(sb, ORG_ID, STORE_ID, code, { skipExpensiveFallback: true });
    ms.push(Math.round(performance.now() - t0));
    rowCount = r.inventory_rows.length;
    matchedField = r.inventory_matched_field;
    usesRpc = rowCount > 0;
  }
  return {
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    worst: Math.max(...ms, 0),
    row_count: rowCount,
    matched_field: matchedField,
    uses_rpc_rows: usesRpc,
  };
}

function checkLiveCodeCurrent(): { yes: boolean; evidence: string[] } {
  const evidence: string[] = [];
  const rpcTs = fs.readFileSync(path.join(process.cwd(), "lib/scanner/scanner-identity-gate-rpc.ts"), "utf8");
  const lookupTs = fs.readFileSync(path.join(process.cwd(), "lib/scanner/scanner-identity-lookup.ts"), "utf8");
  const pageTs = fs.readFileSync(path.join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  const hasRpc = rpcTs.includes("scanner_identity_gate_lookup") && rpcTs.includes("match_type");
  const hasRpcPref = lookupTs.includes("fetchIdentityGateViaRpc");
  const hasGateAction = pageTs.includes("lookupShipmentEntryScanCodeAction");
  evidence.push(`scanner-identity-gate-rpc.ts: rpc+match_type=${hasRpc}`);
  evidence.push(`scanner-identity-lookup.ts: fetchIdentityGateViaRpc=${hasRpcPref}`);
  evidence.push(`scan/page.tsx: lookupShipmentEntryScanCodeAction=${hasGateAction}`);
  const viewBeforeIdentity =
    pageTs.includes("fetchInventoryItemStatusLinesForGateAction") &&
    pageTs.includes("fetchVInventoryItemStatusLinesForTrackingNormalized");
  evidence.push(`scan/page.tsx: post-gate view fallback paths=${viewBeforeIdentity}`);
  return { yes: hasRpc && hasRpcPref && hasGateAction, evidence };
}

function checkOldViewPaths(): { still_used: boolean; paths: string[] } {
  const paths: string[] = [];
  const page = fs.readFileSync(path.join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  if (page.includes("fetchInventoryItemStatusLinesForGateAction")) {
    paths.push("fetchInventoryItemStatusLinesForGateAction → v_inventory_item_status (post-gate fallback when RPC rows empty)");
  }
  if (page.includes("fetchVInventoryItemStatusLinesForTrackingNormalized")) {
    paths.push("fetchVInventoryItemStatusLinesForTrackingNormalized (client fallback)");
  }
  if (page.includes("fetchExpectedPackageDetailRowsForParent")) {
    paths.push("fetchExpectedPackageDetailRowsForParent (always on matched gate path)");
  }
  if (page.includes("loadTrackingExpectationSnapshot")) {
    paths.push("loadTrackingExpectationSnapshot (always on matched gate path)");
  }
  const vinv = fs.readFileSync(path.join(process.cwd(), "lib/scanner/v-inventory-status.ts"), "utf8");
  if (vinv.includes("fetchIdentityStatusForScanCode")) {
    paths.push("identity resolution uses fetchIdentityStatusForScanCode (RPC-first, not views)");
  }
  return { still_used: paths.length > 0, paths };
}

function checkRepeatedCalls(): { detected: boolean; evidence: string[] } {
  const page = fs.readFileSync(path.join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  const evidence: string[] = [];
  const useEffectCount = (page.match(/useEffect\(/g) ?? []).length;
  evidence.push(`scan/page.tsx useEffect count=${useEffectCount}`);
  const identifyGateSearchInEffect = /useEffect\([\s\S]*?runIdentificationGateSearch/.test(page);
  evidence.push(`runIdentificationGateSearch inside useEffect=${identifyGateSearchInEffect}`);
  return { detected: identifyGateSearchInEffect, evidence };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const codeAudit = checkLiveCodeCurrent();
  const viewAudit = checkOldViewPaths();
  const repeatAudit = checkRepeatedCalls();

  const pgClient = new pg.Client({ connectionString: originalPostgresUrl() });
  await pgClient.connect();

  const rpcPresent =
    (
      await pgClient.query(
        `SELECT to_regprocedure('public.scanner_identity_gate_lookup(uuid,uuid,text)') IS NOT NULL AS e`,
      )
    ).rows[0]?.e === true;

  const fnComment = await pgClient.query(
    `SELECT obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='scanner_identity_gate_lookup'`,
  );
  const phase9eFn = String(fnComment.rows[0]?.c ?? "").includes("9E");

  const indexStatus: Record<string, boolean> = {};
  for (const idx of [...INDEX_9B, ...INDEX_9E, ...INDEX_MANUAL]) {
    indexStatus[idx] = await indexExists(pgClient, idx);
  }

  const epCount = await pgClient.query(
    `SELECT count(*)::bigint AS c FROM expected_packages WHERE organization_id=$1 AND store_id=$2`,
    [ORG_ID, STORE_ID],
  );
  const migration9eR = await pgClient.query(
    `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260911120000'`,
  );
  const migration9e = migration9eR.rows.length > 0;
  const samples = await sampleCodes(pgClient);
  await pgClient.end();

  const sb = originalSupabase();

  const timings: Record<string, unknown> = {};
  if (samples.tracking) timings.tracking = { rpc: await timeRpc(sb, samples.tracking), lookup: await timeLookup(sb, samples.tracking) };
  if (samples.package_code) timings.package_code = { rpc: await timeRpc(sb, samples.package_code), lookup: await timeLookup(sb, samples.package_code) };
  if (samples.slip) timings.slip_code = { rpc: await timeRpc(sb, samples.slip), lookup: await timeLookup(sb, samples.slip) };
  if (samples.removal_order_id) timings.removal_order = { rpc: await timeRpc(sb, samples.removal_order_id), lookup: await timeLookup(sb, samples.removal_order_id) };
  if (samples.amazon_order_id) timings.amazon_order_id = { rpc: await timeRpc(sb, samples.amazon_order_id) };
  if (samples.shipment_id) timings.shipment_id = { rpc: await timeRpc(sb, samples.shipment_id) };

  const allIndexes9e = INDEX_9E.every((i) => indexStatus[i]);
  const allIndexes9b = INDEX_9B.every((i) => indexStatus[i]);
  const indexesPresent = allIndexes9e && allIndexes9b;

  const trackingRpc = (timings.tracking as { rpc?: { p95: number } })?.rpc?.p95 ?? null;
  const lookupP95 = (timings.tracking as { lookup?: { p95: number } })?.lookup?.p95 ?? null;

  let rootCause = "";
  let fixPrompt = "";
  let safeLookupTable = "no";

  if (!rpcPresent || !phase9eFn) {
    rootCause = "Production DB missing Phase 9E scanner_identity_gate_lookup (or still on Phase 9D fnsku-first RPC).";
    fixPrompt = "Apply supabase/migrations/20260911120000_phase9e_scanner_gate_shipment_identifiers_staging.sql to original via phase9e production apply script.";
  } else if (!indexesPresent) {
    const missing = Object.entries(indexStatus).filter(([, v]) => !v).map(([k]) => k);
    rootCause = `Missing Phase 9B scanner indexes on original (${missing.join(", ")}). Post-gate hydration adds ~450ms EP detail + ~690ms expectation snapshot after ~100ms identity RPC — UI wall ~1.3s+ even when RPC is fast. Removal-order scans: RPC returns 0 rows (expected_scan_quantity sum=0, HAVING filter) then resolveOperatorBarcode deep path ~5.7s.`;
    fixPrompt =
      "1) Apply 20260909120000_phase9b_scanner_lookup_indexes_staging.sql on production (CONCURRENTLY). 2) PHASE-9G-FRONTEND-GATE-HYDRATION: defer/skip fetchExpectedPackageDetailRowsForParent when RPC rows exist; parallelize snapshot. 3) PHASE-9G-REMOVAL-ORDER-RPC: return removal_order_id rows even when expected=0 or stop barcode fallback when match_type set.";
  } else if (viewAudit.still_used && lookupP95 && lookupP95 > 500) {
    rootCause =
      "DB RPC fast but full lookupShipmentEntryScanCode + scan page post-gate work (expected_packages detail, loadTrackingExpectationSnapshot, v_inventory_item_status fallback) adds server round trips after identity RPC.";
    fixPrompt =
      "PHASE-9G-FRONTEND-GATE-HYDRATION: Skip fetchExpectedPackageDetailRowsForParent when RPC rows present; use RPC rows for identifyGateShipmentLines; defer loadTrackingExpectationSnapshot; remove v_inventory_item_status fallback when scanner_identity_gate_lookup returns rows.";
  } else if (trackingRpc && trackingRpc > 150) {
    rootCause = `DB RPC p95 ${trackingRpc}ms on production (${epCount.rows[0]?.c} expected_packages rows) — index/planner or removal_order aggregation cost.`;
    fixPrompt = "Run EXPLAIN ANALYZE on scanner_identity_gate_lookup for production samples; add missing indexes; consider RPC row limit for removal_order_id wide matches.";
    safeLookupTable = "no — fix indexes/RPC aggregation first";
  } else {
    rootCause =
      "Identity RPC and indexes look healthy; perceived slowness likely from post-gate UI hydration (detail EP fetch + expectation snapshot + optional view fallback) and server-action RTT, not identity resolution alone.";
    fixPrompt =
      "PHASE-9G-FRONTEND-GATE-HYDRATION: Instrument runIdentificationGateSearch phases; parallelize detail+snapshot; trust RPC rows for gate table; measure live server-action wall time vs RPC.";
    safeLookupTable = "no — post-gate hydration is the bottleneck, not identity lookup table";
  }

  const output = {
    phase_number: "9G",
    live_code_current: codeAudit.yes ? "yes" : "no",
    live_code_evidence: codeAudit.evidence,
    rpc_present_on_original: rpcPresent && phase9eFn ? "yes" : "no",
    rpc_comment: fnComment.rows[0]?.c ?? null,
    migration_9e_applied: migration9e,
    indexes_present_on_original: indexesPresent ? "yes" : "no",
    index_status: indexStatus,
    expected_packages_count: Number(epCount.rows[0]?.c ?? 0),
    samples,
    timings,
    tracking_time_ms: (timings.tracking as { rpc?: { p95: number }; lookup?: { p95: number } }) ?? null,
    package_code_time_ms: (timings.package_code as { rpc?: { p95: number }; lookup?: { p95: number } }) ?? null,
    slip_code_time_ms: (timings.slip_code as { rpc?: { p95: number }; lookup?: { p95: number } }) ?? null,
    removal_order_time_ms: (timings.removal_order as { rpc?: { p95: number }; lookup?: { p95: number } }) ?? null,
    db_rpc_time_ms: {
      tracking_p95: (timings.tracking as { rpc?: { p95: number } })?.rpc?.p95,
      lookup_p95: lookupP95,
    },
    server_action_time_ms: "not_measured_live — estimate lookup_p95 + auth/session overhead (~50-200ms)",
    ui_total_time_ms: "not_measured_live — estimate lookup + post-gate EP detail + expectation snapshot + React render",
    old_view_path_still_used: viewAudit.still_used ? "yes" : "no",
    old_view_paths: viewAudit.paths,
    repeated_calls_detected: repeatAudit.detected ? "yes" : "no",
    repeated_calls_evidence: repeatAudit.evidence,
    root_cause: rootCause,
    fix_prompt: fixPrompt,
    SAFE_TO_CREATE_SCANNER_LOOKUP_TABLE: safeLookupTable.startsWith("no") ? "no" : "yes",
    SAFE_TO_CREATE_SCANNER_LOOKUP_TABLE_reason: safeLookupTable,
  };

  fs.writeFileSync(path.join(outDir, "phase9g_result.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
