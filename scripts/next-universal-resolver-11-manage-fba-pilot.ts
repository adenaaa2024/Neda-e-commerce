/**
 * NEXT-UNIVERSAL-RESOLVER-11 — Hardened Manage FBA resolver pilot controls.
 *
 * Default: verify-only, no execute, max pilot rows = 500.
 *
 * Safe examples:
 *   npx tsx scripts/next-universal-resolver-11-manage-fba-pilot.ts --run-id=20260514T153500Z
 *   npx tsx scripts/next-universal-resolver-11-manage-fba-pilot.ts --run-id=... --upload-id=<uuid> --max-pilot-rows=2500 --preimage-export
 *
 * Execute remains opt-in and requires explicit upload + preimage export:
 *   npx tsx scripts/next-universal-resolver-11-manage-fba-pilot.ts --upload-id=<uuid> --preimage-export --execute-lane-b
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { emitResolverIncrementalObservabilityJsonLine } from "../lib/amazon-resolver-incremental-observability";
import { runIncrementalResolverForUpload } from "../lib/amazon-resolver-incremental-orchestrator";

const TABLE = "amazon_manage_fba_inventory" as const;
const DEFAULT_MAX_PILOT_ROWS = 500;
const DEFAULT_MAX_AMBIGUOUS_RATIO = 0.12;
const DEFAULT_MAX_UNRESOLVED_RATIO = 0.40;

type Pilot = {
  organization_id: string;
  store_id: string;
  upload_id: string;
  row_count: string;
};

type Args = {
  runId: string;
  uploadId: string | null;
  maxPilotRows: number;
  maxAmbiguousRatio: number;
  maxUnresolvedRatio: number;
  requireExplicitUploadForLargePilot: boolean;
  preimageExport: boolean;
  executeLaneB: boolean;
};

type NdJson = Record<string, unknown>;

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeRatio(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseArgs(argv: string[], env: Record<string, string>): Args {
  let runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  let uploadId: string | null = null;
  let maxPilotRows = parsePositiveInt(env.RESOLVER_11_MAX_PILOT_ROWS, DEFAULT_MAX_PILOT_ROWS);
  let maxAmbiguousRatio = parseNonNegativeRatio(
    env.RESOLVER_11_MAX_AMBIGUOUS_RATIO,
    DEFAULT_MAX_AMBIGUOUS_RATIO,
  );
  let maxUnresolvedRatio = parseNonNegativeRatio(
    env.RESOLVER_11_MAX_UNRESOLVED_RATIO,
    DEFAULT_MAX_UNRESOLVED_RATIO,
  );
  let requireExplicitUploadForLargePilot = false;
  let preimageExport = false;
  let executeLaneB = false;

  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || runId;
    else if (a.startsWith("--upload-id=")) uploadId = a.slice("--upload-id=".length).trim() || null;
    else if (a.startsWith("--max-pilot-rows=")) {
      maxPilotRows = parsePositiveInt(a.slice("--max-pilot-rows=".length), maxPilotRows);
    } else if (a.startsWith("--max-ambiguous-ratio=")) {
      maxAmbiguousRatio = parseNonNegativeRatio(a.slice("--max-ambiguous-ratio=".length), maxAmbiguousRatio);
    } else if (a.startsWith("--max-unresolved-ratio=")) {
      maxUnresolvedRatio = parseNonNegativeRatio(a.slice("--max-unresolved-ratio=".length), maxUnresolvedRatio);
    } else if (a === "--require-explicit-upload-for-large-pilot") requireExplicitUploadForLargePilot = true;
    else if (a === "--preimage-export") preimageExport = true;
    else if (a === "--execute-lane-b") executeLaneB = true;
    else if (a === "--no-execute") executeLaneB = false;
  }

  if (maxPilotRows > DEFAULT_MAX_PILOT_ROWS) requireExplicitUploadForLargePilot = true;

  return {
    runId,
    uploadId,
    maxPilotRows,
    maxAmbiguousRatio,
    maxUnresolvedRatio,
    requireExplicitUploadForLargePilot,
    preimageExport,
    executeLaneB,
  };
}

function appendNdjson(file: string, row: NdJson) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function ratio(n: number, d: number): number {
  return n / Math.max(1, d);
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, rows: Record<string, unknown>[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (rows.length === 0) {
    fs.writeFileSync(file, "", "utf8");
    return;
  }
  const headers = Object.keys(rows[0] ?? {});
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(","))];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

async function selectPilot(client: pg.Client, args: Args): Promise<Pilot | null> {
  if (args.uploadId) {
    const { rows } = await client.query<Pilot>(
      `SELECT organization_id::text,
              store_id::text,
              source_upload_id::text AS upload_id,
              count(*)::text AS row_count
       FROM public.amazon_manage_fba_inventory
       WHERE source_upload_id = $1::uuid
         AND store_id IS NOT NULL
       GROUP BY organization_id, store_id, source_upload_id
       LIMIT 1`,
      [args.uploadId],
    );
    return rows[0] ?? null;
  }

  if (args.requireExplicitUploadForLargePilot && args.maxPilotRows > DEFAULT_MAX_PILOT_ROWS) return null;

  const { rows } = await client.query<Pilot>(
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
    [args.maxPilotRows],
  );
  return rows[0] ?? null;
}

async function exportPreimage(client: pg.Client, outDir: string, pilot: Pilot): Promise<{ csvPath: string; jsonPath: string; rowCount: number }> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id::text,
            organization_id::text,
            store_id::text,
            source_upload_id::text,
            sku,
            fnsku,
            asin,
            product_name,
            resolved_product_id::text,
            resolved_catalog_product_id::text,
            identifier_resolution_status,
            identifier_resolution_confidence,
            updated_at,
            raw_data
     FROM public.amazon_manage_fba_inventory
     WHERE organization_id = $1::uuid
       AND store_id = $2::uuid
       AND source_upload_id = $3::uuid
     ORDER BY id`,
    [pilot.organization_id, pilot.store_id, pilot.upload_id],
  );
  const snapDir = path.join(outDir, "snapshots");
  const csvPath = path.join(snapDir, `amazon_manage_fba_inventory-${pilot.upload_id}-preimage.csv`);
  const jsonPath = path.join(snapDir, `amazon_manage_fba_inventory-${pilot.upload_id}-preimage.json`);
  writeCsv(csvPath, rows);
  fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), "utf8");
  return {
    csvPath: path.relative(process.cwd(), csvPath),
    jsonPath: path.relative(process.cwd(), jsonPath),
    rowCount: rows.length,
  };
}

async function main() {
  const env = loadEnvLocal();
  const args = parseArgs(process.argv.slice(2), env);

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

  const outDir = path.join(process.cwd(), ".cursor", "audit-reports", "next-universal-resolver-11", args.runId);
  const logPath = path.join(outDir, "logs", "universal-resolver-11.ndjson");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

  const stamp = () => new Date().toISOString();
  const log = (row: NdJson) => appendNdjson(logPath, row);

  log({ event: "start", ts: stamp(), args, defaultMaxPilotRows: DEFAULT_MAX_PILOT_ROWS });

  if (args.maxPilotRows > DEFAULT_MAX_PILOT_ROWS && !args.uploadId) {
    log({
      event: "cap_increase_requires_explicit_upload",
      ts: stamp(),
      maxPilotRows: args.maxPilotRows,
      defaultMaxPilotRows: DEFAULT_MAX_PILOT_ROWS,
    });
    console.log(JSON.stringify({ ok: false, reason: "cap_increase_requires_explicit_upload", run_id: args.runId }));
    return;
  }

  if (args.executeLaneB && (!args.uploadId || !args.preimageExport)) {
    log({ event: "execute_rejected", ts: stamp(), reason: "execute_requires_upload_id_and_preimage_export" });
    console.log(JSON.stringify({ ok: false, reason: "execute_requires_upload_id_and_preimage_export", run_id: args.runId }));
    return;
  }

  const pgClient = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  try {
    const pilot = await selectPilot(pgClient, args);
    if (!pilot) {
      log({
        event: "no_safe_pilot",
        ts: stamp(),
        reason: args.uploadId ? "explicit_upload_not_found" : `no upload with 1..${args.maxPilotRows} rows`,
      });
      console.log(JSON.stringify({ ok: false, reason: "no_safe_pilot", run_id: args.runId }));
      return;
    }

    const rowCount = Number(pilot.row_count);
    if (!Number.isFinite(rowCount) || rowCount <= 0 || rowCount > args.maxPilotRows) {
      log({ event: "pilot_rejected_by_cap", ts: stamp(), pilot, maxPilotRows: args.maxPilotRows });
      console.log(JSON.stringify({ ok: false, reason: "pilot_rejected_by_cap", pilot, run_id: args.runId }));
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
       WHERE organization_id = $1::uuid
         AND store_id = $2::uuid
         AND source_upload_id = $3::uuid`,
      [pilot.organization_id, pilot.store_id, pilot.upload_id],
    );
    log({ event: "baseline_counts", ts: stamp(), row: baseline.rows[0] });

    let preimage: Awaited<ReturnType<typeof exportPreimage>> | null = null;
    if (args.preimageExport) {
      preimage = await exportPreimage(pgClient, outDir, pilot);
      log({ event: "preimage_exported", ts: stamp(), preimage });
    }

    const supabase = createClient(url, service, { auth: { persistSession: false } });

    emitResolverIncrementalObservabilityJsonLine({
      event: "resolver_11_verify_start",
      run_id: args.runId,
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
      governance: { lane: "B", laneB_preflight: true, maxAmbiguousRatioForExecute: args.maxAmbiguousRatio },
      verifyOnly: true,
      allowExecute: false,
      persistToUploadMetadata: true,
    });

    const m = verifyResult.final_metrics;
    const ambRatio = m ? ratio(m.rows_ambiguous, m.rows_scanned) : null;
    const unresolvedRatio = m ? ratio(m.rows_unresolved, m.rows_scanned) : null;
    const ratiosSafe =
      Boolean(m) &&
      verifyResult.ok &&
      ambRatio != null &&
      unresolvedRatio != null &&
      ambRatio <= args.maxAmbiguousRatio &&
      unresolvedRatio <= args.maxUnresolvedRatio;

    log({
      event: "verify_only_complete",
      ts: stamp(),
      ok: verifyResult.ok,
      duration_ms_total: verifyResult.duration_ms_total,
      phases: verifyResult.phases,
      final_metrics: verifyResult.final_metrics,
      persist_metadata_ok: verifyResult.persist_metadata_ok,
      ambRatio,
      unresolvedRatio,
      ratiosSafe,
      thresholds: {
        maxAmbiguousRatio: args.maxAmbiguousRatio,
        maxUnresolvedRatio: args.maxUnresolvedRatio,
      },
      error: verifyResult.error,
    });

    emitResolverIncrementalObservabilityJsonLine({
      event: "resolver_11_verify_complete",
      run_id: args.runId,
      table: TABLE,
      upload_id: pilot.upload_id,
      duration_ms_total: verifyResult.duration_ms_total,
      final_metrics: verifyResult.final_metrics,
      persist_metadata_ok: verifyResult.persist_metadata_ok,
    });

    let executeResult: Awaited<ReturnType<typeof runIncrementalResolverForUpload>> | null = null;
    if (args.executeLaneB) {
      if (!ratiosSafe) {
        log({ event: "execute_lane_b_skipped", ts: stamp(), reason: "ratio_threshold_failed", ambRatio, unresolvedRatio });
      } else {
        process.env.RESOLVER_INCREMENTAL_VERIFY_ONLY = "0";
        process.env.RESOLVER_INCREMENTAL_EXECUTE = "1";
        executeResult = await runIncrementalResolverForUpload({
          supabase,
          organizationId: pilot.organization_id,
          uploadId: pilot.upload_id,
          storeId: pilot.store_id,
          table: TABLE,
          pageSize: 400,
          governance: { lane: "B", laneB_preflight: true, maxAmbiguousRatioForExecute: args.maxAmbiguousRatio },
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
      }
    } else {
      log({ event: "execute_not_requested", ts: stamp(), defaultNoExecute: true });
    }

    log({ event: "done", ts: stamp() });
    console.log(
      JSON.stringify({
        ok: true,
        run_id: args.runId,
        pilot,
        preimage,
        verify_only: verifyResult,
        amb_ratio: ambRatio,
        unresolved_ratio: unresolvedRatio,
        execute_lane_b_ran: Boolean(executeResult),
      }),
    );
  } finally {
    await pgClient.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
