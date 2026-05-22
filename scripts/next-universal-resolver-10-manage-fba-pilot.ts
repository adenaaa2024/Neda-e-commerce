/**
 * NEXT-UNIVERSAL-RESOLVER-10 — Bounded amazon_manage_fba_inventory pilot (verify + optional Lane B).
 *
 * Usage:
 *   npx tsx scripts/next-universal-resolver-10-manage-fba-pilot.ts --run-id=20260514T170500Z
 *   npx tsx scripts/next-universal-resolver-10-manage-fba-pilot.ts --run-id=... --execute-lane-b
 *
 * Default: verify-only (dry run), persist resolver_incremental_last_run to raw_report_uploads metadata.
 * Lane B execute: only with --execute-lane-b AND preflight ambiguity ratio <= max (default 0.12).
 *
 * Sets process env mirrors for operators / log scrapers (no whole-table sweep; upload-scoped).
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { emitResolverIncrementalObservabilityJsonLine } from "../lib/amazon-resolver-incremental-observability";
import { runIncrementalResolverForUpload } from "../lib/amazon-resolver-incremental-orchestrator";
import type { ResolveMetrics } from "../lib/amazon-import-product-resolver";

const TABLE = "amazon_manage_fba_inventory" as const;
const MAX_PILOT_ROWS = 2500;
const DEFAULT_MAX_AMBIGUOUS_RATIO = 0.12;

function loadEnvLocal(): Record<string, string> {
  const p = path.join(process.cwd(), ".env.local");
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function parseArgs(argv: string[]) {
  let runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  let executeLaneB = false;
  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || runId;
    if (a === "--execute-lane-b") executeLaneB = true;
  }
  return { runId, executeLaneB };
}

type NdJson = Record<string, unknown>;

function appendNdjson(file: string, row: NdJson) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function ratioAmbiguous(m: ResolveMetrics): number {
  return m.rows_ambiguous / Math.max(1, m.rows_scanned);
}

async function main() {
  const { runId, executeLaneB } = parseArgs(process.argv.slice(2));
  const env = loadEnvLocal();

  process.env.RESOLVER_INCREMENTAL_PIPELINE = "1";
  process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_MANAGE_FBA_INVENTORY = "1";
  process.env.RESOLVER_INCREMENTAL_VERIFY_ONLY = "1";
  process.env.RESOLVER_INCREMENTAL_EXECUTE = "0";
  process.env.RESOLVER_INCREMENTAL_OBSERVABILITY_JSON_LOG = env.RESOLVER_INCREMENTAL_OBSERVABILITY_JSON_LOG ?? "1";

  const direct = env.DIRECT_POSTGRES_URL?.trim();
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const service = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!direct) throw new Error("DIRECT_POSTGRES_URL missing in .env.local");
  if (!url || !service) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");

  const outDir = path.join(process.cwd(), ".cursor", "audit-reports", "next-universal-resolver-10", runId);
  const logPath = path.join(outDir, "logs", "universal-resolver-10.ndjson");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

  const stamp = () => new Date().toISOString();
  const log = (row: NdJson) => appendNdjson(logPath, row);

  log({ event: "start", ts: stamp(), runId, executeLaneB_requested: executeLaneB, env_mirror: {
    RESOLVER_INCREMENTAL_PIPELINE: process.env.RESOLVER_INCREMENTAL_PIPELINE,
    RESOLVER_INCREMENTAL_TABLE_AMAZON_MANAGE_FBA_INVENTORY: process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_MANAGE_FBA_INVENTORY,
    RESOLVER_INCREMENTAL_VERIFY_ONLY: process.env.RESOLVER_INCREMENTAL_VERIFY_ONLY,
    RESOLVER_INCREMENTAL_EXECUTE: process.env.RESOLVER_INCREMENTAL_EXECUTE,
    RESOLVER_INCREMENTAL_OBSERVABILITY_JSON_LOG: process.env.RESOLVER_INCREMENTAL_OBSERVABILITY_JSON_LOG,
  }});

  const pgClient = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  type Pilot = { organization_id: string; store_id: string; upload_id: string; row_count: string };
  const { rows: pilotRows } = await pgClient.query<Pilot>(
    `SELECT organization_id::text,
            store_id::text,
            source_upload_id::text AS upload_id,
            count(*)::text AS row_count
     FROM public.amazon_manage_fba_inventory
     WHERE source_upload_id IS NOT NULL
       AND store_id IS NOT NULL
     GROUP BY organization_id, store_id, source_upload_id
     HAVING count(*) >= 1 AND count(*) <= $1
     ORDER BY count(*) ASC
     LIMIT 1`,
    [MAX_PILOT_ROWS],
  );
  const pilot = pilotRows[0] ?? null;

  if (!pilot) {
    log({ event: "no_safe_pilot", ts: stamp(), reason: `no upload with 1..${MAX_PILOT_ROWS} rows` });
    await pgClient.end();
    console.log(JSON.stringify({ ok: false, reason: "no_safe_pilot" }));
    return;
  }

  log({ event: "pilot_selected", ts: stamp(), pilot });

  const baseline = await pgClient.query<{
    scanned: string;
    resolved: string;
    ambiguous: string;
    unresolved_or_null: string;
  }>(
    `SELECT count(*)::text AS scanned,
            count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::text AS resolved,
            count(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::text AS ambiguous,
            count(*) FILTER (WHERE identifier_resolution_status = 'unresolved' OR identifier_resolution_status IS NULL)::text AS unresolved_or_null
     FROM public.amazon_manage_fba_inventory
     WHERE source_upload_id = $1::uuid`,
    [pilot.upload_id],
  );
  log({ event: "baseline_counts", ts: stamp(), row: baseline.rows[0] });

  await pgClient.end();

  const supabase = createClient(url, service, { auth: { persistSession: false } });

  emitResolverIncrementalObservabilityJsonLine({
    event: "pilot_verify_start",
    run_id: runId,
    table: TABLE,
    upload_id: pilot.upload_id,
    organization_id: pilot.organization_id,
    store_id: pilot.store_id,
  });

  const verifyResult = await runIncrementalResolverForUpload({
    supabase,
    organizationId: pilot.organization_id,
    uploadId: pilot.upload_id,
    storeId: pilot.store_id,
    table: TABLE,
    pageSize: 400,
    governance: { lane: "B", laneB_preflight: true, maxAmbiguousRatioForExecute: DEFAULT_MAX_AMBIGUOUS_RATIO },
    verifyOnly: true,
    allowExecute: false,
    persistToUploadMetadata: true,
  });

  log({
    event: "verify_only_complete",
    ts: stamp(),
    ok: verifyResult.ok,
    duration_ms_total: verifyResult.duration_ms_total,
    phases: verifyResult.phases,
    final_metrics: verifyResult.final_metrics,
    persist_metadata_ok: verifyResult.persist_metadata_ok,
    error: verifyResult.error,
  });

  emitResolverIncrementalObservabilityJsonLine({
    event: "pilot_verify_complete",
    run_id: runId,
    table: TABLE,
    upload_id: pilot.upload_id,
    duration_ms_total: verifyResult.duration_ms_total,
    final_metrics: verifyResult.final_metrics,
    persist_metadata_ok: verifyResult.persist_metadata_ok,
  });

  const m = verifyResult.final_metrics;
  const ambRatio = m ? ratioAmbiguous(m) : null;
  const safeForLaneB =
    m &&
    m.rows_scanned > 0 &&
    ambRatio != null &&
    ambRatio <= DEFAULT_MAX_AMBIGUOUS_RATIO &&
    verifyResult.ok;

  let executeResult: Awaited<ReturnType<typeof runIncrementalResolverForUpload>> | null = null;

  if (executeLaneB) {
    if (!safeForLaneB) {
      log({
        event: "execute_lane_b_skipped",
        ts: stamp(),
        reason: "preflight_thresholds_or_verify_ok_failed",
        ambRatio,
        metrics: m,
      });
    } else {
      process.env.RESOLVER_INCREMENTAL_VERIFY_ONLY = "0";
      process.env.RESOLVER_INCREMENTAL_EXECUTE = "1";

      emitResolverIncrementalObservabilityJsonLine({
        event: "pilot_lane_b_execute_start",
        run_id: runId,
        table: TABLE,
        upload_id: pilot.upload_id,
      });

      executeResult = await runIncrementalResolverForUpload({
        supabase,
        organizationId: pilot.organization_id,
        uploadId: pilot.upload_id,
        storeId: pilot.store_id,
        table: TABLE,
        pageSize: 400,
        governance: { lane: "B", laneB_preflight: true, maxAmbiguousRatioForExecute: DEFAULT_MAX_AMBIGUOUS_RATIO },
        verifyOnly: false,
        allowExecute: true,
        persistToUploadMetadata: true,
      });

      log({
        event: "lane_b_execute_complete",
        ts: stamp(),
        ok: executeResult.ok,
        duration_ms_total: executeResult.duration_ms_total,
        phases: executeResult.phases,
        final_metrics: executeResult.final_metrics,
        aborted_execute: executeResult.aborted_execute,
        persist_metadata_ok: executeResult.persist_metadata_ok,
        error: executeResult.error,
      });

      emitResolverIncrementalObservabilityJsonLine({
        event: "pilot_lane_b_execute_complete",
        run_id: runId,
        table: TABLE,
        upload_id: pilot.upload_id,
        duration_ms_total: executeResult.duration_ms_total,
        final_metrics: executeResult.final_metrics,
        aborted_execute: executeResult.aborted_execute,
      });
    }
  }

  log({ event: "done", ts: stamp() });

  console.log(
    JSON.stringify({
      ok: true,
      pilot,
      verify_only: verifyResult,
      amb_ratio: ambRatio,
      execute_lane_b_ran: Boolean(executeResult),
      execute_skipped_reason: executeLaneB && !executeResult && !safeForLaneB ? "thresholds" : undefined,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
