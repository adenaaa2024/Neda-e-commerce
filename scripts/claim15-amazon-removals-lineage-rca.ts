/**
 * NEXT-CLAIM-15 — Read-only RCA: why claim_candidates → amazon_removals pointers fail (stale lineage).
 *
 *   npx tsx scripts/claim15-amazon-removals-lineage-rca.ts --org-id=<uuid>
 *   npx tsx scripts/claim15-amazon-removals-lineage-rca.ts --org-id=<uuid> --run-id=myRun
 *
 * Writes: .cursor/audit-reports/next-claim-15/<run_id>/
 *
 * SELECT-only. No mutations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mergeOperationalHints } from "../lib/claim-operational-source-resolve";

const PAGE = 500;
const IN_CHUNK = 150;

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createClientSr(): SupabaseClient {
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

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map((c) => escapeCsvCell(c)).join(",") + "\n";
}

/** Store-scoped first (matches lib/claim-operational-source-resolve), then org-wide. */
async function lookupAmazonRemovalOrderKey(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  orderId: string,
  keyCol: "sku" | "fnsku",
  keyVal: string,
): Promise<{ row: Record<string, unknown> | null; ambiguous: boolean }> {
  const base = () =>
    client
      .from("amazon_removals")
      .select("id, upload_id, source_staging_id, order_id, sku, fnsku, store_id")
      .eq("organization_id", organizationId)
      .eq("order_id", orderId)
      .eq(keyCol, keyVal);
  if (storeId) {
    const { data: d1 } = await base().eq("store_id", storeId).limit(8);
    const s1 = (d1 ?? []) as Record<string, unknown>[];
    if (s1.length === 1) return { row: s1[0]!, ambiguous: false };
    if (s1.length > 1) return { row: null, ambiguous: true };
  }
  const { data: d2 } = await base().limit(8);
  const s2 = (d2 ?? []) as Record<string, unknown>[];
  if (s2.length === 1) return { row: s2[0]!, ambiguous: false };
  if (s2.length > 1) return { row: null, ambiguous: true };
  return { row: null, ambiguous: false };
}

function traceNd(logPath: string, rec: Record<string, unknown>): void {
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
}

function parseArgs(argv: string[]): { orgId: string | null; runId: string | null } {
  let orgId: string | null = null;
  let runId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) orgId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
  }
  return { orgId, runId };
}

async function fetchInChunks<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  col: string,
  ids: string[],
  extraEq: { col: string; val: string }[],
  select: string,
  tracePath: string,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const slice = uniq.slice(i, i + IN_CHUNK);
    if (slice.length === 0) continue;
    let q = client.from(table).select(select).in(col, slice);
    for (const { col: c, val } of extraEq) q = q.eq(c, val);
    const { data, error } = await q;
    traceNd(tracePath, { phase: "fetch", table, col, chunk: i, n: slice.length, err: error?.message });
    if (error) continue;
    for (const row of (data ?? []) as T[]) {
      const rid = n((row as Record<string, unknown>).id);
      const sid = n((row as Record<string, unknown>).source_staging_id);
      if (col === "id" && rid) out.set(rid, row);
      else if (col === "source_staging_id" && sid) {
        if (!out.has(sid)) out.set(sid, row);
      }
    }
  }
  return out;
}

type LineageCategory =
  | "points_to_deleted_operational_row"
  | "points_to_staging_identity"
  | "source_row_id_is_source_staging_id_operational_exists"
  | "upload_rebuild_drift_operational_found_by_order_sku"
  | "source_staging_id_survived_but_operational_id_changed"
  | "points_to_expected_packages_or_other_shape"
  | "pointer_is_expected_packages_pk_remaps_via_order_sku"
  | "unsupported_historical_shape"
  | "no_lineage_available"
  | "replay_ambiguous_multiple_operational_rows";

function classifyRow(args: {
  inRemovalsPk: boolean;
  stagingRow: Record<string, unknown> | undefined;
  removalViaStaging: Record<string, unknown> | undefined;
  replayRemoval: Record<string, unknown> | undefined;
  replayAmbiguous: boolean;
  expectedPkgHit: boolean;
  expectedPkgPkMatch: boolean;
}): { category: LineageCategory; recovery_hint: string } {
  const {
    inRemovalsPk,
    stagingRow,
    removalViaStaging,
    replayRemoval,
    replayAmbiguous,
    expectedPkgHit,
    expectedPkgPkMatch,
  } = args;
  if (inRemovalsPk) {
    return { category: "unsupported_historical_shape", recovery_hint: "unexpected_hit_should_not_happen_in_missing_set" };
  }
  if (removalViaStaging) {
    return {
      category: "source_row_id_is_source_staging_id_operational_exists",
      recovery_hint: "remap_source_row_id_to_amazon_removals.id_or_resolver_fallback_source_staging_id",
    };
  }
  if (replayAmbiguous) {
    return {
      category: "replay_ambiguous_multiple_operational_rows",
      recovery_hint: "resolver_should_not_auto_pick_requires_disambiguation_rule",
    };
  }
  if (replayRemoval && expectedPkgPkMatch) {
    return {
      category: "pointer_is_expected_packages_pk_remaps_via_order_sku",
      recovery_hint: "treat_source_row_id_as_expected_packages.id_remap_to_amazon_removals.id_or_resolver_bridge",
    };
  }
  if (replayRemoval) {
    return {
      category: "upload_rebuild_drift_operational_found_by_order_sku",
      recovery_hint: "resolver_fallback_order_sku_or_remap_pointer_to_current_amazon_removals.id",
    };
  }
  if (stagingRow && !removalViaStaging) {
    return {
      category: "points_to_staging_identity",
      recovery_hint: "staging_row_exists_but_no_operational_row_with_that_source_staging_id_missing_import_or_deleted_operational",
    };
  }
  if (expectedPkgHit) {
    return {
      category: "points_to_expected_packages_or_other_shape",
      recovery_hint: "verify_pointer_semantics_expected_packages_vs_removals",
    };
  }
  return { category: "points_to_deleted_operational_row", recovery_hint: "no_staging_no_operational_replay_no_expected_pkg_match" };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const orgId = args.orgId?.trim();
  if (!orgId) {
    console.error("Required: --org-id=<uuid>");
    process.exitCode = 1;
    return;
  }
  const runId = args.runId ?? isoRunId();
  const outDir = path.resolve(".cursor", "audit-reports", "next-claim-15", runId);
  const logsDir = path.join(outDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const tracePath = path.join(logsDir, "lineage-trace.ndjson");
  fs.writeFileSync(tracePath, "", "utf8");
  traceNd(tracePath, { phase: "start", organization_id: orgId });

  const client = createClientSr();

  const baseCcCols =
    "id, organization_id, store_id, source_table, source_row_id, sku, fnsku, asin";
  const optionalCcCols = ["order_id", "source_staging_id", "upload_id", "amazon_order_id", "lpn"] as const;
  let claimCandidatesSelect = baseCcCols;
  for (const col of optionalCcCols) {
    const probe = await client.from("claim_candidates").select(`id, ${col}`).eq("organization_id", orgId).limit(1);
    if (!probe.error) claimCandidatesSelect += `, ${col}`;
    traceNd(tracePath, {
      phase: "claim_candidates_column_probe",
      column: col,
      available: !probe.error,
      err: probe.error?.message,
    });
  }
  traceNd(tracePath, { phase: "claim_candidates_select", columns: claimCandidatesSelect });

  let expectedPackagesSelect = "id, source_detail_row_id, upload_id";
  for (const col of ["source_staging_id", "order_id", "sku", "tracking_number"] as const) {
    const probe = await client.from("expected_packages").select(`id, ${col}`).eq("organization_id", orgId).limit(1);
    if (!probe.error) expectedPackagesSelect += `, ${col}`;
    traceNd(tracePath, {
      phase: "expected_packages_column_probe",
      column: col,
      available: !probe.error,
      err: probe.error?.message,
    });
  }
  traceNd(tracePath, { phase: "expected_packages_select", columns: expectedPackagesSelect });

  const summaryPath = path.join(outDir, "lineage-root-cause-summary.csv");
  const semanticsPath = path.join(outDir, "source-pointer-semantics-analysis.csv");
  const stagingVsOpPath = path.join(outDir, "staging-vs-operational-id-analysis.csv");
  const uploadCorrPath = path.join(outDir, "upload-lineage-correlation.csv");
  const orphanPatternsPath = path.join(outDir, "orphaned-source-pointer-patterns.csv");
  const driftPath = path.join(outDir, "historical-import-drift-analysis.csv");
  const strategyPath = path.join(outDir, "linkage-repair-strategy-options.md");

  const catCounts = new Map<LineageCategory, number>();
  const bump = (c: LineageCategory) => catCounts.set(c, (catCounts.get(c) ?? 0) + 1);

  fs.writeFileSync(
    summaryPath,
    rowToCsvLine(["category", "row_count", "pct_of_missing", "recovery_hint_summary"]),
    "utf8",
  );
  fs.writeFileSync(
    semanticsPath,
    rowToCsvLine([
      "interpretation",
      "evidence",
      "row_count",
      "notes",
    ]),
    "utf8",
  );
  fs.writeFileSync(
    stagingVsOpPath,
    rowToCsvLine([
      "claim_candidate_id",
      "source_row_id_pointer",
      "in_amazon_removals_as_pk",
      "amazon_staging_id_match",
      "amazon_removals_via_source_staging_id",
      "replay_match_removals_id",
      "expected_packages_id_match",
      "lineage_category",
      "recovery_hint",
      "replay_order_or_context",
      "replay_sku_or_fnsku",
      "replay_source",
      "replay_ambiguous",
    ]),
    "utf8",
  );
  fs.writeFileSync(
    uploadCorrPath,
    rowToCsvLine([
      "source_row_id_pointer",
      "staging_upload_id",
      "operational_upload_id_from_replay",
      "operational_upload_id_from_staging_join",
      "upload_agrees",
      "expected_packages_upload_id_if_pointer_is_ep_pk",
    ]),
    "utf8",
  );
  fs.writeFileSync(
    orphanPatternsPath,
    rowToCsvLine(["pattern", "count", "example_pointer", "notes"]),
    "utf8",
  );
  fs.writeFileSync(
    driftPath,
    rowToCsvLine([
      "claim_candidate_id",
      "pointer_id",
      "replay_operational_id",
      "replay_order_id",
      "replay_sku",
      "drift_note",
    ]),
    "utf8",
  );

  type CandRow = {
    id: string;
    source_row_id: string;
    organization_id: string;
    store_id: string | null;
    sku: string | null;
    fnsku: string | null;
    asin: string | null;
    order_id: string | null;
    source_staging_id: string | null;
    upload_id: string | null;
  };

  const missing: CandRow[] = [];
  const contextByCand = new Map<string, Record<string, unknown>>();

  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("claim_candidates")
      .select(claimCandidatesSelect)
      .eq("organization_id", orgId)
      .ilike("source_table", "amazon_removals")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      traceNd(tracePath, { phase: "claim_candidates_error", error: error.message });
      console.error(`claim_candidates query failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    if (batch.length === 0) break;

    const candIds = batch.map((r) => n(r.id)).filter(Boolean) as string[];
    for (let i = 0; i < candIds.length; i += IN_CHUNK) {
      const slice = candIds.slice(i, i + IN_CHUNK);
      const { data: ctxData, error: ctxErr } = await client
        .from("v_claim_candidate_source_context")
        .select("*")
        .in("claim_candidate_id", slice);
      traceNd(tracePath, { phase: "source_context", chunk: i, err: ctxErr?.message });
      for (const row of (ctxData ?? []) as Record<string, unknown>[]) {
        const cid = n(row.claim_candidate_id);
        if (cid) contextByCand.set(cid, row);
      }
    }

    const ptrs = batch.map((r) => n(r.source_row_id)).filter(Boolean) as string[];
    const remPk = await fetchInChunks<Record<string, unknown>>(
      client,
      "amazon_removals",
      "id",
      ptrs,
      [{ col: "organization_id", val: orgId }],
      "id, upload_id, source_staging_id, order_id, sku, fnsku, disposition",
      tracePath,
    );

    for (const r of batch) {
      const id = n(r.id);
      const ptr = n(r.source_row_id);
      if (!id || !ptr) continue;
      if (!remPk.has(ptr)) {
        missing.push({
          id,
          source_row_id: ptr,
          organization_id: n(r.organization_id) ?? orgId,
          store_id: n(r.store_id),
          sku: n(r.sku),
          fnsku: n(r.fnsku),
          asin: n(r.asin),
          order_id: n(r.order_id),
          source_staging_id: n(r.source_staging_id),
          upload_id: n(r.upload_id),
        });
      }
    }

    if (batch.length < PAGE) break;
    from += PAGE;
  }

  const missingPtrs = [...new Set(missing.map((m) => m.source_row_id))];
  traceNd(tracePath, { phase: "missing_pointers", count: missing.length, distinct_pointers: missingPtrs.length });

  const stagingById = await fetchInChunks<Record<string, unknown>>(
    client,
    "amazon_staging",
    "id",
    missingPtrs,
    [{ col: "organization_id", val: orgId }],
    "id, upload_id, row_number, report_type, source_line_hash",
    tracePath,
  );

  const removalBySourceStaging = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < missingPtrs.length; i += IN_CHUNK) {
    const slice = missingPtrs.slice(i, i + IN_CHUNK);
    const q = client
      .from("amazon_removals")
      .select("id, upload_id, source_staging_id, order_id, sku, fnsku, disposition")
      .eq("organization_id", orgId)
      .in("source_staging_id", slice);
    const { data, error } = await q;
    traceNd(tracePath, { phase: "removals_by_source_staging", chunk: i, err: error?.message });
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const ss = n(row.source_staging_id);
      if (ss && !removalBySourceStaging.has(ss)) removalBySourceStaging.set(ss, row);
    }
  }

  const expectedById = await fetchInChunks<Record<string, unknown>>(
    client,
    "expected_packages",
    "id",
    missingPtrs,
    [{ col: "organization_id", val: orgId }],
    expectedPackagesSelect,
    tracePath,
  );

  const expectedByDetail = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < missingPtrs.length; i += IN_CHUNK) {
    const slice = missingPtrs.slice(i, i + IN_CHUNK);
    const { data, error } = await client.from("expected_packages").select(expectedPackagesSelect).eq("organization_id", orgId).in("source_detail_row_id", slice);
    traceNd(tracePath, { phase: "expected_by_detail", chunk: i, err: error?.message });
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const d = n(row.source_detail_row_id);
      if (d && !expectedByDetail.has(d)) expectedByDetail.set(d, row);
    }
  }

  traceNd(tracePath, {
    phase: "expected_prefetch_done",
    expected_packages_by_id_rows: expectedById.size,
    staging_by_id_rows: stagingById.size,
    removals_by_source_staging_rows: removalBySourceStaging.size,
  });

  let rruProbe: string | null = null;
  try {
    const { error } = await client.from("raw_report_uploads").select("id").eq("organization_id", orgId).limit(1);
    rruProbe = error ? `raw_report_uploads_probe:${error.message}` : "raw_report_uploads_readable";
  } catch (e) {
    rruProbe = String(e);
  }
  traceNd(tracePath, { phase: "raw_report_uploads", rruProbe });

  type ReplayEnt = Record<string, unknown> | "ambiguous" | null;
  const replayCacheKey = (storeId: string | null, orderId: string, col: "sku" | "fnsku", val: string) =>
    `${storeId ?? ""}\x1f${orderId}\x1f${col}\x1f${val}`;

  const replayRequests = new Map<
    string,
    { storeId: string | null; orderId: string; col: "sku" | "fnsku"; val: string }
  >();

  for (const m of missing) {
    const ctx = contextByCand.get(m.id) ?? null;
    const cand: Record<string, unknown> = {
      id: m.id,
      organization_id: m.organization_id,
      store_id: m.store_id,
      sku: m.sku,
      fnsku: m.fnsku,
      asin: m.asin,
      order_id: m.order_id,
      source_staging_id: m.source_staging_id,
      upload_id: m.upload_id,
    };
    const hints = mergeOperationalHints(cand, ctx);
    const epRow = expectedById.get(m.source_row_id);
    const epOrder = epRow ? n(epRow.order_id) : null;
    const epSku = epRow ? n(epRow.sku) : null;
    if (epOrder && epSku) {
      const k = replayCacheKey(m.store_id, epOrder, "sku", epSku);
      replayRequests.set(k, { storeId: m.store_id, orderId: epOrder, col: "sku", val: epSku });
    }
    const hOrder = hints.order_id;
    const hSku = hints.sku;
    const hFnsku = hints.fnsku;
    if (hOrder && hSku) {
      const k = replayCacheKey(m.store_id, hOrder, "sku", hSku);
      replayRequests.set(k, { storeId: m.store_id, orderId: hOrder, col: "sku", val: hSku });
    }
    if (hOrder && hFnsku) {
      const k = replayCacheKey(m.store_id, hOrder, "fnsku", hFnsku);
      replayRequests.set(k, { storeId: m.store_id, orderId: hOrder, col: "fnsku", val: hFnsku });
    }
  }

  const replayByKey = new Map<string, ReplayEnt>();
  traceNd(tracePath, { phase: "replay_batch_start", distinct_replay_keys: replayRequests.size });
  let replayHits = 0;
  let replayAmbiguous = 0;
  let replayMisses = 0;
  for (const [k, req] of replayRequests) {
    const { row, ambiguous } = await lookupAmazonRemovalOrderKey(
      client,
      orgId,
      req.storeId,
      req.orderId,
      req.col,
      req.val,
    );
    if (ambiguous) {
      replayByKey.set(k, "ambiguous");
      replayAmbiguous++;
    } else if (row) {
      replayByKey.set(k, row);
      replayHits++;
    } else {
      replayByKey.set(k, null);
      replayMisses++;
    }
  }
  traceNd(tracePath, {
    phase: "replay_batch_done",
    distinct_replay_keys: replayRequests.size,
    replay_hits: replayHits,
    replay_ambiguous: replayAmbiguous,
    replay_misses: replayMisses,
  });

  const patternCounts = new Map<string, number>();
  const patternExample = new Map<string, string>();

  for (const m of missing) {
    const ptr = m.source_row_id;
    const ctx = contextByCand.get(m.id) ?? null;
    const cand: Record<string, unknown> = {
      id: m.id,
      organization_id: m.organization_id,
      store_id: m.store_id,
      sku: m.sku,
      fnsku: m.fnsku,
      asin: m.asin,
      order_id: m.order_id,
      source_staging_id: m.source_staging_id,
      upload_id: m.upload_id,
    };
    const hints = mergeOperationalHints(cand, ctx);
    const epRow = expectedById.get(ptr);
    const epOrder = epRow ? n(epRow.order_id) : null;
    const epSku = epRow ? n(epRow.sku) : null;

    const inStaging = stagingById.has(ptr);
    const viaSt = removalBySourceStaging.get(ptr);
    const expHit = expectedById.has(ptr) || expectedByDetail.has(ptr);
    const expectedPkgPkOnly = !!expectedById.get(ptr);

    const readReplayRow = (
      storeId: string | null,
      orderId: string,
      col: "sku" | "fnsku",
      val: string,
    ): "hit" | "ambiguous" | "miss" => {
      const k = replayCacheKey(storeId, orderId, col, val);
      const ent = replayByKey.get(k);
      if (ent === "ambiguous") return "ambiguous";
      if (ent && typeof ent === "object") return "hit";
      return "miss";
    };

    let replay: Record<string, unknown> | undefined;
    let sawAmbiguous = false;
    let orderUsed = "";
    let skuUsed = "";
    let replaySource = "";

    const tryAssign = (
      st: "hit" | "ambiguous" | "miss",
      storeId: string | null,
      orderId: string,
      col: "sku" | "fnsku",
      val: string,
      source: string,
    ): boolean => {
      if (st === "ambiguous") {
        sawAmbiguous = true;
        return false;
      }
      if (st === "miss") return false;
      const k = replayCacheKey(storeId, orderId, col, val);
      const ent = replayByKey.get(k);
      if (ent && typeof ent === "object") {
        replay = ent;
        orderUsed = orderId;
        skuUsed = val;
        replaySource = source;
        return true;
      }
      return false;
    };

    if (expectedPkgPkOnly && epOrder && epSku) {
      tryAssign(
        readReplayRow(m.store_id, epOrder, "sku", epSku),
        m.store_id,
        epOrder,
        "sku",
        epSku,
        "expected_packages_row",
      );
    }
    if (!replay && hints.order_id && hints.sku) {
      tryAssign(
        readReplayRow(m.store_id, hints.order_id, "sku", hints.sku),
        m.store_id,
        hints.order_id,
        "sku",
        hints.sku,
        "merge_hints_order_sku",
      );
    }
    if (!replay && hints.order_id && hints.fnsku) {
      tryAssign(
        readReplayRow(m.store_id, hints.order_id, "fnsku", hints.fnsku),
        m.store_id,
        hints.order_id,
        "fnsku",
        hints.fnsku,
        "merge_hints_order_fnsku",
      );
    }

    const replayAmbiguous = !replay && sawAmbiguous;

    const expectedPkgPkMatch = replaySource === "expected_packages_row";

    const { category, recovery_hint } = classifyRow({
      inRemovalsPk: false,
      stagingRow: stagingById.get(ptr),
      removalViaStaging: viaSt,
      replayRemoval: replay,
      replayAmbiguous,
      expectedPkgHit: expHit,
      expectedPkgPkMatch,
    });
    bump(category);

    const pat = ptr.match(/^[0-9a-f-]{36}$/i) ? "uuid_pointer" : "non_uuid_pointer";
    patternCounts.set(pat, (patternCounts.get(pat) ?? 0) + 1);
    if (!patternExample.has(pat)) patternExample.set(pat, ptr);

    fs.appendFileSync(
      stagingVsOpPath,
      rowToCsvLine([
        m.id,
        ptr,
        "no",
        inStaging ? "yes" : "no",
        viaSt ? n(viaSt.id) ?? "" : "no",
        replay ? n(replay.id) ?? "" : "",
        expHit ? "yes" : "no",
        category,
        recovery_hint,
        orderUsed || hints.order_id || epOrder || "",
        skuUsed || hints.sku || epSku || "",
        replaySource,
        replayAmbiguous ? "yes" : "no",
      ]),
      "utf8",
    );

    if (replay || replayAmbiguous) {
      fs.appendFileSync(
        driftPath,
        rowToCsvLine([
          m.id,
          ptr,
          replay ? n(replay.id) ?? "" : "",
          orderUsed || hints.order_id || epOrder || "",
          skuUsed || hints.sku || hints.fnsku || epSku || "",
          replayAmbiguous
            ? "ambiguous_operational_candidates"
            : `operational_row_found_not_by_pointer_id_via_${replaySource}`,
        ]),
        "utf8",
      );
    }

    const st = stagingById.get(ptr);
    const stUpload = st ? n(st.upload_id) : "";
    const opUpload = replay ? n(replay.upload_id) : viaSt ? n(viaSt.upload_id) : "";
    fs.appendFileSync(
      uploadCorrPath,
      rowToCsvLine([
        ptr,
        stUpload ?? "",
        replay ? n(replay.upload_id) ?? "" : "",
        viaSt ? n(viaSt.upload_id) ?? "" : "",
        stUpload && opUpload && stUpload === opUpload ? "yes" : stUpload || opUpload ? "no_or_partial" : "",
        epRow ? n(epRow.upload_id) ?? "" : "",
      ]),
      "utf8",
    );
  }

  const totalMissing = missing.length || 1;
  for (const [category, cnt] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    fs.appendFileSync(
      summaryPath,
      rowToCsvLine([category, String(cnt), ((100 * cnt) / totalMissing).toFixed(2), "see_linkage-repair-strategy-options.md"]),
      "utf8",
    );
  }

  fs.appendFileSync(
    semanticsPath,
    rowToCsvLine([
      "claim_candidates.source_row_id intended as amazon_removals.id",
      "resolver_and_stabilization_scripts_use_pk_lookup_on_amazon_removals.id",
      String(missing.length),
      "When id_missing_and_no_alternate_match_pointer_is_stale_or_wrong_semantics",
    ]),
    "utf8",
  );
  fs.appendFileSync(
    semanticsPath,
    rowToCsvLine([
      "amazon_removals.source_staging_id FK",
      "migrations_state_FK_to_amazon_staging.id",
      String(removalBySourceStaging.size),
      "rows_where_pointer_matches_existing_operational_source_staging_id_column",
    ]),
    "utf8",
  );
  fs.appendFileSync(
    semanticsPath,
    rowToCsvLine([
      "v_claim_candidate_source_context_source_order_id_null_when_join_misses",
      "view_left_joins_amazon_removals_on_source_row_id_eq_rm_id_rm_null_if_stale_pointer",
      String(missing.length),
      "RCA_must_use_claim_candidates_columns_or_expected_packages_bridge_not_view_alone",
    ]),
    "utf8",
  );
  fs.appendFileSync(
    semanticsPath,
    rowToCsvLine([
      "Phase2_staging_recreate_new_UUIDs",
      "migration_20260619_comment_stable_row_number",
      "",
      "If_claim_stores_old_staging_or_old_removal_pk_drift_expected",
    ]),
    "utf8",
  );

  for (const [pat, cnt] of patternCounts.entries()) {
    fs.appendFileSync(
      orphanPatternsPath,
      rowToCsvLine([pat, String(cnt), patternExample.get(pat) ?? "", "missing_operational_pk"]),
      "utf8",
    );
  }

  const recoverableStagingJoin = catCounts.get("source_row_id_is_source_staging_id_operational_exists") ?? 0;
  const recoverableReplay = catCounts.get("upload_rebuild_drift_operational_found_by_order_sku") ?? 0;
  const recoverableEpPk = catCounts.get("pointer_is_expected_packages_pk_remaps_via_order_sku") ?? 0;
  const replayAmbCount = catCounts.get("replay_ambiguous_multiple_operational_rows") ?? 0;
  const maybePkg = catCounts.get("points_to_expected_packages_or_other_shape") ?? 0;

  const deleted = catCounts.get("points_to_deleted_operational_row") ?? 0;
  const totalM = missing.length || 1;
  const bridgeRecover = recoverableEpPk + recoverableReplay + recoverableStagingJoin;
  let scriptedPick =
    "**Resolver fallback is safer than DB repair** until counts show a dominant deterministic lineage key (human must confirm).";
  if (recoverableStagingJoin >= recoverableEpPk + recoverableReplay && recoverableStagingJoin > 0.25 * totalM) {
    scriptedPick = "**Future repair should use source_staging_id lineage** (pointers align with `amazon_removals.source_staging_id` more than replay bridges).";
  } else if (recoverableEpPk + recoverableReplay > 0.2 * totalM) {
    scriptedPick =
      "**Future repair should use upload / source row lineage** (expected_packages + order/sku replay explains most misses; remap `source_row_id` or bridge in resolver).";
  } else if (replayAmbCount > recoverableReplay + recoverableEpPk && replayAmbCount > 0.05 * totalM) {
    scriptedPick =
      "**Resolver fallback is safer than DB repair** (ambiguous operational matches dominate recoverable tiers).";
  } else if (deleted > 0.7 * totalM && bridgeRecover < 0.1 * totalM) {
    scriptedPick =
      "**Historical lineage too inconsistent for safe automated repair** (most pointers are dead with no bridge).";
  }

  fs.writeFileSync(
    strategyPath,
    [
      "# NEXT-CLAIM-15 — Linkage repair strategy options (read-only draft)",
      "",
      `Organization: \`${orgId}\``,
      `Missing operational PK join rows analyzed: **${missing.length}**`,
      "",
      "## Counts by RCA category",
      "",
      [...catCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `- **${k}**: ${v}`)
        .join("\n"),
      "",
      "## Estimated recoverable (theoretical, not executed)",
      "",
      `- **Resolver / remap via source_staging_id join**: ~${recoverableStagingJoin} rows (pointer equals live \`amazon_removals.source_staging_id\` / staging key semantics).`,
      `- **Remap when pointer is expected_packages.id**: ~${recoverableEpPk} rows (operational row found via \`expected_packages\` order+sku bridge).`,
      `- **Resolver fallback order_id+sku / fnsku (non-EP)**: ~${recoverableReplay} rows (replay via merged hints; implies id drift / rebuild or missing view context).`,
      `- **Replay ambiguous (multiple operational rows)**: ~${replayAmbCount} rows (needs disambiguation; do not auto-remap).`,
      `- **Investigate expected_packages / other shapes (no replay)**: ~${maybePkg} rows.`,
      "",
      "## Recommendation options (choose one after human review)",
      "",
      "1. **source_staging_id lineage** — Prefer when `source_row_id_is_source_staging_id_operational_exists` dominates: treat pointer as staging id or align resolver to join `amazon_removals.source_staging_id` before PK.",
      "2. **upload / physical row lineage** — Prefer when uploads replay with new UUIDs but stable `(organization_id, upload_id, row_number)` / hashes: remap using staging physical keys (requires DB repair job; not in this RCA).",
      "3. **Resolver-only fallback** — Safer short term: never auto-write DB; extend resolver to match order/sku/fnsku with ambiguity guards.",
      "4. **Pause automated repair** — If `points_to_deleted_operational_row` dominates and replay is low: data may be gone; manual review only.",
      "",
      "## Scripted single-choice suggestion (review required)",
      "",
      scriptedPick,
      "",
      "## Validation",
      "",
      "- This RCA performed **SELECT** queries and local file writes only.",
      "- No migrations, no backfill, no storage, no claim/product table updates.",
      "",
    ].join("\n"),
    "utf8",
  );

  const checks: { id: string; passed: boolean; detail: string }[] = [
    { id: "C15-1", passed: true, detail: "No INSERT/UPDATE/DELETE; read-only Supabase client usage." },
    { id: "C15-2", passed: true, detail: "Outputs only under .cursor/audit-reports/next-claim-15/<run_id>/." },
    { id: "C15-3", passed: true, detail: "No storage or external APIs beyond Supabase read." },
    {
      id: "C15-4",
      passed: true,
      detail: `Missing amazon_removals PK pointers analyzed: ${missing.length} (zero is valid if no bad pointers).`,
    },
    { id: "C15-5", passed: !rruProbe?.startsWith("raw_report_uploads_probe:"), detail: rruProbe ?? "raw_report_uploads not required for core RCA" },
  ];
  fs.writeFileSync(path.join(outDir, "10-validation-checks.json"), JSON.stringify(checks, null, 2), "utf8");

  traceNd(tracePath, { phase: "complete", missing_rows: missing.length, categories: Object.fromEntries(catCounts) });

  console.log(
    JSON.stringify(
      {
        runId,
        outDir,
        organization_id: orgId,
        missing_amazon_removals_pointers: missing.length,
        distinct_pointers: missingPtrs.length,
        category_counts: Object.fromEntries(catCounts),
        raw_report_uploads_probe: rruProbe,
        scripted_recommendation: scriptedPick,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
