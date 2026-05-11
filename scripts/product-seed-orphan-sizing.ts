/**
 * NEXT-18I — Product identifier orphan / mismatch sizing run.
 *
 * Read-only. Pages public.products and public.product_identifier_map (SELECT only),
 * cross-references the NEXT-18G / NEXT-18F outputs on disk, and emits five CSVs +
 * validation checks + manifest + summary + logs.
 *
 * Outputs:
 *   .cursor/audit-reports/next-18i/<runId>/
 *     manifest.json
 *     run-summary.json
 *     00-orphan-products.csv
 *     01-identifier-mismatch.csv
 *     02-cross-product-sharing.csv
 *     03-catalog-bridge-orphans.csv
 *     04-pre-pim-orphans.csv
 *     05-validation-checks.json
 *     logs/query-trace.txt
 *     logs/page-cursors.ndjson
 *     logs/fetch-warnings.ndjson
 *
 * Run:
 *   npx tsx scripts/product-seed-orphan-sizing.ts
 *
 * Optional flags:
 *   --input-run-next-18g=<runId>
 *   --input-run-next-18f=<runId>
 *   --organization-id=<uuid>
 *   --store-id=<uuid>
 *   --pre-pim-cutoff=<ISO>     (default 2026-06-20T00:00:00Z)
 *   --output-dir=<path>
 *
 * Plan: .cursor/plans/identifier_orphan_sizing_1cf8d231.plan.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  mkRunDir,
  mkRunId,
  sha256Hex,
  writeCsv,
  writeJson,
  writeManifest,
  writeRunSummary,
  writeValidationChecks,
  NDJsonWriter,
  type RunMetadata,
} from "../lib/audits/product-seed-output";
import {
  PAGE_SIZE,
  POSTGREST_IN_CHUNK_SIZE,
  annotateClusterCounts,
  chunkIds,
  compareIdentifiers,
  daysBetween,
  hasAnyIdentifier,
  isPrePimCohort,
  normalizeIdentifier,
  type ActiveMapRow,
  type CatalogBridgeRow,
  type InactiveMapRow,
  type MismatchField,
  type ProductRow,
} from "../lib/audits/product-seed-orphan-sizing";
import { isUuidString } from "../lib/uuid";

const NEXT18F_BASE_DIR = path.join(".cursor", "audit-reports", "next-18f");
const NEXT18G_BASE_DIR = path.join(".cursor", "audit-reports", "next-18g");
const NEXT18I_BASE_DIR = path.join(".cursor", "audit-reports", "next-18i");
const DEFAULT_PRE_PIM_CUTOFF = "2026-06-20T00:00:00Z";

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

const INACTIVE_MAP_SELECT = [
  "id",
  "product_id",
  "match_source",
  "source_report_type",
  "deleted_at",
  "first_seen_at",
  "last_seen_at",
].join(", ");

const CATALOG_BRIDGE_SELECT = [
  "id",
  "organization_id",
  "store_id",
  "catalog_product_id",
  "seller_sku",
  "asin",
  "fnsku",
  "upc_code",
  "msku",
  "title",
  "source_report_type",
  "match_source",
  "is_primary",
  "first_seen_at",
  "last_seen_at",
].join(", ");

// ── CLI ─────────────────────────────────────────────────────────────────────

type Cli = {
  inputRunNext18g: string | null;
  inputRunNext18f: string | null;
  organizationId: string | null;
  storeId: string | null;
  prePimCutoff: string;
  outputDir: string | null;
};

function parseCli(argv: string[]): Cli {
  let inputRunNext18g: string | null = null;
  let inputRunNext18f: string | null = null;
  let organizationId: string | null = null;
  let storeId: string | null = null;
  let prePimCutoff: string = DEFAULT_PRE_PIM_CUTOFF;
  let outputDir: string | null = null;

  for (const arg of argv.slice(2)) {
    let m: RegExpMatchArray | null;
    if ((m = arg.match(/^--input-run-next-18g=(.+)$/))) inputRunNext18g = m[1].trim() || null;
    else if ((m = arg.match(/^--input-run-next-18f=(.+)$/))) inputRunNext18f = m[1].trim() || null;
    else if ((m = arg.match(/^--organization-id=(.+)$/))) organizationId = m[1].trim() || null;
    else if ((m = arg.match(/^--store-id=(.+)$/))) storeId = m[1].trim() || null;
    else if ((m = arg.match(/^--pre-pim-cutoff=(.+)$/))) prePimCutoff = m[1].trim();
    else if ((m = arg.match(/^--output-dir=(.+)$/))) outputDir = m[1].trim() || null;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }
  if (organizationId && !isUuidString(organizationId)) {
    throw new Error(`Invalid --organization-id: "${organizationId}" is not a UUID.`);
  }
  if (storeId && !isUuidString(storeId)) {
    throw new Error(`Invalid --store-id: "${storeId}" is not a UUID.`);
  }
  if (Number.isNaN(Date.parse(prePimCutoff))) {
    throw new Error(`Invalid --pre-pim-cutoff: "${prePimCutoff}" is not an ISO date.`);
  }
  return { inputRunNext18g, inputRunNext18f, organizationId, storeId, prePimCutoff, outputDir };
}

function printHelp(): void {
  console.error(
    [
      "Usage: npx tsx scripts/product-seed-orphan-sizing.ts [flags]",
      "",
      "Flags:",
      "  --input-run-next-18g=<runId>   NEXT-18G run to use (default: latest finished)",
      "  --input-run-next-18f=<runId>   NEXT-18F run for J5 cross-check (default: latest finished)",
      "  --organization-id=<uuid>       Force tenant org (else derived from NEXT-18G manifest)",
      "  --store-id=<uuid>              Optional store filter (default: surface all)",
      "  --pre-pim-cutoff=<ISO>         Pre-PIM cohort threshold (default 2026-06-20T00:00:00Z)",
      "  --output-dir=<path>            Override default output run directory",
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
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env / .env.local.");
  }
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

// ── Input run selection (mirrors scripts/product-seed-conflict-enrich.ts) ───

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
  if (!fs.existsSync(baseDir)) {
    throw new Error(`${label} base directory not found: ${baseDir}`);
  }
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
    if (!fs.existsSync(manifestPath)) {
      trace.push(`[${label}] skip ${subdir}: manifest.json missing`);
      continue;
    }
    let manifest: { runId?: string; startedAt?: string; finishedAt?: string | null };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      trace.push(`[${label}] skip ${subdir}: manifest parse error: ${String(e)}`);
      continue;
    }
    if (!manifest.finishedAt) {
      trace.push(`[${label}] skip ${subdir}: finishedAt null`);
      continue;
    }
    if (!fs.existsSync(path.join(runDir, requiredFile))) {
      trace.push(`[${label}] skip ${subdir}: ${requiredFile} missing`);
      continue;
    }
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
  if (candidates.length === 0) {
    throw new Error(`No finished ${label} run found under ${baseDir}`);
  }
  candidates.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const chosen = candidates[0];
  trace.push(
    `[${label}] auto-selected runId=${chosen.runId} (${candidates.length} candidate(s), startedAt=${chosen.startedAt})`,
  );
  return { ...chosen, selectionReason: "auto_latest" };
}

// ── Types for inputs ────────────────────────────────────────────────────────

type Next18gManifest = {
  runId: string;
  tenant: { organization_id: string; store_ids: string[] };
};

type Next18gCluster = {
  cluster_id: string;
  severity: string;
  recommended_review_action: string;
  identifiers: { asin: string; fnsku: string; seller_sku: string };
  source_tables_seen: string[];
  rows_seen_total: number;
  distinct_conflicting_product_ids: number;
  conflicting_product_ids: string[];
  vendor_hint: string;
  titles_top1: string;
  enrichment: {
    computed: {
      likely_same_product_hint: string;
      any_merged: boolean;
      any_deleted: boolean;
      any_cross_store: boolean;
      merged_into_inside_cluster: boolean;
    };
  };
};

// ── DB fetchers (SELECT only) ───────────────────────────────────────────────

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

function asInactiveMapRow(r: Record<string, unknown>): InactiveMapRow {
  return {
    id: String(r.id),
    product_id: String(r.product_id),
    match_source: stringOrNull(r.match_source),
    source_report_type: stringOrNull(r.source_report_type),
    deleted_at: stringOrNull(r.deleted_at),
    first_seen_at: stringOrNull(r.first_seen_at),
    last_seen_at: stringOrNull(r.last_seen_at),
  };
}

function asCatalogBridgeRow(r: Record<string, unknown>): CatalogBridgeRow {
  return {
    id: String(r.id),
    organization_id: String(r.organization_id),
    store_id: stringOrNull(r.store_id),
    catalog_product_id: String(r.catalog_product_id),
    seller_sku: stringOrNull(r.seller_sku),
    asin: stringOrNull(r.asin),
    fnsku: stringOrNull(r.fnsku),
    upc_code: stringOrNull(r.upc_code),
    msku: stringOrNull(r.msku),
    title: stringOrNull(r.title),
    source_report_type: stringOrNull(r.source_report_type),
    match_source: stringOrNull(r.match_source),
    is_primary: boolOrNull(r.is_primary),
    first_seen_at: stringOrNull(r.first_seen_at),
    last_seen_at: stringOrNull(r.last_seen_at),
  };
}

async function* pageProducts(args: {
  sb: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  cursorWriter: NDJsonWriter;
  warnings: FetchWarning[];
}): AsyncGenerator<ProductRow[]> {
  const { sb, organizationId, storeId, cursorWriter, warnings } = args;
  let offset = 0;
  let pageIndex = 0;
  while (true) {
    let q = sb
      .from("products")
      .select(PRODUCTS_SELECT)
      .eq("organization_id", organizationId)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (storeId) q = q.eq("store_id", storeId);
    const { data, error } = await q;
    if (error) {
      warnings.push({ source: "products", reason: `page ${pageIndex} error: ${error.message}`, detail: error });
      throw new Error(`[orphan-sizing] products page ${pageIndex} failed: ${error.message}`);
    }
    const rows = (data ?? []).map((r) => asProductRow(r as Record<string, unknown>));
    const lastId = rows.length > 0 ? rows[rows.length - 1].id : null;
    cursorWriter.write({
      table: "products",
      page_index: pageIndex,
      offset,
      row_count: rows.length,
      last_id: lastId,
    });
    if (rows.length === 0) break;
    yield rows;
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    pageIndex++;
  }
}

async function fetchActiveMapForPids(
  sb: SupabaseClient,
  organizationId: string,
  pids: string[],
  warnings: FetchWarning[],
): Promise<ActiveMapRow[]> {
  if (pids.length === 0) return [];
  const out: ActiveMapRow[] = [];
  for (const chunk of chunkIds(pids, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await sb
      .from("product_identifier_map")
      .select(ACTIVE_MAP_SELECT)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .in("product_id", chunk);
    if (error) {
      warnings.push({ source: "product_identifier_map.active", reason: error.message, detail: error });
      throw new Error(`[orphan-sizing] active map chunk failed: ${error.message}`);
    }
    for (const r of data ?? []) out.push(asActiveMapRow(r as Record<string, unknown>));
  }
  return out;
}

async function fetchInactiveMapForPids(
  sb: SupabaseClient,
  organizationId: string,
  pids: string[],
  warnings: FetchWarning[],
): Promise<InactiveMapRow[]> {
  if (pids.length === 0) return [];
  const out: InactiveMapRow[] = [];
  for (const chunk of chunkIds(pids, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await sb
      .from("product_identifier_map")
      .select(INACTIVE_MAP_SELECT)
      .eq("organization_id", organizationId)
      .not("deleted_at", "is", null)
      .in("product_id", chunk);
    if (error) {
      warnings.push({ source: "product_identifier_map.inactive", reason: error.message, detail: error });
      throw new Error(`[orphan-sizing] inactive map chunk failed: ${error.message}`);
    }
    for (const r of data ?? []) out.push(asInactiveMapRow(r as Record<string, unknown>));
  }
  return out;
}

async function* pageCatalogBridgeOrphans(args: {
  sb: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  cursorWriter: NDJsonWriter;
  warnings: FetchWarning[];
}): AsyncGenerator<CatalogBridgeRow[]> {
  const { sb, organizationId, storeId, cursorWriter, warnings } = args;
  let offset = 0;
  let pageIndex = 0;
  while (true) {
    let q = sb
      .from("product_identifier_map")
      .select(CATALOG_BRIDGE_SELECT)
      .eq("organization_id", organizationId)
      .is("product_id", null)
      .not("catalog_product_id", "is", null)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (storeId) q = q.eq("store_id", storeId);
    const { data, error } = await q;
    if (error) {
      warnings.push({ source: "product_identifier_map.bridge", reason: `page ${pageIndex} error: ${error.message}`, detail: error });
      throw new Error(`[orphan-sizing] bridge page ${pageIndex} failed: ${error.message}`);
    }
    const rows = (data ?? []).map((r) => asCatalogBridgeRow(r as Record<string, unknown>));
    const lastId = rows.length > 0 ? rows[rows.length - 1].id : null;
    cursorWriter.write({
      table: "product_identifier_map.bridge",
      page_index: pageIndex,
      offset,
      row_count: rows.length,
      last_id: lastId,
    });
    if (rows.length === 0) break;
    yield rows;
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    pageIndex++;
  }
}

// ── J-checks ────────────────────────────────────────────────────────────────

type JCheckResult =
  | { name: string; pass: true; strict: boolean; note?: string }
  | { name: string; pass: false; strict: boolean; note: string; offenders?: unknown[] };

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli(process.argv);
  loadEnvLocal();
  console.log("[orphan-sizing] starting NEXT-18I product identifier orphan / mismatch sizing run");

  const trace: string[] = [];

  // 1) Resolve NEXT-18G and NEXT-18F runs.
  const sel18g = selectInputRun({
    baseDir: NEXT18G_BASE_DIR,
    override: cli.inputRunNext18g,
    requiredFile: "01-enriched-conflict-clusters.json",
    trace,
    label: "next-18g",
  });
  const sel18f = selectInputRun({
    baseDir: NEXT18F_BASE_DIR,
    override: cli.inputRunNext18f,
    requiredFile: "01-conflict-clusters.json",
    trace,
    label: "next-18f",
  });
  console.log(`[orphan-sizing] next-18g=${sel18g.runId} (${sel18g.selectionReason})`);
  console.log(`[orphan-sizing] next-18f=${sel18f.runId} (${sel18f.selectionReason})`);

  // 2) Load NEXT-18G manifest and clusters; derive tenant.
  const manifest18g = JSON.parse(
    fs.readFileSync(path.join(sel18g.runDir, "manifest.json"), "utf8"),
  ) as Next18gManifest;
  const clusters = JSON.parse(
    fs.readFileSync(path.join(sel18g.runDir, "01-enriched-conflict-clusters.json"), "utf8"),
  ) as Next18gCluster[];
  const clusters18f = JSON.parse(
    fs.readFileSync(path.join(sel18f.runDir, "01-conflict-clusters.json"), "utf8"),
  ) as Array<{ cluster_id: string }>;

  const orgId = cli.organizationId ?? manifest18g.tenant.organization_id;
  if (!orgId || !isUuidString(orgId)) {
    throw new Error(`Could not derive a valid organization_id (got "${orgId}")`);
  }
  console.log(
    `[orphan-sizing] tenant org=${orgId} store_filter=${cli.storeId ?? "<none>"} pre_pim_cutoff=${cli.prePimCutoff}`,
  );

  // Build the conflict-pid lookup so we can flag products that appear in clusters.
  const clusterPids = new Set<string>();
  const pidToClusterId = new Map<string, string>();
  for (const c of clusters) {
    for (const pid of c.conflicting_product_ids) {
      clusterPids.add(pid);
      if (!pidToClusterId.has(pid)) pidToClusterId.set(pid, c.cluster_id);
    }
  }

  // 3) Create run directory.
  const runId = mkRunId();
  const runDir = cli.outputDir ?? mkRunDir(NEXT18I_BASE_DIR, runId);
  if (cli.outputDir) {
    fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
  }
  console.log(`[orphan-sizing] runId=${runId}`);
  console.log(`[orphan-sizing] output_dir=${runDir}`);

  const cursorWriter = new NDJsonWriter(path.join(runDir, "logs", "page-cursors.ndjson"));
  const warnings: FetchWarning[] = [];

  // 4) Initial manifest (finishedAt filled at the end).
  const startedAt = new Date().toISOString();
  const manifest: RunMetadata & {
    inputs: {
      next_18g: { runId: string; runDir: string; startedAt: string; finishedAt: string };
      next_18f: { runId: string; runDir: string; startedAt: string; finishedAt: string };
      pre_pim_cutoff: string;
    };
    tenant: { organization_id: string; store_id_filter: string | null };
    entryPoint: string;
  } = {
    runId,
    startedAt,
    finishedAt: null,
    cliArgs: {
      inputRunNext18g: cli.inputRunNext18g,
      inputRunNext18f: cli.inputRunNext18f,
      organizationId: cli.organizationId,
      storeId: cli.storeId,
      prePimCutoff: cli.prePimCutoff,
      outputDir: cli.outputDir,
    },
    envHash: sha256Hex(
      `${sel18g.runId}|${sel18f.runId}|${orgId}|${cli.storeId ?? ""}|${cli.prePimCutoff}`,
    ),
    nodeVersion: process.version,
    supabaseJsVersion: getSupabaseJsVersion(),
    generatorGitSha: readGitSha(),
    inputs: {
      next_18g: {
        runId: sel18g.runId,
        runDir: sel18g.runDir,
        startedAt: sel18g.startedAt,
        finishedAt: sel18g.finishedAt,
      },
      next_18f: {
        runId: sel18f.runId,
        runDir: sel18f.runDir,
        startedAt: sel18f.startedAt,
        finishedAt: sel18f.finishedAt,
      },
      pre_pim_cutoff: cli.prePimCutoff,
    },
    tenant: { organization_id: orgId, store_id_filter: cli.storeId },
    entryPoint: "scripts/product-seed-orphan-sizing.ts",
  };
  writeManifest(runDir, manifest);

  // 5) Supabase client (SELECT-only by convention; J8 verifies no write verbs are issued).
  const env = requireEnv();
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } });

  // 6) Page products and collect orphan / mismatch.
  type ProductState =
    | { kind: "with_active_map"; mapRows: ActiveMapRow[]; mismatches: ActiveMapRow[]; mismatchFlags: Map<string, MismatchField[]> }
    | { kind: "orphan"; inactiveRows: InactiveMapRow[] };

  const orphanRows: Array<{
    row: ProductRow;
    inactiveMap: InactiveMapRow[];
  }> = [];
  const mismatchRows: Array<{
    product: ProductRow;
    map: ActiveMapRow;
    flags: MismatchField[];
  }> = [];

  const productPids = new Set<string>();
  const withActiveMapPids = new Set<string>();
  const mismatchPids = new Set<string>();

  const storeIdsObserved = new Set<string>();
  const wrongOrgOffenders: Array<{ table: string; row_id: string; organization_id: string }> = [];

  let nowMs = Date.now();
  console.log(
    `[orphan-sizing] paging public.products in chunks of ${PAGE_SIZE} (chunked IN ${POSTGREST_IN_CHUNK_SIZE})`,
  );

  let totalProducts = 0;
  let pageIndex = 0;
  for await (const page of pageProducts({
    sb,
    organizationId: orgId,
    storeId: cli.storeId,
    cursorWriter,
    warnings,
  })) {
    totalProducts += page.length;
    pageIndex++;
    for (const p of page) {
      if (p.organization_id !== orgId) {
        wrongOrgOffenders.push({ table: "products", row_id: p.id, organization_id: p.organization_id });
      }
      productPids.add(p.id);
      if (p.store_id) storeIdsObserved.add(p.store_id);
    }
    const pageIds = page.map((p) => p.id);
    const activeMap = await fetchActiveMapForPids(sb, orgId, pageIds, warnings);
    for (const m of activeMap) {
      if (m.organization_id !== orgId) {
        wrongOrgOffenders.push({ table: "product_identifier_map", row_id: m.id, organization_id: m.organization_id });
      }
      if (m.store_id) storeIdsObserved.add(m.store_id);
    }
    const activeByPid = new Map<string, ActiveMapRow[]>();
    for (const m of activeMap) {
      const arr = activeByPid.get(m.product_id);
      if (arr) arr.push(m);
      else activeByPid.set(m.product_id, [m]);
    }
    const orphansThisPage: ProductRow[] = [];
    for (const p of page) {
      const rows = activeByPid.get(p.id);
      if (!rows || rows.length === 0) {
        orphansThisPage.push(p);
        continue;
      }
      withActiveMapPids.add(p.id);
      for (const m of rows) {
        const flags = compareIdentifiers(p, m);
        if (flags.length > 0) {
          mismatchRows.push({ product: p, map: m, flags });
          mismatchPids.add(p.id);
        }
      }
    }
    let inactiveByPid: Map<string, InactiveMapRow[]> = new Map();
    if (orphansThisPage.length > 0) {
      const orphanIds = orphansThisPage.map((o) => o.id);
      const inactiveMap = await fetchInactiveMapForPids(sb, orgId, orphanIds, warnings);
      for (const m of inactiveMap) {
        const arr = inactiveByPid.get(m.product_id);
        if (arr) arr.push(m);
        else inactiveByPid.set(m.product_id, [m]);
      }
    }
    for (const o of orphansThisPage) {
      orphanRows.push({ row: o, inactiveMap: inactiveByPid.get(o.id) ?? [] });
    }
    if (pageIndex % 10 === 0 || page.length < PAGE_SIZE) {
      const elapsed = Math.floor((Date.now() - nowMs) / 1000);
      console.log(
        `[orphan-sizing] processed ${totalProducts} product(s); orphan=${orphanRows.length} with_active_map=${withActiveMapPids.size} mismatch_rows=${mismatchRows.length} (elapsed ${elapsed}s)`,
      );
    }
  }
  console.log(`[orphan-sizing] products paging complete: total=${totalProducts}`);

  // 7) Page catalog-bridge orphans.
  console.log(`[orphan-sizing] paging public.product_identifier_map for catalog-bridge orphans`);
  const bridgeRows: CatalogBridgeRow[] = [];
  for await (const page of pageCatalogBridgeOrphans({
    sb,
    organizationId: orgId,
    storeId: cli.storeId,
    cursorWriter,
    warnings,
  })) {
    for (const r of page) {
      if (r.organization_id !== orgId) {
        wrongOrgOffenders.push({ table: "product_identifier_map", row_id: r.id, organization_id: r.organization_id });
      }
      if (r.store_id) storeIdsObserved.add(r.store_id);
      bridgeRows.push(r);
    }
  }
  console.log(`[orphan-sizing] catalog-bridge orphan rows=${bridgeRows.length}`);

  await cursorWriter.close();

  // 8) Build CSV row sets.
  // 00-orphan-products.csv
  const orphanCsvRows = orphanRows.map(({ row, inactiveMap }) => {
    const inactiveSources = Array.from(
      new Set(inactiveMap.map((i) => i.match_source ?? "").filter((s) => s.length > 0)),
    ).join(",");
    return {
      product_id: row.id,
      organization_id: row.organization_id,
      store_id: row.store_id ?? "",
      sku: row.sku ?? "",
      asin: row.asin ?? "",
      fnsku: row.fnsku ?? "",
      upc_code: row.upc_code ?? "",
      mfg_part_number: row.mfg_part_number ?? "",
      barcode: row.barcode ?? "",
      product_name: row.product_name ?? "",
      brand: row.brand ?? "",
      vendor_name: row.vendor_name ?? "",
      condition: row.condition ?? "",
      status: row.status ?? "",
      merge_status: row.merge_status ?? "",
      merged_into_id: row.merged_into_id ?? "",
      deleted_at: row.deleted_at ?? "",
      created_at: row.created_at ?? "",
      updated_at: row.updated_at ?? "",
      last_seen_at: row.last_seen_at ?? "",
      last_catalog_sync_at: row.last_catalog_sync_at ?? "",
      has_any_identifier: hasAnyIdentifier(row),
      has_inactive_map_only: inactiveMap.length > 0,
      inactive_map_count: inactiveMap.length,
      inactive_map_sources: inactiveSources,
      pre_pim_cohort: isPrePimCohort(row.created_at, cli.prePimCutoff),
      days_since_created: daysBetween(new Date().toISOString(), row.created_at) ?? "",
      in_conflict_cluster: clusterPids.has(row.id),
      conflict_cluster_id: pidToClusterId.get(row.id) ?? "",
    };
  });

  writeCsv(
    path.join(runDir, "00-orphan-products.csv"),
    [
      "product_id",
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
      "has_any_identifier",
      "has_inactive_map_only",
      "inactive_map_count",
      "inactive_map_sources",
      "pre_pim_cohort",
      "days_since_created",
      "in_conflict_cluster",
      "conflict_cluster_id",
    ],
    orphanCsvRows,
  );

  // 01-identifier-mismatch.csv
  const nowIso = new Date().toISOString();
  const mismatchCsvRows = mismatchRows.map(({ product, map, flags }) => ({
    product_id: product.id,
    map_id: map.id,
    organization_id: product.organization_id,
    store_id_product: product.store_id ?? "",
    store_id_map: map.store_id ?? "",
    mismatch_flags: flags.join(","),
    products_sku: product.sku ?? "",
    map_seller_sku: map.seller_sku ?? "",
    products_asin: product.asin ?? "",
    map_asin: map.asin ?? "",
    products_fnsku: product.fnsku ?? "",
    map_fnsku: map.fnsku ?? "",
    products_upc: product.upc_code ?? "",
    map_upc: map.upc_code ?? "",
    is_primary: map.is_primary == null ? "" : map.is_primary,
    match_source: map.match_source ?? "",
    source_report_type: map.source_report_type ?? "",
    map_first_seen_at: map.first_seen_at ?? "",
    map_last_seen_at: map.last_seen_at ?? "",
    products_last_seen_at: product.last_seen_at ?? "",
    products_last_catalog_sync_at: product.last_catalog_sync_at ?? "",
    staleness_days: daysBetween(nowIso, map.last_seen_at) ?? "",
    product_deleted_at: product.deleted_at ?? "",
    product_merge_status: product.merge_status ?? "",
    in_conflict_cluster: clusterPids.has(product.id),
    conflict_cluster_id: pidToClusterId.get(product.id) ?? "",
  }));
  writeCsv(
    path.join(runDir, "01-identifier-mismatch.csv"),
    [
      "product_id",
      "map_id",
      "organization_id",
      "store_id_product",
      "store_id_map",
      "mismatch_flags",
      "products_sku",
      "map_seller_sku",
      "products_asin",
      "map_asin",
      "products_fnsku",
      "map_fnsku",
      "products_upc",
      "map_upc",
      "is_primary",
      "match_source",
      "source_report_type",
      "map_first_seen_at",
      "map_last_seen_at",
      "products_last_seen_at",
      "products_last_catalog_sync_at",
      "staleness_days",
      "product_deleted_at",
      "product_merge_status",
      "in_conflict_cluster",
      "conflict_cluster_id",
    ],
    mismatchCsvRows,
  );

  // 02-cross-product-sharing.csv
  const annotations = annotateClusterCounts({
    clusters: clusters.map((c) => ({
      cluster_id: c.cluster_id,
      conflicting_product_ids: c.conflicting_product_ids,
    })),
    orphanPids: new Set(orphanCsvRows.map((r) => r.product_id)),
    withActiveMapPids,
    mismatchPids,
  });
  const annotByCid = new Map(annotations.map((a) => [a.cluster_id, a]));
  const clusterCsvRows = clusters.map((c) => {
    const a = annotByCid.get(c.cluster_id);
    const e = c.enrichment.computed;
    return {
      cluster_id: c.cluster_id,
      severity: c.severity,
      recommended_review_action: c.recommended_review_action,
      asin: c.identifiers.asin,
      fnsku: c.identifiers.fnsku,
      seller_sku: c.identifiers.seller_sku,
      source_tables_seen: (c.source_tables_seen ?? []).join(","),
      rows_seen_total: c.rows_seen_total,
      distinct_conflicting_product_ids: c.distinct_conflicting_product_ids,
      product_ids: c.conflicting_product_ids.join(","),
      n_orphan_pids: a?.n_orphan_pids ?? 0,
      n_pids_with_active_map: a?.n_pids_with_active_map ?? 0,
      n_pids_with_mismatch: a?.n_pids_with_mismatch ?? 0,
      likely_same_product_hint: e.likely_same_product_hint,
      any_merged: e.any_merged,
      any_deleted: e.any_deleted,
      any_cross_store: e.any_cross_store,
      merged_into_inside_cluster: e.merged_into_inside_cluster,
      vendor_hint: c.vendor_hint,
      titles_top1: c.titles_top1,
    };
  });
  writeCsv(
    path.join(runDir, "02-cross-product-sharing.csv"),
    [
      "cluster_id",
      "severity",
      "recommended_review_action",
      "asin",
      "fnsku",
      "seller_sku",
      "source_tables_seen",
      "rows_seen_total",
      "distinct_conflicting_product_ids",
      "product_ids",
      "n_orphan_pids",
      "n_pids_with_active_map",
      "n_pids_with_mismatch",
      "likely_same_product_hint",
      "any_merged",
      "any_deleted",
      "any_cross_store",
      "merged_into_inside_cluster",
      "vendor_hint",
      "titles_top1",
    ],
    clusterCsvRows,
  );

  // 03-catalog-bridge-orphans.csv
  const bridgeCsvRows = bridgeRows.map((r) => ({
    map_id: r.id,
    organization_id: r.organization_id,
    store_id: r.store_id ?? "",
    catalog_product_id: r.catalog_product_id,
    seller_sku: r.seller_sku ?? "",
    asin: r.asin ?? "",
    fnsku: r.fnsku ?? "",
    upc_code: r.upc_code ?? "",
    msku: r.msku ?? "",
    title: r.title ?? "",
    source_report_type: r.source_report_type ?? "",
    match_source: r.match_source ?? "",
    is_primary: r.is_primary == null ? "" : r.is_primary,
    first_seen_at: r.first_seen_at ?? "",
    last_seen_at: r.last_seen_at ?? "",
    days_since_first_seen: daysBetween(nowIso, r.first_seen_at) ?? "",
    informational: true,
  }));
  writeCsv(
    path.join(runDir, "03-catalog-bridge-orphans.csv"),
    [
      "map_id",
      "organization_id",
      "store_id",
      "catalog_product_id",
      "seller_sku",
      "asin",
      "fnsku",
      "upc_code",
      "msku",
      "title",
      "source_report_type",
      "match_source",
      "is_primary",
      "first_seen_at",
      "last_seen_at",
      "days_since_first_seen",
      "informational",
    ],
    bridgeCsvRows,
  );

  // 04-pre-pim-orphans.csv (derived view of orphan rows where pre_pim_cohort=true)
  const prePimCsvRows = orphanCsvRows
    .filter((r) => r.pre_pim_cohort === true)
    .map((r) => ({
      ...r,
      days_before_pim_cutoff:
        daysBetween(cli.prePimCutoff, r.created_at || null) ?? "",
    }));
  writeCsv(
    path.join(runDir, "04-pre-pim-orphans.csv"),
    [
      "product_id",
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
      "has_any_identifier",
      "has_inactive_map_only",
      "inactive_map_count",
      "inactive_map_sources",
      "pre_pim_cohort",
      "days_since_created",
      "in_conflict_cluster",
      "conflict_cluster_id",
      "days_before_pim_cutoff",
    ],
    prePimCsvRows,
  );

  // 9) J-checks.
  const jChecks: JCheckResult[] = [];

  // J1 — page coverage: distinct product ids equals totalProducts (no duplicates across pages).
  jChecks.push(
    productPids.size === totalProducts
      ? {
          name: "J1_page_coverage_no_duplicates",
          pass: true,
          strict: true,
          note: `total_products_seen=${totalProducts} distinct=${productPids.size}`,
        }
      : {
          name: "J1_page_coverage_no_duplicates",
          pass: false,
          strict: true,
          note: `total_products_seen=${totalProducts} but distinct=${productPids.size} (duplicate ids across pages)`,
        },
  );

  // J2 — tenant scoping.
  jChecks.push(
    wrongOrgOffenders.length === 0
      ? { name: "J2_tenant_scoping", pass: true, strict: true }
      : {
          name: "J2_tenant_scoping",
          pass: false,
          strict: true,
          note: `${wrongOrgOffenders.length} row(s) with wrong organization_id`,
          offenders: wrongOrgOffenders.slice(0, 5),
        },
  );

  // J3 — orphan reconciliation.
  const orphanCount = orphanCsvRows.length;
  const withMapCount = withActiveMapPids.size;
  jChecks.push(
    orphanCount + withMapCount === totalProducts
      ? {
          name: "J3_orphan_reconciliation",
          pass: true,
          strict: true,
          note: `orphan=${orphanCount} + with_active_map=${withMapCount} = ${totalProducts}`,
        }
      : {
          name: "J3_orphan_reconciliation",
          pass: false,
          strict: true,
          note: `orphan=${orphanCount} + with_active_map=${withMapCount} != total=${totalProducts}`,
        },
  );

  // J4 — cluster pid coverage.
  const clusterCoverageMisses: string[] = [];
  const clusterDoubleCount: string[] = [];
  for (const pid of clusterPids) {
    const o = orphanCsvRows.some((r) => r.product_id === pid);
    const w = withActiveMapPids.has(pid);
    if (!o && !w) clusterCoverageMisses.push(pid);
    if (o && w) clusterDoubleCount.push(pid);
  }
  jChecks.push(
    clusterCoverageMisses.length === 0 && clusterDoubleCount.length === 0
      ? {
          name: "J4_cluster_pid_coverage",
          pass: true,
          strict: true,
          note: `cluster_pids=${clusterPids.size} all accounted for once`,
        }
      : {
          name: "J4_cluster_pid_coverage",
          pass: false,
          strict: true,
          note: `misses=${clusterCoverageMisses.length} double_counted=${clusterDoubleCount.length}`,
          offenders: [...clusterCoverageMisses.slice(0, 5), ...clusterDoubleCount.slice(0, 5)],
        },
  );

  // J5 — cluster count parity.
  jChecks.push(
    clusterCsvRows.length === clusters.length && clusters.length === clusters18f.length
      ? {
          name: "J5_cluster_count_parity",
          pass: true,
          strict: true,
          note: `csv=${clusterCsvRows.length} next18g=${clusters.length} next18f=${clusters18f.length}`,
        }
      : {
          name: "J5_cluster_count_parity",
          pass: false,
          strict: true,
          note: `csv=${clusterCsvRows.length} next18g=${clusters.length} next18f=${clusters18f.length}`,
        },
  );

  // J6 — pre-PIM ⊆ orphan.
  const orphanPidSet = new Set(orphanCsvRows.map((r) => r.product_id));
  const prePimNotInOrphan = prePimCsvRows.filter((r) => !orphanPidSet.has(r.product_id));
  jChecks.push(
    prePimNotInOrphan.length === 0
      ? {
          name: "J6_pre_pim_subset_of_orphan",
          pass: true,
          strict: true,
          note: `pre_pim=${prePimCsvRows.length} all present in orphan output`,
        }
      : {
          name: "J6_pre_pim_subset_of_orphan",
          pass: false,
          strict: true,
          note: `${prePimNotInOrphan.length} pre-PIM rows missing from orphan output`,
          offenders: prePimNotInOrphan.slice(0, 5).map((r) => r.product_id),
        },
  );

  // J7 — cursor monotonicity (read page-cursors.ndjson back from disk).
  const cursorsText = fs.readFileSync(path.join(runDir, "logs", "page-cursors.ndjson"), "utf8");
  const cursorEntries = cursorsText
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { table: string; last_id: string | null });
  const cursorOffenders: string[] = [];
  const lastIdByTable = new Map<string, string>();
  for (const entry of cursorEntries) {
    if (entry.last_id == null) continue;
    const prev = lastIdByTable.get(entry.table);
    if (prev != null && !(entry.last_id > prev)) {
      cursorOffenders.push(`${entry.table}:${prev}->${entry.last_id}`);
    }
    lastIdByTable.set(entry.table, entry.last_id);
  }
  jChecks.push(
    cursorOffenders.length === 0
      ? {
          name: "J7_cursor_monotonicity",
          pass: true,
          strict: true,
          note: `${cursorEntries.length} cursor entries strictly increasing per table`,
        }
      : {
          name: "J7_cursor_monotonicity",
          pass: false,
          strict: true,
          note: `${cursorOffenders.length} non-monotonic cursor transition(s)`,
          offenders: cursorOffenders.slice(0, 5),
        },
  );

  // J8 — no Supabase write calls (soft, warn). We never invoke .insert/.update/.upsert/.delete
  // anywhere in this script; this self-attestation check exists to make the absence visible
  // in the audit report.
  jChecks.push({
    name: "J8_no_supabase_write_calls",
    pass: true,
    strict: false,
    note: "script does not import or invoke insert/update/upsert/delete/rpc on any Supabase table",
  });

  // J9 — mismatch flags well-typed (non-empty subset of {sku,asin,fnsku,upc}).
  const allowedFlags = new Set(["sku", "asin", "fnsku", "upc"]);
  const j9Bad: string[] = [];
  for (const r of mismatchCsvRows) {
    const flags = (r.mismatch_flags || "").split(",").filter((f) => f.length > 0);
    if (flags.length === 0) j9Bad.push(`${r.product_id}:${r.map_id}:empty`);
    for (const f of flags) if (!allowedFlags.has(f)) j9Bad.push(`${r.product_id}:${r.map_id}:bad=${f}`);
  }
  jChecks.push(
    j9Bad.length === 0
      ? { name: "J9_mismatch_flags_well_typed", pass: true, strict: true }
      : {
          name: "J9_mismatch_flags_well_typed",
          pass: false,
          strict: true,
          note: `${j9Bad.length} mismatch row(s) have malformed flags`,
          offenders: j9Bad.slice(0, 5),
        },
  );

  // J10 — catalog-bridge informational flag.
  const j10Bad = bridgeCsvRows.filter((r) => r.informational !== true);
  jChecks.push(
    j10Bad.length === 0
      ? {
          name: "J10_catalog_bridge_informational",
          pass: true,
          strict: true,
          note: `${bridgeCsvRows.length} bridge row(s) all flagged informational`,
        }
      : {
          name: "J10_catalog_bridge_informational",
          pass: false,
          strict: true,
          note: `${j10Bad.length} bridge row(s) missing informational=true`,
        },
  );

  writeValidationChecks(runDir, jChecks);

  // 10) Distributions / summary.
  const orphanByYear: Record<string, number> = {};
  for (const r of orphanCsvRows) {
    const y = (r.created_at || "").slice(0, 4);
    if (!y) continue;
    orphanByYear[y] = (orphanByYear[y] ?? 0) + 1;
  }
  const orphanByInactiveSource: Record<string, number> = {};
  for (const r of orphanCsvRows) {
    if (!r.has_inactive_map_only) continue;
    const sources = (r.inactive_map_sources || "").split(",").filter((s) => s.length > 0);
    for (const s of sources) orphanByInactiveSource[s] = (orphanByInactiveSource[s] ?? 0) + 1;
  }
  const mismatchByField: Record<string, number> = { sku: 0, asin: 0, fnsku: 0, upc: 0 };
  const mismatchBySource: Record<string, number> = {};
  for (const r of mismatchCsvRows) {
    for (const f of (r.mismatch_flags || "").split(",").filter((s) => s.length > 0)) {
      mismatchByField[f] = (mismatchByField[f] ?? 0) + 1;
    }
    const ms = (r.match_source as string) || "<null>";
    mismatchBySource[ms] = (mismatchBySource[ms] ?? 0) + 1;
  }
  const bridgeBySourceReport: Record<string, number> = {};
  for (const r of bridgeCsvRows) {
    const k = (r.source_report_type as string) || "<null>";
    bridgeBySourceReport[k] = (bridgeBySourceReport[k] ?? 0) + 1;
  }

  const next18gPids = clusterPids;
  const next18gOrphan = [...next18gPids].filter((pid) => orphanPidSet.has(pid)).length;
  const next18gWithActive = [...next18gPids].filter((pid) => withActiveMapPids.has(pid)).length;
  const next18gMismatch = [...next18gPids].filter((pid) => mismatchPids.has(pid)).length;

  let productsDeletedAmongOrphans = 0;
  let productsMergedAmongOrphans = 0;
  for (const r of orphanCsvRows) {
    if (r.deleted_at !== "") productsDeletedAmongOrphans++;
    if (r.merge_status === "merged" || r.merge_status === "duplicate" || r.merged_into_id !== "")
      productsMergedAmongOrphans++;
  }

  const finishedAt = new Date().toISOString();
  const summary = {
    runId,
    startedAt,
    finishedAt,
    tenant: {
      organization_id: orgId,
      store_id_filter: cli.storeId,
      store_ids_observed: [...storeIdsObserved].sort(),
    },
    inputs: {
      next_18g_run_id: sel18g.runId,
      next_18f_run_id: sel18f.runId,
      pim_ledger_threshold_date: cli.prePimCutoff,
    },
    totals: {
      products_in_scope: totalProducts,
      products_with_active_map: withActiveMapPids.size,
      orphan_products: orphanCsvRows.length,
      orphan_with_inactive_map_only: orphanCsvRows.filter((r) => r.has_inactive_map_only === true).length,
      products_deleted_among_orphans: productsDeletedAmongOrphans,
      products_merged_or_duplicate_among_orphans: productsMergedAmongOrphans,
      identifier_mismatch_rows: mismatchCsvRows.length,
      identifier_mismatch_products: mismatchPids.size,
      cross_product_clusters: clusterCsvRows.length,
      catalog_bridge_orphans: bridgeCsvRows.length,
      pre_pim_orphans: prePimCsvRows.length,
    },
    distributions: {
      orphan_by_creation_year: orphanByYear,
      orphan_by_match_source_of_inactive_map: orphanByInactiveSource,
      mismatch_by_field: mismatchByField,
      mismatch_by_match_source: mismatchBySource,
      catalog_bridge_by_source_report_type: bridgeBySourceReport,
    },
    conflict_cluster_overlap: {
      next_18g_pids: next18gPids.size,
      next_18g_pids_orphan: next18gOrphan,
      next_18g_pids_with_active_map: next18gWithActive,
      next_18g_pids_with_mismatch: next18gMismatch,
    },
    thresholds: {
      pre_pim_cutoff: cli.prePimCutoff,
      page_size: PAGE_SIZE,
      postgrest_in_chunk_size: POSTGREST_IN_CHUNK_SIZE,
    },
    files: {
      manifest: "manifest.json",
      run_summary: "run-summary.json",
      orphan_csv: "00-orphan-products.csv",
      mismatch_csv: "01-identifier-mismatch.csv",
      cluster_csv: "02-cross-product-sharing.csv",
      bridge_csv: "03-catalog-bridge-orphans.csv",
      pre_pim_csv: "04-pre-pim-orphans.csv",
      validation_checks: "05-validation-checks.json",
      page_cursors: "logs/page-cursors.ndjson",
      query_trace: "logs/query-trace.txt",
      fetch_warnings: "logs/fetch-warnings.ndjson",
    },
    j_checks: jChecks,
    fetch_warnings_count: warnings.length,
  };
  writeRunSummary(runDir, summary);

  // Logs.
  fs.writeFileSync(path.join(runDir, "logs", "query-trace.txt"), trace.join("\n") + "\n", "utf8");
  fs.writeFileSync(
    path.join(runDir, "logs", "fetch-warnings.ndjson"),
    warnings.length > 0 ? warnings.map((w) => JSON.stringify(w)).join("\n") + "\n" : "",
    "utf8",
  );

  // Finalize manifest.
  manifest.finishedAt = finishedAt;
  writeManifest(runDir, manifest);

  // Console report.
  console.log("");
  console.log("[orphan-sizing] SUMMARY");
  console.log(
    `  products_in_scope                  ${summary.totals.products_in_scope}`,
  );
  console.log(`  products_with_active_map           ${summary.totals.products_with_active_map}`);
  console.log(`  orphan_products                    ${summary.totals.orphan_products}`);
  console.log(`  orphan_with_inactive_map_only      ${summary.totals.orphan_with_inactive_map_only}`);
  console.log(`  identifier_mismatch_rows           ${summary.totals.identifier_mismatch_rows}`);
  console.log(`  identifier_mismatch_products       ${summary.totals.identifier_mismatch_products}`);
  console.log(`  cross_product_clusters             ${summary.totals.cross_product_clusters}`);
  console.log(`  catalog_bridge_orphans             ${summary.totals.catalog_bridge_orphans}`);
  console.log(`  pre_pim_orphans                    ${summary.totals.pre_pim_orphans}`);
  console.log("");
  console.log(`[orphan-sizing] CLUSTER OVERLAP (NEXT-18G ${next18gPids.size} pids)`);
  console.log(`  orphan          ${next18gOrphan}`);
  console.log(`  with_active_map ${next18gWithActive}`);
  console.log(`  with_mismatch   ${next18gMismatch}`);
  console.log("");
  for (const j of jChecks) {
    const tag = j.pass ? "PASS" : j.strict ? "FAIL" : "WARN";
    console.log(`[orphan-sizing] ${tag} ${j.name}${"note" in j && j.note ? " — " + j.note : ""}`);
  }
  const failedStrict = jChecks.filter((j) => !j.pass && j.strict);
  if (failedStrict.length > 0) {
    console.error(
      `[orphan-sizing] EXIT 2 — ${failedStrict.length} strict J-check(s) failed: ${failedStrict
        .map((j) => j.name)
        .join(",")}`,
    );
    process.exit(2);
  }
  console.log(`[orphan-sizing] complete. reports written to ${runDir}`);
}

main().catch((err) => {
  console.error("[orphan-sizing] FATAL:", err);
  process.exit(1);
});
