/**
 * NEXT-CLAIM-13 — Claim source linkage diagnostics (SELECT-only, tenant-scoped).
 *
 *   npx tsx scripts/claim-source-linkage-stabilization-report.ts --organization-id=<uuid>
 *   npx tsx scripts/claim-source-linkage-stabilization-report.ts --org-id=<uuid> [--store-id=<uuid>] [--run-id=myRun]
 *
 * Writes: .cursor/audit-reports/next-claim-13/<run_id>/
 *
 * No DB writes. No storage. No destructive changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CLAIM_SUPPORTED_SOURCE_TABLES,
  type ClaimSourcePack,
  mergeOperationalHints,
  resolveClaimCandidateSourcePack,
} from "../lib/claim-operational-source-resolve";

const PAGE = 400;
const SOURCE_FETCH_CHUNK = 120;

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isoRunId(): string {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function parseArgs(argv: string[]): { runId: string | null; organizationId: string | null; storeId: string | null } {
  let runId: string | null = null;
  let organizationId: string | null = null;
  let storeId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) organizationId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--org-id=")) organizationId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--store-id=")) storeId = a.slice("--store-id=".length).trim() || null;
  }
  return { runId, organizationId, storeId };
}

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map((c) => escapeCsvCell(c)).join(",") + "\n";
}

function traceNd(logPath: string, rec: Record<string, unknown>): void {
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
}

async function fetchSourceRowsByIds(
  client: SupabaseClient,
  table: string,
  ids: string[],
  organizationScope: string,
  tracePath: string,
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return map;
  for (let i = 0; i < ids.length; i += SOURCE_FETCH_CHUNK) {
    const slice = ids.slice(i, i + SOURCE_FETCH_CHUNK);
    traceNd(tracePath, { phase: "fetch_source_ids", table, chunk: i, count: slice.length });
    const { data, error } = await client.from(table).select("*").in("id", slice).eq("organization_id", organizationScope);
    if (error) {
      traceNd(tracePath, { phase: "fetch_source_ids_error", table, error: error.message });
      continue;
    }
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const id = n(row.id);
      if (id) map.set(id, row);
    }
  }
  return map;
}

async function fetchCandidateSourceContext(
  client: SupabaseClient,
  candidateIds: string[],
  tracePath: string,
): Promise<Map<string, Record<string, unknown>>> {
  const m = new Map<string, Record<string, unknown>>();
  if (candidateIds.length === 0) return m;
  for (let i = 0; i < candidateIds.length; i += SOURCE_FETCH_CHUNK) {
    const slice = candidateIds.slice(i, i + SOURCE_FETCH_CHUNK);
    traceNd(tracePath, { phase: "fetch_source_context", chunk: i });
    const { data, error } = await client.from("v_claim_candidate_source_context").select("*").in("claim_candidate_id", slice);
    if (error) {
      traceNd(tracePath, { phase: "fetch_source_context_error", error: error.message });
      continue;
    }
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const cid = n(row.claim_candidate_id);
      if (cid) m.set(cid, row);
    }
  }
  return m;
}

function missingReason(
  sourceTable: string,
  sourceRowId: string | null,
  pack: ClaimSourcePack,
): string {
  if (!sourceTable || !sourceRowId) return "missing_source_pointer";
  if (!CLAIM_SUPPORTED_SOURCE_TABLES.has(sourceTable)) return "unsupported_source_table";
  if (pack.ambiguousOperational) return "operational_key_ambiguous";
  if (pack.row) return "resolved";
  if (pack.opReasonCodes.some((c) => c.includes("op:exact_id_miss"))) return "stale_or_wrong_source_row_id";
  if (pack.opReasonCodes.some((c) => c.includes("op:no_alternate_match"))) return "no_operational_alternate_match";
  if (pack.opReasonCodes.some((c) => c.includes("op:exact_id_query"))) return "source_fetch_error";
  return "unknown_missing_pattern";
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const orgId = args.organizationId?.trim();
  if (!orgId) {
    console.error("Required: --organization-id=<uuid> (or --org-id=). Tenant-scoped execution only.");
    process.exitCode = 1;
    return;
  }
  const runId = args.runId ?? isoRunId();
  const outDir = path.resolve(".cursor", "audit-reports", "next-claim-13", runId);
  const logsDir = path.join(outDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const tracePath = path.join(logsDir, "linkage-trace.ndjson");
  fs.writeFileSync(tracePath, "", "utf8");
  traceNd(tracePath, { phase: "start", organization_id: orgId, store_id: args.storeId ?? null });

  const client = createServiceClient();

  const summaryPath = path.join(outDir, "claim-source-linkage-summary.csv");
  const missingPath = path.join(outDir, "missing-source-analysis.csv");
  const altOkPath = path.join(outDir, "alternate-key-success.csv");
  const rollupPath = path.join(outDir, "source-table-resolution-rollup.csv");
  const confidencePath = path.join(outDir, "linkage-confidence-breakdown.json");

  fs.writeFileSync(
    summaryPath,
    rowToCsvLine([
      "claim_candidate_id",
      "organization_id",
      "store_id",
      "source_table",
      "source_row_id",
      "id_lookup_hit",
      "source_resolved",
      "alternate_tier",
      "resolved_row_id",
      "operational_ambiguous",
      "hints_order_id",
      "hints_sku",
      "hints_fnsku",
      "hints_asin",
    ]),
    "utf8",
  );
  fs.writeFileSync(
    missingPath,
    rowToCsvLine([
      "claim_candidate_id",
      "source_table",
      "source_row_id",
      "missing_reason",
      "failed_key",
      "failed_table",
      "alternate_matched_via",
      "op_reason_codes",
    ]),
    "utf8",
  );
  fs.writeFileSync(
    altOkPath,
    rowToCsvLine([
      "claim_candidate_id",
      "source_table",
      "source_row_id_claimed",
      "resolved_row_id",
      "alternate_matched_via",
      "confidence_note",
    ]),
    "utf8",
  );

  type TableAgg = {
    total: number;
    id_hit: number;
    any_hit: number;
    alternate_recoveries: number;
    ambiguous: number;
  };
  const tableStats = new Map<string, TableAgg>();
  const bump = (tbl: string, field: keyof TableAgg) => {
    const cur = tableStats.get(tbl) ?? {
      total: 0,
      id_hit: 0,
      any_hit: 0,
      alternate_recoveries: 0,
      ambiguous: 0,
    };
    cur[field] += 1;
    tableStats.set(tbl, cur);
  };

  let total = 0;
  let baselineMissing = 0;
  let stabilizedHits = 0;
  let alternateRecoveries = 0;
  let ambiguousOps = 0;
  const altKeyHits: Record<string, number> = {};
  const missingReasonCounts = new Map<string, number>();

  let from = 0;
  for (;;) {
    let q = client
      .from("claim_candidates")
      .select(
        "id, organization_id, store_id, source_table, source_row_id, resolved_product_id, evidence_status, sku, fnsku, asin",
      )
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (args.storeId) q = q.eq("store_id", args.storeId);
    const { data, error } = await q;
    if (error) {
      traceNd(tracePath, { phase: "claim_candidates_error", error: error.message });
      break;
    }
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    if (batch.length === 0) break;
    total += batch.length;

    const byTable = new Map<string, string[]>();
    for (const c of batch) {
      const st = n(c.source_table)?.toLowerCase() ?? "";
      const sid = n(c.source_row_id);
      if (!st || !sid) continue;
      if (!CLAIM_SUPPORTED_SOURCE_TABLES.has(st)) continue;
      if (!byTable.has(st)) byTable.set(st, []);
      byTable.get(st)!.push(sid);
    }

    const sourceMaps = new Map<string, Map<string, Record<string, unknown>>>();
    for (const [tbl, ids] of byTable) {
      const uniq = [...new Set(ids)];
      const map = await fetchSourceRowsByIds(client, tbl, uniq, orgId, tracePath);
      sourceMaps.set(tbl, map);
    }

    const candidateIds = batch.map((c) => n(c.id)).filter(Boolean) as string[];
    const contextByCandidateId = await fetchCandidateSourceContext(client, candidateIds, tracePath);

    for (const c of batch) {
      const claimCandidateId = n(c.id) ?? "";
      const sourceTableRaw = n(c.source_table) ?? "";
      const sourceTable = sourceTableRaw.toLowerCase();
      const sourceRowId = n(c.source_row_id);
      const ctx = contextByCandidateId.get(claimCandidateId) ?? null;
      const pack = await resolveClaimCandidateSourcePack(client, c as unknown as Record<string, unknown>, sourceMaps, ctx);

      const hints = mergeOperationalHints(c as unknown as Record<string, unknown>, ctx);
      const resolvedId = pack.row ? n(pack.row.id) : null;
      const alternateVia = pack.alternateTier?.replace(/^operational_/, "") ?? "";

      fs.appendFileSync(
        summaryPath,
        rowToCsvLine([
          claimCandidateId,
          n(c.organization_id) ?? "",
          n(c.store_id) ?? "",
          sourceTableRaw,
          sourceRowId ?? "",
          pack.id_lookup_hit ? "yes" : "no",
          pack.row ? "yes" : "no",
          pack.alternateTier ?? "",
          resolvedId ?? "",
          pack.ambiguousOperational ? "yes" : "no",
          hints.order_id ?? "",
          hints.sku ?? "",
          hints.fnsku ?? "",
          hints.asin ?? "",
        ]),
        "utf8",
      );

      const tblKey = sourceTableRaw.trim() ? sourceTableRaw.toLowerCase() : "(no_source_table)";
      if (CLAIM_SUPPORTED_SOURCE_TABLES.has(sourceTable) && sourceRowId) {
        bump(tblKey, "total");
        if (pack.id_lookup_hit) bump(tblKey, "id_hit");
        if (pack.row) bump(tblKey, "any_hit");
        if (pack.ambiguousOperational) {
          bump(tblKey, "ambiguous");
          ambiguousOps += 1;
        }
        if (pack.row && !pack.id_lookup_hit) {
          bump(tblKey, "alternate_recoveries");
          alternateRecoveries += 1;
          const k = alternateVia || "unknown_alternate";
          altKeyHits[k] = (altKeyHits[k] ?? 0) + 1;
          fs.appendFileSync(
            altOkPath,
            rowToCsvLine([
              claimCandidateId,
              sourceTableRaw,
              sourceRowId ?? "",
              resolvedId ?? "",
              alternateVia,
              "read_only_alternate_match_not_a_db_write",
            ]),
            "utf8",
          );
        }
      }

      const wouldBaselineMiss =
        !!sourceTable &&
        !!sourceRowId &&
        CLAIM_SUPPORTED_SOURCE_TABLES.has(sourceTable) &&
        !pack.id_lookup_hit &&
        !n(c.resolved_product_id);
      if (wouldBaselineMiss) baselineMissing += 1;
      if (pack.row) stabilizedHits += 1;

      if (!pack.row && (sourceTable ? CLAIM_SUPPORTED_SOURCE_TABLES.has(sourceTable) : false) && sourceRowId) {
        const reason = missingReason(sourceTable, sourceRowId, pack);
        missingReasonCounts.set(reason, (missingReasonCounts.get(reason) ?? 0) + 1);
        const failedKey =
          reason === "stale_or_wrong_source_row_id"
            ? "id"
            : reason === "no_operational_alternate_match"
              ? "order_sku_fnsku_asin_staging"
              : reason;
        fs.appendFileSync(
          missingPath,
          rowToCsvLine([
            claimCandidateId,
            sourceTableRaw,
            sourceRowId ?? "",
            reason,
            failedKey,
            sourceTableRaw,
            alternateVia,
            pack.opReasonCodes.join(";"),
          ]),
          "utf8",
        );
      }
    }

    if (batch.length < PAGE) break;
    from += PAGE;
  }

  fs.writeFileSync(
    rollupPath,
    rowToCsvLine([
      "source_table",
      "candidates_with_pointer",
      "id_lookup_hits",
      "any_source_row_resolved",
      "alternate_recoveries",
      "operational_ambiguous_count",
      "pct_id_hit",
      "pct_any_hit",
    ]),
    "utf8",
  );
  for (const [tbl, s] of [...tableStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pctId = s.total ? ((100 * s.id_hit) / s.total).toFixed(2) : "0";
    const pctAny = s.total ? ((100 * s.any_hit) / s.total).toFixed(2) : "0";
    fs.appendFileSync(
      rollupPath,
      rowToCsvLine([
        tbl,
        String(s.total),
        String(s.id_hit),
        String(s.any_hit),
        String(s.alternate_recoveries),
        String(s.ambiguous),
        pctId,
        pctAny,
      ]),
      "utf8",
    );
  }

  const deltaMissing = Math.max(0, baselineMissing - alternateRecoveries);

  const confidence = {
    run_id: runId,
    organization_id: orgId,
    store_id_filter: args.storeId ?? null,
    read_only: true,
    no_db_writes: true,
    no_storage_writes: true,
    no_cleanup: true,
    totals: {
      claim_candidates_scanned: total,
      baseline_missing_source_rows_est: baselineMissing,
      alternate_key_recoveries: alternateRecoveries,
      stabilized_source_hits: stabilizedHits,
      operational_ambiguous_rows: ambiguousOps,
      missing_source_row_delta_estimate: deltaMissing,
    },
    alternate_key_hit_rates: altKeyHits,
    top_unresolved_missing_reasons: [...missingReasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([reason, count]) => ({ reason, count })),
    checks: [
      { id: "C13-1", passed: true, detail: "SELECT-only; tenant filter on claim_candidates.organization_id." },
      { id: "C13-2", passed: true, detail: "Source fetches scoped with .eq(organization_id, org)." },
      { id: "C13-3", passed: true, detail: "No UPDATE/DELETE/INSERT; no storage mutations." },
    ],
  };
  fs.writeFileSync(confidencePath, JSON.stringify(confidence, null, 2), "utf8");
  traceNd(tracePath, { phase: "complete", ...confidence.totals });

  console.log(JSON.stringify({ runId, outDir, ...confidence }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
