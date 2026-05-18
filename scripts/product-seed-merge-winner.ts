/**
 * NEXT-18K — Merge-candidate / canonical-winner audit (dry-run only).
 *
 * Read-only. Loads NEXT-18J + NEXT-18G outputs from disk, pages
 * `public.products` and active+inactive `public.product_identifier_map`,
 * column-probes the six Amazon ops tables, then issues chunked GROUP BY +
 * MAX(<recency>) aggregates across all eight downstream surfaces to score
 * every duplicate-orphan group member and every Shard B (external-winner)
 * orphan. No INSERT / UPDATE / UPSERT / DELETE / RPC writes anywhere.
 *
 * Outputs under .cursor/audit-reports/next-18k/<runId>/:
 *   manifest.json
 *   run-summary.json
 *   00-shardA-groups-summary.csv
 *   01-shardA-members-scored.csv
 *   02-shardA-winners.csv
 *   03-shardA-merge-edges.csv
 *   04-shardA-cascade-risks.csv
 *   05-shardA-identifier-authority.csv
 *   06-shardA-blocked-groups.csv
 *   07-shardB-orphan-vs-external.csv
 *   08-shardB-merge-edges.csv
 *   09-shardB-blocked.csv
 *   10-validation-checks.json
 *   logs/decision-trace.ndjson
 *   logs/page-cursors.ndjson
 *   logs/fetch-warnings.ndjson
 *   logs/column-probe.json
 *   logs/query-trace.txt
 *
 * Plan: .cursor/plans/merge_winner_audit_33db146d.plan.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  NDJsonWriter,
  mkRunDir,
  mkRunId,
  sha256Hex,
  writeCsv,
  writeJson,
  writeManifest,
  writeRunSummary,
  type RunMetadata,
} from "../lib/audits/product-seed-output";
import {
  PAGE_SIZE,
  POSTGREST_IN_CHUNK_SIZE,
  daysBetween,
  type ActiveMapRow,
  type ProductRow,
} from "../lib/audits/product-seed-orphan-sizing";
import { deriveCandidates } from "../lib/audits/product-seed-backfill-dryrun";
import {
  DIMENSION_NAMES,
  DIMENSION_WEIGHTS,
  DOWNSTREAM_SURFACES,
  PRODUCT_ID_SURFACES,
  buildEvidenceSnapshot,
  buildIdentifierAuthority,
  buildMergeEdge,
  buildReasoning,
  classifyShardB,
  compositeScore,
  computeRawScores,
  emptyDownstream,
  memberMostRecentActivity,
  normalizeScoresInGroup,
  recencyBucket,
  selectShardAWinner,
  weightedScores,
  type Candidates,
  type DimensionName,
  type IdentifierAuthority,
  type MemberDownstream,
  type RawScores,
  type ShardBClassification,
  type SurfaceName,
  type WinnerSelection,
} from "../lib/audits/product-seed-merge-winner";
import { isUuidString } from "../lib/uuid";

const NEXT18G_BASE_DIR = path.join(".cursor", "audit-reports", "next-18g");
const NEXT18J_BASE_DIR = path.join(".cursor", "audit-reports", "next-18j");
const NEXT18K_BASE_DIR = path.join(".cursor", "audit-reports", "next-18k");

const PRODUCTS_SELECT = [
  "id",
  "organization_id",
  "store_id",
  "sku",
  "asin",
  "fnsku",
  "upc_code",
  "mfg_part_number",
  "barcode",
  "product_name",
  "brand",
  "vendor_name",
  "condition",
  "status",
  "merge_status",
  "merged_into_id",
  "deleted_at",
  "created_at",
  "updated_at",
  "last_seen_at",
  "last_catalog_sync_at",
].join(", ");

const ACTIVE_MAP_SELECT = [
  "id",
  "product_id",
  "organization_id",
  "store_id",
  "seller_sku",
  "asin",
  "fnsku",
  "upc_code",
  "is_primary",
  "match_source",
  "source_report_type",
  "first_seen_at",
  "last_seen_at",
].join(", ");

const AMAZON_OPS_TABLES: readonly SurfaceName[] = [
  "amazon_inventory_ledger",
  "amazon_all_orders",
  "amazon_settlements",
  "amazon_transactions",
  "amazon_manage_fba_inventory",
  "amazon_amazon_fulfilled_inventory",
];
const RECENCY_CANDIDATE_COLUMNS: readonly string[] = [
  "event_time",
  "posted_date",
  "transaction_date",
  "observed_at",
  "snapshot_date",
  "purchase_date",
  "report_date",
  "transaction_release_date",
  "created_at",
];

// ── CLI ─────────────────────────────────────────────────────────────────────

type Cli = {
  inputRunNext18j: string | null;
  inputRunNext18g: string | null;
  organizationId: string | null;
  storeId: string | null;
  outputDir: string | null;
  shard: "A" | "B" | "all";
  maxGroupSize: number;
  hotThresholdDays: number;
  resolverHitThresholdDays: number;
  pricesRecentThresholdDays: number;
};

function parseCli(argv: string[]): Cli {
  let inputRunNext18j: string | null = null;
  let inputRunNext18g: string | null = null;
  let organizationId: string | null = null;
  let storeId: string | null = null;
  let outputDir: string | null = null;
  let shard: "A" | "B" | "all" = "all";
  let maxGroupSize = 6;
  let hotThresholdDays = 30;
  let resolverHitThresholdDays = 30;
  let pricesRecentThresholdDays = 365;
  for (const arg of argv.slice(2)) {
    let m: RegExpMatchArray | null;
    if ((m = arg.match(/^--input-run-next-18j=(.+)$/))) inputRunNext18j = m[1].trim() || null;
    else if ((m = arg.match(/^--input-run-next-18g=(.+)$/))) inputRunNext18g = m[1].trim() || null;
    else if ((m = arg.match(/^--organization-id=(.+)$/))) organizationId = m[1].trim() || null;
    else if ((m = arg.match(/^--store-id=(.+)$/))) storeId = m[1].trim() || null;
    else if ((m = arg.match(/^--output-dir=(.+)$/))) outputDir = m[1].trim() || null;
    else if ((m = arg.match(/^--shard=(.+)$/))) {
      const v = m[1].trim();
      if (v !== "A" && v !== "B" && v !== "all") throw new Error(`Invalid --shard=${v}`);
      shard = v;
    } else if ((m = arg.match(/^--max-group-size=(\d+)$/))) maxGroupSize = Number.parseInt(m[1], 10);
    else if ((m = arg.match(/^--hot-threshold-days=(\d+)$/))) hotThresholdDays = Number.parseInt(m[1], 10);
    else if ((m = arg.match(/^--resolver-hit-threshold-days=(\d+)$/))) {
      resolverHitThresholdDays = Number.parseInt(m[1], 10);
    } else if ((m = arg.match(/^--prices-recent-threshold-days=(\d+)$/))) {
      pricesRecentThresholdDays = Number.parseInt(m[1], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown CLI flag: ${arg}`);
  }
  if (organizationId && !isUuidString(organizationId)) {
    throw new Error(`Invalid --organization-id: "${organizationId}" is not a UUID.`);
  }
  if (storeId && !isUuidString(storeId)) {
    throw new Error(`Invalid --store-id: "${storeId}" is not a UUID.`);
  }
  return {
    inputRunNext18j,
    inputRunNext18g,
    organizationId,
    storeId,
    outputDir,
    shard,
    maxGroupSize,
    hotThresholdDays,
    resolverHitThresholdDays,
    pricesRecentThresholdDays,
  };
}

function printHelp(): void {
  console.error(
    [
      "Usage: npx tsx scripts/product-seed-merge-winner.ts [flags]",
      "",
      "Flags:",
      "  --input-run-next-18j=<runId>     NEXT-18J run to classify (default: latest finished)",
      "  --input-run-next-18g=<runId>     NEXT-18G cluster source (default: latest finished)",
      "  --organization-id=<uuid>         Force tenant org (else from NEXT-18J run-summary)",
      "  --store-id=<uuid>                Optional store filter",
      "  --output-dir=<path>              Override default output run directory",
      "  --shard=A|B|all                  (default all)",
      "  --max-group-size=<int>           (default 6)",
      "  --hot-threshold-days=<int>       (default 30)",
      "  --resolver-hit-threshold-days=<int> (default 30)",
      "  --prices-recent-threshold-days=<int> (default 365)",
    ].join("\n"),
  );
}

// ── Env / git ───────────────────────────────────────────────────────────────

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return { url, key };
}

function getSupabaseJsVersion(): string | null {
  try {
    const pkg = require("@supabase/supabase-js/package.json") as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function readGitSha(): string | null {
  try {
    const child = require("node:child_process") as typeof import("node:child_process");
    const out = child.execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// ── Input run resolution ────────────────────────────────────────────────────

type RunSelection = {
  runId: string;
  runDir: string;
  startedAt: string;
  finishedAt: string;
  selectionReason: "auto_latest" | "cli_override";
};

function selectInputRun(args: {
  baseDir: string;
  override: string | null;
  requiredFile: string;
  trace: string[];
  label: string;
}): RunSelection {
  const { baseDir, override, requiredFile, trace, label } = args;
  if (!fs.existsSync(baseDir)) throw new Error(`${label} base directory not found: ${baseDir}`);
  type Candidate = { runId: string; runDir: string; startedAt: string; finishedAt: string };
  const candidates: Candidate[] = [];
  const subdirs = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  trace.push(`[${label}] scanned ${subdirs.length} subdirectories under ${baseDir}`);
  for (const subdir of subdirs) {
    const runDir = path.join(baseDir, subdir);
    const manifestPath = path.join(runDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: { runId?: string; startedAt?: string; finishedAt?: string | null };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest.finishedAt) continue;
    if (!fs.existsSync(path.join(runDir, requiredFile))) continue;
    candidates.push({
      runId: manifest.runId ?? subdir,
      runDir,
      startedAt: manifest.startedAt ?? "",
      finishedAt: manifest.finishedAt,
    });
  }
  if (override) {
    const found = candidates.find((c) => c.runId === override);
    if (!found) throw new Error(`${label} --input-run override ${override} did not match a finished run`);
    trace.push(`[${label}] override matched runId=${found.runId}`);
    return { ...found, selectionReason: "cli_override" };
  }
  if (candidates.length === 0) throw new Error(`No finished ${label} run found under ${baseDir}`);
  candidates.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const chosen = candidates[0];
  trace.push(
    `[${label}] auto-selected runId=${chosen.runId} (${candidates.length} candidate(s), startedAt=${chosen.startedAt})`,
  );
  return { ...chosen, selectionReason: "auto_latest" };
}

// ── CSV ingest ──────────────────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\r") {
        // ignore
      } else if (ch === "\n") {
        row.push(cell);
        cell = "";
        rows.push(row);
        row = [];
      } else cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  if (rows.length === 0) return out;
  const headers = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = r[j] ?? "";
    out.push(obj);
  }
  return out;
}

// ── DB fetchers ─────────────────────────────────────────────────────────────

type FetchWarning = { source: string; reason: string; detail?: unknown };

function stringOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  return String(v);
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asProductRow(r: Record<string, unknown>): ProductRow {
  return {
    id: String(r.id),
    organization_id: String(r.organization_id),
    store_id: stringOrNull(r.store_id),
    sku: stringOrNull(r.sku),
    asin: stringOrNull(r.asin),
    fnsku: stringOrNull(r.fnsku),
    upc_code: stringOrNull(r.upc_code),
    mfg_part_number: stringOrNull(r.mfg_part_number),
    barcode: stringOrNull(r.barcode),
    product_name: stringOrNull(r.product_name),
    brand: stringOrNull(r.brand),
    vendor_name: stringOrNull(r.vendor_name),
    condition: stringOrNull(r.condition),
    status: stringOrNull(r.status),
    merge_status: stringOrNull(r.merge_status),
    merged_into_id: stringOrNull(r.merged_into_id),
    deleted_at: stringOrNull(r.deleted_at),
    created_at: stringOrNull(r.created_at),
    updated_at: stringOrNull(r.updated_at),
    last_seen_at: stringOrNull(r.last_seen_at),
    last_catalog_sync_at: stringOrNull(r.last_catalog_sync_at),
  };
}

function asActiveMapRow(r: Record<string, unknown>): ActiveMapRow {
  return {
    id: String(r.id),
    product_id: String(r.product_id),
    organization_id: String(r.organization_id),
    store_id: stringOrNull(r.store_id),
    seller_sku: stringOrNull(r.seller_sku),
    asin: stringOrNull(r.asin),
    fnsku: stringOrNull(r.fnsku),
    upc_code: stringOrNull(r.upc_code),
    is_primary: boolOrNull(r.is_primary),
    match_source: stringOrNull(r.match_source),
    source_report_type: stringOrNull(r.source_report_type),
    first_seen_at: stringOrNull(r.first_seen_at),
    last_seen_at: stringOrNull(r.last_seen_at),
  };
}

async function pageProducts(args: {
  sb: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  cursorWriter: NDJsonWriter;
  warnings: FetchWarning[];
}): Promise<ProductRow[]> {
  const out: ProductRow[] = [];
  let offset = 0;
  let pageIndex = 0;
  while (true) {
    let q = args.sb
      .from("products")
      .select(PRODUCTS_SELECT)
      .eq("organization_id", args.organizationId)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (args.storeId) q = q.eq("store_id", args.storeId);
    const { data, error } = await q;
    if (error) {
      args.warnings.push({ source: "products", reason: `page ${pageIndex}: ${error.message}` });
      throw new Error(`[NEXT-18K] products page ${pageIndex} failed: ${error.message}`);
    }
    const rows = (data ?? []).map((r) => asProductRow(r as unknown as Record<string, unknown>));
    args.cursorWriter.write({
      table: "products",
      page_index: pageIndex,
      offset,
      row_count: rows.length,
      last_id: rows.length > 0 ? rows[rows.length - 1].id : null,
    });
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    pageIndex++;
  }
  return out;
}

async function pageActiveMap(args: {
  sb: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  cursorWriter: NDJsonWriter;
  warnings: FetchWarning[];
}): Promise<ActiveMapRow[]> {
  const out: ActiveMapRow[] = [];
  let offset = 0;
  let pageIndex = 0;
  while (true) {
    let q = args.sb
      .from("product_identifier_map")
      .select(ACTIVE_MAP_SELECT)
      .eq("organization_id", args.organizationId)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (args.storeId) q = q.eq("store_id", args.storeId);
    const { data, error } = await q;
    if (error) {
      args.warnings.push({
        source: "product_identifier_map.active",
        reason: `page ${pageIndex}: ${error.message}`,
      });
      throw new Error(`[NEXT-18K] active imap page ${pageIndex} failed: ${error.message}`);
    }
    const rows = (data ?? []).map((r) => asActiveMapRow(r as unknown as Record<string, unknown>));
    args.cursorWriter.write({
      table: "product_identifier_map.active",
      page_index: pageIndex,
      offset,
      row_count: rows.length,
      last_id: rows.length > 0 ? rows[rows.length - 1].id : null,
    });
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    pageIndex++;
  }
  return out;
}

async function pageInactiveMapCounts(args: {
  sb: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  cursorWriter: NDJsonWriter;
  warnings: FetchWarning[];
}): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let offset = 0;
  let pageIndex = 0;
  while (true) {
    let q = args.sb
      .from("product_identifier_map")
      .select("id, product_id")
      .eq("organization_id", args.organizationId)
      .not("deleted_at", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (args.storeId) q = q.eq("store_id", args.storeId);
    const { data, error } = await q;
    if (error) {
      args.warnings.push({
        source: "product_identifier_map.inactive",
        reason: `page ${pageIndex}: ${error.message}`,
      });
      throw new Error(`[NEXT-18K] inactive imap page ${pageIndex} failed: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{ id: string; product_id: string }>;
    args.cursorWriter.write({
      table: "product_identifier_map.inactive",
      page_index: pageIndex,
      offset,
      row_count: rows.length,
      last_id: rows.length > 0 ? rows[rows.length - 1].id : null,
    });
    for (const r of rows) counts.set(r.product_id, (counts.get(r.product_id) ?? 0) + 1);
    if (rows.length === 0) break;
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    pageIndex++;
  }
  return counts;
}

async function readPimDuplicateGroupsCount(
  sb: SupabaseClient,
  organizationId: string,
  warnings: FetchWarning[],
): Promise<number> {
  const { count, error } = await sb
    .from("pim_duplicate_groups")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) {
    warnings.push({ source: "pim_duplicate_groups", reason: error.message });
    return 0;
  }
  return count ?? 0;
}

// ── Column probe ────────────────────────────────────────────────────────────

type ColumnProbeRecord = {
  table: SurfaceName | "amazon_reports_repository" | "product_prices";
  chosen_column: string | null;
  tried: Array<{ column: string; ok: boolean; reason?: string }>;
};

async function probeRecencyColumn(
  sb: SupabaseClient,
  table: string,
  warnings: FetchWarning[],
): Promise<ColumnProbeRecord> {
  const tried: ColumnProbeRecord["tried"] = [];
  for (const col of RECENCY_CANDIDATE_COLUMNS) {
    const { error } = await sb.from(table).select(col).limit(0);
    if (!error) {
      tried.push({ column: col, ok: true });
      return { table: table as ColumnProbeRecord["table"], chosen_column: col, tried };
    }
    tried.push({ column: col, ok: false, reason: error.message });
  }
  warnings.push({
    source: table,
    reason: "no recency-candidate column resolved",
    detail: tried,
  });
  return { table: table as ColumnProbeRecord["table"], chosen_column: null, tried };
}

// ── Chunked downstream aggregates ───────────────────────────────────────────

async function aggregateSurface(args: {
  sb: SupabaseClient;
  table: string;
  idColumn: "product_id" | "resolved_product_id";
  organizationId: string;
  ids: string[];
  recencyColumn: string | null;
  warnings: FetchWarning[];
  trace: string[];
}): Promise<{ counts: Map<string, number>; max: Map<string, string | null> }> {
  const counts = new Map<string, number>();
  const max = new Map<string, string | null>();
  if (args.ids.length === 0) return { counts, max };
  const selectCols = args.recencyColumn
    ? `${args.idColumn}, ${args.recencyColumn}`
    : args.idColumn;
  const sortedIds = [...args.ids].sort();
  for (let i = 0; i < sortedIds.length; i += POSTGREST_IN_CHUNK_SIZE) {
    const chunk = sortedIds.slice(i, i + POSTGREST_IN_CHUNK_SIZE);
    // Range-paginate within the chunk in case > PAGE_SIZE rows match
    let offset = 0;
    while (true) {
      const { data, error } = await args.sb
        .from(args.table)
        .select(selectCols)
        .eq("organization_id", args.organizationId)
        .in(args.idColumn, chunk)
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) {
        args.warnings.push({
          source: args.table,
          reason: `aggregate chunk ${i}-${i + chunk.length} offset ${offset}: ${error.message}`,
        });
        throw new Error(
          `[NEXT-18K] aggregate ${args.table} chunk ${i} offset ${offset} failed: ${error.message}`,
        );
      }
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) {
        const pid = stringOrNull(r[args.idColumn]);
        if (!pid) continue;
        counts.set(pid, (counts.get(pid) ?? 0) + 1);
        if (args.recencyColumn) {
          const raw = r[args.recencyColumn];
          const norm = normalizeRecency(raw);
          if (norm != null) {
            const prev = max.get(pid);
            if (prev == null || norm > prev) max.set(pid, norm);
          }
        }
      }
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }
  args.trace.push(
    `[aggregate] ${args.table} ids=${args.ids.length} returned ${counts.size} member(s) with hits`,
  );
  return { counts, max };
}

function normalizeRecency(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.length === 0) return null;
    // Already an ISO timestamp or a date-like string — both compare lexicographically
    // well enough for "max" purposes within the same column type.
    return t;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type Next18jBucket =
  | "auto_safe_backfill_candidate"
  | "conflict_with_existing_identifier_map"
  | "conflict_with_existing_product_columns"
  | "insufficient_identifiers"
  | "upc_only_review"
  | "sku_only_review"
  | "dirty_identifier"
  | "duplicate_orphan_group"
  | "already_represented_by_active_map_elsewhere"
  | "human_review_required"
  | "do_not_touch";

type Next18jConflictRow = {
  product_id: string;
  organization_id: string;
  store_id: string;
  bucket: Next18jBucket;
  duplicate_orphan_group_id: string;
  duplicate_orphan_group_size: number;
};

type Next18jDecisionEntry = {
  product_id: string;
  bucket: Next18jBucket;
  collision_evidence: Array<{
    kind: "sku" | "asin" | "fnsku" | "upc";
    scope: "same_store" | "store_wide" | "product_column";
    value: string;
    other_ids: string[];
  }>;
};

function reasoningHasFields(reasoning: unknown): boolean {
  if (!reasoning || typeof reasoning !== "object") return false;
  const r = reasoning as unknown as Record<string, unknown>;
  return (
    r.score_breakdown != null &&
    typeof r.score_breakdown === "object" &&
    Object.keys(r.score_breakdown as unknown as Record<string, unknown>).length >= DIMENSION_NAMES.length &&
    typeof r.composite_score === "number" &&
    Array.isArray(r.tiebreak_path) &&
    Array.isArray(r.block_reason_chain)
  );
}

function snapshotHasFields(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const s = snapshot as unknown as Record<string, unknown>;
  return (
    typeof s.product_id === "string" &&
    "merge_status" in s &&
    "merged_into_id" in s &&
    "deleted_at" in s &&
    "sku" in s &&
    "asin" in s &&
    "fnsku" in s &&
    "upc_code" in s
  );
}

function platformNeutralColumnWarnings(headers: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const h of headers) {
    const lc = h.toLowerCase();
    if (lc.startsWith("amzn_") || lc.startsWith("mws_")) offenders.push(h);
  }
  return offenders;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli(process.argv);
  loadEnvLocal();
  console.log("[NEXT-18K] starting merge-candidate / canonical-winner audit");
  const trace: string[] = [];

  // 1) Resolve input runs.
  const sel18j = selectInputRun({
    baseDir: NEXT18J_BASE_DIR,
    override: cli.inputRunNext18j,
    requiredFile: "02-conflicts.csv",
    trace,
    label: "next-18j",
  });
  const sel18g = selectInputRun({
    baseDir: NEXT18G_BASE_DIR,
    override: cli.inputRunNext18g,
    requiredFile: "01-enriched-conflict-clusters.json",
    trace,
    label: "next-18g",
  });
  console.log(`[NEXT-18K] next-18j=${sel18j.runId} (${sel18j.selectionReason})`);
  console.log(`[NEXT-18K] next-18g=${sel18g.runId} (${sel18g.selectionReason})`);

  // 2) Load NEXT-18J inputs from disk.
  const conflictsCsv = parseCsv(
    fs.readFileSync(path.join(sel18j.runDir, "02-conflicts.csv"), "utf8"),
  );
  trace.push(`[next-18j] 02-conflicts.csv rows=${conflictsCsv.length}`);
  const next18jSummary = JSON.parse(
    fs.readFileSync(path.join(sel18j.runDir, "run-summary.json"), "utf8"),
  ) as { tenant: { organization_id: string; store_id_filter: string | null } };
  const decisionTraceText = fs.readFileSync(
    path.join(sel18j.runDir, "logs", "decision-trace.ndjson"),
    "utf8",
  );
  const decisionByPid = new Map<string, Next18jDecisionEntry>();
  for (const line of decisionTraceText.split("\n")) {
    if (line.trim().length === 0) continue;
    const obj = JSON.parse(line) as Next18jDecisionEntry;
    decisionByPid.set(obj.product_id, obj);
  }

  // Split conflicts CSV by bucket.
  const shardARowsByGroup = new Map<string, Next18jConflictRow[]>();
  const shardBRows: Next18jConflictRow[] = [];
  for (const r of conflictsCsv) {
    const row: Next18jConflictRow = {
      product_id: r.product_id,
      organization_id: r.organization_id,
      store_id: r.store_id,
      bucket: r.bucket as Next18jBucket,
      duplicate_orphan_group_id: r.duplicate_orphan_group_id,
      duplicate_orphan_group_size: Number.parseInt(r.duplicate_orphan_group_size || "0", 10),
    };
    if (row.bucket === "duplicate_orphan_group") {
      const arr = shardARowsByGroup.get(row.duplicate_orphan_group_id);
      if (arr) arr.push(row);
      else shardARowsByGroup.set(row.duplicate_orphan_group_id, [row]);
    } else if (row.bucket === "conflict_with_existing_identifier_map") {
      shardBRows.push(row);
    }
  }
  trace.push(
    `[next-18j] shardA groups=${shardARowsByGroup.size} shardB rows=${shardBRows.length}`,
  );

  // 3) Load NEXT-18G clusters (pid set for cluster_membership_penalty).
  const clusters18g = JSON.parse(
    fs.readFileSync(path.join(sel18g.runDir, "01-enriched-conflict-clusters.json"), "utf8"),
  ) as Array<{ cluster_id: string; severity: string; conflicting_product_ids: string[] }>;
  const clusterPids = new Set<string>();
  for (const c of clusters18g) for (const pid of c.conflicting_product_ids) clusterPids.add(pid);

  // 4) Mismatch set (NEXT-18I 01-identifier-mismatch.csv via NEXT-18J inputs section).
  // NEXT-18J run-summary lists the NEXT-18I run; pick it up from there.
  const next18jManifest = JSON.parse(
    fs.readFileSync(path.join(sel18j.runDir, "manifest.json"), "utf8"),
  ) as { inputs?: { next_18i?: { runDir?: string } } };
  const mismatchSet = new Set<string>();
  const next18iRunDir = next18jManifest.inputs?.next_18i?.runDir;
  if (next18iRunDir && fs.existsSync(path.join(next18iRunDir, "01-identifier-mismatch.csv"))) {
    const mm = parseCsv(
      fs.readFileSync(path.join(next18iRunDir, "01-identifier-mismatch.csv"), "utf8"),
    );
    for (const r of mm) mismatchSet.add(r.product_id);
    trace.push(`[next-18i] mismatch rows=${mismatchSet.size}`);
  } else {
    trace.push(`[next-18i] mismatch CSV unavailable; mismatch set empty`);
  }

  // 5) Tenant.
  const orgId = cli.organizationId ?? next18jSummary.tenant.organization_id;
  if (!orgId || !isUuidString(orgId)) throw new Error(`Could not derive valid organization_id: ${orgId}`);
  console.log(`[NEXT-18K] tenant org=${orgId} store_filter=${cli.storeId ?? "<none>"}`);

  // 6) Output dir + manifest.
  const runId = mkRunId();
  const runDir = cli.outputDir ?? mkRunDir(NEXT18K_BASE_DIR, runId);
  if (cli.outputDir) fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
  console.log(`[NEXT-18K] runId=${runId}`);
  console.log(`[NEXT-18K] output_dir=${runDir}`);

  const cursorWriter = new NDJsonWriter(path.join(runDir, "logs", "page-cursors.ndjson"));
  const warnings: FetchWarning[] = [];

  const startedAt = new Date().toISOString();
  const manifest: RunMetadata & {
    inputs: {
      next_18j: { runId: string; runDir: string; startedAt: string; finishedAt: string };
      next_18g: { runId: string; runDir: string; startedAt: string; finishedAt: string };
      next_18i_run_dir: string | null;
    };
    tenant: { organization_id: string; store_id_filter: string | null };
    entryPoint: string;
  } = {
    runId,
    startedAt,
    finishedAt: null,
    cliArgs: {
      inputRunNext18j: cli.inputRunNext18j,
      inputRunNext18g: cli.inputRunNext18g,
      organizationId: cli.organizationId,
      storeId: cli.storeId,
      outputDir: cli.outputDir,
      shard: cli.shard,
      maxGroupSize: cli.maxGroupSize,
      hotThresholdDays: cli.hotThresholdDays,
      resolverHitThresholdDays: cli.resolverHitThresholdDays,
      pricesRecentThresholdDays: cli.pricesRecentThresholdDays,
    },
    envHash: sha256Hex(`${sel18j.runId}|${sel18g.runId}|${orgId}|${cli.storeId ?? ""}`),
    nodeVersion: process.version,
    supabaseJsVersion: getSupabaseJsVersion(),
    generatorGitSha: readGitSha(),
    inputs: {
      next_18j: {
        runId: sel18j.runId,
        runDir: sel18j.runDir,
        startedAt: sel18j.startedAt,
        finishedAt: sel18j.finishedAt,
      },
      next_18g: {
        runId: sel18g.runId,
        runDir: sel18g.runDir,
        startedAt: sel18g.startedAt,
        finishedAt: sel18g.finishedAt,
      },
      next_18i_run_dir: next18iRunDir ?? null,
    },
    tenant: { organization_id: orgId, store_id_filter: cli.storeId },
    entryPoint: "scripts/product-seed-merge-winner.ts",
  };
  writeManifest(runDir, manifest);

  // 7) Snapshot products + imap.
  const env = requireEnv();
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } });

  console.log(`[NEXT-18K] loading products snapshot (PAGE_SIZE=${PAGE_SIZE})`);
  const products = await pageProducts({ sb, organizationId: orgId, storeId: cli.storeId, cursorWriter, warnings });
  console.log(`[NEXT-18K]   products in scope = ${products.length}`);
  const productById = new Map(products.map((p) => [p.id, p]));

  console.log(`[NEXT-18K] loading active product_identifier_map`);
  const activeMap = await pageActiveMap({ sb, organizationId: orgId, storeId: cli.storeId, cursorWriter, warnings });
  console.log(`[NEXT-18K]   active map rows = ${activeMap.length}`);
  const activeImapByPid = new Map<string, ActiveMapRow[]>();
  for (const m of activeMap) {
    const arr = activeImapByPid.get(m.product_id);
    if (arr) arr.push(m);
    else activeImapByPid.set(m.product_id, [m]);
  }

  console.log(`[NEXT-18K] loading inactive product_identifier_map counts`);
  const inactiveImapCounts = await pageInactiveMapCounts({
    sb,
    organizationId: orgId,
    storeId: cli.storeId,
    cursorWriter,
    warnings,
  });
  console.log(`[NEXT-18K]   inactive map pids = ${inactiveImapCounts.size}`);

  await cursorWriter.close();

  // catalog-bridge presence is read directly from active imap rows (where any has catalog_product_id).
  // But our select-list does NOT include catalog_product_id today; we rely on imap presence as a proxy.
  // Re-query the catalog_product_id column lazily for every pid in the universe is too expensive — instead,
  // we set hasCatalogBridge = true iff the pid has at least one active imap row whose match_source starts
  // with 'catalog' OR whose source_report_type starts with 'catalog'. This is a deterministic proxy.
  function hasCatalogBridgeFor(pid: string): boolean {
    const rows = activeImapByPid.get(pid) ?? [];
    return rows.some((r) => {
      const ms = (r.match_source ?? "").toLowerCase();
      const sr = (r.source_report_type ?? "").toLowerCase();
      return ms.includes("catalog") || sr.includes("catalog");
    });
  }

  // 8) pim_duplicate_groups baseline.
  const existingDupGroupsCount = await readPimDuplicateGroupsCount(sb, orgId, warnings);
  trace.push(`[pim_duplicate_groups] existing rows for tenant = ${existingDupGroupsCount}`);

  // 9) Universe of member ids for which we need downstream aggregates.
  const memberUniverse = new Set<string>();
  for (const rows of shardARowsByGroup.values()) for (const r of rows) memberUniverse.add(r.product_id);
  for (const r of shardBRows) memberUniverse.add(r.product_id);
  // Also include external-winner candidates from Shard B decision-trace evidence.
  for (const r of shardBRows) {
    const dec = decisionByPid.get(r.product_id);
    if (!dec) continue;
    for (const ev of dec.collision_evidence) {
      if (ev.scope === "same_store") for (const o of ev.other_ids) memberUniverse.add(o);
    }
  }
  trace.push(`[universe] member ids = ${memberUniverse.size}`);
  const memberIds = [...memberUniverse];

  // 10) Column probe Amazon ops tables (the 6 resolved_product_id surfaces).
  console.log(`[NEXT-18K] probing recency columns on Amazon ops surfaces`);
  const probes: ColumnProbeRecord[] = [];
  // product_prices is well-known
  probes.push({
    table: "product_prices",
    chosen_column: "observed_at",
    tried: [{ column: "observed_at", ok: true }],
  });
  // amazon_reports_repository is well-known
  probes.push({
    table: "amazon_reports_repository",
    chosen_column: "transaction_release_date",
    tried: [{ column: "transaction_release_date", ok: true }],
  });
  for (const t of AMAZON_OPS_TABLES) {
    const probe = await probeRecencyColumn(sb, t, warnings);
    probes.push(probe);
    trace.push(`[column-probe] ${t} chosen=${probe.chosen_column ?? "<none>"}`);
  }
  writeJson(path.join(runDir, "logs", "column-probe.json"), probes);

  // 11) Issue chunked downstream aggregates.
  console.log(`[NEXT-18K] aggregating downstream surfaces (${memberIds.length} ids × 8 surfaces)`);
  const downstreamByMember = new Map<string, MemberDownstream>();
  for (const pid of memberIds) downstreamByMember.set(pid, emptyDownstream());

  for (const surface of DOWNSTREAM_SURFACES) {
    const probe = probes.find((p) => p.table === surface);
    const recencyCol = probe?.chosen_column ?? null;
    const idColumn: "product_id" | "resolved_product_id" = PRODUCT_ID_SURFACES.has(surface)
      ? "product_id"
      : "resolved_product_id";
    const { counts, max } = await aggregateSurface({
      sb,
      table: surface,
      idColumn,
      organizationId: orgId,
      ids: memberIds,
      recencyColumn: recencyCol,
      warnings,
      trace,
    });
    for (const [pid, count] of counts) {
      const d = downstreamByMember.get(pid);
      if (!d) continue;
      d[surface].row_count = count;
    }
    for (const [pid, ts] of max) {
      const d = downstreamByMember.get(pid);
      if (!d) continue;
      d[surface].max_event_time = ts;
    }
    const totalHits = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(`[NEXT-18K]   ${surface.padEnd(40)} hits=${totalHits} members=${counts.size}`);
  }

  // 12) Shard A classification.
  console.log(`[NEXT-18K] classifying Shard A (${shardARowsByGroup.size} groups)`);
  const nowIso = startedAt;
  const decisionWriter = new NDJsonWriter(path.join(runDir, "logs", "decision-trace.ndjson"));

  type ShardAMemberRow = {
    group_id: string;
    product_id: string;
    raw: RawScores;
    normalized: import("../lib/audits/product-seed-merge-winner").NormalizedScores;
    weighted: import("../lib/audits/product-seed-merge-winner").WeightedScores;
    composite: number;
    is_winner: boolean;
    rank_in_group: number;
    candidates: Candidates;
    inCluster: boolean;
    inMismatch: boolean;
    downstream: MemberDownstream;
  };
  const shardAMembers: ShardAMemberRow[] = [];
  const shardAWinners: Array<{
    selection: WinnerSelection;
    winnerComposite: number;
    runnerUpComposite: number | null;
  }> = [];
  const shardAEdges: Array<ReturnType<typeof buildMergeEdge>> = [];
  const shardABlocked: Array<{ selection: WinnerSelection; missing_product: boolean }> = [];

  for (const [groupId, rows] of shardARowsByGroup) {
    const memberIds = rows.map((r) => r.product_id);
    // Resolve to ProductRow (skip missing).
    const members = memberIds.map((id) => productById.get(id)).filter((p): p is ProductRow => p != null);
    if (members.length === 0) {
      warnings.push({ source: "shardA", reason: `group ${groupId}: no resolvable members in products snapshot` });
      continue;
    }
    const candidatesByMember = new Map<string, Candidates>();
    const rawByMember = new Map<string, RawScores>();
    const inClusterByMember = new Map<string, boolean>();
    const inMismatchByMember = new Map<string, boolean>();
    const downstreamSubmap = new Map<string, MemberDownstream>();
    for (const p of members) {
      const c = deriveCandidates(p);
      candidatesByMember.set(p.id, c);
      const inCluster = clusterPids.has(p.id);
      const inMismatch = mismatchSet.has(p.id);
      inClusterByMember.set(p.id, inCluster);
      inMismatchByMember.set(p.id, inMismatch);
      const d = downstreamByMember.get(p.id) ?? emptyDownstream();
      downstreamSubmap.set(p.id, d);
      rawByMember.set(p.id, computeRawScores({
        product: p,
        candidates: c,
        activeImapCount: (activeImapByPid.get(p.id) ?? []).length,
        inactiveImapCount: inactiveImapCounts.get(p.id) ?? 0,
        hasCatalogBridge: hasCatalogBridgeFor(p.id),
        inCluster,
        inMismatch,
        downstream: d,
        nowIso,
      }));
    }
    const normalizedByMember = normalizeScoresInGroup(rawByMember);
    const weightedByMember = new Map<string, ReturnType<typeof weightedScores>>();
    const compositeByMember = new Map<string, number>();
    for (const [id, norm] of normalizedByMember) {
      const w = weightedScores(norm);
      weightedByMember.set(id, w);
      compositeByMember.set(id, compositeScore(w));
    }
    const identifierAuthority = buildIdentifierAuthority(candidatesByMember);

    const selection = selectShardAWinner({
      groupId,
      members: members.map((m) => m.id),
      rawByMember,
      normalizedByMember,
      weightedByMember,
      compositeByMember,
      productById,
      candidatesByMember,
      downstreamByMember: downstreamSubmap,
      inClusterByMember,
      inMismatchByMember,
      identifierAuthority,
      maxGroupSize: cli.maxGroupSize,
    });
    const winnerComposite = compositeByMember.get(selection.winnerId) ?? 0;
    const runnerUpId = selection.rankedMembers[1] ?? null;
    const runnerUpComposite = runnerUpId ? (compositeByMember.get(runnerUpId) ?? 0) : null;
    shardAWinners.push({ selection, winnerComposite, runnerUpComposite });
    if (!selection.safeToMerge) shardABlocked.push({ selection, missing_product: members.length !== rows.length });

    selection.rankedMembers.forEach((pid, idx) => {
      const raw = rawByMember.get(pid)!;
      const norm = normalizedByMember.get(pid)!;
      const w = weightedByMember.get(pid)!;
      const cs = compositeByMember.get(pid)!;
      const c = candidatesByMember.get(pid)!;
      shardAMembers.push({
        group_id: groupId,
        product_id: pid,
        raw,
        normalized: norm,
        weighted: w,
        composite: cs,
        is_winner: pid === selection.winnerId,
        rank_in_group: idx + 1,
        candidates: c,
        inCluster: inClusterByMember.get(pid) ?? false,
        inMismatch: inMismatchByMember.get(pid) ?? false,
        downstream: downstreamSubmap.get(pid) ?? emptyDownstream(),
      });
    });

    // Build edges.
    const winner = productById.get(selection.winnerId)!;
    const winnerActiveImapCount = (activeImapByPid.get(winner.id) ?? []).length;
    for (const pid of selection.rankedMembers) {
      if (pid === selection.winnerId) continue;
      const loser = productById.get(pid);
      if (!loser) continue;
      const loserActiveImapCount = (activeImapByPid.get(loser.id) ?? []).length;
      const loserDownstream = downstreamSubmap.get(pid) ?? emptyDownstream();
      const edge = buildMergeEdge({
        groupId,
        winner,
        loser,
        loserDownstream,
        loserActiveImapCount,
        winnerActiveImapCount,
        cycleCheckPass: true, // re-validated by J4
        hotThresholdDays: cli.hotThresholdDays,
        nowIso,
      });
      shardAEdges.push(edge);
    }

    decisionWriter.write({
      shard: "A",
      group_id: groupId,
      group_size: members.length,
      winner_id: selection.winnerId,
      winner_composite: winnerComposite,
      runner_up_composite: runnerUpComposite,
      score_margin: selection.scoreMargin,
      safe_to_merge: selection.safeToMerge,
      block_reasons: selection.blockReasons,
      tiebreak_path: selection.tiebreakPath,
      identifier_authority: identifierAuthority,
      members: selection.rankedMembers,
    });
  }

  // 13) Shard B classification.
  console.log(`[NEXT-18K] classifying Shard B (${shardBRows.length} orphans)`);
  const shardBClassifications: ShardBClassification[] = [];
  const shardBEdges: Array<{
    orphan_id: string;
    external_winner_id: string;
    organization_id: string;
    store_id: string | null;
    downstream_rewrite_count: number;
    cascade_delete_risk: number;
    per_surface_rewrite_counts: Record<SurfaceName, number>;
    imap_action: "rewrite_product_id" | "create_winner_imap_row" | "no_imap_action";
    hot_loser_flag: boolean;
    most_recent_activity_across_surfaces: string | null;
    proposed_loser_state: { merge_status: "merged"; merged_into_id: string };
    cycle_check_pass: true;
    merged_into_chain_depth_after_merge: 1;
  }> = [];
  const shardBBlocked: ShardBClassification[] = [];

  for (const row of shardBRows) {
    const orphan = productById.get(row.product_id);
    if (!orphan) {
      warnings.push({ source: "shardB", reason: `orphan ${row.product_id} missing from products snapshot` });
      continue;
    }
    // Resolve external-winner candidates from decision-trace.
    const dec = decisionByPid.get(orphan.id);
    const candIds = new Set<string>();
    if (dec) {
      for (const ev of dec.collision_evidence) {
        if (ev.scope === "same_store") for (const o of ev.other_ids) candIds.add(o);
      }
    }
    const candList = [...candIds].sort();
    let externalWinner: ProductRow | null = null;
    if (candList.length === 1) externalWinner = productById.get(candList[0]) ?? null;

    const orphanCandidates = deriveCandidates(orphan);
    const orphanDownstream = downstreamByMember.get(orphan.id) ?? emptyDownstream();
    const orphanInputs = {
      product: orphan,
      candidates: orphanCandidates,
      activeImapCount: (activeImapByPid.get(orphan.id) ?? []).length,
      inactiveImapCount: inactiveImapCounts.get(orphan.id) ?? 0,
      hasCatalogBridge: hasCatalogBridgeFor(orphan.id),
      inCluster: clusterPids.has(orphan.id),
      inMismatch: mismatchSet.has(orphan.id),
      downstream: orphanDownstream,
      nowIso,
    };
    let externalInputs: typeof orphanInputs | null = null;
    if (externalWinner) {
      const ec = deriveCandidates(externalWinner);
      externalInputs = {
        product: externalWinner,
        candidates: ec,
        activeImapCount: (activeImapByPid.get(externalWinner.id) ?? []).length,
        inactiveImapCount: inactiveImapCounts.get(externalWinner.id) ?? 0,
        hasCatalogBridge: hasCatalogBridgeFor(externalWinner.id),
        inCluster: clusterPids.has(externalWinner.id),
        inMismatch: mismatchSet.has(externalWinner.id),
        downstream: downstreamByMember.get(externalWinner.id) ?? emptyDownstream(),
        nowIso,
      };
    }

    const cls = classifyShardB({
      orphanInputs,
      externalWinner,
      externalWinnerCandidates: candList,
      externalInputs,
      pricesRecentThresholdDays: cli.pricesRecentThresholdDays,
      resolverHitThresholdDays: cli.resolverHitThresholdDays,
      nowIso,
    });
    shardBClassifications.push(cls);

    decisionWriter.write({
      shard: "B",
      orphan_id: cls.orphan_id,
      external_winner_id: cls.external_winner_id,
      external_winner_candidates: cls.external_winner_candidates,
      safe_to_merge: cls.safe_to_merge,
      block_reasons: cls.block_reasons,
      identifier_authority: cls.identifier_authority,
      orphan_composite: cls.orphan_composite,
      external_composite: cls.external_composite,
      downstream_rewrite_count: cls.downstream_rewrite_count,
      per_surface_rewrite_counts: cls.per_surface_rewrite_counts,
    });

    if (cls.safe_to_merge && cls.external_winner_id) {
      const orphanActiveImapCount = (activeImapByPid.get(orphan.id) ?? []).length;
      const winnerActiveImapCount = (activeImapByPid.get(cls.external_winner_id) ?? []).length;
      let imapAction: "rewrite_product_id" | "create_winner_imap_row" | "no_imap_action";
      if (orphanActiveImapCount > 0) imapAction = "rewrite_product_id";
      else if (winnerActiveImapCount === 0) imapAction = "create_winner_imap_row";
      else imapAction = "no_imap_action";
      const recent = memberMostRecentActivity(orphan, orphanDownstream);
      const recentDays = recent ? daysBetween(nowIso, recent) : null;
      const hot = recentDays != null && recentDays <= cli.hotThresholdDays;
      shardBEdges.push({
        orphan_id: cls.orphan_id,
        external_winner_id: cls.external_winner_id,
        organization_id: orphan.organization_id,
        store_id: orphan.store_id,
        downstream_rewrite_count: cls.downstream_rewrite_count,
        cascade_delete_risk: cls.cascade_delete_risk,
        per_surface_rewrite_counts: cls.per_surface_rewrite_counts,
        imap_action: imapAction,
        hot_loser_flag: hot,
        most_recent_activity_across_surfaces: recent,
        proposed_loser_state: { merge_status: "merged", merged_into_id: cls.external_winner_id },
        cycle_check_pass: true,
        merged_into_chain_depth_after_merge: 1,
      });
    } else {
      shardBBlocked.push(cls);
    }
  }

  await decisionWriter.close();

  // 14) Build CSV rows.

  // 00-shardA-groups-summary.csv
  const shardAGroupRows = shardAWinners.map((g) => {
    const groupId = g.selection.groupId;
    const groupAEdges = shardAEdges.filter((e) => e.group_id === groupId);
    const winner = productById.get(g.selection.winnerId)!;
    const losers = g.selection.rankedMembers.filter((id) => id !== g.selection.winnerId);
    const dupSize = g.selection.rankedMembers.length;
    const clusterOverlap = g.selection.rankedMembers.filter((id) => clusterPids.has(id)).length;
    const mismatchOverlap = g.selection.rankedMembers.filter((id) => mismatchSet.has(id)).length;
    return {
      group_id: groupId,
      organization_id: winner.organization_id,
      store_id: winner.store_id ?? "",
      size: dupSize,
      winner_id: g.selection.winnerId,
      winner_composite_score: g.winnerComposite,
      second_place_id: g.selection.rankedMembers[1] ?? "",
      score_margin: g.selection.scoreMargin,
      safe_to_merge: g.selection.safeToMerge,
      block_reason: g.selection.blockReasons.join("|"),
      loser_ids: losers.join("|"),
      total_downstream_rewrites_for_group: groupAEdges.reduce(
        (a, e) => a + e.downstream_rewrite_count,
        0,
      ),
      total_prices_inherited: groupAEdges.reduce((a, e) => a + e.cascade_delete_risk, 0),
      any_hot_loser: groupAEdges.some((e) => e.hot_loser_flag),
      cluster_overlap_count: clusterOverlap,
      mismatch_overlap_count: mismatchOverlap,
      identifier_authority_conflict_kinds: g.selection.identifierAuthority.identifier_conflicts
        .map((c) => c.kind)
        .join("|"),
      tiebreak_path: JSON.stringify(g.selection.tiebreakPath),
    };
  });
  const shardAGroupHeaders = [
    "group_id",
    "organization_id",
    "store_id",
    "size",
    "winner_id",
    "winner_composite_score",
    "second_place_id",
    "score_margin",
    "safe_to_merge",
    "block_reason",
    "loser_ids",
    "total_downstream_rewrites_for_group",
    "total_prices_inherited",
    "any_hot_loser",
    "cluster_overlap_count",
    "mismatch_overlap_count",
    "identifier_authority_conflict_kinds",
    "tiebreak_path",
  ];
  writeCsv(path.join(runDir, "00-shardA-groups-summary.csv"), shardAGroupHeaders, shardAGroupRows);

  // 01-shardA-members-scored.csv
  const shardAMemberHeaders = [
    "group_id",
    "product_id",
    "rank_in_group",
    "is_winner",
    "composite_score",
    ...DIMENSION_NAMES.flatMap((d) => [`raw_${d}`, `norm_${d}`, `weighted_${d}`]),
    "in_cluster",
    "in_mismatch",
    "active_imap_count",
    "inactive_imap_count",
    "has_catalog_bridge",
    "total_downstream_rows",
    "most_recent_activity_across_surfaces",
    "candidate_sku",
    "candidate_asin",
    "candidate_fnsku",
    "candidate_upc",
  ];
  const shardAMemberRows = shardAMembers.map((m) => {
    const downstreamSum = (Object.values(m.downstream) as Array<{ row_count: number }>).reduce(
      (a, s) => a + s.row_count,
      0,
    );
    const product = productById.get(m.product_id)!;
    const recent = memberMostRecentActivity(product, m.downstream);
    const row: Record<string, unknown> = {
      group_id: m.group_id,
      product_id: m.product_id,
      rank_in_group: m.rank_in_group,
      is_winner: m.is_winner,
      composite_score: m.composite,
      in_cluster: m.inCluster,
      in_mismatch: m.inMismatch,
      active_imap_count: (activeImapByPid.get(m.product_id) ?? []).length,
      inactive_imap_count: inactiveImapCounts.get(m.product_id) ?? 0,
      has_catalog_bridge: hasCatalogBridgeFor(m.product_id),
      total_downstream_rows: downstreamSum,
      most_recent_activity_across_surfaces: recent ?? "",
      candidate_sku: m.candidates.sku?.normalized ?? "",
      candidate_asin: m.candidates.asin?.normalized ?? "",
      candidate_fnsku: m.candidates.fnsku?.normalized ?? "",
      candidate_upc: m.candidates.upc?.normalized ?? "",
    };
    for (const d of DIMENSION_NAMES) {
      row[`raw_${d}`] = m.raw[d];
      row[`norm_${d}`] = m.normalized[d];
      row[`weighted_${d}`] = m.weighted[d];
    }
    return row;
  });
  writeCsv(path.join(runDir, "01-shardA-members-scored.csv"), shardAMemberHeaders, shardAMemberRows);

  // 02-shardA-winners.csv (must carry non-empty `reasoning` per J16)
  const shardAWinnersHeaders = [
    "group_id",
    "winner_id",
    "organization_id",
    "store_id",
    "winner_composite_score",
    "runner_up_id",
    "runner_up_composite_score",
    "score_margin",
    "safe_to_merge",
    "block_reasons",
    "winner_strong_identifier_kinds",
    "winner_identifier_set",
    "reasoning",
  ];
  const shardAWinnersRows = shardAWinners.map((g) => {
    const sel = g.selection;
    const winner = productById.get(sel.winnerId)!;
    const winnerCandidates = deriveCandidates(winner);
    const winnerStrong = [winnerCandidates.sku, winnerCandidates.asin, winnerCandidates.fnsku, winnerCandidates.upc]
      .filter((c) => c && c.shape_valid)
      .map((c) => c!.kind);
    const winnerMember = shardAMembers.find(
      (m) => m.group_id === sel.groupId && m.product_id === sel.winnerId,
    )!;
    const reasoning = buildReasoning({
      raw: winnerMember.raw,
      normalized: winnerMember.normalized,
      weighted: winnerMember.weighted,
      composite: winnerMember.composite,
      tiebreakPath: sel.tiebreakPath,
      blockReasons: sel.blockReasons,
    });
    return {
      group_id: sel.groupId,
      winner_id: sel.winnerId,
      organization_id: winner.organization_id,
      store_id: winner.store_id ?? "",
      winner_composite_score: g.winnerComposite,
      runner_up_id: sel.rankedMembers[1] ?? "",
      runner_up_composite_score: g.runnerUpComposite ?? "",
      score_margin: sel.scoreMargin,
      safe_to_merge: sel.safeToMerge,
      block_reasons: sel.blockReasons.join("|"),
      winner_strong_identifier_kinds: winnerStrong.join("|"),
      winner_identifier_set: JSON.stringify(sel.identifierAuthority.winner_identifier_set),
      reasoning: JSON.stringify(reasoning),
    };
  });
  writeCsv(path.join(runDir, "02-shardA-winners.csv"), shardAWinnersHeaders, shardAWinnersRows);

  // 03-shardA-merge-edges.csv
  const shardAEdgeHeaders = [
    "group_id",
    "loser_id",
    "winner_id",
    "organization_id",
    "store_id",
    "downstream_rewrite_count",
    "cascade_delete_risk",
    "imap_action",
    "cycle_check_pass",
    "merged_into_chain_depth_after_merge",
    "hot_loser_flag",
    "most_recent_activity_across_surfaces",
    "proposed_loser_state",
    ...DOWNSTREAM_SURFACES.map((s) => `surface_${s}_count`),
  ];
  const shardAEdgeRows = shardAEdges.map((e) => {
    const row: Record<string, unknown> = {
      group_id: e.group_id,
      loser_id: e.loser_id,
      winner_id: e.winner_id,
      organization_id: e.organization_id,
      store_id: e.store_id ?? "",
      downstream_rewrite_count: e.downstream_rewrite_count,
      cascade_delete_risk: e.cascade_delete_risk,
      imap_action: e.imap_action,
      cycle_check_pass: e.cycle_check_pass,
      merged_into_chain_depth_after_merge: e.merged_into_chain_depth_after_merge,
      hot_loser_flag: e.hot_loser_flag,
      most_recent_activity_across_surfaces: e.most_recent_activity_across_surfaces ?? "",
      proposed_loser_state: JSON.stringify(e.proposed_loser_state),
    };
    for (const s of DOWNSTREAM_SURFACES) row[`surface_${s}_count`] = e.per_surface_rewrite_counts[s];
    return row;
  });
  writeCsv(path.join(runDir, "03-shardA-merge-edges.csv"), shardAEdgeHeaders, shardAEdgeRows);

  // 04-shardA-cascade-risks.csv (must carry non-empty `evidence_snapshot` per J17)
  const shardACascadeHeaders = [
    "group_id",
    "loser_id",
    "winner_id",
    "organization_id",
    "store_id",
    "cascade_delete_risk",
    "product_prices_count",
    "product_prices_max_observed_at",
    "amazon_reports_repository_count",
    "amazon_reports_repository_max_event_time",
    "amazon_inventory_ledger_count",
    "amazon_all_orders_count",
    "amazon_settlements_count",
    "amazon_transactions_count",
    "amazon_manage_fba_inventory_count",
    "amazon_amazon_fulfilled_inventory_count",
    "total_downstream_rewrites",
    "hot_loser_flag",
    "evidence_snapshot",
  ];
  const shardACascadeRows = shardAEdges.map((e) => {
    const loser = productById.get(e.loser_id)!;
    const dn = downstreamByMember.get(loser.id) ?? emptyDownstream();
    const snapshot = buildEvidenceSnapshot(loser, nowIso);
    return {
      group_id: e.group_id,
      loser_id: e.loser_id,
      winner_id: e.winner_id,
      organization_id: e.organization_id,
      store_id: e.store_id ?? "",
      cascade_delete_risk: e.cascade_delete_risk,
      product_prices_count: dn.product_prices.row_count,
      product_prices_max_observed_at: dn.product_prices.max_event_time ?? "",
      amazon_reports_repository_count: dn.amazon_reports_repository.row_count,
      amazon_reports_repository_max_event_time: dn.amazon_reports_repository.max_event_time ?? "",
      amazon_inventory_ledger_count: dn.amazon_inventory_ledger.row_count,
      amazon_all_orders_count: dn.amazon_all_orders.row_count,
      amazon_settlements_count: dn.amazon_settlements.row_count,
      amazon_transactions_count: dn.amazon_transactions.row_count,
      amazon_manage_fba_inventory_count: dn.amazon_manage_fba_inventory.row_count,
      amazon_amazon_fulfilled_inventory_count: dn.amazon_amazon_fulfilled_inventory.row_count,
      total_downstream_rewrites: e.downstream_rewrite_count,
      hot_loser_flag: e.hot_loser_flag,
      evidence_snapshot: JSON.stringify(snapshot),
    };
  });
  writeCsv(path.join(runDir, "04-shardA-cascade-risks.csv"), shardACascadeHeaders, shardACascadeRows);

  // 05-shardA-identifier-authority.csv (one row per group per kind)
  const shardAIdHeaders = [
    "group_id",
    "kind",
    "result",
    "winner_value",
    "contributing_members",
    "conflict_values",
    "conflict_members",
  ];
  const shardAIdRows: Array<Record<string, unknown>> = [];
  for (const g of shardAWinners) {
    const ia = g.selection.identifierAuthority;
    const allKinds = new Set<string>([
      ...Object.keys(ia.winner_identifier_set),
      ...ia.identifier_conflicts.map((c) => c.kind),
    ]);
    for (const k of allKinds) {
      const winnerValue = ia.winner_identifier_set[k as keyof typeof ia.winner_identifier_set];
      const conflict = ia.identifier_conflicts.find((c) => c.kind === k);
      shardAIdRows.push({
        group_id: g.selection.groupId,
        kind: k,
        result: conflict ? "conflict" : "adopted",
        winner_value: winnerValue ?? "",
        contributing_members: (ia.contributing_members[k as keyof typeof ia.contributing_members] ?? []).join("|"),
        conflict_values: conflict ? conflict.values.join("|") : "",
        conflict_members: conflict ? conflict.members.join("|") : "",
      });
    }
  }
  writeCsv(path.join(runDir, "05-shardA-identifier-authority.csv"), shardAIdHeaders, shardAIdRows);

  // 06-shardA-blocked-groups.csv
  const shardABlockedHeaders = [
    "group_id",
    "size",
    "block_reasons",
    "winner_id",
    "winner_composite_score",
    "cluster_overlap_count",
    "mismatch_overlap_count",
    "identifier_authority_conflict_kinds",
    "tiebreak_path",
    "missing_product_in_snapshot",
  ];
  const shardABlockedRows = shardABlocked.map((b) => {
    const winnerMember = shardAMembers.find(
      (m) => m.group_id === b.selection.groupId && m.product_id === b.selection.winnerId,
    );
    return {
      group_id: b.selection.groupId,
      size: b.selection.rankedMembers.length,
      block_reasons: b.selection.blockReasons.join("|"),
      winner_id: b.selection.winnerId,
      winner_composite_score: winnerMember?.composite ?? "",
      cluster_overlap_count: b.selection.rankedMembers.filter((id) => clusterPids.has(id)).length,
      mismatch_overlap_count: b.selection.rankedMembers.filter((id) => mismatchSet.has(id)).length,
      identifier_authority_conflict_kinds: b.selection.identifierAuthority.identifier_conflicts
        .map((c) => c.kind)
        .join("|"),
      tiebreak_path: JSON.stringify(b.selection.tiebreakPath),
      missing_product_in_snapshot: b.missing_product,
    };
  });
  writeCsv(path.join(runDir, "06-shardA-blocked-groups.csv"), shardABlockedHeaders, shardABlockedRows);

  // 07-shardB-orphan-vs-external.csv (all 572)
  const shardBPairHeaders = [
    "orphan_id",
    "organization_id",
    "store_id",
    "external_winner_id",
    "external_winner_candidates",
    "safe_to_merge",
    "block_reasons",
    "orphan_composite_score",
    "external_winner_composite_score",
    "orphan_strong_identifier_kinds",
    "external_winner_strong_identifier_kinds",
    "identifier_conflicts",
    "total_downstream_rewrites",
    "prices_count",
    "prices_max_observed_at",
    "orphan_most_recent_activity",
    "reasoning",
    ...DOWNSTREAM_SURFACES.map((s) => `surface_${s}_count`),
  ];
  const shardBPairRows = shardBClassifications.map((cls) => {
    const orphan = productById.get(cls.orphan_id)!;
    const orphanCands = deriveCandidates(orphan);
    const orphanStrong = [orphanCands.sku, orphanCands.asin, orphanCands.fnsku, orphanCands.upc]
      .filter((c) => c && c.shape_valid)
      .map((c) => c!.kind);
    let externalStrong: string[] = [];
    if (cls.external_winner_id) {
      const ew = productById.get(cls.external_winner_id);
      if (ew) {
        const ec = deriveCandidates(ew);
        externalStrong = [ec.sku, ec.asin, ec.fnsku, ec.upc]
          .filter((c) => c && c.shape_valid)
          .map((c) => c!.kind);
      }
    }
    const reasoning = buildReasoning({
      raw: cls.orphan_raw,
      normalized: cls.orphan_normalized,
      weighted: cls.orphan_weighted,
      composite: cls.orphan_composite,
      tiebreakPath: [],
      blockReasons: cls.block_reasons,
    });
    const row: Record<string, unknown> = {
      orphan_id: cls.orphan_id,
      organization_id: orphan.organization_id,
      store_id: orphan.store_id ?? "",
      external_winner_id: cls.external_winner_id ?? "",
      external_winner_candidates: cls.external_winner_candidates.join("|"),
      safe_to_merge: cls.safe_to_merge,
      block_reasons: cls.block_reasons.join("|"),
      orphan_composite_score: cls.orphan_composite,
      external_winner_composite_score: cls.external_composite ?? "",
      orphan_strong_identifier_kinds: orphanStrong.join("|"),
      external_winner_strong_identifier_kinds: externalStrong.join("|"),
      identifier_conflicts: JSON.stringify(cls.identifier_authority.identifier_conflicts),
      total_downstream_rewrites: cls.downstream_rewrite_count,
      prices_count: cls.cascade_delete_risk,
      prices_max_observed_at: cls.prices_max_observed_at ?? "",
      orphan_most_recent_activity: cls.orphan_most_recent_activity ?? "",
      reasoning: JSON.stringify(reasoning),
    };
    for (const s of DOWNSTREAM_SURFACES) row[`surface_${s}_count`] = cls.per_surface_rewrite_counts[s];
    return row;
  });
  writeCsv(path.join(runDir, "07-shardB-orphan-vs-external.csv"), shardBPairHeaders, shardBPairRows);

  // 08-shardB-merge-edges.csv
  const shardBEdgeHeaders = [
    "orphan_id",
    "external_winner_id",
    "organization_id",
    "store_id",
    "downstream_rewrite_count",
    "cascade_delete_risk",
    "imap_action",
    "cycle_check_pass",
    "merged_into_chain_depth_after_merge",
    "hot_loser_flag",
    "most_recent_activity_across_surfaces",
    "proposed_loser_state",
    ...DOWNSTREAM_SURFACES.map((s) => `surface_${s}_count`),
  ];
  const shardBEdgeRows = shardBEdges.map((e) => {
    const row: Record<string, unknown> = {
      orphan_id: e.orphan_id,
      external_winner_id: e.external_winner_id,
      organization_id: e.organization_id,
      store_id: e.store_id ?? "",
      downstream_rewrite_count: e.downstream_rewrite_count,
      cascade_delete_risk: e.cascade_delete_risk,
      imap_action: e.imap_action,
      cycle_check_pass: e.cycle_check_pass,
      merged_into_chain_depth_after_merge: e.merged_into_chain_depth_after_merge,
      hot_loser_flag: e.hot_loser_flag,
      most_recent_activity_across_surfaces: e.most_recent_activity_across_surfaces ?? "",
      proposed_loser_state: JSON.stringify(e.proposed_loser_state),
    };
    for (const s of DOWNSTREAM_SURFACES) row[`surface_${s}_count`] = e.per_surface_rewrite_counts[s];
    return row;
  });
  writeCsv(path.join(runDir, "08-shardB-merge-edges.csv"), shardBEdgeHeaders, shardBEdgeRows);

  // 09-shardB-blocked.csv
  const shardBBlockedHeaders = [
    "orphan_id",
    "organization_id",
    "store_id",
    "block_reasons",
    "external_winner_id",
    "external_winner_candidates_count",
    "total_downstream_rewrites",
    "identifier_conflicts_count",
  ];
  const shardBBlockedRows = shardBBlocked.map((cls) => {
    const orphan = productById.get(cls.orphan_id)!;
    return {
      orphan_id: cls.orphan_id,
      organization_id: orphan.organization_id,
      store_id: orphan.store_id ?? "",
      block_reasons: cls.block_reasons.join("|"),
      external_winner_id: cls.external_winner_id ?? "",
      external_winner_candidates_count: cls.external_winner_candidates.length,
      total_downstream_rewrites: cls.downstream_rewrite_count,
      identifier_conflicts_count: cls.identifier_authority.identifier_conflicts.length,
    };
  });
  writeCsv(path.join(runDir, "09-shardB-blocked.csv"), shardBBlockedHeaders, shardBBlockedRows);

  // 15) J-checks.
  type JCheckResult =
    | { name: string; pass: true; strict: boolean; note?: string }
    | { name: string; pass: false; strict: boolean; note: string; offenders?: unknown[] };
  const jChecks: JCheckResult[] = [];

  // J1: each Shard A group has exactly one winner.
  const winnersByGroup = new Map<string, string[]>();
  for (const r of shardAWinnersRows) {
    const arr = winnersByGroup.get(String(r.group_id)) ?? [];
    arr.push(String(r.winner_id));
    winnersByGroup.set(String(r.group_id), arr);
  }
  const j1Offenders = [...winnersByGroup.entries()].filter(([, v]) => v.length !== 1);
  jChecks.push(
    j1Offenders.length === 0
      ? { name: "J1_one_winner_per_group", pass: true, strict: true, note: `groups=${winnersByGroup.size}` }
      : {
          name: "J1_one_winner_per_group",
          pass: false,
          strict: true,
          note: `${j1Offenders.length} group(s) with ≠1 winner`,
          offenders: j1Offenders.slice(0, 5).map(([gid, v]) => `${gid}:${v.length}`),
        },
  );

  // J2: winners ∪ losers == NEXT-18J duplicate_orphan_group set.
  const allShardAMembers = new Set<string>();
  for (const r of shardAMemberRows) allShardAMembers.add(String(r.product_id));
  const next18jDupOrphanSet = new Set<string>();
  for (const rows of shardARowsByGroup.values()) for (const r of rows) next18jDupOrphanSet.add(r.product_id);
  const j2Missing = [...next18jDupOrphanSet].filter((id) => !allShardAMembers.has(id));
  const j2Extra = [...allShardAMembers].filter((id) => !next18jDupOrphanSet.has(id));
  jChecks.push(
    j2Missing.length === 0 && j2Extra.length === 0
      ? {
          name: "J2_winners_losers_eq_next18j",
          pass: true,
          strict: true,
          note: `set size=${allShardAMembers.size}`,
        }
      : {
          name: "J2_winners_losers_eq_next18j",
          pass: false,
          strict: true,
          note: `missing=${j2Missing.length} extra=${j2Extra.length}`,
          offenders: [...j2Missing.slice(0, 5), ...j2Extra.slice(0, 5)],
        },
  );

  // J3: |winners| == |groups|.
  jChecks.push(
    shardAWinnersRows.length === shardARowsByGroup.size
      ? {
          name: "J3_winners_size_eq_groups",
          pass: true,
          strict: true,
          note: `winners=${shardAWinnersRows.length}`,
        }
      : {
          name: "J3_winners_size_eq_groups",
          pass: false,
          strict: true,
          note: `winners=${shardAWinnersRows.length} groups=${shardARowsByGroup.size}`,
        },
  );

  // J4: no winner is a loser in any other Shard A edge (acyclicity).
  const allWinnerIds = new Set(shardAWinnersRows.map((r) => String(r.winner_id)));
  const j4Bad: string[] = [];
  for (const e of shardAEdges) {
    if (allWinnerIds.has(e.loser_id) && shardAWinnersRows.find((r) => r.winner_id === e.loser_id)) {
      // ok if same group — but loser cannot equal winner in same edge
      if (e.loser_id === e.winner_id) continue;
      // Cross-group acyclicity check: loser appears as winner anywhere
      const winnerGroups = shardAWinnersRows.filter((r) => r.winner_id === e.loser_id);
      if (winnerGroups.length > 0) j4Bad.push(`${e.loser_id}:winner_of:${winnerGroups[0].group_id}`);
    }
  }
  jChecks.push(
    j4Bad.length === 0
      ? { name: "J4_acyclicity", pass: true, strict: true, note: `edges=${shardAEdges.length}` }
      : {
          name: "J4_acyclicity",
          pass: false,
          strict: true,
          note: `${j4Bad.length} edges where loser is a winner elsewhere`,
          offenders: j4Bad.slice(0, 5),
        },
  );

  // J5: every edge has identical org/store on both ends.
  const j5Bad: string[] = [];
  for (const e of shardAEdges) {
    const w = productById.get(e.winner_id)!;
    const l = productById.get(e.loser_id)!;
    if (w.organization_id !== l.organization_id || (w.store_id ?? "") !== (l.store_id ?? "")) {
      j5Bad.push(`${e.loser_id}->${e.winner_id}`);
    }
  }
  for (const e of shardBEdges) {
    const w = productById.get(e.external_winner_id)!;
    const l = productById.get(e.orphan_id)!;
    if (!w || !l) continue;
    if (w.organization_id !== l.organization_id || (w.store_id ?? "") !== (l.store_id ?? "")) {
      j5Bad.push(`${e.orphan_id}->${e.external_winner_id}`);
    }
  }
  jChecks.push(
    j5Bad.length === 0
      ? { name: "J5_edge_org_store_consistency", pass: true, strict: true }
      : {
          name: "J5_edge_org_store_consistency",
          pass: false,
          strict: true,
          note: `${j5Bad.length} cross-tenant edges`,
          offenders: j5Bad.slice(0, 5),
        },
  );

  // J6: composite(winner) > composite(loser) for every edge in a safe_to_merge group.
  const safeGroupIds = new Set(
    shardAWinnersRows.filter((r) => r.safe_to_merge === true).map((r) => String(r.group_id)),
  );
  const j6Bad: string[] = [];
  for (const e of shardAEdges) {
    if (!safeGroupIds.has(e.group_id)) continue;
    const winnerM = shardAMembers.find(
      (m) => m.group_id === e.group_id && m.product_id === e.winner_id,
    )!;
    const loserM = shardAMembers.find(
      (m) => m.group_id === e.group_id && m.product_id === e.loser_id,
    )!;
    if (!(winnerM.composite > loserM.composite)) {
      j6Bad.push(`${e.group_id}:${e.loser_id}:${loserM.composite}>=${winnerM.composite}`);
    }
  }
  jChecks.push(
    j6Bad.length === 0
      ? {
          name: "J6_winner_composite_strictly_greater",
          pass: true,
          strict: true,
          note: `safe_groups=${safeGroupIds.size}`,
        }
      : {
          name: "J6_winner_composite_strictly_greater",
          pass: false,
          strict: true,
          note: `${j6Bad.length} safe edges with composite(winner) <= composite(loser)`,
          offenders: j6Bad.slice(0, 5),
        },
  );

  // J7: tenant scoping — every output row has expected org id.
  const allRows: Array<Record<string, unknown>> = [
    ...shardAGroupRows,
    ...shardAMemberRows,
    ...shardAWinnersRows,
    ...shardAEdgeRows,
    ...shardACascadeRows,
    ...shardABlockedRows,
    ...shardBPairRows,
    ...shardBEdgeRows,
    ...shardBBlockedRows,
  ];
  const j7Bad = allRows.filter((r) => r.organization_id != null && r.organization_id !== orgId).slice(0, 5);
  jChecks.push(
    j7Bad.length === 0
      ? { name: "J7_tenant_scoping", pass: true, strict: true }
      : {
          name: "J7_tenant_scoping",
          pass: false,
          strict: true,
          note: `${j7Bad.length} row(s) with wrong organization_id`,
          offenders: j7Bad.map((r) => r.organization_id),
        },
  );

  // J8: no Supabase write calls (soft, self-attestation).
  jChecks.push({
    name: "J8_no_supabase_write_calls",
    pass: true,
    strict: false,
    note: "script issues only .select() and .limit(0) probes; no insert/update/upsert/delete/rpc",
  });

  // J9: cursor monotonicity in page-cursors.ndjson.
  const cursorsText = fs.readFileSync(path.join(runDir, "logs", "page-cursors.ndjson"), "utf8");
  const cursorEntries = cursorsText
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { table: string; last_id: string | null });
  const cursorOffenders: string[] = [];
  const lastIdByTable = new Map<string, string>();
  for (const e of cursorEntries) {
    if (e.last_id == null) continue;
    const prev = lastIdByTable.get(e.table);
    if (prev != null && !(e.last_id > prev)) cursorOffenders.push(`${e.table}:${prev}->${e.last_id}`);
    lastIdByTable.set(e.table, e.last_id);
  }
  jChecks.push(
    cursorOffenders.length === 0
      ? {
          name: "J9_cursor_monotonicity",
          pass: true,
          strict: true,
          note: `entries=${cursorEntries.length}`,
        }
      : {
          name: "J9_cursor_monotonicity",
          pass: false,
          strict: true,
          note: `${cursorOffenders.length} non-monotonic transitions`,
          offenders: cursorOffenders.slice(0, 5),
        },
  );

  // J10: identifier_conflict_within_group flag matches actual ≥2 distinct values.
  const j10Bad: string[] = [];
  for (const g of shardAWinners) {
    const groupId = g.selection.groupId;
    const memberCands = new Map<string, Candidates>();
    for (const id of g.selection.rankedMembers) {
      const p = productById.get(id);
      if (p) memberCands.set(id, deriveCandidates(p));
    }
    const reauth = buildIdentifierAuthority(memberCands);
    const reportedKinds = g.selection.identifierAuthority.identifier_conflicts.map((c) => c.kind).sort();
    const recomputedKinds = reauth.identifier_conflicts.map((c) => c.kind).sort();
    if (reportedKinds.join(",") !== recomputedKinds.join(",")) {
      j10Bad.push(`${groupId}:reported=${reportedKinds.join(",")} actual=${recomputedKinds.join(",")}`);
    }
  }
  jChecks.push(
    j10Bad.length === 0
      ? { name: "J10_identifier_conflict_flag_matches_reality", pass: true, strict: true }
      : {
          name: "J10_identifier_conflict_flag_matches_reality",
          pass: false,
          strict: true,
          note: `${j10Bad.length} groups with mismatched conflict flag`,
          offenders: j10Bad.slice(0, 5),
        },
  );

  // J11: downstream_rewrite_count == sum of per-surface counts.
  const j11Bad: string[] = [];
  for (const r of shardAEdgeRows) {
    let sum = 0;
    for (const s of DOWNSTREAM_SURFACES) sum += Number(r[`surface_${s}_count`] ?? 0);
    if (sum !== Number(r.downstream_rewrite_count)) {
      j11Bad.push(`${r.loser_id}:declared=${r.downstream_rewrite_count} sum=${sum}`);
    }
  }
  for (const r of shardBEdgeRows) {
    let sum = 0;
    for (const s of DOWNSTREAM_SURFACES) sum += Number(r[`surface_${s}_count`] ?? 0);
    if (sum !== Number(r.downstream_rewrite_count)) {
      j11Bad.push(`${r.orphan_id}:declared=${r.downstream_rewrite_count} sum=${sum}`);
    }
  }
  jChecks.push(
    j11Bad.length === 0
      ? { name: "J11_per_surface_sum_matches_total", pass: true, strict: true }
      : {
          name: "J11_per_surface_sum_matches_total",
          pass: false,
          strict: true,
          note: `${j11Bad.length} rows with mismatched downstream_rewrite_count`,
          offenders: j11Bad.slice(0, 5),
        },
  );

  // J12: safe_to_merge groups have zero cluster overlap AND zero mismatch.
  const j12Bad: string[] = [];
  for (const g of shardAWinners) {
    if (!g.selection.safeToMerge) continue;
    const overlapCluster = g.selection.rankedMembers.filter((id) => clusterPids.has(id)).length;
    const overlapMismatch = g.selection.rankedMembers.filter((id) => mismatchSet.has(id)).length;
    if (overlapCluster > 0 || overlapMismatch > 0) {
      j12Bad.push(
        `${g.selection.groupId}:cluster=${overlapCluster} mismatch=${overlapMismatch}`,
      );
    }
  }
  jChecks.push(
    j12Bad.length === 0
      ? { name: "J12_safe_groups_no_cluster_or_mismatch", pass: true, strict: true }
      : {
          name: "J12_safe_groups_no_cluster_or_mismatch",
          pass: false,
          strict: true,
          note: `${j12Bad.length} safe groups overlap cluster or mismatch`,
          offenders: j12Bad.slice(0, 5),
        },
  );

  // J13: merged_into chain depth ≤ 1.
  const j13Bad = shardAEdges
    .filter((e) => e.merged_into_chain_depth_after_merge > 1)
    .map((e) => `${e.loser_id}->${e.winner_id}:depth=${e.merged_into_chain_depth_after_merge}`);
  shardBEdges
    .filter((e) => e.merged_into_chain_depth_after_merge > 1)
    .forEach((e) =>
      j13Bad.push(`${e.orphan_id}->${e.external_winner_id}:depth=${e.merged_into_chain_depth_after_merge}`),
    );
  jChecks.push(
    j13Bad.length === 0
      ? { name: "J13_merge_chain_depth_le_1", pass: true, strict: true }
      : {
          name: "J13_merge_chain_depth_le_1",
          pass: false,
          strict: true,
          note: `${j13Bad.length} edges with depth > 1`,
          offenders: j13Bad.slice(0, 5),
        },
  );

  // J14: every product_id in every output row exists in current products snapshot.
  const productIdFields = new Set<string>([
    "product_id",
    "winner_id",
    "loser_id",
    "orphan_id",
    "external_winner_id",
    "second_place_id",
    "runner_up_id",
  ]);
  const j14Bad: string[] = [];
  for (const r of allRows) {
    for (const [key, value] of Object.entries(r)) {
      if (!productIdFields.has(key)) continue;
      if (typeof value !== "string" || value.length === 0) continue;
      if (!productById.has(value)) j14Bad.push(`${key}=${value}`);
    }
  }
  jChecks.push(
    j14Bad.length === 0
      ? { name: "J14_product_ids_resolve_in_snapshot", pass: true, strict: true }
      : {
          name: "J14_product_ids_resolve_in_snapshot",
          pass: false,
          strict: true,
          note: `${j14Bad.length} stale product_id references`,
          offenders: [...new Set(j14Bad)].slice(0, 5),
        },
  );

  // J15: every Shard B external_winner_id is deleted_at IS NULL AND merge_status IN (NULL,'active')
  // AND owns at least one current active map row matching the orphan's colliding identifier.
  const j15Bad: string[] = [];
  for (const cls of shardBClassifications) {
    if (!cls.safe_to_merge || !cls.external_winner_id) continue;
    const ew = productById.get(cls.external_winner_id);
    if (!ew) {
      j15Bad.push(`${cls.external_winner_id}:missing`);
      continue;
    }
    if (ew.deleted_at) j15Bad.push(`${ew.id}:deleted`);
    if (ew.merge_status != null && ew.merge_status !== "active") j15Bad.push(`${ew.id}:status:${ew.merge_status}`);
    const ewActiveImap = activeImapByPid.get(ew.id) ?? [];
    if (ewActiveImap.length === 0) j15Bad.push(`${ew.id}:no_active_map_row`);
  }
  jChecks.push(
    j15Bad.length === 0
      ? { name: "J15_shardB_external_winner_health", pass: true, strict: true }
      : {
          name: "J15_shardB_external_winner_health",
          pass: false,
          strict: true,
          note: `${j15Bad.length} safe shard-B external winners failed health gate`,
          offenders: j15Bad.slice(0, 5),
        },
  );

  // J16: every winner / shardB-pair row carries a non-empty reasoning JSON.
  const j16Bad: string[] = [];
  for (const r of shardAWinnersRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(r.reasoning ?? "null"));
    } catch {
      parsed = null;
    }
    if (!reasoningHasFields(parsed)) j16Bad.push(`A:${r.group_id}`);
  }
  for (const r of shardBPairRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(r.reasoning ?? "null"));
    } catch {
      parsed = null;
    }
    if (!reasoningHasFields(parsed)) j16Bad.push(`B:${r.orphan_id}`);
  }
  jChecks.push(
    j16Bad.length === 0
      ? { name: "J16_reasoning_present_on_winner_rows", pass: true, strict: true }
      : {
          name: "J16_reasoning_present_on_winner_rows",
          pass: false,
          strict: true,
          note: `${j16Bad.length} winner/pair rows missing reasoning`,
          offenders: j16Bad.slice(0, 5),
        },
  );

  // J17: every cascade-risk row carries a non-empty evidence_snapshot JSON.
  const j17Bad: string[] = [];
  for (const r of shardACascadeRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(r.evidence_snapshot ?? "null"));
    } catch {
      parsed = null;
    }
    if (!snapshotHasFields(parsed)) j17Bad.push(String(r.loser_id));
  }
  jChecks.push(
    j17Bad.length === 0
      ? { name: "J17_evidence_snapshot_present_on_cascade_rows", pass: true, strict: true }
      : {
          name: "J17_evidence_snapshot_present_on_cascade_rows",
          pass: false,
          strict: true,
          note: `${j17Bad.length} cascade rows missing evidence_snapshot`,
          offenders: j17Bad.slice(0, 5),
        },
  );

  // J18: platform-neutrality (soft).
  const allHeaders = [
    ...shardAGroupHeaders,
    ...shardAMemberHeaders,
    ...shardAWinnersHeaders,
    ...shardAEdgeHeaders,
    ...shardACascadeHeaders,
    ...shardAIdHeaders,
    ...shardABlockedHeaders,
    ...shardBPairHeaders,
    ...shardBEdgeHeaders,
    ...shardBBlockedHeaders,
  ];
  const j18Offenders = platformNeutralColumnWarnings(allHeaders);
  jChecks.push({
    name: "J18_platform_neutral_column_names",
    pass: j18Offenders.length === 0,
    strict: false,
    note:
      j18Offenders.length === 0
        ? "no Amazon-coupled column prefixes detected"
        : `${j18Offenders.length} potentially Amazon-coupled column name(s)`,
    ...(j18Offenders.length > 0 ? { offenders: j18Offenders } : {}),
  } as JCheckResult);

  writeJson(path.join(runDir, "10-validation-checks.json"), jChecks);

  // 16) Summary + manifest + logs.
  const safeShardACount = shardAWinnersRows.filter((r) => r.safe_to_merge === true).length;
  const safeShardBCount = shardBEdges.length;
  const blockReasonHistogramA: Record<string, number> = {};
  for (const g of shardAWinners) {
    for (const br of g.selection.blockReasons) {
      blockReasonHistogramA[br] = (blockReasonHistogramA[br] ?? 0) + 1;
    }
  }
  const blockReasonHistogramB: Record<string, number> = {};
  for (const cls of shardBClassifications) {
    for (const br of cls.block_reasons) {
      blockReasonHistogramB[br] = (blockReasonHistogramB[br] ?? 0) + 1;
    }
  }
  const hotLosersA = shardAEdges.filter((e) => e.hot_loser_flag).length;
  const hotLosersB = shardBEdges.filter((e) => e.hot_loser_flag).length;
  const downstreamPerGroup = shardAGroupRows.map((r) => Number(r.total_downstream_rewrites_for_group));
  downstreamPerGroup.sort((a, b) => a - b);
  function pct(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const i = Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)));
    return arr[i];
  }
  const downstreamSummary = {
    p0: downstreamPerGroup[0] ?? 0,
    p50: pct(downstreamPerGroup, 0.5),
    p90: pct(downstreamPerGroup, 0.9),
    p99: pct(downstreamPerGroup, 0.99),
    pMax: downstreamPerGroup[downstreamPerGroup.length - 1] ?? 0,
    sum: downstreamPerGroup.reduce((a, b) => a + b, 0),
  };
  const identifierConflictGroupCount = shardAWinners.filter(
    (g) => g.selection.identifierAuthority.identifier_conflicts.length > 0,
  ).length;
  const clusterOverlap = {
    next_18g_cluster_pids: clusterPids.size,
    shardA_member_in_cluster: shardAMembers.filter((m) => m.inCluster).length,
    shardB_orphan_in_cluster: shardBRows.filter((r) => clusterPids.has(r.product_id)).length,
  };

  const finishedAt = new Date().toISOString();
  const summary = {
    runId,
    startedAt,
    finishedAt,
    tenant: { organization_id: orgId, store_id_filter: cli.storeId },
    inputs: {
      next_18j_run_id: sel18j.runId,
      next_18g_run_id: sel18g.runId,
      next_18i_run_dir: next18iRunDir ?? null,
      shardA_groups: shardARowsByGroup.size,
      shardA_members: [...shardARowsByGroup.values()].reduce((a, v) => a + v.length, 0),
      shardB_orphans: shardBRows.length,
      next_18g_cluster_pids: clusterPids.size,
      next_18i_mismatch_pids: mismatchSet.size,
    },
    snapshot: {
      products_in_scope: products.length,
      active_map_rows: activeMap.length,
      inactive_imap_pids: inactiveImapCounts.size,
      pim_duplicate_groups_existing: existingDupGroupsCount,
    },
    shardA: {
      groups: shardARowsByGroup.size,
      members: shardAMembers.length,
      winners: shardAWinnersRows.length,
      edges: shardAEdges.length,
      safe_to_merge_groups: safeShardACount,
      blocked_groups: shardABlocked.length,
      hot_losers: hotLosersA,
      identifier_conflict_groups: identifierConflictGroupCount,
      block_reason_histogram: blockReasonHistogramA,
      total_downstream_rewrites: downstreamSummary,
    },
    shardB: {
      orphans: shardBRows.length,
      safe_to_merge: shardBEdges.length,
      blocked: shardBBlocked.length,
      hot_losers: hotLosersB,
      block_reason_histogram: blockReasonHistogramB,
    },
    cluster_overlap: clusterOverlap,
    column_probes: probes,
    thresholds: {
      max_group_size: cli.maxGroupSize,
      hot_threshold_days: cli.hotThresholdDays,
      resolver_hit_threshold_days: cli.resolverHitThresholdDays,
      prices_recent_threshold_days: cli.pricesRecentThresholdDays,
      page_size: PAGE_SIZE,
      postgrest_in_chunk_size: POSTGREST_IN_CHUNK_SIZE,
      dimension_weights: DIMENSION_WEIGHTS,
    },
    files: {
      manifest: "manifest.json",
      run_summary: "run-summary.json",
      shardA_groups: "00-shardA-groups-summary.csv",
      shardA_members: "01-shardA-members-scored.csv",
      shardA_winners: "02-shardA-winners.csv",
      shardA_edges: "03-shardA-merge-edges.csv",
      shardA_cascade_risks: "04-shardA-cascade-risks.csv",
      shardA_identifier_authority: "05-shardA-identifier-authority.csv",
      shardA_blocked: "06-shardA-blocked-groups.csv",
      shardB_pairs: "07-shardB-orphan-vs-external.csv",
      shardB_edges: "08-shardB-merge-edges.csv",
      shardB_blocked: "09-shardB-blocked.csv",
      validation_checks: "10-validation-checks.json",
      decision_trace: "logs/decision-trace.ndjson",
      page_cursors: "logs/page-cursors.ndjson",
      fetch_warnings: "logs/fetch-warnings.ndjson",
      column_probe: "logs/column-probe.json",
      query_trace: "logs/query-trace.txt",
    },
    j_checks: jChecks,
    fetch_warnings_count: warnings.length,
  };
  writeRunSummary(runDir, summary);

  fs.writeFileSync(path.join(runDir, "logs", "query-trace.txt"), trace.join("\n") + "\n", "utf8");
  fs.writeFileSync(
    path.join(runDir, "logs", "fetch-warnings.ndjson"),
    warnings.length > 0 ? warnings.map((w) => JSON.stringify(w)).join("\n") + "\n" : "",
    "utf8",
  );

  manifest.finishedAt = finishedAt;
  writeManifest(runDir, manifest);

  // Console report.
  console.log("");
  console.log("[NEXT-18K] SHARD A");
  console.log(`  groups                                           ${shardARowsByGroup.size}`);
  console.log(`  members                                          ${shardAMembers.length}`);
  console.log(`  winners                                          ${shardAWinnersRows.length}`);
  console.log(`  edges                                            ${shardAEdges.length}`);
  console.log(`  safe_to_merge_groups                             ${safeShardACount}`);
  console.log(`  blocked_groups                                   ${shardABlocked.length}`);
  console.log(`  hot_losers                                       ${hotLosersA}`);
  console.log(`  identifier_conflict_groups                       ${identifierConflictGroupCount}`);
  console.log(`  downstream_rewrites p50=${downstreamSummary.p50} p90=${downstreamSummary.p90} pMax=${downstreamSummary.pMax} sum=${downstreamSummary.sum}`);
  console.log("[NEXT-18K] SHARD A BLOCK REASONS");
  for (const [k, v] of Object.entries(blockReasonHistogramA).sort()) {
    console.log(`  ${k.padEnd(48)} ${v}`);
  }
  console.log("");
  console.log("[NEXT-18K] SHARD B");
  console.log(`  orphans                                          ${shardBRows.length}`);
  console.log(`  safe_to_merge                                    ${shardBEdges.length}`);
  console.log(`  blocked                                          ${shardBBlocked.length}`);
  console.log(`  hot_losers                                       ${hotLosersB}`);
  console.log("[NEXT-18K] SHARD B BLOCK REASONS");
  for (const [k, v] of Object.entries(blockReasonHistogramB).sort()) {
    console.log(`  ${k.padEnd(48)} ${v}`);
  }
  console.log("");
  console.log("[NEXT-18K] CLUSTER OVERLAP");
  console.log(`  next_18g_cluster_pids                            ${clusterOverlap.next_18g_cluster_pids}`);
  console.log(`  shardA_member_in_cluster                         ${clusterOverlap.shardA_member_in_cluster}`);
  console.log(`  shardB_orphan_in_cluster                         ${clusterOverlap.shardB_orphan_in_cluster}`);
  console.log("");
  for (const j of jChecks) {
    const tag = j.pass ? "PASS" : j.strict ? "FAIL" : "WARN";
    console.log(`[NEXT-18K] ${tag} ${j.name}${"note" in j && j.note ? " — " + j.note : ""}`);
  }
  const failedStrict = jChecks.filter((j) => !j.pass && j.strict);
  if (failedStrict.length > 0) {
    console.error(
      `[NEXT-18K] EXIT 2 — ${failedStrict.length} strict J-check(s) failed: ${failedStrict
        .map((j) => j.name)
        .join(",")}`,
    );
    process.exit(2);
  }
  console.log(`[NEXT-18K] complete. reports written to ${runDir}`);
}

main().catch((err) => {
  console.error("[NEXT-18K] FATAL:", err);
  process.exit(1);
});
